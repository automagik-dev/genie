-- 064_drain_default_uses_replica_bridge.sql
-- Refactor genie_runtime_events_drain_default() to invoke the privilege bridge
-- (genie_runtime_events_replica_insert_drain) instead of calling
-- set_config('session_replication_role', 'replica', ...) directly.
--
-- Why: session_replication_role is SUPERUSER-gated. Migration 055's original
-- body executed that call as the caller, which broke once `runMigrations`
-- started running under the scoped non-superuser role (`role-cutover` Wave 3).
-- Symptom: `genie serve start preconditions failed: permission denied to set
-- parameter "session_replication_role"`, crash-looping forever.
--
-- The bridge is a SECURITY DEFINER function owned by the bootstrap superuser,
-- installed by `ensurePrivilegedBootstrapObjects()` (src/lib/role-cutover.ts)
-- every time the scoped role is provisioned/refreshed. The scoped role only
-- holds EXECUTE on the bridge — strictly narrower than holding SUPERUSER or
-- the GUC capability directly. Audit-bypass blast radius is bounded to the
-- literal INSERT body inside the bridge.
--
-- Belt-and-suspenders: this migration also installs the bridge when the
-- caller is a superuser AND the bridge is missing. That covers paths where
-- `shouldAttemptRoleCutover()` returns false (test mode, TCP/router transport)
-- — `ensurePrivilegedBootstrapObjects` is skipped there, so without this
-- guard `drain_default` would reference a non-existent function. The guard
-- is rolsuper-gated: a non-superuser caller that hits this branch would
-- create a bridge owned by itself, where SECURITY DEFINER provides no real
-- privilege elevation, so we intentionally do nothing in that case.
--
-- The rest of the drain (DETACH / create_partition / TRUNCATE / ATTACH) still
-- runs under the scoped role's privileges — the scoped role owns the partition
-- and parent tables, so those operations need no elevation.

DO $bridge$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'genie_runtime_events_replica_insert_drain'
       AND n.nspname = current_schema()
  ) AND EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper
  ) THEN
    EXECUTE $body$
      CREATE FUNCTION genie_runtime_events_replica_insert_drain()
      RETURNS INTEGER
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $fn$
      DECLARE
        drained INTEGER := 0;
      BEGIN
        PERFORM set_config('session_replication_role', 'replica', true);
        INSERT INTO genie_runtime_events (
          id, repo_path, subject, kind, source, agent, team, direction, peer,
          text, data, thread_id, trace_id, parent_event_id, span_id, parent_span_id,
          severity, schema_version, duration_ms, dedup_key, source_subsystem, created_at
        )
        OVERRIDING SYSTEM VALUE
        SELECT id, repo_path, subject, kind, source, agent, team, direction, peer,
               text, data, thread_id, trace_id, parent_event_id, span_id, parent_span_id,
               severity, schema_version, duration_ms, dedup_key, source_subsystem, created_at
          FROM genie_runtime_events_default;
        GET DIAGNOSTICS drained = ROW_COUNT;
        RETURN drained;
      END;
      $fn$ LANGUAGE plpgsql;
    $body$;
    EXECUTE 'REVOKE EXECUTE ON FUNCTION genie_runtime_events_replica_insert_drain() FROM PUBLIC';
  END IF;
END
$bridge$;

CREATE OR REPLACE FUNCTION genie_runtime_events_drain_default()
RETURNS INTEGER AS $$
DECLARE
  drained INTEGER := 0;
  d_rec   RECORD;
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

  -- Detach so the re-insert routes to dated partitions instead of looping
  -- back into DEFAULT. Non-CONCURRENTLY form is transaction-safe.
  EXECUTE 'ALTER TABLE genie_runtime_events DETACH PARTITION genie_runtime_events_default';

  -- Ensure a dated partition exists for every day represented in the
  -- detached default. create_partition is CREATE TABLE IF NOT EXISTS.
  FOR d_rec IN
    SELECT DISTINCT date_trunc('day', created_at)::DATE AS d
      FROM genie_runtime_events_default
  LOOP
    PERFORM genie_runtime_events_create_partition(d_rec.d);
  END LOOP;

  -- Privilege bridge: SECURITY DEFINER function owned by the bootstrap
  -- superuser, installed by ensureScopedRole(). Suppresses AFTER INSERT
  -- triggers (notify_runtime_event_split, audit chain) for the re-insert.
  -- These rows already fired notifies on their original insert; re-firing
  -- would broadcast duplicates to every LISTEN'er.
  drained := genie_runtime_events_replica_insert_drain();

  EXECUTE 'TRUNCATE genie_runtime_events_default';
  EXECUTE 'ALTER TABLE genie_runtime_events ATTACH PARTITION genie_runtime_events_default DEFAULT';

  RETURN drained;
END;
$$ LANGUAGE plpgsql;

-- One-shot drain at migration time so any installs whose 055 application
-- left rows stuck in DEFAULT (e.g. the boot path crash-looped after 055
-- partially applied) get unstuck on the first post-upgrade `genie serve start`.
-- Guarded so the call only fires if the bridge exists — fresh installs that
-- run 055+064 in the same boot before ensureScopedRole has refreshed the
-- bridge would otherwise hit an undefined-function error.
DO $$
DECLARE
  drained INTEGER;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'genie_runtime_events_replica_insert_drain'
       AND n.nspname = current_schema()
  ) THEN
    drained := genie_runtime_events_drain_default();
    IF drained > 0 THEN
      RAISE NOTICE 'genie_runtime_events_default: drained % stuck row(s) via replica bridge', drained;
    END IF;
  END IF;
END$$;
