/**
 * OmniQueue — PG-backed request queue for SDK executor.
 *
 * Guarantees zero message loss: inbound NATS messages are persisted to PG
 * before acknowledgement, then processed by a poll-based worker loop.
 *
 * Features:
 *   - Durable persistence (survives bridge restart)
 *   - Claim-based concurrency (FOR UPDATE SKIP LOCKED)
 *   - Per-agent rate limiting (configurable requests/minute)
 *   - Exponential backoff retry (max 3 attempts)
 *   - Recovery of stale processing rows on restart
 */

import type { Sql } from '../lib/db.js';
import type { OmniMessage } from './executor.js';

// ============================================================================
// Types
// ============================================================================

export interface QueueConfig {
  /** Max requests per minute per agent. Default: 60. */
  maxPerMinute?: number;
  /** Poll interval in ms. Default: 1000. */
  pollIntervalMs?: number;
  /** Max concurrent processing. Default: 5. */
  maxConcurrent?: number;
  /** Stale processing timeout in ms. Default: 5 minutes. */
  staleTimeoutMs?: number;
}

export interface QueueStats {
  pending: number;
  processing: number;
  done: number;
  failed: number;
}

export interface QueuedRequest {
  id: string;
  agent: string;
  chatId: string;
  instanceId: string;
  content: string;
  sender: string;
  env: Record<string, string>;
  attempts: number;
  maxAttempts: number;
}

/** Callback invoked for each claimed request. @public */
export type RequestHandler = (request: QueuedRequest, message: OmniMessage) => Promise<void>;

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MAX_PER_MINUTE = 60;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_CONCURRENT = 5;
const DEFAULT_STALE_TIMEOUT_MS = 5 * 60 * 1000;

/** Backoff base for retries: 2^attempt * BASE_MS. */
const BACKOFF_BASE_MS = 5_000;

// ============================================================================
// Queue Manager
// ============================================================================

export class OmniQueue {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private processing = 0;
  private stopped = false;

  readonly maxPerMinute: number;
  readonly pollIntervalMs: number;
  readonly maxConcurrent: number;
  readonly staleTimeoutMs: number;

  constructor(
    private readonly sql: Sql,
    private readonly handler: RequestHandler,
    config: QueueConfig = {},
  ) {
    this.maxPerMinute = config.maxPerMinute ?? DEFAULT_MAX_PER_MINUTE;
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxConcurrent = config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.staleTimeoutMs = config.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;
  }

  // ==========================================================================
  // Enqueue
  // ==========================================================================

  /**
   * Persist an inbound message to the queue. Returns the request ID.
   * This is the durable write — once this returns, the message survives restarts.
   */
  async enqueue(message: OmniMessage, env: Record<string, string> = {}): Promise<string> {
    const envJson = JSON.stringify(env);
    const rows = await this.sql<{ id: string }[]>`
      INSERT INTO omni_requests (agent, chat_id, instance_id, content, sender, env)
      VALUES (${message.agent}, ${message.chatId}, ${message.instanceId}, ${message.content}, ${message.sender}, ${envJson}::jsonb)
      RETURNING id
    `;
    return rows[0].id;
  }

  // ==========================================================================
  // Worker loop
  // ==========================================================================

  /** Start the poll-based worker loop. */
  start(): void {
    if (this.pollTimer) return;
    this.stopped = false;
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
    // Immediate first poll
    this.poll();
    console.log(
      `[omni-queue] Started (poll=${this.pollIntervalMs}ms, max_concurrent=${this.maxConcurrent}, rate=${this.maxPerMinute}/min)`,
    );
  }

  /** Stop the worker loop. In-flight processing continues to completion. */
  stop(): void {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    console.log('[omni-queue] Stopped');
  }

  /** Recover stale processing rows from a previous crash. */
  async recoverStale(): Promise<number> {
    const staleThreshold = new Date(Date.now() - this.staleTimeoutMs).toISOString();
    const rows = await this.sql<{ id: string }[]>`
      UPDATE omni_requests
      SET status = 'pending', started_at = NULL
      WHERE status = 'processing' AND started_at < ${staleThreshold}
      RETURNING id
    `;
    if (rows.length > 0) {
      console.log(`[omni-queue] Recovered ${rows.length} stale request(s)`);
    }
    return rows.length;
  }

  // ==========================================================================
  // Stats
  // ==========================================================================

  async stats(): Promise<QueueStats> {
    const rows = await this.sql<{ status: string; count: string }[]>`
      SELECT status, count(*)::text as count
      FROM omni_requests
      GROUP BY status
    `;
    const result: QueueStats = { pending: 0, processing: 0, done: 0, failed: 0 };
    for (const row of rows) {
      if (row.status in result) {
        result[row.status as keyof QueueStats] = Number(row.count);
      }
    }
    return result;
  }

  // ==========================================================================
  // Internal
  // ==========================================================================

  private async poll(): Promise<void> {
    if (this.stopped) return;
    if (this.processing >= this.maxConcurrent) return;

    try {
      const claimed = await this.claimNext();
      if (!claimed) return;

      this.processing++;
      // Fire-and-forget — don't block the poll loop
      this.processRequest(claimed).finally(() => {
        this.processing--;
      });
    } catch (err) {
      console.warn('[omni-queue] Poll error:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Claim the next pending request using FOR UPDATE SKIP LOCKED.
   * Respects per-agent rate limits by checking recent completions.
   */
  private async claimNext(): Promise<QueuedRequest | null> {
    const rows = await this.sql<
      {
        id: string;
        agent: string;
        chat_id: string;
        instance_id: string;
        content: string;
        sender: string;
        env: Record<string, string>;
        attempts: number;
        max_attempts: number;
      }[]
    >`
      UPDATE omni_requests
      SET status = 'processing', started_at = now(), attempts = attempts + 1
      WHERE id = (
        SELECT r.id FROM omni_requests r
        WHERE r.status = 'pending'
          AND (r.next_retry_at IS NULL OR r.next_retry_at <= now())
          AND (
            SELECT count(*) FROM omni_requests c
            WHERE c.agent = r.agent
              AND c.status = 'done'
              AND c.completed_at > now() - interval '1 minute'
          ) < ${this.maxPerMinute}
        ORDER BY r.created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, agent, chat_id, instance_id, content, sender, env, attempts, max_attempts
    `;

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      id: row.id,
      agent: row.agent,
      chatId: row.chat_id,
      instanceId: row.instance_id,
      content: row.content,
      sender: row.sender,
      env: typeof row.env === 'string' ? JSON.parse(row.env) : (row.env ?? {}),
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
    };
  }

  private async processRequest(request: QueuedRequest): Promise<void> {
    const message: OmniMessage = {
      content: request.content,
      sender: request.sender,
      instanceId: request.instanceId,
      chatId: request.chatId,
      agent: request.agent,
    };

    try {
      await this.handler(request, message);
      await this.markDone(request.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[omni-queue] Request ${request.id} failed (attempt ${request.attempts}/${request.maxAttempts}): ${msg}`,
      );

      if (request.attempts >= request.maxAttempts) {
        await this.markFailed(request.id);
      } else {
        await this.markRetry(request.id, request.attempts);
      }
    }
  }

  private async markDone(id: string): Promise<void> {
    await this.sql`
      UPDATE omni_requests
      SET status = 'done', completed_at = now()
      WHERE id = ${id}
    `;
  }

  private async markFailed(id: string): Promise<void> {
    await this.sql`
      UPDATE omni_requests
      SET status = 'failed', completed_at = now()
      WHERE id = ${id}
    `;
  }

  private async markRetry(id: string, attempt: number): Promise<void> {
    const backoffMs = BACKOFF_BASE_MS * 2 ** (attempt - 1);
    const nextRetry = new Date(Date.now() + backoffMs).toISOString();
    await this.sql`
      UPDATE omni_requests
      SET status = 'pending', started_at = NULL, next_retry_at = ${nextRetry}
      WHERE id = ${id}
    `;
  }
}
