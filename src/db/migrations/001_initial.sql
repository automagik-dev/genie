-- 001_initial.sql — Core genie schema
-- Tables: schedules, triggers, runs, heartbeats, audit_events, agent_checkpoints

-- ============================================================================
-- Schedules — cron-like schedule definitions
-- ============================================================================
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  timezone TEXT DEFAULT 'UTC',
  command TEXT,
  metadata JSONB DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'deleted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_schedules_status ON schedules(status);
CREATE INDEX idx_schedules_name ON schedules(name);

-- ============================================================================
-- Triggers — individual fire instances of a schedule
-- ============================================================================
CREATE TABLE triggers (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  due_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'executing', 'completed', 'failed', 'skipped')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_triggers_schedule_id ON triggers(schedule_id);
CREATE INDEX idx_triggers_status ON triggers(status);
CREATE INDEX idx_triggers_due_pending ON triggers(due_at)
  WHERE status = 'pending';

-- ============================================================================
-- Runs — execution attempts for a trigger
-- ============================================================================
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  worker_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'running', 'completed', 'failed', 'timeout', 'cancelled')),
  output TEXT,
  error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_runs_trigger_id ON runs(trigger_id);
CREATE INDEX idx_runs_worker_id ON runs(worker_id);
CREATE INDEX idx_runs_status ON runs(status);
CREATE INDEX idx_runs_leased ON runs(status, started_at)
  WHERE status IN ('leased', 'running');

-- ============================================================================
-- Heartbeats — worker liveness tracking
-- ============================================================================
CREATE TABLE heartbeats (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'alive'
    CHECK (status IN ('alive', 'idle', 'busy', 'dead')),
  context JSONB DEFAULT '{}',
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_heartbeats_worker_id ON heartbeats(worker_id);
CREATE INDEX idx_heartbeats_run_id ON heartbeats(run_id);
CREATE INDEX idx_heartbeats_last_seen ON heartbeats(last_seen_at);

-- ============================================================================
-- Audit events — immutable log of state transitions
-- ============================================================================
CREATE TABLE audit_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT,
  details JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_entity ON audit_events(entity_type, entity_id);
CREATE INDEX idx_audit_created ON audit_events(created_at);
CREATE INDEX idx_audit_actor ON audit_events(actor);

-- ============================================================================
-- Agent checkpoints — session resume state for agents
-- ============================================================================
CREATE TABLE agent_checkpoints (
  worker_id TEXT PRIMARY KEY,
  wish_slug TEXT,
  group_name TEXT,
  phase TEXT CHECK (phase IN ('executing', 'validating', 'reporting')),
  context_summary TEXT,
  dispatch_context TEXT,
  branch_name TEXT,
  last_checkpoint TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_checkpoints_wish ON agent_checkpoints(wish_slug);
CREATE INDEX idx_checkpoints_group ON agent_checkpoints(group_name);

-- ============================================================================
-- LISTEN/NOTIFY — real-time trigger-due notifications
-- ============================================================================
CREATE OR REPLACE FUNCTION notify_trigger_due()
RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('genie_trigger_due', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_notify_due
  AFTER INSERT ON triggers
  FOR EACH ROW
  WHEN (NEW.status = 'pending')
  EXECUTE FUNCTION notify_trigger_due();
