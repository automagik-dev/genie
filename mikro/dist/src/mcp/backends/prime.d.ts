/**
 * Prime backend — executes one delegated microagent turn through the pinned,
 * installed prime-agent binary (wish mikro-v2-prime-backend, Group 2).
 *
 * Why a subprocess: prime-agent is not an npm SDK this repo may import — the
 * wish pins integration to the installed binary (`--mode json -p`), and a
 * spawn per turn is the only surface that exists. The daemon socket is never
 * touched and no prime-agent package is imported anywhere.
 *
 * ## Host contract
 * The result shape is exactly `MicroagentResult` (`src/mcp/backend.ts`):
 * `answer` from prime's final assistant message, `iterations` from prime's
 * turn count (prime has no iteration concept of its own — a turn is its
 * analog), `budgetHit` from this backend's own enforcement, `usage` from the
 * assistant messages' usage records. `isFailedRun` (`src/mcp/server.ts`)
 * classifies the two designed aborts the way it classifies legacy's: a
 * deadline kill returns `TIMEOUT_ANSWER` (failed run) and a ceiling kill
 * returns normally with `budgetHit` set (success with a budget note in the
 * footer).
 *
 * ## Mapping decisions
 * The wish is the governing artifact; every ambiguous mapping fails loudly —
 * no silent degradation.
 *
 * - model: Prime 0.8.1 accepts direct `google`, `openrouter`, `deepseek`,
 *   `prime-inference`, `openai-codex`, and `zai` provider/model pairs. Mikro's
 *   configured `khal` provider uses Prime's custom-provider contract. Unknown
 *   providers fail loudly.
 * - thinking: `config.gemini.thinkingLevel` (minimal|low|medium|high) is a
 *   subset of prime's `--thinking` levels; passed through verbatim.
 * - system: `config.system` (the agent's SYSTEM.md via `applyAgent`) and
 *   `config.criteria` are APPENDED to prime's base prompt via
 *   `--append-system-prompt` — never `--system-prompt`, which per Prime
 *   0.8.1 `--help` *replaces* the default system prompt. Replacing would
 *   strip prime's base RLM prompt and handicap the prime leg.
 * - context: `LoadedContext` items map to prime `@file` arguments at their
 *   original absolute paths (`BackendRequest.contextRoot` — the same files
 *   the caller named, so path citations stay resolvable). Every arg is the
 *   single `@<abs path>` form Prime 0.8.1's parser turns into fileArgs
 *   (contents inlined into the first user message): a plain path would
 *   instead become a message and spawn one garbage autonomous turn per file.
 *   Each mapped file's existence is pre-checked at spawn, so a missing
 *   @file — which prime answers with a hard `process.exit(1)` — surfaces as
 *   an actionable tool error before any child starts. A `dict` context
 *   throws.
 * - budget.maxCost / maxTokens: mikro-owned ceilings monitored from the
 *   assistant messages' usage records, mirroring `BudgetTracker`
 *   (`src/budget.ts`): totalCost ≥ maxCost → "max-cost", input+output
 *   tokens ≥ maxTokens → "max-tokens". A breach kills the subprocess AND its
 *   descendants and returns a normal result with the partial answer and
 *   `budgetHit` set — never a throw, matching legacy's non-throwing aborts.
 * - maxIterations (spec budget/shape): prime has no iteration concept, so
 *   the cap maps to a turn ceiling — when the (cap+1)th turn would start,
 *   the tree is killed and the run returns the last completed turn's answer
 *   with `budgetHit: "max-iterations"`. Documented deviation: legacy's loop
 *   bound ends gracefully with no budget note; prime has no stop signal
 *   other than the kill, so the truncation is marked in the footer.
 *   `isFailedRun` still classifies it as a success, matching legacy.
 * - deadline: an mikro-owned wall clock defaulting to rlmLoop's 300s and
 *   overridable with `MIKRO_MCP_RUN_TIMEOUT_MS` — the same override the
 *   legacy backend forwards to its engine. Expiry kills the tree and
 *   returns `TIMEOUT_ANSWER`, which `isFailedRun` classifies as failed,
 *   exactly like legacy's timeout.
 *
 * ## Loudly rejected (no silent degradation)
 * - `config.tools` (TOOLS.md REPL functions): Python REPL functions prime's
 *   environment does not have.
 * - `budget.maxDepth`: legacy enforces depth at sub-call time; the parent's
 *   prime stream carries no child-depth signal to enforce from.
 * - `output.schema`: prime has no structured-output flag.
 * - gemini feature flags (googleSearch, urlContext, codeExecution,
 *   computerUse, mapsGrounding, fileSearch, mediaResolution): mikro-side
 *   request decoration prime cannot replicate.
 * - `context` of type `dict`.
 *
 * `config.cache` / `storage` are deliberately NOT rejected: they are
 * already inert on the legacy MCP path (rlmLoop runs with cache and storage
 * mode off), so rejecting them here would make prime stricter than the
 * reference backend.
 *
 * ## Inherent subprocess boundary (not mapped; noted for Group 3)
 * - sub-call model: legacy re-pins sub-calls to the agent's model; prime's
 *   recursive children run on prime's own defaults — the CLI has no flag
 *   for it.
 * - child usage: legacy merges sub-call usage into the footer totals; the
 *   prime parent stream carries only its own turns' usage.
 */
import type { Microagent } from "../agents.js";
import type { BackendRequest, MicroagentResult, RuntimeBackend } from "../backend.js";
/** The exact prime-agent release both subprocess and SDK integrations target. */
export declare const EXPECTED_PRIME_VERSION = "0.8.1";
/** rlmLoop's default wall-clock cap, mirrored so the deadline default matches legacy. */
export declare const DEFAULT_PRIME_DEADLINE_MS = 300000;
/** Budgets the backend enforces on the spawned run, from the request. */
export interface PrimeRunLimits {
    /** mikro-owned wall-clock deadline; expiry kills the tree and returns TIMEOUT_ANSWER. */
    readonly deadlineMs: number;
    /** Cost ceiling from `budget.max_cost` (null = unlimited). */
    readonly maxCost: number | null;
    /** Token ceiling from `budget.max_tokens` (null = unlimited; input+output, like BudgetTracker). */
    readonly maxTokens: number | null;
    /** Turn ceiling from the spec's iteration cap (null = unlimited). */
    readonly maxTurns: number | null;
}
/** What the spawn engine hands back — the raw material of one turn. */
export interface PrimeRunResult {
    readonly answer: string;
    /** Completed prime turns — the backend reports this as `iterations`. */
    readonly turns: number;
    /** "max-cost" | "max-tokens" | "max-iterations" | null. */
    readonly budgetHit: string | null;
    readonly usage: {
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly totalCost: number;
    };
}
/**
 * The spawn seam: run one argv line to completion (or to a designed kill)
 * and hand back the raw result. In production this is `spawnPrimeRun`; tests
 * inject a scripted engine (the contract harness) or drive the real spawner
 * through a stub binary (`tests/prime-backend.test.ts`).
 */
export type PrimeEngine = (argv: readonly string[], emit: (message: string) => void, limits: PrimeRunLimits) => Promise<PrimeRunResult>;
export interface PrimeBackendOptions {
    /** Path to the prime-agent binary (default: `MIKRO_PRIME_BINARY_PATH` or "prime-agent"). */
    readonly binaryPath?: string;
    /** Pinned version to assert at construction (default: EXPECTED_PRIME_VERSION). */
    readonly expectedVersion?: string;
    /** Test seam: replaces the real spawn engine and skips the version check. */
    readonly engine?: PrimeEngine;
    /** Test seam: overrides production's least-privilege child environment builder. */
    readonly environment?: (source: NodeJS.ProcessEnv, provider: string) => NodeJS.ProcessEnv;
}
/** Build the least-privilege environment handed to the Prime subprocess. */
export declare function buildPrimeChildEnv(source: NodeJS.ProcessEnv, provider: string): NodeJS.ProcessEnv;
export declare class PrimeBackend implements RuntimeBackend {
    private readonly binaryPath;
    private readonly engine;
    constructor(options?: PrimeBackendOptions);
    run(agent: Microagent | undefined, request: BackendRequest, emit: (message: string) => void): Promise<MicroagentResult>;
}
//# sourceMappingURL=prime.d.ts.map