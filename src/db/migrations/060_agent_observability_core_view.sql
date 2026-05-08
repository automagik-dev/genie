-- 060_agent_observability_core_view.sql — cost-independent companion view.
--
-- Wish 3/5 (agent-observability-snapshot) Group 2 follow-up.
--
-- The full `v_agent_observability` view defined by migration 059 joins
-- `v_claude_usage_events` for the `recent_cost_usd` / `recent_input_tokens`
-- / `recent_output_tokens` columns. `v_claude_usage_events` does numeric
-- casts over `audit_events.details` JSONB, which on certain pgserve
-- installs (notably worktree pgserves missing the timezonesets share
-- directory; documented across wish 2 and wish 3 reports) errors out with
-- `could not open directory "...timezonesets"`.
--
-- That defect is purely environmental — production-pgserve hosts evaluate
-- the cost CTE without issue — but it forces the TypeScript query layer
-- (`src/lib/agent-observability.ts`) to fall back to a degraded query that
-- skips cost data. This view is that fallback target. Same identity /
-- executor / session / tool-event projection as the canonical view, with
-- the cost columns omitted entirely so postgres never visits
-- `v_claude_usage_events` or `audit_events`.
--
-- Consumers should always prefer `v_agent_observability` first; only the
-- TypeScript fallback path reads this view directly.

CREATE OR REPLACE VIEW v_agent_observability_core AS
WITH executor_link AS (
  SELECT
    a.id                                   AS agent_id,
    a.custom_name                          AS custom_name,
    a.role                                 AS role,
    a.team                                 AS team,
    a.kind                                 AS kind,
    a.state                                AS agent_state,
    a.started_at                           AS agent_started_at,
    a.updated_at                           AS agent_updated_at,
    a.current_executor_id                  AS current_executor_id,
    e.id                                   AS executor_id,
    e.state                                AS executor_state,
    e.provider                             AS executor_provider,
    e.transport                            AS executor_transport,
    e.pid                                  AS executor_pid,
    e.tmux_pane_id                         AS executor_tmux_pane,
    e.tmux_session                         AS executor_tmux_session,
    e.started_at                           AS executor_started_at,
    e.updated_at                           AS executor_updated_at,
    e.ended_at                             AS executor_ended_at,
    e.claude_session_id                    AS claude_session_id,
    COALESCE(s_by_exec.id, s_by_claude.id)                 AS session_id,
    COALESCE(s_by_exec.status, s_by_claude.status)         AS session_status,
    COALESCE(s_by_exec.started_at, s_by_claude.started_at) AS session_started_at,
    COALESCE(s_by_exec.total_turns, s_by_claude.total_turns) AS session_total_turns,
    COALESCE(s_by_exec.executor_id, s_by_claude.executor_id) AS session_executor_id,
    COALESCE(s_by_exec.display_name, s_by_claude.display_name) AS session_display_name,
    CASE
      WHEN s_by_exec.id IS NOT NULL THEN 'executor_id'
      WHEN s_by_claude.id IS NOT NULL THEN 'claude_session_id'
      ELSE NULL
    END                                                    AS session_link_source
  FROM agents a
  LEFT JOIN executors e
    ON e.id = a.current_executor_id
  LEFT JOIN sessions s_by_exec
    ON s_by_exec.executor_id = e.id
   AND s_by_exec.ended_at IS NULL
  LEFT JOIN sessions s_by_claude
    ON s_by_exec.id IS NULL
   AND s_by_claude.claude_session_id = e.claude_session_id
   AND s_by_claude.claude_session_id IS NOT NULL
   AND s_by_claude.ended_at IS NULL
),
recent_tools AS (
  SELECT
    te.agent_id,
    COUNT(*)                                  AS recent_tool_count,
    COUNT(*) FILTER (WHERE te.is_error)       AS recent_error_count,
    MAX(te."timestamp")                       AS recent_last_tool_at
  FROM tool_events te
  WHERE te.agent_id IS NOT NULL
    AND te."timestamp" >= now() - INTERVAL '24 hours'
  GROUP BY te.agent_id
)
SELECT
  el.agent_id,
  el.custom_name,
  el.role,
  el.team,
  el.kind,
  el.agent_state,
  el.agent_started_at,
  el.agent_updated_at,
  el.current_executor_id,
  el.executor_id,
  el.executor_state,
  el.executor_provider,
  el.executor_transport,
  el.executor_pid,
  el.executor_tmux_pane,
  el.executor_tmux_session,
  el.executor_started_at,
  el.executor_updated_at,
  el.executor_ended_at,
  el.claude_session_id,
  el.session_id,
  el.session_status,
  el.session_started_at,
  el.session_total_turns,
  el.session_executor_id,
  el.session_display_name,
  el.session_link_source,
  COALESCE(rt.recent_tool_count, 0)::bigint   AS recent_tool_count,
  COALESCE(rt.recent_error_count, 0)::bigint  AS recent_error_count,
  rt.recent_last_tool_at                      AS recent_last_tool_at,
  CASE
    WHEN el.custom_name = 'harness' OR el.role = 'harness' THEN 'harness'
    WHEN el.agent_id LIKE 'harness%' OR el.agent_id LIKE 'dir:harness%' THEN 'harness'
    ELSE 'agent'
  END AS classification
FROM executor_link el
LEFT JOIN recent_tools rt ON rt.agent_id = el.agent_id;

COMMENT ON VIEW v_agent_observability_core IS
  'Cost-free projection over identity/executor/session/tool_events. Used as fallback by src/lib/agent-observability.ts when v_claude_usage_events evaluation hits the recurring pgserve timezonesets/plpgsql install defect documented in wish 2 / wish 3 reports.';
