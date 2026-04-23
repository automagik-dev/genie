-- docs/observability-acid-tests.sql — retroactive-reconstruction queries
-- Wish: genie-serve-structured-observability (Group 7).
--
-- Goal: prove the structured event substrate can reconstruct each of the six
-- "rot" patterns and five dispatch bugs called out in the umbrella DRAFT, from
-- raw rows in `genie_runtime_events` + `genie_runtime_events_audit` alone.
--
-- Layout: each query is bracketed by `-- @pattern: <id>` ... `-- @end-pattern`
-- markers so test/observability/acid-test.ts can extract a single pattern's
-- query at a time. Standalone usage (manual operator pull):
--
--   psql -f docs/observability-acid-tests.sql \
--        -v since="'24 hours'" -v pattern=all
--
-- All queries are read-only.
--
-- Conventions:
--   * `subject` carries the closed event-registry type (e.g. 'mailbox.delivery').
--     emit.ts writes `kind='system'` for every row; channel-split derives the
--     prefix from `subject`, not `kind`. Filter by `subject` exclusively.
--   * Trace correlation lives at `data->>'_trace_id'` (Group 2 scaffold) AND in
--     the `trace_id` column (Group 1 enrichment). Queries COALESCE both so a
--     row written by either path is visible.
--   * Every query is parameterized by a single psql variable `:since`, an
--     INTERVAL string (e.g. '24 hours'). The bun test substitutes a fresh value
--     when running each query against a per-test fixture window.

\set ON_ERROR_STOP on

\if :{?since}
\else
  \set since '24 hours'
\endif
\if :{?pattern}
\else
  \set pattern all
\endif

\echo === acid tests — since :since pattern :pattern ===

-- ---------------------------------------------------------------------------
-- Rot Patterns (6)
-- ---------------------------------------------------------------------------

-- @pattern: rot.1.backfilled-teams-without-worktree
-- A team.create row landed in the WORM audit table but no cli.command /
-- wish.dispatch span exists for the same trace within ±5 minutes — i.e. the
-- team was injected by an out-of-band backfiller, not via `genie team create`
-- (and therefore likely has no worktree).
\echo --- rot.1.backfilled-teams-without-worktree ---
SELECT
  a.id,
  a.created_at,
  a.data->>'team_name'                                AS team_name,
  COALESCE(a.trace_id::text, a.data->>'_trace_id')    AS trace_id
FROM genie_runtime_events_audit a
WHERE a.subject = 'team.create'
  AND a.created_at >= now() - (:'since')::interval
  AND NOT EXISTS (
    SELECT 1
      FROM genie_runtime_events e
     WHERE e.subject IN ('cli.command', 'wish.dispatch')
       AND COALESCE(e.trace_id::text, e.data->>'_trace_id')
         = COALESCE(a.trace_id::text, a.data->>'_trace_id')
       AND e.created_at BETWEEN a.created_at - INTERVAL '5 minutes'
                            AND a.created_at + INTERVAL '5 minutes'
  )
ORDER BY a.created_at ASC;
-- @end-pattern

-- @pattern: rot.2.team-ls-disband-drift
-- Teams that were created (audit) but never disbanded; the team-ls/disband
-- drift surfaces as audit rows for team.create with no matching team.disband
-- entry, regardless of whether the team-ls cli.command shows them as alive.
\echo --- rot.2.team-ls-disband-drift ---
WITH created AS (
  SELECT
    data->>'team_name'    AS team_name,
    MAX(created_at)       AS created_at
  FROM genie_runtime_events_audit
  WHERE subject = 'team.create'
    AND created_at >= now() - (:'since')::interval
  GROUP BY data->>'team_name'
),
disbanded AS (
  SELECT
    data->>'team_name'    AS team_name,
    MAX(created_at)       AS disband_at
  FROM genie_runtime_events_audit
  WHERE subject = 'team.disband'
  GROUP BY data->>'team_name'
)
SELECT
  c.team_name,
  c.created_at,
  d.disband_at
FROM created c
LEFT JOIN disbanded d ON d.team_name = c.team_name
WHERE d.disband_at IS NULL
   OR d.disband_at < c.created_at  -- last disband predates the latest create (re-created without prior disband)
ORDER BY c.created_at ASC;
-- @end-pattern

-- @pattern: rot.3.ghost-anchors-no-session
-- agent.lifecycle span recorded but no session.id.written for the same agent
-- arrived within 10 minutes — the worker was registered in PG but never anchored
-- to a real executor session (a "ghost anchor").
\echo --- rot.3.ghost-anchors-no-session ---
SELECT
  al.id,
  al.created_at,
  al.agent,
  COALESCE(al.trace_id::text, al.data->>'_trace_id')  AS trace_id
FROM genie_runtime_events al
WHERE al.subject = 'agent.lifecycle'
  AND al.created_at >= now() - (:'since')::interval
  AND NOT EXISTS (
    SELECT 1
      FROM genie_runtime_events siw
     WHERE siw.subject = 'session.id.written'
       AND siw.agent   = al.agent
       AND siw.created_at BETWEEN al.created_at
                              AND al.created_at + INTERVAL '10 minutes'
  )
ORDER BY al.created_at ASC;
-- @end-pattern

-- @pattern: rot.4.duplicate-custom-name-anchors
-- Multiple agent.lifecycle spans whose public agent_id label collides — the
-- "duplicate custom-name anchor" pathology where two workers share a name in
-- the same window so the spawn lookup is non-deterministic.
\echo --- rot.4.duplicate-custom-name-anchors ---
SELECT
  data->>'agent_id'                                   AS agent_id,
  COUNT(*)                                            AS spawn_count,
  MIN(created_at)                                     AS first_seen,
  MAX(created_at)                                     AS last_seen
FROM genie_runtime_events
WHERE subject = 'agent.lifecycle'
  AND data->>'agent_id' IS NOT NULL
  AND created_at >= now() - (:'since')::interval
GROUP BY data->>'agent_id'
HAVING COUNT(*) > 1
ORDER BY spawn_count DESC, first_seen ASC;
-- @end-pattern

-- @pattern: rot.5.zombie-team-lead-polling
-- Spans/events for a team-lead that fired AFTER the team.disband recorded in
-- the audit table — the worker kept polling/executing even though the team is
-- supposedly torn down.
\echo --- rot.5.zombie-team-lead-polling ---
WITH disbanded AS (
  SELECT
    data->>'team_name'  AS team_name,
    MAX(created_at)     AS disband_at
  FROM genie_runtime_events_audit
  WHERE subject = 'team.disband'
  GROUP BY data->>'team_name'
)
SELECT
  e.id,
  e.created_at,
  e.team,
  e.agent,
  e.subject              AS event_type,
  d.disband_at
FROM genie_runtime_events e
JOIN disbanded d
  ON d.team_name = e.team
WHERE e.subject IN ('hook.delivery', 'executor.write', 'executor.row.written', 'mailbox.delivery')
  AND e.created_at > d.disband_at + INTERVAL '60 seconds'
  AND e.created_at >= now() - (:'since')::interval
  AND (
       e.agent ILIKE '%team-lead%'
    OR e.agent ILIKE '%team_lead%'
    OR (e.data->>'_source_subsystem') ILIKE '%team-lead%'
  )
ORDER BY e.created_at ASC;
-- @end-pattern

-- @pattern: rot.6.orphan-subagent-cascade
-- A child agent.lifecycle span whose parent_span_id refers to a parent span
-- that has already ended (parent payload carries an exit_reason). The child
-- outlives its parent → orphan cascade.
\echo --- rot.6.orphan-subagent-cascade ---
SELECT
  child.id                                              AS child_id,
  parent.id                                             AS parent_id,
  child.agent                                           AS child_agent,
  parent.agent                                          AS parent_agent,
  child.created_at                                      AS child_at,
  parent.created_at                                     AS parent_at,
  parent.data->>'exit_reason'                           AS parent_exit_reason
FROM genie_runtime_events child
JOIN genie_runtime_events parent
  ON  COALESCE(parent.span_id::text, parent.data->>'_span_id')
    = COALESCE(child.parent_span_id::text, child.data->>'_parent_span_id')
WHERE child.subject  = 'agent.lifecycle'
  AND parent.subject = 'agent.lifecycle'
  AND parent.data->>'exit_reason' IS NOT NULL  -- parent has finished
  AND child.created_at  > parent.created_at
  AND child.created_at >= now() - (:'since')::interval
ORDER BY child.created_at ASC;
-- @end-pattern

-- ---------------------------------------------------------------------------
-- Dispatch Bugs (5) — labelled A..E to mirror the umbrella DRAFT.
-- ---------------------------------------------------------------------------

-- @pattern: dispatch.A.parser-review-false-match
-- wish.dispatch where the parser matched a "review" wave but the actor running
-- it is not the reviewer (parser false-positive on a substring match).
\echo --- dispatch.A.parser-review-false-match ---
SELECT
  id,
  created_at,
  data->>'group_name'      AS group_name,
  data->>'actor'           AS actor,
  data->>'wish_slug'       AS wish_slug
FROM genie_runtime_events
WHERE subject = 'wish.dispatch'
  AND data->>'group_name' ILIKE '%review%'
  AND COALESCE(data->>'actor', '') NOT ILIKE '%review%'
  AND created_at >= now() - (:'since')::interval
ORDER BY created_at ASC;
-- @end-pattern

-- @pattern: dispatch.B.reset-no-clear-wave-state
-- A wish state_transition into 'reset' followed within 5 minutes by a
-- wish.dispatch with wave > 0 sharing the same trace — the reset did not
-- actually clear the wave counter.
\echo --- dispatch.B.reset-no-clear-wave-state ---
WITH resets AS (
  SELECT
    id,
    created_at,
    COALESCE(trace_id::text, data->>'_trace_id') AS trace_id
  FROM genie_runtime_events
  WHERE subject = 'state_transition'
    AND data->>'entity_kind' = 'wish'
    AND data->>'to'          = 'reset'
    AND created_at >= now() - (:'since')::interval
)
SELECT
  r.id                                                  AS reset_id,
  r.created_at                                          AS reset_at,
  wd.id                                                 AS dispatch_id,
  wd.created_at                                         AS dispatch_at,
  (wd.data->>'wave')::int                               AS wave_after_reset,
  wd.data->>'wish_slug'                                 AS wish_slug
FROM resets r
JOIN genie_runtime_events wd
  ON wd.subject = 'wish.dispatch'
 AND COALESCE(wd.trace_id::text, wd.data->>'_trace_id') = r.trace_id
 AND wd.created_at  > r.created_at
 AND wd.created_at <= r.created_at + INTERVAL '5 minutes'
 AND (wd.data->>'wave')::int > 0
ORDER BY r.created_at ASC;
-- @end-pattern

-- @pattern: dispatch.C.pg-vs-cache-status-drift
-- Two state_transition rows for the same entity within 60 seconds where the
-- second transition's `from` ≠ the first transition's `to` — i.e. the second
-- writer started from a stale cached state.
\echo --- dispatch.C.pg-vs-cache-status-drift ---
SELECT
  a.id                          AS first_id,
  b.id                          AS second_id,
  a.data->>'entity_kind'        AS entity_kind,
  a.data->>'entity_id'          AS entity_id,
  a.data->>'to'                 AS first_to,
  b.data->>'from'               AS second_from,
  a.created_at                  AS first_at,
  b.created_at                  AS second_at
FROM genie_runtime_events a
JOIN genie_runtime_events b
  ON  b.subject               = 'state_transition'
 AND  a.data->>'entity_kind'  = b.data->>'entity_kind'
 AND  a.data->>'entity_id'    = b.data->>'entity_id'
 AND  b.created_at  > a.created_at
 AND  b.created_at <= a.created_at + INTERVAL '60 seconds'
 AND  a.data->>'to' IS NOT NULL
 AND  b.data->>'from' IS NOT NULL
 AND  a.data->>'to' <> b.data->>'from'
WHERE a.subject = 'state_transition'
  AND a.created_at >= now() - (:'since')::interval
ORDER BY a.created_at ASC;
-- @end-pattern

-- @pattern: dispatch.D.spawn-bypass-state-machine
-- agent.lifecycle span emitted with no preceding state_transition for the
-- same worker/team_lead within 5 minutes — spawn went straight to the
-- executor without being routed through the wish/team state machine.
\echo --- dispatch.D.spawn-bypass-state-machine ---
SELECT
  al.id,
  al.agent,
  al.team,
  al.created_at,
  COALESCE(al.trace_id::text, al.data->>'_trace_id')   AS trace_id
FROM genie_runtime_events al
WHERE al.subject = 'agent.lifecycle'
  AND al.agent IS NOT NULL
  AND al.created_at >= now() - (:'since')::interval
  AND NOT EXISTS (
    SELECT 1
      FROM genie_runtime_events st
     WHERE st.subject = 'state_transition'
       AND st.data->>'entity_kind' IN ('worker', 'team_lead', 'team', 'group')
       AND st.agent = al.agent
       AND st.created_at BETWEEN al.created_at - INTERVAL '5 minutes'
                             AND al.created_at
  )
ORDER BY al.created_at ASC;
-- @end-pattern

-- @pattern: dispatch.E.agent-ready-timer-mismeasure
-- agent.lifecycle span with an unrealistically tiny duration_ms (< 100ms) but
-- ≥3 hook.delivery events fired by the same agent in the 60 seconds after
-- the span started — the "agent ready" timer was closed before the agent had
-- actually become ready.
\echo --- dispatch.E.agent-ready-timer-mismeasure ---
SELECT
  al.id,
  al.agent,
  al.created_at,
  COALESCE(
    al.duration_ms,
    NULLIF(al.data->>'_duration_ms', '')::int
  )                                                     AS duration_ms,
  (
    SELECT COUNT(*)
      FROM genie_runtime_events h
     WHERE h.subject = 'hook.delivery'
       AND h.agent   = al.agent
       AND h.created_at BETWEEN al.created_at
                            AND al.created_at + INTERVAL '60 seconds'
  )                                                     AS hooks_in_first_minute
FROM genie_runtime_events al
WHERE al.subject = 'agent.lifecycle'
  AND COALESCE(al.duration_ms, NULLIF(al.data->>'_duration_ms','')::int, 99999) < 100
  AND al.created_at >= now() - (:'since')::interval
  AND (
    SELECT COUNT(*)
      FROM genie_runtime_events h
     WHERE h.subject = 'hook.delivery'
       AND h.agent   = al.agent
       AND h.created_at BETWEEN al.created_at
                            AND al.created_at + INTERVAL '60 seconds'
  ) >= 3
ORDER BY al.created_at ASC;
-- @end-pattern

\echo === acid tests complete ===
