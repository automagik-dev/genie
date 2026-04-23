/**
 * Pattern 6 — Subagent Cascade Detector tests.
 *
 * DI capture pattern: inject `loadState` per test; avoid `mock.module`
 * (Bun-global, cannot be undone across files).
 *
 * Wish: genie-self-healing-observability-b1-detectors (Group 3c).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { start as startScheduler } from '../../serve/detector-scheduler.js';
import { type DetectorModule, __clearDetectorsForTests } from '../index.js';
import {
  type SubagentCascadeRow,
  type SubagentCascadeState,
  makeSubagentCascadeDetector,
} from '../pattern-6-subagent-cascade.js';

interface CapturedEmit {
  type: string;
  payload: Record<string, unknown>;
  opts: Record<string, unknown>;
}

function makeCapture(): {
  captured: CapturedEmit[];
  emit: (t: string, p: Record<string, unknown>, o?: Record<string, unknown>) => void;
} {
  const captured: CapturedEmit[] = [];
  return {
    captured,
    emit(type, payload, opts = {}) {
      captured.push({ type, payload, opts });
    },
  };
}

function cascade(overrides: Partial<SubagentCascadeRow> = {}): SubagentCascadeRow {
  return {
    parent_id: 'parent-1',
    child_ids: ['child-a', 'child-b'],
    parent_errored_at: '2026-04-20T10:25:00+00:00',
    children_errored_at: ['2026-04-20T10:26:00+00:00', '2026-04-20T10:27:00+00:00'],
    last_parent_recovery_at: null,
    ...overrides,
  };
}

describe('rot.subagent-cascade (Pattern 6)', () => {
  afterEach(() => {
    __clearDetectorsForTests();
  });

  test('positive fixture: parent+2 children in error → 1 event', async () => {
    const state: SubagentCascadeState = { cascades: [cascade()] };
    const detector = makeSubagentCascadeDetector({ loadState: async () => state });
    const { captured, emit } = makeCapture();

    const scheduler = startScheduler({
      tickIntervalMs: 1_000_000,
      jitterMs: 0,
      now: () => Date.UTC(2026, 3, 20, 10, 30, 0),
      detectorSource: () => [detector as DetectorModule<unknown>],
      emitFn: emit,
      setTimeoutFn: () => ({ id: Symbol('test') }),
      clearTimeoutFn: () => {},
    });
    await scheduler.tickNow();
    scheduler.stop();

    const fires = captured.filter((c) => c.type === 'rot.detected');
    expect(fires.length).toBe(1);
    const obs = fires[0].payload.observed_state_json as Record<string, unknown>;
    expect(fires[0].payload.pattern_id).toBe('pattern-6-subagent-cascade');
    expect(obs.parent_id).toBe('parent-1');
    expect(obs.child_ids).toEqual(['child-a', 'child-b']);
    expect(obs.parent_errored_at).toBe('2026-04-20T10:25:00+00:00');
    expect(obs.children_errored_at).toEqual(['2026-04-20T10:26:00+00:00', '2026-04-20T10:27:00+00:00']);
    expect(obs.last_parent_recovery_at).toBeNull();
    expect(obs.cascade_count).toBe(1);
    expect(obs.child_count).toBe(2);
    expect(fires[0].opts.detector_version).toBe('1.0.0');
  });

  test('negative fixture: no cascade → 0 events', async () => {
    const detector = makeSubagentCascadeDetector({ loadState: async () => ({ cascades: [] }) });
    const { captured, emit } = makeCapture();
    const scheduler = startScheduler({
      tickIntervalMs: 1_000_000,
      jitterMs: 0,
      now: () => Date.UTC(2026, 3, 20, 10, 30, 0),
      detectorSource: () => [detector as DetectorModule<unknown>],
      emitFn: emit,
      setTimeoutFn: () => ({ id: Symbol('test') }),
      clearTimeoutFn: () => {},
    });
    await scheduler.tickNow();
    scheduler.stop();
    expect(captured.filter((c) => c.type === 'rot.detected').length).toBe(0);
  });

  test('payload parses against rot.detected schema', async () => {
    const state: SubagentCascadeState = { cascades: [cascade()] };
    const detector = makeSubagentCascadeDetector({ loadState: async () => state });
    const event = detector.render(await detector.query());
    const { getEntry } = await import('../../lib/events/registry.js');
    const entry = getEntry('rot.detected');
    expect(entry).not.toBeNull();
    const parsed = entry!.schema.safeParse(event.payload);
    if (!parsed.success) {
      console.error('schema parse failed', parsed.error.issues);
    }
    expect(parsed.success).toBe(true);
  });

  test('detector metadata matches contract', () => {
    const detector = makeSubagentCascadeDetector({ loadState: async () => ({ cascades: [] }) });
    expect(detector.id).toBe('rot.subagent-cascade');
    expect(detector.version).toBe('1.0.0');
    expect(detector.riskClass).toBe('high');
  });
});
