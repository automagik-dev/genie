/**
 * Detector: rot.zombie-team-lead — team-lead alive but its team went silent.
 *
 * Wish: Observability B1 rot-pattern detectors (Group 3a / Pattern 5).
 *
 * Symptom: a row in `agents` with `role='team-lead'` in a live state
 * (spawning/working/idle/permission/question) whose team has not emitted any
 * `wish.dispatch`, `mailbox.delivery`, or `agent.lifecycle` event with a
 * completion outcome in the last 5 minutes. The lead is polling `genie
 * status` on a team that has nothing to show.
 *
 * Behaviour:
 *   - `query()` joins live team-leads against the max(created_at) of
 *     progress events on the same team.
 *   - `shouldFire()` returns true when at least one team has last_activity
 *     older than the idleness threshold.
 *   - `render()` emits a single `rot.detected` per tick for the first
 *     offending team, carrying the team name, last activity timestamp, and
 *     computed minutes-idle in the evidence.
 *
 * Tuning knobs exposed via the factory so tests can drive deterministic
 * timing without waiting five real minutes.
 */

import { getConnection } from '../lib/db.js';
import { type DetectorEvent, type DetectorModule, registerDetector } from './index.js';
import { teamLeadPredicate } from './shared/team-leads.js';

/** Agent states that count as "alive and polling". Matches the PG CHECK constraint. */
const ALIVE_STATES = ['spawning', 'working', 'idle', 'permission', 'question'] as const;

/**
 * Event subjects that count as "team activity". We reuse the registry's own
 * type names to stay aligned with what the emit pipeline produces. Any new
 * progress-signalling event type added to the registry will need to be added
 * here too (caught by the test fixture when it exercises a representative
 * event and expects the detector NOT to fire).
 */
const ACTIVITY_SUBJECTS = ['wish.dispatch', 'mailbox.delivery', 'agent.lifecycle'] as const;

/** Default idleness threshold. */
const DEFAULT_IDLE_MINUTES = 5;

/** Row shape returned by the correlated query. */
interface ZombieRow {
  team: string;
  lead_agent_id: string;
  lead_state: string;
  /** Epoch-ms of the most recent activity event; null when no event ever fired on the team. */
  last_activity_ms: number | null;
  /** Epoch-ms the query was run — used to compute minutes_idle deterministically. */
  now_ms: number;
}

export interface ZombieTeamLeadState {
  readonly zombies: ReadonlyArray<ZombieRow>;
  readonly thresholdMs: number;
}

export function createZombieTeamLeadDetector(opts?: {
  query?: () => Promise<ZombieRow[]>;
  /** Override the idleness threshold (default 5 minutes). */
  idleMinutes?: number;
  version?: string;
}): DetectorModule<ZombieTeamLeadState> {
  const idleMinutes = opts?.idleMinutes ?? DEFAULT_IDLE_MINUTES;
  const thresholdMs = idleMinutes * 60 * 1000;
  const version = opts?.version ?? '0.1.0';

  const defaultQuery = async (): Promise<ZombieRow[]> => {
    const sql = await getConnection();
    // LEFT JOIN so teams with no activity row ever appear with last_activity_ms=null.
    // The subquery filters on `subject = ANY($ACTIVITY_SUBJECTS)` and uses
    // idx_runtime_events_team_id for the team scan. LIMIT 500 caps payload
    // when many leads are stuck simultaneously.
    const rows = (await sql`
      WITH active_leads AS (
        SELECT id, team, state
          FROM agents
         WHERE ${teamLeadPredicate(sql)}
           AND team IS NOT NULL
           AND state = ANY(${sql.array([...ALIVE_STATES])})
      ),
      last_activity AS (
        SELECT team, MAX(created_at) AS last_at
          FROM genie_runtime_events
         WHERE team IS NOT NULL
           AND subject = ANY(${sql.array([...ACTIVITY_SUBJECTS])})
         GROUP BY team
      )
      SELECT al.team                                           AS team,
             al.id                                             AS lead_agent_id,
             al.state                                          AS lead_state,
             EXTRACT(EPOCH FROM la.last_at) * 1000             AS last_activity_ms,
             EXTRACT(EPOCH FROM now()) * 1000                  AS now_ms
        FROM active_leads al
   LEFT JOIN last_activity la ON la.team = al.team
       ORDER BY al.team
       LIMIT 500
    `) as unknown as Array<{
      team: string;
      lead_agent_id: string;
      lead_state: string;
      last_activity_ms: number | string | null;
      now_ms: number | string;
    }>;

    return rows.map((r) => ({
      team: r.team,
      lead_agent_id: r.lead_agent_id,
      lead_state: r.lead_state,
      last_activity_ms: r.last_activity_ms === null ? null : Number(r.last_activity_ms),
      now_ms: Number(r.now_ms),
    }));
  };

  const queryFn = opts?.query ?? defaultQuery;

  return {
    id: 'rot.zombie-team-lead',
    version,
    riskClass: 'low',
    async query(): Promise<ZombieTeamLeadState> {
      const rows = await queryFn();
      const zombies = rows.filter((r) => {
        // Null last_activity => team has never emitted a progress event. If
        // the lead has been alive long enough that the bucket is older than
        // the threshold, count it as a zombie. We conservatively treat
        // null as "definitely stale" — the lead is the oldest fact we have.
        if (r.last_activity_ms === null) return true;
        return r.now_ms - r.last_activity_ms > thresholdMs;
      });
      return { zombies, thresholdMs };
    },
    shouldFire(state: ZombieTeamLeadState): boolean {
      return state.zombies.length > 0;
    },
    render(state: ZombieTeamLeadState): DetectorEvent {
      const row = state.zombies[0];
      const lastAtIso = row.last_activity_ms === null ? null : new Date(row.last_activity_ms).toISOString();
      const minutesIdle =
        row.last_activity_ms === null ? null : Math.floor((row.now_ms - row.last_activity_ms) / 60_000);
      return {
        type: 'rot.detected',
        subject: row.team,
        payload: {
          pattern_id: 'pattern-5-zombie-team-lead',
          entity_id: row.team,
          observed_state_json: {
            team_name: row.team,
            lead_agent_id: row.lead_agent_id,
            lead_state: row.lead_state,
            last_activity_at: lastAtIso,
            minutes_idle: minutesIdle,
            threshold_minutes: Math.floor(state.thresholdMs / 60_000),
            total_zombie_teams: state.zombies.length,
          },
        },
      };
    },
  };
}

// Canonical production instance — registered at module load via side effect.
registerDetector(createZombieTeamLeadDetector());
