-- 014_comms_protocol.sql — Communication protocol: agent requests, activity threading, event subscriptions
-- Creates: agent_requests (typed agent→human requests)
-- Extends: genie_runtime_events (thread_id for per-agent/task/team feeds)
-- Extends: teams (event_subscriptions JSONB for configurable routing)

-- ============================================================================
-- 1. Activity Threading — thread_id on runtime events
-- ============================================================================

ALTER TABLE genie_runtime_events ADD COLUMN IF NOT EXISTS thread_id TEXT;

-- Backfill existing rows: default thread_id = 'agent:<agent>'
UPDATE genie_runtime_events SET thread_id = 'agent:' || agent WHERE thread_id IS NULL;

-- Index for fast thread-scoped queries
CREATE INDEX IF NOT EXISTS idx_runtime_events_thread ON genie_runtime_events(thread_id, id);

-- ============================================================================
-- 2. Structured Agent Requests — typed agent→human I/O
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_requests (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  agent_id TEXT NOT NULL,
  executor_id TEXT,
  task_id TEXT,
  team TEXT,
  type TEXT NOT NULL CHECK (type IN ('env', 'confirm', 'choice', 'approve', 'input')),
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'resolved', 'rejected', 'expired')),
  resolved_by TEXT,
  resolved_value JSONB,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_requests_status ON agent_requests(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_agent_requests_team ON agent_requests(team) WHERE team IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_requests_agent ON agent_requests(agent_id);

-- NOTIFY on create and resolve
CREATE OR REPLACE FUNCTION notify_agent_request()
RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('genie_request',
    NEW.id || ':' || NEW.agent_id || ':' || NEW.type || ':' || NEW.status);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_notify_request
  AFTER INSERT OR UPDATE OF status ON agent_requests
  FOR EACH ROW EXECUTE FUNCTION notify_agent_request();

-- ============================================================================
-- 3. Event Subscriptions — per-team routing config
-- ============================================================================

ALTER TABLE teams ADD COLUMN IF NOT EXISTS event_subscriptions JSONB
  DEFAULT '{"preset": "actionable"}'::jsonb;
