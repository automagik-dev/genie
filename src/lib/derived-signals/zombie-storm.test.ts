/**
 * Tests for `ZombieStormDetector`.
 *
 * Same shape as LostAnchorDetector but global (one ring buffer for all
 * agents) and a different threshold/window (5/hour).
 */

import { describe, expect, test } from 'bun:test';
import type { AuditEventRow } from '../audit.js';
import { ZombieStormDetector } from './zombie-storm.js';

function event(agentId: string, isoMs: number): AuditEventRow {
  return {
    id: isoMs,
    entity_type: 'worker',
    entity_id: agentId,
    event_type: 'state_changed',
    actor: 'reconciler',
    details: { state: 'error', reason: 'dead_pane_zombie' },
    created_at: new Date(isoMs).toISOString(),
  };
}

describe('ZombieStormDetector', () => {
  test('five events in window → no signal (at threshold)', () => {
    const det = new ZombieStormDetector();
    for (let i = 0; i < 5; i++) {
      expect(det.ingest(event(`a-${i}`, 1000 + i), 2000)).toBeNull();
    }
  });

  test('six events in window → fires once', () => {
    const det = new ZombieStormDetector();
    for (let i = 0; i < 5; i++) {
      det.ingest(event(`a-${i}`, 1000 + i), 2000);
    }
    const sig = det.ingest(event('a-6', 1006), 2000);
    expect(sig?.type).toBe('agents.zombie_storm');
    expect(sig?.subject).toBe('global');
    expect(sig?.details.zombies_in_window).toBe(6);
    expect(sig?.details.latest_agent).toBe('a-6');
  });

  test('subsequent zombie inside same hour → suppressed', () => {
    const det = new ZombieStormDetector();
    for (let i = 0; i < 6; i++) det.ingest(event(`a-${i}`, 1000 + i), 2000);
    const dup = det.ingest(event('a-7', 1007), 2000);
    expect(dup).toBeNull();
  });

  test('window slides clean → re-fires', () => {
    const det = new ZombieStormDetector();
    const hour = 60 * 60 * 1000;
    for (let i = 0; i < 6; i++) det.ingest(event(`a-${i}`, i * 1000), hour);
    // Two hours later — original ring has fully slid out.
    const future = 2 * hour;
    for (let i = 0; i < 5; i++) det.ingest(event(`b-${i}`, future + i), future + i);
    const sig = det.ingest(event('b-6', future + 100), future + 100);
    expect(sig?.type).toBe('agents.zombie_storm');
  });

  test('non-zombie state_change → ignored', () => {
    const det = new ZombieStormDetector();
    for (let i = 0; i < 6; i++) {
      const row = event(`a-${i}`, 1000 + i);
      row.details = { state: 'error', reason: 'stale_spawn' };
      expect(det.ingest(row, 2000)).toBeNull();
    }
  });

  test('non-worker entity_type → ignored', () => {
    const det = new ZombieStormDetector();
    for (let i = 0; i < 6; i++) {
      const row = event(`a-${i}`, 1000 + i);
      row.entity_type = 'agent';
      expect(det.ingest(row, 2000)).toBeNull();
    }
  });

  test('reset() clears in-memory state', () => {
    const det = new ZombieStormDetector();
    for (let i = 0; i < 5; i++) det.ingest(event(`a-${i}`, 1000 + i), 2000);
    det.reset();
    for (let i = 0; i < 5; i++) {
      expect(det.ingest(event(`b-${i}`, 1000 + i), 2000)).toBeNull();
    }
  });
});
