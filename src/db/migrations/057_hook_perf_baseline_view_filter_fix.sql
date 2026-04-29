-- 057_hook_perf_baseline_view_filter_fix.sql — fix #1494 residual
--
-- Background: #1492 (the schema fix) accepts the new `event` key emitted by
-- runHandler post-#1485, so hook.delivery spans now insert into
-- genie_runtime_events without rejection. But dog-fooder-11eb's verdict
-- (state/evidence/followups-1490-1491-1493/REPORT.md) flagged a SECOND
-- bug: the hook_perf_baseline view created by migration 056 filters
-- `WHERE kind = 'hook.delivery'`, but the actual emitted row carries:
--
--   subject = 'hook.delivery'   ← what we want to filter on
--   kind    = 'system'          ← what the view incorrectly filters on
--   data->>'_kind' = 'span'     ← span marker
--
-- Net effect: rows accepted into the table never appear in the view, so
-- `genie doctor --perf` and `hook_perf_baseline` queries always returned
-- empty. The hookify-perf-foundation telemetry value (#1485) stayed inert.
--
-- Fix: replace the view to filter on `subject='hook.delivery'` AND require
-- `data->>'_kind' = 'span'` (so we only count completed spans, not other
-- runtime events that might happen to share the subject).

CREATE OR REPLACE VIEW hook_perf_baseline AS
WITH spans AS (
  SELECT
    COALESCE(data->>'event', '<unknown>')      AS event_name,
    COALESCE(data->>'tool',  '<none>')         AS tool_name,
    COALESCE(data->>'hook_name', '<unknown>')  AS handler_name,
    NULLIF(data->>'duration_ms', '')::numeric  AS duration_ms,
    created_at
  FROM genie_runtime_events
  WHERE subject = 'hook.delivery'
    AND data->>'_kind' = 'span'
    AND data ? 'duration_ms'
)
SELECT
  event_name,
  tool_name,
  handler_name,
  PERCENTILE_CONT(0.5)
    WITHIN GROUP (ORDER BY duration_ms)
    FILTER (WHERE created_at >= now() - interval '1 hour')   AS p50_1h,
  PERCENTILE_CONT(0.99)
    WITHIN GROUP (ORDER BY duration_ms)
    FILTER (WHERE created_at >= now() - interval '1 hour')   AS p99_1h,
  PERCENTILE_CONT(0.5)
    WITHIN GROUP (ORDER BY duration_ms)
    FILTER (WHERE created_at >= now() - interval '24 hours') AS p50_24h,
  PERCENTILE_CONT(0.99)
    WITHIN GROUP (ORDER BY duration_ms)
    FILTER (WHERE created_at >= now() - interval '24 hours') AS p99_24h,
  PERCENTILE_CONT(0.5)
    WITHIN GROUP (ORDER BY duration_ms)
    FILTER (WHERE created_at >= now() - interval '7 days')   AS p50_7d,
  PERCENTILE_CONT(0.99)
    WITHIN GROUP (ORDER BY duration_ms)
    FILTER (WHERE created_at >= now() - interval '7 days')   AS p99_7d,
  COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours')::bigint AS sample_count_24h
FROM spans
WHERE duration_ms IS NOT NULL
GROUP BY event_name, tool_name, handler_name;

COMMENT ON VIEW hook_perf_baseline IS
  'Rolling P50/P99 per (event, tool, handler) over 1h/24h/7d windows. Source: hook.delivery spans in genie_runtime_events (filtered by subject + data._kind=span). Fixed in #1494 residual / migration 057 — original migration 056 filtered the wrong column.';
