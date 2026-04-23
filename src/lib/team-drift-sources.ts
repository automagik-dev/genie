/**
 * Team drift sources — the two divergent data paths the
 * `rot.team-ls-drift` detector observes.
 *
 * These adapters exist so the detector stays testable without pulling a
 * live PG connection or a real `~/.claude/teams/` directory. Production
 * callers get the real implementations here; tests pass their own stubs
 * via the detector's `TeamLsDriftSources` DI.
 *
 * Wish: genie-self-healing-observability-b1-detectors (Group 3b).
 */

import { existsSync } from 'node:fs';
import type { LsSnapshotEntry } from '../detectors/pattern-2-team-ls-drift.js';
import * as nativeTeamsManager from './claude-native-teams.js';
import { listTeams as pgListTeams } from './team-manager.js';

/**
 * Read the exact data `genie team ls` shows the operator — the non-archived
 * PG rows. Mirrors `src/term-commands/team.ts:printTeams` →
 * `teamManager.listTeams(includeArchived=false)`.
 */
export async function listTeamsFromPg(): Promise<LsSnapshotEntry[]> {
  const rows = await pgListTeams(false);
  return rows.map((row) => ({
    name: row.name,
    status: row.status,
    worktreePath: row.worktreePath,
  }));
}

/**
 * Read the filesystem side of `genie team disband` — the `~/.claude/teams/`
 * directory listing. `disbandTeam` ends by calling
 * `nativeTeamsManager.deleteNativeTeam(name)` which rm-rfs
 * `~/.claude/teams/<sanitizeTeamName(name)>/`. The matching read path is
 * `nativeTeamsManager.listTeams()`.
 */
export async function listNativeTeamDirs(): Promise<string[]> {
  return nativeTeamsManager.listTeams();
}

/**
 * Replicate the check `pruneStaleWorktrees` performs inside `disbandTeam`:
 * a PG row with a non-existent `worktree_path` will be silently DELETEd
 * the next time any team is disbanded. The detector flags this as a
 * `status_mismatch` so operators see the stale ls snapshot coming.
 */
export function pgWorktreeExistsOnDisk(worktreePath: string): boolean {
  return existsSync(worktreePath);
}
