-- 043_executor_read_role.sql — Readonly PG role for executor state lookups.
-- Wish: turn-session-contract (Group 6).
--
-- External consumers (omni scope-enforcer) either hit the HTTP endpoint
-- `GET /executors/:id/state` (src/lib/executor-read.ts) OR connect directly to
-- genie-PG as `executors_reader`. This migration ships the direct-SQL path so
-- operators can choose the transport that matches their deployment:
--
--   * HTTP: zero config, but adds a hop through `genie serve`.
--   * Direct SQL: one fewer hop + simpler observability (pg_stat_statements).
--
-- The role is SELECT-only and scoped to the three columns the boundary contract
-- promises (`state`, `outcome`, `closed_at`) via a dedicated view. Granting on
-- the base table would expose `metadata`, `claude_session_id`, and other
-- fields omni has no need to see.
--
-- NOINHERIT + no LOGIN by default: operators layer a login role on top with
-- their own credentials (`CREATE ROLE omni_scope_enforcer LOGIN PASSWORD '…'
--   IN ROLE executors_reader`). That keeps credential rotation a boundary
-- concern, not a schema concern.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'executors_reader') THEN
    EXECUTE 'CREATE ROLE executors_reader NOINHERIT';
  END IF;
END$$;

-- Scoped view — exposes ONLY the boundary-contract fields. Adding a field here
-- is a cross-repo coordination point (see WISH.md §Boundary Contracts).
CREATE OR REPLACE VIEW executors_public_state AS
SELECT id, state, outcome, closed_at
FROM executors;

REVOKE ALL ON executors_public_state FROM PUBLIC;
GRANT SELECT ON executors_public_state TO executors_reader;

-- Schema USAGE is required for the role to reference the view at all. Tables
-- inside the schema still require explicit grants, so USAGE is safe to give
-- broadly.
GRANT USAGE ON SCHEMA public TO executors_reader;
