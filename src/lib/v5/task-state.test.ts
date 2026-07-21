import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './genie-db.js';
import {
  CheckoutConflictError,
  CycleError,
  DEFAULT_LIFECYCLE_LANES,
  DEFAULT_STALE_MS,
  DuplicateBoardError,
  LaneError,
  TaskNotReadyError,
  UnknownTaskError,
  WishGroupDriftError,
  WishGroupStateError,
  addDependency,
  appendStage,
  appendTaskEvent,
  assertWishSignature,
  claimTask,
  completeTask,
  completeWishGroup,
  computeGroupsSignature,
  countBoardTasks,
  createBoard,
  createTask,
  createWishGroups,
  getBoardByName,
  getStageLog,
  getTask,
  getTaskEvents,
  getTaskLane,
  getWishGroups,
  listBoards,
  listTasks,
  moveTask,
  readyTasks,
  recomputeReady,
  startWishGroup,
} from './task-state.js';

const HUMAN = { author: 'felipe', authorKind: 'human' };

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genie-task-'));
  db = openDb({ path: join(dir, 'genie.db') });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('task CRUD', () => {
  test('creates a task with no deps as ready and round-trips', () => {
    const board = createBoard(db, 'sprint-1');
    const task = createTask(db, { title: 'ship it', boardId: board.id });
    expect(task.title).toBe('ship it');
    expect(task.status).toBe('ready');
    expect(task.boardId).toBe(board.id);

    const fetched = getTask(db, task.id);
    expect(fetched).toEqual(task);
  });

  test('creates a task with deps as blocked', () => {
    const a = createTask(db, { title: 'a' });
    const b = createTask(db, { title: 'b', dependsOn: [a.id] });
    expect(b.status).toBe('blocked');
  });

  test('listTasks filters by status', () => {
    createTask(db, { title: 'r1' });
    const a = createTask(db, { title: 'a' });
    createTask(db, { title: 'b', dependsOn: [a.id] });
    expect(listTasks(db).length).toBe(3);
    expect(listTasks(db, { status: 'blocked' }).map((t) => t.title)).toEqual(['b']);
  });

  test('getTask returns null for unknown id', () => {
    expect(getTask(db, 't_missing')).toBeNull();
  });
});

describe('boards with lifecycle lanes', () => {
  test('createBoard persists lanes and round-trips them', () => {
    const board = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    expect(board.lanes?.map((l) => l.name)).toEqual(['Idea', 'Brainstorm', 'Wish', 'Work', 'Review', 'Done']);
    const fetched = getBoardByName(db, 'roadmap');
    expect(fetched?.lanes).toEqual(DEFAULT_LIFECYCLE_LANES);
    // Display-only action hints survive the JSON round-trip.
    expect(fetched?.lanes?.find((l) => l.name === 'Brainstorm')?.action).toBe('/wish');
  });

  test('a laneless board round-trips lanes as null', () => {
    const board = createBoard(db, 'plain');
    expect(board.lanes).toBeNull();
    expect(getBoardByName(db, 'plain')?.lanes).toBeNull();
  });

  test('an empty lane list normalizes to a laneless board', () => {
    const board = createBoard(db, 'empty-lanes', []);
    expect(board.lanes).toBeNull();
  });

  test('a duplicate board name throws DuplicateBoardError (UNIQUE surfaced cleanly)', () => {
    createBoard(db, 'dup');
    expect(() => createBoard(db, 'dup')).toThrow(DuplicateBoardError);
  });

  test('listBoards + countBoardTasks report lane and card counts', () => {
    const road = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    createBoard(db, 'plain');
    createTask(db, { title: 'c1', boardId: road.id });
    createTask(db, { title: 'c2', boardId: road.id });

    const boards = listBoards(db);
    expect(boards.map((b) => b.name).sort()).toEqual(['plain', 'roadmap']);
    expect(countBoardTasks(db, road.id)).toBe(2);
    const plain = boards.find((b) => b.name === 'plain');
    expect(countBoardTasks(db, plain!.id)).toBe(0);
  });
});

describe('lane moves + task_events timeline', () => {
  test('createTask honors an initial lane placement', () => {
    const board = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    const task = createTask(db, { title: 'idea', boardId: board.id, lane: 'Idea' });
    expect(getTaskLane(db, task.id)).toBe('Idea');
  });

  test('moveTask sets the lane and appends a move event with from→to', () => {
    const board = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    const task = createTask(db, { title: 'idea', boardId: board.id, lane: 'Idea' });

    const result = moveTask(db, task.id, 'Brainstorm', HUMAN);
    expect(result.from).toBe('Idea');
    expect(result.to).toBe('Brainstorm');
    expect(getTaskLane(db, task.id)).toBe('Brainstorm');

    const events = getTaskEvents(db, task.id);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('move');
    expect(events[0].note).toBe('Idea→Brainstorm');
    expect(events[0].author).toBe('felipe');
    expect(events[0].authorKind).toBe('human');
  });

  test('moving an unplaced card records the (none)→lane origin', () => {
    const board = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    const task = createTask(db, { title: 'unplaced', boardId: board.id });
    const result = moveTask(db, task.id, 'Wish', HUMAN);
    expect(result.from).toBeNull();
    expect(getTaskEvents(db, task.id)[0].note).toBe('(none)→Wish');
  });

  test('rejects an undefined lane, listing the valid lanes', () => {
    const board = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    const task = createTask(db, { title: 'idea', boardId: board.id, lane: 'Idea' });
    expect(() => moveTask(db, task.id, 'Nope', HUMAN)).toThrow(LaneError);
    try {
      moveTask(db, task.id, 'Nope', HUMAN);
    } catch (err) {
      expect((err as Error).message).toContain('Idea, Brainstorm, Wish, Work, Review, Done');
    }
    // A rejected move leaves the lane and timeline untouched.
    expect(getTaskLane(db, task.id)).toBe('Idea');
    expect(getTaskEvents(db, task.id)).toHaveLength(0);
  });

  test('rejects a move for a card with no board', () => {
    const task = createTask(db, { title: 'boardless' });
    expect(() => moveTask(db, task.id, 'Idea', HUMAN)).toThrow(LaneError);
  });

  test('rejects a move on a board that defines no lanes', () => {
    const board = createBoard(db, 'plain');
    const task = createTask(db, { title: 'on plain', boardId: board.id });
    expect(() => moveTask(db, task.id, 'Idea', HUMAN)).toThrow(LaneError);
  });

  test('rejects a move for an unknown task', () => {
    expect(() => moveTask(db, 't_nope', 'Idea', HUMAN)).toThrow(UnknownTaskError);
  });

  test('appendTaskEvent + getTaskEvents round-trip in append order', () => {
    const task = createTask(db, { title: 'a' });
    appendTaskEvent(db, task.id, { kind: 'comment', note: 'first', author: 'x', authorKind: 'human' });
    appendTaskEvent(db, task.id, { kind: 'comment', note: 'second' });
    const events = getTaskEvents(db, task.id);
    expect(events.map((e) => e.note)).toEqual(['first', 'second']);
    expect(events[0].id < events[1].id).toBe(true);
    // Unset author fields round-trip as null.
    expect(events[1].author).toBeNull();
    expect(events[1].authorKind).toBeNull();
  });

  test('appendTaskEvent rejects an unknown task', () => {
    expect(() => appendTaskEvent(db, 't_nope', { kind: 'move' })).toThrow(UnknownTaskError);
  });
});

describe('dependency cycle rejection', () => {
  test('rejects self-dependency', () => {
    const a = createTask(db, { title: 'a' });
    expect(() => addDependency(db, a.id, a.id)).toThrow(CycleError);
  });

  test('rejects a 2-node cycle at insertion', () => {
    const a = createTask(db, { title: 'a' });
    const b = createTask(db, { title: 'b', dependsOn: [a.id] }); // b → a
    expect(() => addDependency(db, a.id, b.id)).toThrow(CycleError); // a → b closes loop
  });

  test('rejects a transitive 3-node cycle', () => {
    const a = createTask(db, { title: 'a' });
    const b = createTask(db, { title: 'b', dependsOn: [a.id] }); // b → a
    const c = createTask(db, { title: 'c', dependsOn: [b.id] }); // c → b
    expect(() => addDependency(db, a.id, c.id)).toThrow(CycleError); // a → c closes loop
  });

  test('rejects a dependency on an unknown task', () => {
    const a = createTask(db, { title: 'a' });
    expect(() => addDependency(db, a.id, 't_nope')).toThrow(UnknownTaskError);
  });

  test('allows a valid DAG edge', () => {
    const a = createTask(db, { title: 'a' });
    const b = createTask(db, { title: 'b' });
    expect(() => addDependency(db, b.id, a.id)).not.toThrow();
  });
});

describe('ready-set recompute (idempotent + monotonic)', () => {
  test('promotes blocked → ready only when all deps are done', () => {
    const a = createTask(db, { title: 'a' });
    const b = createTask(db, { title: 'b' });
    const c = createTask(db, { title: 'c', dependsOn: [a.id, b.id] });
    expect(getTask(db, c.id)!.status).toBe('blocked');

    completeTask(db, a.id); // completeTask runs recomputeReady internally
    expect(getTask(db, c.id)!.status).toBe('blocked'); // b still pending

    completeTask(db, b.id);
    expect(getTask(db, c.id)!.status).toBe('ready');
  });

  test('is idempotent — a second recompute promotes nothing', () => {
    const a = createTask(db, { title: 'a' });
    createTask(db, { title: 'b', dependsOn: [a.id] });
    completeTask(db, a.id);
    expect(recomputeReady(db)).toBe(0);
    expect(recomputeReady(db)).toBe(0);
  });

  test('is monotonic — never demotes in_progress or done', () => {
    const a = createTask(db, { title: 'a' });
    claimTask(db, a.id, 'w1');
    expect(getTask(db, a.id)!.status).toBe('in_progress');
    recomputeReady(db);
    expect(getTask(db, a.id)!.status).toBe('in_progress'); // not demoted
  });

  test('readyTasks lists only ready tasks', () => {
    const a = createTask(db, { title: 'a' });
    createTask(db, { title: 'b', dependsOn: [a.id] });
    expect(readyTasks(db).map((t) => t.title)).toEqual(['a']);
  });

  test('completing a blocked task is rejected (no dependency-gate bypass)', () => {
    const a = createTask(db, { title: 'a' });
    const b = createTask(db, { title: 'b', dependsOn: [a.id] });
    expect(getTask(db, b.id)!.status).toBe('blocked');
    expect(() => completeTask(db, b.id)).toThrow(TaskNotReadyError);
    // a's dependency gate is intact — b never went done, nothing downstream moved.
    expect(getTask(db, b.id)!.status).toBe('blocked');
    // Once the dep is done, b promotes to ready and completes normally.
    completeTask(db, a.id);
    expect(getTask(db, b.id)!.status).toBe('ready');
    expect(completeTask(db, b.id).status).toBe('done');
  });
});

describe('atomic checkout claim (single process)', () => {
  test('claiming a ready task transitions it to in_progress', () => {
    const a = createTask(db, { title: 'a' });
    const claimed = claimTask(db, a.id, 'worker-1');
    expect(claimed.status).toBe('in_progress');
    expect(claimed.claimedBy).toBe('worker-1');
    expect(claimed.claimedAt).not.toBeNull();
  });

  test('a second claim on a fresh claim raises CheckoutConflictError', () => {
    const a = createTask(db, { title: 'a' });
    claimTask(db, a.id, 'worker-1');
    expect(() => claimTask(db, a.id, 'worker-2')).toThrow(CheckoutConflictError);
  });

  test('claiming an unknown task raises UnknownTaskError', () => {
    expect(() => claimTask(db, 't_nope', 'worker-1')).toThrow(UnknownTaskError);
  });

  test('a stale in_progress claim can be re-claimed', () => {
    const a = createTask(db, { title: 'a' });
    const t0 = 1_000_000;
    claimTask(db, a.id, 'worker-1', { now: t0 });
    // Before the stale horizon: still conflicts.
    expect(() => claimTask(db, a.id, 'worker-2', { now: t0 + DEFAULT_STALE_MS - 1 })).toThrow(CheckoutConflictError);
    // Past the stale horizon: worker-2 takes it.
    const reclaimed = claimTask(db, a.id, 'worker-2', { now: t0 + DEFAULT_STALE_MS + 1 });
    expect(reclaimed.claimedBy).toBe('worker-2');
  });
});

describe('append-only stage log', () => {
  test('appends entries in order and reads them back', () => {
    const a = createTask(db, { title: 'a' });
    appendStage(db, a.id, 'planned');
    appendStage(db, a.id, 'implemented', 'wrote the module');
    const log = getStageLog(db, a.id);
    expect(log.map((e) => e.stage)).toEqual(['planned', 'implemented']);
    expect(log[1].note).toBe('wrote the module');
    expect(log[0].id < log[1].id).toBe(true);
  });

  test('rejects a stage on an unknown task', () => {
    expect(() => appendStage(db, 't_nope', 'planned')).toThrow(UnknownTaskError);
  });
});

describe('wish-group state machine', () => {
  const groups = [{ name: 'g1' }, { name: 'g2', dependsOn: ['g1'] }, { name: 'g3', dependsOn: ['g1'] }];

  test('createWishGroups seeds ready/blocked from deps', () => {
    const created = createWishGroups(db, 'demo', groups);
    const byName = Object.fromEntries(created.map((g) => [g.name, g.status]));
    expect(byName).toEqual({ g1: 'ready', g2: 'blocked', g3: 'blocked' });
  });

  test('start requires deps done; complete promotes dependents', () => {
    createWishGroups(db, 'demo', groups);
    expect(() => startWishGroup(db, 'demo', 'g2', 'eng')).toThrow(WishGroupStateError);

    startWishGroup(db, 'demo', 'g1', 'eng');
    completeWishGroup(db, 'demo', 'g1');

    const byName = Object.fromEntries(getWishGroups(db, 'demo').map((g) => [g.name, g.status]));
    expect(byName.g2).toBe('ready');
    expect(byName.g3).toBe('ready');
  });

  test('complete is idempotent on a done group', () => {
    createWishGroups(db, 'demo', groups);
    startWishGroup(db, 'demo', 'g1', 'eng');
    completeWishGroup(db, 'demo', 'g1');
    expect(() => completeWishGroup(db, 'demo', 'g1')).not.toThrow();
    expect(completeWishGroup(db, 'demo', 'g1').status).toBe('done');
  });

  test('rejects a group graph with a cycle', () => {
    expect(() =>
      createWishGroups(db, 'bad', [
        { name: 'a', dependsOn: ['b'] },
        { name: 'b', dependsOn: ['a'] },
      ]),
    ).toThrow(CycleError);
  });

  test('signature is stable across ordering and flags drift', () => {
    const sigA = computeGroupsSignature(groups);
    const reordered = [{ name: 'g3', dependsOn: ['g1'] }, { name: 'g1' }, { name: 'g2', dependsOn: ['g1'] }];
    expect(computeGroupsSignature(reordered)).toBe(sigA);

    createWishGroups(db, 'demo', groups);
    // Same structure (reordered) → no drift.
    expect(() => assertWishSignature(db, 'demo', reordered)).not.toThrow();
    // Structural change (new dep) → drift.
    const drifted = [{ name: 'g1' }, { name: 'g2', dependsOn: ['g1'] }, { name: 'g3', dependsOn: ['g1', 'g2'] }];
    expect(() => assertWishSignature(db, 'demo', drifted)).toThrow(WishGroupDriftError);
  });
});

// ---------------------------------------------------------------------------
// Multi-PROCESS checkout race: N concurrent bun processes claim the same ready
// task. Exactly one must win; every loser must get a typed conflict. This is
// the real proof that the conditional-UPDATE-in-a-transaction is atomic across
// processes sharing one on-disk WAL database.
// ---------------------------------------------------------------------------
describe('multi-process checkout race', () => {
  test('exactly one of N concurrent claimants wins', async () => {
    const dbPath = join(dir, 'race.db');
    const seed = openDb({ path: dbPath });
    const task = createTask(seed, { title: 'contended' });
    seed.close(); // checkpoint so child processes see the committed row

    const gdbPath = join(import.meta.dir, 'genie-db.ts');
    const tsPath = join(import.meta.dir, 'task-state.ts');
    const workerPath = join(dir, 'claim-worker.ts');
    writeFileSync(
      workerPath,
      `
import { openDb } from ${JSON.stringify(gdbPath)};
import { claimTask, CheckoutConflictError } from ${JSON.stringify(tsPath)};
const [dbPath, taskId, worker] = process.argv.slice(2);
const db = openDb({ path: dbPath });
try {
  claimTask(db, taskId, worker);
  process.stdout.write('WON');
} catch (e) {
  if (e instanceof CheckoutConflictError) process.stdout.write('CONFLICT');
  else { process.stdout.write('ERR:' + (e && e.message)); process.exitCode = 3; }
} finally {
  db.close();
}
`,
    );

    const N = 8;
    const runs = Array.from({ length: N }, (_, i) => {
      const proc = Bun.spawn(['bun', 'run', workerPath, dbPath, task.id, `worker-${i}`], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      return (async () => {
        const out = await new Response(proc.stdout).text();
        const err = await new Response(proc.stderr).text();
        const code = await proc.exited;
        return { out, err, code };
      })();
    });

    const settled = await Promise.allSettled(runs);
    const outcomes = settled.map((s) =>
      s.status === 'fulfilled' ? `${s.value.out}(exit ${s.value.code})` : `REJECTED:${s.reason}`,
    );

    const wins = outcomes.filter((o) => o.startsWith('WON')).length;
    const conflicts = outcomes.filter((o) => o.startsWith('CONFLICT')).length;

    // On mismatch, the raw outcomes are the only way to diagnose a CI-only
    // straggler (empty stdout = child died before writing; ERR:* = typed leak).
    if (wins !== 1 || conflicts !== N - 1) {
      console.error('race outcomes:', JSON.stringify(outcomes));
      for (const s of settled) {
        if (s.status === 'fulfilled' && !s.value.out.startsWith('WON') && !s.value.out.startsWith('CONFLICT')) {
          console.error('straggler stderr:', s.value.err);
        }
      }
    }

    expect(wins).toBe(1);
    expect(conflicts).toBe(N - 1);

    // Final state: exactly one worker owns the task, status in_progress.
    const verify = openDb({ path: dbPath });
    const finalTask = getTask(verify, task.id)!;
    verify.close();
    expect(finalTask.status).toBe('in_progress');
    expect(finalTask.claimedBy).toMatch(/^worker-\d+$/);
  }, 30_000);
});
