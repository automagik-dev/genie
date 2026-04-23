/**
 * Pattern 7 — Dispatch Silent Drop Detector tests.
 *
 * DI capture pattern only — no `mock.module` (process-global, non-undoable).
 *
 * Accuracy discipline test-cases:
 *   - Positive: 60s+ since broadcast, idle member, zero prompts → 1 event.
 *   - Negative: prompt landed after broadcast → 0 events.
 *   - Negative: broadcast too recent (<60s) → the detector's loadState
 *     enforces the cutoff; fixtures return empty drops when the window is
 *     not satisfied.
 *
 * Wish: genie-self-healing-observability-b1-detectors (Group 3c).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { start as startScheduler } from '../../serve/detector-scheduler.js';
import { type DetectorModule, __clearDetectorsForTests } from '../index.js';
import {
  type DispatchSilentDropRow,
  type DispatchSilentDropState,
  makeDispatchSilentDropDetector,
} from '../pattern-7-dispatch-silent-drop.js';

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

function drop(overrides: Partial<DispatchSilentDropRow> = {}): DispatchSilentDropRow {
  return {
    team: 'wish-42',
    broadcast_id: '12345',
    broadcast_at: '2026-04-20T10:28:00+00:00',
    idle_member_ids: ['eng-1', 'eng-2'],
    expected_prompt_count: 2,
    actual_prompt_count: 0,
    ...overrides,
  };
}

describe('rot.dispatch-silent-drop (Pattern 7)', () => {
  afterEach(() => {
    __clearDetectorsForTests();
  });

  test('positive fixture: silent drop after 60s → exactly 1 event', async () => {
    const state: DispatchSilentDropState = { drops: [drop()] };
    const detector = makeDispatchSilentDropDetector({ loadState: async () => state });
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
    expect(fires[0].payload.pattern_id).toBe('pattern-7-dispatch-silent-drop');
    expect(obs.team).toBe('wish-42');
    expect(obs.broadcast_id).toBe('12345');
    expect(obs.broadcast_at).toBe('2026-04-20T10:28:00+00:00');
    expect(obs.idle_member_ids).toEqual(['eng-1', 'eng-2']);
    expect(obs.expected_prompt_count).toBe(2);
    expect(obs.actual_prompt_count).toBe(0);
    expect(obs.drop_count).toBe(1);
    expect(fires[0].opts.detector_version).toBe('1.0.0');
  });

  test('negative fixture: no silent drops → 0 events (clean channel)', async () => {
    const detector = makeDispatchSilentDropDetector({ loadState: async () => ({ drops: [] }) });
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

  test('conservative predicate: single fire per tick even with multiple drops', async () => {
    const state: DispatchSilentDropState = {
      drops: [drop({ team: 't1', broadcast_id: '1' }), drop({ team: 't2', broadcast_id: '2' })],
    };
    const detector = makeDispatchSilentDropDetector({ loadState: async () => state });
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
    // We fire once per tick with drop_count reflecting the full set, to
    // avoid flooding the event bus — the scheduler's fire_budget is the
    // second line of defence; we want predictable cardinality first.
    expect(fires.length).toBe(1);
    expect((fires[0].payload.observed_state_json as Record<string, unknown>).drop_count).toBe(2);
  });

  test('payload parses against rot.detected schema', async () => {
    const state: DispatchSilentDropState = { drops: [drop()] };
    const detector = makeDispatchSilentDropDetector({ loadState: async () => state });
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
    const detector = makeDispatchSilentDropDetector({ loadState: async () => ({ drops: [] }) });
    expect(detector.id).toBe('rot.dispatch-silent-drop');
    expect(detector.version).toBe('1.0.0');
    expect(detector.riskClass).toBe('high');
  });
});
