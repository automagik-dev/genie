import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BusyDbError,
  CURRENT_SCHEMA_VERSION,
  ForeignDbError,
  GenieDbError,
  MalformedDbError,
  STAGE_LOG_BACKFILL_KEY,
  isBusyError,
  isCurrentGenieDb,
  isReadableGenieDb,
  openDb,
  resolveDbPath,
  resolveRepoRoot,
} from './genie-db.js';
import { hasStaleReadonlyWalIndex } from './sqlite-open.js';

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
    expect(tables).toEqual([
      'boards',
      'hire_roster',
      'meta',
      'stage_log',
      'task_dependencies',
      'task_events',
      'tasks',
      'wish_groups',
    ]);
  });

  test('a fresh DB carries hire_roster', () => {
    const path = join(dir, 'genie.db');
    const db = openDb({ path });
    const has = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='hire_roster'").get();
    db.close();
    expect(has).not.toBeNull();
  });

  test('adds hire_roster to a pre-existing current DB via the schemaIsCurrent path', () => {
    const path = join(dir, 'genie.db');
    // Simulate a DB stamped by an earlier build: already at user_version=1 but
    // missing the additive hire_roster table. schemaIsCurrent must return false
    // (hire_roster ∈ EXPECTED_TABLES) so ensureSchema re-runs and creates it —
    // no user_version bump.
    const db1 = openDb({ path });
    db1.exec('DROP TABLE hire_roster');
    db1.close();
    expect(userVersion(path)).toBe(CURRENT_SCHEMA_VERSION);

    const db2 = openDb({ path });
    const has = db2.query("SELECT name FROM sqlite_master WHERE type='table' AND name='hire_roster'").get();
    db2.close();
    expect(has).not.toBeNull();
    // Additive migration — the schema version is unchanged.
    expect(userVersion(path)).toBe(CURRENT_SCHEMA_VERSION);
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

  test('a full-schema DB missing the backfill marker is not current — re-open runs the migration', () => {
    const path = join(dir, 'genie.db');
    const db1 = openDb({ path });
    db1
      .query("INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES ('t1', 'legacy', 'ready', 1, 1)")
      .run();
    db1.query("INSERT INTO stage_log (task_id, stage, note, created_at) VALUES ('t1', 'planned', 'kickoff', 1)").run();
    // Simulate a pre-backfill DB: full current schema + real stage_log history
    // + absent guard. The existing backfill test deletes the marker and calls
    // ensureSchema directly; this goes through the PRODUCTION open path, which
    // schemaIsCurrent must not short-circuit (lockstep contract).
    db1.query('DELETE FROM meta WHERE key = ?').run(STAGE_LOG_BACKFILL_KEY);
    db1.close();

    const db2 = openDb({ path });
    const mirrored = db2.query('SELECT COUNT(*) AS n FROM task_events').get() as { n: number };
    db2.close();
    expect(mirrored.n).toBe(1);
  });

  test('isReadableGenieDb accepts a marker-only-stale DB and refuses a shape-stale one', () => {
    const path = join(dir, 'genie.db');
    const db = openDb({ path });
    // Current shape, pending data-only migration marker: NOT strictly current
    // (write paths must still run ensureSchema) but perfectly readable — the
    // readonly MCP degrade path serves exactly this shape when the heal write
    // is impossible.
    db.query('DELETE FROM meta WHERE key = ?').run(STAGE_LOG_BACKFILL_KEY);
    expect(isCurrentGenieDb(db)).toBe(false);
    expect(isReadableGenieDb(db)).toBe(true);
    // Shape staleness (a column this build queries is missing) refuses reads too.
    db.exec('ALTER TABLE tasks DROP COLUMN agent_kind');
    expect(isReadableGenieDb(db)).toBe(false);
    db.close();
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
// Pre-assignment backfill (cross-agent-delegate W1): a DB initialized by a
// build that predates tasks.assigned_agent/assigned_reason must be detected as
// NOT current (EXPECTED_SCHEMA lockstep) so ensureSchema re-runs and backfills
// additively — no user_version bump, no data loss. The documented trap is
// omitting the columns from EXPECTED_SCHEMA: schemaIsCurrent would then return
// true for the pre-upgrade shape and the backfill would be silently skipped.
// ---------------------------------------------------------------------------
describe('pre-assignment DB backfill (additive, no version bump)', () => {
  test('a full-schema DB missing only the assignment columns is not current and heals on open', () => {
    const path = join(dir, 'pre-assignment.db');
    const db1 = openDb({ path });
    // A card with real assignment data, plus an unassigned one — both must
    // survive the drop/re-add cycle intact.
    db1
      .query(
        "INSERT INTO tasks (id, title, status, created_at, updated_at, assigned_agent, assigned_reason) VALUES ('t_a', 'routed', 'ready', 1, 1, 'codex', 'dissent on parser')",
      )
      .run();
    db1
      .query("INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES ('t_b', 'plain', 'ready', 1, 1)")
      .run();
    // Simulate a DB stamped by the previous build: drop ONLY the two new
    // columns; everything else stays at the current shape.
    db1.exec('ALTER TABLE tasks DROP COLUMN assigned_agent');
    db1.exec('ALTER TABLE tasks DROP COLUMN assigned_reason');
    // The lockstep contract: the pre-upgrade shape must NOT read as current —
    // otherwise openDb's fast path would skip ensureSchema and the backfill
    // would silently never run on already-initialized DBs.
    expect(isCurrentGenieDb(db1)).toBe(false);
    expect(isReadableGenieDb(db1)).toBe(false);
    db1.close();

    const db2 = openDb({ path });
    // Additive migration — user_version unchanged.
    expect((db2.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
      CURRENT_SCHEMA_VERSION,
    );
    // Both columns backfilled; every pre-existing row (and its assignment)
    // survived.
    const cols = new Set((db2.query('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((c) => c.name));
    expect(cols.has('assigned_agent')).toBe(true);
    expect(cols.has('assigned_reason')).toBe(true);
    // The pre-existing row survived the heal; the re-added columns read as NULL
    // (a real pre-assignment DB never carried assignment data — SQLite DROP
    // COLUMN discards values, so the fresh column starts null exactly as it
    // would on a database that predates the feature).
    const routed = db2.query('SELECT title, assigned_agent, assigned_reason FROM tasks WHERE id = ?').get('t_a') as {
      title: string;
      assigned_agent: string | null;
      assigned_reason: string | null;
    };
    expect(routed).toEqual({ title: 'routed', assigned_agent: null, assigned_reason: null });
    const plain = db2.query('SELECT assigned_agent, assigned_reason FROM tasks WHERE id = ?').get('t_b') as {
      assigned_agent: string | null;
      assigned_reason: string | null;
    };
    expect(plain).toEqual({ assigned_agent: null, assigned_reason: null });
    // The healed DB is now current, and a re-open is a pure no-op.
    expect(isCurrentGenieDb(db2)).toBe(true);
    db2.close();
    expect(isCurrentGenieDb(openDb({ path }))).toBe(true);
  });

  test('a fresh DB carries the assignment columns from CREATE TABLE', () => {
    const path = join(dir, 'fresh.db');
    const db = openDb({ path });
    const cols = new Set((db.query('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((c) => c.name));
    db.close();
    expect(cols.has('assigned_agent')).toBe(true);
    expect(cols.has('assigned_reason')).toBe(true);
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

  test('SQLITE_PROTOCOL is transient contention, never corruption', () => {
    // "locking protocol" is what SQLite raises when a writer loses the WAL-index
    // lock race repeatedly under heavy multi-process contention. The database is
    // HEALTHY; classifying it down the corruption path made a contended open
    // claim "Refusing malformed database".
    expect(isBusyError(Object.assign(new Error('locking protocol'), { code: 'SQLITE_PROTOCOL', errno: 15 }))).toBe(
      true,
    );
    expect(isBusyError(Object.assign(new Error('locking protocol'), { errno: 15 }))).toBe(true);
    expect(isBusyError(new Error('SQLITE_PROTOCOL: locking protocol'))).toBe(true);
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
// Poisoned WAL index vs. the SHARED open path. A database that was briefly
// write-protected keeps a read-only wal-index header in `-shm`, and every write
// through the next handle fails. Recovering it is NOT `openDb`'s job: the
// poison header is byte-identical to the virgin header of a healthy fresh
// index, so probing for it fleet-wide fires on healthy contended databases and
// the journal-mode churn that follows crashed bun's Linux shm handling under a
// live multi-process fleet. `openDb` therefore stays exactly what it was before
// the heal: open, pragma, ensure schema. The heal stays scoped to a component
// that CREATES the poison — a degraded read-only session, a shape the retired
// MCP/ui-bridge servers were the last to have; see sqlite-open.test.ts for the
// recovery helper's own contract.
//
// This test fails the moment the heal is re-wired into the shared primitive.
// ---------------------------------------------------------------------------
describe('poisoned WAL index through openDb (the shared path never heals)', () => {
  test('openDb serves the poisoned database untouched: no probe, no rebuild, no journal-mode churn', () => {
    const path = join(dir, 'genie.db');
    const seed = openDb({ path });
    seed.exec("INSERT INTO meta (key, value) VALUES ('probe', '1')");
    seed.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    seed.close();

    // Produce the REAL poison: a readonly connection closing while the file is
    // write-protected writes SQLite's zeroed read-only wal-index header.
    chmodSync(path, 0o444);
    chmodSync(dir, 0o555);
    try {
      // Platforms differ: where SQLite refuses a readonly open of a
      // write-protected WAL database outright (SQLITE_READONLY_CANTINIT on
      // Linux), no poison is produced and the line below skips the scenario.
      try {
        const degraded = new Database(path, { readonly: true });
        try {
          degraded.query('SELECT count(*) AS n FROM meta').get();
        } finally {
          degraded.close();
        }
      } catch {
        // this platform cannot express the degraded readonly session
      }
    } finally {
      chmodSync(dir, 0o755);
      chmodSync(path, 0o644);
    }
    if (!hasStaleReadonlyWalIndex(path)) return; // platform never produces the poison

    // The open itself succeeds (the poison lives on the handle, not the file),
    // and the write fails raw — the pre-heal behavior, restored deliberately.
    const db = openDb({ path });
    try {
      expect(() => db.exec("INSERT INTO meta (key, value) VALUES ('after-poison', '1')")).toThrow();
      // ...and the shared path left the database in WAL: no DELETE conversion
      // was attempted on it. That churn under a live fleet is the whole reason
      // the heal does not belong here.
      expect(
        String((db.query('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toLowerCase(),
      ).toBe('wal');
    } finally {
      db.close();
    }
    expect(hasStaleReadonlyWalIndex(path)).toBe(true); // the sidecars were never rebuilt
  });
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
