/**
 * genie board — CLI-level tests. The board is derived purely by query with
 * NO stored view state, so these assert that status transitions are reflected
 * on the next render with nothing persisted. Exit codes AND stderr are checked.
 */

import type { Database, SQLQueryBindings } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/v5/genie-db.js';
import {
  DEFAULT_LIFECYCLE_LANES,
  LIVENESS_RUNNING_MS,
  LIVENESS_STALE_MS,
  addDependency,
  appendTaskEvent,
  blockTask,
  claimTask,
  completeTask,
  createBoard,
  createTask,
  getTaskEvents,
  getTaskLane,
  moveTask,
  readBoardTaskSnapshot,
  recordHeartbeat,
} from '../lib/v5/task-state.js';

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

async function boardWithEnv(cwd: string, env: Record<string, string>, ...args: string[]): Promise<CliResult> {
  const proc = Bun.spawn(['bun', GENIE, 'board', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1', GENIE_TEST_SKIP_PGSERVE: '1', ...env },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { stdout, stderr, code };
}

async function board(cwd: string, ...args: string[]): Promise<CliResult> {
  return boardWithEnv(cwd, {}, ...args);
}

function expectMalformedBoard(result: CliResult): void {
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toMatch(/^Error: Malformed board detail: [^\n]+\n$/);
  expect(result.stderr.length).toBeLessThan(240);
}

async function manualTask(cwd: string, ...args: string[]): Promise<CliResult> {
  const proc = Bun.spawn(['bun', GENIE, 'task', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      NO_COLOR: '1',
      GENIE_TEST_SKIP_PGSERVE: '1',
      GENIE_AGENT_NAME: 'manual-operator',
      GENIE_AGENT_KIND: 'human',
    },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { stdout, stderr, code };
}

function writeWish(slug: string, status: string): void {
  const dir = join(repo, '.genie', 'wishes', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'WISH.md'), `# Wish: ${slug}\n\n| Field | Value |\n|---|---|\n| **Status** | ${status} |\n`);
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
  test('renders the three laneless columns on an empty repo (blocked is a badge, never a column)', async () => {
    const r = await board(repo);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    for (const label of ['Ready', 'In Progress', 'Done']) {
      expect(r.stdout).toContain(label);
    }
    // Blocked is never a column header on the human render.
    expect(r.stdout).not.toContain('── Blocked');
    // Counts line reflects an empty board.
    expect(r.stdout).toContain('Ready: 0');
    expect(r.stdout).toContain('Done: 0');
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
    // The claimed_by fence requires the claimant's identity — pass w1 (the checkout above).
    const db2 = openDb({ cwd: repo });
    completeTask(db2, t.id, { author: 'w1', authorKind: 'human' });
    db2.close();
    r = await board(repo);
    expect(r.stdout).toContain('Done: 1');
    expect(r.stdout).toContain('In Progress: 0');
  });

  test('--json emits columns keyed by status', async () => {
    const db = openDb({ cwd: repo });
    const task = createTask(db, { title: 'ready-1' });
    db.close();

    const r = await board(repo, '--json');
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    const expected = {
      scope: 'all tasks',
      columns: {
        blocked: [],
        ready: [
          {
            id: task.id,
            boardId: null,
            title: 'ready-1',
            status: 'ready',
            claimedBy: null,
            claimedAt: null,
            wish: null,
            group: null,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
          },
        ],
        in_progress: [],
        done: [],
      },
    };
    expect(r.stdout).toBe(`${JSON.stringify(expected, null, 2)}\n`);
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

describe('board create', () => {
  test('defaults to the 6 lifecycle lanes', async () => {
    const r = await board(repo, 'create', 'roadmap');
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('6 lanes');
    expect(r.stdout).toContain('Idea, Brainstorm, Wish, Work, Review, Done');

    const db = openDb({ cwd: repo });
    const row = db.query('SELECT lanes FROM boards WHERE name = ?').get('roadmap') as { lanes: string };
    db.close();
    expect(JSON.parse(row.lanes).map((l: { name: string }) => l.name)).toEqual([
      'Idea',
      'Brainstorm',
      'Wish',
      'Work',
      'Review',
      'Done',
    ]);
  });

  test('--lanes "A,B,C" creates name-only lanes', async () => {
    const r = await board(repo, 'create', 'custom', '--lanes', 'A, B ,C');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('3 lanes');
    expect(r.stdout).toContain('A, B, C');
  });

  test('a duplicate board name fails with exit 1 and a clean message', async () => {
    const first = await board(repo, 'create', 'dup');
    expect(first.code).toBe(0);
    const second = await board(repo, 'create', 'dup');
    expect(second.code).toBe(1);
    expect(second.stdout).toBe('');
    expect(second.stderr).toContain('already exists');
  });
});

describe('board list', () => {
  test('reports lane count and card count per board', async () => {
    const db = openDb({ cwd: repo });
    const road = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    const plain = createBoard(db, 'plain');
    createTask(db, { title: 'c1', boardId: road.id });
    db.query('UPDATE boards SET created_at = 10 WHERE id = ?').run(road.id);
    db.query('UPDATE boards SET created_at = 20 WHERE id = ?').run(plain.id);
    db.close();

    const r = await board(repo, 'list');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('roadmap');
    expect(r.stdout).toContain('plain');
    expect(r.stdout).toContain('2 boards');

    const j = await board(repo, 'list', '--json');
    expect(j.code).toBe(0);
    expect(j.stderr).toBe('');
    expect(j.stdout).toBe(
      `${JSON.stringify(
        [
          { id: road.id, name: 'roadmap', laneCount: 6, cardCount: 1 },
          { id: plain.id, name: 'plain', laneCount: 0, cardCount: 0 },
        ],
        null,
        2,
      )}\n`,
    );
  });

  test('reports "No boards found." on an empty repo', async () => {
    const r = await board(repo, 'list');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('No boards found.');
  });
});

describe('lane-grouped render', () => {
  test('keeps the human empty-lane output byte-exact', async () => {
    const db = openDb({ cwd: repo });
    createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    db.close();

    const result = await board(repo, '--board', 'roadmap');
    expect(result).toEqual({
      code: 0,
      stderr: '',
      stdout: [
        '',
        'Board — board "roadmap"',
        '═'.repeat(56),
        '  Idea: 0   Brainstorm: 0   Wish: 0   Work: 0   Review: 0   Done: 0',
        '',
        '── Idea → /brainstorm (0 cards) ──',
        '  (empty)',
        '',
        '── Brainstorm → /wish (0 cards) ──',
        '  (empty)',
        '',
        '── Wish → /work (0 cards) ──',
        '  (empty)',
        '',
        '── Work → /review (0 cards) ──',
        '  (empty)',
        '',
        '── Review (0 cards) ──',
        '  (empty)',
        '',
        '── Done (0 cards) ──',
        '  (empty)',
        '',
        '',
      ].join('\n'),
    });
  });

  test('groups by lane and prints action hints; a moved card lands in its lane', async () => {
    const db = openDb({ cwd: repo });
    const road = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    const t = createTask(db, { title: 'lane card', boardId: road.id, lane: 'Idea' });
    moveTask(db, t.id, 'Brainstorm', { author: 'felipe', authorKind: 'human' });
    db.close();

    const r = await board(repo, '--board', 'roadmap');
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    // Lane-header action hints render (substring, not eyeball).
    expect(r.stdout).toContain('Idea → /brainstorm');
    expect(r.stdout).toContain('Brainstorm → /wish');
    expect(r.stdout).toContain('Wish → /work');
    expect(r.stdout).toContain('Work → /review');
    // Review/Done carry no advancing action → no arrow hint on their headers.
    expect(r.stdout).toMatch(/── Review \(\d+ cards?\) ──/);
    expect(r.stdout).toMatch(/── Done \(\d+ cards?\) ──/);
    // The card moved into Brainstorm; that lane header reports one card.
    expect(r.stdout).toContain('Brainstorm → /wish (1 card)');
    expect(r.stdout).toContain('lane card');
  });

  test('a NULL-lane card lands in the first lane (Idea)', async () => {
    const db = openDb({ cwd: repo });
    const road = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    createTask(db, { title: 'unplaced card', boardId: road.id }); // lane NULL
    db.close();

    const r = await board(repo, '--board', 'roadmap');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Idea → /brainstorm (1 card)');
  });

  test('--json for a lane board groups additively by lane', async () => {
    const db = openDb({ cwd: repo });
    const road = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    createTask(db, { title: 'idea card', boardId: road.id, lane: 'Idea' });
    db.close();

    const r = await board(repo, '--board', 'roadmap', '--json');
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      scope: string;
      lanes: Array<{ name: string; action: string | null; cards: Array<{ title: string; lane: string | null }> }>;
    };
    const idea = payload.lanes.find((l) => l.name === 'Idea');
    expect(idea?.action).toBe('/brainstorm');
    expect(idea?.cards[0].title).toBe('idea card');
    expect(payload.lanes.map((l) => l.name)).toEqual(['Idea', 'Brainstorm', 'Wish', 'Work', 'Review', 'Done']);
  });

  test('--json carries the complete exact card aggregate and explicit nullability', async () => {
    const db = openDb({ cwd: repo });
    const road = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    createTask(db, { title: 'open card', boardId: road.id, lane: 'Idea' });
    const held = createTask(db, { title: 'held card', boardId: road.id, lane: 'Idea' });
    const broken = createTask(db, { title: 'broken card', boardId: road.id, lane: 'Idea' });
    createTask(db, {
      title: 'assigned card',
      boardId: road.id,
      lane: 'Idea',
      assignedAgent: 'codex',
      assignedReason: 'declared routing',
    });
    blockTask(db, held.id, 'parked until Q3', { author: 'felipe', authorKind: 'human' }, 'hold');
    blockTask(db, broken.id, 'awaiting a decision', { author: 'felipe', authorKind: 'human' });
    recordHeartbeat(db, held.id);
    db.close();

    const r = await board(repo, '--board', 'roadmap', '--json');
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      lanes: Array<{ name: string; cards: Array<Record<string, unknown>> }>;
    };
    const cards = new Map(
      (payload.lanes.find((l) => l.name === 'Idea')?.cards ?? []).map((c) => [c.title as string, c]),
    );
    expect(cards.get('open card')?.enforcedBlock).toBeNull();
    expect(cards.get('held card')?.enforcedBlock).toEqual({ reason: 'parked until Q3', kind: 'hold' });
    expect(cards.get('broken card')?.enforcedBlock).toEqual({ reason: 'awaiting a decision', kind: 'work' });

    // Null semantics: every lane card carries the assignment keys; unassigned
    // cards read null, assigned cards carry the declared roster agent + reason.
    expect(cards.get('open card')?.assignedAgent).toBeNull();
    expect(cards.get('open card')?.assignedReason).toBeNull();
    expect(cards.get('assigned card')?.assignedAgent).toBe('codex');
    expect(cards.get('assigned card')?.assignedReason).toBe('declared routing');

    expect(cards.get('open card')).toMatchObject({
      claimedBy: null,
      claimedAt: null,
      wish: null,
      group: null,
      lane: 'Idea',
      agentKind: null,
      heartbeatAt: null,
      liveness: null,
      blockedBy: null,
      blockedReason: null,
      enforcedBlock: null,
      dependencies: [],
      timeline: [],
      comments: [],
    });
    expect(cards.get('held card')).toMatchObject({
      blockedBy: 'felipe',
      blockedReason: 'parked until Q3',
      enforcedBlock: { reason: 'parked until Q3', kind: 'hold' },
      liveness: null,
    });
    expect(Object.keys(cards.get('held card') as Record<string, unknown>).sort()).toEqual([
      'agentKind',
      'assignedAgent',
      'assignedReason',
      'blockedBy',
      'blockedReason',
      'boardId',
      'claimedAt',
      'claimedBy',
      'comments',
      'createdAt',
      'dependencies',
      'enforcedBlock',
      'group',
      'heartbeatAt',
      'id',
      'lane',
      'liveness',
      'status',
      'timeline',
      'title',
      'updatedAt',
      'wish',
    ]);
  });
});

describe('scoped board JSON aggregate v1', () => {
  test('freezes the exact outer shape and returns every lane for an empty board', async () => {
    const db = openDb({ cwd: repo });
    createBoard(db, 'empty', DEFAULT_LIFECYCLE_LANES);
    db.close();

    const result = await board(repo, '--board', 'empty', '--json');
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const payload = JSON.parse(result.stdout) as Record<string, unknown> & {
      lanes: Array<{ name: string; label: string | null; action: string | null; cards: unknown[] }>;
    };
    expect(Object.keys(payload)).toEqual(['schemaVersion', 'scope', 'lanes']);
    expect(payload.schemaVersion).toBe(1);
    expect(payload.scope).toBe('board "empty"');
    expect(payload.lanes.map((lane) => lane.name)).toEqual(['Idea', 'Brainstorm', 'Wish', 'Work', 'Review', 'Done']);
    for (const lane of payload.lanes) {
      expect(Object.keys(lane)).toEqual(['name', 'label', 'action', 'cards']);
      expect(lane.cards).toEqual([]);
    }
  });

  test('orders cards, dependencies, timeline, and comment projection deterministically', async () => {
    const db = openDb({ cwd: repo });
    const roadmap = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    const depZ = createTask(db, { title: 'dependency z', boardId: roadmap.id, lane: 'Idea' });
    const depA = createTask(db, { title: 'dependency a', boardId: roadmap.id, lane: 'Idea' });
    const cardB = createTask(db, { title: 'card b', boardId: roadmap.id, lane: 'Work' });
    const cardA = createTask(db, { title: 'card a', boardId: roadmap.id, lane: 'Work' });
    // Equal timestamps deliberately oppose lexical id order: existing board
    // readers preserve insertion order, so z-card must remain before a-card.
    db.query('UPDATE tasks SET id = ? WHERE id = ?').run('z-dependency', depZ.id);
    db.query('UPDATE tasks SET id = ? WHERE id = ?').run('a-dependency', depA.id);
    db.query('UPDATE tasks SET id = ?, created_at = 10 WHERE id = ?').run('z-card', cardB.id);
    db.query('UPDATE tasks SET id = ?, created_at = 10 WHERE id = ?').run('a-card', cardA.id);
    // This access path sorts equal timestamps by id unless the aggregate
    // explicitly requests its insertion-order tie-break.
    db.run('CREATE INDEX test_board_created_id ON tasks(board_id, created_at, id)');
    addDependency(db, 'a-card', 'z-dependency');
    addDependency(db, 'a-card', 'a-dependency');
    // Insert same-time ids in descending order. Timeline and its comment
    // projection must sort by createdAt then id, independently of insertion.
    db.query(
      `INSERT INTO task_events (id, task_id, kind, note, author_kind, author, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(90, 'a-card', 'comment', 'second comment', 'human', 'felipe', 20);
    db.query(
      `INSERT INTO task_events (id, task_id, kind, note, author_kind, author, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(40, 'a-card', 'move', 'Idea→Work', null, null, 20);
    db.query(
      `INSERT INTO task_events (id, task_id, kind, note, author_kind, author, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(10, 'a-card', 'comment', 'first comment', null, null, 20);
    db.close();

    const result = await board(repo, '--board', 'roadmap', '--json');
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const payload = JSON.parse(result.stdout) as {
      lanes: Array<{
        name: string;
        cards: Array<
          Record<string, unknown> & {
            id: string;
            dependencies: Array<{ id: string; title: string; status: string }>;
            timeline: Array<{ id: number; kind: string; note: string | null; createdAt: number }>;
            comments: Array<{
              id: number;
              note: string;
              authorKind: string | null;
              author: string | null;
              createdAt: number;
            }>;
          }
        >;
      }>;
    };
    const work = payload.lanes.find((lane) => lane.name === 'Work');
    expect(work?.cards.map((card) => card.id)).toEqual(['z-card', 'a-card']);
    const card = work?.cards.find((candidate) => candidate.id === 'a-card');
    expect(card).toBeDefined();
    if (!card) throw new Error('expected card a in Work lane');
    expect(card.dependencies.map((dependency) => dependency.id)).toEqual(['a-dependency', 'z-dependency']);
    for (const dependency of card.dependencies) {
      expect(Object.keys(dependency)).toEqual(['id', 'title', 'status']);
    }
    expect(card.timeline.map((event) => event.id)).toEqual([10, 40, 90]);
    for (const event of card.timeline) {
      expect(Object.keys(event)).toEqual(['id', 'kind', 'note', 'authorKind', 'author', 'createdAt']);
    }
    expect(card.comments).toEqual([
      { id: 10, note: 'first comment', authorKind: null, author: null, createdAt: 20 },
      {
        id: 90,
        note: 'second comment',
        authorKind: 'human',
        author: 'felipe',
        createdAt: 20,
      },
    ]);
  });

  test('derives running, idle, stale, missing-heartbeat, and unclaimed liveness exactly', async () => {
    const db = openDb({ cwd: repo });
    const roadmap = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    const now = Date.now();
    const running = createTask(db, { title: 'running', boardId: roadmap.id, lane: 'Work' });
    const idle = createTask(db, { title: 'idle', boardId: roadmap.id, lane: 'Work' });
    const stale = createTask(db, { title: 'stale', boardId: roadmap.id, lane: 'Work' });
    const missing = createTask(db, { title: 'missing heartbeat', boardId: roadmap.id, lane: 'Work' });
    const open = createTask(db, { title: 'open with heartbeat', boardId: roadmap.id, lane: 'Work' });
    for (const task of [running, idle, stale, missing]) claimTask(db, task.id, 'worker');
    recordHeartbeat(db, running.id, now);
    recordHeartbeat(db, idle.id, now - LIVENESS_RUNNING_MS - 60_000);
    recordHeartbeat(db, stale.id, now - LIVENESS_STALE_MS - 60_000);
    recordHeartbeat(db, open.id, now);
    db.close();

    const result = await board(repo, '--board', 'roadmap', '--json');
    const cards = (
      JSON.parse(result.stdout) as { lanes: Array<{ cards: Array<Record<string, unknown>> }> }
    ).lanes.flatMap((lane) => lane.cards);
    expect(cards.find((card) => card.id === running.id)?.liveness).toBe('running');
    expect(cards.find((card) => card.id === idle.id)?.liveness).toBe('idle');
    expect(cards.find((card) => card.id === stale.id)?.liveness).toBe('stale');
    expect(cards.find((card) => card.id === missing.id)?.liveness).toBe('stale');
    expect(cards.find((card) => card.id === open.id)?.liveness).toBeNull();
  });

  test('is byte-idempotent after the complete snapshot has been established', async () => {
    const db = openDb({ cwd: repo });
    const roadmap = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    createTask(db, { title: 'stable', boardId: roadmap.id, lane: 'Idea' });
    db.close();

    const first = await board(repo, '--board', 'roadmap', '--json');
    const second = await board(repo, '--board', 'roadmap', '--json');
    expect(first).toEqual({ code: 0, stderr: '', stdout: second.stdout });
    expect(second.code).toBe(0);
    expect(second.stderr).toBe('');
  });

  const corruptions: Array<{
    name: string;
    corrupt: (db: Database, boardId: string, taskId: string) => void;
  }> = [
    {
      name: 'card title scalar',
      corrupt: (db, _boardId, taskId) => db.query("UPDATE tasks SET title = X'01' WHERE id = ?").run(taskId),
    },
    {
      name: 'card status enum',
      corrupt: (db, _boardId, taskId) => {
        db.exec('PRAGMA ignore_check_constraints = ON');
        db.query("UPDATE tasks SET status = 'unknown' WHERE id = ?").run(taskId);
      },
    },
    {
      name: 'nullable card claimant scalar',
      corrupt: (db, _boardId, taskId) => db.query("UPDATE tasks SET claimed_by = X'01' WHERE id = ?").run(taskId),
    },
    {
      name: 'dependency title scalar',
      corrupt: (db, _boardId, taskId) => {
        const dependency = createTask(db, { title: 'outside dependency' });
        addDependency(db, taskId, dependency.id);
        db.query("UPDATE tasks SET title = X'01' WHERE id = ?").run(dependency.id);
      },
    },
    {
      name: 'dependency status enum',
      corrupt: (db, _boardId, taskId) => {
        const dependency = createTask(db, { title: 'outside dependency' });
        addDependency(db, taskId, dependency.id);
        db.exec('PRAGMA ignore_check_constraints = ON');
        db.query("UPDATE tasks SET status = 'unknown' WHERE id = ?").run(dependency.id);
      },
    },
    {
      name: 'orphan dependency',
      corrupt: (db, _boardId, taskId) => {
        db.exec('PRAGMA foreign_keys = OFF');
        db.query('INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)').run(taskId, 'missing-task');
      },
    },
    {
      name: 'timeline kind scalar',
      corrupt: (db, _boardId, taskId) => {
        const event = appendTaskEvent(db, taskId, { kind: 'move' });
        db.query("UPDATE task_events SET kind = X'01' WHERE id = ?").run(event.id);
      },
    },
    {
      name: 'nullable timeline author scalar',
      corrupt: (db, _boardId, taskId) => {
        const event = appendTaskEvent(db, taskId, { kind: 'move' });
        db.query("UPDATE task_events SET author = X'01' WHERE id = ?").run(event.id);
      },
    },
    {
      name: 'timeline timestamp scalar',
      corrupt: (db, _boardId, taskId) => {
        const event = appendTaskEvent(db, taskId, { kind: 'move' });
        db.query("UPDATE task_events SET created_at = X'01' WHERE id = ?").run(event.id);
      },
    },
    {
      name: 'null comment text',
      corrupt: (db, _boardId, taskId) => {
        appendTaskEvent(db, taskId, { kind: 'comment' });
      },
    },
  ];

  for (const fixture of corruptions) {
    test(`fails closed for malformed ${fixture.name}`, async () => {
      const db = openDb({ cwd: repo });
      const roadmap = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
      const task = createTask(db, { title: 'corrupt target', boardId: roadmap.id, lane: 'Idea' });
      fixture.corrupt(db, roadmap.id, task.id);
      db.close();

      expectMalformedBoard(await board(repo, '--board', 'roadmap', '--json'));
    });
  }

  const malformedLanes = [
    ['invalid JSON', '{'],
    ['non-array JSON', '{}'],
    ['non-object entry', '[null]'],
    ['missing name', '[{}]'],
    ['wrong name', '[{"name":7}]'],
    ['wrong label', '[{"name":"Idea","label":7}]'],
    ['null label', '[{"name":"Idea","label":null}]'],
    ['wrong action', '[{"name":"Idea","action":7}]'],
    ['null action', '[{"name":"Idea","action":null}]'],
  ] as const;

  for (const [name, lanes] of malformedLanes) {
    test(`fails closed for ${name} lane metadata`, async () => {
      const db = openDb({ cwd: repo });
      const roadmap = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
      db.query('UPDATE boards SET lanes = ? WHERE id = ?').run(lanes, roadmap.id);
      db.close();

      expectMalformedBoard(await board(repo, '--board', 'roadmap', '--json'));
    });
  }

  test('an unknown board JSON read fails with exit 1, empty stdout, and clear stderr', async () => {
    const result = await board(repo, '--board', 'ghost', '--json');
    expect(result).toEqual({ stdout: '', stderr: 'Error: Board not found: ghost\n', code: 1 });
  });
});

describe('board aggregate repository snapshot', () => {
  function instrumentReader(
    reader: Database,
    afterFirstSetRead?: () => void,
  ): {
    counts: { queries: number; transactions: number; deferred: number; outsideTransaction: number };
  } {
    const counts = { queries: 0, transactions: 0, deferred: 0, outsideTransaction: 0 };
    const originalQuery = reader.query.bind(reader);
    const originalTransaction = reader.transaction.bind(reader);

    Object.defineProperty(reader, 'query', {
      configurable: true,
      value: (sql: string) => {
        counts.queries += 1;
        if (!reader.inTransaction) counts.outsideTransaction += 1;
        const queryNumber = counts.queries;
        const statement = originalQuery(sql);
        return new Proxy(statement, {
          get(target, property) {
            const value = Reflect.get(target, property, target);
            if (property === 'all') {
              return (...args: unknown[]) => {
                const rows = Reflect.apply(value as (...values: unknown[]) => unknown, target, args);
                if (queryNumber === 1) afterFirstSetRead?.();
                return rows;
              };
            }
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    });
    Object.defineProperty(reader, 'transaction', {
      configurable: true,
      value: (callback: () => unknown) => {
        counts.transactions += 1;
        const transaction = originalTransaction(callback);
        return {
          deferred: () => {
            counts.deferred += 1;
            return transaction.deferred();
          },
        };
      },
    });
    return { counts };
  }

  test('uses three constant set queries in one deferred transaction regardless of card count', () => {
    const writer = openDb({ cwd: repo });
    const roadmap = createBoard(writer, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    createTask(writer, { title: 'first', boardId: roadmap.id, lane: 'Idea' });
    const reader = openDb({ cwd: repo });
    const { counts } = instrumentReader(reader);

    expect(readBoardTaskSnapshot(reader, roadmap.id)).toHaveLength(1);
    expect(counts).toEqual({ queries: 3, transactions: 1, deferred: 1, outsideTransaction: 0 });

    for (let index = 0; index < 24; index += 1) {
      createTask(writer, { title: `card ${index}`, boardId: roadmap.id, lane: 'Idea' });
    }
    expect(readBoardTaskSnapshot(reader, roadmap.id)).toHaveLength(25);
    expect(counts).toEqual({ queries: 6, transactions: 2, deferred: 2, outsideTransaction: 0 });
    reader.close();
    writer.close();
  });

  test('retains one SQLite snapshot when a peer writes between set reads', () => {
    const writer = openDb({ cwd: repo });
    const roadmap = createBoard(writer, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    const dependency = createTask(writer, { title: 'before peer write' });
    const card = createTask(writer, { title: 'snapshot card', boardId: roadmap.id, lane: 'Work' });
    addDependency(writer, card.id, dependency.id);
    const reader = openDb({ cwd: repo });
    const { counts } = instrumentReader(reader, () => {
      writer.query('UPDATE tasks SET title = ? WHERE id = ?').run('after peer write', dependency.id);
      appendTaskEvent(writer, card.id, { kind: 'comment', note: 'after peer write' });
    });

    const [snapshot] = readBoardTaskSnapshot(reader, roadmap.id);
    expect(snapshot.dependencies).toEqual([{ id: dependency.id, title: 'before peer write', status: 'ready' }]);
    expect(snapshot.timeline).toEqual([]);
    expect(snapshot.comments).toEqual([]);
    expect(counts).toEqual({ queries: 3, transactions: 1, deferred: 1, outsideTransaction: 0 });
    expect(writer.query('SELECT title FROM tasks WHERE id = ?').get(dependency.id) as { title: string }).toEqual({
      title: 'after peer write',
    });
    expect(getTaskEvents(writer, card.id)).toHaveLength(1);
    reader.close();
    writer.close();
  });

  function captureDetailReads(
    reader: Database,
  ): Array<{ sql: string; bindings: SQLQueryBindings[]; plan: string[]; inTransaction: boolean }> {
    const reads: Array<{ sql: string; bindings: SQLQueryBindings[]; plan: string[]; inTransaction: boolean }> = [];
    const originalQuery = reader.query.bind(reader);
    Object.defineProperty(reader, 'query', {
      configurable: true,
      value: (sql: string) => {
        const statement = originalQuery(sql);
        return {
          all: (...bindings: SQLQueryBindings[]) => {
            if (sql.startsWith('SELECT')) {
              const plan = originalQuery(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings) as Array<{
                detail: string;
              }>;
              reads.push({ sql, bindings, plan: plan.map((row) => row.detail), inTransaction: reader.inTransaction });
            }
            return statement.all(...bindings);
          },
        };
      },
    });
    return reads;
  }

  test('detail reads probe task_id indexes scoped to the selected card ids', () => {
    const writer = openDb({ cwd: repo });
    const selected = createBoard(writer, 'selected', DEFAULT_LIFECYCLE_LANES);
    const other = createBoard(writer, 'other', DEFAULT_LIFECYCLE_LANES);
    const cardA = createTask(writer, { title: 'card a', boardId: selected.id, lane: 'Idea' });
    const cardB = createTask(writer, { title: 'card b', boardId: selected.id, lane: 'Idea' });
    const dependency = createTask(writer, { title: 'cross-board dependency', boardId: other.id, lane: 'Idea' });
    const foreign = createTask(writer, { title: 'foreign card', boardId: other.id, lane: 'Idea' });
    const otherWish = createTask(writer, { title: 'other wish', boardId: selected.id, lane: 'Idea' });
    writer.query('UPDATE tasks SET wish = ? WHERE id IN (?, ?)').run('slice', cardA.id, cardB.id);
    writer.query('UPDATE tasks SET created_at = 1 WHERE id = ?').run(cardA.id);
    writer.query('UPDATE tasks SET created_at = 2 WHERE id = ?').run(cardB.id);
    addDependency(writer, cardA.id, dependency.id);
    // Out-of-scope history: a foreign-board event and a filtered-wish comment
    // must never surface in — or fail — the selected board's snapshot.
    writer
      .query("INSERT INTO task_events (task_id, kind, note, created_at) VALUES (?, 'comment', NULL, 1)")
      .run(foreign.id);
    writer
      .query("INSERT INTO task_events (task_id, kind, note, created_at) VALUES (?, 'comment', NULL, 1)")
      .run(otherWish.id);
    writer
      .query("INSERT INTO task_events (task_id, kind, note, created_at) VALUES (?, 'comment', 'later', 2)")
      .run(cardA.id);
    writer
      .query("INSERT INTO task_events (task_id, kind, note, created_at) VALUES (?, 'comment', 'earlier', 1)")
      .run(cardA.id);
    writer.close();

    const reader = openDb({ cwd: repo });
    const reads = captureDetailReads(reader);
    const snapshot = readBoardTaskSnapshot(reader, selected.id, { wish: 'slice' });
    expect(snapshot.map((card) => card.id)).toEqual([cardA.id, cardB.id]);
    expect(snapshot[0]?.dependencies.map((row) => row.id)).toEqual([dependency.id]);
    expect(snapshot[0]?.timeline.map((event) => event.note)).toEqual(['earlier', 'later']);
    expect(reads).toHaveLength(3);
    for (const read of reads) {
      expect(read.inTransaction).toBe(true);
    }
    expect(reads[1]?.sql).toContain('FROM task_dependencies');
    expect(reads[1]?.bindings).toEqual([JSON.stringify([cardA.id, cardB.id])]);
    expect(reads[1]?.plan.join('\n')).toMatch(/SEARCH td .*INDEX.*task_id=\?/);
    expect(reads[2]?.sql).toContain('FROM task_events');
    expect(reads[2]?.bindings).toEqual([JSON.stringify([cardA.id, cardB.id])]);
    expect(reads[2]?.plan.join('\n')).toMatch(/SEARCH e .*INDEX.*task_id=\?/);
    expect(
      reads
        .slice(1)
        .flatMap((read) => read.plan)
        .join('\n'),
    ).not.toMatch(/SCAN (td|e)(?: |$)/);
    reader.close();
  });

  test('an empty card selection returns before querying detail tables', () => {
    const writer = openDb({ cwd: repo });
    const empty = createBoard(writer, 'empty-board', DEFAULT_LIFECYCLE_LANES);
    writer.close();

    const reader = openDb({ cwd: repo });
    const reads = captureDetailReads(reader);
    expect(readBoardTaskSnapshot(reader, empty.id)).toEqual([]);
    expect(reads).toHaveLength(1);
    expect(reads[0]?.inTransaction).toBe(true);
    reader.close();
  });

  const hostileIdentifier = 'bad\n\r\t\x1b\u0085\u2028\u2029\u202e'.concat('x'.repeat(2000));
  for (const kind of ['task', 'dependency', 'event'] as const) {
    test(`a malformed ${kind} identifier cannot create multiline or oversized diagnostics`, () => {
      const db = openDb({ cwd: repo });
      const roadmap = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
      const hostile = createTask(db, { title: 'hostile id', boardId: roadmap.id, lane: 'Idea' });
      const owner = createTask(db, { title: 'owner', boardId: roadmap.id, lane: 'Idea' });
      db.query('UPDATE tasks SET id = ? WHERE id = ?').run(hostileIdentifier, hostile.id);
      if (kind === 'event') {
        db.query("INSERT INTO task_events (task_id, kind, note, created_at) VALUES (?, 'comment', NULL, 1)").run(
          hostileIdentifier,
        );
      } else {
        if (kind === 'dependency') addDependency(db, owner.id, hostileIdentifier);
        db.exec('PRAGMA ignore_check_constraints = ON');
        db.query("UPDATE tasks SET status = 'unknown' WHERE id = ?").run(hostileIdentifier);
      }
      db.close();

      const reader = openDb({ cwd: repo });
      let message = '';
      try {
        readBoardTaskSnapshot(reader, roadmap.id);
      } catch (error) {
        message = (error as Error).message;
      }
      reader.close();
      expect(message.startsWith('Malformed board detail:')).toBe(true);
      expect(message).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
      expect(message.length).toBeLessThan(200);
    });
  }

  test('a large board stays under SQLite bind-variable limits with identifiers intact', () => {
    const writer = openDb({ cwd: repo });
    const wide = createBoard(writer, 'wide', DEFAULT_LIFECYCLE_LANES);
    const insert = writer.prepare(
      "INSERT INTO tasks (id, board_id, title, status, created_at, updated_at) VALUES (?, ?, 'bulk', 'ready', 1, 1)",
    );
    writer.transaction(() => {
      for (let index = 0; index < 33_000; index += 1) insert.run(`task-${index}`, wide.id);
    })();
    writer.close();

    const reader = openDb({ cwd: repo });
    const snapshot = readBoardTaskSnapshot(reader, wide.id);
    reader.close();
    expect(snapshot).toHaveLength(33_000);
    expect(new Set(snapshot.map((card) => card.id)).size).toBe(33_000);
    expect(snapshot.find((card) => card.id === 'task-0')).toBeDefined();
    expect(snapshot.find((card) => card.id === 'task-32999')).toBeDefined();
  });
});

describe('wish-status lane reconciliation on CLI JSON reads', () => {
  test('maps every ordered status prefix and leaves other untouched', async () => {
    const cases: Array<[status: string, destination: string]> = [
      ['DRAFT', 'Idea'],
      ['ROADMAP', 'Idea'],
      ['BLOCKED', 'Work'],
      ['ON-HOLD', 'Work'],
      ['EXECUTED', 'Review'],
      ['REVIEWED', 'Review'],
      ['PLAN-REVIEWED', 'Review'],
      ['IN_PROGRESS', 'Work'],
      ['EXECUTING', 'Work'],
      ['WAVE 2', 'Work'],
      ['READY', 'Wish'],
      ['APPROVED', 'Wish'],
      ['PLAN-READY', 'Wish'],
      ['SHIP-READY', 'Wish'],
      ['STAGED', 'Wish'],
      ['DONE', 'Done'],
      ['SHIPPED', 'Done'],
      ['MERGED — QA pending', 'Done'],
      ['COMPLETED', 'Done'],
      ['DELIVERED', 'Done'],
      ['PUBLISHED', 'Done'],
      ['CONCLUÍDO', 'Done'],
    ];
    const db = openDb({ cwd: repo });
    const roadmap = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    const ids = new Map<string, string>();
    for (const [index, [status]] of cases.entries()) {
      const slug = `mapped-${index}`;
      writeWish(slug, status);
      const task = createTask(db, { title: status, boardId: roadmap.id, lane: 'Brainstorm', wish: slug });
      ids.set(status, task.id);
    }
    writeWish('unrecognised', 'G');
    const other = createTask(db, {
      title: 'unrecognised',
      boardId: roadmap.id,
      lane: 'Brainstorm',
      wish: 'unrecognised',
    });
    db.close();

    const result = await board(repo, '--board', 'roadmap', '--json');
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');

    const observed = openDb({ cwd: repo });
    for (const [status, destination] of cases)
      expect(getTaskLane(observed, ids.get(status) as string)).toBe(destination);
    expect(getTaskLane(observed, other.id)).toBe('Brainstorm');
    observed.close();
  });

  test('moves only sync-owned cards with a WISH.md, preserving hand-owned and orphan cards', async () => {
    writeWish('sync-owned', 'DONE');
    const db = openDb({ cwd: repo });
    const roadmap = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    const syncOwned = createTask(db, { title: 'sync', boardId: roadmap.id, lane: 'Idea', wish: 'sync-owned' });
    const handOwned = createTask(db, { title: 'hand', boardId: roadmap.id, lane: 'Idea' });
    const orphan = createTask(db, { title: 'orphan', boardId: roadmap.id, lane: 'Idea', wish: 'missing-wish' });
    db.close();

    const result = await board(repo, '--board', 'roadmap', '--json');
    expect(result.code).toBe(0);
    const observed = openDb({ cwd: repo });
    expect(getTaskLane(observed, syncOwned.id)).toBe('Done');
    expect(getTaskLane(observed, handOwned.id)).toBe('Idea');
    expect(getTaskLane(observed, orphan.id)).toBe('Idea');
    observed.close();
  });

  test('reverts a manual CLI move with one durable sync event and stays idempotent', async () => {
    writeWish('manual-revert', 'DONE');
    const db = openDb({ cwd: repo });
    const roadmap = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    const task = createTask(db, {
      title: 'sync-owned manual move',
      boardId: roadmap.id,
      lane: 'Done',
      wish: 'manual-revert',
    });
    db.close();

    const manual = await manualTask(repo, 'move', task.id, '--to', 'Idea');
    expect(manual.code).toBe(0);
    expect(manual.stderr).toBe('');
    expect(manual.stdout).toContain('Done → Idea');

    let observed = openDb({ cwd: repo });
    expect(getTaskLane(observed, task.id)).toBe('Idea');
    expect(getTaskEvents(observed, task.id)).toEqual([
      expect.objectContaining({
        kind: 'move',
        note: 'Done→Idea',
        author: 'manual-operator',
        authorKind: 'human',
      }),
    ]);
    observed.close();

    const firstRead = await board(repo, '--board', 'roadmap', '--json');
    expect(firstRead.code).toBe(0);
    expect(firstRead.stderr).toBe('');
    const payload = JSON.parse(firstRead.stdout) as {
      lanes: Array<{ name: string; cards: Array<{ id: string }> }>;
    };
    expect(payload.lanes.find((lane) => lane.name === 'Done')?.cards.map((card) => card.id)).toContain(task.id);

    observed = openDb({ cwd: repo });
    expect(getTaskLane(observed, task.id)).toBe('Done');
    const afterReconcile = getTaskEvents(observed, task.id);
    expect(afterReconcile).toHaveLength(2);
    expect(afterReconcile.filter((event) => event.author === 'manual-operator')).toHaveLength(1);
    expect(afterReconcile.filter((event) => event.author === 'wish-status-sync')).toEqual([
      expect.objectContaining({
        kind: 'move',
        note: 'Idea→Done',
        authorKind: 'genie',
      }),
    ]);
    observed.close();

    const secondRead = await board(repo, '--board', 'roadmap', '--json');
    expect(secondRead.code).toBe(0);
    expect(secondRead.stderr).toBe('');
    observed = openDb({ cwd: repo });
    expect(getTaskLane(observed, task.id)).toBe('Done');
    expect(getTaskEvents(observed, task.id)).toEqual(afterReconcile);
    observed.close();
  });

  test('leaves invalid, linked, non-regular, and oversized wish inputs untouched while JSON succeeds', async () => {
    const wishesDir = join(repo, '.genie', 'wishes');
    mkdirSync(wishesDir, { recursive: true });

    writeWish('INVALID!', 'DONE');

    const linkedDirectoryTarget = join(repo, 'linked-wish-target');
    mkdirSync(linkedDirectoryTarget);
    writeFileSync(join(linkedDirectoryTarget, 'WISH.md'), '| **Status** | DONE |\n');
    symlinkSync(linkedDirectoryTarget, join(wishesDir, 'linked-directory'));

    const linkedFileTarget = join(repo, 'linked-wish-file.md');
    writeFileSync(linkedFileTarget, '| **Status** | DONE |\n');
    mkdirSync(join(wishesDir, 'linked-file'));
    symlinkSync(linkedFileTarget, join(wishesDir, 'linked-file', 'WISH.md'));

    mkdirSync(join(wishesDir, 'non-regular-wish', 'WISH.md'), { recursive: true });

    mkdirSync(join(wishesDir, 'oversized-wish'));
    writeFileSync(join(wishesDir, 'oversized-wish', 'WISH.md'), `| **Status** | DONE |\n${'x'.repeat(256 * 1_024)}`);

    const db = openDb({ cwd: repo });
    const roadmap = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    const tasks = ['INVALID!', 'linked-directory', 'linked-file', 'non-regular-wish', 'oversized-wish'].map((wish) =>
      createTask(db, { title: wish, boardId: roadmap.id, lane: 'Idea', wish }),
    );
    db.close();

    const result = await board(repo, '--board', 'roadmap', '--json');
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(() => JSON.parse(result.stdout)).not.toThrow();

    const observed = openDb({ cwd: repo });
    for (const task of tasks) {
      expect(getTaskLane(observed, task.id)).toBe('Idea');
      expect(getTaskEvents(observed, task.id)).toHaveLength(0);
    }
    observed.close();
  });

  test('leaves a card untouched when the .genie ancestor is a symlink while JSON succeeds', async () => {
    const db = openDb({ cwd: repo });
    const roadmap = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    const task = createTask(db, { title: 'linked genie', boardId: roadmap.id, lane: 'Idea', wish: 'linked-genie' });
    db.close();

    const genieDir = join(repo, '.genie');
    const linkedGenieTarget = join(repo, 'linked-genie-target');
    renameSync(genieDir, linkedGenieTarget);
    const wishDir = join(linkedGenieTarget, 'wishes', 'linked-genie');
    mkdirSync(wishDir, { recursive: true });
    writeFileSync(join(wishDir, 'WISH.md'), '| **Status** | DONE |\n');
    symlinkSync(linkedGenieTarget, genieDir);

    const result = await board(repo, '--board', 'roadmap', '--json');
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(() => JSON.parse(result.stdout)).not.toThrow();

    const observed = openDb({ cwd: repo });
    expect(getTaskLane(observed, task.id)).toBe('Idea');
    expect(getTaskEvents(observed, task.id)).toHaveLength(0);
    observed.close();
  });

  test('leaves a card untouched when the wishes ancestor is a symlink while JSON succeeds', async () => {
    const db = openDb({ cwd: repo });
    const roadmap = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    const task = createTask(db, { title: 'linked wishes', boardId: roadmap.id, lane: 'Idea', wish: 'linked-wishes' });
    db.close();

    const linkedWishesTarget = join(repo, 'linked-wishes-target');
    const wishDir = join(linkedWishesTarget, 'linked-wishes');
    mkdirSync(wishDir, { recursive: true });
    writeFileSync(join(wishDir, 'WISH.md'), '| **Status** | DONE |\n');
    symlinkSync(linkedWishesTarget, join(repo, '.genie', 'wishes'));

    const result = await board(repo, '--board', 'roadmap', '--json');
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(() => JSON.parse(result.stdout)).not.toThrow();

    const observed = openDb({ cwd: repo });
    expect(getTaskLane(observed, task.id)).toBe('Idea');
    expect(getTaskEvents(observed, task.id)).toHaveLength(0);
    observed.close();
  });

  test('leaves a card untouched when its mapped destination lane does not exist', async () => {
    writeWish('no-review-lane', 'REVIEWED');
    const db = openDb({ cwd: repo });
    const custom = createBoard(db, 'custom', [{ name: 'Idea' }, { name: 'Work' }]);
    const task = createTask(db, { title: 'review', boardId: custom.id, lane: 'Work', wish: 'no-review-lane' });
    db.close();

    const result = await board(repo, '--board', 'custom', '--json');
    expect(result.code).toBe(0);
    const observed = openDb({ cwd: repo });
    expect(getTaskLane(observed, task.id)).toBe('Work');
    expect(getTaskEvents(observed, task.id)).toHaveLength(0);
    observed.close();
  });

  test('uses the enclosing first lane for NULL-lane comparison', async () => {
    writeWish('already-fallback', 'DRAFT');
    writeWish('move-from-fallback', 'READY');
    const db = openDb({ cwd: repo });
    const roadmap = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    const already = createTask(db, { title: 'already', boardId: roadmap.id, wish: 'already-fallback' });
    const moves = createTask(db, { title: 'moves', boardId: roadmap.id, wish: 'move-from-fallback' });
    db.close();

    const result = await board(repo, '--board', 'roadmap', '--json');
    expect(result.code).toBe(0);
    const observed = openDb({ cwd: repo });
    expect(getTaskLane(observed, already.id)).toBeNull();
    expect(getTaskEvents(observed, already.id)).toHaveLength(0);
    expect(getTaskLane(observed, moves.id)).toBe('Wish');
    expect(getTaskEvents(observed, moves.id).map((event) => event.kind)).toEqual(['move']);
    observed.close();
  });

  test('does not reconcile a non-JSON human board read nor an unscoped --json read', async () => {
    writeWish('lane-json-only', 'DONE');
    const db = openDb({ cwd: repo });
    const roadmap = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    const task = createTask(db, { title: 'lane json only', boardId: roadmap.id, lane: 'Idea', wish: 'lane-json-only' });
    db.close();

    const human = await board(repo, '--board', 'roadmap');
    expect(human.code).toBe(0);
    let observed = openDb({ cwd: repo });
    expect(getTaskLane(observed, task.id)).toBe('Idea');
    observed.close();

    // Unscoped `--json` renders the frozen status shape, which shows no lanes —
    // so it must not write one either.
    const json = await board(repo, '--json');
    expect(json.code).toBe(0);
    observed = openDb({ cwd: repo });
    expect(getTaskLane(observed, task.id)).toBe('Idea');
    observed.close();
  });

  test('a seeded lane divergence survives every laneless read and is reconciled only by the lane --json read', async () => {
    writeWish('diverged', 'DONE');
    const db = openDb({ cwd: repo });
    const roadmap = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    // Seeded divergence: the stored lane disagrees with the wish's DONE status.
    const task = createTask(db, { title: 'diverged card', boardId: roadmap.id, lane: 'Idea', wish: 'diverged' });
    db.close();

    const unscopedJson = await board(repo, '--json');
    expect(unscopedJson.code).toBe(0);
    expect(unscopedJson.stderr).toBe('');
    let observed = openDb({ cwd: repo });
    expect(getTaskLane(observed, task.id)).toBe('Idea');
    expect(getTaskEvents(observed, task.id)).toHaveLength(0);
    observed.close();

    const laneHuman = await board(repo, '--board', 'roadmap');
    expect(laneHuman.code).toBe(0);
    observed = openDb({ cwd: repo });
    expect(getTaskLane(observed, task.id)).toBe('Idea');
    expect(getTaskEvents(observed, task.id)).toHaveLength(0);
    observed.close();

    const laneJson = await board(repo, '--board', 'roadmap', '--json');
    expect(laneJson.code).toBe(0);
    expect(laneJson.stderr).toBe('');
    observed = openDb({ cwd: repo });
    expect(getTaskLane(observed, task.id)).toBe('Done');
    expect(getTaskEvents(observed, task.id)).toEqual([
      expect.objectContaining({ kind: 'move', note: 'Idea→Done', author: 'wish-status-sync', authorKind: 'genie' }),
    ]);
    observed.close();
  });

  test('spawns git exactly once per board read, none of it from reconciliation', async () => {
    writeWish('one-spawn', 'DONE');
    const db = openDb({ cwd: repo });
    const roadmap = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    const task = createTask(db, { title: 'one spawn', boardId: roadmap.id, lane: 'Idea', wish: 'one-spawn' });
    db.close();

    const shimDir = join(repo, 'git-shim');
    const log = join(repo, 'git-invocations.log');
    mkdirSync(shimDir);
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf-8' }).trim();
    writeFileSync(
      join(shimDir, 'git'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${realGit} "$@"\n`,
    );
    chmodSync(join(shimDir, 'git'), 0o755);

    const result = await boardWithEnv(
      repo,
      { PATH: `${shimDir}:${process.env.PATH ?? ''}` },
      '--board',
      'roadmap',
      '--json',
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');

    // The shim delegates to the real git, so the read still resolves its repo.
    const observed = openDb({ cwd: repo });
    expect(getTaskLane(observed, task.id)).toBe('Done');
    observed.close();

    const invocations = readFileSync(log, 'utf-8').split('\n').filter(Boolean);
    expect(invocations.filter((line) => line.startsWith('rev-parse'))).toHaveLength(1);
    expect(invocations).toHaveLength(1);
  });
});

// A laneless board (no lanes column) must keep the EXACT four-status render and
// the status-keyed --json shape — adding lane support must not perturb it.
describe('laneless board render is unchanged', () => {
  test('a board without lanes renders the three status columns (no Blocked column)', async () => {
    const db = openDb({ cwd: repo });
    const plain = createBoard(db, 'plain');
    createTask(db, { title: 'plain task', boardId: plain.id });
    db.close();

    const r = await board(repo, '--board', 'plain');
    expect(r.code).toBe(0);
    for (const label of ['Ready', 'In Progress', 'Done']) {
      expect(r.stdout).toContain(label);
    }
    expect(r.stdout).not.toContain('── Blocked');
    expect(r.stdout).not.toContain('/brainstorm');
  });

  test('--json for a laneless board keeps the status-keyed shape with no lane field', async () => {
    const db = openDb({ cwd: repo });
    const plain = createBoard(db, 'plain');
    createTask(db, { title: 'plain task', boardId: plain.id });
    db.close();

    const r = await board(repo, '--board', 'plain', '--json');
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout) as { columns: Record<string, Array<Record<string, unknown>>> };
    expect(Object.keys(payload.columns).sort()).toEqual(['blocked', 'done', 'in_progress', 'ready']);
    // The frozen TaskRow shape never gains a `lane` key NOR any runtime or
    // declared-routing field on the laneless path — the byte-freeze survives
    // the runtime layer (Decision 7) and the assignment layer (W1).
    const card = payload.columns.ready[0];
    for (const leaked of [
      'lane',
      'agentKind',
      'heartbeatAt',
      'blockedBy',
      'blockedReason',
      'assignedAgent',
      'assignedReason',
    ]) {
      expect(leaked in card).toBe(false);
    }
    // The exact frozen key set, sorted — a byte-level guard against additions.
    expect(Object.keys(card).sort()).toEqual([
      'boardId',
      'claimedAt',
      'claimedBy',
      'createdAt',
      'group',
      'id',
      'status',
      'title',
      'updatedAt',
      'wish',
    ]);
  });

  test('an ENFORCED-BLOCKED card keeps the frozen laneless shape (enforcedBlock is lane-only)', async () => {
    const db = openDb({ cwd: repo });
    const plain = createBoard(db, 'plain');
    const t = createTask(db, { title: 'plain task', boardId: plain.id });
    blockTask(db, t.id, 'parked until Q3', { author: 'felipe', authorKind: 'human' }, 'hold');
    db.close();

    const r = await board(repo, '--board', 'plain', '--json');
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout) as { columns: Record<string, Array<Record<string, unknown>>> };
    // The block does not move the lifecycle status, so the card is still `ready`.
    const card = payload.columns.ready[0];
    // The two declared-routing fields must not escape onto the laneless path
    // even when the row carries an enforced block (lane-only, Decision 7 + W1).
    for (const leaked of ['assignedAgent', 'assignedReason', 'enforcedBlock']) {
      expect(leaked in card).toBe(false);
    }
    expect(Object.keys(card).sort()).toEqual([
      'boardId',
      'claimedAt',
      'claimedBy',
      'createdAt',
      'group',
      'id',
      'status',
      'title',
      'updatedAt',
      'wish',
    ]);
  });

  test('--json laneless output is byte-identical to the pre-assignment shape even for an assigned card', async () => {
    const db = openDb({ cwd: repo });
    const plain = createBoard(db, 'plain');
    const assigned = createTask(db, {
      title: 'assigned card',
      boardId: plain.id,
      assignedAgent: 'codex',
      assignedReason: 'declared routing',
    });
    db.close();

    const r = await board(repo, '--board', 'plain', '--json');
    expect(r.code).toBe(0);

    // The pre-assignment byte shape, reconstructed independently of the
    // serializer: exactly the TaskRow keys from before A1, in mapTask's
    // insertion order, with the assignment values stripped. Any field added,
    // removed, or reordered on the laneless path changes these bytes.
    const expected = {
      scope: 'board "plain"',
      columns: {
        blocked: [],
        ready: [
          {
            id: assigned.id,
            boardId: plain.id,
            title: 'assigned card',
            status: 'ready',
            claimedBy: null,
            claimedAt: null,
            wish: null,
            group: null,
            createdAt: assigned.createdAt,
            updatedAt: assigned.updatedAt,
          },
        ],
        in_progress: [],
        done: [],
      },
    };
    expect(r.stdout).toBe(`${JSON.stringify(expected, null, 2)}\n`);
  });
});

// Every visual state is asserted by substring against a fixture with injected
// heartbeat_at / blocked_by / events — no criterion is eyeball-accepted. The
// board computes `now` at render time; seeded ages use minute-scale margins so
// the ~100ms subprocess delay never flips a threshold (deterministic, no sleep).
describe('deterministic runtime badges (laneless render)', () => {
  /** Claim a fresh card and seed its heartbeat to an absolute timestamp. */
  function seedClaimed(title: string, heartbeatAt: number | null): string {
    const db = openDb({ cwd: repo });
    const t = createTask(db, { title });
    claimTask(db, t.id, 'w1');
    if (heartbeatAt != null) recordHeartbeat(db, t.id, heartbeatAt);
    db.close();
    return t.id;
  }

  test('a fresh heartbeat renders ▶ running on a claimed card', async () => {
    seedClaimed('running card', Date.now());
    const r = await board(repo);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('▶');
    expect(r.stdout).not.toContain('☠');
  });

  test('a heartbeat past the running window but under stale renders ⏸ idle', async () => {
    seedClaimed('idle card', Date.now() - (LIVENESS_RUNNING_MS + 60_000));
    const r = await board(repo);
    expect(r.stdout).toContain('⏸');
  });

  test('a stale heartbeat renders ☠ (the zombie in_progress lie, killed)', async () => {
    seedClaimed('stale card', Date.now() - (LIVENESS_STALE_MS + 60_000));
    const r = await board(repo);
    expect(r.stdout).toContain('☠');
  });

  test('a claimed card that never pulsed renders ☠', async () => {
    seedClaimed('never pulsed', null);
    const r = await board(repo);
    expect(r.stdout).toContain('☠');
  });

  test('an unclaimed card carries no liveness glyph', async () => {
    const db = openDb({ cwd: repo });
    createTask(db, { title: 'unclaimed' });
    db.close();
    const r = await board(repo);
    expect(r.stdout).not.toContain('▶');
    expect(r.stdout).not.toContain('⏸');
    expect(r.stdout).not.toContain('☠');
  });

  test('a deps-blocked card renders ⛔ deps inside the Ready column (render-derived)', async () => {
    const db = openDb({ cwd: repo });
    const a = createTask(db, { title: 'dep' });
    createTask(db, { title: 'downstream', dependsOn: [a.id] }); // status blocked
    db.close();
    const r = await board(repo);
    expect(r.stdout).toContain('⛔ deps');
    // Folds into Ready — Blocked is a badge, never a column.
    const readyIdx = r.stdout.indexOf('── Ready');
    const inProgIdx = r.stdout.indexOf('── In Progress');
    const badgeIdx = r.stdout.indexOf('⛔ deps');
    expect(badgeIdx).toBeGreaterThan(readyIdx);
    expect(badgeIdx).toBeLessThan(inProgIdx);
  });

  test('an agent-blocked card renders ⛔ with the agent provenance + reason', async () => {
    const db = openDb({ cwd: repo });
    const t = createTask(db, { title: 'agent blocked' });
    blockTask(db, t.id, 'awaiting design', { author: 'eng-B', authorKind: 'claude-code' });
    db.close();
    const r = await board(repo);
    expect(r.stdout).toContain('⛔ eng-B: awaiting design');
  });

  test('a human-blocked card renders ⛔ with the human provenance + reason', async () => {
    const db = openDb({ cwd: repo });
    const t = createTask(db, { title: 'human blocked' });
    blockTask(db, t.id, 'hold for release', { author: 'felipe', authorKind: 'human' });
    db.close();
    const r = await board(repo);
    expect(r.stdout).toContain('⛔ felipe: hold for release');
  });

  test('comment events render a 💬 count badge', async () => {
    const db = openDb({ cwd: repo });
    const t = createTask(db, { title: 'chatty' });
    appendTaskEvent(db, t.id, { kind: 'comment', note: 'one' });
    appendTaskEvent(db, t.id, { kind: 'comment', note: 'two' });
    appendTaskEvent(db, t.id, { kind: 'move', note: 'x' }); // not a comment
    db.close();
    const r = await board(repo);
    expect(r.stdout).toContain('💬 2');
  });

  test('the three columns render and Blocked is never a column header', async () => {
    const db = openDb({ cwd: repo });
    createTask(db, { title: 'r' });
    db.close();
    const r = await board(repo);
    expect(r.stdout).toContain('── Ready');
    expect(r.stdout).toContain('── In Progress');
    expect(r.stdout).toContain('── Done');
    expect(r.stdout).not.toContain('── Blocked');
  });
});

// ============================================================================
// Orchestration authority — the refusal is an error line, never a stack trace
// ============================================================================

describe('orca lifecycle authority', () => {
  /** A throwaway GENIE_HOME whose config hands lifecycle authority to Orca. */
  function orcaHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'genie-board-home-'));
    homes.push(home);
    writeFileSync(join(home, 'config.json'), '{"orchestration":{"mode":"orca"}}');
    return home;
  }

  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  test.each([[[]], [['--json']], [['list']]])(
    'renders `genie board %j` as one clean Error line with exit 1',
    async (args: string[]) => {
      const result = await boardWithEnv(repo, { GENIE_HOME: orcaHome() }, ...args);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(
        'Error: local_lifecycle_disabled_in_orca_mode: local Genie lifecycle state is disabled because orchestration.mode is "orca"\n',
      );
      // The regression: the open happened OUTSIDE the handler's try, so bun
      // printed a raw stack trace and a source excerpt instead.
      expect(result.stderr).not.toContain('at openDb');
      expect(result.stderr).not.toContain('LocalLifecycleDisabledError:');
    },
  );
});
