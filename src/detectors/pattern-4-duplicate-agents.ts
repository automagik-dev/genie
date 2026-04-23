/**
 * Detector: rot.duplicate-agents — agents sharing `(custom_name, team)` when
 * both are non-null.
 *
 * Wish: Observability B1 rot-pattern detectors (Group 3a / Pattern 4).
 *
 * Symptom: two or more non-archived rows in `agents` with the same
 * `(custom_name, team)` pair. Migration 012 added a partial unique index
 * `idx_agents_custom_name_team` going forward (`WHERE custom_name IS NOT NULL
 * AND team IS NOT NULL`), but any pre-constraint residue that was already in
 * the table at migration time survived — the index only prevents NEW
 * violators. This detector surfaces the backlog so an operator can reconcile
 * (merge, archive, or rename one of the duplicates).
 *
 * Behaviour:
 *   - `query()` groups agents by `(custom_name, team)` with count > 1.
 *   - `shouldFire()` returns true when at least one offending pair exists.
 *   - `render()` emits a single `rot.detected` per tick for the first
 *     offending pair, carrying all duplicate agent_ids in the evidence.
 *
 * V1 is measurement only. The detector never writes to `agents` and never
 * offers a fix suggestion in the payload — a human decides how to merge.
 */

import { getConnection } from '../lib/db.js';
import { type DetectorEvent, type DetectorModule, registerDetector } from './index.js';

/** Aggregated row shape returned by the GROUP BY query. */
interface DuplicateRow {
  custom_name: string;
  team: string;
  dup_count: number;
  agent_ids: string[];
}

/** Shape threaded from `query()` into `shouldFire()` / `render()`. */
export interface DuplicateAgentsState {
  readonly duplicates: ReadonlyArray<DuplicateRow>;
}

/**
 * Factory so tests can override the query. Production callers import the
 * pre-built `detector` constant at the bottom of the file.
 */
export function createDuplicateAgentsDetector(opts?: {
  query?: () => Promise<DuplicateRow[]>;
  version?: string;
}): DetectorModule<DuplicateAgentsState> {
  const version = opts?.version ?? '0.1.0';

  const defaultQuery = async (): Promise<DuplicateRow[]> => {
    const sql = await getConnection();
    // GROUP BY uses the partial index idx_agents_custom_name_team for the
    // NOT-NULL filter. array_agg returns duplicate ids so the event has
    // actionable triage data without a second round-trip. LIMIT 200 caps
    // worst-case payload when the table genuinely has hundreds of dupes.
    const rows = (await sql`
      SELECT custom_name,
             team,
             COUNT(*)::int AS dup_count,
             array_agg(id ORDER BY created_at) AS agent_ids
        FROM agents
       WHERE custom_name IS NOT NULL
         AND team IS NOT NULL
       GROUP BY custom_name, team
      HAVING COUNT(*) > 1
       ORDER BY COUNT(*) DESC, custom_name ASC
       LIMIT 200
    `) as unknown as DuplicateRow[];
    return rows;
  };

  const queryFn = opts?.query ?? defaultQuery;

  return {
    id: 'rot.duplicate-agents',
    version,
    riskClass: 'low',
    async query(): Promise<DuplicateAgentsState> {
      const duplicates = await queryFn();
      return { duplicates };
    },
    shouldFire(state: DuplicateAgentsState): boolean {
      return state.duplicates.length > 0;
    },
    render(state: DuplicateAgentsState): DetectorEvent {
      const row = state.duplicates[0];
      // Subject is the `(team/custom_name)` pair — unique per fire so the
      // scheduler's hashed entity_id still disambiguates across repeats.
      const subject = `${row.team}/${row.custom_name}`;
      return {
        type: 'rot.detected',
        subject,
        payload: {
          pattern_id: 'pattern-4-duplicate-agents',
          entity_id: subject,
          observed_state_json: {
            team: row.team,
            custom_name: row.custom_name,
            dup_count: row.dup_count,
            agent_ids: row.agent_ids,
            total_offending_pairs: state.duplicates.length,
          },
        },
      };
    },
  };
}

// Canonical production instance — registered at module load via side effect.
registerDetector(createDuplicateAgentsDetector());
