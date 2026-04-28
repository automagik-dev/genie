/**
 * Rule: `agents.zombie_storm`.
 *
 * Detects `state_changed reason=dead_pane_zombie` rate > 5/hour.
 * Sustained dead-pane zombies usually mean a tmux server crashed, a
 * watchdog mis-fired, or the host reaper ran amok — none of which the
 * scheduler can self-heal.
 *
 * Implementation matches `LostAnchorDetector` — ring buffer of recent
 * timestamps, slides forward as new events arrive, fires once per
 * threshold crossing per window.
 */

import type { AuditEventRow } from '../audit.js';
import type { DerivedSignal } from './types.js';
import { SIGNAL_SEVERITY } from './types.js';

const WINDOW_MS = 60 * 60 * 1000;
const THRESHOLD = 5;

export class ZombieStormDetector {
  private readonly window: number[] = [];
  private lastFired: number | null = null;

  ingest(row: AuditEventRow, now: number = Date.now()): DerivedSignal | null {
    if (row.entity_type !== 'worker') return null;
    if (row.event_type !== 'state_changed') return null;
    if (row.details?.reason !== 'dead_pane_zombie') return null;

    const ts = Date.parse(row.created_at);
    if (!Number.isFinite(ts)) return null;

    const cutoff = now - WINDOW_MS;
    // Drop stale entries in-place to keep the ring bounded.
    while (this.window.length > 0 && this.window[0] < cutoff) {
      this.window.shift();
    }
    this.window.push(ts);

    if (this.window.length <= THRESHOLD) return null;

    if (this.lastFired !== null && this.lastFired >= cutoff) {
      // Already fired this hour — suppress.
      return null;
    }
    this.lastFired = now;

    return {
      type: 'agents.zombie_storm',
      subject: 'global',
      severity: SIGNAL_SEVERITY['agents.zombie_storm'],
      details: {
        window_ms: WINDOW_MS,
        threshold: THRESHOLD,
        zombies_in_window: this.window.length,
        latest_agent: row.entity_id,
      },
      triggeredAt: row.created_at,
    };
  }

  reset(): void {
    this.window.length = 0;
    this.lastFired = null;
  }
}
