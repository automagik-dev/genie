/**
 * Session-link diagnostics + (future) repair primitives.
 *
 * Group 1 of the `fix-agent-session-linkage` wish ships READ-ONLY queries
 * that quantify the current breakage so an operator can see the damage
 * before any mutation runs. Group 3 will layer
 * `genie sessions repair-links --dry-run/--apply` on top of these helpers.
 *
 * This module deliberately does NOT mutate data. Every function returns
 * counts or row samples, suitable to be wired into a future preview step.
 */

// biome-ignore lint/suspicious/noExplicitAny: postgres.js Sql type
type SqlClient = any;

// ============================================================================
// Diagnostics
// ============================================================================

export interface SessionLinkDiagnostics {
  /** Sessions whose id == executors.claude_session_id but executor_id is NULL. */
  linkableOrphanSessions: number;
  /** Total sessions table row count (sanity check / change ratio). */
  totalSessions: number;
  /** Sessions with status = 'orphaned'. */
  statusOrphanedSessions: number;
  /** Sessions with NULL executor_id (regardless of executors join). */
  nullExecutorIdSessions: number;
  /** tool_events rows. */
  totalToolEvents: number;
  /** tool_events missing agent_id (NULL or empty string). */
  toolEventsMissingAgent: number;
  /** tool_events missing team. */
  toolEventsMissingTeam: number;
  /** tool_events missing wish_slug. */
  toolEventsMissingWish: number;
  /** tool_events missing task_id. */
  toolEventsMissingTask: number;
  /** tool_events that are *linkable*: their session has a populated executor_id but the event row is missing attribution. */
  toolEventsLinkableMissingAttribution: number;
  /** Empty-string occurrences specifically — wish decision #4 says these should be NULL. */
  toolEventsEmptyStringAgent: number;
  toolEventsEmptyStringTeam: number;
  toolEventsEmptyStringWish: number;
  toolEventsEmptyStringTask: number;
  sessionsEmptyStringTeam: number;
  sessionsEmptyStringWishSlug: number;
  sessionsEmptyStringRole: number;
}

/**
 * Compute diagnostic counts. Pure read — no UPDATE / INSERT / DELETE.
 *
 * The intent is for `genie sessions repair-links --dry-run` to call this
 * (Group 3), print the numbers, and exit without touching the DB.
 */
export async function diagnoseSessionLinks(sql: SqlClient): Promise<SessionLinkDiagnostics> {
  const [linkableOrphanRow] = await sql`
    SELECT count(*)::int AS n
    FROM sessions s
    JOIN executors e ON s.id = e.claude_session_id
    WHERE s.executor_id IS NULL
  `;

  const [sessionRow] = await sql`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE status = 'orphaned')::int AS status_orphaned,
      count(*) FILTER (WHERE executor_id IS NULL)::int AS null_executor,
      count(*) FILTER (WHERE team = '')::int AS empty_team,
      count(*) FILTER (WHERE wish_slug = '')::int AS empty_wish_slug,
      count(*) FILTER (WHERE role = '')::int AS empty_role
    FROM sessions
  `;

  const [toolEventRow] = await sql`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE agent_id IS NULL OR agent_id = '')::int AS missing_agent,
      count(*) FILTER (WHERE team IS NULL OR team = '')::int AS missing_team,
      count(*) FILTER (WHERE wish_slug IS NULL OR wish_slug = '')::int AS missing_wish,
      count(*) FILTER (WHERE task_id IS NULL OR task_id = '')::int AS missing_task,
      count(*) FILTER (WHERE agent_id = '')::int AS empty_agent,
      count(*) FILTER (WHERE team = '')::int AS empty_team,
      count(*) FILTER (WHERE wish_slug = '')::int AS empty_wish,
      count(*) FILTER (WHERE task_id = '')::int AS empty_task
    FROM tool_events
  `;

  // tool_events whose owning session HAS attribution but the event row is missing it —
  // i.e. rows that a future backfill could safely repair from the linked session.
  const [linkableTeRow] = await sql`
    SELECT count(*)::int AS n
    FROM tool_events te
    JOIN sessions s ON s.id = te.session_id
    WHERE s.executor_id IS NOT NULL
      AND (
        (te.agent_id IS NULL OR te.agent_id = '') OR
        (te.team     IS NULL OR te.team     = '') OR
        (te.wish_slug IS NULL OR te.wish_slug = '') OR
        (te.task_id  IS NULL OR te.task_id  = '')
      )
  `;

  return {
    linkableOrphanSessions: Number(linkableOrphanRow?.n ?? 0),
    totalSessions: Number(sessionRow?.total ?? 0),
    statusOrphanedSessions: Number(sessionRow?.status_orphaned ?? 0),
    nullExecutorIdSessions: Number(sessionRow?.null_executor ?? 0),
    sessionsEmptyStringTeam: Number(sessionRow?.empty_team ?? 0),
    sessionsEmptyStringWishSlug: Number(sessionRow?.empty_wish_slug ?? 0),
    sessionsEmptyStringRole: Number(sessionRow?.empty_role ?? 0),
    totalToolEvents: Number(toolEventRow?.total ?? 0),
    toolEventsMissingAgent: Number(toolEventRow?.missing_agent ?? 0),
    toolEventsMissingTeam: Number(toolEventRow?.missing_team ?? 0),
    toolEventsMissingWish: Number(toolEventRow?.missing_wish ?? 0),
    toolEventsMissingTask: Number(toolEventRow?.missing_task ?? 0),
    toolEventsEmptyStringAgent: Number(toolEventRow?.empty_agent ?? 0),
    toolEventsEmptyStringTeam: Number(toolEventRow?.empty_team ?? 0),
    toolEventsEmptyStringWish: Number(toolEventRow?.empty_wish ?? 0),
    toolEventsEmptyStringTask: Number(toolEventRow?.empty_task ?? 0),
    toolEventsLinkableMissingAttribution: Number(linkableTeRow?.n ?? 0),
  };
}

// ============================================================================
// Sample helpers (read-only)
// ============================================================================

export interface OrphanSessionSample {
  sessionId: string;
  executorId: string;
  agentId: string | null;
  status: string | null;
}

/**
 * Return up to `limit` linkable orphan sessions for previewing what a
 * future `repair-links --dry-run` would update. Read-only.
 */
export async function sampleLinkableOrphanSessions(sql: SqlClient, limit = 20): Promise<OrphanSessionSample[]> {
  const rows = await sql`
    SELECT s.id AS session_id, e.id AS executor_id, e.agent_id, s.status
    FROM sessions s
    JOIN executors e ON s.id = e.claude_session_id
    WHERE s.executor_id IS NULL
    ORDER BY s.created_at DESC NULLS LAST
    LIMIT ${limit}
  `;
  return rows.map((r: { session_id: string; executor_id: string; agent_id: string | null; status: string | null }) => ({
    sessionId: r.session_id,
    executorId: r.executor_id,
    agentId: r.agent_id,
    status: r.status,
  }));
}

/**
 * Detect ambiguous matches — same `claude_session_id` claimed by multiple
 * executor rows. Group 3 must refuse `--apply` when this is non-zero
 * (or require `--force`) per the wish risk register.
 */
export async function findAmbiguousExecutorSessions(
  sql: SqlClient,
): Promise<{ claudeSessionId: string; executorIds: string[] }[]> {
  const rows = await sql`
    SELECT claude_session_id, array_agg(id) AS executor_ids
    FROM executors
    WHERE claude_session_id IS NOT NULL
    GROUP BY claude_session_id
    HAVING count(*) > 1
  `;
  return rows.map((r: { claude_session_id: string; executor_ids: string[] }) => ({
    claudeSessionId: r.claude_session_id,
    executorIds: r.executor_ids,
  }));
}
