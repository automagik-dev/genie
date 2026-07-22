/**
 * genie idea — CLI-level tests. Invokes the real `genie.ts` entry as a user
 * would (subprocess), against a throwaway git-repo fixture, asserting exit code
 * AND stderr. `idea` is one-verb capture into the roadmap board's Idea lane,
 * creating the board (with the 6 lifecycle lanes) if absent.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/v5/genie-db.js';
import { getBoardByName, getTaskLane, listBoards, listTasks } from '../lib/v5/task-state.js';

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
  const proc = Bun.spawn(['bun', GENIE, ...args], {
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
  repo = mkdtempSync(join(tmpdir(), 'genie-idea-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'commit', '--allow-empty', '-m', 'init');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('genie idea', () => {
  test('on a fresh repo, creates the roadmap board and a card in the Idea lane', async () => {
    const r = await cli(repo, 'idea', 'try building a widget');
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('roadmap/Idea');

    const db = openDb({ cwd: repo });
    const board = getBoardByName(db, 'roadmap');
    expect(board?.lanes?.map((l) => l.name)).toEqual(['Idea', 'Brainstorm', 'Wish', 'Work', 'Review', 'Done']);
    const tasks = listTasks(db, { boardId: board?.id });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('try building a widget');
    expect(getTaskLane(db, tasks[0].id)).toBe('Idea');
    db.close();
  });

  test('joins multi-word idea text into a single title', async () => {
    const r = await cli(repo, 'idea', 'add', 'dark', 'mode');
    expect(r.code).toBe(0);
    const db = openDb({ cwd: repo });
    const tasks = listTasks(db, {});
    db.close();
    expect(tasks[0].title).toBe('add dark mode');
  });

  test('a second idea reuses the roadmap board (no duplicate-board failure)', async () => {
    const first = await cli(repo, 'idea', 'first');
    expect(first.code).toBe(0);
    const second = await cli(repo, 'idea', 'second');
    expect(second.code).toBe(0);
    expect(second.stderr).toBe('');

    const db = openDb({ cwd: repo });
    expect(listBoards(db)).toHaveLength(1); // one roadmap board, reused
    const tasks = listTasks(db, {});
    db.close();
    expect(tasks.map((t) => t.title).sort()).toEqual(['first', 'second']);
  });

  test('the captured card is visible in the roadmap Idea lane render', async () => {
    await cli(repo, 'idea', 'ship it');
    const r = await cli(repo, 'board', '--board', 'roadmap');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Idea → /brainstorm (1 card)');
    expect(r.stdout).toContain('ship it');
  });

  test('empty idea text fails with exit 1', async () => {
    const r = await cli(repo, 'idea', '   ');
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('idea text is required');
  });
});
