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
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, normalize, resolve } from 'node:path';
// One-way, deliberate: the per-repo database asks the GENIE_HOME path module
// where the machine-scope file lives so it can REFUSE to be that file. v6 ships
// no machine-scope database — the Omni runner owned every table it held — but
// the refusal outlives it, because a host contaminated before the rule landed
// still carries the file and both databases stamp `user_version = 1`.
import { resolveGenieHome, resolveGlobalDbPath } from '../genie-home.js';
import { assertLocalLifecycleEnabled } from '../orchestration-mode.js';
import { printErr } from '../term-output.js';
import { GenieDbError, type PreparedMigrationBackup, openSqlite } from './sqlite-open.js';

// Concurrency + typed-error primitives now live in sqlite-open.ts (shared with
// the global DB). Re-exported here so existing importers of ./genie-db keep
// working — this stays the public surface for the per-repo database.
export {
  /** @public Backward-compatible per-repo database facade export. */
  BUSY_TIMEOUT_MS,
  BusyDbError,
  ForeignDbError,
  GenieDbError,
  isBusyError,
  MalformedDbError,
  PendingMigrationError,
} from './sqlite-open.js';

/**
 * Schema revision stamped into `PRAGMA user_version`. Bump on breaking change,
 * and add the matching {@link SCHEMA_MIGRATIONS} step in the same commit — a
 * bump alone makes `initOrValidate` refuse every database already on disk.
 *
 * 1 -> 2 (wish `v6-stable-cut`): `hire_roster` dropped.
 */
export const CURRENT_SCHEMA_VERSION = 2;

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

/**
 * Absolute path to the git-tracked roadmap snapshot for the repo containing
 * `cwd`. Unlike genie.db (gitignored, binary, WAL), this JSON snapshot is
 * committed so the board survives a clone: refresh with
 * `genie task export --write`, restore with `genie task import`.
 */
export function resolveRoadmapPath(cwd?: string): string {
  return join(resolveRepoRoot(cwd), '.genie', 'roadmap.json');
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

interface PhysicalFileIdentity {
  device: string;
  inode: string;
}

/**
 * A fail-closed binding between the repository's one logical database path and
 * the physical regular file validated there. MCP opens this exact binding; it
 * never recomputes a candidate from cwd after project-context validation.
 */
export interface ProjectDatabaseBinding {
  kind: 'validated-project-database';
  logicalPath: string;
  physicalPath: string;
  directoryIdentity: PhysicalFileIdentity;
  databaseIdentity: PhysicalFileIdentity;
}

export type ProjectDatabaseBindingResult =
  | { ok: true; binding: ProjectDatabaseBinding }
  | { ok: false; detail: string };

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
  /**
   * Exact physical regular-file binding for `dbPath`. Production resolution
   * always supplies it; optionality preserves injected diagnostic fixtures,
   * which the MCP server refuses rather than opening by cwd.
   */
  databaseBinding?: ProjectDatabaseBinding;
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

function fileIdentity(path: string): PhysicalFileIdentity {
  const stat = lstatSync(path);
  return { device: String(stat.dev), inode: String(stat.ino) };
}

function sameIdentity(left: PhysicalFileIdentity, right: PhysicalFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function samePhysicalPath(left: string, right: string): boolean {
  return normalize(normalizeGitPath(left)) === normalize(normalizeGitPath(right));
}

/**
 * Resolve and revalidate the physical `.genie/genie.db` boundary.
 *
 * Both `.genie` and `genie.db` must be direct, non-symlink filesystem entries;
 * the database must be a regular file. The double identity observation catches
 * replacements during resolution, while an optional expected binding fences a
 * later readonly open against path substitution.
 */
export function resolveProjectDatabaseBinding(
  dbPath: string,
  expected?: ProjectDatabaseBinding,
): ProjectDatabaseBindingResult {
  const logicalPath = normalize(dbPath);
  const directoryPath = dirname(logicalPath);
  try {
    const directoryBefore = lstatSync(directoryPath);
    if (directoryBefore.isSymbolicLink() || !directoryBefore.isDirectory()) {
      return {
        ok: false,
        detail: `unsafe Genie database binding at ${logicalPath}: ${directoryPath} must be a physical directory, not a symlink or non-directory`,
      };
    }
    const databaseBefore = lstatSync(logicalPath);
    if (databaseBefore.isSymbolicLink() || !databaseBefore.isFile() || databaseBefore.nlink !== 1) {
      return {
        ok: false,
        detail: `unsafe Genie database binding at ${logicalPath}: genie.db must be a singly linked physical regular file, not a symlink, hardlink, or non-file`,
      };
    }

    const physicalDirectory = normalizeGitPath(realpathSync(directoryPath));
    const expectedPhysicalDirectory = join(
      normalizeGitPath(realpathSync(dirname(directoryPath))),
      basename(directoryPath),
    );
    if (!samePhysicalPath(physicalDirectory, expectedPhysicalDirectory)) {
      return {
        ok: false,
        detail: `unsafe Genie database binding at ${logicalPath}: .genie resolves outside its repository storage root`,
      };
    }
    const physicalPath = normalizeGitPath(realpathSync(logicalPath));
    const expectedPhysicalPath = join(physicalDirectory, basename(logicalPath));
    if (!samePhysicalPath(physicalPath, expectedPhysicalPath)) {
      return {
        ok: false,
        detail: `unsafe Genie database binding at ${logicalPath}: genie.db resolves to a physical alias`,
      };
    }

    const directoryIdentity = fileIdentity(directoryPath);
    const databaseIdentity = fileIdentity(logicalPath);
    const databaseAfter = lstatSync(logicalPath);
    const directoryBeforeIdentity = {
      device: String(directoryBefore.dev),
      inode: String(directoryBefore.ino),
    };
    const databaseBeforeIdentity = {
      device: String(databaseBefore.dev),
      inode: String(databaseBefore.ino),
    };
    if (
      databaseAfter.isSymbolicLink() ||
      !databaseAfter.isFile() ||
      databaseAfter.nlink !== 1 ||
      !sameIdentity(directoryBeforeIdentity, directoryIdentity) ||
      !sameIdentity(databaseBeforeIdentity, databaseIdentity)
    ) {
      return {
        ok: false,
        detail: `unsafe Genie database binding at ${logicalPath}: path identity changed during validation`,
      };
    }

    const binding: ProjectDatabaseBinding = {
      kind: 'validated-project-database',
      logicalPath,
      physicalPath,
      directoryIdentity,
      databaseIdentity,
    };
    if (
      expected !== undefined &&
      (!samePhysicalPath(binding.logicalPath, expected.logicalPath) ||
        !samePhysicalPath(binding.physicalPath, expected.physicalPath) ||
        !sameIdentity(binding.directoryIdentity, expected.directoryIdentity) ||
        !sameIdentity(binding.databaseIdentity, expected.databaseIdentity))
    ) {
      return {
        ok: false,
        detail: `unsafe Genie database binding at ${logicalPath}: validated path identity no longer matches`,
      };
    }
    return { ok: true, binding };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `unable to validate Genie database at ${logicalPath}: ${detail}` };
  }
}

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
  const database = resolveProjectDatabaseBinding(dbPath);
  if (!database.ok) {
    return {
      kind: 'project-database-unavailable',
      effectiveLaunchCwd,
      worktreeConfigRoot,
      gitCommonDir,
      genieStorageRoot,
      dbPath,
      detail: `${database.detail}; run \`genie init\` in ${genieStorageRoot}`,
    };
  }
  return {
    kind: 'ok',
    effectiveLaunchCwd,
    worktreeConfigRoot,
    gitCommonDir,
    genieStorageRoot,
    dbPath,
    databaseBinding: database.binding,
  };
}

// ============================================================================
// Separation guard: the per-repo schema never lands in the global database
// ============================================================================

const GLOBAL_DB_REFUSAL = [
  'that file is GENIE_HOME/genie.db (the machine-scope database), and the per-repo',
  'task/board schema must never be written into it. Run the command from inside a repository,',
  "or point GENIE_HOME at a directory that is not this repo's .genie/.",
].join(' ');

/**
 * The resolved path names the machine-scope `<GENIE_HOME>/genie.db`, so opening
 * it here would write the 9-table per-repo schema into a machine-scope file.
 * v6 ships nothing into that path — the Omni runner owned every table it ever
 * held — but the refusal outlives the feature: an older host still carries the
 * file, both databases stamp `user_version = 1`, and a future per-repo
 * migration must never be able to run against — or silently skip — it.
 */
export class GlobalDbPathError extends GenieDbError {
  readonly path: string;
  constructor(path: string) {
    super(`Refusing to open the machine-scope database at ${path} as a per-repo genie.db: ${GLOBAL_DB_REFUSAL}`);
    this.name = 'GlobalDbPathError';
    this.path = path;
  }
}

/**
 * Absolute, symlink-resolved spelling of a database path. The directory is
 * realpath'd (the file itself may not exist yet), so `GENIE_HOME` pointing at a
 * symlink of `$HOME/.genie` still compares equal to the literal spelling.
 */
function canonicalDbPath(path: string): string {
  const absolute = resolve(path);
  try {
    return join(realpathSync(dirname(absolute)), basename(absolute));
  } catch {
    return absolute;
  }
}

/**
 * Refuse the global database path. This fires on the real collision the dogfood
 * host hit: `GENIE_HOME` is `$HOME/.genie`, and a per-repo verb invoked with
 * `cwd` = `$HOME` (outside any git repo) resolves `$HOME/.genie/genie.db` — the
 * global file — and initializes the per-repo schema in it.
 */
function assertNotGlobalDbPath(path: string): void {
  if (path === ':memory:') return;
  if (canonicalDbPath(path) !== canonicalDbPath(resolveGlobalDbPath())) return;
  throw new GlobalDbPathError(path);
}

// ============================================================================
// Open / init
// ============================================================================

export interface OpenOptions {
  /** Explicit DB file path. Overrides `cwd`-based resolution. `:memory:` allowed. */
  path?: string;
  /** Working directory used for git-based path resolution when `path` is absent. */
  cwd?: string;
  /**
   * `false` refuses to migrate a database stamped below
   * {@link CURRENT_SCHEMA_VERSION}, throwing `PendingMigrationError` instead.
   * For callers that only OBSERVE — `genie doctor` — because a forward-only,
   * destructive schema change must never be a side effect of looking at a file.
   */
  migrate?: boolean;
}

/**
 * Copy the database aside before the first migration step runs.
 *
 * The ladder is forward-only and destructive: once `hire_roster` is dropped
 * there is no step back, and a 5.x binary on the same machine refuses the
 * migrated file outright. So the backup is unconditional, not opt-in — an
 * operator who discovers the wrong binary migrated a shared database needs the
 * bytes, not a flag they did not know to pass.
 *
 * The archive is `db.serialize()` — the page image this connection's snapshot
 * sees, WAL frames included — written as a ROLLBACK-JOURNAL file, and not any
 * of the two obvious alternatives, both of which failed on 2026-09-20:
 *
 *   - `wal_checkpoint` + `copyFileSync` copies a WAL-mode file: its header says
 *     WAL and no `-wal`/`-shm` sit beside it, which the system SQLite bun links
 *     on macOS refuses to open read-only (`SQLITE_CANTOPEN`; darwin CI, two
 *     tests). A torn copy under a concurrent checkpoint is also possible.
 *   - `VACUUM INTO` rebuilds the output by stepping `SELECT sql FROM
 *     sqlite_schema` and executing each CREATE into it. When another process
 *     changes the schema meanwhile — exactly what the race winner's `DROP
 *     TABLE` does while the losers are still preparing their backups — that
 *     SELECT restarts on `SQLITE_SCHEMA` and re-emits the rows it already ran,
 *     so the output dies with `table boards already exists` (1–3 of six
 *     openers, most local runs; a separate read-only connection changes
 *     nothing because the window is inside VACUUM).
 *
 * `sqlite3_serialize` copies pages through the pager under one read
 * transaction and parses no schema, so neither failure applies. Header bytes
 * 18 and 19 are the file-format write/read versions (1 = rollback journal,
 * 2 = WAL); setting both to 1 is byte-for-byte what `PRAGMA journal_mode =
 * DELETE` writes, and it is what lets any SQLite open the archive read-only
 * with no sidecar. `user_version` and every page are untouched.
 *
 * The root lives under `<GENIE_HOME>/state-backups/`, which is an ARCHIVE:
 * nothing genie writes there is removed by a later run. Returns the path so
 * the caller can name it on stdout — an unreported backup is a backup the
 * operator cannot use.
 */
const HEADER_WRITE_VERSION_OFFSET = 18;
const HEADER_READ_VERSION_OFFSET = 19;
const FILE_FORMAT_ROLLBACK_JOURNAL = 1;

function prepareMigrationBackup(db: Database, path: string, from: number, to: number): PreparedMigrationBackup {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // Stamp AND pid: every racing opener prepares a backup and only the winner
  // keeps its root, so two openers landing in the same millisecond must not
  // share one — the loser's `discard` deleted the winner's archive (the
  // six-opener test found 0 roots, 2 of 5 local runs). Still sortable, still
  // the `<family>-<compact ISO>` shape every state-backups root uses.
  const root = join(resolveGenieHome(), 'state-backups', `db-migration-${stamp}-${process.pid}`);
  // Explicit 0o700, like every other `state-backups` root. Without a mode the
  // directory inherits the ambient umask, which on CI produced a root this
  // very process could not traverse — the copy landed and re-opening it failed
  // with `unable to open database file`. `genie-home-permissions.test.ts`
  // enforces the rule for every GENIE_HOME creator.
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const target = join(root, basename(path));
  const image = Buffer.from(db.serialize());
  image[HEADER_WRITE_VERSION_OFFSET] = FILE_FORMAT_ROLLBACK_JOURNAL;
  image[HEADER_READ_VERSION_OFFSET] = FILE_FORMAT_ROLLBACK_JOURNAL;
  writeFileSync(target, image, { mode: 0o600 });
  return {
    // This process won the lock: the copy is genuinely the previous database,
    // so keep it and say where it went.
    commit: () => reportDbMigration(`genie.db: schema v${from} -> v${to}; previous database backed up to ${target}`),
    // It lost: the file it copied was migrated by someone else (or already
    // was), so this root archives nothing anyone needs and announcing it would
    // be a receipt for bytes nobody saved. Remove it and stay silent — the
    // winner's root is the one that matters, and `state-backups` never
    // accumulates a root that describes no event.
    discard: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * The ONE line the migration prints, and it goes to STDERR.
 *
 * `genie task export` and `genie board --json` put a single JSON document on
 * stdout; a notice on that stream corrupts exactly the run that migrates — the
 * first one after an upgrade — and the caller's `JSON.parse` fails on
 * `genie.db: schema v1 -> v2; …`. This is operator text, so it belongs on
 * stderr with every other diagnostic genie writes.
 */
function reportDbMigration(line: string): void {
  printErr(line);
}

/**
 * Open (creating if absent) the genie.db for a repo, apply concurrency pragmas,
 * and ensure the schema. Refuses malformed or foreign databases with typed
 * errors. Idempotent: safe to call on every CLI invocation.
 */
export function openDb(opts: OpenOptions = {}): Database {
  assertLocalLifecycleEnabled();
  const path = opts.path ?? resolveDbPath(opts.cwd);
  assertNotGlobalDbPath(path);
  return openSqlite({
    path,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    ensureSchema,
    schemaIsCurrent,
    migrations: SCHEMA_MIGRATIONS,
    ...(opts.migrate === false ? { migrate: false } : {}),
    beforeMigrate: ({ db, path: dbPath, from, to }) => prepareMigrationBackup(db, dbPath, from, to),
  });
}

/**
 * The forward-only ladder every stamped version below {@link
 * CURRENT_SCHEMA_VERSION} climbs. Each step is destructive-change-only: an
 * ADDITIVE change needs no step at all, because `ensureSchema` + the
 * `schemaIsCurrent` shape check already backfill it within one version.
 *
 * 1 -> 2: drop `hire_roster`. It held machine-local worktree paths for the
 * retired `genie ui-bridge` hire surface, was excluded from every snapshot
 * genie ever published (`hire_roster: []`), and had no reader left. Dropping
 * it is what made the 1 -> 2 bump — and therefore this ladder — necessary.
 */
const SCHEMA_MIGRATIONS: ReadonlyArray<{ from: number; to: number; apply: (db: Database) => void }> = [
  {
    from: 1,
    to: 2,
    apply: (db) => {
      db.exec('DROP TABLE IF EXISTS hire_roster');
    },
  },
];

/** Required table/column shape of a fully-initialized per-repo Genie database. */
const EXPECTED_SCHEMA = {
  boards: ['id', 'name', 'created_at', 'lanes'],
  meta: ['key', 'value'],
  stage_log: ['id', 'task_id', 'stage', 'note', 'created_at'],
  task_checklist: ['id', 'task_id', 'position', 'text', 'checked_at', 'checked_by', 'evidence', 'created_at'],
  task_dependencies: ['task_id', 'depends_on_id'],
  task_events: ['id', 'task_id', 'kind', 'note', 'author_kind', 'author', 'payload', 'created_at'],
  tasks: [
    'id',
    'board_id',
    'title',
    'status',
    'claimed_by',
    'claimed_at',
    'wish',
    'group_name',
    'created_at',
    'updated_at',
    'lane',
    'agent_kind',
    'heartbeat_at',
    'blocked_by',
    'blocked_reason',
    'block_kind',
    'assigned_agent',
    'assigned_reason',
  ],
  wish_groups: [
    'wish',
    'name',
    'status',
    'depends_on',
    'assignee',
    'started_at',
    'completed_at',
    'created_at',
    'updated_at',
  ],
} as const;

/**
 * True when the DB is already at the current schema — every expected table plus
 * the additive lane/wish/assignment columns backfilled by
 * {@link ensureTaskColumns} and {@link ensureBoardColumns}. Pure reads (no
 * write lock), so a known-current DB
 * opens without contending on the schema lock. A pre-column v1 DB (missing any
 * of these) returns false → ensureSchema runs and backfills. This MUST stay in
 * lockstep with the ensure* helpers: an added column absent here would let an
 * already-initialized DB short-circuit past the backfill.
 */
function schemaIsCurrent(db: Database): boolean {
  if (!schemaShapeIsCurrent(db)) return false;
  // The one-time stage_log → task_events backfill is part of ensureSchema, so a
  // full-schema DB whose meta guard is missing (a pre-backfill DB, or a legacy
  // snapshot imported onto a marker-stamped DB) is NOT current. Without this
  // check the fast path would skip ensureSchema and the documented migration
  // would silently never run — the lockstep failure the contract above warns
  // about. One pure read; only markerless DBs pay the ensureSchema write lock,
  // once, until the backfill re-stamps the marker.
  if (!db.query('SELECT 1 FROM meta WHERE key = ?').get(STAGE_LOG_BACKFILL_KEY)) return false;
  return true;
}

/** Shape half of {@link schemaIsCurrent}: every expected table and column exists. */
function schemaShapeIsCurrent(db: Database): boolean {
  const tables = new Set(
    (
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name),
  );
  for (const [table, expectedColumns] of Object.entries(EXPECTED_SCHEMA)) {
    if (!tables.has(table)) return false;
    const columns = new Set(
      (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
    );
    for (const column of expectedColumns) {
      if (!columns.has(column)) return false;
    }
  }
  return true;
}

/**
 * Validate a handle without applying migrations or taking a write lock: both
 * the per-repo `user_version` and the complete required schema must match this
 * build. The retired MCP server was its original caller — that comment outlived
 * the subsystem by two releases — and what the property is FOR now is the
 * observe-don't-mutate side of the v1 -> v2 ladder: `ensureSchema` and the
 * migration are write paths, and a caller that only needs to know whether this
 * database is current must not trigger either. `genie doctor` takes the same
 * guarantee through `openDb({ migrate: false })`, which additionally
 * distinguishes a PENDING migration from a foreign or malformed file.
 *
 * Malformed SQLite inputs may throw while being inspected; callers own closing
 * the handle and translating that failure at their boundary.
 */
export function isCurrentGenieDb(db: Database): boolean {
  const row = db.query('PRAGMA user_version').get() as { user_version: number } | null;
  return row?.user_version === CURRENT_SCHEMA_VERSION && schemaIsCurrent(db);
}

/**
 * Weaker read-side validation: this build's version stamp plus the complete
 * schema SHAPE, ignoring pending data-only migration markers (the stage_log
 * backfill guard). Every table and column a read can touch exists, so a
 * read-only consumer that CANNOT run the write-path heal (read-only mount,
 * sandboxed process, CI checkout) may still serve the database rather than
 * fail closed — the only degradation is legacy stage_log history not yet
 * mirrored into the timeline. Write paths must keep using the strict
 * {@link isCurrentGenieDb} / ensureSchema lockstep.
 */
export function isReadableGenieDb(db: Database): boolean {
  const row = db.query('PRAGMA user_version').get() as { user_version: number } | null;
  return row?.user_version === CURRENT_SCHEMA_VERSION && schemaShapeIsCurrent(db);
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
  id               TEXT PRIMARY KEY,
  board_id         TEXT REFERENCES boards(id) ON DELETE SET NULL,
  title            TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('blocked', 'ready', 'in_progress', 'done')),
  claimed_by       TEXT,
  claimed_at       INTEGER,
  wish             TEXT,
  group_name       TEXT,
  assigned_agent   TEXT,
  assigned_reason  TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
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
  payload     TEXT,
  created_at  INTEGER NOT NULL
);

-- Definition-of-done items for a card: an ordered checklist a claimant ticks off
-- with evidence. Additive, so this stays within the current user_version — no
-- destructive migration, no version bump. A row starts unchecked; checked_at
-- NULL means open, non-NULL means done. Reopening clears the tick, its author and
-- its evidence: the row is current state, and the checklist_check event already
-- preserves what was claimed and by whom.
CREATE TABLE IF NOT EXISTS task_checklist (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  text       TEXT NOT NULL,
  checked_at INTEGER,
  checked_by TEXT,
  evidence   TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS task_checklist_task_position
  ON task_checklist (task_id, position);

-- VESTIGIAL, pending drop: the wish-group execution machinery is production-dead
-- (no writer exists). The DDL stays inert for schema compatibility — older
-- binaries' validateSnapshot expects the wish_groups key and exportState emits
-- the empty array. Dropping the table is a live-DB migration OUT of scope.
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
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id);
`;

/** Create every table/index if absent. Idempotent — pure `IF NOT EXISTS`. */
export function ensureSchema(db: Database): void {
  db.exec(SCHEMA_SQL);
  ensureTaskColumns(db);
  ensureBoardColumns(db);
  ensureTaskEventColumns(db);
  backfillStageLog(db);
}

/**
 * Add one nullable column unless it is already there.
 *
 * The presence check and the `ALTER` are two statements, so two processes
 * opening the same older database at the same moment can both read the column
 * as missing and both try to add it — the loser then dies with
 * `duplicate column name`, taking an ordinary `genie task` invocation with it.
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so the error IS the signal that
 * another opener won: it means the column now exists, which is precisely the
 * post-condition this function promises. Every other failure propagates.
 */
function addColumn(
  db: Database,
  table: 'tasks' | 'boards' | 'task_events',
  present: ReadonlySet<string>,
  name: string,
  type: 'TEXT' | 'INTEGER',
): void {
  if (present.has(name)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  } catch (err) {
    if (!/duplicate column name/i.test(err instanceof Error ? err.message : String(err))) throw err;
  }
}

function addTaskColumn(db: Database, present: ReadonlySet<string>, name: string, type: 'TEXT' | 'INTEGER'): void {
  addColumn(db, 'tasks', present, name, type);
}

/**
 * Additive, in-place column backfill for `task_events`. `payload` carries the
 * structured half of a worker report (changed files, checks, artifacts, risk) as
 * JSON; a NULL payload is every event written before it existed, and every event
 * kind that has no structure. Nullable ⇒ no version bump, same rule as
 * {@link addTaskColumn}.
 */
function ensureTaskEventColumns(db: Database): void {
  const cols = new Set(
    (db.query('PRAGMA table_info(task_events)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  addColumn(db, 'task_events', cols, 'payload', 'TEXT');
}

/**
 * Additive, in-place column backfill for `tasks`. `CREATE TABLE IF NOT EXISTS`
 * never alters an existing table, so a DB stamped by an earlier build (which
 * lacked `wish`/`group_name`/`lane`) needs the columns added. All are nullable,
 * so this stays within the current `user_version` — no destructive migration,
 * no version bump. Idempotent, and safe against a concurrent opener running it
 * at the same time (see {@link addTaskColumn}).
 */
function ensureTaskColumns(db: Database): void {
  const cols = new Set((db.query('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((c) => c.name));
  addTaskColumn(db, cols, 'wish', 'TEXT');
  addTaskColumn(db, cols, 'group_name', 'TEXT');
  addTaskColumn(db, cols, 'lane', 'TEXT');
  // Runtime layer: authored identity, heartbeat liveness, and the enforced block
  // (blocked_by drives the single carved checkout exception; block_kind says
  // whether it is a work problem or a deliberate hold, NULL ⇒ 'work'). All
  // nullable ⇒ no user_version bump; the card-projection render reads them,
  // TaskRow stays frozen.
  addTaskColumn(db, cols, 'agent_kind', 'TEXT');
  addTaskColumn(db, cols, 'heartbeat_at', 'INTEGER');
  addTaskColumn(db, cols, 'blocked_by', 'TEXT');
  addTaskColumn(db, cols, 'blocked_reason', 'TEXT');
  addTaskColumn(db, cols, 'block_kind', 'TEXT');
  // Declared routing (cross-agent-delegate W1): which roster agent works the
  // card and why. Nullable ⇒ no user_version bump; both halves travel together
  // (an assignment without its reason is rejected at the state API).
  addTaskColumn(db, cols, 'assigned_agent', 'TEXT');
  addTaskColumn(db, cols, 'assigned_reason', 'TEXT');
}

/** Meta key marking the one-time stage_log → task_events backfill as complete. */
export const STAGE_LOG_BACKFILL_KEY = 'stage_log_backfill_v1';

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
 * DB) never duplicates rows. Runs inside {@link ensureSchema} under the write
 * lock, and again from `importState` after a legacy snapshot lands, so the
 * importing handle sees the mirrored timeline immediately.
 */
export function backfillStageLog(db: Database): void {
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
 * within the current `user_version`. Idempotent, and tolerant of a concurrent
 * opener adding it first (see {@link addColumn}): `SCHEMA_SQL` creates `boards`
 * WITHOUT `lanes`, so on a brand-new database every first opener reaches this
 * `ALTER` — the race is not confined to older files (darwin CI, 2026-09-20).
 */
function ensureBoardColumns(db: Database): void {
  const cols = new Set((db.query('PRAGMA table_info(boards)').all() as Array<{ name: string }>).map((c) => c.name));
  addColumn(db, 'boards', cols, 'lanes', 'TEXT');
}
