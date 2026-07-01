import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CURRENT_SCHEMA_VERSION,
  ForeignDbError,
  MalformedDbError,
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
    expect(tables).toEqual(['boards', 'meta', 'stage_log', 'task_dependencies', 'tasks', 'wish_groups']);
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
