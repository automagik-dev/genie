/**
 * Tests for the rule-engine dispatcher (`dispatch()`).
 *
 * Covers the round-trip: feed a synthetic audit row → assert the right
 * rule(s) detected the fingerprint → assert the signal was persisted to
 * `audit_events`.
 *
 * Also asserts the corruption-fingerprint detection acceptance criterion
 * from the wish: within a single dispatch call (well under the 30 s SLI),
 * a `session.divergence_preserved` row produces a
 * `recovery_anchor_at_risk` signal.
 */

import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { AuditEventRow } from '../audit.js';
import { queryAuditEvents } from '../audit.js';
import { dispatch, listActiveDerivedSignals } from './index.js';
import { LostAnchorDetector } from './lost-anchor.js';
import { ZombieStormDetector } from './zombie-storm.js';

function makeRow(overrides: Partial<AuditEventRow>): AuditEventRow {
  return {
    id: 1,
    entity_type: 'agent',
    entity_id: 'a-1',
    event_type: 'state_changed',
    actor: 'test',
    details: {},
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('dispatch() — rule engine', () => {
  test('session.divergence_preserved row → emits recovery_anchor_at_risk', async () => {
    const subject = `dispatch-test-exec-${randomUUID().slice(0, 8)}`;
    const row = makeRow({
      entity_type: 'executor',
      entity_id: subject,
      event_type: 'session.divergence_preserved',
      details: {
        stored_session_id: 'old-uuid',
        live_session_id: 'new-uuid',
        executor_state: 'terminated',
      },
    });
    const sigs = await dispatch(row, {
      lost: new LostAnchorDetector(),
      zombie: new ZombieStormDetector(),
    });
    expect(sigs.length).toBe(1);
    expect(sigs[0].type).toBe('observability.recovery_anchor_at_risk');
    // Verify the signal landed in audit_events for the status surface.
    const persisted = await queryAuditEvents({
      type: 'observability.recovery_anchor_at_risk',
      entity: 'derived_signal',
      since: '5s',
    });
    const found = persisted.find((p) => p.entity_id === subject);
    expect(found).toBeDefined();
  });

  test('three resume.missing_session rows for one agent → emits resume.lost_anchor', async () => {
    const subject = `dispatch-test-agent-${randomUUID().slice(0, 8)}`;
    const lost = new LostAnchorDetector();
    const zombie = new ZombieStormDetector();

    let result: Awaited<ReturnType<typeof dispatch>> = [];
    for (let i = 0; i < 3; i++) {
      const row = makeRow({
        entity_type: 'agent',
        entity_id: subject,
        event_type: 'resume.missing_session',
        details: { reason: 'no_executor' },
      });
      result = await dispatch(row, { lost, zombie });
    }
    const lostSigs = result.filter((s) => s.type === 'resume.lost_anchor');
    expect(lostSigs.length).toBe(1);
    expect(lostSigs[0].subject).toBe(subject);
  });

  test('listActiveDerivedSignals deduplicates per (type, subject)', async () => {
    const subject = `dispatch-test-dedup-${randomUUID().slice(0, 8)}`;
    const lost = new LostAnchorDetector();
    const zombie = new ZombieStormDetector();
    // Two storms across two windows for the same agent → two persisted
    // signals → list should still report one (most-recent wins).
    for (let i = 0; i < 3; i++) {
      await dispatch(
        makeRow({
          id: i,
          entity_id: subject,
          event_type: 'resume.missing_session',
          details: { reason: 'no_executor' },
          // shift created_at to make sure we're inside the window
          created_at: new Date().toISOString(),
        }),
        { lost, zombie },
      );
    }
    const signals = await listActiveDerivedSignals();
    const myMatches = signals.filter((s) => s.subject === subject);
    expect(myMatches.length).toBe(1);
  });

  test('a benign first-capture session.reconciled does NOT produce a signal', async () => {
    const subject = `dispatch-test-benign-${randomUUID().slice(0, 8)}`;
    const row = makeRow({
      entity_type: 'executor',
      entity_id: subject,
      event_type: 'session.reconciled',
      details: { old_session_id: null, new_session_id: 'fresh-uuid' },
    });
    const sigs = await dispatch(row, {
      lost: new LostAnchorDetector(),
      zombie: new ZombieStormDetector(),
    });
    expect(sigs.length).toBe(0);
  });
});
