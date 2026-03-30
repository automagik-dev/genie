-- 015: Archive Lifecycle — soft-delete for tasks, projects, boards, teams.
-- Adds 'archived' status + archived_at timestamp to all four entities.
-- Idempotent: safe to re-run.

-- Tasks: extend status CHECK to include 'archived'
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('blocked', 'ready', 'in_progress', 'done', 'failed', 'cancelled', 'archived'));
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- Projects: add status + archived_at
ALTER TABLE projects ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_check;
ALTER TABLE projects ADD CONSTRAINT projects_status_check
  CHECK (status IN ('active', 'archived'));
ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
UPDATE projects SET status = 'active' WHERE status IS NULL;

-- Boards: add status + archived_at
ALTER TABLE boards ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
ALTER TABLE boards DROP CONSTRAINT IF EXISTS boards_status_check;
ALTER TABLE boards ADD CONSTRAINT boards_status_check
  CHECK (status IN ('active', 'archived'));
ALTER TABLE boards ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
UPDATE boards SET status = 'active' WHERE status IS NULL;

-- Teams: extend status CHECK to include 'archived'
ALTER TABLE teams DROP CONSTRAINT IF EXISTS teams_status_check;
ALTER TABLE teams ADD CONSTRAINT teams_status_check
  CHECK (status IN ('in_progress', 'done', 'blocked', 'archived'));
ALTER TABLE teams ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- Partial indexes for fast active queries
CREATE INDEX IF NOT EXISTS idx_tasks_archived ON tasks(status) WHERE status = 'archived';
CREATE INDEX IF NOT EXISTS idx_projects_archived ON projects(status) WHERE status = 'archived';
CREATE INDEX IF NOT EXISTS idx_boards_archived ON boards(status) WHERE status = 'archived';
CREATE INDEX IF NOT EXISTS idx_teams_archived ON teams(status) WHERE status = 'archived';
