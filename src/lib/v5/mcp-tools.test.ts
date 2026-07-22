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

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { openDb } from './genie-db.js';
import { MCP_TOOLS, openReadonlyDb, resolveProjectContext } from './mcp-tools.js';
import { createBoard, createTask } from './task-state.js';

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
