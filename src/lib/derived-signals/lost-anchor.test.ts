/**
 * Tests for `LostAnchorDetector`.
 *
 * Window/threshold semantics: ≥ 3 `resume.missing_session` events for one
 * agent within 5 min should fire once; subsequent events inside the same
 * window should suppress; once the window slides clean, a fresh storm
 * fires again.
 */

import { describe, expect, test } from 'bun:test';
import type { AuditEventRow } from '../audit.js';
import { LostAnchorDetector } from './lost-anchor.js';

function event(agentId: string, isoMs: number): AuditEventRow {
  return {
    id: isoMs,
    entity_type: 'agent',
    entity_id: agentId,
    event_type: 'resume.missing_session',
    actor: 'executor-registry',
    details: { reason: 'no_executor' },
    created_at: new Date(isoMs).toISOString(),
  };
}

describe('LostAnchorDetector', () => {
  test('two events in window → no signal (under threshold)', () => {
    const det = new LostAnchorDetector();
    expect(det.ingest(event('agent-1', 1000), 1500)).toBeNull();
    expect(det.ingest(event('agent-1', 1200), 1500)).toBeNull();
  });

  test('three events in window → fires once', () => {
    const det = new LostAnchorDetector();
    det.ingest(event('agent-1', 1000), 1500);
    det.ingest(event('agent-1', 1100), 1500);
    const sig = det.ingest(event('agent-1', 1200), 1500);
    expect(sig?.type).toBe('resume.lost_anchor');
    expect(sig?.subject).toBe('agent-1');
    expect(sig?.severity).toBe('warn');
    expect(sig?.details.events_in_window).toBe(3);
  });

  test('fourth event inside same window → suppressed', () => {
    const det = new LostAnchorDetector();
    det.ingest(event('agent-1', 1000), 1500);
    det.ingest(event('agent-1', 1100), 1500);
    det.ingest(event('agent-1', 1200), 1500);
    const dup = det.ingest(event('agent-1', 1300), 1500);
    expect(dup).toBeNull();
  });

  test('window slides clean → second storm re-fires', () => {
    const det = new LostAnchorDetector();
    const minute = 60_000;
    det.ingest(event('agent-1', 0), minute);
    det.ingest(event('agent-1', minute), 2 * minute);
    det.ingest(event('agent-1', 2 * minute), 3 * minute);
    // Far in the future — original window has slid clean.
    const farFuture = 30 * minute;
    det.ingest(event('agent-1', farFuture), farFuture);
    det.ingest(event('agent-1', farFuture + 100), farFuture + 100);
    const sig = det.ingest(event('agent-1', farFuture + 200), farFuture + 200);
    expect(sig?.type).toBe('resume.lost_anchor');
  });

  test('two agents in lockstep — both fire independently', () => {
    const det = new LostAnchorDetector();
    det.ingest(event('agent-A', 1000), 1500);
    det.ingest(event('agent-B', 1000), 1500);
    det.ingest(event('agent-A', 1100), 1500);
    det.ingest(event('agent-B', 1100), 1500);
    const a = det.ingest(event('agent-A', 1200), 1500);
    const b = det.ingest(event('agent-B', 1200), 1500);
    expect(a?.subject).toBe('agent-A');
    expect(b?.subject).toBe('agent-B');
  });

  test('non-agent entity → ignored', () => {
    const det = new LostAnchorDetector();
    const row = event('agent-1', 1000);
    row.entity_type = 'worker';
    expect(det.ingest(row, 1500)).toBeNull();
  });

  test('different event type → ignored', () => {
    const det = new LostAnchorDetector();
    const row = event('agent-1', 1000);
    row.event_type = 'state_changed';
    expect(det.ingest(row, 1500)).toBeNull();
  });

  test('reset() clears in-memory state', () => {
    const det = new LostAnchorDetector();
    det.ingest(event('agent-1', 1000), 1500);
    det.ingest(event('agent-1', 1100), 1500);
    det.reset();
    // Without reset, this would have been the threshold-crossing event;
    // after reset, only one event sits in the ring so no signal fires.
    expect(det.ingest(event('agent-1', 1200), 1500)).toBeNull();
  });
});
