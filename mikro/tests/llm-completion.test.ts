import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createToolRegistry, rlmDriver, runAgent } from "../src/sdk/index.js";
import type { ModelConfig } from "../src/config.js";
import { parseCustomProviders } from "../src/custom-providers.js";
import { assertLLMCompletion, buildCompletionOptions, createPiModelRuntime, createUsage, getModelRuntime, handleLLMRequest, LLMCompletionError, llmComplete, llmCompleteBatched, resolveModel, streamLLMCompletion } from "../src/llm.js";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";

async function gateway(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server must have a TCP address");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  return {
    model(keyEnv: string): ModelConfig {
      return { provider: "isolated", model: "control", providers: parseCustomProviders({ isolated: {
        "base-url": baseUrl, "api-key-env": keyEnv,
        headers: { "X-Configured": "retained" },
        models: { control: { cost: { input: 1, output: 2 } } },
      } }, "fixture") };
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function reply(res: ServerResponse, finish = "stop") {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "served-control", choices: [{ index: 0, delta: { role: "assistant", content: '{"answer":"partial"}' }, finish_reason: finish }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, completion_tokens_details: { reasoning_tokens: 2 } } })}\n\ndata: [DONE]\n\n`);
}

function codexRuntime(config: ModelConfig) {
  const runtime = getModelRuntime(config.providers);
  const model = { ...resolveModel(config.provider, config.model, config.providers), api: "openai-codex-responses" as const };
  const provider = runtime.getProvider(config.provider)!;
  runtime.setProvider(createProvider({ id: config.provider, auth: provider.auth, models: [model], api: openAICodexResponsesApi() }));
  return { runtime, model };
}

function replyCodex(res: ServerResponse, kind: "tool" | "text", status: "completed" | "incomplete", zero = false) {
  const item = kind === "tool"
    ? { id: "search-item", type: "function_call", call_id: "search", name: "search", arguments: '{"query":"fixture"}', status }
    : { id: "text-item", type: "message", role: "assistant", content: [{ type: "output_text", text: "codex fixture answer", annotations: [] }], status };
  const packets = [
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.done", response: {
      id: "codex-fixture", status, output: [item],
      ...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
      usage: { input_tokens: zero ? 0 : 11, output_tokens: zero ? 0 : 7, total_tokens: zero ? 0 : 18 },
    } },
  ];
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(packets.map((packet) => `event: ${packet.type}\ndata: ${JSON.stringify(packet)}\n\n`).join(""));
}

const CODEX_FIXTURE_TOKEN = `fixture.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" },
})).toString("base64")}.signature`;

const messages = [{ role: "user" as const, content: "fixture request" }];

describe("SDK completion terminal and transport boundary", () => {
  it("rejects partial length output with reported usage on both complete and stream results", async () => {
    const local = await gateway((_req, res) => reply(res, "length"));
    process.env.MIKRO_FIXTURE_KEY = "fixture-key";
    const model = local.model("MIKRO_FIXTURE_KEY");
    try {
      await assert.rejects(llmComplete(messages, model, { maxRetries: 0 }), (error: unknown) => {
        assert.ok(error instanceof LLMCompletionError);
        assert.equal(error.stopReason, "length");
        assert.equal(error.usage?.inputTokens, 11);
        assert.equal(error.usage?.outputTokens, 7);
        assert.equal(error.usage?.reasoningTokens, 2);
        assert.equal(error.usage?.llmCalls, 1);
        assert.ok(error.usage && Math.abs(error.usage.totalCost - 0.000025) < 1e-12);
        return true;
      });
      const runtime = await createPiModelRuntime(model);
      let observed = 0;
      const result = await streamLLMCompletion(runtime, resolveModel(model.provider, model.model, model.providers),
        { messages: [{ role: "user", content: "fixture request", timestamp: 0 }] },
        { ...buildCompletionOptions(model, { maxRetries: 0 }), onProviderStreamEvent: () => { observed++; } }).result();
      assert.ok(observed > 0, "caller provider observer is preserved");
      assert.throws(() => assertLLMCompletion(result, model), (error: unknown) => {
        assert.ok(error instanceof LLMCompletionError);
        assert.equal(error.usage?.inputTokens, 11);
        return true;
      });
    } finally { delete process.env.MIKRO_FIXTURE_KEY; await local.close(); }
  });

  it("keeps successful and failed sibling usage when a batch fails", async () => {
    const local = await gateway(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      reply(res, body.includes("truncate") ? "length" : "stop");
    });
    process.env.MIKRO_FIXTURE_KEY = "fixture-key";
    try {
      await assert.rejects(llmCompleteBatched(["complete", "truncate"], local.model("MIKRO_FIXTURE_KEY"), undefined, { maxRetries: 0 }), (error: unknown) => {
        assert.ok(error instanceof LLMCompletionError);
        assert.equal(error.stopReason, "length");
        assert.equal(error.usage?.inputTokens, 22);
        assert.equal(error.usage?.outputTokens, 14);
        assert.equal(error.usage?.llmCalls, 2);
        return true;
      });
    } finally { delete process.env.MIKRO_FIXTURE_KEY; await local.close(); }
  });

  it("uses three transport retries by default and respects explicit zero", async () => {
    let calls = 0;
    const local = await gateway((_req, res) => {
      calls++;
      if (calls % 4 !== 0) {
        res.writeHead(429, { "Content-Type": "application/json", "retry-after-ms": "1" });
        res.end(JSON.stringify({ error: { message: "fixture busy", type: "rate_limit_error" } }));
      } else reply(res);
    });
    process.env.MIKRO_FIXTURE_KEY = "fixture-key";
    try {
      const model = local.model("MIKRO_FIXTURE_KEY");
      const result = await llmComplete(messages, model);
      assert.equal(calls, 4);
      assert.equal(result.text, '{"answer":"partial"}');
      assert.equal(result.usage.llmCalls, 1, "SDK transport attempts are one logical model call");
      await assert.rejects(llmComplete(messages, model, { maxRetries: 0 }), LLMCompletionError);
      assert.equal(calls, 5);
    } finally { delete process.env.MIKRO_FIXTURE_KEY; await local.close(); }
  });

  it("keeps an explicitly zero sampling setting effective at the provider boundary", async () => {
    const local = await gateway(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      if (JSON.parse(body).temperature !== 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "This deterministic route requires zero temperature" } }));
      } else reply(res);
    });
    process.env.MIKRO_FIXTURE_KEY = "fixture-key";
    try {
      const result = await llmComplete(messages, local.model("MIKRO_FIXTURE_KEY"),
        { temperature: 0, maxRetries: 0 });
      assert.equal(result.text, '{"answer":"partial"}');
    } finally { delete process.env.MIKRO_FIXTURE_KEY; await local.close(); }
  });

  it("isolates equal provider ids across concurrent configurations and headless auth runtimes", async () => {
    const seen: Array<{ key: string | undefined; body: Record<string, unknown>; configured: string | undefined }> = [];
    const local = await gateway(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      seen.push({ key: req.headers.authorization, body: JSON.parse(body), configured: req.headers["x-configured"] as string | undefined });
      reply(res);
    });
    process.env.MIKRO_FIXTURE_A_KEY = "fixture-a";
    process.env.MIKRO_FIXTURE_B_KEY = "fixture-b";
    try {
      const a = local.model("MIKRO_FIXTURE_A_KEY");
      const b = local.model("MIKRO_FIXTURE_B_KEY");
      const controls = { temperature: 0, maxTokens: 23, maxRetries: 0,
        cacheConfig: { enabled: true, retention: "long" as const, sessionId: "fixture-session" } };
      await Promise.all([a, b].map((model) => llmComplete(messages, model, controls)));
      const runtime = await createPiModelRuntime(a);
      await runtime.completeSimple(resolveModel(a.provider, a.model, a.providers),
        { messages: [{ role: "user", content: "fixture request", timestamp: 0 }] }, buildCompletionOptions(a, controls));
      assert.deepEqual(seen.map((entry) => entry.key).sort(), ["Bearer fixture-a", "Bearer fixture-a", "Bearer fixture-b"]);
      for (const entry of seen) {
        assert.equal(entry.configured, "retained");
        assert.equal(entry.body.temperature, 0);
        assert.equal(entry.body.max_completion_tokens, 23);
        assert.equal(entry.body.prompt_cache_key, "fixture-session");
        assert.equal(entry.body.prompt_cache_retention, "24h");
      }
      assert.throws(() => resolveModel("isolated", "control"), /Unknown model/, "a configured provider cannot leak into the default catalog");
    } finally { delete process.env.MIKRO_FIXTURE_A_KEY; delete process.env.MIKRO_FIXTURE_B_KEY; await local.close(); }
  });

  it("surfaces provider errors without credentials, URLs or request bodies", async () => {
    process.env.MIKRO_FIXTURE_KEY = "fixture-secret";
    const local = await gateway((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: 'failed Bearer fixture-secret https://example.test/?token=fixture-secret {"messages":["private request"]}' } }));
    });
    try {
      await assert.rejects(llmComplete(messages, local.model("MIKRO_FIXTURE_KEY"), { maxRetries: 0 }), (error: unknown) => {
        assert.ok(error instanceof LLMCompletionError);
        assert.equal(error.stopReason, "error");
        assert.match(error.errorMessage, /failed/);
        assert.doesNotMatch(error.message, /fixture-secret|example\.test|private request/);
        return true;
      });
    } finally { delete process.env.MIKRO_FIXTURE_KEY; await local.close(); }
  });

  it("redacts bare header credentials and explicitly configured nonstandard env references", () => {
    const previous = process.env.MIKRO_GATEWAY_AUTH;
    process.env.MIKRO_GATEWAY_AUTH = "fixture-custom-auth";
    try {
      const model: ModelConfig = {
        provider: "isolated", model: "control",
        providers: parseCustomProviders({ isolated: {
          "base-url": "https://example.test/v1",
          "api-key-env": "MIKRO_GATEWAY_AUTH",
          headers: { Authorization: "Bearer fixture-header-credential" },
          models: { control: {} },
        } }, "fixture"),
      };
      const error = new LLMCompletionError("error",
        "Incorrect API key provided: fixture-header-credential; diagnostic fixture-custom-auth",
        undefined, model);
      assert.match(error.errorMessage, /Incorrect API key provided/);
      assert.doesNotMatch(error.message, /fixture-header-credential|fixture-custom-auth/);
    } finally {
      if (previous === undefined) delete process.env.MIKRO_GATEWAY_AUTH;
      else process.env.MIKRO_GATEWAY_AUTH = previous;
    }
  });

  it("redacts trimmed header values and bare Bearer/Basic credentials as transmitted by Headers", () => {
    const providerHeaders = { "X-Api-Key": " \tfixture-padded-key \t", Authorization: " \tBearer fixture-padded-bearer \t" };
    const modelHeaders = { Authorization: " \tBasic Zml4dHVyZTpjYW5hcnk= \t" };
    const config: ModelConfig = { provider: "isolated", model: "control", providers: parseCustomProviders({
      isolated: { "base-url": "https://example.test/v1", headers: providerHeaders,
        models: { control: { headers: modelHeaders } } },
    }, "fixture") };
    const transmitted = new Headers(providerHeaders);
    const modelTransmitted = new Headers(modelHeaders);
    const diagnostic = `Incorrect API key: ${transmitted.get("X-Api-Key")}; bare fixture-padded-bearer; ` +
      `${transmitted.get("Authorization")}; bare Zml4dHVyZTpjYW5hcnk=; ${modelTransmitted.get("Authorization")}; ` +
      providerHeaders["X-Api-Key"];
    const error = new LLMCompletionError("error", diagnostic, undefined, config);
    assert.match(error.errorMessage, /Incorrect API key/);
    assert.doesNotMatch(error.message, /fixture-padded-key|fixture-padded-bearer|Zml4dHVyZTpjYW5hcnk=/);
  });

  it("distinguishes cancellation from empty completion", async () => {
    const controller = new AbortController();
    const local = await gateway(() => { controller.abort(); });
    process.env.MIKRO_FIXTURE_KEY = "fixture-key";
    try {
      await assert.rejects(llmComplete(messages, local.model("MIKRO_FIXTURE_KEY"), { signal: controller.signal, maxRetries: 0 }), (error: unknown) => {
        assert.ok(error instanceof LLMCompletionError);
        assert.equal(error.stopReason, "aborted");
        return true;
      });
    } finally { delete process.env.MIKRO_FIXTURE_KEY; await local.close(); }
  });
});

describe("configured gateway overrides", () => {
  it("retains declared station/khal URLs, catalogs and auth instead of overlaying built-in gateways", async () => {
    let calls = 0;
    const local = await gateway((_req, res) => { calls++; reply(res); });
    process.env.MIKRO_FIXTURE_KEY = "fixture-key";
    try {
      for (const id of ["station", "khal"]) {
        const base = local.model("MIKRO_FIXTURE_KEY");
        const model: ModelConfig = { provider: id, model: "control",
          providers: [{ ...base.providers![0], id }] };
        const result = await llmComplete(messages, model, { maxRetries: 0 });
        assert.equal(result.text, '{"answer":"partial"}');
      }
      assert.equal(calls, 2);
    } finally { delete process.env.MIKRO_FIXTURE_KEY; await local.close(); }
  });
});

describe("provider usage provenance and cancellation accounting", () => {
  for (const outcome of ["http-error", "disconnect", "reported-zero"] as const) {
    it(`does not invent billing for ${outcome}`, async () => {
      const fixture = await mkdtemp(join(tmpdir(), "mikro-usage-"));
      const previousHome = process.env.HOME;
      process.env.HOME = fixture;
      process.env.MIKRO_FIXTURE_KEY = "fixture-key";
      const local = await gateway((_req, res) => {
        if (outcome === "http-error") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "fixture rejected" } }));
        } else {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          const chunk = { id: "fixture", choices: [{ index: 0, delta: { content: "partial" }, finish_reason: outcome === "reported-zero" ? "length" : null }],
            ...(outcome === "reported-zero" ? { usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } } : {}) };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          if (outcome === "reported-zero") res.end("data: [DONE]\n\n");
          else setImmediate(() => res.destroy());
        }
      });
      try {
        const model = local.model("MIKRO_FIXTURE_KEY");
        const zeroCounts = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
          reasoningTokens: 0, totalCost: 0, llmCalls: 0 };
        const expected = outcome === "reported-zero" ? { ...zeroCounts, llmCalls: 1 } : undefined;
        await assert.rejects(llmComplete(messages, model, { maxRetries: 0 }), (error: unknown) => {
          assert.ok(error instanceof LLMCompletionError);
          assert.deepEqual(error.usage, expected);
          return true;
        });
        const usage = createUsage();
        const config = { ...await loadConfig(fixture), model };
        await assert.rejects(handleLLMRequest({ type: "llm_request", request_type: "llm_query", prompts: ["fixture"] },
          config, usage, undefined, undefined, undefined, undefined, { maxRetries: 0 }), LLMCompletionError);
        assert.deepEqual(usage, expected ?? zeroCounts, "IPC owner merges only proven usage exactly once");
      } finally {
        if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
        delete process.env.MIKRO_FIXTURE_KEY;
        await local.close();
        await rm(fixture, { recursive: true, force: true });
      }
    });
  }

  for (const when of ["before-auth", "during-auth"] as const) {
    it(`classifies cancellation ${when} without network or billed usage`, { timeout: 5000 }, async () => {
      let requests = 0;
      const local = await gateway((_req, res) => { requests++; reply(res); });
      const model = local.model("MIKRO_FIXTURE_KEY");
      const runtime = getModelRuntime(model.providers);
      const provider = runtime.getProvider(model.provider)!;
      const controller = new AbortController();
      let started!: () => void;
      const authStarted = new Promise<void>((resolve) => { started = resolve; });
      let authCalls = 0;
      runtime.setProvider({ ...provider, auth: { apiKey: {
        name: "fixture auth",
        resolve: async ({ signal }) => {
          authCalls++;
          started();
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          return { auth: { apiKey: "fixture-key" }, source: "fixture" };
        },
      } } });
      try {
        if (when === "before-auth") controller.abort();
        const pending = llmComplete(messages, model, { signal: controller.signal, maxRetries: 0 });
        const rejected = assert.rejects(pending, (error: unknown) => {
          assert.ok(error instanceof LLMCompletionError);
          assert.equal(error.stopReason, "aborted");
          assert.equal(error.usage, undefined);
          return true;
        });
        if (when === "during-auth") { await authStarted; controller.abort(); }
        await rejected;
        assert.equal(authCalls, when === "before-auth" ? 0 : 1);
        const streamed = await streamLLMCompletion(runtime, resolveModel(model.provider, model.model, model.providers),
          { messages: [{ role: "user", content: "fixture", timestamp: 0 }] }, { signal: controller.signal }).result();
        assert.throws(() => assertLLMCompletion(streamed, model), (error: unknown) => {
          assert.ok(error instanceof LLMCompletionError);
          assert.equal(error.stopReason, "aborted");
          assert.equal(error.usage, undefined);
          return true;
        });
        assert.equal(requests, 0);
      } finally { await local.close(); }
    });
  }
});

describe("SDK receiving failure accounting", () => {
  for (const reportTerminalUsage of [true, false]) {
    it(`forwards billed tool-turn and ${reportTerminalUsage ? "reported" : "unreported"} terminal failure once through runAgent`, async () => {
      let requests = 0;
      const local = await gateway((_req, res) => {
        if (++requests === 1) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.end(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{
            index: 0, id: "search", type: "function", function: { name: "search", arguments: '{"query":"fixture"}' },
          }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })}\n\ndata: [DONE]\n\n`);
        } else if (reportTerminalUsage) reply(res, "length");
        else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "fixture rejected" } }));
        }
      });
      process.env.MIKRO_FIXTURE_KEY = "fixture-key";
      try {
        let tools = 0;
        const registry = createToolRegistry();
        registry.register("search", async () => { tools++; return "entry"; }, {
          description: "fixture search", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        });
        const events = [];
        for await (const event of runAgent({ agentId: "usage-fixture", input: "fixture", toolRegistry: registry,
          sessionId: `usage-fixture-${reportTerminalUsage}`,
          driver: rlmDriver({ model: local.model("MIKRO_FIXTURE_KEY"), tools: { registry }, completionOptions: { maxRetries: 0 } }) })) events.push(event);
        assert.equal(tools, 1);
        assert.equal(requests, 2);
        assert.equal(events.some((event) => event.type === "EmitDone"), false);
        const errors = events.filter((event) => event.type === "Error");
        assert.equal(errors.length, 1);
        const terminal = errors[0]!;
        assert.equal(terminal.error.stopReason, reportTerminalUsage ? "length" : "error");
        const calls = reportTerminalUsage ? 2 : 1;
        assert.equal(terminal.error.usage?.inputTokens, 11 * calls);
        assert.equal(terminal.error.usage?.outputTokens, 7 * calls);
        assert.equal(terminal.error.usage?.llmCalls, calls);
        assert.ok(Math.abs(terminal.error.usage!.totalCost - 0.000025 * calls) < 1e-12);
        assert.ok(events.some((event) => event.type === "SessionClose" && event.reason === "error"));
      } finally { delete process.env.MIKRO_FIXTURE_KEY; await local.close(); }
    });
  }
});

describe("Responses failure usage packet normalization", () => {
  it("retains response.failed usage that SDK 1.0.2 does not normalize before throwing", async () => {
    const local = await gateway((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: {
        id: "failed-fixture", status: "failed", error: { code: "fixture", message: "fixture failure" },
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18,
          input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } },
      } })}\n\n`);
    });
    process.env.MIKRO_FIXTURE_KEY = "fixture-key";
    try {
      const base = local.model("MIKRO_FIXTURE_KEY");
      const model: ModelConfig = { ...base, providers: [{ ...base.providers![0], api: "openai-responses" }] };
      await assert.rejects(llmComplete(messages, model, { maxRetries: 0 }), (error: unknown) => {
        assert.ok(error instanceof LLMCompletionError);
        assert.equal(error.stopReason, "error");
        assert.equal(error.usage?.inputTokens, 8);
        assert.equal(error.usage?.outputTokens, 7);
        assert.equal(error.usage?.cacheReadTokens, 3);
        assert.equal(error.usage?.reasoningTokens, 2);
        assert.equal(error.usage?.llmCalls, 1);
        assert.ok(error.usage && Math.abs(error.usage.totalCost - 0.000022) < 1e-12);
        return true;
      });
    } finally { delete process.env.MIKRO_FIXTURE_KEY; await local.close(); }
  });
});

describe("actual Codex response.done usage boundary", () => {
  for (const zero of [false, true]) {
    it(`retains ${zero ? "genuinely zero" : "reported"} usage on a length stop`, async () => {
      const local = await gateway((_req, res) => replyCodex(res, "text", "incomplete", zero));
      process.env.MIKRO_FIXTURE_KEY = CODEX_FIXTURE_TOKEN;
      try {
        const config = local.model("MIKRO_FIXTURE_KEY");
        const { runtime, model } = codexRuntime(config);
        const response = await streamLLMCompletion(runtime, model,
          { messages: [{ role: "user", content: "fixture", timestamp: 0 }] }, { transport: "sse", maxRetries: 0 }).result();
        assert.throws(() => assertLLMCompletion(response, config), (error: unknown) => {
          assert.ok(error instanceof LLMCompletionError);
          assert.equal(error.stopReason, "length");
          assert.equal(error.usage?.inputTokens, zero ? 0 : 11);
          assert.equal(error.usage?.outputTokens, zero ? 0 : 7);
          assert.equal(error.usage?.llmCalls, 1);
          return true;
        });
      } finally { delete process.env.MIKRO_FIXTURE_KEY; await local.close(); }
    });
  }

  it("retains cumulative native tool-loop success usage through the real Codex adapter", async () => {
    let requests = 0;
    const local = await gateway((_req, res) => replyCodex(res, ++requests === 1 ? "tool" : "text", "completed"));
    process.env.MIKRO_FIXTURE_KEY = CODEX_FIXTURE_TOKEN;
    try {
      const config = local.model("MIKRO_FIXTURE_KEY");
      const { runtime, model } = codexRuntime(config);
      const registry = createToolRegistry();
      let tools = 0;
      registry.register("search", async () => { tools++; return "entry"; }, {
        description: "fixture search", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      });
      const events = [];
      for await (const event of runAgent({
        agentId: "codex-fixture", sessionId: "codex-fixture-success", input: "fixture", toolRegistry: registry,
        driver: rlmDriver({ model: config, tools: { registry },
          toolsLlm: (context, _config, signal) => streamLLMCompletion(runtime, model, context,
            { signal, transport: "sse", maxRetries: 0 }).result() }),
      })) events.push(event);
      assert.equal(requests, 2);
      assert.equal(tools, 1);
      assert.equal(events.some((event) => event.type === "Error"), false);
      const finals = events.filter((event) => event.type === "EmitDone");
      assert.equal(finals.length, 1);
      const payload = finals[0]!.payload;
      assert.ok(payload && typeof payload === "object" && "answer" in payload && "usage" in payload);
      assert.equal(payload.answer, "codex fixture answer");
      const usage = payload.usage;
      assert.ok(usage && typeof usage === "object" && "input" in usage && "output" in usage && "total" in usage);
      assert.equal(usage.input, 22);
      assert.equal(usage.output, 14);
      assert.ok(typeof usage.total === "number" && Math.abs(usage.total - 0.00005) < 1e-12);
    } finally { delete process.env.MIKRO_FIXTURE_KEY; await local.close(); }
  });
});

describe("runAgent cancellation terminal accounting", () => {
  for (const when of ["during-request", "before-normalization"] as const) {
    it(`delivers one cumulative aborted receipt ${when} without processing partial output`, async () => {
      const controller = new AbortController();
      let requests = 0;
      const local = await gateway((_req, res) => {
        if (++requests === 1) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.end(`data: ${JSON.stringify({ id: "first", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{
            index: 0, id: "search", type: "function", function: { name: "search", arguments: '{"query":"fixture"}' },
          }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })}\n\ndata: [DONE]\n\n`);
        } else if (when === "during-request") controller.abort();
        else {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.end(`data: ${JSON.stringify({ id: "cancel-partial", choices: [{ index: 0, delta: { content: "untrusted partial" }, finish_reason: null }],
            usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12,
              prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 1 } } })}\n\n`);
        }
      });
      process.env.MIKRO_FIXTURE_KEY = "fixture-key";
      try {
        const config = local.model("MIKRO_FIXTURE_KEY");
        const runtime = getModelRuntime(config.providers);
        const model = resolveModel(config.provider, config.model, config.providers);
        const registry = createToolRegistry();
        let tools = 0;
        registry.register("search", async () => { tools++; return "entry"; }, {
          description: "fixture search", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        });
        const events = [];
        for await (const event of runAgent({
          agentId: "abort-fixture", sessionId: `abort-fixture-${when}`, input: "fixture", toolRegistry: registry, signal: controller.signal,
          driver: rlmDriver({ model: config, tools: { registry },
            toolsLlm: (context, _config, signal) => streamLLMCompletion(runtime, model, context, {
              signal, maxRetries: 0, onProviderStreamEvent: (packet) => {
                if (packet && typeof packet === "object" && "id" in packet && packet.id === "cancel-partial") {
                  controller.abort();
                  throw new Error("fixture cancellation before SDK normalization");
                }
              },
            }).result() }),
        })) events.push(event);
        assert.equal(requests, 2);
        assert.equal(tools, 1);
        assert.equal(events.some((event) => event.type === "EmitDone"), false);
        assert.equal(events.some((event) => event.type === "Message" && event.content.includes("untrusted partial")), false);
        const errors = events.filter((event) => event.type === "Error");
        assert.equal(errors.length, 1);
        const error = errors[0]!.error;
        assert.equal(error.stopReason, "aborted");
        assert.equal(error.usage?.inputTokens, when === "during-request" ? 11 : 16);
        assert.equal(error.usage?.outputTokens, when === "during-request" ? 7 : 10);
        assert.equal(error.usage?.cacheReadTokens, when === "during-request" ? 0 : 4);
        assert.equal(error.usage?.reasoningTokens, when === "during-request" ? 0 : 1);
        assert.equal(error.usage?.llmCalls, when === "during-request" ? 1 : 2);
        assert.ok(error.usage && Math.abs(error.usage.totalCost - (when === "during-request" ? 0.000025 : 0.000036)) < 1e-12);
        assert.equal(events.filter((event) => event.type === "SessionClose" && event.reason === "abort").length, 1);
      } finally { delete process.env.MIKRO_FIXTURE_KEY; await local.close(); }
    });
  }
});

describe("Anthropic reported reasoning and fallback pricing", () => {
  for (const stopReason of ["end_turn", "max_tokens"]) {
    it(`preserves incremental thinking usage and served-model prices on ${stopReason}`, async () => {
      const local = await gateway((_req, res) => {
        const packets = [
          { type: "message_start", message: {
            id: "fixture", type: "message", role: "assistant", model: "served-control", content: [],
            stop_reason: null, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 0 },
          } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "READY" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: null, stop_sequence: null },
            usage: { output_tokens: 7, output_tokens_details: { thinking_tokens: 2 } } },
          { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: 7 } },
          { type: "message_stop" },
        ];
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(packets.map((packet) => `event: ${packet.type}\ndata: ${JSON.stringify(packet)}\n\n`).join(""));
      });
      process.env.MIKRO_FIXTURE_KEY = "fixture-key";
      const config = local.model("MIKRO_FIXTURE_KEY");
      assert.ok(config.providers);
      config.providers[0].api = "anthropic-messages";
      const model = {
        ...resolveModel(config.provider, config.model, config.providers),
        compat: { allowedFallbackModels: [{
          provider: config.provider, model: "served-control",
          cost: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 },
        }] },
      };
      try {
        const response = await streamLLMCompletion(getModelRuntime(config.providers), model,
          { messages: [{ role: "user", content: "local protocol fixture", timestamp: 0 }] },
          buildCompletionOptions(config, { maxRetries: 0 })).result();
        assert.equal(response.usage.reasoning, 2);
        assert.ok(Math.abs(response.usage.cost.total - 0.000061) < 1e-12);
        assert.equal(response.responseModel, "served-control");
        if (stopReason === "max_tokens") {
          assert.throws(() => assertLLMCompletion(response, config), (error: unknown) => {
            assert.ok(error instanceof LLMCompletionError);
            assert.equal(error.stopReason, "length");
            assert.equal(error.usage?.reasoningTokens, 2);
            assert.ok(error.usage && Math.abs(error.usage.totalCost - 0.000061) < 1e-12);
            return true;
          });
        } else {
          assert.equal(response.stopReason, "stop");
          assert.equal(response.content.filter((part) => part.type === "text").map((part) => part.text).join(""), "READY");
        }
      } finally { delete process.env.MIKRO_FIXTURE_KEY; await local.close(); }
    });
  }
});
