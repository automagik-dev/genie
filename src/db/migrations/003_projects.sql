-- 003_projects.sql — Project abstraction for multi-board task segmentation
-- Adds projects table, tasks.project_id FK, and backfills existing tasks.

-- ============================================================================
-- Table: projects — Named boards for task segmentation
-- ============================================================================
CREATE TABLE projects (
  id TEXT PRIMARY KEY DEFAULT 'proj-' || substr(gen_random_uuid()::text, 1, 8),
  name TEXT UNIQUE NOT NULL,
  repo_path TEXT,  -- NULL = virtual project (no repo backing)
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_projects_repo ON projects(repo_path) WHERE repo_path IS NOT NULL;

-- ============================================================================
-- Add project_id to tasks
-- ============================================================================
ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects(id);
CREATE INDEX idx_tasks_project ON tasks(project_id);

-- ============================================================================
-- Backfill: create projects from existing distinct repo_path values,
-- then link all existing tasks to their project.
-- ============================================================================

-- Step 1: Insert a project per distinct repo_path (name = basename)
INSERT INTO projects (name, repo_path)
SELECT DISTINCT
  -- Extract basename: everything after the last '/'
  CASE
    WHEN repo_path LIKE '%/%' THEN substring(repo_path FROM '[^/]+$')
    ELSE repo_path
  END,
  repo_path
FROM tasks
WHERE repo_path IS NOT NULL
ON CONFLICT (name) DO NOTHING;

-- Step 2: Set project_id on all existing tasks
UPDATE tasks t
SET project_id = p.id
FROM projects p
WHERE t.repo_path = p.repo_path
  AND t.project_id IS NULL;
