/**
 * Rule: `resume.lost_anchor`.
 *
 * Detects ≥3 `resume.missing_session` events for a single agent within a
 * sliding 5-minute window. The chokepoint can't find a session UUID for
 * that agent — it's stuck. Operator can either run `genie agent resume
 * <name>` to retry or pause / archive the row.
 *
 * Implementation note: this rule maintains a small in-memory ring of
 * recent timestamps per agent. The window is 5 min; rings are evicted
 * lazily as new events arrive. Worst case memory: O(N agents × 3
 * timestamps); with the existing scheduler concurrency cap of ~100
 * agents that's ~2.4 KB — negligible.
 */

import type { AuditEventRow } from '../audit.js';
import type { DerivedSignal } from './types.js';
import { SIGNAL_SEVERITY } from './types.js';

const WINDOW_MS = 5 * 60 * 1000;
const THRESHOLD = 3;

/**
 * Per-rule state. Exported as a class so callers can instantiate one
 * detector per subscriber (the engine uses one shared instance, tests
 * spin up isolated ones).
 */
export class LostAnchorDetector {
  /** Map<agentId, number[] of recent ISO ms timestamps>. */
  private readonly windows = new Map<string, number[]>();
  /**
   * Map<agentId, last triggered-at ms>. Suppresses duplicate emissions
   * inside the same window — fire once on the threshold crossing, then
   * stay quiet until the window slides clean.
   */
  private readonly lastFired = new Map<string, number>();

  /**
   * Inspect an audit event. Returns a derived signal if the threshold
   * was just crossed for the agent, otherwise null.
   */
  ingest(row: AuditEventRow, now: number = Date.now()): DerivedSignal | null {
    if (row.entity_type !== 'agent') return null;
    if (row.event_type !== 'resume.missing_session') return null;

    const agentId = row.entity_id;
    const ts = Date.parse(row.created_at);
    if (!Number.isFinite(ts)) return null;

    const cutoff = now - WINDOW_MS;
    const ring = this.windows.get(agentId) ?? [];
    const fresh = ring.filter((t) => t >= cutoff);
    fresh.push(ts);
    this.windows.set(agentId, fresh);

    if (fresh.length < THRESHOLD) return null;

    const lastFiredTs = this.lastFired.get(agentId);
    if (lastFiredTs !== undefined && lastFiredTs >= cutoff) {
      // Already fired inside this window — stay quiet until it slides.
      return null;
    }
    this.lastFired.set(agentId, now);

    return {
      type: 'resume.lost_anchor',
      subject: agentId,
      severity: SIGNAL_SEVERITY['resume.lost_anchor'],
      details: {
        window_ms: WINDOW_MS,
        threshold: THRESHOLD,
        events_in_window: fresh.length,
        latest_reason: row.details?.reason ?? null,
      },
      triggeredAt: row.created_at,
    };
  }

  /** Clear all state — used by tests for isolation. */
  reset(): void {
    this.windows.clear();
    this.lastFired.clear();
  }
}
