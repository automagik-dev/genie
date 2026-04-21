/**
 * Detector: rot.team-unpushed-orphaned-worktree — a team finished local work
 * but its worktree still has commits ahead of origin and no live executor is
 * making forward progress.
 *
 * Wish: team-unpushed-orphaned-worktree (Pattern 9).
 *
 * Symptom: an autonomous `team create --wish <slug>` team completes its work
 * locally (engineers commit), then the leader pane exits before `git push` /
 * PR creation. The worktree sits with commits ahead of origin; no existing
 * detector fires. The operator only discovers it hours later when auditing
 * manually.
 *
 * Predicates (all three must hold for a team to be reported):
 *   1. `teams.status NOT IN ('done','blocked','archived')` — still nominally
 *      active; operator-set terminal states are respected. Enforced in SQL so
 *      terminal-state rows never reach the in-memory filter.
 *   2. No agent on the team has an executor in `running` / `spawning` state
 *      within the last `idleMinutes` window (default 10 — double pattern-5's
 *      5min so the two detectors span different windows).
 *   3. The worktree at `teams.worktree_path` exists on disk AND has
 *      `git rev-list --count origin/<base_branch>..HEAD > 0` — real unpushed
 *      work exists.
 *
 * Behaviour:
 *   - `query()` reads candidate teams, filters in-memory by liveness + path
 *     sanity, caps at `maxTeamsPerTick` (default 32), and probes git for
 *     each survivor.
 *   - `shouldFire()` true when at least one probed team has aheadCount > 0.
 *   - `render()` emits one `rot.detected` per tick for the first stalled team,
 *     carrying the evidence an operator needs for a one-liner salvage.
 *
 * V1 is measurement only. The detector never pushes, never mutates files,
 * never invokes git commands beyond read-only introspection. A future
 * `genie team rescue` command can consume the emitted events and decide its
 * own safety policy.
 *
 * Tuning knobs exposed via the factory so tests can drive deterministic
 * timing without spinning up real git repos or real subprocesses.
 */

import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { getConnection } from '../lib/db.js';
import { type DetectorEvent, type DetectorModule, registerDetector } from './index.js';

/** Executor states that count as "alive and making progress". Matches migration 012 CHECK. */
const LIVE_EXECUTOR_STATES = ['running', 'spawning'] as const;

/** Team statuses that suppress the detector — operator-set terminal states. */
const EXEMPT_TEAM_STATUSES = ['done', 'blocked', 'archived'] as const;

/** Default idleness threshold — double pattern-5's 5min so the two detectors span different windows. */
const DEFAULT_IDLE_MINUTES = 10;

/** Worst-case observed concurrent dispatch was 6 teams; 32 is a sane upper bound. */
const DEFAULT_MAX_TEAMS_PER_TICK = 32;

/** Longer than the slowest healthy `rev-list` observed (~200ms); short enough to not stall a tick. */
const DEFAULT_GIT_TIMEOUT_MS = 3_000;

/**
 * Candidate team row returned by the SQL query. The detector filters this
 * in-memory against the idleness threshold before probing git. Exported so
 * tests can type-check fixtures without reaching into private internals.
 */
export interface CandidateTeamRow {
  /** PG teams.name — also the subject of the emitted event. */
  readonly name: string;
  /** Current teams.status — carried through to evidence so operators can triage. */
  readonly status: string;
  /** Absolute path to the team's worktree on disk. */
  readonly worktree_path: string;
  /** base_branch the worktree was cut from. Empty string tolerated as "malformed". */
  readonly base_branch: string;
  /** Epoch-ms of the most recent `running`/`spawning` activity across the team; null when never seen. */
  readonly last_executor_active_ms: number | null;
  /** Epoch-ms the query was run — used to compute `minutes_since_active` deterministically. */
  readonly now_ms: number;
}

/**
 * Result of the per-team git probe. `ok=false` covers every non-happy path
 * (timeout, missing worktree, non-zero exit, parse error). The detector
 * treats `ok=false` as "unknown → do not fire" and moves on — the row stays
 * eligible for the next tick.
 */
export interface GitProbeResult {
  /** True when the probe produced a usable answer. False degrades to "do not fire". */
  readonly ok: boolean;
  /** Count of commits on HEAD that are not in origin/<base_branch>. */
  readonly aheadCount: number;
  /** ISO-8601 timestamp of the tip commit, or null when the probe could not read it. */
  readonly lastCommitAt: string | null;
}

/** Injected git probe contract — production default shells out to `git`. */
export type GitProbeFn = (worktreePath: string, baseBranch: string) => Promise<GitProbeResult>;

/** Injected fs existence probe — tests inject deterministic stubs. */
export type FsExistsFn = (path: string) => boolean;

/** Shape of a single team after all three predicates have been confirmed via git. */
interface StalledTeamRow {
  readonly row: CandidateTeamRow;
  readonly aheadCount: number;
  readonly lastCommitAt: string | null;
}

export interface TeamUnpushedOrphanedWorktreeState {
  /** Rows the detector confirmed ALL three predicates for. render() picks stalled[0]. */
  readonly stalled: ReadonlyArray<StalledTeamRow>;
  /** Configured threshold (used in evidence). */
  readonly idleMinutes: number;
}

/** Default fs check — stat as directory. Tests bypass this via `fsExists`. */
function defaultFsExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Run `git` in `cwd` with a bounded timeout. Rejects on any non-zero exit. */
function runGit(cwd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout).trim());
    });
    // Drain stderr silently so a git chatty-warning does not leak to the
    // detector log. The subprocess still exits cleanly through callback.
    child.stderr?.resume();
  });
}

/** Build a production git probe bound to a timeout. Factored out so tests inject their own. */
function makeDefaultGitProbe(gitTimeoutMs: number): GitProbeFn {
  return async (worktreePath, baseBranch) => {
    try {
      const aheadStr = await runGit(
        worktreePath,
        ['rev-list', '--count', `origin/${baseBranch}..HEAD`],
        gitTimeoutMs,
      );
      const aheadCount = Number.parseInt(aheadStr, 10);
      if (!Number.isFinite(aheadCount)) {
        return { ok: false, aheadCount: 0, lastCommitAt: null };
      }
      if (aheadCount <= 0) {
        return { ok: true, aheadCount: 0, lastCommitAt: null };
      }
      const tipIso = await runGit(worktreePath, ['log', '-1', '--format=%cI', 'HEAD'], gitTimeoutMs);
      return { ok: true, aheadCount, lastCommitAt: tipIso || null };
    } catch {
      return { ok: false, aheadCount: 0, lastCommitAt: null };
    }
  };
}

export function createTeamUnpushedOrphanedWorktreeDetector(opts?: {
  query?: () => Promise<CandidateTeamRow[]>;
  gitProbe?: GitProbeFn;
  fsExists?: FsExistsFn;
  idleMinutes?: number;
  maxTeamsPerTick?: number;
  gitTimeoutMs?: number;
  version?: string;
}): DetectorModule<TeamUnpushedOrphanedWorktreeState> {
  const idleMinutes = opts?.idleMinutes ?? DEFAULT_IDLE_MINUTES;
  const thresholdMs = idleMinutes * 60_000;
  const maxTeamsPerTick = opts?.maxTeamsPerTick ?? DEFAULT_MAX_TEAMS_PER_TICK;
  const gitTimeoutMs = opts?.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const version = opts?.version ?? '0.1.0';
  const gitProbe = opts?.gitProbe ?? makeDefaultGitProbe(gitTimeoutMs);
  const fsExists = opts?.fsExists ?? defaultFsExists;

  const defaultQuery = async (): Promise<CandidateTeamRow[]> => {
    const sql = await getConnection();
    // live_activity aggregates the max executor updated_at per team for the
    // running/spawning states only. We intentionally skip 'idle'/'working' —
    // those lean toward "polling quietly" which pattern-5 already covers.
    // LEFT JOIN so teams that never produced a live executor surface with NULL.
    const rows = (await sql`
      WITH live_activity AS (
        SELECT a.team AS team, MAX(e.updated_at) AS last_active
          FROM agents a
          JOIN executors e ON e.agent_id = a.id
         WHERE a.team IS NOT NULL
           AND e.state = ANY(${sql.array([...LIVE_EXECUTOR_STATES])})
         GROUP BY a.team
      )
      SELECT t.name                                          AS name,
             t.status                                        AS status,
             t.worktree_path                                 AS worktree_path,
             t.base_branch                                   AS base_branch,
             EXTRACT(EPOCH FROM la.last_active) * 1000       AS last_executor_active_ms,
             EXTRACT(EPOCH FROM now()) * 1000                AS now_ms
        FROM teams t
   LEFT JOIN live_activity la ON la.team = t.name
       WHERE t.status <> ALL(${sql.array([...EXEMPT_TEAM_STATUSES])})
       ORDER BY t.updated_at DESC
       LIMIT 500
    `) as unknown as Array<{
      name: string;
      status: string;
      worktree_path: string;
      base_branch: string | null;
      last_executor_active_ms: number | string | null;
      now_ms: number | string;
    }>;

    return rows.map((r) => ({
      name: r.name,
      status: r.status,
      worktree_path: r.worktree_path ?? '',
      base_branch: r.base_branch ?? '',
      last_executor_active_ms: r.last_executor_active_ms === null ? null : Number(r.last_executor_active_ms),
      now_ms: Number(r.now_ms),
    }));
  };

  const queryFn = opts?.query ?? defaultQuery;

  const isIdlePastThreshold = (row: CandidateTeamRow): boolean => {
    if (row.last_executor_active_ms === null) return true;
    return row.now_ms - row.last_executor_active_ms > thresholdMs;
  };

  const isStructurallyValid = (row: CandidateTeamRow): boolean =>
    row.worktree_path !== '' && row.base_branch !== '' && fsExists(row.worktree_path);

  const probeOne = async (row: CandidateTeamRow): Promise<StalledTeamRow | null> => {
    const probe = await gitProbe(row.worktree_path, row.base_branch);
    if (!probe.ok || probe.aheadCount <= 0) return null;
    return { row, aheadCount: probe.aheadCount, lastCommitAt: probe.lastCommitAt };
  };

  return {
    id: 'rot.team-unpushed-orphaned-worktree',
    version,
    riskClass: 'medium',
    async query(): Promise<TeamUnpushedOrphanedWorktreeState> {
      const candidates = await queryFn();
      const probable = candidates.filter((r) => isIdlePastThreshold(r) && isStructurallyValid(r));
      // Cap probe batch so one runaway tick cannot spawn hundreds of git
      // subprocesses. Stragglers re-evaluate next tick.
      const batch = probable.slice(0, maxTeamsPerTick);
      const stalled: StalledTeamRow[] = [];
      for (const row of batch) {
        const result = await probeOne(row);
        if (result !== null) stalled.push(result);
      }
      return { stalled, idleMinutes };
    },
    shouldFire(state: TeamUnpushedOrphanedWorktreeState): boolean {
      return state.stalled.length > 0;
    },
    render(state: TeamUnpushedOrphanedWorktreeState): DetectorEvent {
      const first = state.stalled[0];
      const row = first.row;
      const minutesSinceActive =
        row.last_executor_active_ms === null ? null : Math.floor((row.now_ms - row.last_executor_active_ms) / 60_000);
      const lastExecutorActiveIso =
        row.last_executor_active_ms === null ? null : new Date(row.last_executor_active_ms).toISOString();
      return {
        type: 'rot.detected',
        subject: row.name,
        payload: {
          pattern_id: 'pattern-9-team-unpushed-orphaned-worktree',
          entity_id: row.name,
          observed_state_json: {
            team_name: row.name,
            team_status: row.status,
            worktree_path: row.worktree_path,
            base_branch: row.base_branch,
            branch_ahead_count: first.aheadCount,
            last_commit_at: first.lastCommitAt,
            last_executor_active_at: lastExecutorActiveIso,
            minutes_since_active: minutesSinceActive,
            threshold_minutes: state.idleMinutes,
            total_stalled_teams: state.stalled.length,
          },
        },
      };
    },
  };
}

// Canonical production instance — registered at module load via side effect.
registerDetector(createTeamUnpushedOrphanedWorktreeDetector());
