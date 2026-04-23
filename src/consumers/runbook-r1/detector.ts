/**
 * R1 detector — pure logic for the scheduler→team-lead mailbox-recursion rule.
 *
 * Maintains a 10-minute sliding window of `mailbox.delivery` rows whose
 * (from, to) matches the recursion signature. Fires once when the window
 * count crosses the threshold and again only after a configurable cool-down
 * (idempotency window) so a sustained pathology does not flood
 * `runbook.triggered` events.
 *
 * Wish: genie-serve-structured-observability, Group 7 deliverable #4.
 */

export interface DetectorOptions {
  /** Sliding window length in milliseconds (default 10 minutes). */
  windowMs?: number;
  /** Threshold above which the rule fires (default 50, exclusive). */
  threshold?: number;
  /** Cool-down between consecutive fires for the same rule (default 60s). */
  idempotencyMs?: number;
  /** Sender role to match (default 'scheduler'). */
  fromRole?: string;
  /** Recipient role to match (default 'team-lead'). */
  toRole?: string;
}

interface SeenEvent {
  createdAt: number;
  trace_id?: string | null;
}

export interface DetectorFinding {
  rule: 'R1';
  evidence_count: number;
  /** Correlation id seeded from the most recent matching event's trace_id. */
  correlation_id?: string;
  /** SQL the operator should run to drain the recursion (NOT executed). */
  recommended_sql: string;
  /** Earliest matching event's timestamp inside the window. */
  window_start_ms: number;
  /** Latest matching event's timestamp inside the window. */
  window_end_ms: number;
}

export interface MailboxDeliveryEvent {
  /** When the event was emitted (epoch ms). */
  createdAt: number;
  from: string;
  to: string;
  /** Optional: trace correlation id for the emitted finding. */
  trace_id?: string | null;
}

export class R1Detector {
  private readonly windowMs: number;
  private readonly threshold: number;
  private readonly idempotencyMs: number;
  private readonly fromRole: string;
  private readonly toRole: string;
  private readonly window: SeenEvent[] = [];
  private lastFiredAt = 0;

  constructor(opts: DetectorOptions = {}) {
    this.windowMs = opts.windowMs ?? 10 * 60_000;
    this.threshold = opts.threshold ?? 50;
    this.idempotencyMs = opts.idempotencyMs ?? 60_000;
    this.fromRole = opts.fromRole ?? 'scheduler';
    this.toRole = opts.toRole ?? 'team-lead';
  }

  /**
   * Register a mailbox.delivery event and return a finding if the rule fires.
   * Returns null when below threshold or inside the idempotency cool-down.
   */
  observe(ev: MailboxDeliveryEvent): DetectorFinding | null {
    if (ev.from !== this.fromRole || ev.to !== this.toRole) return null;

    this.evictOlderThan(ev.createdAt - this.windowMs);
    this.window.push({ createdAt: ev.createdAt, trace_id: ev.trace_id ?? null });

    if (this.window.length <= this.threshold) return null;
    if (ev.createdAt - this.lastFiredAt < this.idempotencyMs) return null;

    this.lastFiredAt = ev.createdAt;
    const correlationId = ev.trace_id ?? this.window[this.window.length - 1]?.trace_id ?? undefined;

    return {
      rule: 'R1',
      evidence_count: this.window.length,
      correlation_id: correlationId ?? undefined,
      recommended_sql: `DELETE FROM mailbox WHERE to_worker='${this.toRole}' AND from_worker='${this.fromRole}';`,
      window_start_ms: this.window[0].createdAt,
      window_end_ms: this.window[this.window.length - 1].createdAt,
    };
  }

  /** Drop window entries older than `cutoffMs`. */
  private evictOlderThan(cutoffMs: number): void {
    while (this.window.length > 0 && this.window[0].createdAt < cutoffMs) {
      this.window.shift();
    }
  }

  /** Useful for tests — returns the current sliding-window depth. */
  getWindowDepth(): number {
    return this.window.length;
  }

  /** Useful for tests — resets the cool-down so the next observe() can fire. */
  __resetIdempotencyForTests(): void {
    this.lastFiredAt = 0;
  }
}
