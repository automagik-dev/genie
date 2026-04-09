-- 035_bridge_sessions.sql — Dedicated bridge session tracking
-- Persists omni bridge sessions so they survive process restarts.
-- Complements the executors table with bridge-specific fields.

CREATE TABLE IF NOT EXISTS genie_bridge_sessions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  executor_id TEXT REFERENCES executors(id) ON DELETE SET NULL,
  instance_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  tmux_pane_id TEXT,
  claude_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'closed', 'orphaned')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_bridge_sessions_status
  ON genie_bridge_sessions(status);
CREATE INDEX IF NOT EXISTS idx_bridge_sessions_instance_chat
  ON genie_bridge_sessions(instance_id, chat_id);
CREATE INDEX IF NOT EXISTS idx_bridge_sessions_active
  ON genie_bridge_sessions(status, last_activity_at)
  WHERE status = 'active';
