/**
 * Pattern 3 — Anchor Orphan Detector tests.
 *
 * Positive + negative fixtures exercise the full detector + scheduler round-
 * trip using the DI capture pattern documented in Group 2's scheduler. The
 * `loadState` dep is injected per-test so no PG, no tmux, and no fs are
 * touched. `mock.module` is deliberately avoided — Bun's mock.module is
 * process-global and cannot be undone across test files.
 *
 * Wish: genie-self-healing-observability-b1-detectors (Group 3c).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { start as startScheduler } from '../../serve/detector-scheduler.js';
import { type DetectorModule, __clearDetectorsForTests } from '../index.js';
import { type AnchorOrphanRow, type AnchorOrphanState, makeAnchorOrphanDetector } from '../pattern-3-anchor-orphan.js';

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

function orphan(overrides: Partial<AnchorOrphanRow> = {}): AnchorOrphanRow {
  return {
    agent_id: 'agent-42',
    custom_name: 'engineer',
    team: 'wish-42',
    last_seen_at: '2026-04-20T10:30:00+00:00',
    expected_session_id: 'wish-42-session',
    expected_pane_id: '%17',
    tmux_present: false,
    transcript_present: false,
    ...overrides,
  };
}

describe('rot.anchor-orphan (Pattern 3)', () => {
  afterEach(() => {
    // The detector self-registers at module load — clear so other tests are
    // not polluted with Pattern 3's state.
    __clearDetectorsForTests();
  });

  test('positive fixture: single orphan → exactly 1 rot.detected event', async () => {
    const state: AnchorOrphanState = { orphans: [orphan()] };
    const detector = makeAnchorOrphanDetector({ loadState: async () => state });
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
    expect(fires[0].payload.pattern_id).toBe('pattern-3-anchor-orphan');
    expect(obs.agent_id).toBe('agent-42');
    expect(obs.custom_name).toBe('engineer');
    expect(obs.team).toBe('wish-42');
    expect(obs.last_seen_at).toBe('2026-04-20T10:30:00+00:00');
    expect(obs.expected_session_id).toBe('wish-42-session');
    expect(obs.tmux_present).toBe(false);
    expect(obs.transcript_present).toBe(false);
    expect(obs.orphan_count).toBe(1);
    expect(fires[0].opts.detector_version).toBe('1.0.0');
  });

  test('positive fixture: multiple orphans → 1 event with summary arrays', async () => {
    const state: AnchorOrphanState = {
      orphans: [
        orphan({ agent_id: 'agent-a', custom_name: 'eng-a' }),
        orphan({ agent_id: 'agent-b', custom_name: 'eng-b' }),
        orphan({ agent_id: 'agent-c', custom_name: 'eng-c' }),
      ],
    };
    const detector = makeAnchorOrphanDetector({ loadState: async () => state });
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
    expect(obs.orphan_count).toBe(3);
    expect(obs.all_agent_ids).toEqual(['agent-a', 'agent-b', 'agent-c']);
  });

  test('negative fixture: clean state → 0 events', async () => {
    const detector = makeAnchorOrphanDetector({ loadState: async () => ({ orphans: [] }) });
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
    expect(fires.length).toBe(0);
  });

  test('emitted payload parses against the rot.detected schema', async () => {
    const state: AnchorOrphanState = { orphans: [orphan()] };
    const detector = makeAnchorOrphanDetector({ loadState: async () => state });
    const result = await detector.query();
    const event = detector.render(result);
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
    const detector = makeAnchorOrphanDetector({ loadState: async () => ({ orphans: [] }) });
    expect(detector.id).toBe('rot.anchor-orphan');
    expect(detector.version).toBe('1.0.0');
    expect(detector.riskClass).toBe('high');
  });
});
