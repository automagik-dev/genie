/**
 * Core RLM iteration loop.
 *
 * Faithful implementation of the RLM algorithm:
 * - Prompt externalization (context as REPL variable, only metadata in messages)
 * - Python REPL with persistent namespace
 * - Iterative code generation + execution loop
 * - FINAL/FINAL_VAR termination detection
 * - Recursive sub-calls via llm_query/rlm_query
 */
import type { MikroConfig, ValidateConfig } from "./config.js";
import type { LoadedContext } from "./context.js";
import { type ChatMessage } from "./llm.js";
import { type RLMResult } from "./output.js";
import type { Logger } from "./logger.js";
import { type EmitterAndStream } from "./sdk/emitter.js";
import type { ToolResolver } from "./sdk/agent.js";
import { type ValidateResult } from "./sdk/validate.js";
/** `budgetHit` set by the consecutive-empty-response abort. */
export declare const EMPTY_RESPONSES_BUDGET_HIT = "empty_responses";
/** Exact `answer` returned by the wall-clock-timeout abort. */
export declare const TIMEOUT_ANSWER = "Error: RLM query timed out";
/** Options for the RLM loop. */
export interface RLMOptions {
    maxIterations: number;
    /** Provider-level output cap for each root iteration. */
    maxOutputTokens?: number;
    /** Provider transport retries per root iteration. Zero disables retries. */
    maxRetries?: number;
    timeout: number;
    verbose: boolean;
    output: "text" | "json" | "stream";
    cache: boolean;
    /** When true, route context through pgserve storage instead of REPL variable. */
    storageMode?: boolean;
    logger?: Logger;
    /**
     * Live SDK event bus (Wish B live-tui G2). Optional — pass a
     * `createEmitter()` the caller has ALREADY subscribed to so the run's
     * events (AgentStart / Iteration* / ToolCall* / Recurse / child-completion
     * / Session*) stream live from the first emission. When omitted, rlmLoop
     * creates its own internal emitter. This is the contractual seam the
     * headless subscriber and the mikro-acp adapter both consume — the run
     * closes the emitter when it finishes.
     */
    emitter?: EmitterAndStream;
    /** Declared-tool resolver exposed to Python through the REPL bridge. */
    tools?: ToolResolver;
}
/**
 * Add live SDK events and run-scoped cancellation to REPL tool dispatch.
 *
 * The REPL supplies its own signal to a ToolResolver. Declared plugins instead
 * receive the enclosing run's signal so the loop timeout can interrupt them.
 */
export declare function bridgeToolResolver(resolver: ToolResolver, emitter: EmitterAndStream, options: {
    readonly sessionId: string;
    readonly selfTag: {
        readonly correlationId?: string;
        readonly parentRunId?: string;
    };
    readonly signal: AbortSignal;
}): ToolResolver;
/**
 * Build the system prompt from config, tools, criteria, and context metadata.
 */
export declare function buildSystemPrompt(config: MikroConfig, _context: LoadedContext | null, storageRecordCount?: number): string;
/**
 * Strip a FINAL payload down to the text `JSON.parse` should see: trim, then
 * unwrap one enclosing markdown fence.
 *
 * The fence strip exists because models fence JSON reflexively, and a fenced
 * payload is a *formatting* miss, not a shape miss — charging a validate
 * attempt for it would spend the retry budget on punctuation.
 */
export declare function normalizeFinalPayload(answer: string): string;
/**
 * Validate one FINAL payload against the pack's schema.
 *
 * Unparsable text is reported as an ordinary shape failure rather than a
 * thrown error, so it flows through the same retry path as a missing field —
 * and the synthetic message names the actual problem, which for this channel
 * is usually a `FINAL_VAR` of a Python dict (single-quoted `str()` repr).
 */
export declare function validateFinalAnswer(answer: string, validate: ValidateConfig): ValidateResult;
/**
 * What the loop must do with a candidate final answer.
 *
 * Discriminated rather than answer-shaped: a wrapper that could only return
 * a string has no way to say "do not finalize, run one more iteration", and
 * the retry is the whole point.
 */
export type ValidationDecision = {
    readonly kind: "finalize";
    /** True only when the schema was checked and the payload lost. */
    readonly validationFailed: boolean;
    readonly errors: readonly string[];
} | {
    readonly kind: "retry";
    readonly hint: string;
    readonly errors: readonly string[];
};
/** Everything `decideValidatedFinal` needs, stated rather than closed over. */
export interface ValidationGate {
    /** The pack's contract, or null when it ships none (⇒ never flagged). */
    readonly validate: ValidateConfig | null;
    /** Validate attempts spent INCLUDING this one (1 on the first check). */
    readonly attempt: number;
    /** False at the forced-final site: validate and flag, but never retry. */
    readonly retryCapable: boolean;
    /**
     * True when another iteration is actually available — the caller mirrors
     * the loop's own top-of-loop tests (iteration budget, wall-clock abort,
     * cost/token budget) so a granted retry can never hang or silently become
     * the forced-final path.
     */
    readonly roomForRetry: boolean;
}
/**
 * The single place the validate/retry/flag policy is decided. Every finalize
 * site branches on the result; none of them re-derives it.
 */
export declare function decideValidatedFinal(answer: string, gate: ValidationGate): ValidationDecision;
/**
 * Give the granted retry its user turn.
 *
 * Merged into a trailing user message when there is one — exactly the move
 * the soft-limit nudge below makes — so the history stays strictly
 * alternating. The alternative, a second consecutive user message, is a
 * shape some providers reject outright.
 */
export declare function appendValidationRetryTurn(messages: ChatMessage[], hint: string): void;
/**
 * Main RLM loop entry point.
 */
export declare function rlmLoop(query: string, context: LoadedContext | null, config: MikroConfig, options?: Partial<RLMOptions>): Promise<RLMResult>;
//# sourceMappingURL=rlm.d.ts.map