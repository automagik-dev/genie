/**
 * Prime SDK backend — executes one delegated microagent turn IN-PROCESS
 * through the installed prime-agent package's programmatic SDK
 * (`createAgentSession`), instead of spawning its CLI once per turn.
 *
 * Default-off and additive: nothing selects this backend unless an agent
 * spec says `backend: prime-sdk`. `src/mcp/backends/prime.ts` is untouched.
 *
 * ## Why a second prime backend
 * `PrimeBackend` shells out to `prime-agent --mode json -p` per turn, which
 * costs ~942 ms of cold start before the first token and confines the
 * integration to whatever the CLI's flags expose. The installed package
 * (`prime-agent`, the fork of `@earendil-works/pi-coding-agent`, MIT) also
 * ships a programmatic entry point. Driving that in-process removes the
 * spawn and — the actual point — unlocks the capabilities the flag surface
 * simply does not have: custom tools, structured output, custom providers,
 * and a real sub-call depth knob.
 *
 * **The npm package named `@earendil-works/pi-coding-agent` is NOT this
 * SDK** — that is upstream pi (0.84.x), a different line. This module never
 * imports a bare specifier; it resolves the INSTALLED package root and
 * imports `<root>/dist/index.js` by absolute path, after asserting the
 * installed version matches the pin.
 *
 * ## Host contract
 * Identical to every other `RuntimeBackend`: one `MicroagentResult` with
 * `answer` / `iterations` / `budgetHit` / `usage`. The two designed aborts
 * keep legacy's classification — a deadline returns `TIMEOUT_ANSWER` (which
 * `isFailedRun` marks failed) and a ceiling returns normally with
 * `budgetHit` set (a success carrying a budget note in the footer).
 *
 * ## Delta vs `prime.ts` — what stopped being a loud reject
 * `prime.ts`'s header lists what the subprocess leg cannot honor. The
 * in-process leg honors all but one of them, and never by degrading
 * silently:
 *
 * | `prime.ts` rejects | here |
 * |---|---|
 * | `output.schema` | **honored** — the schema becomes `emit_done`'s parameter schema, so the model's structured payload is validated by prime's own tool-call layer before it reaches us, and the run's answer is that payload as JSON. |
 * | `budget.maxDepth` | **honored** — passed as `createAgentSession`'s first-class `rlmMaxDepth` option (see "Deviations" below). |
 * | `dict` context | **honored** — every context type is snapshotted to 0600 files under the run's scratch dir and named in the prompt, so there is no context shape left that cannot be mapped. |
 * | `station` provider, and every provider beyond Prime's catalog | **honored** — `khal` / `wafer` / `station` are emitted into a generated `models.json` under the scratch `agentDir`; `google`, `openrouter`, `deepseek`, and `openai-codex` resolve against Prime's built-in catalog under their own Mikro names. |
 * | gemini grounding flags | **still rejected** — `googleSearch`, `urlContext`, `codeExecution`, `computerUse`, `mapsGrounding`, `fileSearch`, `mediaResolution` are mikro-side request decoration prime cannot replicate. |
 * | `config.tools` (TOOLS.md) | **still rejected** — see below. |
 *
 * `config.tools` are TOOLS.md *Python source strings* injected into mikro's
 * own REPL (`ToolDef = {name, code}`). Prime's analogous surface is its
 * IPython kernel, and `createAgentSession` exposes no way to preload code
 * into it. Honoring them would mean inventing an unverified mechanism;
 * ignoring them would mean running an agent without the tools it declared.
 * So it stays a loud reject. Note this is the *config* tool list, which is
 * distinct from `agent.spec.tools` — those ARE honored, as custom tools.
 *
 * ## Spec tools → prime custom tools
 * `agent.spec.tools[]` names resolve through mikro's existing plugin loaders
 * (`src/sdk/tool-loader.ts` for `.mjs`/`.js`, `src/sdk/python-plugin.ts`
 * for `.py`) into a `ToolRegistry`, exactly as `runAgent` resolves them.
 * Each resolved handler is wrapped in a prime `ToolDefinition` whose
 * `parameters` is the registry's declared JSON Schema, or a permissive
 * object schema when the plugin declared none (the loaders attach no schema
 * today — see `docs/tool-authoring.md`). A name that resolves to no plugin
 * is passed through to prime's built-in allowlist if it names a built-in
 * (`ipython` / `bash` / `edit`), and otherwise fails loudly.
 *
 * ## `emit_done` — why the answer is a tool call
 * Every run registers an `emit_done` tool. Its `parameters` is the spec's
 * `output.schema` when there is one, else `{answer: string}`. The run's
 * answer is the arguments prime validated for that call. This is what makes
 * structured output real rather than a prompt-shaped hope: the schema is
 * enforced by prime's tool-call validation layer before `execute` runs.
 *
 * Two behaviors verified live against the installed 0.8.1 and pinned here:
 *
 * 1. `tools` is an allowlist that gates **custom** tools too, not just
 *    built-ins. `tools: []` silently disables `emit_done` and the model
 *    answers in prose instead. The allowlist therefore ALWAYS names
 *    `emit_done`. (Probed: with `tools: []` the tool was never called;
 *    with `tools: ["emit_done"]` it was.)
 * 2. A model may still decline to call it. With no `output.schema` that is
 *    survivable — the answer falls back to the final assistant text, which
 *    is what `prime.ts` would have returned anyway. With an `output.schema`
 *    it is not: there is no structured payload, so the run fails loudly
 *    rather than hand the host prose where a schema was promised.
 *
 * ## Budgets — mikro owns them
 * Mirrors `prime.ts` exactly. Turns are counted at `turn_start` against the
 * spec's iteration cap; usage accumulates against `maxCost` / `maxTokens`;
 * an mikro-owned wall clock (`MIKRO_MCP_RUN_TIMEOUT_MS`, default 300s)
 * bounds the run. A breach calls `session.abort()`.
 *
 * Usage is accumulated at `message_end` ONLY. Verified live: `message_end`
 * and the following `turn_end` carry the SAME assistant message object with
 * the same `usage`, so counting both would double every run's tokens and
 * cost, and fire cost ceilings at half their configured value.
 *
 * **Cost ceilings on custom providers.** Prime derives cost from the price
 * table declared in `models.json`, and mikro does not know per-model pricing
 * for `khal` / `wafer` / `station` here. A declared-zero price would make a
 * `budget.max_cost` ceiling silently un-fireable, so that combination is a
 * loud reject instead.
 *
 * ## Deviations from the brief (deliberate, each verified)
 * - **Version pin.** The subprocess and SDK are two compatibility surfaces
 *   (CLI JSON stream versus programmatic session API), but both target one
 *   deliberate prime-agent release through `EXPECTED_PRIME_VERSION`.
 * - **Sub-call depth.** The brief said to set a `RLM_MAX_DEPTH` env var.
 *   `createAgentSession` accepts `rlmMaxDepth` directly, so this uses that
 *   instead: `process.env` is process-global, and the MCP server runs turns
 *   concurrently, so an env var would race between two turns with different
 *   depth budgets and silently apply the wrong one.
 * - **Typebox.** The brief said tool `parameters` are TypeBox
 *   (`Type.Object(...)`). Verified: the installed `typebox@1.3.21`'s
 *   `Type.Object` returns a plain JSON Schema object carrying no symbols,
 *   and prime's `defineTool` is the identity function. So schemas are
 *   written as plain JSON Schema and mikro takes no typebox dependency.
 *
 * ## Inherent boundary
 * Prime's recursive `rlm()` children run on prime's own model defaults;
 * only their depth is steerable from here. Their usage is not reported on
 * the parent's event stream, so — as with `prime.ts` — footer totals cover
 * the parent's turns.
 */
import type { MikroConfig } from "../../config.js";
import type { LoadedContext } from "../../context.js";
import type { Microagent } from "../agents.js";
import type { BackendRequest, MicroagentResult, RuntimeBackend } from "../backend.js";
/** The shared prime-agent release whose SDK surface this module targets. */
export declare const EXPECTED_PRIME_SDK_VERSION = "0.8.1";
/** The tool through which a run reports its final answer. */
export declare const EMIT_DONE_TOOL = "emit_done";
export interface PrimeSdkToolResult {
    readonly content: ReadonlyArray<{
        readonly type: "text";
        readonly text: string;
    }>;
    readonly details: unknown;
    readonly terminate?: boolean;
}
export interface PrimeSdkToolDefinition {
    readonly name: string;
    readonly label: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
    execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown): Promise<PrimeSdkToolResult>;
}
export interface PrimeSdkUsage {
    readonly input?: number;
    readonly output?: number;
    readonly cost?: {
        readonly total?: number;
    };
}
export interface PrimeSdkMessage {
    readonly role?: string;
    readonly content?: string | ReadonlyArray<{
        type?: string;
        text?: string;
    }>;
    readonly usage?: PrimeSdkUsage;
    readonly stopReason?: string;
    readonly errorMessage?: string;
}
export interface PrimeSdkEvent {
    readonly type?: string;
    readonly message?: PrimeSdkMessage;
    readonly toolName?: string;
}
export interface PrimeSdkSession {
    subscribe(listener: (event: PrimeSdkEvent) => void): unknown;
    prompt(text: string): Promise<unknown>;
    abort(): void;
    dispose(): void;
}
export interface PrimeSdkModel {
    readonly provider: string;
    readonly id: string;
    readonly maxTokens?: number;
}
export interface PrimeSdkModelRegistry {
    find(provider: string, modelId: string): PrimeSdkModel | undefined;
    getError?(): string | undefined;
}
/** Exactly the SDK surface this backend touches — the contract a fake must meet. */
export interface PrimeSdkModule {
    getAgentDir(): string;
    defineTool(tool: PrimeSdkToolDefinition): PrimeSdkToolDefinition;
    readonly AuthStorage: {
        create(path?: string): unknown;
    };
    readonly ModelRegistry: {
        create(authStorage: unknown, modelsJsonPath?: string): PrimeSdkModelRegistry;
    };
    readonly SettingsManager: {
        inMemory(settings?: Record<string, unknown>): unknown;
        create(cwd: string, agentDir?: string): unknown;
    };
    readonly SessionManager: {
        inMemory(): unknown;
    };
    readonly DefaultResourceLoader: new (options: Record<string, unknown>) => {
        reload(): Promise<unknown>;
    };
    createAgentSession(options: Record<string, unknown>): Promise<{
        session: PrimeSdkSession;
    }>;
}
/** Resolves the prime SDK module. Injected in tests; memoized in production. */
export type PrimeSdkLoader = () => Promise<PrimeSdkModule>;
/** One tool offered to the model. `handler` is absent for `emit_done`. */
export interface PrimeSdkPlannedTool {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
    readonly handler?: (args: unknown) => Promise<unknown>;
}
/** A `models.json` document, exactly as prime validates it. */
export interface PrimeModelsJson {
    readonly providers: Readonly<Record<string, Record<string, unknown>>>;
}
/**
 * Everything one in-process run needs — this backend's analog of `prime.ts`'s
 * argv. Built before the SDK is touched so tests can assert on the mapping
 * without a session.
 */
export interface PrimeSdkPlan {
    /** 0700 per-run scratch dir for context and generated provider overrides. */
    readonly scratchDir: string;
    /** Where the agent works — the server's cwd, never the scratch dir. */
    readonly cwd: string;
    readonly query: string;
    /** Appended AFTER prime's base prompt — never replacing it. */
    readonly appendSystemPrompt: string;
    readonly provider: string;
    readonly modelId: string;
    /** Provider-level output cap for each root call. */
    readonly maxOutputTokens: number | null;
    readonly thinkingLevel: string | null;
    /** `budget.max_depth`, passed as `rlmMaxDepth`. */
    readonly rlmMaxDepth: number | null;
    /** Generated only for a custom provider; `null` for prime's built-ins. */
    readonly modelsJson: PrimeModelsJson | null;
    /** Context snapshots written 0600 under `<scratchDir>/context/`. */
    readonly contextSnapshots: ReadonlyArray<{
        readonly path: string;
        readonly content: string;
    }>;
    /** `emit_done` first, then the spec's resolved custom tools. */
    readonly tools: readonly PrimeSdkPlannedTool[];
    /** Built-in prime tools the spec opted into. */
    readonly builtinTools: readonly string[];
    /** The spec's `output.schema`, when it declared one. */
    readonly answerSchema: Record<string, unknown> | null;
}
/** Budgets this backend enforces on the run. Mirrors `PrimeRunLimits`. */
export interface PrimeSdkRunLimits {
    readonly deadlineMs: number;
    readonly maxCost: number | null;
    readonly maxTokens: number | null;
    readonly maxTurns: number | null;
}
/** The raw material of one run. Mirrors `PrimeRunResult`. */
export interface PrimeSdkRunResult {
    readonly answer: string;
    readonly turns: number;
    readonly budgetHit: string | null;
    readonly usage: {
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly totalCost: number;
    };
}
/**
 * Run one plan to completion (or to a designed abort). In production this is
 * {@link runSdkSession}; the backend-contract harness injects a scripted
 * engine, exactly as it does for `PrimeBackend`.
 */
export type PrimeSdkEngine = (plan: PrimeSdkPlan, emit: (message: string) => void, limits: PrimeSdkRunLimits) => Promise<PrimeSdkRunResult>;
/** Optional hermetic provider-payload transform, implemented as an inline Prime extension. */
export type PrimeSdkProviderPayloadTransform = (payload: unknown, plan: PrimeSdkPlan) => unknown | Promise<unknown>;
export interface PrimeSdkBackendOptions {
    /** Test seam: the SDK module. Supplying it skips root resolution and the version pin. */
    readonly loader?: PrimeSdkLoader;
    /** Test seam: replaces the whole run engine (contract harness). */
    readonly engine?: PrimeSdkEngine;
    /** Pinned version to assert (default: {@link EXPECTED_PRIME_SDK_VERSION}). */
    readonly expectedVersion?: string;
    /** Explicit prime package root; overrides `MIKRO_PRIME_AGENT_ROOT` and PATH discovery. */
    readonly primeRoot?: string;
    /** Canonical Prime config dir; defaults to the SDK's getAgentDir(), exactly like the CLI. */
    readonly primeAgentDir?: string;
    /** Inline-only transform; host extension discovery remains disabled. */
    readonly providerPayloadTransform?: PrimeSdkProviderPayloadTransform;
}
/**
 * Locate the INSTALLED prime-agent package root.
 *
 * `MIKRO_PRIME_AGENT_ROOT` wins; otherwise the `prime-agent` binary is found
 * on PATH and followed to its real path — `<root>/dist/bundle/cli.js` — whose
 * grandparent directory is the package root.
 */
export declare function resolvePrimeRoot(): string;
/**
 * Assert the installed package is the pinned version and return its root.
 * Reports to stderr AND throws, so the failure is visible in the server log
 * and surfaces as a clean tool error — same discipline as `prime.ts`.
 */
export declare function assertPinnedSdkVersion(root: string, expected: string): void;
/**
 * The production loader: resolve the root, assert the pin, import
 * `<root>/dist/index.js` by absolute file URL. Memoized — the import and
 * the pin check happen once per process.
 */
export declare function createPrimeSdkLoader(options?: PrimeSdkBackendOptions): PrimeSdkLoader;
/**
 * Reject every mikro feature the in-process prime leg cannot honor. Far
 * shorter than `prime.ts`'s list — see the delta table in the module header.
 */
export declare function assertSupportedConfig(config: MikroConfig, agentName: string | undefined): void;
/** Build the `models.json` document for a custom provider, or null for a built-in. */
export declare function buildModelsJson(provider: string, modelId: string, agentName: string | undefined): PrimeModelsJson | null;
/**
 * Snapshot the loaded context into files under the run's scratch dir.
 *
 * Unlike `prime.ts`, which hands prime `@<abs path>` arguments pointing at
 * the caller's originals, the SDK has no `@file` argument parser — so the
 * content mikro already loaded is written out and named in the prompt. That
 * is also why `dict` contexts work here and not there: a snapshot has a
 * shape, an `@file` argument needs a pre-existing path.
 */
export declare function planContextSnapshots(context: LoadedContext | null, scratchDir: string): Array<{
    path: string;
    content: string;
}>;
/** Build the run plan. Touches the SDK not at all — only maps mikro onto it. */
export declare function buildPlan(scratchDir: string, agent: Microagent | undefined, request: BackendRequest): Promise<PrimeSdkPlan>;
/** Create the per-run scratch directory, owner-only. */
export declare function createScratchDir(): string;
/**
 * Write the plan's files into the scratch dir: `models.json` when a custom
 * provider needs one, and every context snapshot. All 0600 — the scratch dir
 * carries a generated provider config and the caller's context, neither of
 * which any other user on the box has business reading.
 */
export declare function materializePlan(plan: PrimeSdkPlan): void;
/**
 * Run one plan through a real prime agent session, enforcing the mikro-owned
 * budgets from the event stream and aborting the session on breach.
 */
export declare function runSdkSession(load: PrimeSdkLoader, plan: PrimeSdkPlan, emit: (message: string) => void, limits: PrimeSdkRunLimits, configuredPrimeAgentDir?: string, providerPayloadTransform?: PrimeSdkProviderPayloadTransform): Promise<PrimeSdkRunResult>;
export declare class PrimeSdkBackend implements RuntimeBackend {
    private readonly engine;
    constructor(options?: PrimeSdkBackendOptions);
    run(agent: Microagent | undefined, request: BackendRequest, emit: (message: string) => void): Promise<MicroagentResult>;
}
//# sourceMappingURL=prime-sdk.d.ts.map