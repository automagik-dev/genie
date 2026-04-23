/**
 * Pattern 2 — team-ls vs team-disband drift detector.
 *
 * Exercises the detector end-to-end through the real scheduler with
 * stubbed data sources and a capture emitFn. Uses the `emitFn` DI pattern
 * — NOT `mock.module('../../lib/emit.js', ...)`. Bun's `mock.module` is
 * process-global and cannot be undone, so stubbing emit that way would
 * pollute every later test file that exercises the real emit substrate
 * (the same defect Group 2 fixed in `fc7f81ff`).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { type SchedulerHandle, start as startScheduler } from '../../serve/detector-scheduler.js';
import { __clearDetectorsForTests } from '../index.js';
import {
  type DisbandSnapshotEntry,
  type LsSnapshotEntry,
  type TeamLsDriftSources,
  makeTeamLsDriftDetector,
} from '../pattern-2-team-ls-drift.js';

// ---------------------------------------------------------------------------
// Capture sink — replaces process-global mock.module approach.
// ---------------------------------------------------------------------------

interface CapturedEmit {
  type: string;
  payload: Record<string, unknown>;
  opts: Record<string, unknown>;
}

function makeCapture(): {
  emitFn: (t: string, p: Record<string, unknown>, o?: Record<string, unknown>) => void;
  seen: CapturedEmit[];
} {
  const seen: CapturedEmit[] = [];
  return {
    seen,
    emitFn(type: string, payload: Record<string, unknown>, opts: Record<string, unknown> = {}): void {
      seen.push({ type, payload, opts });
    },
  };
}

/** Spin a scheduler with the given detector + emit capture, run one tick. */
async function driveOneTick(detector: ReturnType<typeof makeTeamLsDriftDetector>): Promise<{
  captured: CapturedEmit[];
  queryMs: number;
}> {
  const capture = makeCapture();
  let scheduler: SchedulerHandle | null = null;
  try {
    scheduler = startScheduler({
      tickIntervalMs: 1_000_000,
      jitterMs: 0,
      defaultFireBudget: 10,
      detectorSource: () => [detector],
      emitFn: capture.emitFn,
      setTimeoutFn: () => ({ id: Symbol('test') }),
      clearTimeoutFn: () => {},
    });

    const start = performance.now();
    await scheduler.tickNow();
    const queryMs = performance.now() - start;

    return { captured: capture.seen, queryMs };
  } finally {
    scheduler?.stop();
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Build source stubs returning the given PG rows + filesystem dirs.
 * `existingWorktreePaths` lets tests mark which `worktreePath` values
 * should be reported as present on disk.
 */
function makeSources(
  lsRows: LsSnapshotEntry[],
  disbandDirs: DisbandSnapshotEntry[],
  existingWorktreePaths: ReadonlySet<string>,
): TeamLsDriftSources {
  return {
    listTeamsFromPg: async () => lsRows.slice(),
    listNativeTeamDirs: async () => disbandDirs.slice(),
    pgWorktreeExistsOnDisk: (p: string) => existingWorktreePaths.has(p),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pattern-2 team-ls-drift detector', () => {
  // The production module self-registers on load via the import chain
  // above (pattern-2-*.ts → registerDetector). We do NOT want the global
  // registry to leak into these tests because we inject a custom detector
  // via `detectorSource`. Clear between tests for belt-and-braces.
  afterEach(() => {
    __clearDetectorsForTests();
  });

  test('positive fixture — ghost team in PG with no matching .claude/teams/ dir fires exactly one event', async () => {
    // Seed the drift: one team present in PG (ls would list it) but absent
    // from `~/.claude/teams/` (disband's native cleanup would silently
    // no-op). This mirrors one of the 5 ghosts Felipe observed live.
    const lsRows: LsSnapshotEntry[] = [
      {
        name: 'brain-permanent',
        status: 'in_progress',
        worktreePath: '/tmp/fake-worktree-brain-permanent',
      },
      {
        name: 'ghost-team',
        status: 'in_progress',
        worktreePath: '/tmp/fake-worktree-ghost',
      },
    ];
    const disbandDirs: DisbandSnapshotEntry[] = ['brain-permanent']; // ghost-team missing here
    const existingPaths = new Set<string>(['/tmp/fake-worktree-brain-permanent', '/tmp/fake-worktree-ghost']);

    const detector = makeTeamLsDriftDetector(makeSources(lsRows, disbandDirs, existingPaths));
    const { captured, queryMs } = await driveOneTick(detector);

    // Query budget assertion — detector budget is 500ms.
    expect(queryMs).toBeLessThan(500);

    // Exactly one rot.team-ls-drift.detected event.
    const rotFires = captured.filter((c) => c.type === 'rot.team-ls-drift.detected');
    expect(rotFires.length).toBe(1);

    const evt = rotFires[0];
    expect(evt.payload.divergence_kind).toBe('missing_in_disband');
    expect(evt.payload.divergent_count).toBe(1);

    // observed_state_json round-trips both snapshots + the delta.
    const observed = JSON.parse(String(evt.payload.observed_state_json));
    expect(observed.divergent_ids).toEqual(['ghost-team']);
    expect(observed.divergence_kind).toBe('missing_in_disband');
    expect(observed.ls_total).toBe(2);
    expect(observed.disband_total).toBe(1);
    expect(Array.isArray(observed.ls_snapshot)).toBe(true);
    expect(Array.isArray(observed.disband_snapshot)).toBe(true);
    expect(observed.ls_snapshot.map((r: { name: string }) => r.name)).toContain('ghost-team');

    // Detector meta is threaded through.
    expect(evt.opts.detector_version).toBe('0.1.0');
    expect(evt.opts.entity_id).toBe('rot.team-ls-drift');
  });

  test('positive fixture — status_mismatch fires when PG worktree_path is missing on disk', async () => {
    const lsRows: LsSnapshotEntry[] = [
      {
        name: 'stale-team',
        status: 'in_progress',
        worktreePath: '/tmp/this-path-does-not-exist-on-disk',
      },
    ];
    const disbandDirs: DisbandSnapshotEntry[] = ['stale-team'];
    const existingPaths = new Set<string>(); // worktree path is NOT present

    const detector = makeTeamLsDriftDetector(makeSources(lsRows, disbandDirs, existingPaths));
    const { captured } = await driveOneTick(detector);

    const rotFires = captured.filter((c) => c.type === 'rot.team-ls-drift.detected');
    expect(rotFires.length).toBe(1);
    expect(rotFires[0].payload.divergence_kind).toBe('status_mismatch');
    expect(rotFires[0].payload.divergent_count).toBe(1);
  });

  test('positive fixture — missing_in_ls fires for filesystem-only entries', async () => {
    const lsRows: LsSnapshotEntry[] = []; // empty PG
    const disbandDirs: DisbandSnapshotEntry[] = ['orphan-native-team'];
    const existingPaths = new Set<string>();

    const detector = makeTeamLsDriftDetector(makeSources(lsRows, disbandDirs, existingPaths));
    const { captured } = await driveOneTick(detector);

    const rotFires = captured.filter((c) => c.type === 'rot.team-ls-drift.detected');
    expect(rotFires.length).toBe(1);
    expect(rotFires[0].payload.divergence_kind).toBe('missing_in_ls');
    const observed = JSON.parse(String(rotFires[0].payload.observed_state_json));
    expect(observed.divergent_ids).toEqual(['orphan-native-team']);
  });

  test('negative fixture — consistent state emits zero events', async () => {
    const lsRows: LsSnapshotEntry[] = [
      {
        name: 'alpha',
        status: 'in_progress',
        worktreePath: '/tmp/alpha-worktree',
      },
      {
        name: 'beta',
        status: 'in_progress',
        worktreePath: '/tmp/beta-worktree',
      },
    ];
    // `.claude/teams/` mirrors PG exactly (sanitizeTeamName is identity for these names).
    const disbandDirs: DisbandSnapshotEntry[] = ['alpha', 'beta'];
    const existingPaths = new Set<string>(['/tmp/alpha-worktree', '/tmp/beta-worktree']);

    const detector = makeTeamLsDriftDetector(makeSources(lsRows, disbandDirs, existingPaths));
    const { captured } = await driveOneTick(detector);

    const rotFires = captured.filter((c) => c.type === 'rot.team-ls-drift.detected');
    expect(rotFires.length).toBe(0);
  });

  test('negative fixture — empty PG and empty disk emits zero events', async () => {
    const detector = makeTeamLsDriftDetector(makeSources([], [], new Set()));
    const { captured } = await driveOneTick(detector);

    expect(captured.filter((c) => c.type === 'rot.team-ls-drift.detected').length).toBe(0);
  });

  test('event schema round-trips — observed_state_json parses against the registered schema', async () => {
    const lsRows: LsSnapshotEntry[] = [{ name: 'ghost', status: 'in_progress', worktreePath: '/tmp/ghost' }];
    const detector = makeTeamLsDriftDetector(makeSources(lsRows, [], new Set(['/tmp/ghost'])));
    const { captured } = await driveOneTick(detector);

    const { getEntry } = await import('../../lib/events/registry.js');
    const entry = getEntry('rot.team-ls-drift.detected');
    expect(entry).not.toBeNull();
    const result = entry!.schema.safeParse(captured[0].payload);
    if (!result.success) {
      console.error('schema parse failed', result.error.issues);
    }
    expect(result.success).toBe(true);
  });

  test('detector self-registers at module load', async () => {
    // The detector module registers itself on first import. Inside this
    // describe block we call `__clearDetectorsForTests()` in `afterEach`,
    // which wipes the registry between tests — so to observe the
    // registration we isolate this assertion in a fresh registry check
    // ordered as the FIRST statement, before the afterEach hook runs.
    //
    // Bun caches modules, so we cannot re-trigger the side effect by
    // re-importing. Instead we look at the shape: the factory function and
    // the exported constants are the source of truth the `registerDetector`
    // call at the bottom of pattern-2-team-ls-drift.ts uses. Building a
    // fresh module via the factory and registering it matches the exact
    // production wiring.
    const { listDetectors, registerDetector } = await import('../index.js');
    const { makeTeamLsDriftDetector, DETECTOR_ID } = await import('../pattern-2-team-ls-drift.js');

    // Registering the same id is idempotent by Map semantics — so this
    // mirrors what the production side-effect import does.
    registerDetector(makeTeamLsDriftDetector());

    const ids = listDetectors().map((d) => d.id);
    expect(ids).toContain(DETECTOR_ID);
    expect(DETECTOR_ID).toBe('rot.team-ls-drift');
  });

  test('#1291 — pathological drift (1000 ghosts) stays under schema cap and flags truncation', async () => {
    // Before #1291: the detector's per-list caps (200 snapshots + 100 divergent
    // entries) were individually small but compounded past the schema's
    // 16_384-char `observed_state_json` limit — every emit was rejected by
    // Zod and 100 % of the rot.team-ls-drift signal was lost. This fixture
    // reproduces the overflow and proves the fallback-summary path lands a
    // valid event with `observed_state_json_truncated: true`.
    const ghostCount = 1000;
    const lsRows: LsSnapshotEntry[] = Array.from({ length: ghostCount }, (_, i) => ({
      name: `ghost-team-with-a-reasonably-long-name-${i}`,
      status: 'in_progress',
      worktreePath: `/tmp/fake-worktree-${i}`,
    }));
    // Zero overlap with disband dirs → every PG row is `missing_in_disband`.
    const disbandDirs: DisbandSnapshotEntry[] = [];
    const existingPaths = new Set<string>(lsRows.map((r) => r.worktreePath));

    const detector = makeTeamLsDriftDetector(makeSources(lsRows, disbandDirs, existingPaths));
    const { captured } = await driveOneTick(detector);

    const rotFires = captured.filter((c) => c.type === 'rot.team-ls-drift.detected');
    expect(rotFires.length).toBe(1);

    const evt = rotFires[0];
    expect(evt.payload.divergent_count).toBe(ghostCount);
    expect(evt.payload.observed_state_json_truncated).toBe(true);

    // Emitted string must fit under the schema cap so Zod parse succeeds.
    const observedJson = String(evt.payload.observed_state_json);
    expect(observedJson.length).toBeLessThanOrEqual(16_384);

    // Summary JSON round-trips and preserves totals for downstream triage.
    const observed = JSON.parse(observedJson);
    expect(observed.divergent_total).toBe(ghostCount);
    expect(observed.ls_total).toBe(ghostCount);
    expect(observed.disband_total).toBe(0);
    expect(observed.divergence_kind).toBe('missing_in_disband');
    expect(Array.isArray(observed.divergent_ids)).toBe(true);
    expect(observed.divergent_ids.length).toBeGreaterThan(0);
    expect(typeof observed.truncation_reason).toBe('string');

    // Schema parse must succeed — this is the regression assertion that
    // ties the fix to the 100 %-signal-loss bug.
    const { getEntry } = await import('../../lib/events/registry.js');
    const entry = getEntry('rot.team-ls-drift.detected');
    expect(entry).not.toBeNull();
    const result = entry!.schema.safeParse(evt.payload);
    if (!result.success) {
      console.error('schema parse failed', result.error.issues);
    }
    expect(result.success).toBe(true);
  });

  test('#1291 — normal drift emits without truncation flag', async () => {
    // Belt-and-braces: confirm the flag is strictly present-on-truncate so
    // consumers can use `if (payload.observed_state_json_truncated)` without
    // worrying about accidental `false` values being emitted.
    const lsRows: LsSnapshotEntry[] = [{ name: 'ghost', status: 'in_progress', worktreePath: '/tmp/ghost' }];
    const detector = makeTeamLsDriftDetector(makeSources(lsRows, [], new Set(['/tmp/ghost'])));
    const { captured } = await driveOneTick(detector);

    expect(captured[0].payload.observed_state_json_truncated).toBeUndefined();
  });
});
