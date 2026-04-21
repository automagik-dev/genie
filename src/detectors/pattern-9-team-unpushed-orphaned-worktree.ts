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
 *   3. The git probe returns `ok:true` with `branch_ahead_count > 0` — real
 *      unpushed work exists on disk. Missing worktrees, missing base_branch,
 *      timeouts, and non-zero git exits all degrade to `ok:false` and are
 *      silently skipped (row stays eligible for the next tick).
 *
 * Behaviour:
 *   - `query()` reads candidate teams, filters in-memory by liveness, caps
 *     probed batch at `maxTeamsPerTick` (default 32), and probes git for each
 *     survivor. Idle rows beyond the cap are counted as stragglers and
 *     surfaced via `total_stalled_teams` so the operator sees backlog depth.
 *   - `shouldFire()` true when at least one probed team has branch_ahead_count > 0.
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
import { teamLeadPredicate } from './shared/team-leads.js';

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
export interface TeamUnpushedRow {
  /** PG teams.name — also the subject of the emitted event. */
  readonly team_name: string;
  /** Current teams.status — carried through to evidence so operators can triage. */
  readonly status: string;
  /** Absolute path to the team's worktree on disk. */
  readonly worktree_path: string;
  /** base_branch the worktree was cut from. Null tolerated — probe degrades to ok:false. */
  readonly base_branch: string | null;
  /** Current team-lead agent id (if any). Advisory — used only for evidence. */
  readonly lead_agent_id: string | null;
  /** Current team-lead executor/agent state. Evidence only; null when unknown. */
  readonly lead_state: string | null;
  /** Epoch-ms of the most recent `running`/`spawning` activity across the team; null when never seen. */
  readonly last_executor_active_ms: number | null;
  /** Epoch-ms the query was run — used to compute `minutes_since_active` deterministically. */
  readonly now_ms: number;
}

/**
 * Result of the per-team git probe. `ok=false` covers every non-happy path
 * (timeout, missing worktree, malformed base_branch, non-zero exit, parse
 * error). The detector treats `ok=false` as "unknown → do not fire" and moves
 * on — the row stays eligible for the next tick.
 */
export interface GitProbeResult {
  /** True when the probe produced a usable answer. False degrades to "do not fire". */
  readonly ok: boolean;
  /** Count of commits on HEAD that are not in origin/<base_branch>. */
  readonly branch_ahead_count: number;
  /** Epoch-ms of the tip commit, or null when the probe could not read it. */
  readonly last_commit_ms: number | null;
  /** Optional error label — purely informational, never emitted in payload. */
  readonly error?: string;
}

/** Injected git probe contract — production default shells out to `git`. */
export type GitProbeFn = (row: TeamUnpushedRow) => Promise<GitProbeResult>;

/** Shape of a single team after all three predicates have been confirmed via git. */
interface StalledTeamRow {
  readonly row: TeamUnpushedRow;
  readonly branchAheadCount: number;
  readonly lastCommitMs: number | null;
}

export interface TeamUnpushedOrphanedWorktreeState {
  /** Rows the detector confirmed ALL three predicates for. render() picks stalled[0]. */
  readonly stalled: ReadonlyArray<StalledTeamRow>;
  /** Count of idle candidates that were capped out of this tick (still stalled, not probed). */
  readonly idleUnprobed: number;
  /** Configured threshold (used in evidence). */
  readonly idleMinutes: number;
}

/** Default fs check — stat as directory. Tests bypass this via the injected gitProbe. */
function defaultWorktreeExists(path: string): boolean {
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

/** Invoke the ahead+tip probes and package them as a `GitProbeResult`. */
async function probeWorktree(worktreePath: string, baseBranch: string, timeoutMs: number): Promise<GitProbeResult> {
  const aheadStr = await runGit(worktreePath, ['rev-list', '--count', `origin/${baseBranch}..HEAD`], timeoutMs);
  const aheadCount = Number.parseInt(aheadStr, 10);
  if (!Number.isFinite(aheadCount)) {
    return { ok: false, branch_ahead_count: 0, last_commit_ms: null, error: 'parse_error' };
  }
  if (aheadCount <= 0) {
    return { ok: true, branch_ahead_count: 0, last_commit_ms: null };
  }
  const tipIso = await runGit(worktreePath, ['log', '-1', '--format=%cI', 'HEAD'], timeoutMs);
  const tipMs = tipIso ? Date.parse(tipIso) : Number.NaN;
  return {
    ok: true,
    branch_ahead_count: aheadCount,
    last_commit_ms: Number.isFinite(tipMs) ? tipMs : null,
  };
}

/** Build a production git probe bound to a timeout. Factored out so tests inject their own. */
function makeDefaultGitProbe(gitTimeoutMs: number): GitProbeFn {
  return async (row) => {
    if (!row.base_branch || !row.worktree_path) {
      return { ok: false, branch_ahead_count: 0, last_commit_ms: null, error: 'malformed_path' };
    }
    if (!defaultWorktreeExists(row.worktree_path)) {
      return { ok: false, branch_ahead_count: 0, last_commit_ms: null, error: 'missing_worktree' };
    }
    try {
      return await probeWorktree(row.worktree_path, row.base_branch, gitTimeoutMs);
    } catch (err) {
      const error = (err as NodeJS.ErrnoException | undefined)?.code ?? 'probe_error';
      return { ok: false, branch_ahead_count: 0, last_commit_ms: null, error };
    }
  };
}

export function createTeamUnpushedOrphanedWorktreeDetector(opts?: {
  query?: () => Promise<TeamUnpushedRow[]>;
  gitProbe?: GitProbeFn;
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

  const defaultQuery = async (): Promise<TeamUnpushedRow[]> => {
    const sql = await getConnection();
    // live_activity aggregates the max executor updated_at per team for the
    // running/spawning states only. We intentionally skip 'idle'/'working' —
    // those lean toward "polling quietly" which pattern-5 already covers.
    // LEFT JOIN so teams that never produced a live executor surface with NULL.
    // Also LEFT JOIN the current team-lead agent row for evidence continuity.
    const rows = (await sql`
      WITH live_activity AS (
        SELECT a.team AS team, MAX(e.updated_at) AS last_active
          FROM agents a
          JOIN executors e ON e.agent_id = a.id
         WHERE a.team IS NOT NULL
           AND e.state = ANY(${sql.array([...LIVE_EXECUTOR_STATES])})
         GROUP BY a.team
      ),
      team_leads AS (
        SELECT DISTINCT ON (team) team, id AS lead_agent_id, state AS lead_state
          FROM agents
         WHERE ${teamLeadPredicate(sql)}
           AND team IS NOT NULL
         ORDER BY team, created_at DESC
      )
      SELECT t.name                                          AS team_name,
             t.status                                        AS status,
             t.worktree_path                                 AS worktree_path,
             t.base_branch                                   AS base_branch,
             tl.lead_agent_id                                AS lead_agent_id,
             tl.lead_state                                   AS lead_state,
             EXTRACT(EPOCH FROM la.last_active) * 1000       AS last_executor_active_ms,
             EXTRACT(EPOCH FROM now()) * 1000                AS now_ms
        FROM teams t
   LEFT JOIN live_activity la ON la.team = t.name
   LEFT JOIN team_leads tl    ON tl.team = t.name
       WHERE t.status <> ALL(${sql.array([...EXEMPT_TEAM_STATUSES])})
       ORDER BY t.updated_at DESC
       LIMIT 500
    `) as unknown as Array<{
      team_name: string;
      status: string;
      worktree_path: string;
      base_branch: string | null;
      lead_agent_id: string | null;
      lead_state: string | null;
      last_executor_active_ms: number | string | null;
      now_ms: number | string;
    }>;

    return rows.map((r) => ({
      team_name: r.team_name,
      status: r.status,
      worktree_path: r.worktree_path,
      base_branch: r.base_branch,
      lead_agent_id: r.lead_agent_id,
      lead_state: r.lead_state,
      last_executor_active_ms: r.last_executor_active_ms === null ? null : Number(r.last_executor_active_ms),
      now_ms: Number(r.now_ms),
    }));
  };

  const queryFn = opts?.query ?? defaultQuery;

  const isIdlePastThreshold = (row: TeamUnpushedRow): boolean => {
    if (row.last_executor_active_ms === null) return true;
    return row.now_ms - row.last_executor_active_ms > thresholdMs;
  };

  const probeOne = async (row: TeamUnpushedRow): Promise<StalledTeamRow | null> => {
    const probe = await gitProbe(row);
    if (!probe.ok || probe.branch_ahead_count <= 0) return null;
    return { row, branchAheadCount: probe.branch_ahead_count, lastCommitMs: probe.last_commit_ms };
  };

  return {
    id: 'rot.team-unpushed-orphaned-worktree',
    version,
    riskClass: 'low',
    async query(): Promise<TeamUnpushedOrphanedWorktreeState> {
      const candidates = await queryFn();
      const idle = candidates.filter(isIdlePastThreshold);
      // Cap probe batch so one runaway tick cannot spawn hundreds of git
      // subprocesses. Stragglers re-evaluate next tick.
      const batch = idle.slice(0, maxTeamsPerTick);
      const idleUnprobed = idle.length - batch.length;
      const stalled: StalledTeamRow[] = [];
      for (const row of batch) {
        const result = await probeOne(row);
        if (result !== null) stalled.push(result);
      }
      return { stalled, idleUnprobed, idleMinutes };
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
      const lastCommitIso = first.lastCommitMs === null ? null : new Date(first.lastCommitMs).toISOString();
      // Total reflects both the probed-and-confirmed rows AND the idle rows
      // we capped out of this tick. Operators reading the payload see how much
      // work is queued for subsequent ticks.
      const totalStalledTeams = state.stalled.length + state.idleUnprobed;
      return {
        type: 'rot.detected',
        subject: row.team_name,
        payload: {
          pattern_id: 'pattern-9-team-unpushed-orphaned-worktree',
          entity_id: row.team_name,
          observed_state_json: {
            team_name: row.team_name,
            team_status: row.status,
            worktree_path: row.worktree_path,
            base_branch: row.base_branch ?? '',
            branch_ahead_count: first.branchAheadCount,
            last_commit_at: lastCommitIso,
            last_executor_active_at: lastExecutorActiveIso,
            minutes_since_active: minutesSinceActive,
            threshold_minutes: state.idleMinutes,
            lead_agent_id: row.lead_agent_id,
            lead_state: row.lead_state,
            total_stalled_teams: totalStalledTeams,
          },
        },
      };
    },
  };
}

// Canonical production instance — registered at module load via side effect.
registerDetector(createTeamUnpushedOrphanedWorktreeDetector());
