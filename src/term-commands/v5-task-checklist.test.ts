import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/v5/genie-db.js';
import { DEFAULT_LIFECYCLE_LANES, createBoard, createTask } from '../lib/v5/task-state.js';

const GENIE = join(import.meta.dir, '..', 'genie.ts');

let repo: string;

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function cli(cwd: string, ...args: string[]): Promise<CliResult> {
  const proc = Bun.spawn(['bun', GENIE, 'task', ...args], {
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

/** A card to hang a definition-of-done checklist on. */
async function newCard(): Promise<string> {
  const created = await cli(repo, 'create', '--title', 'checklist card');
  expect(created.code).toBe(0);
  const id = created.stdout.match(/Created task (t_\w+)/)?.[1];
  expect(id).toBeTruthy();
  return id as string;
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'genie-checklist-'));
  execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('task checklist', () => {
  test('appends numbered items in declaration order', async () => {
    const id = await newCard();
    expect((await cli(repo, 'checklist-add', id, 'tests pass')).stdout).toContain('Added checklist item 1');
    expect((await cli(repo, 'checklist-add', id, 'readme updated')).stdout).toContain('Added checklist item 2');

    const list = await cli(repo, 'checklist', id);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain('(0/2 done)');
    expect(list.stdout).toContain('1. [open] tests pass');
    expect(list.stdout).toContain('2. [open] readme updated');
  });

  test('checking records who ticked it and the evidence they gave', async () => {
    const id = await newCard();
    await cli(repo, 'checklist-add', id, 'tests pass');

    const checked = await cli(
      repo,
      'checklist-check',
      id,
      '1',
      '--evidence',
      'node --test: 45/45',
      '--worker',
      'verifier',
    );
    expect(checked.code).toBe(0);
    expect(checked.stdout).toContain('Checked item 1');

    const list = await cli(repo, 'checklist', id);
    expect(list.stdout).toContain('(1/1 done)');
    expect(list.stdout).toContain('[done] tests pass [verifier] — node --test: 45/45');
  });

  test('reopening clears the tick and its evidence', async () => {
    const id = await newCard();
    await cli(repo, 'checklist-add', id, 'tests pass');
    await cli(repo, 'checklist-check', id, '1', '--evidence', 'node --test: 45/45', '--worker', 'verifier');

    const reopened = await cli(repo, 'checklist-uncheck', id, '1', '--worker', 'captain');
    expect(reopened.code).toBe(0);

    const list = await cli(repo, 'checklist', id);
    expect(list.stdout).toContain('(0/1 done)');
    expect(list.stdout).toContain('1. [open] tests pass');
    // The row is current state; the evidence survives in the timeline, not here.
    expect(list.stdout).not.toContain('45/45');
  });

  test('rejects an unknown position and a non-numeric position', async () => {
    const id = await newCard();
    await cli(repo, 'checklist-add', id, 'only item');

    const missing = await cli(repo, 'checklist-check', id, '9');
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain(`Task ${id} has no checklist item 9.`);

    const bad = await cli(repo, 'checklist-check', id, 'abc');
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('positive integer');
  });

  test('every transition is attributed in the card timeline', async () => {
    const id = await newCard();
    await cli(repo, 'checklist-add', id, 'item one', '--worker', 'builder');
    await cli(repo, 'checklist-check', id, '1', '--worker', 'verifier');
    await cli(repo, 'checklist-uncheck', id, '1', '--worker', 'captain');

    const status = await cli(repo, 'status', id);
    expect(status.stdout).toContain('checklist_add by builder');
    expect(status.stdout).toContain('checklist_check by verifier');
    expect(status.stdout).toContain('checklist_uncheck by captain');
  });

  test('an empty checklist reports plainly instead of failing', async () => {
    const id = await newCard();
    const list = await cli(repo, 'checklist', id);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(`No checklist items on ${id}.`);
  });
});

describe('the board aggregate carries the checklist', () => {
  /** Run any genie command (the helper above is `task`-scoped). */
  async function genie(...args: string[]): Promise<CliResult> {
    const proc = Bun.spawn(['bun', GENIE, ...args], {
      cwd: repo,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1', GENIE_TEST_SKIP_PGSERVE: '1' },
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return { stdout, stderr, code };
  }

  /** A lane-defining board is what selects the schemaVersion 1 aggregate path. */
  async function laneDefiningBoardWithCard(): Promise<{ taskId: string }> {
    const db = openDb({ cwd: repo });
    const board = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    const task = createTask(db, { title: 'aggregate card', boardId: board.id, lane: 'Idea' });
    db.close();
    return { taskId: task.id };
  }

  test('checklists ride the envelope as a sibling key, and the card stays frozen', async () => {
    const { taskId } = await laneDefiningBoardWithCard();
    await cli(repo, 'checklist-add', taskId, 'tests pass', '--worker', 'builder');
    await cli(repo, 'checklist-check', taskId, '1', '--evidence', '45/45', '--worker', 'verifier');

    const r = await genie('board', '--board', 'roadmap', '--json');
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    const aggregate = JSON.parse(r.stdout);

    // The envelope contract is unchanged where it is frozen...
    expect(aggregate.schemaVersion).toBe(1);
    // ...and additive where it is allowed to grow.
    expect(aggregate.checklists[taskId]).toEqual([
      { position: 1, text: 'tests pass', done: true, checkedBy: 'verifier', evidence: '45/45' },
    ]);

    const cards = (aggregate.lanes as Array<{ cards: Array<Record<string, unknown>> }>).flatMap((lane) => lane.cards);
    const card = cards.find((c) => c.id === taskId);
    expect(card).toBeTruthy();
    expect(card && 'checklists' in card).toBe(false);
    expect(card && 'checklist' in card).toBe(false);
  });

  test('a board with no checklist items adds only an empty map', async () => {
    const { taskId } = await laneDefiningBoardWithCard();
    const r = await genie('board', '--board', 'roadmap', '--json');
    expect(r.code).toBe(0);
    const aggregate = JSON.parse(r.stdout);
    expect(aggregate.schemaVersion).toBe(1);
    expect(aggregate.checklists).toEqual({});
    const cards = (aggregate.lanes as Array<{ cards: Array<Record<string, unknown>> }>).flatMap((lane) => lane.cards);
    expect(cards.map((c) => c.id)).toContain(taskId);
  });
});
