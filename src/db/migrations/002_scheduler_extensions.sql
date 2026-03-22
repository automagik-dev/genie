-- 002_scheduler_extensions.sql — Scheduler daemon extensions
-- Adds lease columns to triggers, trace_id to runs, run_spec to schedules

-- ============================================================================
-- Schedules — add interval support and run specification
-- ============================================================================
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS interval_ms BIGINT;
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS run_spec JSONB DEFAULT '{}';

-- ============================================================================
-- Triggers — add lease columns and idempotency key
-- ============================================================================
ALTER TABLE triggers ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE triggers ADD COLUMN IF NOT EXISTS leased_by TEXT;
ALTER TABLE triggers ADD COLUMN IF NOT EXISTS leased_until TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_triggers_idempotency
  ON triggers(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_triggers_leased
  ON triggers(status, leased_until)
  WHERE status = 'executing';

-- ============================================================================
-- Runs — add trace_id and lease_timeout_ms
-- ============================================================================
ALTER TABLE runs ADD COLUMN IF NOT EXISTS trace_id TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS lease_timeout_ms INTEGER DEFAULT 300000;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS exit_code INTEGER;

CREATE INDEX IF NOT EXISTS idx_runs_trace_id ON runs(trace_id)
  WHERE trace_id IS NOT NULL;
