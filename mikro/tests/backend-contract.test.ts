/**
 * Backend contract — the `RuntimeBackend` seam must be host-invisible.
 *
 * One harness drives every backend through the *real* server-side turn
 * pipeline (`runTurn` → cost footer → `sessionResult`) with the same request
 * and a stubbed engine, then asserts each backend's host-visible results are
 * equal:
 *
 *   1. the `structuredContent` `{answer, session_id}` envelope and its
 *      mirrored text block (same string, byte for byte, on both channels);
 *   2. the cost-footer field set — label, model, iterations, tokens in/out,
 *      cost, budget-hit presence, session id — parsed out of the text block;
 *   3. the `isError` classification, which must equal `isFailedRun`'s verdict
 *      on the backend's result;
 *   4. the progress-notification sequence.
 *
 * Deliberately NOT compared: tool schemas. `genericToolSchema` /
 * `agentToolSchema` / `toolOutputSchema` take no backend argument, so a
 * schema comparison passes by construction and can never fail — comparing
 * them would be theater.
 *
 * Two deliberate exclusions from byte equality:
 *
 *   - the elapsed-seconds footer field: wall-clock timing is a property of
 *     the machine, not of the backend, and two runs never take the same
 *     milliseconds. The field's *presence* and numeric shape are asserted on
 *     every record; its *value* is never compared across backends.
 *   - the heartbeat: the idle `working Ns` ticks are server-side (shared by
 *     every backend by construction, `src/mcp/server.ts`) and fire at 15s —
 *     the stub runs here finish in microseconds, so the compared sequences
 *     are the backend-driven messages, which is what can diverge.
 *
 * The legacy backend is registered twice, so the pairwise comparison has
 * real teeth from day one. Group 2 registers the prime backend too — fed its
 * own stub *engine* — and every assertion below becomes a live cross-backend
 * gate. The prime stub is an engine seam, not the stub binary: two scenarios
 * (empty-response abort, budget-truncated run) carry `budgetHit` reasons the
 * prime backend can only *produce*, not derive from a scripted JSONL stream,
 * so the binary-level spawn machinery stays in `tests/prime-backend.test.ts`
 * and this harness proves the host-visible surface alone.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { MikroConfig } from "../src/config.js";
import type { LoadedContext } from "../src/context.js";
import type { UsageStats } from "../src/llm.js";
import type { Microagent } from "../src/mcp/agents.js";
import type { RuntimeBackend } from "../src/mcp/backend.js";
import { LegacyMikroBackend } from "../src/mcp/backends/legacy.js";
import {
  PrimeBackend,
  type PrimeEngine,
  type PrimeRunLimits,
} from "../src/mcp/backends/prime.js";
import {
  EMIT_DONE_TOOL,
  PrimeSdkBackend,
  type PrimeSdkEngine,
  type PrimeSdkPlan,
  type PrimeSdkRunLimits,
} from "../src/mcp/backends/prime-sdk.js";
import type { RLMResult } from "../src/output.js";
import { EMPTY_RESPONSES_BUDGET_HIT, TIMEOUT_ANSWER, type RLMOptions } from "../src/rlm.js";
import { parseAgentSpec } from "../src/sdk/agent-spec.js";
import type { AgentEvent } from "../src/sdk/events.js";
import {
  isFailedRun,
  runTurn,
  selectBackend,
  sessionResult,
  type TurnOutcome,
} from "../src/mcp/server.js";

const SESSION_ID = "sess_contract0000000";

/** Config whose fields the turn pipeline actually reads (model for the footer). */
const CONFIG = {
  // The gate model (wish decision 7, as amended): deepseek/deepseek-v4-flash.
  // The prime backend maps mikro's deepseek addressing to prime's native
  // deepseek provider verbatim; any other provider would be a loud failure,
  // which is not what this harness exists to compare.
  model: { provider: "deepseek", model: "deepseek-v4-flash", subCallModel: "deepseek-v4-flash" },
  budget: { maxCost: null, maxTokens: null, maxDepth: null },
  gemini: { thinkingLevel: null },
  contextConfig: {},
} as unknown as MikroConfig;

/** Footer cost formatting — pinned here so a format drift fails the contract. */
function formatCost(cost: number): string {
  if (cost <= 0) return "$0.00";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

const USAGE = {
  inputTokens: 1_234,
  outputTokens: 567,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalCost: 0.0123,
  llmCalls: 3,
} as unknown as UsageStats;

// ── Stub engine ──────────────────────────────────────────────────────────
//
// The legacy backend's engine is `rlmLoop`; the seam runs it with a
// caller-supplied emitter and reads back `answer` / `iterations` / `budgetHit`
// / usage. The stub reproduces that contract without an LLM: emit a fixed
// event script, close the emitter, return a fixed result. Every call is
// recorded so the test can pin what the backend forwarded.

type StubLoop = (
  query: string,
  context: LoadedContext | null,
  config: MikroConfig,
  options?: Partial<RLMOptions>
) => Promise<RLMResult>;

interface StubCall {
  readonly query: string;
  readonly context: LoadedContext | null;
  readonly options: Partial<RLMOptions>;
}

interface StubRun {
  readonly answer: string;
  readonly iterations: number;
  readonly budgetHit: string | null;
  readonly usage: UsageStats;
  readonly events: readonly AgentEvent[];
}

const ev = (type: "IterationStart" | "Recurse"): AgentEvent =>
  ({ type } as unknown as AgentEvent);

function stubLoop(run: StubRun): { loop: StubLoop; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const loop: StubLoop = async (query, context, _config, options = {}) => {
    calls.push({ query, context, options });
    for (const event of run.events) options.emitter?.emit(event);
    options.emitter?.close();
    return {
      answer: run.answer,
      references: [],
      usage: run.usage,
      iterations: run.iterations,
      model: "stub/stub-model",
      budgetHit: run.budgetHit,
    };
  };
  return { loop, calls };
}

// ── Prime stub engine ────────────────────────────────────────────────────
//
// The prime backend's engine seam (its `rlmLoop` analog): one spawn argv plus
// the limits the backend derived from the spec/config, one raw result out.
// The stub returns the scenario's values directly and replays the scenario's
// progress as bare messages (runTurn owns the label prefix). The real spawn,
// event parsing, and budget enforcement live in `tests/prime-backend.test.ts`.

interface PrimeCall {
  readonly argv: readonly string[];
  readonly limits: PrimeRunLimits;
}

function stubPrimeEngine(
  run: StubRun,
  bareProgressMessages: readonly string[]
): { engine: PrimeEngine; calls: PrimeCall[] } {
  const calls: PrimeCall[] = [];
  const engine: PrimeEngine = async (argv, emit, limits) => {
    calls.push({ argv, limits });
    for (const message of bareProgressMessages) emit(message);
    return {
      answer: run.answer,
      turns: run.iterations,
      budgetHit: run.budgetHit,
      usage: {
        inputTokens: run.usage.inputTokens,
        outputTokens: run.usage.outputTokens,
        totalCost: run.usage.totalCost,
      },
    };
  };
  return { engine, calls };
}

// ── Prime SDK stub engine ────────────────────────────────────────────────
//
// The in-process backend's engine seam: one run plan (its argv analog) plus
// the limits the backend derived, one raw result out. Same shape as the
// prime stub above, so the same scenario drives both prime legs. The real
// session drive, event translation, and budget enforcement live in
// `tests/prime-sdk-backend.test.ts` against an injected fake SDK.

interface PrimeSdkCall {
  readonly plan: PrimeSdkPlan;
  readonly limits: PrimeSdkRunLimits;
}

function stubPrimeSdkEngine(
  run: StubRun,
  bareProgressMessages: readonly string[]
): { engine: PrimeSdkEngine; calls: PrimeSdkCall[] } {
  const calls: PrimeSdkCall[] = [];
  const engine: PrimeSdkEngine = async (plan, emit, limits) => {
    calls.push({ plan, limits });
    for (const message of bareProgressMessages) emit(message);
    return {
      answer: run.answer,
      turns: run.iterations,
      budgetHit: run.budgetHit,
      usage: {
        inputTokens: run.usage.inputTokens,
        outputTokens: run.usage.outputTokens,
        totalCost: run.usage.totalCost,
      },
    };
  };
  return { engine, calls };
}

/** Backends emit bare messages; runTurn adds "label · ". Strip the prefix back off. */
function bareProgress(scenario: Scenario): readonly string[] {
  return scenario.expectedProgress.map((m) => m.slice(m.indexOf(" · ") + 3));
}

// ── Harness ──────────────────────────────────────────────────────────────

/** One host-visible turn: the real server pipeline, one backend under test. */
interface Observed {
  readonly outcome: TurnOutcome;
  readonly result: CallToolResult;
  readonly progress: string[];
}

interface Scenario {
  readonly name: string;
  /** The resolved microagent, or undefined for the generic `mikro_query` shape. */
  readonly agent: Microagent | undefined;
  readonly label: string;
  readonly query: string;
  readonly maxIterations?: number;
  /**
   * Absolute path to a real file or directory on disk, passed to `runTurn`
   * as the caller's `context:` argument. Absent = no context is loaded, and
   * the engines must see `null` context / no `@file` argv entries.
   */
  readonly contextPath?: string;
  readonly stub: StubRun;
  readonly expectedProgress: readonly string[];
  readonly isError: boolean;
}

/**
 * The backends under contract, each fed the SAME scripted scenario.
 *
 * The legacy backend is registered twice (two instances, one stub loop: any
 * per-instance state or nondeterminism fails) and the prime backend once,
 * fed the same `StubRun` through its engine seam. Every assertion in this
 * harness — envelope, footer fields, isError, progress — is therefore a live
 * cross-backend gate.
 */
function backendsFor(
  loop: StubLoop,
  primeEngine: PrimeEngine,
  primeSdkEngine: PrimeSdkEngine
): ReadonlyArray<{ name: string; backend: RuntimeBackend }> {
  return [
    { name: "legacy#1", backend: new LegacyMikroBackend({ loop }) },
    { name: "legacy#2", backend: new LegacyMikroBackend({ loop }) },
    { name: "prime", backend: new PrimeBackend({ engine: primeEngine }) },
    { name: "prime-sdk", backend: new PrimeSdkBackend({ engine: primeSdkEngine }) },
  ];
}

async function drive(backend: RuntimeBackend, scenario: Scenario): Promise<Observed> {
  const progress: string[] = [];
  const outcome = await runTurn(
    backend,
    scenario.agent,
    CONFIG,
    scenario.label,
    scenario.query,
    SESSION_ID,
    scenario.contextPath,
    "/tmp/mikro-backend-contract",
    (message) => progress.push(message),
    scenario.maxIterations
  );
  await drain(progress, scenario.expectedProgress.length);
  return { outcome, result: sessionResult(outcome.text, SESSION_ID, outcome.failed), progress };
}

/** Give the backend's async event-translation loop bounded time to drain. */
async function drain(progress: string[], expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (progress.length < expected && Date.now() < deadline) {
    await new Promise((r) => setImmediate(r));
  }
}

// ── Footer parsing ───────────────────────────────────────────────────────

interface ParsedFooter {
  readonly label: string;
  readonly model: string;
  readonly iterations: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cost: string;
  readonly seconds: number;
  readonly budgetHit: string | null;
  readonly sessionId: string;
}

const FOOTER_RE =
  /^mikro · (?<label>[^·]+?) · (?<model>[^·]+?) · (?<iterations>\d+) iterations? · (?<input>[\d,]+) in \/ (?<output>[\d,]+) out · (?<cost>\$[\d.]+) · (?<seconds>\d+(?:\.\d+)?)s(?: · budget hit: (?<budget>[^·]+?))? · session (?<session>\S+)$/;

function parseFooter(footer: string): ParsedFooter {
  const m = FOOTER_RE.exec(footer);
  const g = m?.groups;
  assert.ok(g, `not a cost footer: ${JSON.stringify(footer)}`);
  return {
    label: g.label,
    model: g.model,
    iterations: Number(g.iterations),
    inputTokens: Number(g.input.replace(/,/g, "")),
    outputTokens: Number(g.output.replace(/,/g, "")),
    cost: g.cost,
    seconds: Number(g.seconds),
    budgetHit: g.budget ?? null,
    sessionId: g.session,
  };
}

const SEPARATOR = "\n\n---\n";

function splitText(text: string): { answer: string; footer: string } {
  const idx = text.indexOf(SEPARATOR);
  assert.notEqual(idx, -1, `text has no answer/footer separator: ${JSON.stringify(text)}`);
  assert.equal(
    text.indexOf(SEPARATOR, idx + 1),
    -1,
    `more than one answer/footer separator: ${JSON.stringify(text)}`
  );
  return { answer: text.slice(0, idx), footer: text.slice(idx + SEPARATOR.length) };
}

/** Footer fields compared across backends. Seconds is excluded on purpose:
 *  wall-clock elapsed time is a property of the machine, not of the backend. */
function footerFields(o: Observed): Record<string, unknown> {
  const parsed = parseFooter(splitText(o.outcome.text).footer);
  return {
    label: parsed.label,
    model: parsed.model,
    iterations: parsed.iterations,
    inputTokens: parsed.inputTokens,
    outputTokens: parsed.outputTokens,
    cost: parsed.cost,
    budgetHit: parsed.budgetHit,
    sessionId: parsed.sessionId,
  };
}

/** The host-visible contract a single record must satisfy. */
function assertHostContract(observed: Observed, scenario: Scenario, tag: string): void {
  const { outcome, result, progress } = observed;

  // 1. The structuredContent envelope is exactly {answer, session_id}, and
  //    `answer` is the same string as the text block, byte for byte.
  const block = result.content[0];
  assert.ok(block && block.type === "text", `${tag}: first content block must be text`);
  assert.equal(block.text, outcome.text, `${tag}: text block must carry the turn text`);
  assert.deepEqual(
    result.structuredContent,
    { answer: outcome.text, session_id: SESSION_ID },
    `${tag}: envelope must be exactly {answer, session_id}, mirrored from the text block`
  );

  // 2. The text block is the raw answer plus one cost footer, and the footer
  //    carries the stub's numbers.
  const { answer, footer } = splitText(outcome.text);
  assert.equal(answer, outcome.answer, `${tag}: text block must open with the raw answer`);
  assert.equal(outcome.answer, scenario.stub.answer, `${tag}: answer passed through verbatim`);

  const parsed = parseFooter(footer);
  assert.equal(parsed.label, scenario.label, `${tag}: footer label`);
  assert.equal(
    parsed.model,
    `${CONFIG.model.provider}/${CONFIG.model.model}`,
    `${tag}: footer model must render the config the run used`
  );
  assert.equal(parsed.iterations, scenario.stub.iterations, `${tag}: footer iterations`);
  assert.equal(parsed.inputTokens, scenario.stub.usage.inputTokens, `${tag}: tokens in`);
  assert.equal(parsed.outputTokens, scenario.stub.usage.outputTokens, `${tag}: tokens out`);
  assert.equal(parsed.cost, formatCost(scenario.stub.usage.totalCost), `${tag}: cost`);
  assert.equal(parsed.budgetHit, scenario.stub.budgetHit, `${tag}: budget-hit field`);
  assert.equal(parsed.sessionId, SESSION_ID, `${tag}: session id`);
  assert.ok(Number.isFinite(parsed.seconds) && parsed.seconds >= 0, `${tag}: seconds present`);

  // 3. isError is exactly isFailedRun's classification of the result.
  assert.equal(outcome.failed, scenario.isError, `${tag}: failed flag`);
  assert.equal(result.isError, scenario.isError, `${tag}: isError`);
  assert.equal(
    outcome.failed,
    isFailedRun({ answer: outcome.answer, budgetHit: scenario.stub.budgetHit }),
    `${tag}: isError must be isFailedRun's verdict, nothing else`
  );

  // 4. The progress sequence is the stub's events translated, label-prefixed.
  assert.deepEqual(progress, scenario.expectedProgress, `${tag}: progress sequence`);
}

/** Engine forwarding — the legacy stub's recorded `rlmLoop` options. */
function assertLegacyForwarding(
  calls: readonly StubCall[],
  scenario: Scenario,
  tag: string
): void {
  assert.ok(calls.length > 0, `${tag}: the engine stub was never called`);
  for (const call of calls) {
    assert.equal(call.query, scenario.query, `${tag}: query forwarded`);
    if (scenario.contextPath === undefined) {
      assert.equal(call.context, null, `${tag}: no context path → null context forwarded`);
    } else {
      assert.ok(call.context !== null, `${tag}: a loaded context must reach the engine`);
      assert.equal(call.context?.type, "list", `${tag}: a directory context loads as a list`);
    }
    assert.equal(call.options.output, "json", `${tag}: output must stay "json" (stdout discipline)`);
    assert.ok(call.options.emitter, `${tag}: run must receive the subscribed emitter`);
    assert.equal(
      call.options.maxIterations,
      scenario.maxIterations,
      `${tag}: the spec's iteration cap must reach the engine`
    );
  }
}

/** True when `seq` appears in `argv` as a contiguous run, in order. */
function hasArgs(argv: readonly string[], seq: readonly string[]): boolean {
  outer: for (let i = 0; i <= argv.length - seq.length; i += 1) {
    for (let j = 0; j < seq.length; j += 1) {
      if (argv[i + j] !== seq[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Prime forwarding — the prime stub's recorded spawn call: the argv the
 * backend assembled and the limits it derived from the spec and config.
 * (The real spawn/parse/kill machinery is covered in
 * `tests/prime-backend.test.ts` against a stub binary.)
 */
function assertPrimeForwarding(
  calls: readonly PrimeCall[],
  scenario: Scenario,
  tag: string
): void {
  assert.ok(calls.length > 0, `${tag}: the prime engine was never called`);
  for (const call of calls) {
    const { argv } = call;
    assert.ok(hasArgs(argv, ["--mode", "json", "-p"]), `${tag}: json mode, print-and-exit`);
    assert.ok(argv.includes("--no-session"), `${tag}: --no-session`);
    assert.ok(
      hasArgs(argv, ["--cwd", "/tmp/mikro-backend-contract"]),
      `${tag}: the server's cwd must reach prime's --cwd`
    );
    for (const flag of ["-nc", "-ne", "-ns", "-np"]) {
      assert.ok(argv.includes(flag), `${tag}: host isolation flag ${flag}`);
    }
    assert.ok(
      argv.includes("--append-system-prompt"),
      `${tag}: the microagent role must be appended to prime's base prompt`
    );
    assert.ok(
      !argv.includes("--system-prompt"),
      `${tag}: prime's base RLM prompt must never be replaced`
    );
    assert.ok(
      hasArgs(argv, ["--provider", "deepseek", "--model", "deepseek-v4-flash"]),
      `${tag}: the gate model maps to prime's native deepseek provider, bare id`
    );
    const contextArgs = argv.filter((a) => a.startsWith("@"));
    if (scenario.contextPath === undefined) {
      assert.equal(contextArgs.length, 0, `${tag}: no context path → no @file args`);
    } else {
      assert.ok(contextArgs.length > 0, `${tag}: a loaded context must reach prime as @file args`);
      assert.ok(
        contextArgs.every((a) => a.startsWith("@/")),
        `${tag}: every @file arg must be the single @<abs path> form, got: ${argv.join(" ")}`
      );
    }
    assert.equal(argv.at(-2), "--", `${tag}: -- separator before the message`);
    assert.equal(argv.at(-1), scenario.query, `${tag}: query forwarded as the message`);
    assert.equal(call.limits.maxCost, null, `${tag}: null budget maxCost → null cost ceiling`);
    assert.equal(call.limits.maxTokens, null, `${tag}: null budget maxTokens → null token ceiling`);
    assert.equal(
      call.limits.maxTurns,
      scenario.maxIterations ?? null,
      `${tag}: the spec's iteration cap must reach the engine as the turn ceiling`
    );
    assert.ok(
      Number.isFinite(call.limits.deadlineMs) && call.limits.deadlineMs > 0,
      `${tag}: an mikro-owned wall-clock deadline is always set`
    );
  }
}

/**
 * Prime SDK forwarding — the plan the in-process backend assembled and the
 * limits it derived. The mirror of `assertPrimeForwarding`: same scenario,
 * same derived limits, but the mapping target is a session plan rather than
 * an argv line.
 */
function assertPrimeSdkForwarding(
  calls: readonly PrimeSdkCall[],
  scenario: Scenario,
  tag: string
): void {
  assert.ok(calls.length > 0, `${tag}: the prime-sdk engine was never called`);
  for (const call of calls) {
    const { plan } = call;
    assert.equal(plan.cwd, "/tmp/mikro-backend-contract", `${tag}: the server's cwd must reach the plan`);
    assert.equal(plan.query, scenario.query, `${tag}: query forwarded as the prompt`);
    assert.equal(plan.provider, "deepseek", `${tag}: mikro provider passes through unremapped`);
    assert.equal(plan.modelId, "deepseek-v4-flash", `${tag}: mikro model id passes through bare`);
    assert.equal(
      plan.modelsJson,
      null,
      `${tag}: deepseek is a prime built-in — no generated models.json`
    );
    assert.ok(
      plan.appendSystemPrompt.length > 0,
      `${tag}: the microagent role must be appended to prime's base prompt`
    );
    assert.equal(
      plan.tools[0]?.name,
      EMIT_DONE_TOOL,
      `${tag}: every run must offer the emit_done answer channel first`
    );
    if (scenario.contextPath === undefined) {
      assert.equal(plan.contextSnapshots.length, 0, `${tag}: no context path → no snapshots`);
    } else {
      assert.ok(
        plan.contextSnapshots.length > 0,
        `${tag}: a loaded context must reach the plan as snapshots`
      );
      assert.ok(
        plan.contextSnapshots.every((s) => s.path.startsWith(plan.scratchDir)),
        `${tag}: every snapshot must live inside the run's scratch dir`
      );
    }
    assert.equal(call.limits.maxCost, null, `${tag}: null budget maxCost → null cost ceiling`);
    assert.equal(call.limits.maxTokens, null, `${tag}: null budget maxTokens → null token ceiling`);
    assert.equal(
      call.limits.maxTurns,
      scenario.maxIterations ?? null,
      `${tag}: the spec's iteration cap must reach the engine as the turn ceiling`
    );
    assert.ok(
      Number.isFinite(call.limits.deadlineMs) && call.limits.deadlineMs > 0,
      `${tag}: an mikro-owned wall-clock deadline is always set`
    );
  }
}

const SECONDS_RE = / · \d+(?:\.\d+)?s ·/;

/** Cross-backend equality: every compared dimension must match. */
function assertRecordsEqual(a: Observed, b: Observed, tag: string): void {
  assert.equal(a.outcome.answer, b.outcome.answer, `${tag}: answers diverged`);
  assert.equal(
    a.outcome.text.replace(SECONDS_RE, " · <elapsed>s ·"),
    b.outcome.text.replace(SECONDS_RE, " · <elapsed>s ·"),
    `${tag}: text blocks diverged (modulo the elapsed-seconds field)`
  );
  assert.deepEqual(footerFields(a), footerFields(b), `${tag}: footer field set diverged`);
  assert.equal(a.result.isError, b.result.isError, `${tag}: isError diverged`);
  assert.deepEqual(
    a.result.structuredContent?.session_id,
    b.result.structuredContent?.session_id,
    `${tag}: envelope session diverged`
  );
  assert.deepEqual(a.progress, b.progress, `${tag}: progress sequences diverged`);
}

// ── Scenarios ────────────────────────────────────────────────────────────

const GENERIC_QUERY = "Where are the two call sites of rlmLoop?";

const SCENARIOS: readonly Scenario[] = [
  {
    name: "loop run with recursion (generic mikro_query shape)",
    agent: undefined,
    label: "query",
    query: GENERIC_QUERY,
    stub: {
      answer: "Two call sites: src/a.ts:10 and src/b.ts:20.",
      iterations: 2,
      budgetHit: null,
      usage: USAGE,
      events: [ev("IterationStart"), ev("IterationStart"), ev("Recurse")],
    },
    expectedProgress: [
      "query · iteration 1",
      "query · iteration 2",
      "query · iteration 2 · 1 recursive spawn",
    ],
    isError: false,
  },
  {
    name: "agent turn forwards the spec's iteration cap",
    agent: fakeAgent(undefined),
    label: "agent=triage",
    query: "Classify this: nginx 502 storm.",
    maxIterations: 3,
    stub: {
      answer: "triage: P1, owner=platform.",
      iterations: 3,
      budgetHit: null,
      usage: USAGE,
      events: [ev("IterationStart"), ev("IterationStart"), ev("IterationStart")],
    },
    expectedProgress: [
      "agent=triage · iteration 1",
      "agent=triage · iteration 2",
      "agent=triage · iteration 3",
    ],
    isError: false,
  },
  {
    name: "empty-response abort is a failed run with the abort reason as the answer",
    agent: undefined,
    label: "query",
    query: GENERIC_QUERY,
    stub: {
      answer:
        "Error: aborted after 3 consecutive empty LLM responses. Context may exceed API token limits.",
      iterations: 3,
      budgetHit: EMPTY_RESPONSES_BUDGET_HIT,
      usage: USAGE,
      events: [ev("IterationStart")],
    },
    expectedProgress: ["query · iteration 1"],
    isError: true,
  },
  {
    name: "wall-clock timeout is a failed run with the verbatim timeout answer",
    agent: undefined,
    label: "query",
    query: GENERIC_QUERY,
    stub: {
      answer: TIMEOUT_ANSWER,
      iterations: 1,
      budgetHit: null,
      usage: USAGE,
      events: [ev("IterationStart")],
    },
    expectedProgress: ["query · iteration 1"],
    isError: true,
  },
  {
    name: "budget-truncated run stays a success with the budget field in the footer",
    agent: undefined,
    label: "query",
    query: GENERIC_QUERY,
    stub: {
      answer: "The call sites are src/a.ts:10 and src/b.ts:20 (report shortened).",
      iterations: 4,
      budgetHit: "max-cost",
      usage: USAGE,
      events: [ev("IterationStart")],
    },
    expectedProgress: ["query · iteration 1"],
    isError: false,
  },
];

function fakeAgent(backend: string | undefined): Microagent {
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
      ...(backend === undefined ? {} : { backend }),
    },
  } as unknown as Microagent;
}

/** Drive one scenario through every backend and assert the full contract. */
async function runScenario(scenario: Scenario): Promise<void> {
  const legacy = stubLoop(scenario.stub);
  const prime = stubPrimeEngine(scenario.stub, bareProgress(scenario));
  const primeSdk = stubPrimeSdkEngine(scenario.stub, bareProgress(scenario));
  const backends = backendsFor(legacy.loop, prime.engine, primeSdk.engine);
  assert.ok(backends.length > 1, "the comparison needs at least two backends to mean anything");

  const observed: Observed[] = [];
  for (const { name, backend } of backends) {
    const record = await drive(backend, scenario);
    observed.push(record);
    assertHostContract(record, scenario, `${scenario.name} [${name}]`);
    if (name === "prime") {
      assertPrimeForwarding(prime.calls, scenario, `${scenario.name} [${name}]`);
    } else if (name === "prime-sdk") {
      assertPrimeSdkForwarding(primeSdk.calls, scenario, `${scenario.name} [${name}]`);
    } else {
      assertLegacyForwarding(legacy.calls, scenario, `${scenario.name} [${name}]`);
    }
  }

  // The actual contract: what the host sees must not depend on the backend.
  for (let i = 1; i < observed.length; i++) {
    assertRecordsEqual(
      observed[0]!,
      observed[i]!,
      `${scenario.name} [${backends[0]!.name} vs ${backends[i]!.name}]`
    );
  }
}

describe("backend contract — one harness, both backends", () => {
  for (const scenario of SCENARIOS) {
    it(`"${scenario.name}" is host-identical across every backend`, () => runScenario(scenario));
  }

  it("forwards a loaded directory context as @<abs path> args to prime", async () => {
    // The prime forwarding assertions must see the corrected argv: when a
    // context exists, every context file reaches the spawn line as one
    // `@<abs path>` arg (a plain path would become a message and spawn a
    // garbage turn). The legacy engine, meanwhile, must receive the loaded
    // context itself — the same files, through its own seam.
    const dir = await mkdtemp(join(tmpdir(), "mikro-contract-ctx-"));
    try {
      await writeFile(join(dir, "note.md"), "Call sites: src/c.ts:42 and src/d.ts:7.\n");
      const scenario: Scenario = {
        name: "directory context forwarding",
        agent: undefined,
        label: "query",
        query: GENERIC_QUERY,
        contextPath: dir,
        stub: {
          answer: "Two call sites: src/c.ts:42 and src/d.ts:7.",
          iterations: 1,
          budgetHit: null,
          usage: USAGE,
          events: [ev("IterationStart")],
        },
        expectedProgress: ["query · iteration 1"],
        isError: false,
      };
      await runScenario(scenario);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * `validation_failed` — deliberately NOT a shared `SCENARIOS` entry.
 *
 * The flag is produced by `rlmLoop`'s VALIDATE.md gate and therefore exists
 * only behind the legacy backend: the prime backends enforce their schema
 * through `emit_done`'s parameter schema and can never reach this state. A
 * scenario in the shared list would fail the cross-backend byte comparison by
 * construction — which would be pinning an asymmetry the wish declared OUT of
 * scope, not catching a regression. So it is asserted legacy-only, on the same
 * real turn pipeline every other scenario uses.
 */
describe("validation_failed reaches the footer (legacy backend only)", () => {
  const ANSWER = '{"verdict": "maybe"}';

  /** The stub loop, plus the one field the shared `stubLoop` cannot express. */
  function flaggingLoop(validationFailed: boolean): StubLoop {
    return async (_query, _context, _config, options = {}) => {
      options.emitter?.emit(ev("IterationStart"));
      options.emitter?.close();
      return {
        answer: ANSWER,
        references: [],
        usage: USAGE,
        iterations: 2,
        model: "stub/stub-model",
        budgetHit: null,
        ...(validationFailed ? { validation_failed: true } : {}),
      };
    };
  }

  async function driveFlagged(validationFailed: boolean): Promise<Observed> {
    return drive(new LegacyMikroBackend({ loop: flaggingLoop(validationFailed) }), {
      name: "validation flag",
      agent: undefined,
      label: "query",
      query: GENERIC_QUERY,
      stub: {
        answer: ANSWER,
        iterations: 2,
        budgetHit: null,
        usage: USAGE,
        events: [ev("IterationStart")],
      },
      expectedProgress: ["query · iteration 1"],
      isError: false,
    });
  }

  it("adds a footer segment when the loop flagged the answer", async () => {
    const { outcome } = await driveFlagged(true);
    const footer = splitText(outcome.text).footer;
    assert.ok(
      footer.includes(" · validation_failed: true · session "),
      `footer must carry the flag ahead of the session id: ${JSON.stringify(footer)}`
    );
  });

  it("leaves the footer untouched when the answer conformed", async () => {
    const { outcome } = await driveFlagged(false);
    const footer = splitText(outcome.text).footer;
    assert.ok(!footer.includes("validation_failed"));
    // Still the canonical footer shape — the segment is purely additive.
    assert.equal(parseFooter(footer).sessionId, SESSION_ID);
  });

  /**
   * The flag is footer-only by contract. `structuredContent` is a declared
   * output schema an MCP host validates against, and widening it would be a
   * host-visible contract change the wish explicitly froze.
   */
  it("never widens structuredContent beyond {answer, session_id}", async () => {
    const { outcome } = await driveFlagged(true);
    assert.deepEqual(
      sessionResult(outcome.text, SESSION_ID, outcome.failed).structuredContent,
      { answer: outcome.text, session_id: SESSION_ID }
    );
  });

  /** A flagged answer is a real, paid, returned payload — not a failed run. */
  it("is not classified as a failed run", async () => {
    const { outcome } = await driveFlagged(true);
    assert.equal(outcome.failed, false);
  });
});

describe("backend selection", () => {
  it("defaults an agent with no backend field to the legacy backend", () => {
    assert.ok(selectBackend(fakeAgent(undefined)) instanceof LegacyMikroBackend);
  });

  it("honors an explicit backend: mikro", () => {
    assert.ok(selectBackend(fakeAgent("mikro")) instanceof LegacyMikroBackend);
  });

  it("runs mikro_query — no spec, no backend field — on legacy, unconditionally", () => {
    // There is no selection path for the generic tool: it has no agent spec,
    // so there is no `backend` field to read.
    assert.ok(selectBackend(undefined) instanceof LegacyMikroBackend);
  });

  it("selects the prime backend for a spec naming backend: prime", async () => {
    // The prime backend's constructor pins the binary version, so the
    // selection test drives it with a version-only stub — the test suite
    // must not require the real prime-agent install.
    const dir = await mkdtemp(join(tmpdir(), "mikro-contract-prime-"));
    try {
      const shim = join(dir, "prime-agent");
      await writeFile(
        shim,
        "#!/usr/bin/env node\n" +
          "if (process.argv.includes('--version')) { process.stderr.write('0.8.1'); process.exit(0); }\n" +
          "process.exit(1);\n",
        "utf-8"
      );
      await chmod(shim, 0o755);

      const previous = process.env.MIKRO_PRIME_BINARY_PATH;
      try {
        process.env.MIKRO_PRIME_BINARY_PATH = shim;
        assert.ok(selectBackend(fakeAgent("prime")) instanceof PrimeBackend);
      } finally {
        if (previous === undefined) delete process.env.MIKRO_PRIME_BINARY_PATH;
        else process.env.MIKRO_PRIME_BINARY_PATH = previous;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("selects the in-process prime-sdk backend for a spec naming backend: prime-sdk", () => {
    // Unlike PrimeBackend, this constructor touches nothing: package
    // resolution, the version pin, and the dynamic import all live behind
    // the memoized loader, so selection works on a machine with no
    // prime-agent installed. That is the property under test.
    const previous = process.env.MIKRO_PRIME_AGENT_ROOT;
    try {
      delete process.env.MIKRO_PRIME_AGENT_ROOT;
      assert.ok(selectBackend(fakeAgent("prime-sdk")) instanceof PrimeSdkBackend);
    } finally {
      if (previous !== undefined) process.env.MIKRO_PRIME_AGENT_ROOT = previous;
    }
  });

  it("rejects a forged backend name that would hit the prototype chain", () => {
    // A plain-object BACKENDS record resolves "constructor" to a truthy
    // non-backend; the Map record must resolve it to "not wired".
    assert.throws(
      () => selectBackend(fakeAgent("constructor")),
      /backend "constructor" is not wired into this build/
    );
  });

  it("fails loudly when a spec names a backend this build has not wired", () => {
    assert.throws(
      () => selectBackend(fakeAgent("pulp")),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /backend "pulp" is not wired/);
        assert.match(err.message, /triage/);
        return true;
      }
    );
  });
});

describe("agent.yaml backend field (internal, undocumented)", () => {
  const DIR = "/tmp/fake-agent";

  it("parses mikro | prime | prime-sdk and stays undefined when absent", () => {
    assert.equal(parseAgentSpec("backend: mikro\n", DIR).backend, "mikro");
    assert.equal(parseAgentSpec("backend: prime\n", DIR).backend, "prime");
    assert.equal(parseAgentSpec("backend: prime-sdk\n", DIR).backend, "prime-sdk");
    assert.equal(parseAgentSpec("shape: loop\n", DIR).backend, undefined);
  });

  it("rejects a typo loudly instead of silently running the legacy engine", () => {
    assert.throws(
      () => parseAgentSpec("backend: prim\n", DIR),
      /agent\.yaml: backend must be one of mikro \| prime \| prime-sdk, got "prim"/
    );
    assert.throws(() => parseAgentSpec("backend: xhigh\n", DIR), /backend must be one of/);
    // The near-miss that matters most: `prime-sdk` is one hyphen away from a
    // name that would otherwise fall through to a different engine.
    assert.throws(
      () => parseAgentSpec("backend: primesdk\n", DIR),
      /backend must be one of mikro \| prime \| prime-sdk, got "primesdk"/
    );
  });

  it("does not leak into the extras bag", () => {
    const spec = parseAgentSpec("backend: prime\n", DIR);
    assert.equal(spec.extras.backend, undefined);
    assert.deepEqual(Object.keys(spec.extras), []);
  });
});

describe("the cross-backend comparator can fail", () => {
  // One legitimate record per scenario dimension, corrupted one field at a
  // time: the comparator must flag every dimension the contract covers.
  // (During development a deliberately divergent *backend* was also run
  // through the harness and the suite failed as expected — see the report.)
  it("flags a divergence in any compared dimension", async () => {
    const stub: StubRun = {
      answer: "Two call sites: src/a.ts:10 and src/b.ts:20.",
      iterations: 2,
      budgetHit: null,
      usage: USAGE,
      events: [ev("IterationStart")],
    };
    const { loop } = stubLoop(stub);
    const scenario: Scenario = {
      name: "comparator",
      agent: undefined,
      label: "query",
      query: GENERIC_QUERY,
      stub,
      expectedProgress: ["query · iteration 1"],
      isError: false,
    };
    const base = await drive(new LegacyMikroBackend({ loop }), scenario);

    const corruptions: Array<{ name: string; mutate: (o: Observed) => Observed }> = [
      {
        name: "answer",
        mutate: (o) => ({ ...o, outcome: { ...o.outcome, answer: "A different answer." } }),
      },
      {
        name: "text block (footer cost)",
        mutate: (o) => ({
          ...o,
          outcome: { ...o.outcome, text: o.outcome.text.replace("$0.01", "$0.02") },
        }),
      },
      {
        name: "isError",
        mutate: (o) => ({ ...o, result: { ...o.result, isError: !o.result.isError } }),
      },
      {
        name: "progress sequence",
        mutate: (o) => ({ ...o, progress: o.progress.slice(0, -1) }),
      },
      {
        name: "envelope session",
        mutate: (o) => ({
          ...o,
          result: {
            ...o.result,
            structuredContent: { ...o.result.structuredContent, session_id: "sess_other" },
          },
        }),
      },
    ];

    for (const { name, mutate } of corruptions) {
      const corrupted = mutate(cloneObserved(base));
      assert.throws(
        () => assertRecordsEqual(base, corrupted, "comparator"),
        `a divergence in ${name} must fail the comparison`
      );
    }

    // A clean copy must pass — the comparator is strict, not broken.
    assertRecordsEqual(base, cloneObserved(base), "comparator");
  });
});

function cloneObserved(o: Observed): Observed {
  return {
    outcome: { ...o.outcome },
    result: {
      content: [...o.result.content],
      structuredContent: { ...o.result.structuredContent },
      isError: o.result.isError,
    },
    progress: [...o.progress],
  };
}

describe("legacy timeout override", () => {
  it("forwards MIKRO_MCP_RUN_TIMEOUT_MS to the engine, and leaves it alone when unset", async () => {
    const stub: StubRun = {
      answer: "done",
      iterations: 1,
      budgetHit: null,
      usage: USAGE,
      events: [ev("IterationStart")],
    };
    const { loop, calls } = stubLoop(stub);
    const scenario: Scenario = {
      name: "timeout",
      agent: undefined,
      label: "query",
      query: GENERIC_QUERY,
      stub,
      expectedProgress: ["query · iteration 1"],
      isError: false,
    };

    const previous = process.env.MIKRO_MCP_RUN_TIMEOUT_MS;
    try {
      delete process.env.MIKRO_MCP_RUN_TIMEOUT_MS;
      await drive(new LegacyMikroBackend({ loop }), scenario);
      assert.equal(calls[0]?.options.timeout, undefined, "no env → no timeout override");

      process.env.MIKRO_MCP_RUN_TIMEOUT_MS = "123456";
      await drive(new LegacyMikroBackend({ loop }), scenario);
      assert.equal(calls[1]?.options.timeout, 123456, "env override must reach the engine");
    } finally {
      if (previous === undefined) delete process.env.MIKRO_MCP_RUN_TIMEOUT_MS;
      else process.env.MIKRO_MCP_RUN_TIMEOUT_MS = previous;
    }
  });
});
