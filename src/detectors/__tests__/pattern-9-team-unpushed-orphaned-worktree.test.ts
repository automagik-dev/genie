/**
 * Tests for Pattern 9 detector (rot.team-unpushed-orphaned-worktree).
 *
 * Wish: team-unpushed-orphaned-worktree (Group 2).
 *
 * Same DI pattern as pattern-5: the scheduler drives a single tick with an
 * injected `detectorSource`; the factory accepts an injected `query` and
 * `gitProbe`; a capture closure records emitted events. No real SQL, no
 * real git subprocess, no real DB, no real filesystem reads.
 *
 * Scenarios covered (mapped from the wish IN section):
 *   1. Fires when all three predicates hold.
 *   2. Does NOT fire when an executor is running within the idle window.
 *   3. Does NOT fire when the worktree is missing on disk (probe → ok:false).
 *   4. Does NOT fire when ahead-count is 0.
 *   5. Does NOT fire when teams.status = 'done' (SQL gate removes upstream).
 *   6. Does NOT fire when teams.status = 'blocked' (SQL gate removes upstream).
 *   7. Fire-budget: same team fires once per hour max, not once per tick.
 *   8. Handles missing base_branch / malformed worktree_path without crashing.
 *   9. Subprocess timeout is graceful — no fire, no deadlock.
 *  10. Caps probe batch at maxTeamsPerTick; total_stalled_teams includes the
 *      uncapped idle stragglers deferred to the next tick.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { type SchedulerHandle, start as startScheduler } from '../../serve/detector-scheduler.js';
import type { DetectorModule } from '../index.js';
import {
  type GitProbeFn,
  type GitProbeResult,
  type TeamUnpushedOrphanedWorktreeState,
  type TeamUnpushedRow,
  createTeamUnpushedOrphanedWorktreeDetector,
} from '../pattern-9-team-unpushed-orphaned-worktree.js';

// ---------------------------------------------------------------------------
// Shared harness
// ---------------------------------------------------------------------------

interface CapturedEmit {
  type: string;
  payload: Record<string, unknown>;
  opts: Record<string, unknown>;
}

const captured: CapturedEmit[] = [];
function captureEmit(type: string, payload: Record<string, unknown>, opts: Record<string, unknown> = {}): void {
  captured.push({ type, payload, opts });
}

/** Fixed instant used for deterministic "minutes_since_active" math. */
const NOW_MS = Date.UTC(2026, 3, 21, 12, 0, 0); // 2026-04-21 12:00:00 UTC

/** 11 minutes ago — exceeds the 10-minute default threshold. */
const STALE_EXECUTOR_MS = NOW_MS - 11 * 60 * 1000;
/** 2 minutes ago — inside the 10-minute window (still active). */
const FRESH_EXECUTOR_MS = NOW_MS - 2 * 60 * 1000;
/** 15 minutes ago — a plausible tip-commit time for a stalled worktree. */
const LAST_COMMIT_MS = NOW_MS - 15 * 60 * 1000;
const LAST_COMMIT_ISO = new Date(LAST_COMMIT_MS).toISOString();

/**
 * Build a baseline candidate row whose liveness timestamp is already past the
 * default idle threshold. Tests override only the fields that matter.
 */
function stalledRow(overrides: Partial<TeamUnpushedRow> = {}): TeamUnpushedRow {
  return {
    team_name: 'docs-pr-detectors-page',
    status: 'working',
    worktree_path: '/home/genie/.genie/worktrees/docs/docs-pr-detectors-page',
    base_branch: 'main',
    lead_agent_id: 'team-lead-1',
    lead_state: 'idle',
    last_executor_active_ms: STALE_EXECUTOR_MS,
    now_ms: NOW_MS,
    ...overrides,
  };
}

/** Git probe reporting three unpushed commits and a concrete tip timestamp. */
const probeAhead3: GitProbeFn = async () => ({
  ok: true,
  branch_ahead_count: 3,
  last_commit_ms: LAST_COMMIT_MS,
});

/** Git probe reporting zero ahead — healthy worktree, nothing to salvage. */
const probeZeroAhead: GitProbeFn = async () => ({
  ok: true,
  branch_ahead_count: 0,
  last_commit_ms: null,
});

/** Git probe simulating a subprocess timeout / unknown-state degrade. */
const probeTimeout: GitProbeFn = async () => ({
  ok: false,
  branch_ahead_count: 0,
  last_commit_ms: null,
  error: 'ETIMEDOUT',
});

/** Git probe mirroring `makeDefaultGitProbe`'s missing-worktree degrade. */
const probeMissingWorktree: GitProbeFn = async () => ({
  ok: false,
  branch_ahead_count: 0,
  last_commit_ms: null,
  error: 'missing_worktree',
});

/**
 * Git probe that mirrors the production skip-and-continue behaviour: return
 * ok:false for malformed rows, ok:true+ahead for well-formed ones. Matches the
 * semantics of `makeDefaultGitProbe`'s top-of-function guards.
 */
const probeMalformedAware: GitProbeFn = async (row) => {
  if (!row.base_branch || !row.worktree_path) {
    return { ok: false, branch_ahead_count: 0, last_commit_ms: null, error: 'malformed_path' };
  }
  return { ok: true, branch_ahead_count: 3, last_commit_ms: LAST_COMMIT_MS };
};

/**
 * Drive one scheduler tick against a detector and capture emitted events.
 * Pattern-5 uses the same harness; see `pattern-5-zombie-team-lead.test.ts`
 * for cross-reference.
 */
async function runDetectorOnce(
  detector: DetectorModule<TeamUnpushedOrphanedWorktreeState>,
  opts: { defaultFireBudget?: number } = {},
): Promise<void> {
  let scheduler: SchedulerHandle | null = null;
  try {
    scheduler = startScheduler({
      tickIntervalMs: 1_000_000,
      jitterMs: 0,
      defaultFireBudget: opts.defaultFireBudget ?? 1_000,
      now: () => NOW_MS,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pattern-9-team-unpushed-orphaned-worktree detector', () => {
  afterEach(() => {
    captured.length = 0;
  });

  test('1. fires once when all three predicates hold — evidence carries required fields', async () => {
    const startTime = performance.now();
    const detector = createTeamUnpushedOrphanedWorktreeDetector({
      idleMinutes: 10,
      query: async () => [stalledRow()],
      gitProbe: probeAhead3,
    });

    await runDetectorOnce(detector);
    const elapsed = performance.now() - startTime;
    console.log(`[pattern-9] positive fixture ran in ${elapsed.toFixed(2)}ms`);

    const fires = captured.filter((c) => c.type === 'rot.detected');
    expect(fires.length).toBe(1);
    expect(fires[0].payload.pattern_id).toBe('pattern-9-team-unpushed-orphaned-worktree');
    expect(fires[0].opts.entity_id).toBe('docs-pr-detectors-page');

    const state = fires[0].payload.observed_state_json as Record<string, unknown>;
    expect(state.team_name).toBe('docs-pr-detectors-page');
    expect(state.team_status).toBe('working');
    expect(state.worktree_path).toBe('/home/genie/.genie/worktrees/docs/docs-pr-detectors-page');
    expect(state.base_branch).toBe('main');
    expect(state.branch_ahead_count).toBe(3);
    expect(state.last_commit_at).toBe(LAST_COMMIT_ISO);
    expect(state.last_executor_active_at).toBe(new Date(STALE_EXECUTOR_MS).toISOString());
    expect(state.minutes_since_active).toBe(11);
    expect(state.threshold_minutes).toBe(10);
    expect(state.lead_agent_id).toBe('team-lead-1');
    expect(state.lead_state).toBe('idle');
    expect(state.total_stalled_teams).toBe(1);

    // Guard against accidental real-subprocess regressions — stubbed detector
    // must finish in well under a second.
    expect(elapsed).toBeLessThan(500);
  });

  test('2. does NOT fire when executor is still active within the idle window', async () => {
    const detector = createTeamUnpushedOrphanedWorktreeDetector({
      idleMinutes: 10,
      query: async () => [stalledRow({ last_executor_active_ms: FRESH_EXECUTOR_MS })],
      gitProbe: probeAhead3,
    });

    await runDetectorOnce(detector);

    expect(captured.filter((c) => c.type === 'rot.detected').length).toBe(0);
  });

  test('3. does NOT fire when the worktree is missing on disk (probe degrades to ok:false)', async () => {
    const detector = createTeamUnpushedOrphanedWorktreeDetector({
      idleMinutes: 10,
      query: async () => [stalledRow()],
      gitProbe: probeMissingWorktree,
    });

    await runDetectorOnce(detector);

    expect(captured.filter((c) => c.type === 'rot.detected').length).toBe(0);
  });

  test('4. does NOT fire when the worktree has zero commits ahead', async () => {
    const detector = createTeamUnpushedOrphanedWorktreeDetector({
      idleMinutes: 10,
      query: async () => [stalledRow()],
      gitProbe: probeZeroAhead,
    });

    await runDetectorOnce(detector);

    expect(captured.filter((c) => c.type === 'rot.detected').length).toBe(0);
  });

  test("5. does NOT fire when teams.status = 'done' (SQL gate removes the row upstream)", async () => {
    // Production SQL gates on `status NOT IN ('done','blocked','archived')`,
    // so the default query never returns terminal-state teams. The stub
    // mirrors that contract — any row with status 'done' is filtered upstream.
    const detector = createTeamUnpushedOrphanedWorktreeDetector({
      idleMinutes: 10,
      query: async () => {
        const row = stalledRow({ status: 'done' });
        return row.status === 'done' ? [] : [row];
      },
      gitProbe: probeAhead3,
    });

    await runDetectorOnce(detector);

    expect(captured.filter((c) => c.type === 'rot.detected').length).toBe(0);
  });

  test("6. does NOT fire when teams.status = 'blocked' (SQL gate removes the row upstream)", async () => {
    const detector = createTeamUnpushedOrphanedWorktreeDetector({
      idleMinutes: 10,
      query: async () => {
        const row = stalledRow({ status: 'blocked' });
        return row.status === 'blocked' ? [] : [row];
      },
      gitProbe: probeAhead3,
    });

    await runDetectorOnce(detector);

    expect(captured.filter((c) => c.type === 'rot.detected').length).toBe(0);
  });

  test('7. fire-budget: same detector fires once per hour, disables after cap', async () => {
    // Budget of 1 + always-stalled row => first tick emits rot.detected, second
    // tick emits detector.disabled with cause=fire_budget_exceeded, subsequent
    // ticks silent. Matches the behaviour validated by
    // src/detectors/__tests__/fire-budget.test.ts for pattern-agnostic cases.
    const detector = createTeamUnpushedOrphanedWorktreeDetector({
      idleMinutes: 10,
      query: async () => [stalledRow()],
      gitProbe: probeAhead3,
    });

    let scheduler: SchedulerHandle | null = null;
    try {
      scheduler = startScheduler({
        tickIntervalMs: 1_000_000,
        jitterMs: 0,
        defaultFireBudget: 1,
        now: () => NOW_MS,
        detectorSource: () => [detector as DetectorModule<unknown>],
        emitFn: captureEmit,
        setTimeoutFn: () => ({ id: Symbol('test') }),
        clearTimeoutFn: () => {},
      });
      await scheduler.tickNow();
      await scheduler.tickNow();
      await scheduler.tickNow();
    } finally {
      scheduler?.stop();
    }

    const fires = captured.filter((c) => c.type === 'rot.detected');
    const disables = captured.filter((c) => c.type === 'detector.disabled');

    expect(fires.length).toBe(1);
    expect(disables.length).toBe(1);
    expect(disables[0].payload.detector_id).toBe('rot.team-unpushed-orphaned-worktree');
    expect(disables[0].payload.cause).toBe('fire_budget_exceeded');
    expect(disables[0].payload.budget).toBe(1);
  });

  test('8. does NOT crash when base_branch is missing / worktree_path is empty', async () => {
    // Malformed rows must be skipped without taking the detector down; a
    // well-formed row alongside them should still produce an emission. The
    // injected probe mirrors the production guard (empty worktree/base_branch
    // → ok:false → probeOne returns null → detector moves on).
    const detector = createTeamUnpushedOrphanedWorktreeDetector({
      idleMinutes: 10,
      query: async () => [
        // Empty path — worktree row is structurally invalid.
        stalledRow({ team_name: 'empty-path-row', worktree_path: '' }),
        // Missing base_branch — probe has no origin/<branch> to diff against.
        stalledRow({ team_name: 'missing-base-branch', base_branch: null }),
        stalledRow(), // well-formed — should be the emission subject
      ],
      gitProbe: probeMalformedAware,
    });

    await runDetectorOnce(detector);

    const fires = captured.filter((c) => c.type === 'rot.detected');
    expect(fires.length).toBe(1);
    const state = fires[0].payload.observed_state_json as Record<string, unknown>;
    expect(state.team_name).toBe('docs-pr-detectors-page');
    // Only the well-formed row survived the malformed-aware probe.
    expect(state.total_stalled_teams).toBe(1);
  });

  test('9. subprocess timeout degrades gracefully — no fire, no deadlock', async () => {
    const startTime = performance.now();
    const detector = createTeamUnpushedOrphanedWorktreeDetector({
      idleMinutes: 10,
      gitTimeoutMs: 3000,
      query: async () => [stalledRow()],
      gitProbe: probeTimeout,
    });

    await runDetectorOnce(detector);
    const elapsed = performance.now() - startTime;

    const fires = captured.filter((c) => c.type === 'rot.detected');
    expect(fires.length).toBe(0);
    // Guard against regressions in which a timed-out probe blocks the tick.
    expect(elapsed).toBeLessThan(500);
  });

  test('10. caps probe batch at maxTeamsPerTick; total_stalled_teams includes the uncapped stragglers', async () => {
    // 40 stalled candidates but cap = 32. The detector probes only 32 (bounding
    // git subprocess blast radius); the remaining 8 idle-past-threshold rows
    // are surfaced in `total_stalled_teams` so the operator can see backlog.
    const rows: TeamUnpushedRow[] = Array.from({ length: 40 }, (_, i) =>
      stalledRow({
        team_name: `docs-pr-stalled-${String(i).padStart(2, '0')}`,
        worktree_path: `/home/genie/.genie/worktrees/docs/docs-pr-stalled-${i}`,
      }),
    );
    let probeCalls = 0;
    const countedProbe: GitProbeFn = async (row): Promise<GitProbeResult> => {
      probeCalls++;
      return probeAhead3(row);
    };
    const detector = createTeamUnpushedOrphanedWorktreeDetector({
      idleMinutes: 10,
      maxTeamsPerTick: 32,
      query: async () => rows,
      gitProbe: countedProbe,
    });

    await runDetectorOnce(detector);

    // Probe budget enforced — never exceeds the per-tick cap.
    expect(probeCalls).toBe(32);

    const fires = captured.filter((c) => c.type === 'rot.detected');
    expect(fires.length).toBe(1);
    const state = fires[0].payload.observed_state_json as Record<string, unknown>;
    // Evidence names the first row (candidates come back in query order).
    expect(state.team_name).toBe('docs-pr-stalled-00');
    // total_stalled_teams = probed+confirmed (32) + idle stragglers deferred
    // to the next tick (8) = 40. Per the wish's "reflects the full count"
    // semantic, operators see total backlog, not just what was probed this tick.
    expect(state.total_stalled_teams).toBe(40);
  });

  // ---------------------------------------------------------------------------
  // Descriptor sanity — id + version + riskClass align with registration.
  // ---------------------------------------------------------------------------

  test('detector metadata: id / version / riskClass', () => {
    const detector = createTeamUnpushedOrphanedWorktreeDetector();
    expect(detector.id).toBe('rot.team-unpushed-orphaned-worktree');
    expect(detector.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(detector.riskClass).toBe('low');
  });

  // Safety guard: a non-stalled team (fresh executor) never invokes the git
  // probe. Prevents an N-team query from spawning N subprocesses when every
  // team is healthy — matches pattern-5's "no-op when no zombies" discipline.
  test('does not invoke git probe when every team is within the idle window', async () => {
    let probeCalls = 0;
    const probe: GitProbeFn = async (row): Promise<GitProbeResult> => {
      probeCalls++;
      return probeAhead3(row);
    };
    const detector = createTeamUnpushedOrphanedWorktreeDetector({
      idleMinutes: 10,
      query: async () => [stalledRow({ last_executor_active_ms: FRESH_EXECUTOR_MS })],
      gitProbe: probe,
    });

    await runDetectorOnce(detector);

    expect(probeCalls).toBe(0);
  });
});
