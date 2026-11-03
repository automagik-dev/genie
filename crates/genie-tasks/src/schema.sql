-- The one definition of Genie's Rust-owned tables in the per-repo .genie/genie.db.
-- Loaded by the store with include_str! and by the TS T9 fixtures with readFileSync, so a database
-- seeded from this file alone matches what the store creates. Every name carries the v7_ prefix,
-- so none can collide with a TS table; PRAGMA user_version is never written here.

-- Append-only: never updated or deleted, so the rowid `seq` only grows: it is the replay order.
-- No AUTOINCREMENT, which would add a row to the sqlite_sequence table TS shares.
CREATE TABLE IF NOT EXISTS v7_task_events (
  seq INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  task_key TEXT NOT NULL,
  task TEXT NOT NULL DEFAULT '',
  event TEXT NOT NULL CHECK (event IN ('created', 'opened', 'merged', 'closed')),
  forge TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT '',
  "commit" TEXT NOT NULL DEFAULT '',
  worktree TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  lead TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL,
  counted INTEGER NOT NULL DEFAULT 1 CHECK (counted IN (0, 1)),
  exclude_reason TEXT NOT NULL DEFAULT '',
  -- Commits pushed after the PR opened; NULL when the forge cannot say (never a measured-looking 0).
  pushed_after_open INTEGER,
  dedupe_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS v7_task_events_by_task ON v7_task_events (project, task_key, seq);

-- The current state of each task, derived from v7_task_events in the same transaction.
-- task_key is the task id, or pr:<forge>:<url> for a PR/MR whose branch carries none.
CREATE TABLE IF NOT EXISTS v7_tasks (
  project TEXT NOT NULL,
  task_key TEXT NOT NULL,
  task TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK (state IN ('created', 'opened', 'merged', 'closed')),
  title TEXT NOT NULL DEFAULT '',
  lead TEXT NOT NULL DEFAULT '',
  forge TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT '',
  last_seq INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project, task_key)
);

-- gn-<seq> reservations, minted by `start` (group 2). A failed start marks its row abandoned,
-- which leaves a gap in the sequence and never a reused id.
CREATE TABLE IF NOT EXISTS v7_task_ids (
  project TEXT NOT NULL,
  seq INTEGER NOT NULL,
  task TEXT NOT NULL,
  reserved_at TEXT NOT NULL,
  abandoned INTEGER NOT NULL DEFAULT 0 CHECK (abandoned IN (0, 1)),
  PRIMARY KEY (project, seq)
);

-- Rust's own schema version, one row; TS's PRAGMA user_version stays TS's.
CREATE TABLE IF NOT EXISTS v7_schema (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
);
INSERT OR IGNORE INTO v7_schema (id, version) VALUES (1, 1);
