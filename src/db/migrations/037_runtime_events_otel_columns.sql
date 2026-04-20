-- 037_runtime_events_otel_columns.sql — OTEL-style correlation columns
-- Wish: genie-serve-structured-observability (Group 1 — Schema Evolution + Feature Flag).
-- Never-rename / never-drop discipline: existing legacy columns (repo_path, subject,
-- kind, source, agent, team, direction, peer, text, data, thread_id, trace_id,
-- parent_event_id, created_at) are untouched.
--
-- NOTE on CONCURRENTLY: the wish calls for `CREATE INDEX CONCURRENTLY`, but the
-- repo's migration runner (src/lib/db-migrations.ts) wraps every migration in a
-- `sql.begin()` transaction, and CONCURRENTLY cannot execute inside one. The
-- ADD COLUMN statements below are metadata-only in PG 11+ (instant; no rewrite),
-- and the plain CREATE INDEX calls finish in milliseconds on the current event
-- volume. If a future operator needs to rebuild on a multi-billion-row table,
-- they should apply these indexes out-of-band with CONCURRENTLY before running
-- the migration so the IF NOT EXISTS check becomes a no-op.

-- ---------------------------------------------------------------------------
-- 1. ADD COLUMN IF NOT EXISTS — idempotent on re-apply
-- ---------------------------------------------------------------------------

-- span_id — OTEL-compatible 128-bit span identifier for this event row.
ALTER TABLE genie_runtime_events ADD COLUMN IF NOT EXISTS span_id UUID;

-- parent_span_id — points at the parent span row (spans form a causal tree).
-- Deliberately does NOT add a FK: a child may outlive its parent row after
-- retention sweeps, and FK enforcement would block daily-partition drops.
ALTER TABLE genie_runtime_events ADD COLUMN IF NOT EXISTS parent_span_id UUID;

-- severity — structured log level. CHECK enforced below (nullable so rows written
-- by the legacy emitter keep working until Group 3 migrates them).
ALTER TABLE genie_runtime_events ADD COLUMN IF NOT EXISTS severity TEXT;

-- schema_version — per-event-type version so consumer queries pinned to a
-- specific version remain verifiable forever.
ALTER TABLE genie_runtime_events ADD COLUMN IF NOT EXISTS schema_version INTEGER;

-- duration_ms — span duration in milliseconds (NULL for point events).
ALTER TABLE genie_runtime_events ADD COLUMN IF NOT EXISTS duration_ms INTEGER;

-- dedup_key — SHA256 of (type, entity_id, payload_digest, minute_bucket).
-- Not UNIQUE: ON CONFLICT handling lives in the emitter (emit.ts, Group 2).
ALTER TABLE genie_runtime_events ADD COLUMN IF NOT EXISTS dedup_key TEXT;

-- source_subsystem — which genie subsystem emitted this (executor, scheduler,
-- mailbox, hook, cli, ...). Broader-granularity than `source`.
ALTER TABLE genie_runtime_events ADD COLUMN IF NOT EXISTS source_subsystem TEXT;

-- ---------------------------------------------------------------------------
-- 2. CHECK constraint on severity (skip if already present)
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'genie_runtime_events_severity_check'
  ) THEN
    ALTER TABLE genie_runtime_events
      ADD CONSTRAINT genie_runtime_events_severity_check
      CHECK (severity IS NULL OR severity IN ('debug', 'info', 'warn', 'error', 'fatal'));
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- 3. Indexes — five new, all IF NOT EXISTS + partial where useful
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_runtime_events_span_id
  ON genie_runtime_events(span_id)
  WHERE span_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_runtime_events_parent_span_id
  ON genie_runtime_events(parent_span_id)
  WHERE parent_span_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_runtime_events_severity_id
  ON genie_runtime_events(severity, id)
  WHERE severity IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_runtime_events_dedup_key
  ON genie_runtime_events(dedup_key)
  WHERE dedup_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_runtime_events_source_subsystem_id
  ON genie_runtime_events(source_subsystem, id)
  WHERE source_subsystem IS NOT NULL;
