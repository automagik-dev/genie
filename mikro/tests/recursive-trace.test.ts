import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createUsage, mergeUsage, usageDelta, parseRlmChildOutput, buildRlmChildArgs, buildChildEnv, classifyRlmChildResult, resolveChildModelRef, stderrTail } from "../src/llm.js";
import { buildStats, type RLMResult } from "../src/output.js";
import { LangfuseTraceRecorder } from "../src/langfuse.js";

describe("recursive RLM tracing helpers", () => {
  it("parses child json answer, run id, usage, and stats without losing the answer", () => {
    const parsed = parseRlmChildOutput(JSON.stringify({
      answer: "child verdict",
      usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 2, cacheWriteTokens: 3, totalCost: 0.0123, llmCalls: 2 },
      stats: { run_id: "child-run-123" },
    }));

    assert.equal(parsed.answer, "child verdict");
    assert.equal(parsed.runId, "child-run-123");
    assert.deepEqual(parsed.usage, { inputTokens: 11, outputTokens: 7, cacheReadTokens: 2, cacheWriteTokens: 3, totalCost: 0.0123, llmCalls: 2 });
  });

  it("builds bounded child invocation flags and increments recursion depth in env", () => {
    const args = buildRlmChildArgs("subproblem", {
      output: "json",
      maxIterations: 4,
      timeout: 120000,
      maxDepth: 3,
      maxCost: 0.25,
      maxTokens: 5000,
      logPath: "/tmp/parent.jsonl",
      stats: true,
      noSession: true,
    });

    assert.deepEqual(args, [
      "subproblem",
      "--output", "json",
      "--stats",
      "--max-iterations", "4",
      "--timeout", "120000",
      "--max-depth", "3",
      "--max-cost", "0.25",
      "--max-tokens", "5000",
      "--no-session",
    ]);

    const env = buildChildEnv({ ...process.env, MIKRO_RECURSION_DEPTH: "1" }, "parent-run", "child-corr");
    assert.equal(env.MIKRO_PARENT_RUN_ID, "parent-run");
    assert.equal(env.MIKRO_CHILD_CORRELATION_ID, "child-corr");
    assert.equal(env.MIKRO_RECURSION_DEPTH, "2");
  });

  it("computes root/child/total usage splits", () => {
    const total = createUsage();
    mergeUsage(total, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 5, cacheWriteTokens: 6, totalCost: 0.15, llmCalls: 3 });
    const child = createUsage();
    mergeUsage(child, { inputTokens: 40, outputTokens: 10, cacheReadTokens: 1, cacheWriteTokens: 2, totalCost: 0.05, llmCalls: 1 });

    assert.deepEqual(usageDelta(total, child), {
      inputTokens: 60,
      outputTokens: 40,
      cacheReadTokens: 4,
      cacheWriteTokens: 4,
      totalCost: 0.09999999999999999,
      llmCalls: 2,
      reasoningTokens: 0,
    });
  });

  it("includes root/child/total token and cost splits in stats", () => {
    const result: RLMResult = {
      answer: "ok",
      references: [],
      usage: { inputTokens: 150, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0.23, llmCalls: 5 },
      usageBreakdown: {
        root: { inputTokens: 100, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0.16, llmCalls: 3 },
        child: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0.07, llmCalls: 2 },
        total: { inputTokens: 150, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0.23, llmCalls: 5 },
      },
      iterations: 2,
      model: "openrouter/deepseek-v4-pro",
    };

    const stats = buildStats(result, { time_ms: 1000, run_id: "root-run" });
    assert.deepEqual(stats.usage_split, {
      root: { input_tokens: 100, output_tokens: 60, total_tokens: 160, total_cost: 0.16, llm_calls: 3 },
      child: { input_tokens: 50, output_tokens: 20, total_tokens: 70, total_cost: 0.07, llm_calls: 2 },
      total: { input_tokens: 150, output_tokens: 80, total_tokens: 230, total_cost: 0.23, llm_calls: 5 },
    });
  });

  it("builds a Langfuse parent trace with child_start and child_end spans", async () => {
    const payloads: unknown[] = [];
    const recorder = new LangfuseTraceRecorder({
      host: "https://langfuse.example",
      publicKey: "pk",
      secretKey: "sk",
      fetchImpl: async (_url: string | URL | Request, init?: RequestInit) => {
        payloads.push(JSON.parse(String(init?.body)));
        return new Response("{}", { status: 200 });
      },
    });

    recorder.startTrace({ runId: "root-run", query: "root query", model: "openrouter/deepseek-v4-pro" });
    const spanId = recorder.childStart({ parentRunId: "root-run", childRunId: "pending", correlationId: "child-1", prompt: "child query", depth: 1 });
    recorder.childEnd(spanId, { childRunId: "child-run", answerPreview: "child answer", durationMs: 42, usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0.01, llmCalls: 1 } });
    await recorder.flush();

    const batch = payloads.flatMap((p) => (p as { batch: unknown[] }).batch);
    assert.equal(batch.some((e) => (e as { type: string }).type === "trace-create"), true);
    assert.equal(batch.filter((e) => (e as { type: string }).type === "span-create").length, 1);
    assert.equal(batch.filter((e) => (e as { type: string }).type === "span-update").length, 1);
    assert.equal((batch.find((e) => (e as { type: string }).type === "span-update") as { body: { metadata: { child_run_id: string } } }).body.metadata.child_run_id, "child-run");
  });

  it("builds root Langfuse generation create/update events with model, IO, usage, and latency", async () => {
    const payloads: unknown[] = [];
    const recorder = new LangfuseTraceRecorder({
      host: "https://langfuse.example",
      publicKey: "pk",
      secretKey: "sk",
      fetchImpl: async (_url: string | URL | Request, init?: RequestInit) => {
        payloads.push(JSON.parse(String(init?.body)));
        return new Response("{}", { status: 200 });
      },
    });

    recorder.startTrace({ runId: "root-run", query: "root query", model: "anthropic/claude-opus-4-8" });
    const generationId = recorder.rootGenerationStart({
      name: "Model call — root iteration 1",
      input: [{ role: "user", content: "hello" }],
      model: "anthropic/claude-opus-4-8",
      iteration: 0,
    });
    recorder.rootGenerationEnd(generationId, {
      output: "world",
      durationMs: 123,
      usage: { inputTokens: 5, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 2, totalCost: 0.42, llmCalls: 1 },
    });
    await recorder.flush();

    const batch = payloads.flatMap((p) => (p as { batch: unknown[] }).batch) as Array<{ type: string; body: Record<string, any> }>;
    const generationCreate = batch.find((e) => e.type === "generation-create");
    const generationUpdate = batch.find((e) => e.type === "generation-update");
    assert.ok(generationCreate, "generation-create event missing");
    assert.ok(generationUpdate, "generation-update event missing");
    assert.equal(generationCreate.body.traceId, "root-run");
    assert.equal(generationCreate.body.model, "anthropic/claude-opus-4-8");
    assert.deepEqual(generationCreate.body.input, [{ role: "user", content: "hello" }]);
    assert.equal(generationUpdate.body.output, "world");
    assert.equal(generationUpdate.body.usage.input, 5);
    assert.equal(generationUpdate.body.usage.output, 7);
    assert.equal(generationUpdate.body.usage.total, 14);
    assert.equal(generationUpdate.body.usageDetails.input, 5);
    assert.equal(generationUpdate.body.usageDetails.output, 7);
    assert.equal(generationUpdate.body.usageDetails.cache_read, 0);
    assert.equal(generationUpdate.body.usageDetails.cache_write, 2);
    assert.equal(generationUpdate.body.costDetails.total, 0.42);
    assert.equal(generationUpdate.body.metadata.duration_ms, 123);
    assert.equal(generationUpdate.body.metadata.total_cost, 0.42);
  });
});

/**
 * `rlm_query(p, model="X")` used to be a silent no-op — the Python bridge put
 * the kwarg on the wire (`python/llm_bridge.py:32-33`) and the Node handler
 * never read `request.model`. Worse, with no `--model` on the child argv the
 * child re-derived its model from whatever config sat at its cwd and inherited
 * HOME, so a parent's model pin was lost entirely on every recursive spawn.
 */
describe("recursive child model pinning", () => {
  it("emits --model on the child argv when the parent resolved one", () => {
    const args = buildRlmChildArgs("subproblem", {
      output: "json",
      model: "khal/deepseek-v4-flash",
      stats: true,
      maxIterations: 4,
      noSession: true,
    });

    assert.deepEqual(args, [
      "subproblem",
      "--output", "json",
      "--stats",
      "--model", "khal/deepseek-v4-flash",
      "--max-iterations", "4",
      "--no-session",
    ]);
  });

  it("omits --model when no model was resolved", () => {
    const args = buildRlmChildArgs("subproblem", { output: "json" });
    assert.equal(args.includes("--model"), false);
  });

  const config = (provider: string, model: string, subCallModel?: string) =>
    ({ model: { provider, model, subCallModel } }) as unknown as Parameters<typeof resolveChildModelRef>[0];

  it("defaults the child to the parent's primary model, not its sub-call model", () => {
    assert.equal(
      resolveChildModelRef(config("khal", "deepseek-v4-flash", "deepseek-v4-mini")),
      "khal/deepseek-v4-flash"
    );
  });

  it("honours the model= kwarg, keeping the parent's provider", () => {
    assert.equal(
      resolveChildModelRef(config("khal", "deepseek-v4-flash"), "deepseek-v4-pro"),
      "khal/deepseek-v4-pro"
    );
  });

  it("falls back to the parent's model for an empty kwarg", () => {
    assert.equal(
      resolveChildModelRef(config("khal", "deepseek-v4-flash"), ""),
      "khal/deepseek-v4-flash"
    );
  });

  it("does not double-prefix a kwarg that already names the provider", () => {
    assert.equal(
      resolveChildModelRef(config("khal", "deepseek-v4-flash"), "khal/deepseek-v4-pro"),
      "khal/deepseek-v4-pro"
    );
  });
});

/**
 * The silent-failure bug. A child that cannot reach a model still exits 0 and
 * still prints `{"answer":""}` — round 1's three recursive spawns all died
 * this way and were handed back to the REPL as ordinary empty results. The
 * parent must classify that as an explicit error the model can react to.
 */
describe("classifyRlmChildResult", () => {
  const ok = JSON.stringify({
    answer: "child verdict",
    usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0.01, llmCalls: 1 },
    stats: { run_id: "child-run-123" },
  });

  it("passes a real answer through untouched, with usage intact", () => {
    const { result, isError } = classifyRlmChildResult(0, ok, "");
    assert.equal(isError, false);
    assert.equal(result.answer, "child verdict");
    assert.equal(result.runId, "child-run-123");
    assert.equal(result.usage?.totalCost, 0.01);
  });

  it("turns a zero-exit empty answer into an explicit rlm_query failure", () => {
    const stdout = JSON.stringify({
      answer: "",
      model: "google/gemini-3.1-flash-lite-preview",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0, llmCalls: 1 },
    });
    const stderr = "mikro [iter 0]: WARNING — LLM returned empty response. Possible context size limit.";

    const { result, isError, errorMessage } = classifyRlmChildResult(0, stdout, stderr);
    assert.equal(isError, true);
    assert.ok(result.answer.startsWith("Error: rlm_query failed:"), result.answer);
    assert.ok(result.answer.includes("empty answer"), result.answer);
    assert.ok(result.answer.includes("LLM returned empty response"), result.answer);
    assert.equal(errorMessage, result.answer);
    // Usage is still reported so the parent's cost accounting stays honest.
    assert.equal(result.usage?.llmCalls, 1);
  });

  it("treats a whitespace-only answer as a failure too", () => {
    const { isError } = classifyRlmChildResult(0, JSON.stringify({ answer: "  \n " }), "");
    assert.equal(isError, true);
  });

  it("flags a zero exit with unparseable stdout", () => {
    const { result, isError } = classifyRlmChildResult(0, "", "Traceback: boom");
    assert.equal(isError, true);
    assert.ok(result.answer.startsWith("Error: rlm_query failed:"), result.answer);
    assert.ok(result.answer.includes("Traceback: boom"), result.answer);
  });

  it("keeps the existing non-zero-exit message shape", () => {
    const { result, isError, errorMessage } = classifyRlmChildResult(1, "", "boom");
    assert.equal(isError, true);
    assert.equal(result.answer, "Error: child mikro exited with code 1. boom");
    assert.equal(errorMessage, result.answer);
  });

  it("collapses and tail-truncates a long stderr instead of dumping it", () => {
    const stderr = `${"x".repeat(1000)}\n\n   the last thing that went wrong`;
    const { result } = classifyRlmChildResult(0, JSON.stringify({ answer: "" }), stderr);
    assert.ok(result.answer.includes("the last thing that went wrong"), result.answer);
    assert.ok(result.answer.length < 600, `error string too long: ${result.answer.length}`);
    assert.equal(result.answer.includes("\n"), false);
  });
});

describe("stderrTail", () => {
  it("returns an empty string for empty stderr", () => {
    assert.equal(stderrTail(""), "");
    assert.equal(stderrTail("   \n\t "), "");
  });

  it("returns short stderr verbatim, whitespace-collapsed", () => {
    assert.equal(stderrTail("  boom\n  bang  "), "boom bang");
  });

  it("keeps the tail, marked with an ellipsis", () => {
    const out = stderrTail("abcdefghij", 4);
    assert.equal(out, "…ghij");
  });
});

describe("recursive subprocess cancellation", () => {
  for (const mode of ["already-aborted", "queued-batch", "settled-batch"] as const) {
    const behavior = mode === "settled-batch"
      ? "accounts every settled child exactly once on successful batches"
      : `keeps settled receipts without dispatching ${mode} children after their generation is retired`;
    it(behavior, async () => {
      const dir = await mkdtemp(join(tmpdir(), "mikro-recursion-cancel-"));
      const entry = join(dir, "recursive-child.mjs");
      // rlmQuery uses its parent's entry point for recursive subprocesses.
      // Keep that entry point in a separate host, never mutate test-runner argv.
      await writeFile(entry, `
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { getEventListeners } from "node:events";
import { createUsage, handleLLMRequest, llmCompleteSimple, rlmQuery, usageDelta } from ${JSON.stringify(new URL("../src/llm.js", import.meta.url).href)};
import { parseCustomProviders } from ${JSON.stringify(new URL("../src/custom-providers.js", import.meta.url).href)};
import { buildStats } from ${JSON.stringify(new URL("../src/output.js", import.meta.url).href)};
import { BudgetTracker } from ${JSON.stringify(new URL("../src/budget.js", import.meta.url).href)};

function model(port) {
  return { provider: "isolated", model: "control", providers: parseCustomProviders({ isolated: {
    "base-url": "http://127.0.0.1:" + port + "/v1", "api-key-env": "MIKRO_RECURSION_FIXTURE_KEY",
    models: { control: { cost: { input: 1, output: 2 } } },
  } }, "local recursion fixture") };
}
function reply(response) {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end("data: " + JSON.stringify({
    object: "chat.completion.chunk", model: "control",
    choices: [{ index: 0, delta: { role: "assistant", content: "local child receipt" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, completion_tokens_details: { reasoning_tokens: 2 } },
  }) + "\\n\\ndata: [DONE]\\n\\n");
}
if (process.argv[2]?.startsWith("child-")) {
  // Exercise the real SDK transport and recursive stdout receipt, not an
  // onChildEnd mock that supplies the accounting the owner should perform.
  const response = await llmCompleteSimple(process.argv[2], model(process.env.MIKRO_RECURSION_FIXTURE_PORT),
    undefined, { maxRetries: 0 });
  console.log(JSON.stringify({ answer: response.text, usage: response.usage, stats: { run_id: randomUUID() } }));
} else {
  const mode = process.argv[2];
  const controller = new AbortController();
  const reason = new Error("fixture generation retired");
  const dispatches = [];
  const starts = [];
  const ends = [];
  const parked = [];
  const firstBatch = Promise.withResolvers();
  const usage = createUsage();
  const childUsage = createUsage();
  const budget = new BudgetTracker({ maxCost: null, maxTokens: 18, maxDepth: null });
  // Failure-only watchdog for detached subprocesses that fake timers in the
  // test runner cannot reach. Readiness/cancellation await HTTP and settlement.
  const deadline = mode !== "already-aborted" ? setTimeout(() => {
    controller.abort(reason);
    if (mode === "queued-batch") firstBatch.reject(new Error("fixture first batch never reached the local server"));
  }, 20_000) : undefined;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const prompt = JSON.parse(body).messages.at(-1).content;
    dispatches.push(prompt);
    if (mode === "queued-batch") {
      parked.push({ prompt, response });
      if (parked.length === 4) firstBatch.resolve();
    } else {
      reply(response);
    }
  });
  const listening = Promise.withResolvers();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  process.env.MIKRO_RECURSION_FIXTURE_PORT = String(server.address().port);
  process.env.MIKRO_RECURSION_FIXTURE_KEY = "local-fixture-only";
  const config = { configDir: import.meta.dirname, model: model(server.address().port) };
  const options = {
    onChildStart: ({ prompt, correlationId }) => { starts.push({ prompt, correlationId }); },
    onChildEnd: (data) => {
      ends.push(data);
      if (mode === "queued-batch" && data.result.usage) controller.abort(reason);
    },
  };
  if (mode === "already-aborted") controller.abort(reason);
  const prompts = [
    ...Array.from({ length: 4 }, (_, i) => "child-first-" + i),
    ...Array.from({ length: 4 }, (_, i) => "child-queued-" + i),
  ];
  const pending = (mode === "already-aborted"
    ? rlmQuery("child-pre-aborted", import.meta.dirname, controller.signal, options)
    : handleLLMRequest({ request_type: "rlm_query_batched", prompts }, config, usage,
        controller.signal, undefined, undefined, childUsage, options)
  // Mirror the RLM consumer's finally(recordBudgetUsage): failures still
  // update its budget using the cumulative totals owned by handleLLMRequest.
  ).finally(() => budget.record(usage.inputTokens, usage.outputTokens, usage.totalCost))
    .then(() => "resolved", (error) => error === reason ? reason.message : String(error));
  try {
    if (mode === "queued-batch") {
      await firstBatch.promise;
      reply(parked.find(({ prompt }) => prompt === "child-first-0").response);
    }
    const settlement = await pending;
    const stats = buildStats({
      answer: settlement, references: [], iterations: 0, model: "isolated/control", usage,
      usageBreakdown: { root: usageDelta(usage, childUsage), child: childUsage, total: usage },
    }, { time_ms: 0, budget_hit: budget.getState().budgetHit });
    console.log(JSON.stringify({
      settlement,
      starts: starts.map(({ prompt }) => prompt).sort(),
      dispatches: dispatches.sort(),
      completedChildren: ends.length,
      failedChildren: ends.filter(({ isError }) => isError === true).length,
      paidChildren: ends.filter(({ result }) => result.usage !== undefined).length,
      paidIdentities: ends.filter(({ result }) => result.usage !== undefined).every(({ result }) => typeof result.runId === "string"),
      unknownKilledChildren: ends.filter(({ result, isError }) => isError && result.usage === undefined && result.runId === undefined).length,
      matchedCompletions: ends.every(({ correlationId }) => starts.some((start) => start.correlationId === correlationId)),
      remainingAbortListeners: getEventListeners(controller.signal, "abort").length,
      usage, childUsage, stats, budget: budget.getState(),
    }));
  } finally {
    clearTimeout(deadline);
    controller.abort(reason);
    await pending;
    for (const { response } of parked) response.destroy();
    server.closeAllConnections();
    const closed = Promise.withResolvers();
    server.close(closed.resolve);
    await closed.promise;
  }
}
`);
      try {
        const { stdout } = await promisify(execFile)(process.execPath, [entry, mode], { timeout: 35_000 });
        const observed = JSON.parse(stdout);
        const started = mode === "already-aborted" ? []
          : Array.from({ length: 4 }, (_, i) => `child-first-${i}`);
        if (mode === "settled-batch") {
          started.push(...Array.from({ length: 4 }, (_, i) => `child-queued-${i}`));
        }
        const paid = mode === "settled-batch" ? 8 : mode === "queued-batch" ? 1 : 0;
        const killed = mode === "queued-batch" ? 3 : 0;
        assert.equal(observed.settlement, mode === "settled-batch" ? "resolved" : "fixture generation retired");
        assert.deepEqual(observed.starts, started);
        assert.deepEqual(observed.dispatches, started);
        assert.equal(observed.completedChildren, started.length);
        assert.equal(observed.failedChildren, killed);
        assert.equal(observed.paidChildren, paid);
        assert.equal(observed.paidIdentities, true);
        assert.equal(observed.unknownKilledChildren, killed);
        assert.equal(observed.matchedCompletions, true);
        assert.equal(observed.remainingAbortListeners, 0);
        const { totalCost, ...tokens } = observed.usage;
        assert.deepEqual(tokens, {
          inputTokens: 11 * paid, outputTokens: 7 * paid, cacheReadTokens: 0, cacheWriteTokens: 0,
          llmCalls: paid, reasoningTokens: 2 * paid,
        });
        assert.ok(Math.abs(totalCost - 0.000025 * paid) < 1e-12);
        assert.deepEqual(observed.childUsage, observed.usage);
        assert.equal(observed.stats.total_tokens, 18 * paid);
        assert.equal(observed.stats.total_cost, totalCost);
        assert.deepEqual(observed.stats.usage_split.root, {
          input_tokens: 0, output_tokens: 0, total_tokens: 0, total_cost: 0, llm_calls: 0,
        });
        for (const split of ["child", "total"]) {
          assert.deepEqual(observed.stats.usage_split[split], {
            input_tokens: 11 * paid, output_tokens: 7 * paid, total_tokens: 18 * paid,
            total_cost: totalCost, llm_calls: paid,
          });
        }
        assert.deepEqual(observed.budget, {
          totalCost, totalInputTokens: 11 * paid, totalOutputTokens: 7 * paid,
          currentDepth: 0, budgetHit: paid ? "max-tokens" : null,
        });
        assert.equal(observed.stats.budget_hit, paid ? "max-tokens" : null);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});
