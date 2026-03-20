-- 003_machine_snapshots.sql — Machine state snapshots for scheduler observability

CREATE TABLE IF NOT EXISTS machine_snapshots (
  id TEXT PRIMARY KEY,
  active_workers INTEGER NOT NULL DEFAULT 0,
  active_teams INTEGER NOT NULL DEFAULT 0,
  tmux_sessions INTEGER NOT NULL DEFAULT 0,
  cpu_percent REAL,
  memory_mb REAL,
  context JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_machine_snapshots_created
  ON machine_snapshots(created_at);
