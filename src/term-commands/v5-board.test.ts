/**
 * genie board — CLI-level tests. The board is derived purely by query with
 * NO stored view state, so these assert that status transitions are reflected
 * on the next render with nothing persisted. Exit codes AND stderr are checked.
 */

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
  appendTaskEvent,
  blockTask,
  claimTask,
  completeTask,
  createBoard,
  createTask,
  getTaskEvents,
  getTaskLane,
  moveTask,
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
    createBoard(db, 'plain');
    createTask(db, { title: 'c1', boardId: road.id });
    db.close();

    const r = await board(repo, 'list');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('roadmap');
    expect(r.stdout).toContain('plain');
    expect(r.stdout).toContain('2 boards');

    const j = await board(repo, 'list', '--json');
    const rows = JSON.parse(j.stdout) as Array<{ name: string; laneCount: number; cardCount: number }>;
    const road2 = rows.find((x) => x.name === 'roadmap');
    expect(road2?.laneCount).toBe(6);
    expect(road2?.cardCount).toBe(1);
    expect(rows.find((x) => x.name === 'plain')?.laneCount).toBe(0);
  });

  test('reports "No boards found." on an empty repo', async () => {
    const r = await board(repo, 'list');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('No boards found.');
  });
});

describe('lane-grouped render', () => {
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

  test('--json carries enforcedBlock and the declared routing on every lane card and nothing else from the runtime layer', async () => {
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
    recordHeartbeat(db, held.id); // a runtime field that must NOT reach this shape
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

    // The lane shape carries the two declared-routing fields plus exactly one
    // runtime field — provenance, identity, and heartbeat siblings stay off it.
    for (const leaked of ['agentKind', 'heartbeatAt', 'blockedBy', 'blockedReason']) {
      expect(leaked in (cards.get('held card') as Record<string, unknown>)).toBe(false);
    }
    expect(Object.keys(cards.get('held card') as Record<string, unknown>).sort()).toEqual([
      'assignedAgent',
      'assignedReason',
      'boardId',
      'claimedAt',
      'claimedBy',
      'createdAt',
      'enforcedBlock',
      'group',
      'id',
      'lane',
      'status',
      'title',
      'updatedAt',
      'wish',
    ]);
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
