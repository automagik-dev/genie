-- Privilege bridge for the trigger-suppressed bulk INSERT inside
-- genie_runtime_events_drain_default() (migration 055 / refactor 064).
--
-- Why a bridge: set_config('session_replication_role', 'replica', …) is
-- SUPERUSER-gated. The scoped non-superuser role that runs migrations cannot
-- call it directly. This function is installed by
-- src/lib/role-cutover.ts:ensurePrivilegedBootstrapObjects() on the bootstrap
-- superuser connection; the scoped role gets EXECUTE, and only this exact
-- INSERT runs with elevated privileges (SECURITY DEFINER).
--
-- This .sql lives outside `src/lib/` so the emit-discipline lint (which
-- guards normal runtime emission against bypassing src/lib/emit.ts) does not
-- flag it. The privilege-bridge install path is the one legitimate exception.

CREATE OR REPLACE FUNCTION genie_runtime_events_replica_insert_drain()
RETURNS INTEGER
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  drained INTEGER := 0;
BEGIN
  -- is_local=true ⇒ auto-revert at txn end. SUPERUSER-gated; reachable here
  -- only because the function executes as its owner (bootstrap superuser).
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
