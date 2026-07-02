/**
 * Genie v5 state engine — bun:sqlite open/init.
 *
 * The v5 "lightweight body": documents live in git, operational state lives in
 * `.genie/genie.db`. Zero daemons, zero Postgres. A CLI invocation opens this
 * file, runs one transaction, and exits. See TAXONOMY.md for the full contract.
 *
 * This module owns:
 *   - worktree-aware DB path resolution (all worktrees share one genie.db),
 *   - idempotent schema creation stamped with `PRAGMA user_version = 1`,
 *   - WAL + busy_timeout so concurrent writers surface as clean claim-conflicts
 *     rather than SQLITE_BUSY flake,
 *   - refusal of malformed / foreign databases with typed errors.
 */

import type { Database } from 'bun:sqlite';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openSqlite } from './sqlite-open.js';

// Concurrency + typed-error primitives now live in sqlite-open.ts (shared with
// the global DB). Re-exported here so existing importers of ./genie-db keep
// working — this stays the public surface for the per-repo database.
export {
  BUSY_TIMEOUT_MS,
  BusyDbError,
  ForeignDbError,
  GenieDbError,
  isBusyError,
  MalformedDbError,
} from './sqlite-open.js';

/** Schema revision stamped into `PRAGMA user_version`. Bump on breaking change. */
export const CURRENT_SCHEMA_VERSION = 1;

// ============================================================================
// Path resolution (worktree-aware)
// ============================================================================

/** Canonicalize macOS `/private`-prefixed paths so worktrees resolve identically. */
function normalizeGitPath(path: string): string {
  if (process.platform !== 'darwin') return path;
  if (!path.startsWith('/private/')) return path;
  const logicalPath = path.slice('/private'.length);
  return existsSync(logicalPath) ? logicalPath : path;
}

/**
 * Resolve the repo root that owns the shared `.genie/`. Uses
 * `git rev-parse --git-common-dir`, whose parent is the MAIN repo root even when
 * invoked from a linked worktree — so every worktree resolves to one genie.db.
 * Falls back to `cwd` when not inside a git repo.
 *
 * Git discovery walks up from `cwd`, so invocation from a repo subdirectory
 * (e.g. `repo/src/`) still resolves to the repo-root DB — no ceiling is imposed.
 * A prior `GIT_CEILING_DIRECTORIES=dirname(cwd)` broke subdir discovery,
 * silently falling back to cwd and creating a stray `repo/src/.genie/genie.db`.
 */
export function resolveRepoRoot(cwd?: string): string {
  const dir = cwd ?? process.cwd();
  try {
    const commonDir = execSync('git rev-parse --path-format=absolute --git-common-dir', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: dir,
    }).trim();
    return normalizeGitPath(dirname(commonDir));
  } catch {
    return normalizeGitPath(dir);
  }
}

/** Absolute path to the shared genie.db for the repo containing `cwd`. */
export function resolveDbPath(cwd?: string): string {
  return join(resolveRepoRoot(cwd), '.genie', 'genie.db');
}

// ============================================================================
// Open / init
// ============================================================================

export interface OpenOptions {
  /** Explicit DB file path. Overrides `cwd`-based resolution. `:memory:` allowed. */
  path?: string;
  /** Working directory used for git-based path resolution when `path` is absent. */
  cwd?: string;
}

/**
 * Open (creating if absent) the genie.db for a repo, apply concurrency pragmas,
 * and ensure the schema. Refuses malformed or foreign databases with typed
 * errors. Idempotent: safe to call on every CLI invocation.
 */
export function openDb(opts: OpenOptions = {}): Database {
  return openSqlite({
    path: opts.path ?? resolveDbPath(opts.cwd),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    ensureSchema,
    schemaIsCurrent,
  });
}

/** Tables a fully-initialized `user_version = 1` DB must carry. */
const EXPECTED_TABLES = ['boards', 'meta', 'stage_log', 'task_dependencies', 'tasks', 'wish_groups'] as const;

/**
 * True when the DB is already at the current schema — every expected table plus
 * the additive `wish`/`group_name` columns on `tasks`. Pure reads (no write
 * lock), so a known-current DB opens without contending on the schema lock.
 * A pre-column v1 DB (missing wish/group_name) returns false → ensureSchema runs
 * and backfills, preserving {@link ensureTaskColumns} semantics.
 */
function schemaIsCurrent(db: Database): boolean {
  const tables = new Set(
    (
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name),
  );
  for (const t of EXPECTED_TABLES) if (!tables.has(t)) return false;
  const cols = new Set((db.query('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((c) => c.name));
  return cols.has('wish') && cols.has('group_name');
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS boards (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id         TEXT PRIMARY KEY,
  board_id   TEXT REFERENCES boards(id) ON DELETE SET NULL,
  title      TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('blocked', 'ready', 'in_progress', 'done')),
  claimed_by TEXT,
  claimed_at INTEGER,
  wish       TEXT,
  group_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_id)
);

CREATE TABLE IF NOT EXISTS stage_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  stage      TEXT NOT NULL,
  note       TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wish_groups (
  wish         TEXT NOT NULL,
  name         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('blocked', 'ready', 'in_progress', 'done')),
  depends_on   TEXT NOT NULL DEFAULT '[]',
  assignee     TEXT,
  started_at   INTEGER,
  completed_at INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (wish, name)
);

CREATE INDEX IF NOT EXISTS idx_task_deps_dep ON task_dependencies(depends_on_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_stage_log_task ON stage_log(task_id);
`;

/** Create every table/index if absent. Idempotent — pure `IF NOT EXISTS`. */
export function ensureSchema(db: Database): void {
  db.exec(SCHEMA_SQL);
  ensureTaskColumns(db);
}

/**
 * Additive, in-place column backfill for `tasks`. `CREATE TABLE IF NOT EXISTS`
 * never alters an existing table, so a DB stamped by an earlier build (which
 * lacked `wish`/`group_name`) needs the columns added. Both are nullable, so
 * this stays within `user_version = 1` — no destructive migration, no version
 * bump. Idempotent: a table that already has the columns is left untouched.
 */
function ensureTaskColumns(db: Database): void {
  const cols = new Set((db.query('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((c) => c.name));
  if (!cols.has('wish')) db.exec('ALTER TABLE tasks ADD COLUMN wish TEXT');
  if (!cols.has('group_name')) db.exec('ALTER TABLE tasks ADD COLUMN group_name TEXT');
}
