-- 012_executor_model.sql — Separate agent identity from runtime execution
-- Creates: executors (ephemeral process runtime), assignments (work history)
-- Slims: agents (to durable identity only)
-- Re-keys: sessions.agent_id → sessions.executor_id

-- ============================================================================
-- Table: executors — Ephemeral process runtime
-- One agent can have many executors over time; only one is current.
-- ============================================================================
CREATE TABLE executors (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('tmux', 'api', 'process')),
  pid INTEGER,
  tmux_session TEXT,
  tmux_pane_id TEXT,
  tmux_window TEXT,
  tmux_window_id TEXT,
  claude_session_id TEXT,
  state TEXT NOT NULL DEFAULT 'spawning'
    CHECK (state IN ('spawning', 'running', 'idle', 'working', 'permission', 'question', 'done', 'error', 'terminated')),
  metadata JSONB DEFAULT '{}',
  worktree TEXT,
  repo_path TEXT,
  pane_color TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_executors_agent_id ON executors(agent_id);
CREATE INDEX idx_executors_state ON executors(state);
CREATE INDEX idx_executors_provider ON executors(provider);

-- ============================================================================
-- Table: assignments — Work history (executor ↔ task many-to-many)
-- ============================================================================
CREATE TABLE assignments (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  executor_id TEXT NOT NULL REFERENCES executors(id) ON DELETE CASCADE,
  task_id TEXT,
  wish_slug TEXT,
  group_number INTEGER,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  outcome TEXT CHECK (outcome IN ('completed', 'failed', 'reassigned', 'abandoned')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_assignments_executor_id ON assignments(executor_id);
CREATE INDEX idx_assignments_task_id ON assignments(task_id) WHERE task_id IS NOT NULL;

-- ============================================================================
-- Data migration: populate executors from existing agents with runtime state
-- ============================================================================
INSERT INTO executors (
  id, agent_id, provider, transport, pid, tmux_session, tmux_pane_id,
  tmux_window, tmux_window_id, claude_session_id, state, metadata,
  worktree, repo_path, pane_color, started_at, created_at, updated_at
)
SELECT
  'exec-' || id,                                         -- executor id derived from agent id
  id,                                                     -- agent_id FK
  COALESCE(provider, 'claude'),                           -- provider (default claude)
  CASE
    WHEN transport = 'inline' THEN 'process'              -- map old 'inline' to 'process'
    WHEN transport IS NULL THEN 'tmux'
    ELSE transport
  END,                                                    -- transport
  NULL,                                                   -- pid (not tracked before)
  session,                                                -- tmux_session
  pane_id,                                                -- tmux_pane_id
  tmux_window,                                            -- tmux_window
  window_id,                                              -- tmux_window_id
  claude_session_id,                                      -- claude_session_id
  CASE
    WHEN state = 'suspended' THEN 'terminated'            -- map old 'suspended' to 'terminated'
    ELSE state
  END,                                                    -- state
  '{}',                                                   -- metadata
  worktree,                                               -- worktree
  repo_path,                                              -- repo_path
  pane_color,                                             -- pane_color
  started_at,                                             -- started_at
  created_at,                                             -- created_at
  updated_at                                              -- updated_at
FROM agents;

-- ============================================================================
-- Data migration: populate assignments from agents that had tasks
-- ============================================================================
INSERT INTO assignments (executor_id, task_id, wish_slug, group_number, started_at)
SELECT
  'exec-' || id,
  task_id,
  wish_slug,
  group_number,
  started_at
FROM agents
WHERE task_id IS NOT NULL;

-- ============================================================================
-- Slim agents: add current_executor_id, then drop runtime columns
-- ============================================================================

-- Add FK to current executor
ALTER TABLE agents ADD COLUMN IF NOT EXISTS current_executor_id TEXT REFERENCES executors(id) ON DELETE SET NULL;

-- Backfill current_executor_id from migrated executors
UPDATE agents SET current_executor_id = 'exec-' || id;

-- Add composite unique constraint: (custom_name, team) where both non-null
-- Prevents duplicate agents with the same name in the same team
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_custom_name_team
  ON agents(custom_name, team)
  WHERE custom_name IS NOT NULL AND team IS NOT NULL;

-- Drop triggers + function on agents.state BEFORE dropping the column
-- (both triggers depend on the state column, blocking DROP COLUMN)
DROP TRIGGER IF EXISTS trg_notify_agent_state ON agents;
DROP TRIGGER IF EXISTS trg_agent_state_change ON agents;
DROP FUNCTION IF EXISTS notify_agent_state_change() CASCADE;

-- Drop indexes on columns about to be removed
DROP INDEX IF EXISTS idx_agents_state;
DROP INDEX IF EXISTS idx_agents_session;
DROP INDEX IF EXISTS idx_agents_pane_id;
DROP INDEX IF EXISTS idx_agents_wish_slug;
DROP INDEX IF EXISTS idx_agents_task_id;

-- Drop runtime columns that moved to executors
ALTER TABLE agents DROP COLUMN IF EXISTS pane_id;
ALTER TABLE agents DROP COLUMN IF EXISTS session;
ALTER TABLE agents DROP COLUMN IF EXISTS worktree;
ALTER TABLE agents DROP COLUMN IF EXISTS state;
ALTER TABLE agents DROP COLUMN IF EXISTS last_state_change;
ALTER TABLE agents DROP COLUMN IF EXISTS claude_session_id;
ALTER TABLE agents DROP COLUMN IF EXISTS window_name;
ALTER TABLE agents DROP COLUMN IF EXISTS window_id;
ALTER TABLE agents DROP COLUMN IF EXISTS sub_panes;
ALTER TABLE agents DROP COLUMN IF EXISTS provider;
ALTER TABLE agents DROP COLUMN IF EXISTS transport;
ALTER TABLE agents DROP COLUMN IF EXISTS tmux_window;
ALTER TABLE agents DROP COLUMN IF EXISTS suspended_at;
ALTER TABLE agents DROP COLUMN IF EXISTS auto_resume;
ALTER TABLE agents DROP COLUMN IF EXISTS resume_attempts;
ALTER TABLE agents DROP COLUMN IF EXISTS last_resume_attempt;
ALTER TABLE agents DROP COLUMN IF EXISTS max_resume_attempts;
ALTER TABLE agents DROP COLUMN IF EXISTS pane_color;
ALTER TABLE agents DROP COLUMN IF EXISTS task_id;
ALTER TABLE agents DROP COLUMN IF EXISTS task_title;
ALTER TABLE agents DROP COLUMN IF EXISTS wish_slug;
ALTER TABLE agents DROP COLUMN IF EXISTS group_number;
ALTER TABLE agents DROP COLUMN IF EXISTS skill;
ALTER TABLE agents DROP COLUMN IF EXISTS repo_path;
ALTER TABLE agents DROP COLUMN IF EXISTS window_ref;

-- ============================================================================
-- Re-key sessions: agent_id → executor_id
-- ============================================================================

-- Add executor_id column
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS executor_id TEXT REFERENCES executors(id) ON DELETE SET NULL;

-- Populate executor_id from existing agent_id
UPDATE sessions SET executor_id = 'exec-' || agent_id WHERE agent_id IS NOT NULL;

-- Drop old agent_id column and index
DROP INDEX IF EXISTS idx_sessions_agent;
ALTER TABLE sessions DROP COLUMN IF EXISTS agent_id;

-- Create index on new FK
CREATE INDEX IF NOT EXISTS idx_sessions_executor ON sessions(executor_id);

-- ============================================================================
-- Auto-update triggers for new tables
-- ============================================================================
CREATE OR REPLACE FUNCTION update_executors_timestamp()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_executors_updated_at
  BEFORE UPDATE ON executors
  FOR EACH ROW EXECUTE FUNCTION update_executors_timestamp();

-- ============================================================================
-- LISTEN/NOTIFY for executor state changes
-- ============================================================================
CREATE OR REPLACE FUNCTION notify_executor_state_change()
RETURNS trigger AS $$
BEGIN
  IF OLD.state IS DISTINCT FROM NEW.state THEN
    PERFORM pg_notify('genie_executor_state', NEW.id || ':' || NEW.agent_id || ':' || COALESCE(OLD.state, '') || ':' || NEW.state);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_notify_executor_state
  AFTER UPDATE OF state ON executors
  FOR EACH ROW EXECUTE FUNCTION notify_executor_state_change();
