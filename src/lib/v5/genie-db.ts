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
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
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
// Fail-closed project context (Group A: no outer/cache-root empty-board masquerade)
// ============================================================================

/**
 * The typed states a project surface resolves BEFORE any MCP tool can serialize
 * an empty board. A non-`ok` kind MUST surface as a structured error, never a
 * healthy-looking empty projection. Bare/submodule/external-git-dir layouts are
 * `unsupported-project-layout`; they never fall outward or to a plugin cache.
 */
export type ProjectContextKind =
  | 'ok'
  | 'project-context-unavailable'
  | 'project-database-unavailable'
  | 'unsupported-project-layout';

export interface ProjectContextOk {
  kind: 'ok';
  /** The child's observable `process.cwd()`; Genie NEVER chdir's away from it. */
  effectiveLaunchCwd: string;
  /** Nearest containing worktree root; a linked worktree stays linked here. */
  worktreeConfigRoot: string;
  /** Absolute `git rev-parse --git-common-dir` (the MAIN repo's `.git` for a linked worktree). */
  gitCommonDir: string;
  /** `dirname(gitCommonDir)` — the repo that owns the shared genie.db. */
  genieStorageRoot: string;
  /** The ONLY database candidate: `<genieStorageRoot>/.genie/genie.db`. */
  dbPath: string;
}

export interface ProjectContextError {
  kind: Exclude<ProjectContextKind, 'ok'>;
  /** The observable launch CWD is always known, even on failure. */
  effectiveLaunchCwd: string;
  detail: string;
  /** Best-effort roots when they are resolvable (e.g. database-unavailable). */
  worktreeConfigRoot?: string;
  gitCommonDir?: string;
  genieStorageRoot?: string;
  dbPath?: string;
}

export type ProjectContext = ProjectContextOk | ProjectContextError;

/** Trimmed stdout of a bounded, no-shell `git` invocation, or `null` on failure. */
function runGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5_000,
    }).trim();
  } catch {
    return null;
  }
}

/** A linked worktree's git dir lives under `<commonDir>/worktrees/<name>`. */
function isLinkedWorktree(gitDir: string, gitCommonDir: string): boolean {
  return normalize(dirname(gitDir)) === normalize(join(gitCommonDir, 'worktrees'));
}

/** A `.git` FILE at a non-linked worktree root marks an external/separate git dir. */
function dotGitIsFile(worktreeRoot: string): boolean {
  try {
    return lstatSync(join(worktreeRoot, '.git')).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the four-value production path model for `cwd` WITHOUT ever changing
 * the process CWD or considering a plugin cache. Git discovery stops at the
 * nearest enclosing worktree, so a nested initialized repository resolves to its
 * OWN storage root and a nested repo without a Genie database fails at that
 * boundary rather than walking outward to an outer database.
 *
 * Bare repositories, submodules, and external/separate-Git-dir layouts return
 * `unsupported-project-layout` BEFORE any database lookup. A resolvable layout
 * whose `<genieStorageRoot>/.genie/genie.db` is absent returns
 * `project-database-unavailable` — never an empty board.
 */
export function resolveProjectContext(cwd: string = process.cwd()): ProjectContext {
  const effectiveLaunchCwd = cwd;
  // Bare vs not-a-repo: `--is-bare-repository` succeeds inside a git dir even
  // where `--show-toplevel` would abort, so it cleanly separates the two.
  const isBare = runGit(cwd, ['rev-parse', '--is-bare-repository']);
  if (isBare === null) {
    return { kind: 'project-context-unavailable', effectiveLaunchCwd, detail: `no Git worktree contains ${cwd}` };
  }
  if (isBare === 'true') {
    return {
      kind: 'unsupported-project-layout',
      effectiveLaunchCwd,
      detail: 'bare Git repositories are not a supported Genie project layout',
    };
  }
  // A non-empty superproject working tree means cwd is inside a submodule.
  const superproject = runGit(cwd, ['rev-parse', '--path-format=absolute', '--show-superproject-working-tree']);
  if (superproject) {
    return {
      kind: 'unsupported-project-layout',
      effectiveLaunchCwd,
      detail: 'Git submodules are not a supported Genie project layout',
    };
  }
  const raw = runGit(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--git-dir']);
  const [topRaw, commonRaw, gitDirRaw] = (raw ?? '').split('\n').map((line) => line.trim());
  if (!topRaw || !commonRaw || !gitDirRaw) {
    return {
      kind: 'project-context-unavailable',
      effectiveLaunchCwd,
      detail: `unable to resolve Git roots for ${cwd}`,
    };
  }
  const worktreeConfigRoot = normalizeGitPath(topRaw);
  const gitCommonDir = normalizeGitPath(commonRaw);
  const gitDir = normalizeGitPath(gitDirRaw);
  // A non-linked worktree whose `.git` is a FILE points its common dir outside
  // the project (`git init --separate-git-dir`); `dirname(gitCommonDir)` would
  // then be an unrelated directory, so refuse it explicitly.
  if (!isLinkedWorktree(gitDir, gitCommonDir) && dotGitIsFile(worktreeConfigRoot)) {
    return {
      kind: 'unsupported-project-layout',
      effectiveLaunchCwd,
      worktreeConfigRoot,
      gitCommonDir,
      detail: 'external/separate Git directory layouts are not a supported Genie project layout',
    };
  }
  const genieStorageRoot = normalizeGitPath(dirname(gitCommonDir));
  const dbPath = join(genieStorageRoot, '.genie', 'genie.db');
  if (!existsSync(dbPath)) {
    return {
      kind: 'project-database-unavailable',
      effectiveLaunchCwd,
      worktreeConfigRoot,
      gitCommonDir,
      genieStorageRoot,
      dbPath,
      detail: `no Genie database at ${dbPath}; run \`genie init\` in ${genieStorageRoot}`,
    };
  }
  return { kind: 'ok', effectiveLaunchCwd, worktreeConfigRoot, gitCommonDir, genieStorageRoot, dbPath };
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
