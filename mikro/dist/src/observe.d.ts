/**
 * ObservabilityRecorder — fire-and-forget event recording to pgserve.
 *
 * Records every LLM call, REPL execution, and sub-call into mikro_sessions
 * and mikro_events tables. All methods are fire-and-forget: errors are logged
 * to stderr but never thrown or block the main RLM loop.
 */
import type { PgStorage } from "./storage.js";
/** Usage info for recording an LLM call. */
export interface LLMCallUsage {
    inputTokens: number;
    outputTokens: number;
    cost: number;
}
/** Total usage for recording session completion. */
export interface TotalUsage {
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
    totalCost: number;
}
export declare class ObservabilityRecorder {
    private storage;
    private sessionId;
    /**
     * Serialization queue for pg client calls. ObservabilityRecorder uses a
     * single shared pg.Client (not a Pool), and pg@>=8 crashes the connection
     * when queries overlap. We chain every write through this tail so they
     * execute strictly in order regardless of how fast callers fire them.
     */
    private writeQueue;
    constructor(storage: PgStorage);
    /**
     * Create a new session record.
     */
    startSession(runId: string, query: string, model: string, provider: string, contextPath?: string, config?: Record<string, unknown>): void;
    /**
     * Record an LLM call event.
     *
     * Snapshots `this.sessionId` synchronously so a subsequent
     * `startSession()` (for the next run) doesn't hijack the INSERT when
     * the queued callback eventually executes.
     */
    recordLLMCall(iteration: number, usage: LLMCallUsage, model: string, durationMs: number): void;
    /**
     * Record a REPL execution event.
     *
     * Snapshots `this.sessionId` synchronously (see recordLLMCall).
     */
    recordReplExec(iteration: number, code: string, stdout: string, stderr: string, durationMs: number, isError?: boolean): void;
    /**
     * Record a sub-call event (pg_search, llm_query from REPL, etc.).
     *
     * Snapshots `this.sessionId` synchronously (see recordLLMCall).
     */
    recordSubCall(iteration: number, requestType: string, promptPreview: string, durationMs: number, isError?: boolean, errorMessage?: string): void;
    /**
     * Record session completion with final answer and totals.
     *
     * Snapshots `this.sessionId` synchronously so the UPDATE targets the
     * right row even if another `startSession()` has fired before the
     * queued callback executes. Without this snapshot, running multiple
     * agents in sequence caused every recordFinal to UPDATE the most
     * recently-started session, leaving all earlier sessions stuck in
     * status='running'.
     */
    recordFinal(answer: string, iterations: number, totalUsage: TotalUsage): void;
    /**
     * Record session failure.
     *
     * Snapshots `this.sessionId` synchronously (see recordFinal).
     */
    recordError(errorMessage: string): void;
    /**
     * Fire-and-forget: enqueue an async operation onto the write queue so
     * the shared pg.Client processes one write at a time. Errors are
     * logged to stderr but never thrown and never abort the chain.
     */
    private fire;
    /**
     * Wait for all pending observability writes to flush. Callers should
     * await this before closing the session / shutting down pgserve so the
     * final recordings make it to disk.
     */
    flush(): Promise<void>;
}
//# sourceMappingURL=observe.d.ts.map