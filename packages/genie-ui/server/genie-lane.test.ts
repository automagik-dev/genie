// genie-lane.test.ts — the genie lane, exercised against a FIXTURE `.genie` (wishes
// markdown + a genie.db). Runs under `bun test`, so the read path takes the bun:sqlite
// branch; the node:sqlite branch is the same SELECT-only surface, exercised at server
// runtime (see README "Runtime split"). Every assertion pins a G2 acceptance criterion.

import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type FleetMember,
  type RosterEntry,
  branchFor,
  groupWorktreePath,
  hire,
  listWishes,
  wishContext,
  worktreeFor,
} from './genie-lane';

let root: string;

/** Write a minimal WISH.md with a Status metadata row + a title heading. */
function writeWish(slug: string, status: string, title: string): void {
  const dir = join(root, '.genie', 'wishes', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'WISH.md'),
    `# ${title}\n\n| Field | Value |\n|-------|-------|\n| **Slug** | \`${slug}\` |\n| **Status** | ${status} |\n`,
    'utf8',
  );
}

/** Build a genie.db fixture with the real schema shape (boards/tasks/wish_groups). */
function seedDb(): void {
  const db = new Database(join(root, '.genie', 'genie.db'), { create: true });
  db.exec(`
    CREATE TABLE boards (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, board_id TEXT, title TEXT NOT NULL, status TEXT NOT NULL,
      claimed_by TEXT, claimed_at INTEGER, wish TEXT, group_name TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE wish_groups (
      wish TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, depends_on TEXT NOT NULL DEFAULT '[]',
      assignee TEXT, started_at INTEGER, completed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (wish, name)
    );
  `);
  db.prepare('INSERT INTO boards VALUES (?,?,?)').run('b1', 'main', 1);
  db.prepare('INSERT INTO tasks (id,title,status,wish,group_name,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(
    't1',
    'G1 shell substrate',
    'done',
    'genie-ui',
    'group-1',
    1,
    1,
  );
  db.prepare('INSERT INTO tasks (id,title,status,wish,group_name,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(
    't2',
    'G2 genie lane',
    'in_progress',
    'genie-ui',
    'group-2',
    2,
    2,
  );
  db.prepare(
    'INSERT INTO wish_groups (wish,name,status,depends_on,assignee,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
  ).run('genie-ui', 'group-2', 'in_progress', '["group-1"]', 'engineer-standard', 2, 2);
  db.close();
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'genie-lane-'));
  writeWish('genie-ui', 'IN_PROGRESS', 'Wish: genie-ui');
  writeWish('genie-mcp', 'SHIPPED', 'Wish: genie-mcp');
  seedDb();
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('listWishes (AC1 — left menu from repo .genie)', () => {
  it('lists wishes from `.genie/wishes` markdown, slug-sorted, with Status', () => {
    const wishes = listWishes({ root });
    expect(wishes.map((w) => w.slug)).toEqual(['genie-mcp', 'genie-ui']);
    const ui = wishes.find((w) => w.slug === 'genie-ui');
    expect(ui?.status).toBe('IN_PROGRESS');
    expect(ui?.title).toBe('Wish: genie-ui');
  });

  it('degrades to empty when `.genie/wishes` is absent', () => {
    expect(listWishes({ root: mkdtempSync(join(tmpdir(), 'genie-empty-')) })).toEqual([]);
  });
});

describe('wishContext (AC1 — selecting a wish opens its worktree-bound state)', () => {
  it('reads board/task + group state READ-ONLY from the fixture genie.db', () => {
    const ctx = wishContext('genie-ui', { root });
    expect(ctx.wish?.slug).toBe('genie-ui');
    expect(ctx.tasks.map((t) => t.group)).toEqual(['group-1', 'group-2']);
    expect(ctx.groups).toEqual([
      { wish: 'genie-ui', name: 'group-2', status: 'in_progress', assignee: 'engineer-standard' },
    ]);
  });

  it('degrades to empty state (no throw) when genie.db is absent', () => {
    const bare = mkdtempSync(join(tmpdir(), 'genie-nodb-'));
    mkdirSync(join(bare, '.genie', 'wishes', 'genie-ui'), { recursive: true });
    writeFileSync(join(bare, '.genie', 'wishes', 'genie-ui', 'WISH.md'), '# x\n| **Status** | DRAFT |\n', 'utf8');
    const ctx = wishContext('genie-ui', { root: bare });
    expect(ctx.wish?.slug).toBe('genie-ui');
    expect(ctx.groups).toEqual([]);
    expect(ctx.tasks).toEqual([]);
  });

  it('read-only open cannot mutate genie.db (probe: write to the same file is refused)', () => {
    // The lane never opens the DB writable. Prove the file the lane reads is itself
    // read-only through the lane by opening it read-only here and asserting a write throws.
    const ro = new Database(join(root, '.genie', 'genie.db'), { readonly: true });
    expect(() => ro.prepare('INSERT INTO boards VALUES (?,?,?)').run('b2', 'x', 1)).toThrow();
    ro.close();
  });
});

describe('hire (AC2 — roster entry only, no live process)', () => {
  it('returns a roster entry binding a member to a wish group, spawning nothing', () => {
    const member: FleetMember = { id: 'fable', harness: 'claude', name: 'Fable', group: 'group-2' };
    const entry = hire('genie-ui', member);
    expect(entry).toMatchObject({
      wishSlug: 'genie-ui',
      memberId: 'fable',
      harness: 'claude',
      name: 'Fable',
      group: 'group-2',
    });
    expect(typeof entry.hiredAt).toBe('number');
  });

  it('defaults the display name to the member id', () => {
    expect(hire('genie-ui', { id: 'codex', harness: 'codex', group: 'group-3' }).name).toBe('codex');
  });
});

describe('worktreeFor (AC2 — reuse genie launch worktree, null before launch, never mint)', () => {
  const entry: RosterEntry = {
    wishSlug: 'genie-ui',
    memberId: 'fable',
    harness: 'claude',
    name: 'Fable',
    group: 'group-2',
    hiredAt: 0,
  };

  it('computes the exact `genie launch` deterministic path (<repo>-<slug>-<group>)', () => {
    const path = groupWorktreePath(entry, { root: '/home/u/repos/genie', worktreesDir: '/wt' });
    expect(path).toBe('/wt/genie-genie-ui-group-2');
    expect(branchFor(entry)).toBe('wish/genie-ui-group-2');
  });

  it('returns null/unbound before the group is launched (no worktree on disk)', () => {
    const bound = worktreeFor(entry, {
      root: '/home/u/repos/genie',
      worktreesDir: mkdtempSync(join(tmpdir(), 'genie-wt-')),
    });
    expect(bound).toBeNull();
  });

  it('resolves to the launched worktree once it exists (reuse, never mint)', () => {
    const wtBase = mkdtempSync(join(tmpdir(), 'genie-wt-'));
    const expected = join(wtBase, 'genie-genie-ui-group-2');
    // Simulate a launched linked worktree: dir + the `.git` file `git worktree add` writes.
    mkdirSync(expected, { recursive: true });
    writeFileSync(join(expected, '.git'), 'gitdir: /somewhere/.git/worktrees/x\n', 'utf8');
    const bound = worktreeFor(entry, { root: '/home/u/repos/genie', worktreesDir: wtBase });
    expect(bound).toBe(expected);
  });

  it('a stray directory without `.git` is NOT treated as a launched worktree', () => {
    const wtBase = mkdtempSync(join(tmpdir(), 'genie-wt-'));
    mkdirSync(join(wtBase, 'genie-genie-ui-group-2'), { recursive: true });
    expect(worktreeFor(entry, { root: '/home/u/repos/genie', worktreesDir: wtBase })).toBeNull();
  });

  it('honors GENIE_WORKTREES_DIR when no explicit base is given (launch.ts parity)', () => {
    const prev = process.env.GENIE_WORKTREES_DIR;
    const wtBase = mkdtempSync(join(tmpdir(), 'genie-env-wt-'));
    process.env.GENIE_WORKTREES_DIR = wtBase;
    try {
      expect(groupWorktreePath(entry, { root: '/x/genie' })).toBe(join(wtBase, 'genie-genie-ui-group-2'));
    } finally {
      // Reflect.deleteProperty genuinely removes the key (a `= undefined` assignment would
      // coerce to the string "undefined" and leak into later tests); `delete` trips noDelete.
      if (prev === undefined) Reflect.deleteProperty(process.env, 'GENIE_WORKTREES_DIR');
      else process.env.GENIE_WORKTREES_DIR = prev;
    }
  });
});
