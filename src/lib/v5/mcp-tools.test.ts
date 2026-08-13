/**
 * mcp-tools — the fail-closed project-context resolver (Group A) and the
 * read-only tool projections it guards.
 *
 * The resolver is re-exported from mcp-tools.ts on purpose: `genie mcp` pulls it
 * through the SAME lazy dynamic import that loads the tool registry, so the read
 * server can refuse to serialize an outer/cache-root empty board without dragging
 * the readonly bun:sqlite open into the eager genie.ts import graph.
 *
 * Every fixture is a real git repo in a tmpdir (per repo convention) so the four
 * production values — effectiveLaunchCwd, worktreeConfigRoot, absolute
 * gitCommonDir, and genieStorageRoot = dirname(gitCommonDir) — are exercised
 * against actual `git rev-parse` behavior, not mocks.
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  copyFileSync,
  existsSync,
  constants as fsConstants,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { BusyDbError, STAGE_LOG_BACKFILL_KEY, isCurrentGenieDb, openDb } from './genie-db.js';
import { type ToolErrorResult, isToolError, unwrapToolError } from './mcp-server.js';
import {
  MCP_TOOLS,
  MCP_WRITE_TOOLS,
  type TaskSummary,
  type ToolContext,
  isDegradedReadonlyDb,
  openReadonlyDb,
  openReadonlyDbHealingStaleSchema,
  openWriteableDb,
  readonlyDatabaseHandleMatchesPath,
  resolveProjectContext,
} from './mcp-tools.js';
import { hasStaleReadonlyWalIndex } from './sqlite-open.js';
import {
  blockTask,
  createBoard,
  createTask,
  getDependencies,
  getTask,
  getTaskEvents,
  getTaskLane,
} from './task-state.js';

let base: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

/** Real git repo with one commit at `dir` (created if absent). */
function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-b', 'main');
  git(dir, 'commit', '--allow-empty', '-m', 'init');
  return dir;
}

/** Create a real, seeded genie.db under `<storageRoot>/.genie/genie.db`. */
function seedDb(storageRoot: string): void {
  const db = openDb({ cwd: storageRoot });
  const board = createBoard(db, 'repo');
  createTask(db, { title: 'seed', boardId: board.id, wish: 'w', group: 'g' });
  // Fold pending WAL frames into the main db and close before any reader opens,
  // so readonly consumers aren't racing an open WAL writer under cross-file
  // test contention (would otherwise surface as "database is locked").
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

/**
 * Canonicalize by realpath-ing the nearest EXISTING ancestor and re-appending
 * the (possibly absent) tail — so macOS /private symlinks never cause false
 * diffs, and an intentionally-absent db path still compares cleanly.
 */
function canon(p: string): string {
  let existing = p;
  const tail: string[] = [];
  while (!existsSync(existing) && dirname(existing) !== existing) {
    tail.unshift(basename(existing));
    existing = dirname(existing);
  }
  return tail.length > 0 ? join(realpathSync(existing), ...tail) : realpathSync(existing);
}

function samePath(actual: string | undefined, expected: string): void {
  expect(actual).toBeDefined();
  expect(canon(actual as string)).toBe(canon(expected));
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'genie-ctx-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

// ============================================================================
// resolveProjectContext — the four-value model + typed fail-closed states
// ============================================================================

describe('resolveProjectContext: supported layouts', () => {
  test('repository root with a genie.db resolves all four values and never changes launch cwd', () => {
    const repo = initRepo(join(base, 'repo'));
    seedDb(repo);
    const ctx = resolveProjectContext(repo);
    expect(ctx.kind).toBe('ok');
    if (ctx.kind !== 'ok') throw new Error('expected ok');
    samePath(ctx.effectiveLaunchCwd, repo); // launch cwd is the input, unchanged
    samePath(ctx.worktreeConfigRoot, repo);
    samePath(ctx.gitCommonDir, join(repo, '.git'));
    samePath(ctx.genieStorageRoot, repo);
    samePath(ctx.dbPath, join(repo, '.genie', 'genie.db'));
    // genieStorageRoot is exactly dirname(gitCommonDir).
    samePath(dirname(ctx.gitCommonDir), ctx.genieStorageRoot);
  });

  test('an ordinary nested subdirectory resolves to the same storage root, not the subdir', () => {
    const repo = initRepo(join(base, 'repo'));
    seedDb(repo);
    const deep = join(repo, 'src', 'deep');
    mkdirSync(deep, { recursive: true });
    const ctx = resolveProjectContext(deep);
    expect(ctx.kind).toBe('ok');
    if (ctx.kind !== 'ok') throw new Error('expected ok');
    samePath(ctx.effectiveLaunchCwd, deep); // cwd stays the subdir
    samePath(ctx.genieStorageRoot, repo); // but storage is the repo root
    samePath(ctx.dbPath, join(repo, '.genie', 'genie.db'));
  });

  test('an initialized nested repository uses its OWN storage root, never the outer db', () => {
    const outer = initRepo(join(base, 'outer'));
    seedDb(outer);
    const nested = initRepo(join(outer, 'vendor', 'nested'));
    seedDb(nested);
    const ctx = resolveProjectContext(nested);
    expect(ctx.kind).toBe('ok');
    if (ctx.kind !== 'ok') throw new Error('expected ok');
    samePath(ctx.genieStorageRoot, nested);
    samePath(ctx.dbPath, join(nested, '.genie', 'genie.db'));
    expect(canon(ctx.dbPath)).not.toBe(canon(join(outer, '.genie', 'genie.db')));
  });

  test('a linked worktree keeps config under the linked root but the db under the main common root', () => {
    const main = initRepo(join(base, 'main'));
    seedDb(main); // db lives ONLY at the main common root
    const linked = join(base, 'linked');
    git(main, 'worktree', 'add', '-b', 'wt', linked);
    const ctx = resolveProjectContext(linked);
    expect(ctx.kind).toBe('ok');
    if (ctx.kind !== 'ok') throw new Error('expected ok');
    samePath(ctx.worktreeConfigRoot, linked); // config stays in the linked worktree
    samePath(ctx.gitCommonDir, join(main, '.git')); // common dir is the MAIN repo's .git
    samePath(ctx.genieStorageRoot, main); // dirname(gitCommonDir) == main
    samePath(ctx.dbPath, join(main, '.genie', 'genie.db')); // sentinel read from the main db
    // Neither the main-worktree cwd nor a cache is substituted as launch context.
    samePath(ctx.effectiveLaunchCwd, linked);
  });
});

describe('resolveProjectContext: fail-closed states', () => {
  test('a non-git directory is project-context-unavailable (never falls outward)', () => {
    const plain = join(base, 'plain');
    mkdirSync(plain, { recursive: true });
    const ctx = resolveProjectContext(plain);
    expect(ctx.kind).toBe('project-context-unavailable');
    samePath(ctx.effectiveLaunchCwd, plain);
  });

  test('a git repo with no genie.db is project-database-unavailable and names the exact candidate', () => {
    const repo = initRepo(join(base, 'repo'));
    const ctx = resolveProjectContext(repo);
    expect(ctx.kind).toBe('project-database-unavailable');
    if (ctx.kind === 'ok') throw new Error('expected error');
    samePath(ctx.genieStorageRoot as string, repo);
    samePath(ctx.dbPath as string, join(repo, '.genie', 'genie.db'));
    expect(ctx.detail).toContain('.genie/genie.db');
  });

  test('a .genie symlink to another repository with a valid database is rejected', () => {
    const repo = initRepo(join(base, 'repo'));
    const other = initRepo(join(base, 'other'));
    seedDb(other);
    symlinkSync(join(other, '.genie'), join(repo, '.genie'), 'dir');

    const ctx = resolveProjectContext(repo);
    expect(ctx.kind).toBe('project-database-unavailable');
    if (ctx.kind === 'ok') throw new Error('expected error');
    expect(ctx.detail).toContain('physical directory');
    expect(openReadonlyDb(repo)).toBeNull();
  });

  test('a genie.db symlink to another repository valid database is rejected', () => {
    const repo = initRepo(join(base, 'repo'));
    const other = initRepo(join(base, 'other'));
    seedDb(other);
    mkdirSync(join(repo, '.genie'));
    symlinkSync(join(other, '.genie', 'genie.db'), join(repo, '.genie', 'genie.db'), 'file');

    const ctx = resolveProjectContext(repo);
    expect(ctx.kind).toBe('project-database-unavailable');
    if (ctx.kind === 'ok') throw new Error('expected error');
    expect(ctx.detail).toContain('physical regular file');
    expect(openReadonlyDb(repo)).toBeNull();
  });

  test('a hardlinked genie.db physical alias is rejected', () => {
    const repo = initRepo(join(base, 'repo'));
    const other = initRepo(join(base, 'other'));
    seedDb(other);
    mkdirSync(join(repo, '.genie'));
    linkSync(join(other, '.genie', 'genie.db'), join(repo, '.genie', 'genie.db'));

    const ctx = resolveProjectContext(repo);
    expect(ctx.kind).toBe('project-database-unavailable');
    if (ctx.kind === 'ok') throw new Error('expected error');
    expect(ctx.detail).toContain('hardlink');
    expect(openReadonlyDb(repo)).toBeNull();
  });

  test('an exact validated binding refuses a later genie.db substitution with another valid database', () => {
    const repo = initRepo(join(base, 'repo'));
    const other = initRepo(join(base, 'other'));
    seedDb(repo);
    seedDb(other);
    const ctx = resolveProjectContext(repo);
    if (ctx.kind !== 'ok' || ctx.databaseBinding === undefined) throw new Error('expected bound database');

    rmSync(ctx.dbPath);
    symlinkSync(join(other, '.genie', 'genie.db'), ctx.dbPath, 'file');

    expect(openReadonlyDb(ctx.databaseBinding)).toBeNull();
  });

  test('an uninitialized nested repository fails at its own boundary, never reading the outer db', () => {
    const outer = initRepo(join(base, 'outer'));
    seedDb(outer); // outer HAS a db — the nested boundary must not fall through to it
    const nested = initRepo(join(outer, 'nested')); // no db here
    const ctx = resolveProjectContext(nested);
    expect(ctx.kind).toBe('project-database-unavailable');
    if (ctx.kind === 'ok') throw new Error('expected error');
    samePath(ctx.dbPath as string, join(nested, '.genie', 'genie.db'));
    expect(canon(ctx.dbPath as string)).not.toBe(canon(join(outer, '.genie', 'genie.db')));
  });

  test('a bare repository is unsupported-project-layout before any db lookup', () => {
    const bare = join(base, 'bare.git');
    git(base, 'init', '--bare', bare);
    const ctx = resolveProjectContext(bare);
    expect(ctx.kind).toBe('unsupported-project-layout');
    expect(ctx.dbPath).toBeUndefined();
  });

  test('a submodule working tree is unsupported-project-layout', () => {
    const sub = initRepo(join(base, 'subrepo'));
    const superRepo = initRepo(join(base, 'super'));
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', sub, 'mysub'], {
      cwd: superRepo,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@e.com',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@e.com',
      },
    });
    seedDb(superRepo); // even with an outer db present, the submodule must not use it
    const ctx = resolveProjectContext(join(superRepo, 'mysub'));
    expect(ctx.kind).toBe('unsupported-project-layout');
    expect(ctx.dbPath).toBeUndefined();
  });

  test('an external/separate-git-dir layout is unsupported-project-layout', () => {
    const work = join(base, 'work');
    const external = join(base, 'external-gitdir');
    mkdirSync(work, { recursive: true });
    git(base, 'init', `--separate-git-dir=${external}`, work);
    const ctx = resolveProjectContext(work);
    expect(ctx.kind).toBe('unsupported-project-layout');
    expect(ctx.dbPath).toBeUndefined();
  });
});

// ============================================================================
// Opened-handle identity — SQLite VFS binding closes the swap/restore window
// ============================================================================

describe('openReadonlyDb: exact opened handle', () => {
  test('HAS_MOVED accepts only a zero SQLite result with a zero moved flag', () => {
    const handle = (result: number, moved: number, throws = false): Pick<Database, 'fileControl'> => ({
      fileControl: ((_op: number, arg?: ArrayBufferView | number) => {
        if (throws) throw new Error('fixture unsupported VFS');
        if (arg instanceof Int32Array) arg[0] = moved;
        return result;
      }) as Database['fileControl'],
    });

    expect(readonlyDatabaseHandleMatchesPath(handle(0, 0))).toBe(true);
    expect(readonlyDatabaseHandleMatchesPath(handle(0, 1))).toBe(false);
    expect(readonlyDatabaseHandleMatchesPath(handle(12, 0))).toBe(false);
    expect(readonlyDatabaseHandleMatchesPath(handle(0, 0, true))).toBe(false);
  });

  test('an injected moved-handle refusal closes the opened database', () => {
    const repo = initRepo(join(base, 'repo'));
    seedDb(repo);
    const ctx = resolveProjectContext(repo);
    if (ctx.kind !== 'ok' || ctx.databaseBinding === undefined) throw new Error('expected bound database');
    let closed = false;
    const fakeDb = {
      close: () => {
        closed = true;
      },
    } as Database;

    const opened = openReadonlyDb(ctx.databaseBinding, {
      openDatabase: () => fakeDb,
      verifyOpenedHandle: () => false,
    });

    expect(opened).toBeNull();
    expect(closed).toBe(true);
  });

  test.skipIf(process.platform === 'win32')(
    'a real A→B constructor swap then B→A restore is rejected by the opened VFS handle',
    () => {
      const repo = initRepo(join(base, 'repo'));
      const other = initRepo(join(base, 'other'));
      seedDb(repo);
      seedDb(other);
      const ctx = resolveProjectContext(repo);
      if (ctx.kind !== 'ok' || ctx.databaseBinding === undefined) throw new Error('expected bound database');
      const otherDbPath = join(other, '.genie', 'genie.db');
      const parkedOriginal = join(base, 'parked-original.db');

      const raced = openReadonlyDb(ctx.databaseBinding, {
        openDatabase: (path) => {
          renameSync(path, parkedOriginal);
          renameSync(otherDbPath, path);
          let opened: Database;
          try {
            opened = new Database(path, { readonly: true });
          } finally {
            renameSync(path, otherDbPath);
            renameSync(parkedOriginal, path);
          }
          return opened;
        },
      });

      expect(raced).toBeNull();
      const restored = openReadonlyDb(ctx.databaseBinding);
      expect(restored).not.toBeNull();
      restored?.close();
    },
  );
});

// ============================================================================
// The read tools serve real state when the context is ok
// ============================================================================

describe('tools serve real state under an ok context', () => {
  test('genie_board reflects the seeded db opened from the resolved storage root', () => {
    const repo = initRepo(join(base, 'repo'));
    seedDb(repo);
    const ctx = resolveProjectContext(repo);
    if (ctx.kind !== 'ok') throw new Error('expected ok');
    const db = openReadonlyDb(ctx.effectiveLaunchCwd);
    expect(db).not.toBeNull();
    const board = MCP_TOOLS.find((t) => t.name === 'genie_board');
    const payload = board?.handler({ db, cwd: ctx.effectiveLaunchCwd, context: ctx }, {}) as {
      counts: { total: number };
    };
    expect(payload.counts.total).toBe(1);
    db?.close();
  });
});

// ============================================================================
// openReadonlyDbHealingStaleSchema — additive-lag self-heal (the N→T dogfood
// regression: a DB stamped by an older build fails isCurrentGenieDb on the
// readonly path until a write-path open backfills the additive columns, and a
// pure-MCP consumer never performs one)
// ============================================================================

describe('openReadonlyDbHealingStaleSchema', () => {
  /** Rewind a current DB to an older build's shape: same user_version, missing additive columns. */
  function makeAdditiveLagDb(repo: string): string {
    seedDb(repo);
    const path = join(repo, '.genie', 'genie.db');
    const db = new Database(path);
    for (const column of ['agent_kind', 'heartbeat_at', 'blocked_by', 'blocked_reason']) {
      db.exec(`ALTER TABLE tasks DROP COLUMN ${column}`);
    }
    db.exec('ALTER TABLE boards DROP COLUMN lanes');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    return path;
  }

  test('heals an older build database in place and returns a validating handle', () => {
    const repo = initRepo(join(base, 'repo'));
    makeAdditiveLagDb(repo);

    const stale = openReadonlyDb(repo);
    expect(stale).not.toBeNull();
    expect(isCurrentGenieDb(stale as Database)).toBe(false);
    stale?.close();

    const healed = openReadonlyDbHealingStaleSchema(repo);
    expect(healed).not.toBeNull();
    expect(isCurrentGenieDb(healed as Database)).toBe(true);
    // The seeded task is served through the healed handle, additive columns included.
    const row = (healed as Database).query('SELECT title, wish, agent_kind FROM tasks').get() as {
      title: string;
      wish: string;
      agent_kind: string | null;
    };
    expect(row.title).toBe('seed');
    expect(row.wish).toBe('w');
    healed?.close();

    // The heal is durable on disk: a plain readonly reopen validates current.
    const reopened = openReadonlyDb(repo);
    expect(isCurrentGenieDb(reopened as Database)).toBe(true);
    reopened?.close();
  });

  test('accepts the databaseBinding target form the MCP loop passes', () => {
    const repo = initRepo(join(base, 'repo'));
    makeAdditiveLagDb(repo);
    const context = resolveProjectContext(repo);
    if (context.kind !== 'ok' || context.databaseBinding === undefined) {
      throw new Error(`expected ok context with binding, got ${context.kind}`);
    }
    const healed = openReadonlyDbHealingStaleSchema(context.databaseBinding);
    expect(healed).not.toBeNull();
    expect(isCurrentGenieDb(healed as Database)).toBe(true);
    healed?.close();
  });

  test('never creates an absent database', () => {
    const repo = initRepo(join(base, 'repo'));
    expect(openReadonlyDbHealingStaleSchema(repo)).toBeNull();
    expect(existsSync(join(repo, '.genie', 'genie.db'))).toBe(false);
  });

  test('refuses to heal through a binding whose database was substituted', () => {
    const repo = initRepo(join(base, 'repo'));
    makeAdditiveLagDb(repo);
    const context = resolveProjectContext(repo);
    if (context.kind !== 'ok' || context.databaseBinding === undefined) {
      throw new Error(`expected ok context with binding, got ${context.kind}`);
    }
    const binding = context.databaseBinding;
    // Replace the bound database after the binding was captured — the heal
    // must fail closed, never write-open the substituted file (openDb would
    // otherwise run ensureSchema DDL on it). The substitute is created while
    // the original still exists so it is guaranteed a distinct inode even on
    // filesystems that recycle inode numbers immediately (ext4), then renamed
    // over the original — the realistic atomic-swap shape.
    const dbPath = join(repo, '.genie', 'genie.db');
    const substitute = join(repo, '.genie', 'genie.db.substitute');
    copyFileSync(dbPath, substitute);
    renameSync(substitute, dbPath);
    expect(openReadonlyDbHealingStaleSchema(binding)).toBeNull();
    // The substituted database was left untouched by any write-path open.
    const untouched = openReadonlyDb(repo);
    expect(isCurrentGenieDb(untouched as Database)).toBe(false);
    untouched?.close();
  });

  test('serves a marker-only-stale database readonly when the heal write is impossible', () => {
    const repo = initRepo(join(base, 'repo'));
    seedDb(repo);
    const path = join(repo, '.genie', 'genie.db');
    const stale = new Database(path);
    // Shape is fully current; only the data-only backfill marker is pending —
    // the one staleness a read never depends on.
    stale.query('DELETE FROM meta WHERE key = ?').run(STAGE_LOG_BACKFILL_KEY);
    stale.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    stale.close();

    // Write-protect the database and its directory: the sandboxed/CI shape
    // where the consumer can read .genie/genie.db but never write it, so the
    // write-path heal is impossible.
    const genieDir = join(repo, '.genie');
    chmodSync(path, 0o444);
    chmodSync(genieDir, 0o555);
    try {
      // Root (some CI containers) ignores file modes, so the heal write would
      // succeed and this test would assert the wrong branch — the degrade
      // path is only expressible where chmod actually revokes write access.
      try {
        accessSync(path, fsConstants.W_OK);
        return; // still writable (running as root) — skip
      } catch {
        // write access revoked as intended — proceed
      }
      const served = openReadonlyDbHealingStaleSchema(repo);
      if (served === null) {
        // Null is only acceptable when this platform's SQLite cannot read a
        // write-protected WAL database AT ALL (read-only WAL support varies
        // by VFS state — ubuntu CI hits this). Probe a plain readonly open +
        // query: if that works, the degrade fallback should have served the
        // handle and returning null is a real regression.
        const probe = openReadonlyDb(repo);
        let readable = false;
        try {
          if (probe !== null) {
            probe.query('SELECT 1 FROM meta').get();
            readable = true;
          }
        } catch {
          // unreadable — the scenario is inexpressible in this environment
        }
        probe?.close();
        expect(readable).toBe(false);
        return;
      }
      // Still not strictly current (marker pending) — but readable and served.
      expect(isCurrentGenieDb(served)).toBe(false);
      const row = served.query('SELECT title FROM tasks').get() as { title: string };
      expect(row.title).toBe('seed');
      served.close();
    } finally {
      chmodSync(genieDir, 0o755);
      chmodSync(path, 0o644);
    }
  });

  test('fails closed on a future user_version instead of healing it', () => {
    const repo = initRepo(join(base, 'repo'));
    seedDb(repo);
    const path = join(repo, '.genie', 'genie.db');
    const db = new Database(path);
    db.exec('PRAGMA user_version = 99');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    expect(openReadonlyDbHealingStaleSchema(repo)).toBeNull();
    // The refusal left the foreign version untouched.
    const check = new Database(path, { readonly: true });
    expect((check.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(99);
    check.close();
  });
});

// ============================================================================
// Poisoned-WAL-index fixtures. The recovery itself now lives in the shared open
// primitive (sqlite-open.ts, tested in sqlite-open.test.ts) so every writer
// heals identically; what is asserted HERE is that `genie mcp`'s write open
// inherits it, and that the busy carve-out above it is intact. NOTE: on this
// machine the REAL poison (written by a degraded readonly close) is byte-for-
// byte identical to the virgin header bun writes on any healthy fresh open, and
// the write open does NOT throw on it (bun hands back a writable-looking handle
// whose writes fail "disk I/O error") — only the post-open write probe sees it.
// ============================================================================

/**
 * The exact read-only WAL-index header macOS/bun leaves in `-shm` when a
 * DEGRADED readonly connection closes while the db file is write-protected:
 * iVersion + isInit still set, iChange (offset 8) and nPage (offset 20) zeroed.
 * Observed live on macOS (bun 1.x): a write-protected db opened without the
 * readonly flag silently opens READONLY, writes fail with "attempt to write a
 * readonly database", and the close leaves this header.
 */
function poisonShmHeader(): Buffer {
  const header = Buffer.alloc(32768);
  header.writeUInt32LE(0x002de218, 0); // iVersion (matches the observed value)
  header.writeUInt32LE(1, 12); // isInit
  return header;
}

// ============================================================================
// openWriteableDb — hardened write path + read-only-degrade fallback (Group 1
// of wish mcp-write-tools: `genie mcp` now serves against a WRITABLE handle)
// ============================================================================

describe('openWriteableDb', () => {
  /** Probe whether a handle can take the write lock (BEGIN IMMEDIATE), then roll back. */
  function expectWritable(db: Database | null): void {
    expect(db).not.toBeNull();
    // A readonly/degraded handle raises SQLITE_READONLY here; a writable handle
    // takes the write lock and rolls back, leaving no side effect.
    (db as Database).exec('BEGIN IMMEDIATE');
    (db as Database).exec('ROLLBACK');
  }

  test('opens a WRITABLE handle through the standard CLI path in a healthy repo', () => {
    const repo = initRepo(join(base, 'repo'));
    seedDb(repo);
    const context = resolveProjectContext(repo);
    if (context.kind !== 'ok' || context.databaseBinding === undefined) throw new Error('expected bound database');
    const db = openWriteableDb(context.databaseBinding);
    expectWritable(db);
    expect(isDegradedReadonlyDb(db)).toBe(false);
    // The seeded task is served through the writable handle.
    const row = (db as Database).query('SELECT title FROM tasks').get() as { title: string };
    expect(row.title).toBe('seed');
    (db as Database).close();
  });

  test('degrades to a readable-but-degraded readonly handle on a write-protected fully-current db', () => {
    const repo = initRepo(join(base, 'repo'));
    seedDb(repo);
    const context = resolveProjectContext(repo);
    if (context.kind !== 'ok' || context.databaseBinding === undefined) throw new Error('expected bound database');
    const path = context.databaseBinding.physicalPath;
    const genieDir = dirname(path);
    chmodSync(path, 0o444);
    chmodSync(genieDir, 0o555);
    try {
      // Root (some CI containers) ignores file modes, so the write open would
      // succeed and this test would assert the wrong branch — the degrade path
      // is only expressible where chmod actually revokes write access.
      try {
        accessSync(path, fsConstants.W_OK);
        return; // still writable (running as root) — skip
      } catch {
        // write access revoked as intended — proceed
      }
      const served = openWriteableDb(context.databaseBinding);
      if (served === null) {
        // Null is only acceptable when this platform's SQLite cannot read a
        // write-protected WAL database AT ALL (read-only WAL support varies by
        // VFS state). Probe a plain readonly open + query: if that works, the
        // degrade fallback should have served the handle and null is a regression.
        const probe = openReadonlyDb(context.databaseBinding);
        let readable = false;
        try {
          if (probe !== null) {
            probe.query('SELECT 1 FROM meta').get();
            readable = true;
          }
        } catch {
          // unreadable — the scenario is inexpressible in this environment
        }
        probe?.close();
        expect(readable).toBe(false);
        return;
      }
      // The fully-current db's reads still serve through the degraded handle...
      const row = served.query('SELECT title FROM tasks').get() as { title: string };
      expect(row.title).toBe('seed');
      // ...and the handle is observable as degraded (a write through it fails).
      expect(isDegradedReadonlyDb(served)).toBe(true);
      served.close();
    } finally {
      chmodSync(genieDir, 0o755);
      chmodSync(path, 0o644);
    }
  });

  test('a subsequent write open on a repaired filesystem yields a fresh NON-degraded handle (never latched)', () => {
    const repo = initRepo(join(base, 'repo'));
    seedDb(repo);
    const context = resolveProjectContext(repo);
    if (context.kind !== 'ok' || context.databaseBinding === undefined) throw new Error('expected bound database');
    const path = context.databaseBinding.physicalPath;
    const genieDir = dirname(path);
    chmodSync(path, 0o444);
    chmodSync(genieDir, 0o555);
    try {
      try {
        accessSync(path, fsConstants.W_OK);
        return; // root — the degrade branch is inexpressible, skip
      } catch {
        // proceed
      }
      const degraded = openWriteableDb(context.databaseBinding);
      if (degraded === null) {
        // Inexpressible on this platform (same probe as the degrade test).
        const probe = openReadonlyDb(context.databaseBinding);
        let readable = false;
        try {
          if (probe !== null) {
            probe.query('SELECT 1 FROM meta').get();
            readable = true;
          }
        } catch {
          // unreadable
        }
        probe?.close();
        if (!readable) return;
      }
      expect(isDegradedReadonlyDb(degraded)).toBe(true);
      degraded?.close();
    } finally {
      chmodSync(genieDir, 0o755);
      chmodSync(path, 0o644);
    }
    // Repaired filesystem: the NEXT open goes through the write path and the
    // fresh handle is NOT degraded — the degraded state was derived from the
    // per-open outcome, never latched across opens.
    const restored = openWriteableDb(context.databaseBinding);
    expectWritable(restored);
    expect(isDegradedReadonlyDb(restored)).toBe(false);
    (restored as Database).close();
  });

  test('never creates an absent database (resolver ordering: a non-ok context never reaches the open)', () => {
    const repo = initRepo(join(base, 'repo'));
    expect(openWriteableDb(repo)).toBeNull();
    expect(existsSync(join(repo, '.genie', 'genie.db'))).toBe(false);
  });

  test('fails closed (null) on foreign, unversioned-foreign, and malformed databases', () => {
    const repo = initRepo(join(base, 'repo'));
    const dbPath = join(repo, '.genie', 'genie.db');
    mkdirSync(dirname(dbPath), { recursive: true });

    // Foreign: user_version = 99 with a lookalike tasks table.
    const foreign = new Database(dbPath);
    foreign.exec(
      'CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL); PRAGMA user_version = 99',
    );
    foreign.close();
    expect(openWriteableDb(repo)).toBeNull();

    // Unversioned foreign: user_version = 0 with existing foreign tables.
    rmSync(dbPath);
    const v0 = new Database(dbPath);
    v0.exec('CREATE TABLE inventory (id TEXT PRIMARY KEY)');
    v0.close();
    expect(openWriteableDb(repo)).toBeNull();

    // Malformed: not a SQLite database at all.
    rmSync(dbPath);
    writeFileSync(dbPath, 'not a sqlite database');
    expect(openWriteableDb(repo)).toBeNull();
  });

  test('the REAL poison a degraded session leaves behind heals on the next write open (no seam)', () => {
    const repo = initRepo(join(base, 'repo'));
    seedDb(repo);
    const context = resolveProjectContext(repo);
    if (context.kind !== 'ok' || context.databaseBinding === undefined) throw new Error('expected bound database');
    const binding = context.databaseBinding;
    const path = binding.physicalPath;
    const genieDir = dirname(path);

    // Build the REAL poison in-process: the degraded readonly fallback's close
    // writes the zeroed read-only wal-index header into -shm. Crafted header
    // bytes canNOT stand in for it — the real poison is byte-identical to a
    // healthy virgin header and only fails through the HANDLE.
    chmodSync(path, 0o444);
    chmodSync(genieDir, 0o555);
    try {
      try {
        accessSync(path, fsConstants.W_OK);
        return; // root — the degrade branch is inexpressible, skip
      } catch {
        // write access revoked as intended — proceed
      }
      const degraded = openWriteableDb(binding);
      if (degraded === null) {
        // Inexpressible on this platform (same probe as the degrade test).
        const probe = openReadonlyDb(binding);
        let readable = false;
        try {
          if (probe !== null) {
            probe.query('SELECT 1 FROM meta').get();
            readable = true;
          }
        } catch {
          // unreadable — the scenario is inexpressible in this environment
        }
        probe?.close();
        if (!readable) return;
      }
      expect(isDegradedReadonlyDb(degraded)).toBe(true);
      degraded?.close(); // writes the REAL poison marker into -shm
    } finally {
      chmodSync(genieDir, 0o755);
      chmodSync(path, 0o644);
    }
    if (!hasStaleReadonlyWalIndex(binding.physicalPath)) return; // no poison produced here

    // Repaired filesystem: the write open inherits the shared recovery — the
    // open itself succeeds, its post-open probe rejects the poison, the
    // sidecars are rebuilt, and the handle served is writable and NOT degraded.
    const db = openWriteableDb(binding);
    expectWritable(db);
    expect(isDegradedReadonlyDb(db)).toBe(false);
    (db as Database).close();
  });

  test('a BusyDbError write open returns null WITHOUT the readonly degrade fallback or sidecar recovery', () => {
    const repo = initRepo(join(base, 'repo'));
    seedDb(repo);
    const context = resolveProjectContext(repo);
    if (context.kind !== 'ok' || context.databaseBinding === undefined) throw new Error('expected bound database');
    const binding = context.databaseBinding;
    const shmPath = `${binding.physicalPath}-shm`;

    // Even with a poisoned -shm present, a busy open must NOT run sidecar
    // recovery (the sidecars belong to a live writer) and must NOT degrade to
    // readonly: the loop's per-call reopen retries the write open next call.
    rmSync(shmPath, { force: true });
    writeFileSync(shmPath, poisonShmHeader());

    const db = openWriteableDb(binding, {
      openDatabase: () => {
        throw new BusyDbError(binding.physicalPath, new Error('write lock held by another process'));
      },
    });
    expect(db).toBeNull();
    expect(isDegradedReadonlyDb(db)).toBe(false); // not mislabeled read-only
    // The poisoned -shm was left untouched — recovery never ran for a busy db.
    expect(hasStaleReadonlyWalIndex(binding.physicalPath)).toBe(true);
  });
});
// ============================================================================
// MCP_WRITE_TOOLS — the 12 operative write tools (Group 2)
// ============================================================================
//
// Every verb is driven through the same in-process registry `genie mcp`
// serves, then its observable db effect is read back via `task-state.ts`
// queries — the parity assertion that each write equals its CLI counterpart.

interface RpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: { isError?: boolean; content?: Array<{ type: string; text: string }> };
  error?: { code: number; message: string };
}

/** Spawn a real `genie mcp` server subprocess (as an MCP client would). */
async function spawnMcpServer(cwd: string, requests: Record<string, unknown>[]): Promise<RpcResponse[]> {
  const proc = Bun.spawn(['bun', join(import.meta.dir, '..', '..', 'genie.ts'), 'mcp'], {
    cwd,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1', GENIE_TEST_SKIP_PGSERVE: '1' },
  });
  proc.stdin.write(`${requests.map((r) => JSON.stringify(r)).join('\n')}\n`);
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RpcResponse);
}

const MCP_INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } },
};
const MCP_INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };

describe('MCP_WRITE_TOOLS — the 12 operative write tools', () => {
  let repo: string;
  let db: Database;
  let ctx: ToolContext;

  beforeEach(() => {
    repo = initRepo(join(base, 'write-repo'));
    db = openDb({ cwd: repo });
    ctx = { db, cwd: repo };
  });

  afterEach(() => {
    db?.close();
  });

  function call(name: string, args: Record<string, unknown>): unknown {
    const tool = MCP_WRITE_TOOLS.find((t) => t.name === name);
    if (!tool) throw new Error(`no write tool ${name}`);
    return tool.handler(ctx, args);
  }

  function expectOk<T = Record<string, unknown>>(result: unknown): T {
    expect(isToolError(result)).toBe(false);
    return result as T;
  }

  function expectError(result: unknown, code: string): Record<string, unknown> {
    expect(isToolError(result)).toBe(true);
    const payload = unwrapToolError(result as ToolResult) as Record<string, unknown>;
    expect(payload.error).toBe(code);
    return payload;
  }

  function readyTask(title: string): string {
    return createTask(db, { title }).id;
  }

  test('MCP_TOOLS stays the 5 read tools — ui-bridge splice untouched', () => {
    expect(MCP_TOOLS.map((t) => t.name).sort()).toEqual([
      'genie_active',
      'genie_board',
      'genie_task',
      'genie_wish_status',
      'genie_worktree_context',
    ]);
  });

  test('MCP_WRITE_TOOLS exposes exactly the 12 operative-core verbs', () => {
    expect(MCP_WRITE_TOOLS.map((t) => t.name).sort()).toEqual([
      'genie_task_add_dependency',
      'genie_task_block',
      'genie_task_checkout',
      'genie_task_comment',
      'genie_task_create',
      'genie_task_done',
      'genie_task_heartbeat',
      'genie_task_move',
      'genie_task_release',
      'genie_task_report',
      'genie_task_set_wish',
      'genie_task_unblock',
    ]);
  });

  // --- genie_task_create ----------------------------------------------------

  test('genie_task_create mirrors task create: the row lands with CLI-identical fields', () => {
    const board = createBoard(db, 'repo');
    const result = expectOk<{ task: TaskSummary }>(
      call('genie_task_create', { title: 'new card', board: 'repo', wish: 'mcp-write-tools', group: 'g2' }),
    );
    expect(result.task.title).toBe('new card');
    const row = getTask(db, result.task.id);
    expect(row).not.toBeNull();
    expect(row?.status).toBe('ready');
    expect(row?.wish).toBe('mcp-write-tools');
    expect(row?.group).toBe('g2');
    expect(row?.boardId).toBe(board.id);
    expect(row?.claimedBy).toBeNull();
  });

  test('genie_task_create rejects missing title and group-without-wish as invalid_arguments', () => {
    expectError(call('genie_task_create', {}), 'invalid_arguments');
    expectError(call('genie_task_create', { title: 'x', group: 'g2' }), 'invalid_arguments');
    expect(getTask(db, 't_missing')).toBeNull();
  });

  test('genie_task_create with an unknown board returns typed not_found, never -32603', () => {
    const payload = expectError(call('genie_task_create', { title: 'x', board: 'no_such_board' }), 'not_found');
    expect(payload.detail).toBe('no_such_board');
    expect(String(payload.message)).toContain('Board not found');
    expect(getTask(db, 't_missing')).toBeNull();
  });

  // --- genie_task_checkout --------------------------------------------------

  test('genie_task_checkout claims atomically: two workers claim two claimed_by values on one server', () => {
    const a = readyTask('a');
    const b = readyTask('b');
    const ra = expectOk<{ task: TaskSummary }>(call('genie_task_checkout', { id: a, worker: 'w1' }));
    const rb = expectOk<{ task: TaskSummary }>(call('genie_task_checkout', { id: b, worker: 'w2' }));
    expect(ra.task.claimedBy).toBe('w1');
    expect(rb.task.claimedBy).toBe('w2');
    expect(getTask(db, a)?.status).toBe('in_progress');
    expect(getTask(db, b)?.status).toBe('in_progress');
    // the claim event attributes the env fallback (no author arg given)
    expect(getTaskEvents(db, a)[0]?.kind).toBe('claim');
  });

  test('genie_task_checkout on an already-claimed card → typed claim_conflict', () => {
    const t = readyTask('a');
    call('genie_task_checkout', { id: t, worker: 'w1' });
    const payload = expectError(call('genie_task_checkout', { id: t, worker: 'w2' }), 'claim_conflict');
    expect(payload.taskId).toBe(t);
    expect(getTask(db, t)?.claimedBy).toBe('w1');
  });

  test('genie_task_checkout on an enforced-blocked card → refused_transition (TaskBlockedError)', () => {
    const t = readyTask('a');
    blockTask(db, t, 'waiting on design', { author: 'orch', authorKind: 'human' });
    const payload = expectError(call('genie_task_checkout', { id: t, worker: 'w1' }), 'refused_transition');
    expect(payload.detail).toBe('TaskBlockedError');
  });

  test('genie_task_checkout rejects unknown ids and missing worker', () => {
    expectError(call('genie_task_checkout', { id: 't_missing', worker: 'w1' }), 'not_found');
    const t = readyTask('a');
    expectError(call('genie_task_checkout', { id: t }), 'invalid_arguments');
  });

  // --- genie_task_done ------------------------------------------------------

  test('genie_task_done completes a card and recomputes the ready set (dependent flips to ready)', () => {
    const parent = readyTask('parent');
    const child = createTask(db, { title: 'child', dependsOn: [parent] }).id;
    expect(getTask(db, child)?.status).toBe('blocked');
    call('genie_task_checkout', { id: parent, worker: 'w1' });
    const result = expectOk<{ task: TaskSummary }>(call('genie_task_done', { id: parent, author: 'orch' }));
    expect(result.task.status).toBe('done');
    // recomputeReady ran inside completeTask — the dependent is ready now
    expect(getTask(db, child)?.status).toBe('ready');
    // the release event carries the explicit author
    const events = getTaskEvents(db, parent);
    expect(events.some((e) => e.kind === 'release' && e.author === 'orch')).toBe(true);
  });

  test('genie_task_done refuses blocked and already-done cards → refused_transition with the class name', () => {
    const parent = readyTask('parent');
    const child = createTask(db, { title: 'child', dependsOn: [parent] }).id;
    const blocked = expectError(call('genie_task_done', { id: child }), 'refused_transition');
    expect(blocked.detail).toBe('TaskNotReadyError');
    call('genie_task_done', { id: parent });
    const alreadyDone = expectError(call('genie_task_done', { id: parent }), 'refused_transition');
    expect(alreadyDone.detail).toBe('TaskCompleteError');
    expectError(call('genie_task_done', { id: 't_missing' }), 'not_found');
  });

  // --- genie_task_move ------------------------------------------------------

  test('genie_task_move moves a card to a defined lane, mirroring task move', () => {
    const board = createBoard(db, 'kanban', [{ name: 'Idea' }, { name: 'Doing' }, { name: 'Done' }]);
    const t = createTask(db, { title: 'a', boardId: board.id }).id;
    const result = expectOk<{ task: TaskSummary; from: string | null; to: string }>(
      call('genie_task_move', { id: t, to: 'Doing', author: 'w1' }),
    );
    expect(result.to).toBe('Doing');
    expect(result.from).toBeNull();
    expect(getTaskLane(db, t)).toBe('Doing');
    expect(getTaskEvents(db, t).some((e) => e.kind === 'move' && e.author === 'w1')).toBe(true);
  });

  test('genie_task_move rejects undefined and no-lane targets → invalid_lane', () => {
    const board = createBoard(db, 'kanban', [{ name: 'Idea' }, { name: 'Done' }]);
    const t = createTask(db, { title: 'a', boardId: board.id }).id;
    const unknown = expectError(call('genie_task_move', { id: t, to: 'Nope' }), 'invalid_lane');
    expect(String(unknown.message)).toContain('Idea');
    const noLanes = createTask(db, { title: 'b', boardId: createBoard(db, 'repo').id }).id;
    expectError(call('genie_task_move', { id: noLanes, to: 'Doing' }), 'invalid_lane');
    expectError(call('genie_task_move', { id: 't_missing', to: 'Doing' }), 'not_found');
  });

  // --- genie_task_block / genie_task_unblock --------------------------------

  test('genie_task_block places an enforced block (checkout refused) and unblock clears it', () => {
    const t = readyTask('a');
    const blocked = expectOk<{ task: TaskSummary }>(
      call('genie_task_block', { id: t, reason: 'waiting', author: 'orch' }),
    );
    expect(blocked.task.status).toBe('ready'); // a block does not change status
    expect(getTaskEvents(db, t).some((e) => e.kind === 'block' && e.note === 'waiting' && e.author === 'orch')).toBe(
      true,
    );
    expectError(call('genie_task_checkout', { id: t, worker: 'w1' }), 'refused_transition');
    expectOk(call('genie_task_unblock', { id: t, author: 'orch' }));
    expectOk(call('genie_task_checkout', { id: t, worker: 'w1' })); // claimable again
  });

  test('genie_task_block records a hold kind and both verbs reject unknown ids', () => {
    const t = readyTask('a');
    call('genie_task_block', { id: t, reason: 'parked', hold: true });
    expectError(call('genie_task_checkout', { id: t, worker: 'w1' }), 'refused_transition');
    expectError(call('genie_task_block', { id: 't_missing', reason: 'x' }), 'not_found');
    expectError(call('genie_task_unblock', { id: 't_missing' }), 'not_found');
    expectError(call('genie_task_block', { id: t }), 'invalid_arguments');
  });

  // --- genie_task_release ---------------------------------------------------

  test('genie_task_release returns a claimed card to the ready queue', () => {
    const t = readyTask('a');
    call('genie_task_checkout', { id: t, worker: 'w1' });
    const result = expectOk<{ task: TaskSummary }>(call('genie_task_release', { id: t, author: 'w1' }));
    expect(result.task.status).toBe('ready');
    expect(result.task.claimedBy).toBeNull();
    expect(getTask(db, t)?.claimedBy).toBeNull();
    expect(getTaskEvents(db, t).some((e) => e.kind === 'release' && e.note === 'released')).toBe(true);
  });

  test('genie_task_release on an unclaimed ready card → refused_transition (TaskReleaseError)', () => {
    const t = readyTask('a');
    const payload = expectError(call('genie_task_release', { id: t }), 'refused_transition');
    expect(payload.detail).toBe('TaskReleaseError');
    expectError(call('genie_task_release', { id: 't_missing' }), 'not_found');
  });

  // --- genie_task_comment / genie_task_report -------------------------------

  test('genie_task_comment and genie_task_report append authored timeline events', () => {
    const t = readyTask('a');
    const comment = expectOk<{ taskId: string; event: { kind: string; note: string; author: string | null } }>(
      call('genie_task_comment', { id: t, text: 'look at this', author: 'w1' }),
    );
    expect(comment.event.kind).toBe('comment');
    expect(comment.event.note).toBe('look at this');
    const report = expectOk<{ taskId: string; event: { kind: string; note: string; author: string | null } }>(
      call('genie_task_report', { id: t, text: 'blocked on review', author: 'w1' }),
    );
    expect(report.event.kind).toBe('report');
    const events = getTaskEvents(db, t);
    expect(events.map((e) => e.kind)).toEqual(['comment', 'report']);
    expect(events.every((e) => e.author === 'w1')).toBe(true);
  });

  test('genie_task_comment / genie_task_report reject unknown ids and empty text', () => {
    expectError(call('genie_task_comment', { id: 't_missing', text: 'x' }), 'not_found');
    expectError(call('genie_task_report', { id: 't_missing', text: 'x' }), 'not_found');
    const t = readyTask('a');
    expectError(call('genie_task_comment', { id: t, text: '  ' }), 'invalid_arguments');
    expectError(call('genie_task_report', { id: t }), 'invalid_arguments');
  });

  // --- genie_task_heartbeat -------------------------------------------------

  test('genie_task_heartbeat records heartbeat_at as a bare timestamp write, not an event', () => {
    const t = readyTask('a');
    call('genie_task_checkout', { id: t, worker: 'w1' });
    const result = expectOk<{ taskId: string; heartbeatAt: number }>(call('genie_task_heartbeat', { id: t }));
    expect(result.heartbeatAt).toBeGreaterThan(0);
    expect(getTaskEvents(db, t)).toHaveLength(1); // only the claim event
    expectError(call('genie_task_heartbeat', { id: 't_missing' }), 'not_found');
  });

  // --- genie_task_set_wish --------------------------------------------------

  test('genie_task_set_wish attaches, re-points, and clears the wish identity', () => {
    const t = readyTask('a');
    const attach = expectOk<{
      task: TaskSummary;
      from: { wish: string | null; group: string | null };
      to: { wish: string | null; group: string | null };
    }>(call('genie_task_set_wish', { id: t, wish: 'alpha', author: 'orch' }));
    expect(attach.from).toEqual({ wish: null, group: null });
    expect(attach.to).toEqual({ wish: 'alpha', group: null });
    expect(getTask(db, t)?.wish).toBe('alpha');
    expect(getTaskEvents(db, t).some((e) => e.kind === 'wish' && e.author === 'orch')).toBe(true);

    expectOk(call('genie_task_set_wish', { id: t, wish: 'beta', group: 'g2' }));
    expect(getTask(db, t)?.wish).toBe('beta');
    expect(getTask(db, t)?.group).toBe('g2');

    expectOk(call('genie_task_set_wish', { id: t, clear: true }));
    expect(getTask(db, t)?.wish).toBeNull();
    expect(getTask(db, t)?.group).toBeNull();
  });

  test('genie_task_set_wish enforces the CLI arg guards and unknown ids', () => {
    const t = readyTask('a');
    expectError(call('genie_task_set_wish', { id: t, group: 'g2' }), 'invalid_arguments');
    expectError(call('genie_task_set_wish', { id: t, wish: 'x', clear: true }), 'invalid_arguments');
    expectError(call('genie_task_set_wish', { id: t }), 'invalid_arguments');
    expectError(call('genie_task_set_wish', { id: 't_missing', wish: 'x' }), 'not_found');
  });

  test('genie_task_set_wish rejects a supplied-but-empty group instead of dropping it (CLI parity)', () => {
    const t = readyTask('a');
    // `task set-wish --group ''` fails with "--group must not be empty."; the
    // tool must not silently attach the wish with no group and report success.
    for (const group of ['', '   ', 42]) {
      const payload = expectError(call('genie_task_set_wish', { id: t, wish: 'w1', group }), 'invalid_arguments');
      expect(String(payload.detail)).toContain('group must not be empty');
    }
    expect(getTask(db, t)?.wish).toBeNull();
    // An omitted group stays optional: the wish attaches with a null group.
    expectOk(call('genie_task_set_wish', { id: t, wish: 'w1' }));
    expect(getTask(db, t)?.wish).toBe('w1');
    expect(getTask(db, t)?.group).toBeNull();
  });

  // --- genie_task_add_dependency --------------------------------------------

  test('genie_task_add_dependency inserts the edge and rejects cycles and unknown tasks', () => {
    const a = readyTask('a');
    const b = readyTask('b');
    const result = expectOk<{ taskId: string; dependsOnId: string }>(
      call('genie_task_add_dependency', { id: b, depends_on: a }),
    );
    expect(result).toEqual({ taskId: b, dependsOnId: a });
    expect(getDependencies(db, b)).toEqual([a]);
    expectError(call('genie_task_add_dependency', { id: a, depends_on: a }), 'dependency_cycle'); // self
    expectError(call('genie_task_add_dependency', { id: a, depends_on: b }), 'dependency_cycle'); // transitive
    expectError(call('genie_task_add_dependency', { id: 't_missing', depends_on: a }), 'not_found');
    expectError(call('genie_task_add_dependency', { id: a }), 'invalid_arguments');
  });

  // --- identity / error-channel contracts -----------------------------------

  test('the server env identity is the fallback when author/worker args are absent (Decision 8)', () => {
    const t = readyTask('a');
    const keys = ['GENIE_AGENT_NAME', 'GENIE_AGENT_KIND', 'CODEX_THREAD_ID'] as const;
    const prev = keys.map((key) => [key, process.env[key]] as const);
    try {
      process.env.GENIE_AGENT_NAME = 'env-agent';
      process.env.GENIE_AGENT_KIND = 'codex';
      Reflect.deleteProperty(process.env, 'CODEX_THREAD_ID');
      call('genie_task_checkout', { id: t, worker: 'w1' }); // no author arg
      const events = getTaskEvents(db, t);
      expect(events[0]?.author).toBe('env-agent');
      expect(events[0]?.authorKind).toBe('codex');
    } finally {
      for (const [key, value] of prev) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
    // The identity env is process-global: a leak here would silently re-attribute
    // every later test in this process.
    for (const [key, value] of prev) expect(process.env[key]).toBe(value);
  });

  test('a write reaching a raw readonly handle maps to read_only_database, never -32603', () => {
    const t = readyTask('a');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    const readonly = new Database(join(repo, '.genie', 'genie.db'), { readonly: true });
    const roCtx: ToolContext = { db: readonly, cwd: repo };
    try {
      const result = callOn(roCtx, 'genie_task_comment', { id: t, text: 'x' });
      const payload = expectError(result, 'read_only_database');
      expect(String(payload.detail)).toMatch(/readonly/i);
    } finally {
      readonly.close();
    }
  });

  test('on a write-protected fully-current db, write tools return read_only_database while reads still serve', () => {
    const roRepo = initRepo(join(base, 'ro-repo'));
    seedDb(roRepo);
    const path = join(roRepo, '.genie', 'genie.db');
    const genieDir = join(roRepo, '.genie');
    chmodSync(path, 0o444);
    chmodSync(genieDir, 0o555);
    try {
      try {
        accessSync(path, fsConstants.W_OK);
        return; // running as root — the degrade scenario is inexpressible here
      } catch {
        // write access revoked as intended — proceed
      }
      const handle = openWriteableDb(roRepo);
      if (handle === null) {
        // This platform cannot even read a write-protected WAL db — inexpressible.
        return;
      }
      expect(isDegradedReadonlyDb(handle)).toBe(true);
      const roCtx: ToolContext = { db: handle, cwd: roRepo };
      const payload = expectError(callOn(roCtx, 'genie_task_create', { title: 'x' }), 'read_only_database');
      expect(String(payload.detail)).toContain('read-only');
      // the degraded handle still serves reads (strict validator intact)
      const board = MCP_TOOLS.find((x) => x.name === 'genie_board')!.handler(roCtx, {});
      expect((board as { counts: { total: number } }).counts.total).toBe(1);
      handle.close();
    } finally {
      chmodSync(genieDir, 0o755);
      chmodSync(path, 0o644);
    }
  });

  test('cross-process claim contention: two spawned servers — exactly one winner, loser gets typed claim_conflict', async () => {
    const race = initRepo(join(base, 'race-repo'));
    const seed = openDb({ cwd: race });
    createBoard(seed, 'repo');
    const task = createTask(seed, { title: 'race' });
    seed.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    seed.close();

    const drive = (worker: string) =>
      spawnMcpServer(race, [
        MCP_INIT,
        MCP_INITIALIZED,
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'genie_task_checkout', arguments: { id: task.id, worker } },
        },
      ]);

    const [a, b] = await Promise.all([drive('w1'), drive('w2')]);
    const aRes = a.find((r) => r.id === 2);
    const bRes = b.find((r) => r.id === 2);
    expect(aRes).toBeDefined();
    expect(bRes).toBeDefined();
    expect(aRes?.error).toBeUndefined(); // no JSON-RPC error, no -32603
    expect(bRes?.error).toBeUndefined();
    const outcomes = [aRes!, bRes!];
    const winners = outcomes.filter((r) => r.result?.isError === false);
    const losers = outcomes.filter((r) => r.result?.isError === true);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const loserPayload = JSON.parse((losers[0].result?.content as Array<{ type: string; text: string }>)[0].text) as {
      error: string;
    };
    expect(loserPayload.error).toBe('claim_conflict');
    const check = openDb({ cwd: race });
    try {
      const claimedBy = getTask(check, task.id)?.claimedBy ?? null;
      if (claimedBy === null) throw new Error('no claim persisted');
      expect(['w1', 'w2']).toContain(claimedBy); // exactly one claim persisted
    } finally {
      check.close();
    }
  });
});

function callOn(ctx: ToolContext, name: string, args: Record<string, unknown>): unknown {
  const tool = MCP_WRITE_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no write tool ${name}`);
  return tool.handler(ctx, args);
}

type ToolResult = ToolErrorResult<Record<string, unknown>>;
