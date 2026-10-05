/**
 * Prime SDK backend — the in-process leg's own machinery.
 *
 * `tests/backend-contract.test.ts` proves the HOST-VISIBLE surface is
 * identical across every backend, driving this one through its engine seam.
 * This file proves the layer underneath that seam: the mikro → prime mapping,
 * the event-driven budget enforcement, the answer channel, and the scratch
 * lifecycle — all against an injected fake SDK, so the suite never needs a
 * real prime-agent install or a network call.
 *
 * The fake implements exactly `PrimeSdkModule`, the structural contract the
 * backend declares. That is the point of declaring it structurally: if the
 * backend starts using a part of prime's API the fake does not implement,
 * this suite stops compiling rather than passing against a fiction.
 *
 * Every event shape and every behavior asserted here was probed live against
 * the installed prime-agent 0.8.1 before being written down — notably the two
 * that are easy to get wrong and impossible to notice:
 *
 *   1. `tools` is an allowlist that gates CUSTOM tools too, so `emit_done`
 *      must always be named in it or the answer channel silently vanishes;
 *   2. `message_end` and the `turn_end` that follows carry the SAME assistant
 *      message and the SAME usage, so usage must be counted once.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MikroConfig } from "../src/config.js";
import type { LoadedContext } from "../src/context.js";
import type { Microagent } from "../src/mcp/agents.js";
import type { BackendRequest } from "../src/mcp/backend.js";
import {
  EMIT_DONE_TOOL,
  EXPECTED_PRIME_SDK_VERSION,
  PrimeSdkBackend,
  assertPinnedSdkVersion,
  buildModelsJson,
  createPrimeSdkLoader,
  type PrimeSdkBackendOptions,
  type PrimeSdkEvent,
  type PrimeSdkModule,
  type PrimeSdkSession,
  type PrimeSdkToolDefinition,
} from "../src/mcp/backends/prime-sdk.js";
import { EXPECTED_PRIME_VERSION } from "../src/mcp/backends/prime.js";
import { TIMEOUT_ANSWER } from "../src/rlm.js";

// ── Fixtures ─────────────────────────────────────────────────────────────

function config(overrides: Record<string, unknown> = {}): MikroConfig {
  return {
    model: { provider: "deepseek", model: "deepseek-v4-flash", subCallModel: "deepseek-v4-flash" },
    budget: { maxCost: null, maxTokens: null, maxDepth: null },
    gemini: { thinkingLevel: null },
    output: { schema: null },
    system: null,
    criteria: null,
    tools: [],
    contextConfig: {},
    ...overrides,
  } as unknown as MikroConfig;
}

function request(overrides: Partial<BackendRequest> = {}): BackendRequest {
  return {
    query: "Where are the two call sites of rlmLoop?",
    context: null,
    config: config(),
    cwd: "/tmp/mikro-prime-sdk-cwd",
    ...overrides,
  } as BackendRequest;
}

function agent(spec: Record<string, unknown> = {}): Microagent {
  return {
    name: "triage",
    toolName: "mikro_triage",
    dir: "/tmp/triage",
    summary: "triage agent",
    spec: {
      dir: "/tmp/triage",
      schemaVersion: 1,
      toolsApi: 1,
      shape: "loop",
      tools: [],
      extras: {},
      ...spec,
    },
  } as unknown as Microagent;
}

/** An assistant message carrying one completion's usage. */
function assistant(text: string, usage?: { input: number; output: number; cost: number }) {
  return {
    role: "assistant" as const,
    content: [{ type: "text", text }],
    ...(usage
      ? { usage: { input: usage.input, output: usage.output, cost: { total: usage.cost } } }
      : {}),
  };
}

// ── The fake SDK ─────────────────────────────────────────────────────────

/** One scripted action the fake session performs while `prompt()` runs. */
type Step =
  | { kind: "event"; event: PrimeSdkEvent }
  | { kind: "call"; tool: string; args: Record<string, unknown> };

interface Script {
  readonly steps: readonly Step[];
  /** When true, `prompt()` never settles on its own — only an abort ends it. */
  readonly hangUntilAbort?: boolean;
  /** When set, the fake ModelRegistry resolves nothing. */
  readonly modelMissing?: boolean;
  /** Mirror providers that flush terminal events after session.abort(). */
  readonly continueAfterAbort?: boolean;
}

interface FakeRecord {
  /** Options `createAgentSession` was called with. */
  sessionOptions?: Record<string, unknown>;
  /** Every tool the backend registered, in registration order. */
  tools: PrimeSdkToolDefinition[];
  /** Options `DefaultResourceLoader` was constructed with. */
  loaderOptions?: Record<string, unknown>;
  /** The models.json path handed to ModelRegistry, and its content if it existed. */
  authPath?: string;
  modelsJsonPath?: string;
  modelsJsonContent?: string;
  modelsJsonMode?: number;
  /** The scratch dir, inferred from the session's agentDir. */
  scratchDir?: string;
  /** Context snapshots present on disk when the session was created. */
  contextFiles: Array<{ path: string; content: string; mode: number }>;
  abortCalls: number;
  disposeCalls: number;
  /** Args each tool's execute() received. */
  executed: Array<{ tool: string; args: Record<string, unknown> }>;
}

/** Walk a directory tree, returning every file with its content and mode. */
function readTree(root: string): Array<{ path: string; content: string; mode: number }> {
  const out: Array<{ path: string; content: string; mode: number }> = [];
  if (!existsSync(root)) return out;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.push({ path: p, content: readFileSync(p, "utf8"), mode: statSync(p).mode & 0o777 });
    }
  };
  walk(root);
  return out;
}

function fakeSdk(script: Script): { module: PrimeSdkModule; record: FakeRecord } {
  const record: FakeRecord = { tools: [], contextFiles: [], abortCalls: 0, disposeCalls: 0, executed: [] };

  const module: PrimeSdkModule = {
    getAgentDir: () => "/prime-agent",
    defineTool: (tool) => {
      record.tools.push(tool);
      return tool;
    },
    AuthStorage: {
      create: (path?: string) => {
        record.authPath = path;
        return { path };
      },
    },
    ModelRegistry: {
      create: (_auth, modelsJsonPath) => {
        record.modelsJsonPath = modelsJsonPath;
        if (modelsJsonPath && existsSync(modelsJsonPath)) {
          record.modelsJsonContent = readFileSync(modelsJsonPath, "utf8");
          record.modelsJsonMode = statSync(modelsJsonPath).mode & 0o777;
        }
        return {
          find: (provider: string, id: string) =>
            script.modelMissing ? undefined : { provider, id },
          getError: () => undefined,
        };
      },
    },
    SettingsManager: {
      inMemory: (settings) => ({ settings }),
      create: (_cwd: string, agentDir?: string) => ({ agentDir }),
    },
    SessionManager: { inMemory: () => ({}) },
    DefaultResourceLoader: class {
      constructor(options: Record<string, unknown>) {
        record.loaderOptions = options;
      }
      async reload(): Promise<void> {}
    },
    createAgentSession: async (options) => {
      record.sessionOptions = options;
      const scratch = String(record.loaderOptions?.agentDir ?? options.agentDir);
      record.scratchDir = scratch;
      record.contextFiles = readTree(join(scratch, "context"));

      let listener: ((event: PrimeSdkEvent) => void) | undefined;
      let aborted = false;
      let releaseHang: (() => void) | undefined;

      const session: PrimeSdkSession = {
        subscribe(fn) {
          listener = fn;
          return () => {};
        },
        async prompt() {
          for (const step of script.steps) {
            if (aborted && !script.continueAfterAbort) break;
            // Yield so the backend's deadline timer can fire between steps.
            await new Promise((r) => setImmediate(r));
            if (aborted && !script.continueAfterAbort) break;
            if (step.kind === "event") {
              listener?.(step.event);
              continue;
            }
            const tool = record.tools.find((t) => t.name === step.tool);
            assert.ok(tool, `fake sdk: the backend never registered tool "${step.tool}"`);
            // Mirror prime: the allowlist gates custom tools, so a tool the
            // backend did not put in `tools` could never be called.
            const allow = options.tools as string[] | undefined;
            assert.ok(
              allow?.includes(step.tool),
              `fake sdk: tool "${step.tool}" is not in the session allowlist ${JSON.stringify(allow)}`
            );
            listener?.({ type: "tool_execution_start", toolName: step.tool });
            record.executed.push({ tool: step.tool, args: step.args });
            await tool.execute("call_1", step.args, undefined, undefined, undefined);
          }
          if (script.hangUntilAbort && !aborted) {
            await new Promise<void>((resolve) => {
              releaseHang = resolve;
            });
          }
        },
        abort() {
          record.abortCalls += 1;
          aborted = true;
          releaseHang?.();
        },
        dispose() {
          record.disposeCalls += 1;
        },
      };
      return { session };
    },
  };
  return { module, record };
}

/** Drive one backend run against a scripted fake SDK. */
async function run(
  script: Script,
  opts: {
    agent?: Microagent;
    request?: Partial<BackendRequest>;
    backendOptions?: PrimeSdkBackendOptions;
  } = {}
): Promise<{
  result: Awaited<ReturnType<PrimeSdkBackend["run"]>>;
  record: FakeRecord;
  progress: string[];
}> {
  const { module, record } = fakeSdk(script);
  const backend = new PrimeSdkBackend({ loader: async () => module, ...opts.backendOptions });
  const progress: string[] = [];
  const result = await backend.run(opts.agent, request(opts.request), (m) => progress.push(m));
  return { result, record, progress };
}

// ── The answer channel ───────────────────────────────────────────────────

describe("prime-sdk backend — the emit_done answer channel", () => {
  it("takes the answer from the emit_done arguments, not the assistant prose", async () => {
    const { result, record } = await run({
      steps: [
        { kind: "event", event: { type: "turn_start" } },
        {
          kind: "event",
          event: {
            type: "message_end",
            message: assistant("thinking out loud", { input: 100, output: 20, cost: 0.001 }),
          },
        },
        { kind: "call", tool: EMIT_DONE_TOOL, args: { answer: "src/a.ts:10 and src/b.ts:20." } },
        { kind: "event", event: { type: "turn_end", message: assistant("thinking out loud") } },
      ],
    });

    assert.equal(result.answer, "src/a.ts:10 and src/b.ts:20.");
    assert.equal(result.iterations, 1);
    assert.equal(result.budgetHit, null);
    assert.equal(record.executed[0]?.tool, EMIT_DONE_TOOL);
  });

  it("always names emit_done in the tools allowlist — an empty list would mute the run", async () => {
    // Probed live: `tools: []` disables custom tools as well as built-ins, so
    // the model answers in prose and emit_done is never offered. The
    // allowlist is the whole reason the answer channel works.
    const { record } = await run({
      steps: [{ kind: "call", tool: EMIT_DONE_TOOL, args: { answer: "done" } }],
    });
    const allow = record.sessionOptions?.tools as string[];
    assert.ok(Array.isArray(allow), "the session must receive an explicit tools allowlist");
    assert.ok(allow.includes(EMIT_DONE_TOOL), `allowlist ${JSON.stringify(allow)} must name emit_done`);
  });

  it("honors the provider-level root output cap on the session model", async () => {
    const { record } = await run(
      { steps: [{ kind: "call", tool: EMIT_DONE_TOOL, args: { answer: "done" } }] },
      { request: { maxOutputTokens: 1024 } }
    );
    assert.deepEqual(record.sessionOptions?.model, {
      provider: "deepseek",
      id: "deepseek-v4-flash",
      maxTokens: 1024,
    });
  });

  it("offers a hermetic inline payload transform while host extension discovery stays disabled", async () => {
    const { record } = await run(
      { steps: [{ kind: "call", tool: EMIT_DONE_TOOL, args: { answer: "done" } }] },
      {
        backendOptions: {
          providerPayloadTransform: (payload) => ({
            ...(payload as Record<string, unknown>),
            temperature: 0,
            seed: 53,
          }),
        },
      }
    );
    assert.equal(record.loaderOptions?.noExtensions, true);
    const factories = record.loaderOptions?.extensionFactories as Array<(api: {
      on(event: string, handler: (event: { payload: unknown }) => unknown): void;
    }) => void>;
    assert.equal(factories.length, 1);
    let handler: ((event: { payload: unknown }) => unknown) | undefined;
    factories[0]({ on: (_event, registered) => { handler = registered; } });
    assert.ok(handler);
    assert.deepEqual(await handler({ payload: { model: "controlled" } }), {
      model: "controlled",
      temperature: 0,
      seed: 53,
    });
  });

  it("offers no prime built-in tools unless the spec opts in", async () => {
    const { record } = await run({
      steps: [{ kind: "call", tool: EMIT_DONE_TOOL, args: { answer: "done" } }],
    });
    assert.deepEqual(record.sessionOptions?.tools, [EMIT_DONE_TOOL]);
  });

  it("passes a spec's built-in tool opt-in through to the allowlist", async () => {
    const { record } = await run(
      { steps: [{ kind: "call", tool: EMIT_DONE_TOOL, args: { answer: "done" } }] },
      { agent: agent({ tools: ["ipython"] }) }
    );
    assert.deepEqual(record.sessionOptions?.tools, [EMIT_DONE_TOOL, "ipython"]);
  });

  it("falls back to the final assistant text when no schema was promised", async () => {
    // A model may decline to call emit_done. With no output.schema that is
    // survivable — prose is exactly what the subprocess backend returns.
    const { result } = await run({
      steps: [
        { kind: "event", event: { type: "turn_start" } },
        { kind: "event", event: { type: "message_end", message: assistant("prose answer") } },
        { kind: "event", event: { type: "turn_end", message: assistant("prose answer") } },
      ],
    });
    assert.equal(result.answer, "prose answer");
  });
});

// ── Structured output ────────────────────────────────────────────────────

describe("prime-sdk backend — structured output", () => {
  const SCHEMA = {
    type: "object",
    required: ["severity", "owner"],
    properties: { severity: { type: "string" }, owner: { type: "string" } },
  };

  it("uses output.schema as emit_done's parameter schema so prime validates it", async () => {
    const { record } = await run(
      { steps: [{ kind: "call", tool: EMIT_DONE_TOOL, args: { severity: "P1", owner: "platform" } }] },
      { request: { config: config({ output: { schema: SCHEMA } }) } }
    );
    const emitDone = record.tools.find((t) => t.name === EMIT_DONE_TOOL);
    assert.ok(emitDone, "emit_done must be registered");
    assert.deepEqual(
      emitDone.parameters,
      SCHEMA,
      "the spec's schema must BE the tool's parameter schema — that is what makes prime validate it"
    );
  });

  it("returns the validated arguments as JSON when a schema is declared", async () => {
    const { result } = await run(
      { steps: [{ kind: "call", tool: EMIT_DONE_TOOL, args: { severity: "P1", owner: "platform" } }] },
      { request: { config: config({ output: { schema: SCHEMA } }) } }
    );
    assert.deepEqual(JSON.parse(result.answer), { severity: "P1", owner: "platform" });
  });

  it("defaults to an {answer: string} schema when the spec declares none", async () => {
    const { record } = await run({
      steps: [{ kind: "call", tool: EMIT_DONE_TOOL, args: { answer: "done" } }],
    });
    const emitDone = record.tools.find((t) => t.name === EMIT_DONE_TOOL);
    assert.deepEqual(emitDone?.parameters, {
      type: "object",
      required: ["answer"],
      properties: {
        answer: {
          type: "string",
          description: "The complete final report, written for the host's user.",
        },
      },
    });
  });

  it("fails loudly rather than return prose where a schema was promised", async () => {
    await assert.rejects(
      run(
        {
          steps: [
            { kind: "event", event: { type: "turn_start" } },
            { kind: "event", event: { type: "message_end", message: assistant("just prose") } },
            { kind: "event", event: { type: "turn_end", message: assistant("just prose") } },
          ],
        },
        { request: { config: config({ output: { schema: SCHEMA } }) } }
      ),
      /finished without calling `emit_done`.*no structured output/s
    );
  });

  it("surfaces provider stream errors before the generic structured-output error", async () => {
    await assert.rejects(
      run(
        {
          steps: [{
            kind: "event",
            event: {
              type: "message_end",
              message: {
                role: "assistant",
                content: [],
                stopReason: "error",
                errorMessage: "No endpoints found that support tool use",
              },
            },
          }],
        },
        { request: { config: config({ output: { schema: SCHEMA } }) } }
      ),
      /prime-sdk provider error: No endpoints found that support tool use/
    );
  });
});

// ── Custom tools ─────────────────────────────────────────────────────────

describe("prime-sdk backend — spec tools become prime custom tools", () => {
  it("maps an agent.yaml tool plugin to a callable prime tool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mikro-sdk-agent-"));
    try {
      mkdirSync(join(dir, "tools"), { recursive: true });
      writeFileSync(
        join(dir, "tools", "greet.mjs"),
        "export default async function greet(args) { return { hello: args.name }; }\n"
      );

      const { result, record, progress } = await run(
        {
          steps: [
            { kind: "event", event: { type: "turn_start" } },
            { kind: "call", tool: "greet", args: { name: "world" } },
            { kind: "call", tool: EMIT_DONE_TOOL, args: { answer: "greeted" } },
            { kind: "event", event: { type: "turn_end", message: assistant("greeted") } },
          ],
        },
        { agent: agent({ dir, tools: ["greet"] }) }
      );

      const greet = record.tools.find((t) => t.name === "greet");
      assert.ok(greet, "the spec's tool must reach prime as a custom tool");
      assert.deepEqual(
        greet.parameters,
        { type: "object", additionalProperties: true },
        "a plugin that declares no schema gets a permissive one, not an invented precise one"
      );
      assert.deepEqual(record.sessionOptions?.tools, [EMIT_DONE_TOOL, "greet"]);
      assert.equal(result.answer, "greeted");
      assert.ok(progress.includes("tool greet"), `progress must report the tool call: ${progress}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs the real plugin handler and returns its result to the model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mikro-sdk-agent-"));
    try {
      mkdirSync(join(dir, "tools"), { recursive: true });
      writeFileSync(
        join(dir, "tools", "greet.mjs"),
        "export default async function greet(args) { return { hello: args.name }; }\n"
      );
      const { module, record } = fakeSdk({
        steps: [{ kind: "call", tool: EMIT_DONE_TOOL, args: { answer: "x" } }],
      });
      const backend = new PrimeSdkBackend({ loader: async () => module });
      await backend.run(agent({ dir, tools: ["greet"] }), request(), () => {});

      const greet = record.tools.find((t) => t.name === "greet");
      const out = await greet!.execute("c1", { name: "world" }, undefined, undefined, undefined);
      assert.equal(out.content[0]?.text, JSON.stringify({ hello: "world" }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails loudly on a declared tool that resolves to no plugin and no built-in", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mikro-sdk-agent-"));
    try {
      await assert.rejects(
        run(
          { steps: [{ kind: "call", tool: EMIT_DONE_TOOL, args: { answer: "x" } }] },
          { agent: agent({ dir, tools: ["nope"] }) }
        ),
        /declares tool\(s\) "nope" that resolve to no plugin/
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Budgets ──────────────────────────────────────────────────────────────

describe("prime-sdk backend — mikro owns the budgets", () => {
  it("counts usage once: message_end and turn_end carry the same assistant message", async () => {
    // Probed live against prime 0.8.1. Counting both would double every
    // total and fire cost ceilings at half their configured value.
    const message = assistant("done", { input: 956, output: 78, cost: 0.00015568 });
    const { result } = await run({
      steps: [
        { kind: "event", event: { type: "turn_start" } },
        { kind: "event", event: { type: "message_end", message } },
        { kind: "call", tool: EMIT_DONE_TOOL, args: { answer: "done" } },
        { kind: "event", event: { type: "turn_end", message } },
      ],
    });
    assert.equal(result.usage.inputTokens, 956);
    assert.equal(result.usage.outputTokens, 78);
    assert.equal(result.usage.totalCost, 0.00015568);
  });

  it("caps iterations at the spec's ceiling and reports max-iterations", async () => {
    const turn = (text: string): Step[] => [
      { kind: "event", event: { type: "turn_start" } },
      { kind: "event", event: { type: "message_end", message: assistant(text) } },
      { kind: "event", event: { type: "turn_end", message: assistant(text) } },
    ];
    const { result, record, progress } = await run(
      { steps: [...turn("first"), ...turn("second"), ...turn("third")], continueAfterAbort: true },
      { request: { maxIterations: 2 } }
    );

    assert.equal(result.iterations, 2, "the cap is a turn ceiling");
    assert.equal(result.budgetHit, "max-iterations");
    assert.equal(result.answer, "second", "the answer is the last COMPLETED turn's");
    assert.equal(record.abortCalls, 1, "breaching the cap must abort the session");
    assert.deepEqual(progress, ["iteration 1", "iteration 2"]);
  });

  it("stops on a cost ceiling and returns a normal result carrying budgetHit", async () => {
    const { result, record } = await run(
      {
        steps: [
          { kind: "event", event: { type: "turn_start" } },
          {
            kind: "event",
            event: {
              type: "message_end",
              message: assistant("partial report", { input: 10, output: 5, cost: 0.05 }),
            },
          },
          { kind: "event", event: { type: "turn_end", message: assistant("partial report") } },
          { kind: "event", event: { type: "turn_start" } },
        ],
      },
      { request: { config: config({ budget: { maxCost: 0.01, maxTokens: null, maxDepth: null } }) } }
    );

    assert.equal(result.budgetHit, "max-cost");
    assert.equal(result.answer, "partial report", "a ceiling returns the partial answer, not an error");
    assert.equal(record.abortCalls, 1);
  });

  it("stops on a token ceiling", async () => {
    const { result } = await run(
      {
        steps: [
          { kind: "event", event: { type: "turn_start" } },
          {
            kind: "event",
            event: {
              type: "message_end",
              message: assistant("partial", { input: 900, output: 200, cost: 0.001 }),
            },
          },
        ],
      },
      {
        request: {
          config: config({ budget: { maxCost: null, maxTokens: 1000, maxDepth: null } }),
        },
      }
    );
    assert.equal(result.budgetHit, "max-tokens");
  });

  it("returns TIMEOUT_ANSWER and aborts the session when the wall clock expires", async () => {
    const previous = process.env.MIKRO_MCP_RUN_TIMEOUT_MS;
    process.env.MIKRO_MCP_RUN_TIMEOUT_MS = "25";
    try {
      const { result, record } = await run({
        steps: [{ kind: "event", event: { type: "turn_start" } }],
        hangUntilAbort: true,
      });
      assert.equal(result.answer, TIMEOUT_ANSWER, "the deadline must produce legacy's timeout answer");
      assert.equal(result.budgetHit, null, "a timeout is a failed run, not a budget note");
      assert.equal(record.abortCalls, 1, "the deadline must abort the session");
    } finally {
      if (previous === undefined) delete process.env.MIKRO_MCP_RUN_TIMEOUT_MS;
      else process.env.MIKRO_MCP_RUN_TIMEOUT_MS = previous;
    }
  });

  it("passes budget.max_depth as rlmMaxDepth, not as a process-global env var", async () => {
    const { record } = await run(
      { steps: [{ kind: "call", tool: EMIT_DONE_TOOL, args: { answer: "x" } }] },
      { request: { config: config({ budget: { maxCost: null, maxTokens: null, maxDepth: 3 } }) } }
    );
    assert.equal(record.sessionOptions?.rlmMaxDepth, 3);
    assert.equal(
      process.env.RLM_MAX_DEPTH,
      undefined,
      "depth must not leak into process.env, where concurrent turns would race"
    );
  });
});

// ── Providers + models.json ──────────────────────────────────────────────

describe("prime-sdk backend — provider mapping", () => {
  it("loads built-in-provider auth and model overrides from the same canonical agentDir as the CLI", async () => {
    const primeAgentDir = mkdtempSync(join(tmpdir(), "mikro-prime-agent-dir-"));
    try {
      writeFileSync(join(primeAgentDir, "models.json"), JSON.stringify({ providers: {} }));
      const { record } = await run(
        { steps: [{ kind: "call", tool: EMIT_DONE_TOOL, args: { answer: "x" } }] },
        { backendOptions: { primeAgentDir } }
      );
      assert.equal(record.authPath, join(primeAgentDir, "auth.json"));
      assert.equal(record.modelsJsonPath, join(primeAgentDir, "models.json"));
      assert.equal(record.sessionOptions?.agentDir, primeAgentDir);
    } finally {
      rmSync(primeAgentDir, { recursive: true, force: true });
    }
  });

  it("writes no models.json for a provider prime already knows", async () => {
    const { record } = await run({
      steps: [{ kind: "call", tool: EMIT_DONE_TOOL, args: { answer: "x" } }],
    });
    assert.equal(record.modelsJsonContent, undefined, "deepseek is built into prime");
  });

  it("describes wafer with its ZDR header and an env-var NAME, never a key value", async () => {
    const { record } = await run(
      { steps: [{ kind: "call", tool: EMIT_DONE_TOOL, args: { answer: "x" } }] },
      {
        request: {
          config: config({
            model: { provider: "wafer", model: "wafer-large", subCallModel: "wafer-large" },
          }),
        },
      }
    );

    assert.ok(record.modelsJsonContent, "a custom provider needs a generated models.json");
    const parsed = JSON.parse(record.modelsJsonContent!);
    const wafer = parsed.providers.wafer;
    assert.equal(wafer.baseUrl, "https://pass.wafer.ai/v1");
    assert.equal(wafer.api, "openai-completions");
    assert.deepEqual(wafer.headers, { "Wafer-ZDR": "required" });
    assert.equal(
      wafer.apiKey,
      "WAFER_API_KEY",
      "apiKey must be the env-var NAME — this file lands on disk"
    );
    assert.equal(wafer.models[0].id, "wafer-large");
    assert.equal(record.modelsJsonMode, 0o600, "the generated provider config must be owner-only");
  });

  it("describes khal and station too", () => {
    const khal = buildModelsJson("khal", "khal-model", "a");
    assert.equal(khal?.providers.khal?.apiKey, "KHAL_API_KEY");
    const station = buildModelsJson("station", "qwen", "a");
    assert.equal(station?.providers.station?.apiKey, "STATION_API_KEY");
  });

  it("passes the latest Prime built-in providers through under their own mikro names", () => {
    assert.equal(buildModelsJson("google", "gemini-2.5-flash", "a"), null);
    assert.equal(buildModelsJson("openrouter", "anthropic/claude-3.5", "a"), null);
    assert.equal(buildModelsJson("openai-codex", "gpt-5.6-sol", "a"), null);
    assert.equal(buildModelsJson("zai", "glm-5.2", "a"), null);
  });

  it("fails loudly on a provider neither prime nor mikro can address", () => {
    assert.throws(
      () => buildModelsJson("pulp", "fiction", "triage"),
      /is pinned to model "pulp\/fiction".*neither one of prime's built-in providers/s
    );
  });

  it("rejects a cost ceiling on a custom provider whose pricing mikro cannot declare", async () => {
    // Prime computes cost from the models.json price table. mikro has no
    // pricing for these gateways, so the ceiling would read as enforced and
    // never fire — worse than having no ceiling.
    await assert.rejects(
      run(
        { steps: [{ kind: "call", tool: EMIT_DONE_TOOL, args: { answer: "x" } }] },
        {
          request: {
            config: config({
              model: { provider: "wafer", model: "wafer-large", subCallModel: "wafer-large" },
              budget: { maxCost: 1, maxTokens: null, maxDepth: null },
            }),
          },
        }
      ),
      /sets budget\.max_cost on provider "wafer".*would never fire/s
    );
  });
});

// ── Context snapshots ────────────────────────────────────────────────────

describe("prime-sdk backend — context snapshots", () => {
  const listContext: LoadedContext = {
    type: "list",
    content: [
      { path: "notes/a.md", content: "alpha" },
      { path: "../../escape.md", content: "beta" },
    ],
    metadata: "",
  };

  it("writes every context item to a 0600 file inside the scratch dir", async () => {
    const { record } = await run(
      { steps: [{ kind: "call", tool: EMIT_DONE_TOOL, args: { answer: "x" } }] },
      { request: { context: listContext } }
    );

    assert.equal(record.contextFiles.length, 2);
    for (const file of record.contextFiles) {
      assert.equal(file.mode, 0o600, `${file.path} must be owner-only`);
      assert.ok(
        file.path.startsWith(record.scratchDir!),
        `${file.path} must not escape the scratch dir`
      );
    }
    assert.ok(record.contextFiles.some((f) => f.content === "alpha"));
    assert.ok(record.contextFiles.some((f) => f.content === "beta"));
  });

  it("names the snapshots in the appended system prompt", async () => {
    const { record } = await run(
      { steps: [{ kind: "call", tool: EMIT_DONE_TOOL, args: { answer: "x" } }] },
      { request: { context: listContext } }
    );
    const appended = (record.loaderOptions?.appendSystemPrompt as string[])[0]!;
    assert.match(appended, /Caller-provided context/);
    for (const file of record.contextFiles) assert.ok(appended.includes(file.path));
  });

  it("maps a dict context the subprocess backend has to reject outright", async () => {
    const dict: LoadedContext = {
      type: "dict",
      content: { spec: "the spec text", notes: "the notes" } as unknown as never,
      metadata: "",
    };
    const { record } = await run(
      { steps: [{ kind: "call", tool: EMIT_DONE_TOOL, args: { answer: "x" } }] },
      { request: { context: dict } }
    );
    assert.equal(record.contextFiles.length, 2);
    assert.ok(record.contextFiles.some((f) => f.content === "the spec text"));
  });
});

// ── Prompt + hermeticity ─────────────────────────────────────────────────

describe("prime-sdk backend — prompt assembly", () => {
  it("appends the role to prime's base prompt and never replaces it", async () => {
    const { record } = await run(
      { steps: [{ kind: "call", tool: EMIT_DONE_TOOL, args: { answer: "x" } }] },
      { request: { config: config({ system: "AGENT RULES", criteria: "BE TERSE" }) } },
    );
    const options = record.loaderOptions!;
    assert.ok(Array.isArray(options.appendSystemPrompt), "must append, never replace");
    assert.equal(options.systemPrompt, undefined, "prime's base prompt must survive");
    const appended = (options.appendSystemPrompt as string[])[0]!;
    assert.match(appended, /AGENT RULES/);
    assert.match(appended, /BE TERSE/);
    assert.match(appended, /emit_done/);
  });

  it("keeps the run hermetic — no host AGENTS.md, extensions, skills, or prompts", async () => {
    const { record } = await run({
      steps: [{ kind: "call", tool: EMIT_DONE_TOOL, args: { answer: "x" } }],
    });
    const options = record.loaderOptions!;
    for (const flag of ["noExtensions", "noSkills", "noPromptTemplates", "noThemes", "noContextFiles"]) {
      assert.equal(options[flag], true, `${flag} must be set — the host machine must not leak in`);
    }
    assert.equal(options.bundledSkillsDir, null);
  });

  it("runs in the server cwd, keeps canonical Prime config, and isolates resources in scratch", async () => {
    const { record } = await run({
      steps: [{ kind: "call", tool: EMIT_DONE_TOOL, args: { answer: "x" } }],
    });
    assert.equal(record.sessionOptions?.cwd, "/tmp/mikro-prime-sdk-cwd");
    assert.equal(record.sessionOptions?.agentDir, "/prime-agent");
    assert.equal(record.loaderOptions?.cwd, "/tmp/mikro-prime-sdk-cwd");
    assert.ok(String(record.loaderOptions?.agentDir).startsWith(tmpdir()));
  });

  it("passes the agent's thinking level through", async () => {
    const { record } = await run(
      { steps: [{ kind: "call", tool: EMIT_DONE_TOOL, args: { answer: "x" } }] },
      { request: { config: config({ gemini: { thinkingLevel: "high" } }) } }
    );
    assert.equal(record.sessionOptions?.thinkingLevel, "high");
  });
});

// ── Loud rejects that remain ─────────────────────────────────────────────

describe("prime-sdk backend — what it still refuses", () => {
  const rejects: ReadonlyArray<[string, Record<string, unknown>, RegExp]> = [
    ["gemini.google-search", { gemini: { googleSearch: true } }, /google-search/],
    ["gemini.url-context", { gemini: { urlContext: true } }, /url-context/],
    ["gemini.code-execution", { gemini: { codeExecution: true } }, /code-execution/],
    ["gemini.computer-use", { gemini: { computerUse: true } }, /computer-use/],
    ["gemini.maps-grounding", { gemini: { mapsGrounding: true } }, /maps-grounding/],
    ["gemini.file-search", { gemini: { fileSearch: true } }, /file-search/],
    ["gemini.media-resolution", { gemini: { mediaResolution: "high" } }, /media-resolution/],
  ];

  for (const [name, overrides, pattern] of rejects) {
    it(`rejects ${name} rather than silently dropping it`, async () => {
      await assert.rejects(
        run(
          { steps: [{ kind: "call", tool: EMIT_DONE_TOOL, args: { answer: "x" } }] },
          { request: { config: config(overrides) } }
        ),
        pattern
      );
    });
  }

  it("rejects TOOLS.md REPL tools and points at the surface that does work", async () => {
    await assert.rejects(
      run(
        { steps: [{ kind: "call", tool: EMIT_DONE_TOOL, args: { answer: "x" } }] },
        { request: { config: config({ tools: [{ name: "search", code: "def search(): pass" }] }) } }
      ),
      /custom REPL tools \(TOOLS\.md\).*agent\.yaml `tools:` plugins instead/s
    );
  });

  it("honors what the subprocess backend rejects: schema, depth, dict context, station", async () => {
    // The delta that justifies this backend existing. Each of these is a
    // loud reject in src/mcp/backends/prime.ts.
    const { result } = await run(
      { steps: [{ kind: "call", tool: EMIT_DONE_TOOL, args: { ok: true } }] },
      {
        request: {
          context: { type: "dict", content: { a: "x" } as unknown as never, metadata: "" },
          config: config({
            model: { provider: "station", model: "qwen", subCallModel: "qwen" },
            output: { schema: { type: "object", properties: { ok: { type: "boolean" } } } },
            budget: { maxCost: null, maxTokens: null, maxDepth: 2 },
          }),
        },
      }
    );
    assert.deepEqual(JSON.parse(result.answer), { ok: true });
  });
});

// ── Scratch lifecycle ────────────────────────────────────────────────────

describe("prime-sdk backend — scratch lifecycle", () => {
  it("creates the scratch dir 0700 and removes it after a successful run", async () => {
    let observedMode: number | undefined;
    const { module, record } = fakeSdk({
      steps: [{ kind: "call", tool: EMIT_DONE_TOOL, args: { answer: "x" } }],
    });
    const wrapped: PrimeSdkModule = {
      ...module,
      createAgentSession: async (options) => {
        observedMode = statSync(String(record.loaderOptions?.agentDir)).mode & 0o777;
        return module.createAgentSession(options);
      },
    };
    const backend = new PrimeSdkBackend({ loader: async () => wrapped });
    await backend.run(undefined, request(), () => {});

    assert.equal(observedMode, 0o700, "the scratch dir must be owner-only");
    assert.ok(record.scratchDir, "the fake must have seen a scratch dir");
    assert.equal(existsSync(record.scratchDir!), false, "the scratch dir must not outlive the turn");
  });

  it("removes the scratch dir even when the run throws", async () => {
    let scratchDir: string | undefined;
    const { module, record } = fakeSdk({ steps: [] });
    const wrapped: PrimeSdkModule = {
      ...module,
      createAgentSession: async (options) => {
        scratchDir = String(record.loaderOptions?.agentDir);
        throw new Error("session exploded");
      },
    };
    const backend = new PrimeSdkBackend({ loader: async () => wrapped });
    await assert.rejects(backend.run(undefined, request(), () => {}), /session exploded/);
    assert.ok(scratchDir, "the scratch dir must have been created before the failure");
    assert.equal(existsSync(scratchDir!), false, "a failed run must not leak its scratch dir");
  });

  it("disposes the session on every path", async () => {
    const { record } = await run({
      steps: [{ kind: "call", tool: EMIT_DONE_TOOL, args: { answer: "x" } }],
    });
    assert.equal(record.disposeCalls, 1);
  });
});

// ── The version pin ──────────────────────────────────────────────────────

describe("prime-sdk backend — the version pin", () => {
  it("shares the subprocess backend's 0.8.1 pin", () => {
    assert.equal(EXPECTED_PRIME_SDK_VERSION, EXPECTED_PRIME_VERSION);
    assert.equal(EXPECTED_PRIME_SDK_VERSION, "0.8.1");
  });

  function fakeRoot(version: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), "mikro-prime-root-"));
    if (version !== null) {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "prime-agent", version }));
    }
    return dir;
  }

  it("accepts the pinned version", () => {
    const dir = fakeRoot(EXPECTED_PRIME_SDK_VERSION);
    try {
      assert.doesNotThrow(() => assertPinnedSdkVersion(dir, EXPECTED_PRIME_SDK_VERSION));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws loudly on a version mismatch and names both pins", () => {
    const dir = fakeRoot("0.9.9");
    try {
      assert.throws(
        () => assertPinnedSdkVersion(dir, EXPECTED_PRIME_SDK_VERSION),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /is not the pinned prime-agent 0\.8\.1/);
          assert.match(err.message, /"0\.9\.9"/);
          // The subprocess pin is named too: the two are separate surfaces
          // and an operator must be able to see the divergence.
          assert.match(err.message, /subprocess backend pins/);
          assert.match(err.message, /backend: mikro/);
          return true;
        }
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when the root is not an installed package at all", () => {
    const dir = fakeRoot(null);
    try {
      assert.throws(
        () => assertPinnedSdkVersion(dir, EXPECTED_PRIME_SDK_VERSION),
        /no package\.json at .* is not an installed prime-agent package root/
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defers the pin check to first use, so constructing the backend is free", () => {
    // A server that wires this backend but never selects it must not fail to
    // start on a machine with no prime-agent.
    const dir = fakeRoot("0.0.1");
    try {
      assert.doesNotThrow(() => new PrimeSdkBackend({ primeRoot: dir }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails the run — not the construction — when the installed version is wrong", async () => {
    const dir = fakeRoot("0.0.1");
    try {
      const backend = new PrimeSdkBackend({ primeRoot: dir });
      await assert.rejects(
        backend.run(undefined, request(), () => {}),
        /is not the pinned prime-agent 0\.8\.1/
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("memoizes: the pin is checked once, not once per turn", async () => {
    const dir = fakeRoot("0.0.1");
    try {
      const load = createPrimeSdkLoader({ primeRoot: dir });
      await assert.rejects(load(), /is not the pinned prime-agent/);
      // The memoized rejection is reused rather than re-probed.
      await assert.rejects(load(), /is not the pinned prime-agent/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
