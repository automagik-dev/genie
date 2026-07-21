import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BusyDbError,
  CURRENT_SCHEMA_VERSION,
  ForeignDbError,
  GenieDbError,
  MalformedDbError,
  isBusyError,
  openDb,
  resolveDbPath,
  resolveRepoRoot,
} from './genie-db.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genie-db-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function userVersion(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
}

describe('openDb schema init', () => {
  test('creates the file, stamps user_version, and is idempotent', () => {
    const path = join(dir, 'genie.db');

    const db1 = openDb({ path });
    db1.close();
    expect(existsSync(path)).toBe(true);
    expect(userVersion(path)).toBe(CURRENT_SCHEMA_VERSION);

    // Re-open: must not throw, must not change the version, tables intact.
    const db2 = openDb({ path });
    const tables = db2
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    db2.close();

    expect(userVersion(path)).toBe(CURRENT_SCHEMA_VERSION);
    expect(tables).toEqual(['boards', 'meta', 'stage_log', 'task_dependencies', 'task_events', 'tasks', 'wish_groups']);
  });

  test('creates the .genie parent directory when absent', () => {
    const path = join(dir, 'nested', '.genie', 'genie.db');
    const db = openDb({ path });
    db.close();
    expect(existsSync(path)).toBe(true);
  });

  test('WAL journal mode is enabled', () => {
    const path = join(dir, 'genie.db');
    const db = openDb({ path });
    const mode = (db.query('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
    db.close();
    expect(mode.toLowerCase()).toBe('wal');
  });
});

describe('openDb refusal', () => {
  test('refuses a malformed (non-sqlite) file with MalformedDbError', () => {
    const path = join(dir, 'garbage.db');
    writeFileSync(path, 'this is definitely not a sqlite database\n'.repeat(64));
    expect(() => openDb({ path })).toThrow(MalformedDbError);
  });

  test('refuses a foreign versioned database with ForeignDbError', () => {
    const path = join(dir, 'foreign.db');
    const seed = new Database(path);
    seed.exec('PRAGMA user_version = 7');
    seed.exec('CREATE TABLE widgets (id INTEGER PRIMARY KEY)');
    seed.close();
    expect(() => openDb({ path })).toThrow(ForeignDbError);
  });

  test('refuses an unversioned database that already holds foreign tables', () => {
    const path = join(dir, 'foreign-unversioned.db');
    const seed = new Database(path);
    // user_version stays 0 but the file already carries a foreign table.
    seed.exec('CREATE TABLE legacy_stuff (id INTEGER PRIMARY KEY)');
    seed.close();
    expect(() => openDb({ path })).toThrow(ForeignDbError);
  });

  test('adopts an empty (0-byte) file as a fresh database', () => {
    const path = join(dir, 'empty.db');
    writeFileSync(path, '');
    const db = openDb({ path });
    db.close();
    expect(userVersion(path)).toBe(CURRENT_SCHEMA_VERSION);
  });
});

// ---------------------------------------------------------------------------
// Additive backfill on a pre-lanes DB: a DB stamped at user_version=1 by an
// EARLIER build (no task_events table, no tasks.lane, no boards.lanes) must open
// WITHOUT a version bump, backfill the additive columns/table via ensureSchema,
// and preserve every existing row. This is the worktree-shared-DB rollout
// guarantee — an older binary's DB opens clean under the new code.
// ---------------------------------------------------------------------------
describe('pre-lanes DB backfill (additive, no version bump)', () => {
  /** The exact `boards/tasks/...` schema that shipped BEFORE lifecycle lanes. */
  function seedOldSchemaDb(path: string): void {
    const seed = new Database(path);
    seed.exec('PRAGMA user_version = 1');
    seed.exec(`
      CREATE TABLE boards (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        board_id TEXT REFERENCES boards(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('blocked','ready','in_progress','done')),
        claimed_by TEXT, claimed_at INTEGER, wish TEXT, group_name TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE task_dependencies (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        PRIMARY KEY (task_id, depends_on_id)
      );
      CREATE TABLE stage_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        stage TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE wish_groups (
        wish TEXT NOT NULL, name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('blocked','ready','in_progress','done')),
        depends_on TEXT NOT NULL DEFAULT '[]', assignee TEXT,
        started_at INTEGER, completed_at INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (wish, name)
      );
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    // A board + task written by the old binary — must survive the backfill.
    seed.query('INSERT INTO boards (id, name, created_at) VALUES (?, ?, ?)').run('b_old', 'legacy', 1);
    seed
      .query('INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('t_old', 'seeded before lanes', 'ready', 1, 1);
    seed.close();
  }

  test('opens without a version bump, backfills columns/table, preserves rows', () => {
    const path = join(dir, 'pre-lanes.db');
    seedOldSchemaDb(path);

    // Must NOT be refused as foreign — it is a genuine user_version=1 genie DB.
    const db = openDb({ path });

    // No version bump — still 1.
    expect((db.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
      CURRENT_SCHEMA_VERSION,
    );

    // The additive schema was backfilled.
    const tables = new Set(
      (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    );
    expect(tables.has('task_events')).toBe(true);
    const taskCols = new Set(
      (db.query('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((c) => c.name),
    );
    expect(taskCols.has('lane')).toBe(true);
    const boardCols = new Set(
      (db.query('PRAGMA table_info(boards)').all() as Array<{ name: string }>).map((c) => c.name),
    );
    expect(boardCols.has('lanes')).toBe(true);

    // The pre-existing rows survived; the new columns read back as NULL.
    const task = db.query('SELECT id, title, lane FROM tasks WHERE id = ?').get('t_old') as {
      id: string;
      title: string;
      lane: string | null;
    };
    expect(task.title).toBe('seeded before lanes');
    expect(task.lane).toBeNull();
    const board = db.query('SELECT name, lanes FROM boards WHERE id = ?').get('b_old') as {
      name: string;
      lanes: string | null;
    };
    expect(board.name).toBe('legacy');
    expect(board.lanes).toBeNull();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Busy classification: a contended write lock is transient, not corruption. The
// production bug was openDb wrapping SQLITE_BUSY into MalformedDbError under
// multi-process contention. These lock the classifier and the typed error so a
// "database is locked" failure can never masquerade as a malformed DB again.
// ---------------------------------------------------------------------------
describe('busy classification', () => {
  test('isBusyError matches SQLite busy codes and locked-message text', () => {
    // bun:sqlite surfaces a `code` field on contended locks.
    expect(isBusyError(Object.assign(new Error('boom'), { code: 'SQLITE_BUSY' }))).toBe(true);
    expect(isBusyError(Object.assign(new Error('boom'), { code: 'SQLITE_BUSY_SNAPSHOT' }))).toBe(true);
    expect(isBusyError(Object.assign(new Error('boom'), { code: 'SQLITE_LOCKED' }))).toBe(true);
    // The raw text SQLite emits when busy_timeout is exhausted.
    expect(isBusyError(new Error('database is locked'))).toBe(true);
    expect(isBusyError(new Error('SQLITE_BUSY: database is locked'))).toBe(true);
    expect(isBusyError(new Error('database table is locked'))).toBe(true);
  });

  test('isBusyError rejects unrelated and non-error inputs', () => {
    expect(isBusyError(new Error('file is not a database'))).toBe(false);
    expect(isBusyError(Object.assign(new Error('x'), { code: 'SQLITE_CORRUPT' }))).toBe(false);
    expect(isBusyError('database is locked')).toBe(false);
    expect(isBusyError(null)).toBe(false);
    expect(isBusyError(undefined)).toBe(false);
  });

  test('BusyDbError is a GenieDbError distinct from MalformedDbError', () => {
    const busy = new BusyDbError('/tmp/genie.db', new Error('database is locked'));
    expect(busy).toBeInstanceOf(GenieDbError);
    expect(busy).not.toBeInstanceOf(MalformedDbError);
    expect(busy.name).toBe('BusyDbError');
    expect(busy.path).toBe('/tmp/genie.db');
    // Message must read as retryable contention, not corruption, and name the path.
    expect(busy.message).toContain('/tmp/genie.db');
    expect(busy.message.toLowerCase()).toContain('retry');
    expect(busy.message.toLowerCase()).not.toContain('malformed');
  });

  test('a real EXCLUSIVE-locked DB opens as BusyDbError, never MalformedDbError', () => {
    const path = join(dir, 'contended.db');
    // Seed a healthy, current genie DB, then hold an EXCLUSIVE write lock on it.
    openDb({ path }).close();
    const holder = new Database(path);
    holder.exec('PRAGMA busy_timeout = 0');
    holder.exec('BEGIN EXCLUSIVE');
    try {
      // ensureSchema is skipped (schema is current), but the WAL-mode probe still
      // contends the write lock — the open must surface a typed, retryable busy,
      // NOT a corruption claim.
      let thrown: unknown;
      try {
        openDb({ path }).close();
      } catch (e) {
        thrown = e;
      }
      // Depending on lock timing the open may win outright; if it throws it MUST
      // be a BusyDbError and never a MalformedDbError.
      if (thrown !== undefined) {
        expect(thrown).toBeInstanceOf(BusyDbError);
        expect(thrown).not.toBeInstanceOf(MalformedDbError);
      }
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Real two-worktree visibility: a task created via worktree A is visible from
// worktree B with no daemon — both resolve to the same shared genie.db.
// ---------------------------------------------------------------------------
describe('worktree-shared genie.db (real git)', () => {
  let repoDir: string;
  let worktreeDir: string;

  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    }).trim();
  }

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'genie-wt-main-'));
    git(repoDir, 'init', '-b', 'main');
    writeFileSync(join(repoDir, 'README.md'), '# repo\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'init');
    worktreeDir = join(repoDir, 'wt-a');
    git(repoDir, 'worktree', 'add', worktreeDir, '-b', 'feat-a');
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  test('both worktrees resolve to the same DB path', () => {
    const fromMain = resolveDbPath(repoDir);
    const fromWorktree = resolveDbPath(worktreeDir);
    expect(fromWorktree).toBe(fromMain);
    // The shared DB lives under the MAIN repo's .genie, not the worktree's.
    expect(resolveRepoRoot(worktreeDir)).toBe(resolveRepoRoot(repoDir));
  });

  test('a row written from worktree A is visible from worktree B (main)', () => {
    const dbA = openDb({ cwd: worktreeDir });
    dbA.query('INSERT INTO boards (id, name, created_at) VALUES (?, ?, ?)').run('b_wt', 'from-worktree-a', Date.now());
    dbA.close();

    // Open from the main repo cwd — same underlying file, no sync step.
    const dbB = openDb({ cwd: repoDir });
    const row = dbB.query('SELECT name FROM boards WHERE id = ?').get('b_wt') as { name: string } | null;
    dbB.close();

    expect(row?.name).toBe('from-worktree-a');
  });
});

describe('resolveDbPath fallback', () => {
  test('falls back to cwd when not in a git repo', () => {
    const nonRepo = mkdtempSync(join(tmpdir(), 'genie-nonrepo-'));
    try {
      mkdirSync(join(nonRepo, 'sub'), { recursive: true });
      // No .git anywhere up the tree we control; resolveRepoRoot returns the dir.
      const resolved = resolveDbPath(nonRepo);
      expect(resolved.endsWith(join('.genie', 'genie.db'))).toBe(true);
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});
