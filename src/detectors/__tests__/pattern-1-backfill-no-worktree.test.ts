/**
 * Tests for Pattern 1 detector (rot.backfill-no-worktree).
 *
 * Wish: genie-self-healing-observability-b1-detectors (Group 3a).
 *
 * Strategy: inject both the DB query and the filesystem check so the test
 * stays in-memory (no pgserve dependency for the detector itself). Emission
 * is exercised by feeding the detector through the real scheduler with an
 * `emitFn` capture closure — same DI pattern the fire-budget suite uses.
 * No `mock.module` anywhere (Bun's `mock.module` is process-global, see
 * commit fc7f81ff).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { type SchedulerHandle, start as startScheduler } from '../../serve/detector-scheduler.js';
import type { DetectorModule } from '../index.js';
import { type BackfillNoWorktreeState, createBackfillNoWorktreeDetector } from '../pattern-1-backfill-no-worktree.js';

interface CapturedEmit {
  type: string;
  payload: Record<string, unknown>;
  opts: Record<string, unknown>;
}

const captured: CapturedEmit[] = [];
function captureEmit(type: string, payload: Record<string, unknown>, opts: Record<string, unknown> = {}): void {
  captured.push({ type, payload, opts });
}

/** Runs the detector through the scheduler with an isolated detector source. */
async function runDetectorOnce(detector: DetectorModule<BackfillNoWorktreeState>): Promise<void> {
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

describe('pattern-1-backfill-no-worktree detector', () => {
  afterEach(() => {
    captured.length = 0;
  });

  test('positive fixture — one missing worktree produces exactly 1 event', async () => {
    const startTime = performance.now();
    const detector = createBackfillNoWorktreeDetector({
      query: async () => [
        { name: 'team-alpha', status: 'in_progress', worktree_path: '/tmp/does/not/exist/alpha' },
        { name: 'team-beta', status: 'in_progress', worktree_path: '/tmp/exists/beta' },
      ],
      exists: (path: string) => path.startsWith('/tmp/exists/'),
    });

    await runDetectorOnce(detector);
    const elapsed = performance.now() - startTime;
    console.log(`[pattern-1] positive fixture ran in ${elapsed.toFixed(2)}ms`);

    const fires = captured.filter((c) => c.type === 'rot.detected');
    expect(fires.length).toBe(1);
    expect(fires[0].payload.pattern_id).toBe('pattern-1-backfill-no-worktree');
    // entity_id is HMAC-hashed at schema parse time; the scheduler opts
    // carries the raw subject as `entity_id` for indexing.
    expect(fires[0].opts.entity_id).toBe('team-alpha');
    const state = fires[0].payload.observed_state_json as Record<string, unknown>;
    expect(state.team_name).toBe('team-alpha');
    expect(state.status).toBe('in_progress');
    expect(state.expected_worktree_path).toBe('/tmp/does/not/exist/alpha');
    expect(state.fs_exists).toBe(false);
    expect(state.total_missing).toBe(1);

    // Sub-500ms query timing target per wish.
    expect(elapsed).toBeLessThan(500);
  });

  test('positive fixture — multiple missing paths fire one event per tick with aggregate count', async () => {
    const detector = createBackfillNoWorktreeDetector({
      query: async () => [
        { name: 'team-a', status: 'in_progress', worktree_path: '/gone/a' },
        { name: 'team-b', status: 'in_progress', worktree_path: '/gone/b' },
        { name: 'team-c', status: 'in_progress', worktree_path: '/gone/c' },
      ],
      exists: () => false,
    });

    await runDetectorOnce(detector);

    const fires = captured.filter((c) => c.type === 'rot.detected');
    // Per-tick contract: one event per tick even when many offenders exist.
    expect(fires.length).toBe(1);
    const state = fires[0].payload.observed_state_json as Record<string, unknown>;
    expect(state.total_missing).toBe(3);
  });

  test('negative fixture — every worktree on disk produces 0 events', async () => {
    const startTime = performance.now();
    const detector = createBackfillNoWorktreeDetector({
      query: async () => [
        { name: 'team-ok-1', status: 'in_progress', worktree_path: '/real/ok-1' },
        { name: 'team-ok-2', status: 'in_progress', worktree_path: '/real/ok-2' },
      ],
      exists: () => true,
    });

    await runDetectorOnce(detector);
    const elapsed = performance.now() - startTime;
    console.log(`[pattern-1] negative fixture ran in ${elapsed.toFixed(2)}ms`);

    const fires = captured.filter((c) => c.type === 'rot.detected');
    expect(fires.length).toBe(0);
    expect(elapsed).toBeLessThan(500);
  });

  test('negative fixture — empty teams table produces 0 events', async () => {
    const detector = createBackfillNoWorktreeDetector({
      query: async () => [],
      exists: () => true,
    });

    await runDetectorOnce(detector);

    const fires = captured.filter((c) => c.type === 'rot.detected');
    expect(fires.length).toBe(0);
  });

  test('detector carries correct id + version + riskClass', () => {
    const detector = createBackfillNoWorktreeDetector();
    expect(detector.id).toBe('rot.backfill-no-worktree');
    expect(detector.version).toBe('0.1.0');
    expect(detector.riskClass).toBe('low');
  });
});
