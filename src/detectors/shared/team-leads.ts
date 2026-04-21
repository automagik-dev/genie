/**
 * Shared team-lead identification primitives for rot detectors.
 *
 * Both the Pattern 5 (rot.zombie-team-lead) and Pattern 9
 * (rot.team-unpushed-orphaned-worktree) detectors need to identify which
 * rows in the `agents` table are team-leads. The historical predicate
 * `WHERE role = 'team-lead'` matched zero rows in production: the
 * `agents.role` column stores the agent's identity (e.g., `'brain'`,
 * `'engineer'`, `'felipe-alpha'`), not a role-type. Both detectors
 * shipped "dead" — Pattern 5 never fired, Pattern 9 emitted
 * `lead_agent_id=null` / `lead_state=null` in 100% of its events
 * (issues #1296 and #1298).
 *
 * The correct signal is parentage: the `reports_to` FK on `agents` is
 * set on child agents whose parent spawned them, so an agent `a` is a
 * team-lead when at least one other row has `reports_to = a.id`. The
 * column was added in migration `012_executor_model.sql` specifically
 * to encode this relationship. This predicate is the single source of
 * truth for "is this agent a team-lead?" and any future detector that
 * needs the same classification should import from here.
 */

import type { Sql } from '../../lib/db.js';

/**
 * SQL fragment: "this row in `agents` is a team-lead".
 *
 * Returns a postgres.js fragment compatible with tagged-template
 * interpolation — embed as `${teamLeadPredicate(sql)}` inside a
 * larger `sql\`\`` query. The fragment has no dynamic bindings, so the
 * cost of building it is negligible and the call is pure.
 *
 * Naming note: the fragment uses the unaliased column `id`, so the
 * caller's `FROM agents` (or a CTE with `agents` as the root table)
 * must not shadow that column. Every existing caller — Patterns 5
 * and 9 — already does `FROM agents` without aliasing, so this is a
 * drop-in replacement for the dead `role = 'team-lead'` predicate.
 */
export function teamLeadPredicate(sql: Sql) {
  return sql`id IN (SELECT DISTINCT reports_to FROM agents WHERE reports_to IS NOT NULL)`;
}
