-- 038_runtime_events_partition.sql — daily-partition genie_runtime_events
-- Wish: genie-serve-structured-observability (Group 1).
--
-- Strategy (copy-and-swap, no ATTACH):
--   PostgreSQL cannot convert a non-partitioned table to partitioned in-place.
--   We also cannot ATTACH the legacy table as a default partition because its
--   identity column and auto-named CHECK constraints are incompatible with the
--   parent. Instead:
--     1. Rename the current table to *_legacy_pre_partition (keeps the old
--        rows on disk for rollback).
--     2. CREATE TABLE *_partitioned with the same schema, PARTITION BY RANGE
--        (created_at).
--     3. Seed rolling daily partitions.
--     4. Copy rows from the legacy table into the new parent preserving ids
--        via OVERRIDING SYSTEM VALUE; the parent routes each row to its daily
--        partition by `created_at`.
--     5. Advance the parent's identity sequence past the legacy max id.
--     6. Re-create the LISTEN/NOTIFY trigger.
--   The legacy table is retained (not dropped) so operators can verify row
--   counts post-migration and hand-roll a rollback if needed. A later wish
--   drops it.
--
-- Idempotency: guarded by relkind='p' check on the canonical name.

-- ---------------------------------------------------------------------------
-- Helper: create one daily partition if it does not exist.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION genie_runtime_events_create_partition(target_date DATE)
RETURNS VOID AS $$
DECLARE
  part_name TEXT := 'genie_runtime_events_p' || to_char(target_date, 'YYYYMMDD');
  start_ts  TIMESTAMPTZ := target_date::TIMESTAMPTZ;
  end_ts    TIMESTAMPTZ := (target_date + 1)::TIMESTAMPTZ;
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF genie_runtime_events
       FOR VALUES FROM (%L) TO (%L)',
    part_name, start_ts, end_ts
  );
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Helper: detach + drop partitions older than retention_days.
-- Returns the number of partitions dropped.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION genie_runtime_events_drop_old_partitions(retention_days INTEGER DEFAULT 30)
RETURNS INTEGER AS $$
DECLARE
  cutoff_date DATE := (CURRENT_DATE - retention_days);
  rec         RECORD;
  dropped     INTEGER := 0;
BEGIN
  FOR rec IN
    SELECT c.relname
    FROM   pg_inherits i
    JOIN   pg_class   c ON i.inhrelid = c.oid
    JOIN   pg_class   p ON i.inhparent = p.oid
    WHERE  p.relname = 'genie_runtime_events'
      AND  c.relname ~ '^genie_runtime_events_p[0-9]{8}$'
      AND  to_date(substring(c.relname from 'p([0-9]{8})$'), 'YYYYMMDD') < cutoff_date
  LOOP
    EXECUTE format('ALTER TABLE genie_runtime_events DETACH PARTITION %I', rec.relname);
    EXECUTE format('DROP TABLE %I', rec.relname);
    dropped := dropped + 1;
  END LOOP;
  RETURN dropped;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Helper: rolling-window maintenance. Creates today..today+N partitions,
-- drops partitions older than retention_days. Intended to be called by the
-- scheduler-daemon nightly cron.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION genie_runtime_events_maintain_partitions(
  forward_days INTEGER DEFAULT 2,
  retention_days INTEGER DEFAULT 30
)
RETURNS JSONB AS $$
DECLARE
  created INTEGER := 0;
  dropped INTEGER := 0;
  i       INTEGER;
BEGIN
  FOR i IN 0..forward_days LOOP
    PERFORM genie_runtime_events_create_partition((CURRENT_DATE + i)::DATE);
    created := created + 1;
  END LOOP;
  SELECT genie_runtime_events_drop_old_partitions(retention_days) INTO dropped;
  RETURN jsonb_build_object(
    'created_or_present', created,
    'dropped',            dropped,
    'next_rotation_at',   (CURRENT_DATE + 1)::TIMESTAMPTZ
  );
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Idempotent conversion: only run if the canonical table is not partitioned.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  is_partitioned BOOLEAN;
  max_legacy_id  BIGINT;
BEGIN
  SELECT c.relkind = 'p'
    INTO is_partitioned
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relname = 'genie_runtime_events'
     AND n.nspname = current_schema();

  IF is_partitioned IS TRUE THEN
    RAISE NOTICE 'genie_runtime_events is already partitioned — skipping conversion';
  ELSE
    -- 1. Rename existing table out of the way; retained for rollback.
    EXECUTE 'ALTER TABLE genie_runtime_events RENAME TO genie_runtime_events_legacy_pre_partition';

    -- 2. Drop the old LISTEN/NOTIFY trigger on the renamed table — the new
    --    parent will carry the trigger for all partitions.
    EXECUTE 'DROP TRIGGER IF EXISTS trg_notify_runtime_event ON genie_runtime_events_legacy_pre_partition';

    -- 3. Drop the old indexes from the renamed table to free their names for
    --    the partitioned parent.
    EXECUTE 'DROP INDEX IF EXISTS idx_runtime_events_created';
    EXECUTE 'DROP INDEX IF EXISTS idx_runtime_events_repo_id';
    EXECUTE 'DROP INDEX IF EXISTS idx_runtime_events_agent_id';
    EXECUTE 'DROP INDEX IF EXISTS idx_runtime_events_team_id';
    EXECUTE 'DROP INDEX IF EXISTS idx_runtime_events_subject_id';
    EXECUTE 'DROP INDEX IF EXISTS idx_runtime_events_kind_id';
    EXECUTE 'DROP INDEX IF EXISTS idx_runtime_events_thread';
    EXECUTE 'DROP INDEX IF EXISTS idx_runtime_events_trace_id';
    EXECUTE 'DROP INDEX IF EXISTS idx_runtime_events_span_id';
    EXECUTE 'DROP INDEX IF EXISTS idx_runtime_events_parent_span_id';
    EXECUTE 'DROP INDEX IF EXISTS idx_runtime_events_severity_id';
    EXECUTE 'DROP INDEX IF EXISTS idx_runtime_events_dedup_key';
    EXECUTE 'DROP INDEX IF EXISTS idx_runtime_events_source_subsystem_id';

    -- 4. Create the new partitioned parent with the UNION of legacy columns
    --    + Group 1 OTEL columns.
    EXECUTE $create$
      CREATE TABLE genie_runtime_events (
        id BIGINT GENERATED ALWAYS AS IDENTITY,
        repo_path TEXT NOT NULL,
        subject TEXT,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        agent TEXT NOT NULL,
        team TEXT,
        direction TEXT CHECK (direction IN ('in', 'out')),
        peer TEXT,
        text TEXT NOT NULL,
        data JSONB DEFAULT '{}',
        thread_id TEXT,
        trace_id UUID,
        parent_event_id BIGINT,
        span_id UUID,
        parent_span_id UUID,
        severity TEXT CHECK (severity IS NULL OR severity IN ('debug', 'info', 'warn', 'error', 'fatal')),
        schema_version INTEGER,
        duration_ms INTEGER,
        dedup_key TEXT,
        source_subsystem TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (id, created_at)
      ) PARTITION BY RANGE (created_at)
    $create$;

    -- 5. Re-create the indexes on the partitioned parent (they cascade to
    --    current and future partitions automatically).
    EXECUTE 'CREATE INDEX idx_runtime_events_created ON genie_runtime_events(created_at)';
    EXECUTE 'CREATE INDEX idx_runtime_events_repo_id ON genie_runtime_events(repo_path, id)';
    EXECUTE 'CREATE INDEX idx_runtime_events_agent_id ON genie_runtime_events(agent, id)';
    EXECUTE 'CREATE INDEX idx_runtime_events_team_id ON genie_runtime_events(team, id)';
    EXECUTE 'CREATE INDEX idx_runtime_events_subject_id ON genie_runtime_events(subject, id)';
    EXECUTE 'CREATE INDEX idx_runtime_events_kind_id ON genie_runtime_events(kind, id)';
    EXECUTE 'CREATE INDEX idx_runtime_events_thread ON genie_runtime_events(thread_id, id)';
    EXECUTE 'CREATE INDEX idx_runtime_events_trace_id ON genie_runtime_events(trace_id) WHERE trace_id IS NOT NULL';
    EXECUTE 'CREATE INDEX idx_runtime_events_span_id ON genie_runtime_events(span_id) WHERE span_id IS NOT NULL';
    EXECUTE 'CREATE INDEX idx_runtime_events_parent_span_id ON genie_runtime_events(parent_span_id) WHERE parent_span_id IS NOT NULL';
    EXECUTE 'CREATE INDEX idx_runtime_events_severity_id ON genie_runtime_events(severity, id) WHERE severity IS NOT NULL';
    EXECUTE 'CREATE INDEX idx_runtime_events_dedup_key ON genie_runtime_events(dedup_key) WHERE dedup_key IS NOT NULL';
    EXECUTE 'CREATE INDEX idx_runtime_events_source_subsystem_id ON genie_runtime_events(source_subsystem, id) WHERE source_subsystem IS NOT NULL';

    -- 6. Seed rolling partitions so the copy below has somewhere to route.
    --    We create partitions for any day that has legacy rows, plus today-1
    --    .. today+2 for the incoming write path, plus a DEFAULT partition for
    --    any out-of-range row (e.g. tests backdating created_at for retention
    --    verification). The scheduler daemon's nightly maintain_partitions()
    --    call converts rows in DEFAULT into named partitions as needed.
    DECLARE
      d_rec RECORD;
    BEGIN
      FOR d_rec IN
        SELECT DISTINCT date_trunc('day', created_at)::DATE AS d
          FROM genie_runtime_events_legacy_pre_partition
      LOOP
        PERFORM genie_runtime_events_create_partition(d_rec.d);
      END LOOP;
    END;
    FOR i IN -1..2 LOOP
      PERFORM genie_runtime_events_create_partition((CURRENT_DATE + i)::DATE);
    END LOOP;
    EXECUTE 'CREATE TABLE IF NOT EXISTS genie_runtime_events_default
             PARTITION OF genie_runtime_events DEFAULT';

    -- 7. Copy legacy rows into the new partitioned parent, preserving ids.
    EXECUTE $copy$
      INSERT INTO genie_runtime_events (
        id, repo_path, subject, kind, source, agent, team, direction, peer,
        text, data, thread_id, trace_id, parent_event_id, created_at
      )
      OVERRIDING SYSTEM VALUE
      SELECT id, repo_path, subject, kind, source, agent, team, direction, peer,
             text, data, thread_id, trace_id, parent_event_id, created_at
      FROM genie_runtime_events_legacy_pre_partition
    $copy$;

    -- 8. Advance the parent's identity sequence past the legacy max id so
    --    new inserts don't collide with preserved ids.
    EXECUTE 'SELECT COALESCE(MAX(id), 0) FROM genie_runtime_events' INTO max_legacy_id;
    IF max_legacy_id > 0 THEN
      EXECUTE format(
        'ALTER TABLE genie_runtime_events ALTER COLUMN id RESTART WITH %s',
        max_legacy_id + 1
      );
    END IF;

    -- 9. Re-attach the LISTEN/NOTIFY trigger. Migration 040 replaces this
    --    with a channel-split trigger.
    EXECUTE $trig$
      CREATE TRIGGER trg_notify_runtime_event
        AFTER INSERT ON genie_runtime_events
        FOR EACH ROW EXECUTE FUNCTION notify_runtime_event()
    $trig$;
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- Always ensure the rolling 30-partition window has today..today+2 (idempotent).
-- Oldest-day rotation is driven by the scheduler daemon calling
-- genie_runtime_events_maintain_partitions() nightly.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  d INTEGER;
BEGIN
  FOR d IN -1..2 LOOP
    PERFORM genie_runtime_events_create_partition((CURRENT_DATE + d)::DATE);
  END LOOP;
  -- Ensure the DEFAULT catch-all exists even on idempotent re-runs.
  EXECUTE 'CREATE TABLE IF NOT EXISTS genie_runtime_events_default
           PARTITION OF genie_runtime_events DEFAULT';
EXCEPTION WHEN invalid_table_definition THEN
  -- Raised when a DEFAULT partition already exists; safe to ignore.
  NULL;
END$$;
