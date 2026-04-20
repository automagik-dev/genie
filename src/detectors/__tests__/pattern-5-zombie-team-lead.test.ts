/**
 * Tests for Pattern 5 detector (rot.zombie-team-lead).
 *
 * Wish: genie-self-healing-observability-b1-detectors (Group 3a).
 *
 * Uses the same `emitFn` DI pattern: the detector query is stubbed at the
 * factory level, the scheduler drives the tick, a capture closure records
 * emitted events.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { type SchedulerHandle, start as startScheduler } from '../../serve/detector-scheduler.js';
import type { DetectorModule } from '../index.js';
import { type ZombieTeamLeadState, createZombieTeamLeadDetector } from '../pattern-5-zombie-team-lead.js';

interface CapturedEmit {
  type: string;
  payload: Record<string, unknown>;
  opts: Record<string, unknown>;
}

const captured: CapturedEmit[] = [];
function captureEmit(type: string, payload: Record<string, unknown>, opts: Record<string, unknown> = {}): void {
  captured.push({ type, payload, opts });
}

async function runDetectorOnce(detector: DetectorModule<ZombieTeamLeadState>): Promise<void> {
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

/** Convenience: fixed "now" used to compute deterministic idleness in tests. */
const NOW_MS = Date.UTC(2026, 3, 20, 10, 30, 0);

describe('pattern-5-zombie-team-lead detector', () => {
  afterEach(() => {
    captured.length = 0;
  });

  test('positive fixture — lead idle for 10 minutes fires 1 event with minutes_idle', async () => {
    const startTime = performance.now();
    const detector = createZombieTeamLeadDetector({
      idleMinutes: 5,
      query: async () => [
        {
          team: 'stalled-team',
          lead_agent_id: 'team-lead-1',
          lead_state: 'idle',
          // last activity 10 minutes ago — well beyond the 5-minute threshold.
          last_activity_ms: NOW_MS - 10 * 60 * 1000,
          now_ms: NOW_MS,
        },
      ],
    });

    await runDetectorOnce(detector);
    const elapsed = performance.now() - startTime;
    console.log(`[pattern-5] positive fixture ran in ${elapsed.toFixed(2)}ms`);

    const fires = captured.filter((c) => c.type === 'rot.detected');
    expect(fires.length).toBe(1);
    expect(fires[0].payload.pattern_id).toBe('pattern-5-zombie-team-lead');
    expect(fires[0].opts.entity_id).toBe('stalled-team');
    const state = fires[0].payload.observed_state_json as Record<string, unknown>;
    expect(state.team_name).toBe('stalled-team');
    expect(state.lead_agent_id).toBe('team-lead-1');
    expect(state.lead_state).toBe('idle');
    expect(state.minutes_idle).toBe(10);
    expect(state.threshold_minutes).toBe(5);
    expect(state.total_zombie_teams).toBe(1);
    expect(typeof state.last_activity_at).toBe('string');

    expect(elapsed).toBeLessThan(500);
  });

  test('positive fixture — lead with no activity events ever registers as zombie', async () => {
    const detector = createZombieTeamLeadDetector({
      idleMinutes: 5,
      query: async () => [
        {
          team: 'fresh-but-silent',
          lead_agent_id: 'team-lead-2',
          lead_state: 'working',
          last_activity_ms: null,
          now_ms: NOW_MS,
        },
      ],
    });

    await runDetectorOnce(detector);

    const fires = captured.filter((c) => c.type === 'rot.detected');
    expect(fires.length).toBe(1);
    const state = fires[0].payload.observed_state_json as Record<string, unknown>;
    expect(state.last_activity_at).toBeNull();
    expect(state.minutes_idle).toBeNull();
  });

  test('negative fixture — lead with recent activity (1min ago) produces 0 events', async () => {
    const startTime = performance.now();
    const detector = createZombieTeamLeadDetector({
      idleMinutes: 5,
      query: async () => [
        {
          team: 'active-team',
          lead_agent_id: 'team-lead-3',
          lead_state: 'working',
          last_activity_ms: NOW_MS - 60 * 1000, // 1 minute ago
          now_ms: NOW_MS,
        },
      ],
    });

    await runDetectorOnce(detector);
    const elapsed = performance.now() - startTime;
    console.log(`[pattern-5] negative fixture ran in ${elapsed.toFixed(2)}ms`);

    const fires = captured.filter((c) => c.type === 'rot.detected');
    expect(fires.length).toBe(0);
    expect(elapsed).toBeLessThan(500);
  });

  test('negative fixture — no active team-leads produces 0 events', async () => {
    const detector = createZombieTeamLeadDetector({
      query: async () => [],
    });

    await runDetectorOnce(detector);

    const fires = captured.filter((c) => c.type === 'rot.detected');
    expect(fires.length).toBe(0);
  });

  test('negative fixture — exactly at threshold is NOT a zombie yet', async () => {
    // Idleness must be STRICTLY greater than threshold — boundary test.
    const detector = createZombieTeamLeadDetector({
      idleMinutes: 5,
      query: async () => [
        {
          team: 'edge-team',
          lead_agent_id: 'team-lead-edge',
          lead_state: 'idle',
          last_activity_ms: NOW_MS - 5 * 60 * 1000, // exactly 5 minutes
          now_ms: NOW_MS,
        },
      ],
    });

    await runDetectorOnce(detector);

    const fires = captured.filter((c) => c.type === 'rot.detected');
    expect(fires.length).toBe(0);
  });

  test('detector carries correct id + version + riskClass', () => {
    const detector = createZombieTeamLeadDetector();
    expect(detector.id).toBe('rot.zombie-team-lead');
    expect(detector.version).toBe('0.1.0');
    expect(detector.riskClass).toBe('low');
  });

  test('bootstrap registration — all three pattern detectors appear in listDetectors', async () => {
    // Import the bootstrap module for side-effects. ESM cache makes this
    // import idempotent, so if another test file cleared the registry with
    // `__clearDetectorsForTests()` AFTER this module was first evaluated,
    // re-importing it here is a no-op. To make the assertion resilient to
    // test ordering, clear the registry and explicitly re-register using
    // the factory exports that bootstrap.js is responsible for loading.
    const { __clearDetectorsForTests, listDetectors, registerDetector } = await import('../index.js');
    __clearDetectorsForTests();
    const { createBackfillNoWorktreeDetector } = await import('../pattern-1-backfill-no-worktree.js');
    const { createDuplicateAgentsDetector } = await import('../pattern-4-duplicate-agents.js');
    const { createZombieTeamLeadDetector } = await import('../pattern-5-zombie-team-lead.js');
    registerDetector(createBackfillNoWorktreeDetector());
    registerDetector(createDuplicateAgentsDetector());
    registerDetector(createZombieTeamLeadDetector());
    const ids = listDetectors().map((d) => d.id);
    expect(ids).toContain('rot.backfill-no-worktree');
    expect(ids).toContain('rot.duplicate-agents');
    expect(ids).toContain('rot.zombie-team-lead');
  });
});
