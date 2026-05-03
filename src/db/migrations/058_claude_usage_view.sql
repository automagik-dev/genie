-- 058_claude_usage_view.sql — normalize Claude cost/usage rows into one view.
--
-- Background (observability-signal-normalization, Group 2):
-- Claude cost telemetry lands in `audit_events` under two shapes:
--
--   1. OTel metric — emitted by the OTel receiver from `claude_code.cost.usage`
--      sum/gauge data points. Cost is stored under `details->>'value'`.
--      entity_type='otel_metric'. Entity_id is usually the Claude session UUID
--      (or 'agent:<name>' / 'unknown' when no session attribute is attached).
--
--   2. Legacy / fixture shape — historical rows (and current tests) that store
--      cost under `details->>'cost_usd'`. entity_type varies; usually keyed on
--      executor.id or a synthetic request id.
--
-- App + CLI cost queries previously only honored shape (2), so OTel cost rows
-- — the bulk of real traffic — silently summed to zero. This view is the one
-- canonical projection: callers read `cost_usd`, `model`, token columns,
-- `agent_id`, `executor_id`, `session_id`, `created_at` regardless of source
-- shape.
--
-- Scope: only `event_type = 'claude_code.cost.usage'` rows are exposed. Other
-- OTel logs (api_request, tool_result, …) keep their existing query paths;
-- this view does not try to be a universal cost ledger.

CREATE OR REPLACE VIEW v_claude_usage_events AS
SELECT
  ae.id,
  ae.entity_type,
  ae.entity_id,
  ae.event_type,
  ae.actor,
  COALESCE(NULLIF(ae.details->>'model', ''), 'unknown')                AS model,
  -- Prefer explicit cost_usd (legacy/test shape); fall back to OTel `value`.
  -- COALESCE before cast keeps NULLs in malformed rows from poisoning sums.
  COALESCE(
    NULLIF(ae.details->>'cost_usd', '')::numeric,
    NULLIF(ae.details->>'value',    '')::numeric,
    0::numeric
  )                                                                    AS cost_usd,
  NULLIF(ae.details->>'input_tokens',       '')::bigint                AS input_tokens,
  NULLIF(ae.details->>'output_tokens',      '')::bigint                AS output_tokens,
  NULLIF(ae.details->>'cache_read_tokens',  '')::bigint                AS cache_read_tokens,
  NULLIF(ae.details->>'cache_write_tokens', '')::bigint                AS cache_write_tokens,
  COALESCE(
    NULLIF(ae.actor, ''),
    NULLIF(ae.details->>'agent.name', ''),
    NULLIF(ae.details->>'agent_id', '')
  )                                                                    AS agent_id,
  -- executorId comes from SDK rows; legacy rows often key entity_id directly to executor.id.
  COALESCE(
    NULLIF(ae.details->>'executorId', ''),
    NULLIF(ae.details->>'executor_id', '')
  )                                                                    AS executor_id,
  -- session_id is set by the OTel receiver when the resource carries `session.id`.
  -- For OTel rows entity_id IS the session UUID, so fall back to it as a hint.
  COALESCE(
    NULLIF(ae.details->>'session_id', ''),
    NULLIF(ae.details->>'sessionId',  ''),
    CASE WHEN ae.entity_type = 'otel_metric' THEN NULLIF(ae.entity_id, '') END
  )                                                                    AS session_id,
  ae.details                                                           AS details,
  ae.created_at                                                        AS created_at
FROM audit_events ae
WHERE ae.event_type = 'claude_code.cost.usage';

COMMENT ON VIEW v_claude_usage_events IS
  'Normalized cost/usage projection over audit_events. Maps both OTel `claude_code.cost.usage` metric shape (details.value) and legacy/test cost_usd shape into a unified per-row API. See migration 058 for source of truth.';
