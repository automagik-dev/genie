/**
 * Detector: rot.backfill-no-worktree — team rows whose worktree directory
 * vanished on disk.
 *
 * Wish: Observability B1 rot-pattern detectors (Group 3a / Pattern 1).
 *
 * Symptom: a row exists in `teams` with status='in_progress' and a
 * `worktree_path` that no longer points at a directory. Causes include
 * operator `rm -rf` on the worktree, disk-full truncation, or a backfill
 * migration that populated `teams` from JSON without validating the fs.
 *
 * Behaviour:
 *   - `query()` reads every in_progress team row and stat()s each worktree.
 *   - `shouldFire()` returns true when at least one row has a missing path.
 *   - `render()` emits a single `rot.detected` event for the first offending
 *     row. The scheduler contract is one event per tick; the next tick picks
 *     up the next offender after the budget window rolls.
 *
 * V1 is measurement only — never mutates the teams table or touches the
 * filesystem with anything other than `fs.statSync`.
 */

import { statSync } from 'node:fs';
import { getConnection } from '../lib/db.js';
import { type DetectorEvent, type DetectorModule, registerDetector } from './index.js';

/** Result row shape returned by the query. */
interface TeamRow {
  name: string;
  status: string;
  worktree_path: string;
}

/** Shape threaded from `query()` into `shouldFire()` / `render()`. */
export interface BackfillNoWorktreeState {
  readonly missing: ReadonlyArray<TeamRow>;
}

/**
 * Single place the filesystem is consulted. Extracted so tests can inject a
 * deterministic stub instead of touching the real fs. Production default is
 * `node:fs.statSync` with a try/catch — statSync throws on ENOENT.
 */
type WorktreeExistsCheck = (path: string) => boolean;

const defaultWorktreeExistsCheck: WorktreeExistsCheck = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Factory so tests can override the query / fs-check without poking at
 * module-level state. Production callers import the pre-built `detector`
 * constant at the bottom of the file.
 */
export function createBackfillNoWorktreeDetector(opts?: {
  query?: () => Promise<TeamRow[]>;
  exists?: WorktreeExistsCheck;
  version?: string;
}): DetectorModule<BackfillNoWorktreeState> {
  const exists = opts?.exists ?? defaultWorktreeExistsCheck;
  const version = opts?.version ?? '0.1.0';

  const defaultQuery = async (): Promise<TeamRow[]> => {
    const sql = await getConnection();
    // Narrow column list; relies on idx_teams_status for the WHERE filter.
    // Capped at 1000 rows so a stuck detector can never load the whole table
    // into memory — the scheduler's fire budget still enforces downstream.
    const rows = (await sql`
      SELECT name, status, worktree_path
        FROM teams
       WHERE status = 'in_progress'
       ORDER BY updated_at DESC
       LIMIT 1000
    `) as unknown as TeamRow[];
    return rows;
  };

  const queryFn = opts?.query ?? defaultQuery;

  return {
    id: 'rot.backfill-no-worktree',
    version,
    riskClass: 'low',
    async query(): Promise<BackfillNoWorktreeState> {
      const rows = await queryFn();
      const missing = rows.filter((r) => !exists(r.worktree_path));
      return { missing };
    },
    shouldFire(state: BackfillNoWorktreeState): boolean {
      return state.missing.length > 0;
    },
    render(state: BackfillNoWorktreeState): DetectorEvent {
      // Per-tick contract: one event per fire. We pick the first offending
      // row; the next tick re-runs the query and picks the next.
      const row = state.missing[0];
      return {
        type: 'rot.detected',
        subject: row.name,
        payload: {
          pattern_id: 'pattern-1-backfill-no-worktree',
          entity_id: row.name,
          observed_state_json: {
            team_name: row.name,
            status: row.status,
            expected_worktree_path: row.worktree_path,
            fs_exists: false,
            total_missing: state.missing.length,
          },
        },
      };
    },
  };
}

// Canonical production instance — registered at module load via side effect.
registerDetector(createBackfillNoWorktreeDetector());
