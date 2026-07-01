/**
 * genie v5 board — CLI-level tests. The board is derived purely by query with
 * NO stored view state, so these assert that status transitions are reflected
 * on the next render with nothing persisted. Exit codes AND stderr are checked.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/v5/genie-db.js';
import { claimTask, completeTask, createBoard, createTask } from '../lib/v5/task-state.js';

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

async function board(cwd: string, ...args: string[]): Promise<CliResult> {
  const proc = Bun.spawn(['bun', GENIE, 'v5', 'board', ...args], {
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
  repo = mkdtempSync(join(tmpdir(), 'genie-v5-board-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'commit', '--allow-empty', '-m', 'init');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('board render', () => {
  test('renders all four status columns on an empty repo', async () => {
    const r = await board(repo);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    for (const label of ['Blocked', 'Ready', 'In Progress', 'Done']) {
      expect(r.stdout).toContain(label);
    }
    // Counts line reflects an empty board.
    expect(r.stdout).toContain('Blocked: 0');
    expect(r.stdout).toContain('Ready: 0');
  });

  test('places a fresh task in the Ready column', async () => {
    const db = openDb({ cwd: repo });
    createTask(db, { title: 'do the thing' });
    db.close();

    const r = await board(repo);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Ready: 1');
    expect(r.stdout).toContain('do the thing');
  });

  test('reflects status changes with no stored view state', async () => {
    const db = openDb({ cwd: repo });
    const t = createTask(db, { title: 'moving task' });

    // Ready → in_progress via claim.
    claimTask(db, t.id, 'w1');
    db.close();
    let r = await board(repo);
    expect(r.stdout).toContain('In Progress: 1');
    expect(r.stdout).toContain('Ready: 0');
    expect(r.stdout).toContain('@w1');

    // in_progress → done via complete. Same board command, no persisted view.
    const db2 = openDb({ cwd: repo });
    completeTask(db2, t.id);
    db2.close();
    r = await board(repo);
    expect(r.stdout).toContain('Done: 1');
    expect(r.stdout).toContain('In Progress: 0');
  });

  test('--json emits columns keyed by status', async () => {
    const db = openDb({ cwd: repo });
    createTask(db, { title: 'ready-1' });
    db.close();

    const r = await board(repo, '--json');
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      scope: string;
      columns: Record<string, Array<{ title: string }>>;
    };
    expect(payload.columns.ready).toHaveLength(1);
    expect(payload.columns.ready[0].title).toBe('ready-1');
    expect(payload.columns.blocked).toHaveLength(0);
  });
});

describe('board scoping', () => {
  test('--board filters to one board and reports its name in scope', async () => {
    const db = openDb({ cwd: repo });
    const b1 = createBoard(db, 'alpha');
    createBoard(db, 'beta');
    createTask(db, { title: 'alpha-task', boardId: b1.id });
    createTask(db, { title: 'loose-task' });
    db.close();

    const r = await board(repo, '--board', 'alpha');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('board "alpha"');
    expect(r.stdout).toContain('alpha-task');
    expect(r.stdout).not.toContain('loose-task');
  });

  test('--board with an unknown reference fails with exit 1 and clear stderr', async () => {
    const r = await board(repo, '--board', 'ghost');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Board not found: ghost');
  });
});
