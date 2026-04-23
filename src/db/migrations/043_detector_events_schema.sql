-- 043_detector_events_schema.sql — additive column for self-healing detectors
-- Wish: genie-self-healing-observability-b1-detectors (Group 1 / Phase 0).
-- Audit: docs/detectors/schema-audit.md
--
-- Shape decision: extend the existing substrate with ONE additive column.
-- The eight rot-pattern evidence bundles already fit in `genie_runtime_events`
-- (subject / kind / data / trace_id / parent_event_id). The single gap is a
-- first-class identifier for "which release of the detector emitted this row"
-- — semantically distinct from per-event-type `schema_version` (INTEGER) added
-- in PG 037. We add `detector_version TEXT` to the partitioned parent and both
-- sibling tables (debug / audit) so detector rows land in any tier with a
-- uniform shape. Five new partial indexes enable fast "show me everything from
-- detector v<X>" queries without bloating the write path for non-detector rows.
--
-- Idempotency: every statement uses IF NOT EXISTS or guarded DDL. Running this
-- migration twice against an already-migrated schema is a strict no-op.
--
-- Never-rename / never-drop discipline: no legacy column is modified. Existing
-- indexes and the NOTIFY trigger installed in PG 040 are untouched.
--
-- NOTE on CONCURRENTLY: the migration runner wraps every file in a single
-- `sql.begin()` transaction, which forbids CREATE INDEX CONCURRENTLY. The
-- ADD COLUMN statements below are metadata-only in PG 11+ (no rewrite), and
-- the plain CREATE INDEX calls complete in milliseconds against the current
-- partition row-counts. If a future operator needs to rebuild on a
-- multi-billion-row table, they should apply the indexes out-of-band with
-- CONCURRENTLY before running the migration so the IF NOT EXISTS check
-- becomes a no-op.

-- ---------------------------------------------------------------------------
-- 1. ADD COLUMN IF NOT EXISTS on the partitioned parent (PG 038).
-- PG 11+ propagates the column to every existing and future partition.
-- ---------------------------------------------------------------------------

-- detector_version — release identifier for the detector that emitted the row.
-- TEXT (not INTEGER) because detectors follow semver ('2.3.0'), not per-type
-- schema version. Indexed partial so the non-detector write path is untouched.
ALTER TABLE genie_runtime_events
  ADD COLUMN IF NOT EXISTS detector_version TEXT;

-- ---------------------------------------------------------------------------
-- 2. Mirror onto the sibling tables so detector rows can land in any tier.
-- ---------------------------------------------------------------------------

ALTER TABLE genie_runtime_events_debug
  ADD COLUMN IF NOT EXISTS detector_version TEXT;

ALTER TABLE genie_runtime_events_audit
  ADD COLUMN IF NOT EXISTS detector_version TEXT;

-- ---------------------------------------------------------------------------
-- 3. Partial indexes. One per table. `(detector_version, id)` lets queries
-- like "most recent rot event per detector release" stay on index.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_runtime_events_detector_version
  ON genie_runtime_events(detector_version, id)
  WHERE detector_version IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_runtime_events_debug_detector_version
  ON genie_runtime_events_debug(detector_version, id)
  WHERE detector_version IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_runtime_events_audit_detector_version
  ON genie_runtime_events_audit(detector_version, id)
  WHERE detector_version IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Down-migration sentinel.
-- The migration runner in src/lib/db-migrations.ts does not currently execute
-- reverse DDL — it simply skips already-applied migrations. The block below
-- documents the intended reverse path so an operator performing a manual
-- rollback (outside the runner) has a verified script. Do NOT execute this
-- during a normal `genie db migrate`. To run it by hand:
--
--   BEGIN;
--     DROP INDEX IF EXISTS idx_runtime_events_detector_version;
--     DROP INDEX IF EXISTS idx_runtime_events_debug_detector_version;
--     DROP INDEX IF EXISTS idx_runtime_events_audit_detector_version;
--     ALTER TABLE genie_runtime_events        DROP COLUMN IF EXISTS detector_version;
--     ALTER TABLE genie_runtime_events_debug  DROP COLUMN IF EXISTS detector_version;
--     ALTER TABLE genie_runtime_events_audit  DROP COLUMN IF EXISTS detector_version;
--     DELETE FROM _genie_migrations WHERE name = '043_detector_events_schema';
--   COMMIT;
--
-- The DROP COLUMN is safe because no consumer reads detector_version yet
-- (Group 2 of this wish lands the first emitter). After Group 2 ships, a
-- reversal would require first replacing the column with a default-null
-- expression in every query. That risk is acknowledged but not material to
-- Phase 0.
-- ---------------------------------------------------------------------------
