-- 051_runtime_events_partition_drain.sql
-- Bug: genie_runtime_events_maintain_partitions never drained the DEFAULT
-- partition. Rows that landed in genie_runtime_events_default (e.g. inserts
-- after UTC midnight before the next maintenance call ran) permanently
-- blocked creation of new dated partitions, because PG validates that no
-- existing default-partition row would belong to the new partition. Symptom:
-- SQLSTATE 23514 "updated partition constraint for default partition
-- genie_runtime_events_default would be violated by some row" on every
-- subsequent `genie serve start`. Migration 038's docstring claimed the
-- nightly scheduler converted DEFAULT rows into named partitions; no such
-- code ever existed.
--
-- Fix:
--   1. New helper genie_runtime_events_drain_default() detaches DEFAULT,
--      ensures dated partitions exist for every day represented by its rows,
--      re-inserts the rows (parent-routing them to the correct dated
--      partition) with notify-trigger suppression, truncates the now-empty
--      detached default, and re-attaches it as DEFAULT.
--   2. genie_runtime_events_maintain_partitions calls drain_default() before
--      creating today..today+forward_days, so a stuck DEFAULT can no longer
--      poison subsequent partition creation.
--   3. One-shot drain at migration time so existing installs unstick on the
--      first post-upgrade `genie serve start`.

CREATE OR REPLACE FUNCTION genie_runtime_events_drain_default()
RETURNS INTEGER AS $$
DECLARE
  drained   INTEGER := 0;
  d_rec     RECORD;
  prev_role TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = 'genie_runtime_events_default'
       AND n.nspname = current_schema()
  ) THEN
    RETURN 0;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM genie_runtime_events_default LIMIT 1) THEN
    RETURN 0;
  END IF;

  -- Detach so the re-insert below routes to dated partitions instead of
  -- looping back into DEFAULT. Non-CONCURRENTLY form is transaction-safe.
  EXECUTE 'ALTER TABLE genie_runtime_events DETACH PARTITION genie_runtime_events_default';

  -- Ensure a dated partition exists for every day represented in the
  -- detached default. create_partition is CREATE TABLE IF NOT EXISTS, so
  -- pre-existing partitions are fine.
  FOR d_rec IN
    SELECT DISTINCT date_trunc('day', created_at)::DATE AS d
      FROM genie_runtime_events_default
  LOOP
    PERFORM genie_runtime_events_create_partition(d_rec.d);
  END LOOP;

  -- Suppress AFTER INSERT triggers (notify_runtime_event_split, audit chain
  -- triggers, etc.) for the drain. These rows already fired their notifies
  -- on their original insert; re-firing would broadcast duplicates to every
  -- LISTEN'er.
  prev_role := current_setting('session_replication_role');
  PERFORM set_config('session_replication_role', 'replica', true);

  EXECUTE $sql$
    INSERT INTO genie_runtime_events (
      id, repo_path, subject, kind, source, agent, team, direction, peer,
      text, data, thread_id, trace_id, parent_event_id, span_id, parent_span_id,
      severity, schema_version, duration_ms, dedup_key, source_subsystem, created_at
    )
    OVERRIDING SYSTEM VALUE
    SELECT id, repo_path, subject, kind, source, agent, team, direction, peer,
           text, data, thread_id, trace_id, parent_event_id, span_id, parent_span_id,
           severity, schema_version, duration_ms, dedup_key, source_subsystem, created_at
      FROM genie_runtime_events_default
  $sql$;

  GET DIAGNOSTICS drained = ROW_COUNT;

  PERFORM set_config('session_replication_role', prev_role, true);

  EXECUTE 'TRUNCATE genie_runtime_events_default';
  EXECUTE 'ALTER TABLE genie_runtime_events ATTACH PARTITION genie_runtime_events_default DEFAULT';

  RETURN drained;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION genie_runtime_events_maintain_partitions(
  forward_days   INTEGER DEFAULT 2,
  retention_days INTEGER DEFAULT 30
)
RETURNS JSONB AS $$
DECLARE
  drained INTEGER;
  created INTEGER := 0;
  dropped INTEGER := 0;
  i       INTEGER;
BEGIN
  -- Drain DEFAULT first so any rows that accumulated there (UTC-midnight
  -- rollover between maintenance calls) get routed to their proper dated
  -- partitions before we try to CREATE the new ones.
  drained := genie_runtime_events_drain_default();

  FOR i IN 0..forward_days LOOP
    PERFORM genie_runtime_events_create_partition((CURRENT_DATE + i)::DATE);
    created := created + 1;
  END LOOP;
  SELECT genie_runtime_events_drop_old_partitions(retention_days) INTO dropped;
  RETURN jsonb_build_object(
    'created_or_present',  created,
    'dropped',             dropped,
    'drained_from_default', drained,
    'next_rotation_at',    (CURRENT_DATE + 1)::TIMESTAMPTZ
  );
END;
$$ LANGUAGE plpgsql;

-- Mirror the role grants from migration 041 for the new helper. Conditional
-- so this works on installs that ran 041 before events_admin existed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'events_admin') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION genie_runtime_events_drain_default() TO events_admin';
  END IF;
END$$;

DO $$
DECLARE
  drained INTEGER;
BEGIN
  drained := genie_runtime_events_drain_default();
  IF drained > 0 THEN
    RAISE NOTICE 'genie_runtime_events_default: drained % stuck row(s) into dated partitions', drained;
  END IF;
END$$;
