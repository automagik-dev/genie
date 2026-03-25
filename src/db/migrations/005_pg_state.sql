-- 005_pg_state.sql — Mutable agent state tables (replaces JSON files)
-- Tables: agents, agent_templates, teams, mailbox, team_chat
-- Replaces: workers.json, teams/*.json, mailbox/*.json, chat/*.jsonl

-- ============================================================================
-- Table 1: agents — Mirrors Agent TypeScript interface
-- Replaces: ~/.genie/workers.json → workers record
-- ============================================================================
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  pane_id TEXT NOT NULL,
  session TEXT NOT NULL,
  worktree TEXT,
  task_id TEXT,
  task_title TEXT,
  wish_slug TEXT,
  group_number INTEGER,
  started_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL DEFAULT 'spawning'
    CHECK (state IN ('spawning', 'working', 'idle', 'permission', 'question', 'done', 'error', 'suspended')),
  last_state_change TIMESTAMPTZ NOT NULL DEFAULT now(),
  repo_path TEXT NOT NULL,
  claude_session_id TEXT,
  window_name TEXT,
  window_id TEXT,
  role TEXT,
  custom_name TEXT,
  sub_panes JSONB DEFAULT '[]',
  provider TEXT,
  transport TEXT DEFAULT 'tmux'
    CHECK (transport IN ('tmux', 'inline')),
  skill TEXT,
  team TEXT,
  tmux_window TEXT,
  native_agent_id TEXT,
  native_color TEXT,
  native_team_enabled BOOLEAN DEFAULT false,
  parent_session_id TEXT,
  suspended_at TIMESTAMPTZ,
  auto_resume BOOLEAN DEFAULT true,
  resume_attempts INTEGER DEFAULT 0,
  last_resume_attempt TIMESTAMPTZ,
  max_resume_attempts INTEGER DEFAULT 3,
  pane_color TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hot-path indexes
CREATE INDEX idx_agents_state ON agents(state);
CREATE INDEX idx_agents_team ON agents(team);
CREATE INDEX idx_agents_session ON agents(session);
CREATE INDEX idx_agents_pane_id ON agents(pane_id);
CREATE INDEX idx_agents_role_team ON agents(role, team);
CREATE INDEX idx_agents_wish_slug ON agents(wish_slug) WHERE wish_slug IS NOT NULL;
CREATE INDEX idx_agents_task_id ON agents(task_id) WHERE task_id IS NOT NULL;

-- ============================================================================
-- Table 2: agent_templates — Saved spawn configs for auto-respawn
-- Replaces: ~/.genie/workers.json → templates record
-- ============================================================================
CREATE TABLE agent_templates (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  team TEXT NOT NULL,
  role TEXT,
  skill TEXT,
  cwd TEXT NOT NULL,
  extra_args JSONB DEFAULT '[]',
  native_team_enabled BOOLEAN DEFAULT false,
  last_spawned_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_templates_team ON agent_templates(team);

-- ============================================================================
-- Table 3: teams — Team lifecycle configuration
-- Replaces: ~/.genie/teams/<name>.json
-- ============================================================================
CREATE TABLE teams (
  name TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  base_branch TEXT NOT NULL DEFAULT 'dev',
  worktree_path TEXT NOT NULL,
  leader TEXT,
  members JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'done', 'blocked')),
  native_team_parent_session_id TEXT,
  native_teams_enabled BOOLEAN DEFAULT false,
  tmux_session_name TEXT,
  wish_slug TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_teams_status ON teams(status);
CREATE INDEX idx_teams_wish_slug ON teams(wish_slug) WHERE wish_slug IS NOT NULL;

-- ============================================================================
-- Table 4: mailbox — Durable message store with unread/read semantics
-- Replaces: <repo>/.genie/mailbox/<worker>.json
-- ============================================================================
CREATE TABLE mailbox (
  id TEXT PRIMARY KEY,
  from_worker TEXT NOT NULL,
  to_worker TEXT NOT NULL,
  body TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  read BOOLEAN NOT NULL DEFAULT false,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hot-path: unread messages for a worker in a repo
CREATE INDEX idx_mailbox_to_worker_read ON mailbox(to_worker, read);
CREATE INDEX idx_mailbox_repo_path ON mailbox(repo_path);
CREATE INDEX idx_mailbox_from_worker ON mailbox(from_worker);
CREATE INDEX idx_mailbox_created ON mailbox(created_at DESC);

-- ============================================================================
-- Table 5: team_chat — Group channel messages per team
-- Replaces: <repo>/.genie/chat/<team>.jsonl
-- ============================================================================
CREATE TABLE team_chat (
  id TEXT PRIMARY KEY,
  team TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  sender TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hot-path: messages for a team in a repo
CREATE INDEX idx_team_chat_team_repo ON team_chat(team, repo_path);
CREATE INDEX idx_team_chat_created ON team_chat(team, repo_path, created_at);

-- ============================================================================
-- LISTEN/NOTIFY — Real-time notifications for state changes
-- ============================================================================

-- Notify on agent state changes
CREATE OR REPLACE FUNCTION notify_agent_state_change()
RETURNS trigger AS $$
BEGIN
  IF OLD.state IS DISTINCT FROM NEW.state THEN
    PERFORM pg_notify('genie_agent_state', NEW.id || ':' || COALESCE(OLD.state, '') || ':' || NEW.state);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_notify_agent_state
  AFTER UPDATE OF state ON agents
  FOR EACH ROW EXECUTE FUNCTION notify_agent_state_change();

-- Notify on new mailbox messages (for instant delivery)
CREATE OR REPLACE FUNCTION notify_mailbox_insert()
RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('genie_mailbox_delivery', NEW.to_worker || ':' || NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_notify_mailbox
  AFTER INSERT ON mailbox
  FOR EACH ROW EXECUTE FUNCTION notify_mailbox_insert();

-- Auto-update updated_at on agents
CREATE OR REPLACE FUNCTION update_agents_timestamp()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_agents_updated_at
  BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION update_agents_timestamp();

-- Auto-update updated_at on agent_templates
CREATE TRIGGER trg_agent_templates_updated_at
  BEFORE UPDATE ON agent_templates
  FOR EACH ROW EXECUTE FUNCTION update_agents_timestamp();

-- Auto-update updated_at on teams
CREATE TRIGGER trg_teams_updated_at
  BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION update_agents_timestamp();
