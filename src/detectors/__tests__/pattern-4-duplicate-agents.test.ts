/**
 * Tests for Pattern 4 detector (rot.duplicate-agents).
 *
 * Wish: genie-self-healing-observability-b1-detectors (Group 3a).
 *
 * Uses the same `emitFn` DI pattern as pattern-1: we feed the detector
 * through the real scheduler with a capture closure. The DB query is
 * stubbed at the factory level so the test stays in-memory.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { type SchedulerHandle, start as startScheduler } from '../../serve/detector-scheduler.js';
import type { DetectorModule } from '../index.js';
import { type DuplicateAgentsState, createDuplicateAgentsDetector } from '../pattern-4-duplicate-agents.js';

interface CapturedEmit {
  type: string;
  payload: Record<string, unknown>;
  opts: Record<string, unknown>;
}

const captured: CapturedEmit[] = [];
function captureEmit(type: string, payload: Record<string, unknown>, opts: Record<string, unknown> = {}): void {
  captured.push({ type, payload, opts });
}

async function runDetectorOnce(detector: DetectorModule<DuplicateAgentsState>): Promise<void> {
  let scheduler: SchedulerHandle | null = null;
  try {
    scheduler = startScheduler({
      tickIntervalMs: 1_000_000,
      jitterMs: 0,
      defaultFireBudget: 1_000,
      now: () => Date.UTC(2026, 3, 20, 10, 30, 0),
      detectorSource: () => [detector as DetectorModule<unknown>],
      emitFn: captureEmit,
      setTimeoutFn: () => ({ id: Symbol('test') }),
      clearTimeoutFn: () => {},
    });
    await scheduler.tickNow();
  } finally {
    scheduler?.stop();
  }
}

describe('pattern-4-duplicate-agents detector', () => {
  afterEach(() => {
    captured.length = 0;
  });

  test('positive fixture — one duplicate pair fires exactly 1 event with all agent_ids', async () => {
    const startTime = performance.now();
    const detector = createDuplicateAgentsDetector({
      query: async () => [
        {
          custom_name: 'alpha',
          team: 'my-team',
          dup_count: 2,
          agent_ids: ['agent-1', 'agent-2'],
        },
      ],
    });

    await runDetectorOnce(detector);
    const elapsed = performance.now() - startTime;
    console.log(`[pattern-4] positive fixture ran in ${elapsed.toFixed(2)}ms`);

    const fires = captured.filter((c) => c.type === 'rot.detected');
    expect(fires.length).toBe(1);
    expect(fires[0].payload.pattern_id).toBe('pattern-4-duplicate-agents');
    expect(fires[0].opts.entity_id).toBe('my-team/alpha');
    const state = fires[0].payload.observed_state_json as Record<string, unknown>;
    expect(state.team).toBe('my-team');
    expect(state.custom_name).toBe('alpha');
    expect(state.dup_count).toBe(2);
    expect(state.agent_ids).toEqual(['agent-1', 'agent-2']);
    expect(state.total_offending_pairs).toBe(1);

    expect(elapsed).toBeLessThan(500);
  });

  test('positive fixture — multiple offending pairs fire one event per tick with aggregate count', async () => {
    const detector = createDuplicateAgentsDetector({
      query: async () => [
        {
          custom_name: 'alpha',
          team: 'team-a',
          dup_count: 3,
          agent_ids: ['a-1', 'a-2', 'a-3'],
        },
        {
          custom_name: 'beta',
          team: 'team-b',
          dup_count: 2,
          agent_ids: ['b-1', 'b-2'],
        },
      ],
    });

    await runDetectorOnce(detector);

    const fires = captured.filter((c) => c.type === 'rot.detected');
    // Per-tick: one event; the render picks the first (highest count) group.
    expect(fires.length).toBe(1);
    const state = fires[0].payload.observed_state_json as Record<string, unknown>;
    expect(state.team).toBe('team-a');
    expect(state.custom_name).toBe('alpha');
    expect(state.dup_count).toBe(3);
    expect(state.total_offending_pairs).toBe(2);
  });

  test('negative fixture — no duplicates produces 0 events', async () => {
    const startTime = performance.now();
    const detector = createDuplicateAgentsDetector({
      query: async () => [],
    });

    await runDetectorOnce(detector);
    const elapsed = performance.now() - startTime;
    console.log(`[pattern-4] negative fixture ran in ${elapsed.toFixed(2)}ms`);

    const fires = captured.filter((c) => c.type === 'rot.detected');
    expect(fires.length).toBe(0);
    expect(elapsed).toBeLessThan(500);
  });

  test('detector carries correct id + version + riskClass', () => {
    const detector = createDuplicateAgentsDetector();
    expect(detector.id).toBe('rot.duplicate-agents');
    expect(detector.version).toBe('0.1.0');
    expect(detector.riskClass).toBe('low');
  });
});
