-- 010_session_capture_v2.sql — Session capture v2: subagents, tool events, backfill state

-- ============================================================================
-- Sessions: subagent support + file metadata
-- ============================================================================
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS is_subagent BOOLEAN DEFAULT false;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS file_size BIGINT DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS file_mtime BIGINT DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id) WHERE parent_session_id IS NOT NULL;

-- ============================================================================
-- Tool events — structured per-call records extracted from JSONL
-- ============================================================================
CREATE TABLE IF NOT EXISTS tool_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_index INTEGER NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,

  -- Tool identity (auto-extracted, never hardcoded)
  tool_name TEXT NOT NULL,
  sub_tool TEXT,
  tool_use_id TEXT,

  -- Full input/output (no truncation — this IS the learning data)
  input_raw TEXT,
  output_raw TEXT,

  -- Outcome
  is_error BOOLEAN DEFAULT false,
  error_message TEXT,
  duration_ms INTEGER,

  -- Genie context (denormalized from sessions at ingest time)
  agent_id TEXT,
  team TEXT,
  wish_slug TEXT,
  task_id TEXT,

  UNIQUE(session_id, tool_use_id)
);

CREATE INDEX IF NOT EXISTS idx_te_session ON tool_events(session_id);
CREATE INDEX IF NOT EXISTS idx_te_tool ON tool_events(tool_name);
CREATE INDEX IF NOT EXISTS idx_te_sub_tool ON tool_events(sub_tool) WHERE sub_tool IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_te_agent ON tool_events(agent_id) WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_te_team ON tool_events(team) WHERE team IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_te_wish ON tool_events(wish_slug) WHERE wish_slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_te_task ON tool_events(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_te_errors ON tool_events(is_error) WHERE is_error = true;
CREATE INDEX IF NOT EXISTS idx_te_timestamp ON tool_events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_te_tool_sub ON tool_events(tool_name, sub_tool);

-- ============================================================================
-- Backfill state tracking
-- ============================================================================
CREATE TABLE IF NOT EXISTS session_sync (
  id TEXT PRIMARY KEY DEFAULT 'backfill',
  status TEXT NOT NULL DEFAULT 'pending',
  total_files INTEGER DEFAULT 0,
  processed_files INTEGER DEFAULT 0,
  total_bytes BIGINT DEFAULT 0,
  processed_bytes BIGINT DEFAULT 0,
  errors INTEGER DEFAULT 0,
  error_log JSONB DEFAULT '[]',
  started_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================================
-- Aggregation views (no pre-computed tables)
-- ============================================================================

-- Tool usage per session
CREATE OR REPLACE VIEW v_tool_usage AS
SELECT session_id, tool_name, sub_tool, COUNT(*) as call_count,
       COUNT(*) FILTER (WHERE is_error) as error_count
FROM tool_events GROUP BY session_id, tool_name, sub_tool;

-- File access per session
CREATE OR REPLACE VIEW v_file_usage AS
SELECT session_id, sub_tool as file_path, tool_name as operation, COUNT(*) as access_count
FROM tool_events
WHERE tool_name IN ('Read', 'Write', 'Edit') AND sub_tool IS NOT NULL
GROUP BY session_id, sub_tool, tool_name;

-- Proprietary CLI usage with error rates
CREATE OR REPLACE VIEW v_cli_usage AS
SELECT team, wish_slug, agent_id, sub_tool,
       COUNT(*) as total_calls,
       COUNT(*) FILTER (WHERE is_error) as errors,
       ROUND(100.0 * COUNT(*) FILTER (WHERE is_error) / NULLIF(COUNT(*), 0), 1) as error_rate
FROM tool_events
WHERE tool_name = 'Bash' AND sub_tool ~ '^(genie|omni|rlmx|khal) '
GROUP BY team, wish_slug, agent_id, sub_tool;
