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

-- Relax NOT NULL constraints on runtime columns that now live in executors.
-- The register() function only inserts identity columns; runtime data goes to executors.
-- Adding DEFAULTs lets old and new code coexist during transition.
ALTER TABLE agents ALTER COLUMN pane_id SET DEFAULT '';
ALTER TABLE agents ALTER COLUMN session SET DEFAULT '';
ALTER TABLE agents ALTER COLUMN repo_path SET DEFAULT '';
ALTER TABLE agents ALTER COLUMN state SET DEFAULT 'spawning';
ALTER TABLE agents ALTER COLUMN last_state_change SET DEFAULT now();

-- Make runtime columns nullable so identity-only INSERTs work
ALTER TABLE agents ALTER COLUMN pane_id DROP NOT NULL;
ALTER TABLE agents ALTER COLUMN session DROP NOT NULL;
ALTER TABLE agents ALTER COLUMN repo_path DROP NOT NULL;
ALTER TABLE agents ALTER COLUMN state DROP NOT NULL;
ALTER TABLE agents ALTER COLUMN last_state_change DROP NOT NULL;

-- NOTE: Column drops and session re-key are deferred to Group 3 (agent-registry refactor)
-- and Group 7 (consumer query updates). This migration is additive-only so that existing
-- code continues to work during the parallel wave transition. The old columns remain in
-- agents until the code that references them is updated.
--
-- Deferred operations (to be added as 013_executor_cleanup.sql):
-- - DROP old runtime columns from agents (pane_id, session, state, etc.)
-- - DROP old indexes and triggers on agents
-- - Re-key sessions.agent_id → sessions.executor_id
-- - DROP sessions.agent_id

-- Add executor_id to sessions (additive — keeps agent_id for now)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS executor_id TEXT REFERENCES executors(id) ON DELETE SET NULL;

-- Populate executor_id from existing agent_id
UPDATE sessions SET executor_id = 'exec-' || agent_id WHERE agent_id IS NOT NULL AND executor_id IS NULL;

-- Index on the new column
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

-- ============================================================================
-- TUI kanban link columns — additive schema for cross-table relationships
-- ============================================================================

-- Direct task → team link (set by genie team create)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS team_name TEXT;

-- Team progress: total groups from wish for "5/9 done" display
ALTER TABLE teams ADD COLUMN IF NOT EXISTS total_groups INTEGER;

-- Reverse team → board task link
ALTER TABLE teams ADD COLUMN IF NOT EXISTS task_id TEXT;

-- Org tree: agent hierarchy (self-ref, NULL = root)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS reports_to TEXT;

-- Agent title in org context (CPO, CTO, Research Lead, etc.)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS title TEXT;
