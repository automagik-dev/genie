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
const EXPECTED_TABLES = [
  'boards',
  'hire_roster',
  'meta',
  'stage_log',
  'task_dependencies',
  'task_events',
  'tasks',
  'wish_groups',
] as const;

/**
 * True when the DB is already at the current schema — every expected table plus
 * the additive lane/wish columns backfilled by {@link ensureTaskColumns} and
 * {@link ensureBoardColumns}. Pure reads (no write lock), so a known-current DB
 * opens without contending on the schema lock. A pre-column v1 DB (missing any
 * of these) returns false → ensureSchema runs and backfills. This MUST stay in
 * lockstep with the ensure* helpers: an added column absent here would let an
 * already-initialized DB short-circuit past the backfill.
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
  const taskCols = new Set((db.query('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((c) => c.name));
  if (!taskCols.has('wish') || !taskCols.has('group_name') || !taskCols.has('lane')) return false;
  // Runtime layer (additive-nullable): identity, heartbeat liveness, enforced block.
  for (const c of ['agent_kind', 'heartbeat_at', 'blocked_by', 'blocked_reason']) {
    if (!taskCols.has(c)) return false;
  }
  const boardCols = new Set(
    (db.query('PRAGMA table_info(boards)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  return boardCols.has('lanes');
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

CREATE TABLE IF NOT EXISTS task_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  note        TEXT,
  author_kind TEXT,
  author      TEXT,
  created_at  INTEGER NOT NULL
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

CREATE TABLE IF NOT EXISTS hire_roster (
  wish             TEXT NOT NULL,
  agent_adapter_id TEXT NOT NULL,
  profile          TEXT,
  worktree         TEXT NOT NULL,
  hired_at         INTEGER NOT NULL,
  state            TEXT NOT NULL,
  PRIMARY KEY (wish, agent_adapter_id)
);

CREATE INDEX IF NOT EXISTS idx_task_deps_dep ON task_dependencies(depends_on_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_stage_log_task ON stage_log(task_id);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id);
`;

/** Create every table/index if absent. Idempotent — pure `IF NOT EXISTS`. */
export function ensureSchema(db: Database): void {
  db.exec(SCHEMA_SQL);
  ensureTaskColumns(db);
  ensureBoardColumns(db);
  backfillStageLog(db);
}

/**
 * Additive, in-place column backfill for `tasks`. `CREATE TABLE IF NOT EXISTS`
 * never alters an existing table, so a DB stamped by an earlier build (which
 * lacked `wish`/`group_name`/`lane`) needs the columns added. All are nullable,
 * so this stays within `user_version = 1` — no destructive migration, no version
 * bump. Idempotent: a table that already has the columns is left untouched.
 */
function ensureTaskColumns(db: Database): void {
  const cols = new Set((db.query('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((c) => c.name));
  if (!cols.has('wish')) db.exec('ALTER TABLE tasks ADD COLUMN wish TEXT');
  if (!cols.has('group_name')) db.exec('ALTER TABLE tasks ADD COLUMN group_name TEXT');
  if (!cols.has('lane')) db.exec('ALTER TABLE tasks ADD COLUMN lane TEXT');
  // Runtime layer: authored identity, heartbeat liveness, and the enforced block
  // (blocked_by drives the single carved checkout exception). All nullable ⇒ no
  // user_version bump; the card-projection render reads them, TaskRow stays frozen.
  if (!cols.has('agent_kind')) db.exec('ALTER TABLE tasks ADD COLUMN agent_kind TEXT');
  if (!cols.has('heartbeat_at')) db.exec('ALTER TABLE tasks ADD COLUMN heartbeat_at INTEGER');
  if (!cols.has('blocked_by')) db.exec('ALTER TABLE tasks ADD COLUMN blocked_by TEXT');
  if (!cols.has('blocked_reason')) db.exec('ALTER TABLE tasks ADD COLUMN blocked_reason TEXT');
}

/** Meta key marking the one-time stage_log → task_events backfill as complete. */
const STAGE_LOG_BACKFILL_KEY = 'stage_log_backfill_v1';

/** task_events kinds a legacy stage label maps to directly; anything else → comment. */
const BACKFILLABLE_EVENT_KINDS = ['comment', 'move', 'claim', 'release', 'block', 'unblock', 'report'] as const;

/**
 * One-time migration of the deprecated `stage_log` into the `task_events`
 * timeline. `stage_log` is retained (older binaries on the worktree-shared DB
 * still read it), but the card timeline is now the source of truth, so existing
 * history is mirrored across once. A legacy stage label that names a real event
 * kind becomes that kind; every other label becomes a `comment` whose note keeps
 * the original label so nothing is lost. `created_at` is preserved. Author fields
 * are null (historical rows predate authored attribution).
 *
 * Idempotent via a `meta` guard: a re-open (or a second worktree opening the same
 * DB) never duplicates rows. Runs inside {@link ensureSchema} under the write lock.
 */
function backfillStageLog(db: Database): void {
  const done = db.query('SELECT 1 FROM meta WHERE key = ?').get(STAGE_LOG_BACKFILL_KEY);
  if (done) return;
  const kinds = BACKFILLABLE_EVENT_KINDS.map((k) => `'${k}'`).join(', ');
  const tx = db.transaction(() => {
    db.exec(
      `INSERT INTO task_events (task_id, kind, note, author_kind, author, created_at)
       SELECT task_id,
              CASE WHEN stage IN (${kinds}) THEN stage ELSE 'comment' END,
              CASE WHEN stage IN (${kinds}) THEN note
                   WHEN note IS NOT NULL THEN stage || ': ' || note
                   ELSE stage END,
              NULL, NULL, created_at
       FROM stage_log
       ORDER BY id`,
    );
    db.query('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(STAGE_LOG_BACKFILL_KEY, String(Date.now()));
  });
  tx();
}

/**
 * Additive, in-place column backfill for `boards`. Adds the nullable `lanes`
 * JSON column to a DB stamped before lifecycle lanes existed. Nullable ⇒ stays
 * within `user_version = 1`. Idempotent: a no-op once the column is present.
 */
function ensureBoardColumns(db: Database): void {
  const cols = new Set((db.query('PRAGMA table_info(boards)').all() as Array<{ name: string }>).map((c) => c.name));
  if (!cols.has('lanes')) db.exec('ALTER TABLE boards ADD COLUMN lanes TEXT');
}
