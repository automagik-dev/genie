-- 026_omni_sessions.sql — Persistent session table for the Omni bridge.
-- Tracks per-chat agent sessions so the bridge can recover state after restart.

CREATE TABLE IF NOT EXISTS omni_sessions (
  id                TEXT PRIMARY KEY,           -- format: "agentName:chatId"
  agent_name        TEXT NOT NULL,
  chat_id           TEXT NOT NULL,
  instance_id       TEXT NOT NULL,
  claude_session_id TEXT,                       -- set after first query
  created_at        TIMESTAMPTZ DEFAULT now(),
  last_activity_at  TIMESTAMPTZ DEFAULT now(),
  metadata          JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_omni_sessions_agent
  ON omni_sessions (agent_name);

CREATE INDEX IF NOT EXISTS idx_omni_sessions_instance
  ON omni_sessions (instance_id);
