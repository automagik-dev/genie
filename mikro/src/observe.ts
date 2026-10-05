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

export class ObservabilityRecorder {
  private storage: PgStorage;
  private sessionId: string | null = null;
  /**
   * Serialization queue for pg client calls. ObservabilityRecorder uses a
   * single shared pg.Client (not a Pool), and pg@>=8 crashes the connection
   * when queries overlap. We chain every write through this tail so they
   * execute strictly in order regardless of how fast callers fire them.
   */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(storage: PgStorage) {
    this.storage = storage;
  }

  /**
   * Create a new session record.
   */
  startSession(
    runId: string,
    query: string,
    model: string,
    provider: string,
    contextPath?: string,
    config?: Record<string, unknown>
  ): void {
    this.sessionId = runId;
    this.fire(async () => {
      const client = this.storage.getClient();
      if (!client) return;
      await client.query(
        `INSERT INTO mikro_sessions (id, query, context_path, model, provider, config)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        [runId, query, contextPath ?? null, model, provider, config ? JSON.stringify(config) : null]
      );
    });
  }

  /**
   * Record an LLM call event.
   *
   * Snapshots `this.sessionId` synchronously so a subsequent
   * `startSession()` (for the next run) doesn't hijack the INSERT when
   * the queued callback eventually executes.
   */
  recordLLMCall(
    iteration: number,
    usage: LLMCallUsage,
    model: string,
    durationMs: number
  ): void {
    const capturedSessionId = this.sessionId;
    this.fire(async () => {
      const client = this.storage.getClient();
      if (!client || !capturedSessionId) return;
      await client.query(
        `INSERT INTO mikro_events (session_id, iteration, kind, input_tokens, output_tokens, cost, model, duration_ms)
         VALUES ($1, $2, 'llm_call', $3, $4, $5, $6, $7)`,
        [capturedSessionId, iteration, usage.inputTokens, usage.outputTokens, usage.cost, model, durationMs]
      );
    });
  }

  /**
   * Record a REPL execution event.
   *
   * Snapshots `this.sessionId` synchronously (see recordLLMCall).
   */
  recordReplExec(
    iteration: number,
    code: string,
    stdout: string,
    stderr: string,
    durationMs: number,
    isError?: boolean
  ): void {
    const capturedSessionId = this.sessionId;
    this.fire(async () => {
      const client = this.storage.getClient();
      if (!client || !capturedSessionId) return;
      await client.query(
        `INSERT INTO mikro_events (session_id, iteration, kind, code, stdout, stderr, duration_ms, is_error, error_message)
         VALUES ($1, $2, 'repl_exec', $3, $4, $5, $6, $7, $8)`,
        [
          capturedSessionId, iteration,
          code.slice(0, 10000), stdout.slice(0, 10000), stderr.slice(0, 5000),
          durationMs, isError ?? false, isError ? stderr.slice(0, 1000) : null,
        ]
      );
    });
  }

  /**
   * Record a sub-call event (pg_search, llm_query from REPL, etc.).
   *
   * Snapshots `this.sessionId` synchronously (see recordLLMCall).
   */
  recordSubCall(
    iteration: number,
    requestType: string,
    promptPreview: string,
    durationMs: number,
    isError?: boolean,
    errorMessage?: string
  ): void {
    const capturedSessionId = this.sessionId;
    this.fire(async () => {
      const client = this.storage.getClient();
      if (!client || !capturedSessionId) return;
      await client.query(
        `INSERT INTO mikro_events (session_id, iteration, kind, request_type, prompt_preview, duration_ms, is_error, error_message)
         VALUES ($1, $2, 'sub_call', $3, $4, $5, $6, $7)`,
        [
          capturedSessionId, iteration,
          requestType, promptPreview.slice(0, 500),
          durationMs, isError ?? false, errorMessage?.slice(0, 1000) ?? null,
        ]
      );
    });
  }

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
  recordFinal(
    answer: string,
    iterations: number,
    totalUsage: TotalUsage
  ): void {
    const capturedSessionId = this.sessionId;
    this.fire(async () => {
      const client = this.storage.getClient();
      if (!client || !capturedSessionId) return;
      await client.query(
        `UPDATE mikro_sessions SET
           status = 'completed',
           ended_at = now(),
           iterations = $2,
           input_tokens = $3,
           output_tokens = $4,
           cached_tokens = $5,
           total_cost = $6,
           answer_length = $7
         WHERE id = $1`,
        [
          capturedSessionId, iterations,
          totalUsage.inputTokens, totalUsage.outputTokens,
          totalUsage.cachedTokens ?? 0, totalUsage.totalCost,
          answer.length,
        ]
      );
    });
  }

  /**
   * Record session failure.
   *
   * Snapshots `this.sessionId` synchronously (see recordFinal).
   */
  recordError(errorMessage: string): void {
    const capturedSessionId = this.sessionId;
    this.fire(async () => {
      const client = this.storage.getClient();
      if (!client || !capturedSessionId) return;
      await client.query(
        `UPDATE mikro_sessions SET status = 'failed', ended_at = now(), budget_hit = $2 WHERE id = $1`,
        [capturedSessionId, errorMessage.slice(0, 500)]
      );
    });
  }

  /**
   * Fire-and-forget: enqueue an async operation onto the write queue so
   * the shared pg.Client processes one write at a time. Errors are
   * logged to stderr but never thrown and never abort the chain.
   */
  private fire(fn: () => Promise<void>): void {
    this.writeQueue = this.writeQueue.then(fn).catch((err) => {
      process.stderr.write(
        `mikro: observability recording error: ${err instanceof Error ? err.message : String(err)}\n`
      );
    });
  }

  /**
   * Wait for all pending observability writes to flush. Callers should
   * await this before closing the session / shutting down pgserve so the
   * final recordings make it to disk.
   */
  async flush(): Promise<void> {
    await this.writeQueue;
  }
}
