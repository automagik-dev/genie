/**
 * genie v5 task — CLI-level tests. Each case invokes the real `genie.ts` entry
 * as a user would (subprocess), against a throwaway git-repo fixture, and
 * asserts exit code AND stderr, not just stdout.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, resolveDbPath } from '../lib/v5/genie-db.js';
import { type StateExport, appendStage, createBoard, createTask, createWishGroups } from '../lib/v5/task-state.js';

const GENIE = join(import.meta.dir, '..', 'genie.ts');

let repo: string;

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

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function cli(cwd: string, ...args: string[]): Promise<CliResult> {
  const proc = Bun.spawn(['bun', GENIE, 'v5', 'task', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1', GENIE_TEST_SKIP_PGSERVE: '1' },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { stdout, stderr, code };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'genie-v5-task-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'commit', '--allow-empty', '-m', 'init');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('task create', () => {
  test('creates a ready task and reports its id', async () => {
    const r = await cli(repo, 'create', '--title', 'ship it');
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toMatch(/Created task t_\w+ "ship it" \(ready\)\./);
  });

  test('rejects an empty title with a clear stderr and exit 1', async () => {
    const r = await cli(repo, 'create', '--title', '   ');
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('--title is required');
  });

  test('rejects --group without --wish', async () => {
    const r = await cli(repo, 'create', '--title', 't', '--group', 'g1');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--group requires --wish');
  });

  test('rejects a missing board reference with a typed error and exit 1', async () => {
    const r = await cli(repo, 'create', '--title', 't', '--board', 'ghost');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Board not found: ghost');
  });

  test('attaches to an existing board by id', async () => {
    const db = openDb({ cwd: repo });
    const board = createBoard(db, 'sprint-1');
    db.close();
    const r = await cli(repo, 'create', '--title', 'on board', '--board', board.id);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
  });
});

describe('task list', () => {
  test('reports "No tasks found." on an empty repo', async () => {
    const r = await cli(repo, 'list');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('No tasks found.');
  });

  test('rejects an invalid --status', async () => {
    const r = await cli(repo, 'list', '--status', 'nope');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Invalid --status "nope"');
  });

  test('--json emits an array filtered by wish', async () => {
    await cli(repo, 'create', '--title', 'a', '--wish', 'demo');
    await cli(repo, 'create', '--title', 'b');
    const r = await cli(repo, 'list', '--wish', 'demo', '--json');
    expect(r.code).toBe(0);
    const rows = JSON.parse(r.stdout) as Array<{ title: string; wish: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('a');
    expect(rows[0].wish).toBe('demo');
  });
});

describe('task status / done / checkout', () => {
  async function seedTask(title: string): Promise<string> {
    const db = openDb({ cwd: repo });
    const task = createTask(db, { title });
    db.close();
    return task.id;
  }

  test('status shows detail; unknown id fails with exit 1', async () => {
    const id = await seedTask('inspect me');
    const ok = await cli(repo, 'status', id);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain(id);
    expect(ok.stdout).toContain('inspect me');

    const bad = await cli(repo, 'status', 't_missing');
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('Task not found: t_missing');
  });

  test('checkout claims a ready task; a second claim conflicts with exit 1', async () => {
    const id = await seedTask('claim me');
    const first = await cli(repo, 'checkout', id, '--worker', 'w1');
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('in_progress');

    const second = await cli(repo, 'checkout', id, '--worker', 'w2');
    expect(second.code).toBe(1);
    expect(second.stderr).toContain('not claimable');
  });

  test('done marks a task done; unknown id fails with exit 1', async () => {
    const id = await seedTask('finish me');
    const ok = await cli(repo, 'done', id);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('marked done');

    const bad = await cli(repo, 'done', 't_missing');
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('Task not found: t_missing');
  });
});

describe('subdirectory resolution (carried-over fix)', () => {
  test('invocation from a repo subdirectory hits the repo-root shared DB', async () => {
    const sub = join(repo, 'src', 'deep');
    await mkdir(sub, { recursive: true });

    const created = await cli(sub, 'create', '--title', 'from a subdir');
    expect(created.code).toBe(0);

    // The task must be visible from the repo root — same shared DB, no stray file.
    const listed = await cli(repo, 'list');
    expect(listed.stdout).toContain('from a subdir');

    // And the DB must live at the repo root, not under src/deep.
    const db = openDb({ path: resolveDbPath(repo) });
    const rootCount = (db.query('SELECT count(*) AS n FROM tasks').get() as { n: number }).n;
    db.close();
    expect(rootCount).toBe(1);

    const stray = Bun.file(join(sub, '.genie', 'genie.db'));
    expect(await stray.exists()).toBe(false);
  });
});

describe('task export round-trip', () => {
  test('emits complete state across all 6 tables as JSON', async () => {
    // Seed every table through the state module (the contract), then export.
    const db = openDb({ cwd: repo });
    const board = createBoard(db, 'main-board');
    const a = createTask(db, { title: 'root', boardId: board.id, wish: 'demo', group: 'g1' });
    const b = createTask(db, { title: 'dependent', dependsOn: [a.id] }); // → task_dependencies
    appendStage(db, a.id, 'planned', 'kickoff'); // → stage_log
    createWishGroups(db, 'demo', [{ name: 'g1' }, { name: 'g2', dependsOn: ['g1'] }]); // → wish_groups + meta
    db.close();

    const r = await cli(repo, 'export');
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');

    const state = JSON.parse(r.stdout) as StateExport;
    // All 6 tables represented.
    expect(state.schemaVersion).toBe(1);
    expect(state.boards.map((x) => x.name)).toContain('main-board');
    expect(state.tasks.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(state.task_dependencies).toEqual([{ task_id: b.id, depends_on_id: a.id }]);
    expect(state.stage_log.map((x) => x.stage)).toContain('planned');
    expect(state.wish_groups.map((x) => x.name).sort()).toEqual(['g1', 'g2']);
    expect(state.meta.some((m) => m.key === 'wish_sig:demo')).toBe(true);

    // The wish/group columns survive the round-trip on the seeded task.
    const rootRow = state.tasks.find((x) => x.id === a.id);
    expect(rootRow?.wish).toBe('demo');
    expect(rootRow?.group_name).toBe('g1');
  });
});
