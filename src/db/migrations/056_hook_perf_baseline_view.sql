-- 056_hook_perf_baseline_view.sql — rolling P50/P99 per (event, tool, handler)
--
-- Group 4 of wish hookify-perf-foundation. Surfaces per-handler latency
-- baselines so `genie doctor --perf` can flag regressions without anyone
-- having to write percentile SQL by hand.
--
-- Source data: every `hook.delivery` span emitted by src/hooks/index.ts
-- (lines 172-191) carries `data.duration_ms`, `data.hook_name`,
-- `data.tool`, and `data.event` — all populated by the in-daemon
-- dispatcher when GENIE_WIDE_EMIT is on (which Group 4 makes the default
-- for the hook subsystem).
--
-- Why a view, not a materialized view: rolling windows over the last 1h /
-- 24h / 7d are inherently moving targets; ON-DEMAND evaluation against the
-- existing time-bucket indexes on genie_runtime_events is faster than
-- maintaining materialized state. If the cost ever bites, swap to a
-- materialized view + scheduler-driven refresh; the schema is stable.

CREATE OR REPLACE VIEW hook_perf_baseline AS
WITH spans AS (
  SELECT
    COALESCE(data->>'event', '<unknown>')      AS event_name,
    COALESCE(data->>'tool',  '<none>')         AS tool_name,
    COALESCE(data->>'hook_name', '<unknown>')  AS handler_name,
    NULLIF(data->>'duration_ms', '')::numeric  AS duration_ms,
    created_at
  FROM genie_runtime_events
  WHERE kind = 'hook.delivery'
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
  'Rolling P50/P99 per (event, tool, handler) over 1h/24h/7d windows. Source: hook.delivery spans in genie_runtime_events. See wish hookify-perf-foundation Group 4.';
