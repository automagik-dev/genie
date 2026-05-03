-- 059_agent_observability_view.sql — canonical agent observability projection.
--
-- Wish 3/5 of PR-1607 observability roadmap (agent-observability-snapshot).
--
-- Background: every consumer surface (`genie status`, `genie agent show`,
-- TUI nav badges, app agent detail, app session list) used to rebuild
-- partial truth from `agents`, `executors`, `sessions`, `tool_events`,
-- `audit_events`, and `genie_runtime_events` with subtly different joins.
-- Three surfaces, three answers, no way for an operator (or another
-- agent) to ask "what is this agent doing right now" with one query.
--
-- This view is the one canonical projection. Every surface joins through
-- it (or through `agent-observability.ts` which selects from it). Reads
-- never mutate; never write audit events; never recompute the join.
--
-- Columns:
--   agent_id, custom_name, role, team, kind                   ← identity
--   current_executor_id, executor_state, executor_provider,    ← live executor
--     executor_transport, executor_pid, executor_tmux_pane,
--     executor_tmux_session, executor_started_at,
--     executor_updated_at, executor_ended_at, claude_session_id
--   session_id, session_status, session_started_at,            ← linked session
--     session_total_turns, session_executor_id, session_display_name
--   recent_tool_count, recent_error_count, recent_last_tool_at ← tool activity
--   recent_cost_usd, recent_input_tokens, recent_output_tokens ← usage
--   classification                                              ← agent | harness
--
-- The view fixed-windows tool/usage aggregates to the last 24h so it
-- stays fast as `tool_events` grows; consumers asking for longer
-- windows hit `tool_events` directly via the typed query module.
--
-- Session linkage cascade (mirrors fix-agent-session-linkage Wish 1):
--   1. Prefer the row in `sessions` whose `executor_id` matches the
--      agent's current executor (post-PR-1611 the canonical link).
--   2. Fall back to the session whose `claude_session_id` matches
--      `executors.claude_session_id` (legacy compat for rows written
--      before #1611 normalized session.executor_id).
--   3. Otherwise NULL — surfaced as the `missing_session` health flag
--      by the TS layer.
--
-- Classification: agents whose `id LIKE 'harness%'` or whose `role`
-- matches the harness sentinel are tagged `harness`; everything else
-- is `agent`. The view exposes both classes by default so callers can
-- filter via `WHERE classification = 'agent'`.

CREATE OR REPLACE VIEW v_agent_observability AS
WITH executor_link AS (
  -- Cascade: explicit session.executor_id link → claude_session_id fallback.
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
    -- Session linkage (cascade applied via two LEFT JOINs).
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
  -- 24h window keeps the join cheap on large tool_events tables.
  SELECT
    te.agent_id,
    COUNT(*)                                  AS recent_tool_count,
    COUNT(*) FILTER (WHERE te.is_error)       AS recent_error_count,
    MAX(te."timestamp")                       AS recent_last_tool_at
  FROM tool_events te
  WHERE te.agent_id IS NOT NULL
    AND te."timestamp" >= now() - INTERVAL '24 hours'
  GROUP BY te.agent_id
),
recent_usage AS (
  -- Aggregate over the same 24h window, keyed on the normalized
  -- v_claude_usage_events.agent_id (wish 2 G2 normalization).
  SELECT
    u.agent_id,
    SUM(u.cost_usd)            AS recent_cost_usd,
    SUM(u.input_tokens)        AS recent_input_tokens,
    SUM(u.output_tokens)       AS recent_output_tokens
  FROM v_claude_usage_events u
  WHERE u.agent_id IS NOT NULL
    AND u.created_at >= now() - INTERVAL '24 hours'
  GROUP BY u.agent_id
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
  COALESCE(ru.recent_cost_usd, 0)::numeric    AS recent_cost_usd,
  COALESCE(ru.recent_input_tokens, 0)::bigint AS recent_input_tokens,
  COALESCE(ru.recent_output_tokens, 0)::bigint AS recent_output_tokens,
  -- Classification: agent vs harness/system.
  -- The 'harness' sentinel is written by hooks/resolve-agent-name.ts when no
  -- agent context is present. Agent rows whose custom_name OR role match
  -- this sentinel surface as harness; everything else is a real agent.
  CASE
    WHEN el.custom_name = 'harness' OR el.role = 'harness' THEN 'harness'
    WHEN el.agent_id LIKE 'harness%' OR el.agent_id LIKE 'dir:harness%' THEN 'harness'
    ELSE 'agent'
  END AS classification
FROM executor_link el
LEFT JOIN recent_tools rt ON rt.agent_id = el.agent_id
LEFT JOIN recent_usage ru ON ru.agent_id = el.agent_id;

COMMENT ON VIEW v_agent_observability IS
  'Canonical agent observability projection. One row per agent joining identity, current executor, linked session, recent tool activity, and recent cost/usage. See migration 059 and src/lib/agent-observability.ts for the typed query API.';
