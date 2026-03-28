-- 011_data_model_v5.sql — Organizations, project leaders, agent-project links
-- Adds org hierarchy: Organization → Project (with leader) → Board → Task
-- Adds agent-project many-to-many with role (leader/member/contributor)
-- Adds team-project link
-- Cleans zombie data (stuck spawning agents, dead surgeon teams)

-- ============================================================================
-- Table: organizations — Multi-org support (single instance = one row)
-- ============================================================================
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY DEFAULT 'org-' || substr(gen_random_uuid()::text, 1, 8),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  leader_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed default org
INSERT INTO organizations (id, name, slug, description, leader_agent)
VALUES ('org-namastex', 'NamasteX', 'namastex', 'NamasteX Labs — AI agent orchestration', 'sofia')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- Alter: projects — add org, leader, tmux session
-- ============================================================================
ALTER TABLE projects ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES organizations(id) DEFAULT 'org-namastex';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS leader_agent TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS tmux_session TEXT;

CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id);
CREATE INDEX IF NOT EXISTS idx_projects_leader ON projects(leader_agent);

-- ============================================================================
-- Table: agent_projects — Many-to-many agent ↔ project with role
-- ============================================================================
CREATE TABLE IF NOT EXISTS agent_projects (
  agent_name TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_name, project_id),
  CHECK (role IN ('leader', 'member', 'contributor'))
);

CREATE INDEX IF NOT EXISTS idx_agent_projects_project ON agent_projects(project_id);
CREATE INDEX IF NOT EXISTS idx_agent_projects_agent ON agent_projects(agent_name);

-- ============================================================================
-- Alter: teams — add project link
-- ============================================================================
ALTER TABLE teams ADD COLUMN IF NOT EXISTS project_id TEXT REFERENCES projects(id);

CREATE INDEX IF NOT EXISTS idx_teams_project ON teams(project_id);

-- ============================================================================
-- Backfill: project leaders + tmux sessions
-- ============================================================================

-- Create missing project: research
INSERT INTO projects (id, name, description)
VALUES ('proj-research', 'research', 'Deep research, teardowns, competitive analysis, thesis development')
ON CONFLICT (id) DO NOTHING;

-- Assign leaders
UPDATE projects SET leader_agent = 'vegapunk', tmux_session = 'research' WHERE name = 'research';
UPDATE projects SET leader_agent = 'genie', tmux_session = 'genie' WHERE name = 'genie';
UPDATE projects SET leader_agent = 'genie-os' WHERE name = 'khal-os';
UPDATE projects SET leader_agent = 'omni' WHERE name = 'omni';
UPDATE projects SET leader_agent = 'totvs' WHERE name = 'totvs';
UPDATE projects SET leader_agent = 'hapvida-pm' WHERE name = 'hapvida';
UPDATE projects SET leader_agent = 'docs-pm' WHERE name = 'docs';
UPDATE projects SET leader_agent = 'sofia', tmux_session = 'sofia' WHERE name = 'nmstx-leadership';

-- Set org_id on all projects
UPDATE projects SET org_id = 'org-namastex' WHERE org_id IS NULL;

-- Populate agent_projects for leaders
INSERT INTO agent_projects (agent_name, project_id, role)
SELECT p.leader_agent, p.id, 'leader'
FROM projects p
WHERE p.leader_agent IS NOT NULL
ON CONFLICT DO NOTHING;

-- ============================================================================
-- Backfill: teams → projects via repo path
-- ============================================================================
UPDATE teams SET project_id = (SELECT id FROM projects WHERE name = 'khal-os')
  WHERE repo LIKE '%genie-os%' AND project_id IS NULL;
UPDATE teams SET project_id = (SELECT id FROM projects WHERE name = 'genie')
  WHERE repo LIKE '%/genie/repos/genie' AND project_id IS NULL;
UPDATE teams SET project_id = (SELECT id FROM projects WHERE name = 'genie')
  WHERE repo LIKE '%repos/genie-brain%' AND project_id IS NULL;
UPDATE teams SET project_id = (SELECT id FROM projects WHERE name = 'omni')
  WHERE repo LIKE '%omni%' AND project_id IS NULL;
UPDATE teams SET project_id = (SELECT id FROM projects WHERE name = 'totvs')
  WHERE repo LIKE '%totvs%' AND project_id IS NULL;
UPDATE teams SET project_id = (SELECT id FROM projects WHERE name = 'research')
  WHERE repo LIKE '%rlmx%' AND project_id IS NULL;

-- ============================================================================
-- Cleanup: zombie agents + dead projects
-- ============================================================================

-- Kill agents stuck in spawning > 1 hour
DELETE FROM agents WHERE state = 'spawning'
  AND created_at < now() - interval '1 hour';

-- Remove "sofia" as project (she's an org-level agent, not a project)
DELETE FROM agent_projects WHERE project_id IN (SELECT id FROM projects WHERE name = 'sofia');
DELETE FROM projects WHERE name = 'sofia';

-- Remove deprecated project
DELETE FROM agent_projects WHERE project_id IN (SELECT id FROM projects WHERE name = 'juice-router');
DELETE FROM projects WHERE name = 'juice-router';
