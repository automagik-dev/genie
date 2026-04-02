-- 007_observability.sql — Sessions + session_content tables for full observability
-- Stores session metadata and complementary content (assistant text, tool I/O)
-- OTel structured events (cost, tokens, tool success/fail) go into audit_events

-- ============================================================================
-- Sessions — Claude Code session metadata
-- ============================================================================
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,                    -- Claude Code session UUID
  agent_id TEXT,                          -- Genie worker ID (NULL if orphaned)
  team TEXT,
  wish_slug TEXT,
  task_id TEXT,
  role TEXT,                              -- agent role (engineer, reviewer, etc.)
  project_path TEXT,                      -- .claude/projects/<hash>
  jsonl_path TEXT,                        -- absolute path to source JSONL
  status TEXT NOT NULL DEFAULT 'active',  -- active, completed, crashed, orphaned
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  last_ingested_offset BIGINT DEFAULT 0,  -- byte offset for incremental reads
  total_turns INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_team ON sessions(team);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_wish ON sessions(wish_slug);

-- ============================================================================
-- Session content — complementary content from JSONL (text only, no metrics)
-- ============================================================================
CREATE TABLE IF NOT EXISTS session_content (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_index INTEGER NOT NULL,
  role TEXT NOT NULL,                     -- 'assistant', 'tool_input', 'tool_output'
  content TEXT NOT NULL,                  -- the actual text/code content
  tool_name TEXT,                         -- which tool (for tool_input/tool_output)
  timestamp TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(session_id, turn_index)
);

CREATE INDEX IF NOT EXISTS idx_session_content_session ON session_content(session_id);
CREATE INDEX IF NOT EXISTS idx_session_content_search ON session_content USING gin(to_tsvector('english', content));

-- ============================================================================
-- Retention policies — prevent unbounded table growth
-- ============================================================================
-- Note: retention is enforced by the scheduler daemon, not by PG triggers.
-- These are documented here for reference:
--   DELETE FROM heartbeats WHERE created_at < now() - interval '7 days'
--   DELETE FROM machine_snapshots WHERE created_at < now() - interval '30 days'
--   DELETE FROM audit_events WHERE entity_type LIKE 'otel_%' AND created_at < now() - interval '30 days'
