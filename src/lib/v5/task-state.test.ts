import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSchema, isCurrentGenieDb, openDb } from './genie-db.js';
import {
  CheckoutConflictError,
  CycleError,
  DEFAULT_LIFECYCLE_LANES,
  DEFAULT_STALE_MS,
  DuplicateBoardError,
  LIVENESS_RUNNING_MS,
  LIVENESS_STALE_MS,
  LaneError,
  TaskBlockedError,
  TaskCompleteError,
  TaskHasDependentsError,
  TaskNotReadyError,
  TaskReleaseError,
  type TaskRow,
  UnknownTaskError,
  addDependency,
  appendStage,
  appendTaskEvent,
  blockTask,
  claimTask,
  commentCounts,
  completeTask,
  countBoardTasks,
  createBoard,
  createTask,
  deleteTask,
  exportState,
  formatWishRef,
  getBoardByName,
  getDependencies,
  getHire,
  getStageLog,
  getTask,
  getTaskCard,
  getTaskEvents,
  getTaskLane,
  hireAgent,
  importState,
  linkTaskToWish,
  listBoards,
  listHires,
  listTasks,
  listTasksWithLane,
  livenessFromHeartbeat,
  moveTask,
  readyTasks,
  recomputeReady,
  recordHeartbeat,
  releaseTask,
  setTaskWish,
  unblockTask,
  unhireAgent,
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

  test('linkTaskToWish changes only wish metadata and updated_at, appending one wish event', () => {
    const board = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    const task = createTask(db, { title: 'existing card', boardId: board.id, lane: 'Idea' });
    claimTask(db, task.id, 'worker-1', { now: 1_000, author: { author: 'worker-1', authorKind: 'codex' } });
    recordHeartbeat(db, task.id, 2_000);
    blockTask(db, task.id, 'hold exactly', { author: 'operator', authorKind: 'human' });
    appendTaskEvent(db, task.id, {
      kind: 'comment',
      note: 'preserve this byte-for-byte: → ç',
      author: 'operator',
      authorKind: 'human',
    });

    const beforeRow = db.query('SELECT * FROM tasks WHERE id = ?').get(task.id) as Record<string, unknown>;
    const beforeEvents = JSON.stringify(getTaskEvents(db, task.id));
    const linked = linkTaskToWish(db, task.id, 'missing-wish', 'group-2', 3_000);
    const afterRow = db.query('SELECT * FROM tasks WHERE id = ?').get(task.id) as Record<string, unknown>;

    expect(linked.wish).toBe('missing-wish');
    expect(linked.group).toBe('group-2');
    expect(afterRow.wish).toBe('missing-wish');
    expect(afterRow.group_name).toBe('group-2');
    expect(afterRow.updated_at).toBe(3_000);
    for (const key of Object.keys(beforeRow)) {
      if (key === 'wish' || key === 'group_name' || key === 'updated_at') continue;
      expect(afterRow[key]).toEqual(beforeRow[key]);
    }
    const afterEvents = getTaskEvents(db, task.id);
    expect(JSON.stringify(afterEvents.slice(0, -1))).toBe(beforeEvents);
    const linkEvent = afterEvents[afterEvents.length - 1];
    expect(linkEvent.kind).toBe('wish');
    expect(linkEvent.note).toBe('(none)→missing-wish#group-2');
    expect(linkEvent.author).toBeNull();
    expect(linkEvent.authorKind).toBeNull();

    const linkedRow = db.query('SELECT * FROM tasks WHERE id = ?').get(task.id) as Record<string, unknown>;
    const repeated = linkTaskToWish(db, task.id, 'missing-wish', 'group-2', 4_000);
    const repeatedRow = db.query('SELECT * FROM tasks WHERE id = ?').get(task.id) as Record<string, unknown>;
    expect(repeated.updatedAt).toBe(3_000);
    expect(repeatedRow).toEqual(linkedRow);
    expect(JSON.stringify(getTaskEvents(db, task.id))).toBe(JSON.stringify(afterEvents));
  });

  test('linkTaskToWish omits the group by storing null and rejects an unknown task', () => {
    const task = createTask(db, { title: 'ungrouped link', wish: 'old', group: 'old-group' });
    const linked = linkTaskToWish(db, task.id, 'old', undefined, 4_000);
    expect(linked.wish).toBe('old');
    expect(linked.group).toBeNull();
    expect(linked.updatedAt).toBe(4_000);
    expect(() => linkTaskToWish(db, 't_missing', 'new-wish')).toThrow(UnknownTaskError);
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

describe('setTaskWish — card identity without delete-and-recreate', () => {
  test('attaches a wish to a wishless card, preserving id/createdAt/claim', async () => {
    const task = createTask(db, { title: 'orphan' });
    claimTask(db, task.id, 'worker-1', { author: HUMAN });
    const claimed = getTask(db, task.id) as TaskRow;
    await Bun.sleep(2);

    const result = setTaskWish(db, task.id, { wish: 'remotty-board-asks', group: 'task-wish-verb' }, HUMAN);
    expect(result.from).toEqual({ wish: null, group: null });
    expect(result.to).toEqual({ wish: 'remotty-board-asks', group: 'task-wish-verb' });

    const after = result.task;
    expect(after.id).toBe(task.id);
    expect(after.createdAt).toBe(task.createdAt);
    expect(after.status).toBe('in_progress');
    expect(after.claimedBy).toBe('worker-1');
    expect(after.claimedAt).toBe(claimed.claimedAt);
    expect(after.wish).toBe('remotty-board-asks');
    expect(after.group).toBe('task-wish-verb');
    expect(after.updatedAt).toBeGreaterThan(claimed.updatedAt);

    // The claim event, then the wish event — old → new on the timeline.
    const events = getTaskEvents(db, task.id);
    expect(events.map((e) => e.kind)).toEqual(['claim', 'wish']);
    expect(events[1].note).toBe('(none)→remotty-board-asks#task-wish-verb');
    expect(events[1].author).toBe('felipe');
    expect(events[1].authorKind).toBe('human');
  });

  test('re-pointing to another wish drops the previous group unless a new one is given', () => {
    const task = createTask(db, { title: 'moving', wish: 'old-wish', group: 'g1' });
    const result = setTaskWish(db, task.id, { wish: 'new-wish', group: null }, HUMAN);
    expect(result.from).toEqual({ wish: 'old-wish', group: 'g1' });
    expect(result.task.wish).toBe('new-wish');
    expect(result.task.group).toBeNull();
    expect(getTaskEvents(db, task.id)[0].note).toBe('old-wish#g1→new-wish');
  });

  test('clearing removes wish and group together', () => {
    const task = createTask(db, { title: 'detaching', wish: 'demo', group: 'g1' });
    const result = setTaskWish(db, task.id, { wish: null, group: null }, HUMAN);
    expect(result.to).toEqual({ wish: null, group: null });
    expect(result.task.wish).toBeNull();
    expect(result.task.group).toBeNull();
    expect(getTaskEvents(db, task.id)[0].note).toBe('demo#g1→(none)');
  });

  test('a group passed alongside a null wish is dropped, never orphaned', () => {
    const task = createTask(db, { title: 'orphan-guard', wish: 'demo', group: 'g1' });
    const result = setTaskWish(db, task.id, { wish: null, group: 'g1' }, HUMAN);
    expect(result.task.group).toBeNull();
    expect(getTaskEvents(db, task.id)[0].note).toBe('demo#g1→(none)');
  });

  test('an attached card is findable by the wish filter', () => {
    const task = createTask(db, { title: 'findable' });
    expect(listTasks(db, { wish: 'demo' })).toHaveLength(0);
    setTaskWish(db, task.id, { wish: 'demo', group: null }, HUMAN);
    expect(listTasks(db, { wish: 'demo' }).map((t) => t.id)).toEqual([task.id]);
  });

  test('rejects an unknown task without touching the timeline', () => {
    expect(() => setTaskWish(db, 't_nope', { wish: 'demo', group: null }, HUMAN)).toThrow(UnknownTaskError);
  });

  test('formatWishRef renders slug#group, bare slug, and the empty identity', () => {
    expect(formatWishRef({ wish: 'demo', group: 'g1' })).toBe('demo#g1');
    expect(formatWishRef({ wish: 'demo', group: null })).toBe('demo');
    expect(formatWishRef({ wish: null, group: null })).toBe('(none)');
  });

  test('the new identity survives an export/import round-trip', () => {
    const task = createTask(db, { title: 'round-trip' });
    setTaskWish(db, task.id, { wish: 'demo', group: 'g1' }, HUMAN);
    const snapshot = exportState(db);

    const other = openDb({ path: join(dir, 'other.db') });
    try {
      importState(other, snapshot);
      const restored = getTask(other, task.id) as TaskRow;
      expect(restored.wish).toBe('demo');
      expect(restored.group).toBe('g1');
      expect(getTaskEvents(other, task.id).map((e) => e.kind)).toEqual(['wish']);
    } finally {
      other.close();
    }
  });
});

describe('deleteTask — hard removal with a dependency refusal', () => {
  function edgeCount(): number {
    return (db.query('SELECT COUNT(*) AS n FROM task_dependencies').get() as { n: number }).n;
  }

  test('removes a leaf card with its edges, timeline, and stage log', () => {
    const dep = createTask(db, { title: 'upstream' });
    const task = createTask(db, { title: 'doomed', dependsOn: [dep.id] });
    appendTaskEvent(db, task.id, { kind: 'comment', note: 'created by mistake', ...HUMAN });
    appendStage(db, task.id, 'planned');

    const result = deleteTask(db, task.id);
    expect(result.task.id).toBe(task.id);
    expect(result.task.title).toBe('doomed');
    expect(result.dependencies).toBe(1);
    expect(result.events).toBe(1);
    expect(result.stages).toBe(1);

    expect(getTask(db, task.id)).toBeNull();
    expect(getTaskEvents(db, task.id)).toEqual([]);
    expect(getStageLog(db, task.id)).toEqual([]);
    expect(edgeCount()).toBe(0);
    // Only the target went: what it depended on is untouched.
    expect(getTask(db, dep.id)?.status).toBe('ready');
  });

  test('refuses a card with dependents, naming them, and changes nothing', () => {
    const target = createTask(db, { title: 'depended-on' });
    const dependent = createTask(db, { title: 'downstream', dependsOn: [target.id] });
    appendTaskEvent(db, target.id, { kind: 'comment', note: 'keep me', ...HUMAN });

    expect(() => deleteTask(db, target.id)).toThrow(TaskHasDependentsError);
    try {
      deleteTask(db, target.id);
    } catch (err) {
      expect(err).toBeInstanceOf(TaskHasDependentsError);
      expect((err as TaskHasDependentsError).dependents).toEqual([dependent.id]);
      expect((err as Error).message).toContain(dependent.id);
      expect((err as Error).message).toContain('1 task depends on it');
    }

    expect(getTask(db, target.id)?.title).toBe('depended-on');
    expect(getTaskEvents(db, target.id)).toHaveLength(1);
    expect(getDependencies(db, dependent.id)).toEqual([target.id]);
    expect(getTask(db, dependent.id)?.status).toBe('blocked');
  });

  test('the refusal message names up to three dependents and counts the rest', () => {
    const target = createTask(db, { title: 'popular' });
    const ids = ['a', 'b', 'c', 'd'].map((t) => createTask(db, { title: t, dependsOn: [target.id] }).id);
    try {
      deleteTask(db, target.id);
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(TaskHasDependentsError);
      expect((err as TaskHasDependentsError).dependents.sort()).toEqual([...ids].sort());
      expect((err as Error).message).toContain('4 tasks depend on it');
      expect((err as Error).message).toContain('+1 more');
    }
  });

  test('the refusal is what prevents a delayed silent unblock (the cascade is real)', () => {
    const target = createTask(db, { title: 'blocker' });
    const dependent = createTask(db, { title: 'waiting', dependsOn: [target.id] });
    const unrelated = createTask(db, { title: 'unrelated' });
    expect(getTask(db, dependent.id)?.status).toBe('blocked');

    // Bypass deleteTask exactly as a hand-edited snapshot or a raw DELETE would:
    // ON DELETE CASCADE erases the edge silently...
    db.query('DELETE FROM tasks WHERE id = ?').run(target.id);
    expect(edgeCount()).toBe(0);
    expect(getTask(db, dependent.id)?.status).toBe('blocked');

    // ...and the next recompute — which `task done` on ANY card runs — promotes
    // the orphaned dependent to ready with nothing on its timeline saying why.
    completeTask(db, unrelated.id);
    expect(getTask(db, dependent.id)?.status).toBe('ready');
  });

  test('deletes a claimed, in-progress card without requiring a release first', () => {
    const task = createTask(db, { title: 'claimed by mistake' });
    claimTask(db, task.id, 'w1', { author: HUMAN });
    expect(getTask(db, task.id)?.status).toBe('in_progress');

    expect(deleteTask(db, task.id).task.claimedBy).toBe('w1');
    expect(getTask(db, task.id)).toBeNull();
  });

  test('rejects an unknown id and removes nothing', () => {
    const survivor = createTask(db, { title: 'survivor' });
    expect(() => deleteTask(db, 't_nope')).toThrow(UnknownTaskError);
    expect(listTasks(db)).toHaveLength(1);
    expect(getTask(db, survivor.id)).not.toBeNull();
  });

  test('a deleted card is gone from export, so the snapshot never carries it', () => {
    const keep = createTask(db, { title: 'keep' });
    const drop = createTask(db, { title: 'drop' });
    appendTaskEvent(db, drop.id, { kind: 'comment', note: 'oops', ...HUMAN });

    deleteTask(db, drop.id);
    const snapshot = exportState(db);
    expect(snapshot.tasks.map((t) => t.id)).toEqual([keep.id]);
    expect(snapshot.task_events.filter((e) => e.task_id === drop.id)).toEqual([]);
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

describe('runtime layer — liveness (pure, injected timestamps)', () => {
  const NOW = 10_000_000;

  test('classifies running / idle / stale purely from heartbeat age', () => {
    expect(livenessFromHeartbeat(NOW, NOW)).toBe('running');
    expect(livenessFromHeartbeat(NOW - (LIVENESS_RUNNING_MS - 1), NOW)).toBe('running');
    // At exactly the running boundary it is no longer running → idle.
    expect(livenessFromHeartbeat(NOW - LIVENESS_RUNNING_MS, NOW)).toBe('idle');
    expect(livenessFromHeartbeat(NOW - (LIVENESS_STALE_MS - 1), NOW)).toBe('idle');
    // At/after the stale boundary → stale.
    expect(livenessFromHeartbeat(NOW - LIVENESS_STALE_MS, NOW)).toBe('stale');
    expect(livenessFromHeartbeat(NOW - 9 * 24 * 60 * 60 * 1000, NOW)).toBe('stale');
  });

  test('a claimed card that never pulsed (null heartbeat) reads stale — the zombie', () => {
    expect(livenessFromHeartbeat(null, NOW)).toBe('stale');
  });

  test('recordHeartbeat writes heartbeat_at, visible on the card projection', () => {
    const a = createTask(db, { title: 'a' });
    expect(getTaskCard(db, a.id)?.heartbeatAt).toBeNull();
    const t = recordHeartbeat(db, a.id, NOW);
    expect(t).toBe(NOW);
    expect(getTaskCard(db, a.id)?.heartbeatAt).toBe(NOW);
  });

  test('recordHeartbeat rejects an unknown task', () => {
    expect(() => recordHeartbeat(db, 't_nope')).toThrow(UnknownTaskError);
  });
});

describe('runtime layer — enforced blocks + carved checkout exception', () => {
  test('blockTask stores provenance + reason and appends a block event', () => {
    const a = createTask(db, { title: 'a' });
    blockTask(db, a.id, 'waiting on design', { author: 'felipe', authorKind: 'human' });
    const card = getTaskCard(db, a.id);
    expect(card?.blockedBy).toBe('felipe');
    expect(card?.blockedReason).toBe('waiting on design');
    const events = getTaskEvents(db, a.id);
    expect(events.at(-1)?.kind).toBe('block');
    expect(events.at(-1)?.note).toBe('waiting on design');
  });

  test('an anonymous blocker still sets a non-null blocked_by (gate can never be defeated)', () => {
    const a = createTask(db, { title: 'a' });
    blockTask(db, a.id, 'r', { author: null, authorKind: 'human' });
    expect(getTaskCard(db, a.id)?.blockedBy).toBe('human');
  });

  test('checkout refuses a blocked card with TaskBlockedError carrying the reason', () => {
    const a = createTask(db, { title: 'a' });
    blockTask(db, a.id, 'needs review', { author: 'eng-B', authorKind: 'claude-code' });
    expect(getTask(db, a.id)?.status).toBe('ready'); // block does not change status
    try {
      claimTask(db, a.id, 'w1');
      throw new Error('expected TaskBlockedError');
    } catch (err) {
      expect(err).toBeInstanceOf(TaskBlockedError);
      expect((err as TaskBlockedError).blockedBy).toBe('eng-B');
      expect((err as TaskBlockedError).reason).toBe('needs review');
      expect((err as Error).message).toContain('needs review');
    }
    // Refusal leaves the card unclaimed — the gate did not partially mutate.
    expect(getTask(db, a.id)?.claimedBy).toBeNull();
    expect(getTask(db, a.id)?.status).toBe('ready');
  });

  test('unblock clears the block and restores checkout', () => {
    const a = createTask(db, { title: 'a' });
    blockTask(db, a.id, 'r', HUMAN);
    unblockTask(db, a.id, HUMAN);
    const card = getTaskCard(db, a.id);
    expect(card?.blockedBy).toBeNull();
    expect(card?.blockedReason).toBeNull();
    expect(card?.enforcedBlock).toBeNull();
    expect(getTaskEvents(db, a.id).at(-1)?.kind).toBe('unblock');
    // The kind is cleared with the block, not left behind for the next one.
    expect(rawBlockKind(db, a.id)).toBeNull();
    // Now claimable again.
    expect(claimTask(db, a.id, 'w1').status).toBe('in_progress');
  });
});

/** The stored `block_kind` cell, read past the projection so defaults are visible. */
function rawBlockKind(handle: Database, taskId: string): string | null {
  const row = handle.query('SELECT block_kind FROM tasks WHERE id = ?').get(taskId) as { block_kind: string | null };
  return row.block_kind;
}

describe('block kinds — work vs hold', () => {
  test('an omitted kind stores and projects the work default', () => {
    const a = createTask(db, { title: 'a' });
    blockTask(db, a.id, 'needs a decision', HUMAN);
    expect(rawBlockKind(db, a.id)).toBe('work');
    expect(getTaskCard(db, a.id)?.enforcedBlock).toEqual({ reason: 'needs a decision', kind: 'work' });
  });

  test('an explicit hold is stored and projected as a hold', () => {
    const a = createTask(db, { title: 'a' });
    blockTask(db, a.id, 'parked until Q3', HUMAN, 'hold');
    expect(rawBlockKind(db, a.id)).toBe('hold');
    expect(getTaskCard(db, a.id)?.enforcedBlock).toEqual({ reason: 'parked until Q3', kind: 'hold' });
  });

  test('a hold refuses checkout exactly like a work block', () => {
    const held = createTask(db, { title: 'held' });
    const broken = createTask(db, { title: 'broken' });
    blockTask(db, held.id, 'parked', HUMAN, 'hold');
    blockTask(db, broken.id, 'parked', HUMAN, 'work');
    for (const id of [held.id, broken.id]) {
      expect(() => claimTask(db, id, 'w1')).toThrow(TaskBlockedError);
      expect(getTask(db, id)?.claimedBy).toBeNull();
    }
  });

  test('a block of either kind leaves the lifecycle status untouched', () => {
    const a = createTask(db, { title: 'a' });
    blockTask(db, a.id, 'parked', HUMAN, 'hold');
    expect(getTask(db, a.id)?.status).toBe('ready');
  });

  test('a NULL or unrecognized stored kind normalizes to work (the column is untrusted TEXT)', () => {
    const legacy = createTask(db, { title: 'legacy' });
    const garbage = createTask(db, { title: 'garbage' });
    // A row an older build blocked (no kind column) and a hand-merged roadmap.json.
    db.query("UPDATE tasks SET blocked_by = 'felipe', blocked_reason = 'r' WHERE id = ?").run(legacy.id);
    db.query("UPDATE tasks SET blocked_by = 'felipe', blocked_reason = 'r', block_kind = 'HOLD' WHERE id = ?").run(
      garbage.id,
    );
    expect(getTaskCard(db, legacy.id)?.enforcedBlock).toEqual({ reason: 'r', kind: 'work' });
    expect(getTaskCard(db, garbage.id)?.enforcedBlock).toEqual({ reason: 'r', kind: 'work' });
  });

  test('a block stored without a reason still projects a block (presence keys on blocked_by)', () => {
    const a = createTask(db, { title: 'a' });
    db.query("UPDATE tasks SET blocked_by = 'felipe' WHERE id = ?").run(a.id);
    expect(getTaskCard(db, a.id)?.enforcedBlock).toEqual({ reason: '', kind: 'work' });
  });
});

describe('lane projection carries enforcedBlock', () => {
  test('blocked cards project reason + kind; unblocked cards project null', () => {
    const road = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
    const open = createTask(db, { title: 'open', boardId: road.id, lane: 'Idea' });
    const held = createTask(db, { title: 'held', boardId: road.id, lane: 'Idea' });
    blockTask(db, held.id, 'parked until Q3', HUMAN, 'hold');

    const byId = new Map(listTasksWithLane(db, { boardId: road.id }).map((t) => [t.id, t]));
    expect(byId.get(open.id)?.enforcedBlock).toBeNull();
    expect(byId.get(held.id)?.enforcedBlock).toEqual({ reason: 'parked until Q3', kind: 'hold' });
  });

  test('the lane projection gains ONLY enforcedBlock — provenance and heartbeat stay off it', () => {
    const a = createTask(db, { title: 'a' });
    blockTask(db, a.id, 'r', HUMAN, 'hold');
    recordHeartbeat(db, a.id);
    const row = listTasksWithLane(db).find((t) => t.id === a.id) as unknown as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual([
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

  test('the frozen TaskRow path never gains enforcedBlock', () => {
    const a = createTask(db, { title: 'a' });
    blockTask(db, a.id, 'r', HUMAN, 'hold');
    const frozen = listTasks(db).find((t) => t.id === a.id) as unknown as Record<string, unknown>;
    expect('enforcedBlock' in frozen).toBe(false);
    expect('lane' in frozen).toBe(false);
  });
});

describe('block_kind is an additive v1 column', () => {
  test('a v1 DB predating the column regains it on open, with no user_version change', () => {
    const path = join(dir, 'pre-kind.db');
    const seed = openDb({ path });
    const a = createTask(seed, { title: 'a' });
    blockTask(seed, a.id, 'r', HUMAN, 'hold');
    // Roll the file back to a v1 DB written before the column existed.
    seed.exec('ALTER TABLE tasks DROP COLUMN block_kind');
    expect(isCurrentGenieDb(seed)).toBe(false); // schemaIsCurrent stays in lockstep
    seed.close();

    const reopened = openDb({ path });
    const version = (reopened.query('PRAGMA user_version').get() as { user_version: number }).user_version;
    const columns = (reopened.query('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((c) => c.name);
    // The backfilled column is NULL, so the pre-existing block reads as `work`.
    const card = getTaskCard(reopened, a.id);
    // A second open is a no-op — the backfill is idempotent.
    ensureSchema(reopened);
    const stillOnce = (reopened.query('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).filter(
      (c) => c.name === 'block_kind',
    ).length;
    reopened.close();

    expect(version).toBe(1);
    expect(columns).toContain('block_kind');
    expect(card?.enforcedBlock).toEqual({ reason: 'r', kind: 'work' });
    expect(stillOnce).toBe(1);
  });

  test('export carries block_kind and round-trips it through import', () => {
    const a = createTask(db, { title: 'a' });
    blockTask(db, a.id, 'parked', HUMAN, 'hold');
    const snapshot = exportState(db);
    expect(snapshot.tasks[0].block_kind).toBe('hold');

    const path = join(dir, 'round-trip.db');
    const fresh = openDb({ path });
    importState(fresh, snapshot);
    const card = getTaskCard(fresh, a.id);
    fresh.close();
    expect(card?.enforcedBlock).toEqual({ reason: 'parked', kind: 'hold' });
  });

  test('a same-version snapshot whose tasks omit block_kind imports cleanly as work', () => {
    const a = createTask(db, { title: 'a' });
    blockTask(db, a.id, 'r', HUMAN, 'hold');
    const snapshot = exportState(db);
    // An older build at the same schemaVersion never wrote the key at all.
    const older = {
      ...snapshot,
      tasks: snapshot.tasks.map(({ block_kind: _dropped, ...rest }) => rest),
    } as unknown as typeof snapshot;

    const path = join(dir, 'older-snapshot.db');
    const fresh = openDb({ path });
    const summary = importState(fresh, older);
    const card = getTaskCard(fresh, a.id);
    fresh.close();
    expect(summary.tasks).toBe(1);
    expect(card?.enforcedBlock).toEqual({ reason: 'r', kind: 'work' });
  });
});

describe('runtime layer — claim / release timeline events', () => {
  test('a winning checkout appends a claim event carrying the runtime author', () => {
    const a = createTask(db, { title: 'a' });
    claimTask(db, a.id, 'w1', { author: { author: 'eng-B', authorKind: 'claude-code' } });
    const claim = getTaskEvents(db, a.id).find((e) => e.kind === 'claim');
    expect(claim).toBeDefined();
    expect(claim?.author).toBe('eng-B');
    expect(claim?.authorKind).toBe('claude-code');
  });

  test('a lost claim appends NO claim event (event is inside the winning transaction)', () => {
    const a = createTask(db, { title: 'a' });
    claimTask(db, a.id, 'w1');
    const before = getTaskEvents(db, a.id).filter((e) => e.kind === 'claim').length;
    expect(() => claimTask(db, a.id, 'w2')).toThrow(CheckoutConflictError);
    const after = getTaskEvents(db, a.id).filter((e) => e.kind === 'claim').length;
    expect(after).toBe(before); // no phantom claim from the loser
  });

  test('completeTask appends a release event; recompute still runs', () => {
    const a = createTask(db, { title: 'a' });
    const b = createTask(db, { title: 'b', dependsOn: [a.id] });
    completeTask(db, a.id, HUMAN);
    expect(getTaskEvents(db, a.id).at(-1)?.kind).toBe('release');
    expect(getTask(db, b.id)?.status).toBe('ready'); // dependency gate untouched
  });

  test('releaseTask returns an in_progress card to ready and appends a release event', () => {
    const a = createTask(db, { title: 'a' });
    claimTask(db, a.id, 'w1');
    const released = releaseTask(db, a.id, HUMAN);
    expect(released.status).toBe('ready');
    expect(released.claimedBy).toBeNull();
    expect(getTaskEvents(db, a.id).at(-1)?.kind).toBe('release');
  });

  test('releaseTask clears heartbeat_at so the next owner does not inherit stale liveness', () => {
    const a = createTask(db, { title: 'a' });
    claimTask(db, a.id, 'w1');
    recordHeartbeat(db, a.id, 10_000_000);
    expect(getTaskCard(db, a.id)?.heartbeatAt).toBe(10_000_000);

    releaseTask(db, a.id, HUMAN);
    // The card is back to ready with no lingering pulse; a fresh checkout by
    // worker B must read stale (never running) until B itself heartbeats.
    expect(getTaskCard(db, a.id)?.heartbeatAt).toBeNull();

    claimTask(db, a.id, 'w2');
    expect(getTaskCard(db, a.id)?.heartbeatAt).toBeNull();
  });

  test('releaseTask REFUSES a done card — never resurrects it, emits no release event', () => {
    const a = createTask(db, { title: 'a' });
    claimTask(db, a.id, 'w1');
    // The fence refuses identity-less completion of a claimed card — the setup
    // must pass the matching claimant identity to reach the done state.
    completeTask(db, a.id, { author: 'w1', authorKind: 'human' }); // in_progress → done (+ one 'release' event, note 'completed')
    const releaseEventsBefore = getTaskEvents(db, a.id).filter((e) => e.kind === 'release').length;

    expect(() => releaseTask(db, a.id, HUMAN)).toThrow(TaskReleaseError);
    expect(getTask(db, a.id)!.status).toBe('done'); // NOT resurrected to ready
    // The refused release must leave no phantom timeline event.
    expect(getTaskEvents(db, a.id).filter((e) => e.kind === 'release').length).toBe(releaseEventsBefore);
  });

  test('releaseTask REFUSES a ready card (no live claim to hand back)', () => {
    const a = createTask(db, { title: 'a' }); // starts ready, never claimed
    expect(() => releaseTask(db, a.id, HUMAN)).toThrow(TaskReleaseError);
    expect(getTask(db, a.id)!.status).toBe('ready');
    expect(getTaskEvents(db, a.id).some((e) => e.kind === 'release')).toBe(false);
  });

  test('commentCounts tallies only comment events, keyed by task', () => {
    const a = createTask(db, { title: 'a' });
    const b = createTask(db, { title: 'b' });
    appendTaskEvent(db, a.id, { kind: 'comment', note: '1' });
    appendTaskEvent(db, a.id, { kind: 'comment', note: '2' });
    appendTaskEvent(db, a.id, { kind: 'move', note: 'x' }); // not counted
    appendTaskEvent(db, b.id, { kind: 'report', note: 'r' }); // not counted
    const counts = commentCounts(db);
    expect(counts.get(a.id)).toBe(2);
    expect(counts.has(b.id)).toBe(false);
  });
});

describe('completeTask is orchestrator-authoritative (status CAS only)', () => {
  const WORKER_A = { author: 'worker-a', authorKind: 'claude-code' };
  const ORCHESTRATOR = { author: 'orchestrator', authorKind: 'claude-code' };

  test('the documented two-actor flow: a worker claims, the orchestrator completes', () => {
    const a = createTask(db, { title: 'a' });
    claimTask(db, a.id, 'worker-a', { author: WORKER_A });

    // `task done` is the orchestrator's verb — the completing identity is
    // routinely NOT the claimant and must not be fenced out.
    const done = completeTask(db, a.id, ORCHESTRATOR);
    expect(done.status).toBe('done');
    const release = getTaskEvents(db, a.id).at(-1);
    expect(release?.kind).toBe('release');
    expect(release?.author).toBe('orchestrator');
  });

  test('identity-less completion of a claimed card succeeds (bare `genie task done`)', () => {
    const a = createTask(db, { title: 'a' });
    claimTask(db, a.id, 'w1');
    expect(completeTask(db, a.id).status).toBe('done');
  });

  test('identity-less completion of an UNCLAIMED ready card succeeds', () => {
    const a = createTask(db, { title: 'a' });
    expect(completeTask(db, a.id).status).toBe('done');
  });

  test('completing an already-done card throws the typed error (status CAS)', () => {
    const a = createTask(db, { title: 'a' });
    completeTask(db, a.id, HUMAN); // ready + unclaimed → succeeds
    expect(() => completeTask(db, a.id, HUMAN)).toThrow(TaskCompleteError);
    expect(getTask(db, a.id)!.status).toBe('done');
    // Exactly one release event — the refused completion added none.
    expect(getTaskEvents(db, a.id).filter((e) => e.kind === 'release').length).toBe(1);
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

describe('exportState — task_events additive, stage_log retained', () => {
  test('export carries BOTH stage_log and task_events (row 12: keep stage_log, gain task_events)', () => {
    const a = createTask(db, { title: 'a' });
    appendStage(db, a.id, 'planned', 'kickoff'); // legacy stage_log
    appendTaskEvent(db, a.id, { kind: 'comment', note: 'live event', author: 'x', authorKind: 'human' });

    const state = exportState(db);
    expect(state.stage_log.map((s) => s.stage)).toContain('planned');
    expect(state.task_events.map((e) => e.note)).toContain('live event');
    // The board `boards` export gains the additive lanes column (typed-export NIT fix).
    const road = createBoard(db, 'road', DEFAULT_LIFECYCLE_LANES);
    createTask(db, { title: 'c', boardId: road.id });
    const withLanes = exportState(db).boards.find((b) => b.name === 'road');
    expect(withLanes?.lanes).toBeTypeOf('string'); // JSON-encoded lane list, not undefined
  });
});

describe('stage_log → task_events one-time backfill (idempotent)', () => {
  test('migrates existing stage_log rows once, preserving created_at and mapping kinds', () => {
    const a = createTask(db, { title: 'a' });
    // Simulate a pre-backfill DB: real stage_log history + guard removed so the
    // next ensureSchema performs the one-time migration (as an old DB would).
    appendStage(db, a.id, 'planned', 'kickoff'); // unknown kind → comment, label preserved
    appendStage(db, a.id, 'report', 'meeseeks done'); // known kind → report
    appendStage(db, a.id, 'implemented'); // unknown kind, no note → comment, note = label
    db.query("DELETE FROM meta WHERE key = 'stage_log_backfill_v1'").run();
    const stageRows = getStageLog(db, a.id);

    ensureSchema(db); // triggers the guarded backfill

    const events = getTaskEvents(db, a.id);
    const byNote = Object.fromEntries(events.map((e) => [e.note, e]));
    expect(byNote['planned: kickoff']?.kind).toBe('comment'); // label folded into note
    expect(byNote['meeseeks done']?.kind).toBe('report'); // known kind mapped directly
    expect(byNote.implemented?.kind).toBe('comment'); // label becomes the note
    // created_at is preserved from the source stage rows.
    expect(events.map((e) => e.createdAt).sort()).toEqual(stageRows.map((s) => s.createdAt).sort());
    // Historical rows carry no author attribution.
    expect(events.every((e) => e.author === null && e.authorKind === null)).toBe(true);

    // Idempotent: a second ensureSchema (guard now set) duplicates nothing.
    const count = events.length;
    ensureSchema(db);
    expect(getTaskEvents(db, a.id).length).toBe(count);
  });

  test('importing a legacy snapshot (stage_log, no task_events) mirrors the timeline on the SAME handle', () => {
    const a = createTask(db, { title: 'a' });
    appendStage(db, a.id, 'planned', 'kickoff');
    const legacy = { ...exportState(db), task_events: [] };

    const path = join(dir, 'legacy-import.db');
    const fresh = openDb({ path });
    const summary = importState(fresh, legacy);
    expect(summary.events).toBe(0); // summary counts snapshot rows, not mirrored ones

    // The backfill runs inside the import transaction, so the importing handle
    // sees the mirrored timeline immediately — deferring it to the next openDb
    // left this handle empty and let syncRoadmap record a pre-backfill baseline
    // that the git-hook `task sync` answered with a spurious roadmap rewrite.
    const sameHandle = getTaskEvents(fresh, a.id);
    fresh.close();
    expect(sameHandle.map((e) => e.kind)).toEqual(['comment']);
    expect(sameHandle[0]?.note).toBe('planned: kickoff');

    // Durable on disk, and the re-stamped marker makes the reopen a no-op —
    // the migration never runs twice.
    const reopened = openDb({ path });
    const events = getTaskEvents(reopened, a.id);
    reopened.close();
    expect(events.map((e) => e.kind)).toEqual(['comment']);
  });
});

describe('hire roster (single-row upsert / delete)', () => {
  test('hireAgent creates a row and round-trips', () => {
    const hired = hireAgent(db, {
      wish: 'genie-ui-bridge',
      agentAdapterId: 'claude',
      profile: 'opus',
      worktree: '/wt/g1',
    });
    expect(hired).toEqual({
      wish: 'genie-ui-bridge',
      agentAdapterId: 'claude',
      profile: 'opus',
      worktree: '/wt/g1',
      hiredAt: hired.hiredAt,
      state: 'hired',
    });
    expect(getHire(db, 'genie-ui-bridge', 'claude')).toEqual(hired);
  });

  test('profile is nullable', () => {
    const hired = hireAgent(db, { wish: 'w', agentAdapterId: 'codex', worktree: '/wt/x' });
    expect(hired.profile).toBeNull();
  });

  test('hireAgent is idempotent — re-hire keeps one row and preserves hired_at', () => {
    const first = hireAgent(db, { wish: 'w', agentAdapterId: 'a', worktree: '/wt/1', state: 'hired' });
    // Re-hire with changed fields: still exactly one row, original hired_at preserved.
    const second = hireAgent(db, { wish: 'w', agentAdapterId: 'a', worktree: '/wt/2', state: 'active' });
    expect(listHires(db, 'w').length).toBe(1);
    expect(second.hiredAt).toBe(first.hiredAt);
    expect(second.worktree).toBe('/wt/2');
    expect(second.state).toBe('active');
  });

  test('unhireAgent removes the row and is idempotent', () => {
    hireAgent(db, { wish: 'w', agentAdapterId: 'a', worktree: '/wt/1' });
    expect(unhireAgent(db, 'w', 'a')).toBe(true);
    expect(getHire(db, 'w', 'a')).toBeNull();
    // Deleting an absent hire is a no-op returning false, never an error.
    expect(unhireAgent(db, 'w', 'a')).toBe(false);
  });

  test('listHires scopes by wish and orders stably', () => {
    hireAgent(db, { wish: 'w1', agentAdapterId: 'b', worktree: '/wt/b' });
    hireAgent(db, { wish: 'w1', agentAdapterId: 'a', worktree: '/wt/a' });
    hireAgent(db, { wish: 'w2', agentAdapterId: 'c', worktree: '/wt/c' });
    expect(listHires(db, 'w1').map((h) => h.agentAdapterId)).toEqual(['a', 'b']);
    expect(listHires(db).map((h) => `${h.wish}:${h.agentAdapterId}`)).toEqual(['w1:a', 'w1:b', 'w2:c']);
  });

  test('exportState includes hire_roster rows', () => {
    hireAgent(db, { wish: 'w', agentAdapterId: 'a', profile: 'p', worktree: '/wt/a', state: 'hired' });
    const snapshot = exportState(db);
    expect(snapshot.hire_roster).toEqual([
      {
        wish: 'w',
        agent_adapter_id: 'a',
        profile: 'p',
        worktree: '/wt/a',
        hired_at: snapshot.hire_roster[0].hired_at,
        state: 'hired',
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Multi-PROCESS roster write vs task-create race: concurrent bun processes hire
// agents and create tasks against the same on-disk WAL database. Every writer
// must succeed cleanly — WAL + busy_timeout serialize them into ordered commits,
// never a SQLITE_BUSY failure or a corrupt row. Proves the single-statement
// roster upsert inherits the handle's concurrency contract (sqlite-open.ts).
// ---------------------------------------------------------------------------
describe('multi-process roster write vs task-create concurrency', () => {
  test('concurrent hires and task-creates all commit with no busy-failure', async () => {
    const dbPath = join(dir, 'roster-race.db');
    const seed = openDb({ path: dbPath });
    seed.close(); // checkpoint so child processes see a committed, current schema

    const gdbPath = join(import.meta.dir, 'genie-db.ts');
    const tsPath = join(import.meta.dir, 'task-state.ts');
    const workerPath = join(dir, 'roster-worker.ts');
    writeFileSync(
      workerPath,
      `
import { openDb } from ${JSON.stringify(gdbPath)};
import { hireAgent, createTask } from ${JSON.stringify(tsPath)};
const [dbPath, op, idx] = process.argv.slice(2);
const db = openDb({ path: dbPath });
try {
  if (op === 'hire') hireAgent(db, { wish: 'race', agentAdapterId: 'a' + idx, worktree: '/wt/' + idx });
  else createTask(db, { title: 'task-' + idx, wish: 'race' });
  process.stdout.write('OK');
} catch (e) {
  process.stdout.write('ERR:' + (e && e.message));
  process.exitCode = 3;
} finally {
  db.close();
}
`,
    );

    const N = 8;
    const runs = Array.from({ length: N }, (_, i) => {
      const op = i % 2 === 0 ? 'hire' : 'create';
      const proc = Bun.spawn(['bun', 'run', workerPath, dbPath, op, String(i)], { stdout: 'pipe', stderr: 'pipe' });
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

    const ok = outcomes.filter((o) => o.startsWith('OK')).length;
    if (ok !== N) {
      console.error('roster-race outcomes:', JSON.stringify(outcomes));
      for (const s of settled) {
        if (s.status === 'fulfilled' && !s.value.out.startsWith('OK')) console.error('straggler stderr:', s.value.err);
      }
    }
    // Every writer committed cleanly — no SQLITE_BUSY leak, no corruption.
    expect(ok).toBe(N);
    expect(outcomes.some((o) => o.includes('SQLITE_BUSY'))).toBe(false);

    // Final state is consistent: 4 hires + 4 tasks, all under the 'race' wish.
    const verify = openDb({ path: dbPath });
    const snapshot = exportState(verify);
    verify.close();
    expect(snapshot.hire_roster.length).toBe(N / 2);
    expect(snapshot.tasks.length).toBe(N / 2);
    expect(snapshot.hire_roster.every((h) => h.wish === 'race')).toBe(true);
  }, 30_000);
});

describe('importState — replace is a full wipe even without operational rows', () => {
  test('stale meta keys do not survive a --replace into a metadata-only db', () => {
    // Source db: one task, then export. Its meta carries the backfill marker.
    const source = openDb({ path: join(dir, 'source.db') });
    createTask(source, { title: 'canonical card' });
    const snapshot = exportState(source);
    source.close();

    // Destination db: NO operational rows, but a stale meta key (e.g. a
    // wish_sig left behind after its rows were cleared elsewhere).
    db.query('INSERT INTO meta (key, value) VALUES (?, ?)').run('wish_sig:ghost', 'deadbeef');

    importState(db, snapshot, { replace: true });

    const keys = (db.query('SELECT key FROM meta ORDER BY key').all() as Array<{ key: string }>).map((r) => r.key);
    expect(keys).toEqual(snapshot.meta.map((m) => m.key).sort());
    expect(keys).not.toContain('wish_sig:ghost');
    // The export is now the exact snapshot — lossless replacement.
    expect(exportState(db)).toEqual(snapshot);
  });

  test('a malformed row that passes shape validation fails as SnapshotFormatError and rolls back', () => {
    const before = exportState(db);
    const bad = {
      ...before,
      // title NOT NULL in schema — null must not surface as a raw SQLite error.
      tasks: [{ id: 't_bad', title: null, status: 'ready', created_at: 1, updated_at: 1 }],
    };
    expect(() => importState(db, bad as unknown, { replace: true })).toThrow(/Snapshot rows could not be imported/);
    expect(exportState(db)).toEqual(before); // transaction rolled back
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

  test('two concurrent checkouts of a BLOCKED card both refuse cleanly (no SQLITE_BUSY flake)', async () => {
    const dbPath = join(dir, 'blocked-race.db');
    const seed = openDb({ path: dbPath });
    const task = createTask(seed, { title: 'contended-blocked' });
    blockTask(seed, task.id, 'held for review', { author: 'eng-B', authorKind: 'claude-code' });
    seed.close();

    const gdbPath = join(import.meta.dir, 'genie-db.ts');
    const tsPath = join(import.meta.dir, 'task-state.ts');
    const workerPath = join(dir, 'blocked-worker.ts');
    writeFileSync(
      workerPath,
      `
import { openDb } from ${JSON.stringify(gdbPath)};
import { claimTask, TaskBlockedError, CheckoutConflictError } from ${JSON.stringify(tsPath)};
const [dbPath, taskId, worker] = process.argv.slice(2);
const db = openDb({ path: dbPath });
try {
  claimTask(db, taskId, worker);
  process.stdout.write('WON');
} catch (e) {
  if (e instanceof TaskBlockedError) process.stdout.write('BLOCKED');
  else if (e instanceof CheckoutConflictError) process.stdout.write('CONFLICT');
  else { process.stdout.write('ERR:' + (e && e.message)); process.exitCode = 3; }
} finally {
  db.close();
}
`,
    );

    const runs = Array.from({ length: 2 }, (_, i) => {
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
      s.status === 'fulfilled' ? `${s.value.out}(exit ${s.value.code})` : 'REJECTED',
    );
    if (!outcomes.every((o) => o.startsWith('BLOCKED')))
      console.error('blocked-race outcomes:', JSON.stringify(outcomes));

    // Both refuse with the typed enforced-block error — never a win, never a raw SQLITE_BUSY leak.
    expect(outcomes.filter((o) => o.startsWith('BLOCKED')).length).toBe(2);
    expect(outcomes.some((o) => o.startsWith('WON') || o.startsWith('ERR'))).toBe(false);

    const verify = openDb({ path: dbPath });
    const finalTask = getTask(verify, task.id)!;
    verify.close();
    expect(finalTask.status).toBe('ready'); // untouched — still blocked, never claimed
    expect(finalTask.claimedBy).toBeNull();
  }, 30_000);

  // Two real processes race `done` vs `release` on ONE in_progress card. The
  // release worker spins (bounded, no fixed sleep) until it observes `done`
  // committed, then attempts its release — this reproduces the EXACT reported
  // corruption window: a completed card whose concurrent release once fired an
  // unconditional `status='ready'` write, resurrecting it. With the conditional
  // CAS the release must refuse: final status stays `done`, exactly one release
  // event exists (completeTask's), and no `ready` is ever observable.
  test('done vs release race — a completed card is NEVER resurrected to ready', async () => {
    const dbPath = join(dir, 'done-release-race.db');
    const seed = openDb({ path: dbPath });
    const task = createTask(seed, { title: 'contended-done-release' });
    claimTask(seed, task.id, 'w1'); // in_progress, held by w1
    seed.close();

    const gdbPath = join(import.meta.dir, 'genie-db.ts');
    const tsPath = join(import.meta.dir, 'task-state.ts');

    const doneWorkerPath = join(dir, 'done-worker.ts');
    writeFileSync(
      doneWorkerPath,
      `
import { openDb } from ${JSON.stringify(gdbPath)};
import { completeTask } from ${JSON.stringify(tsPath)};
const [dbPath, taskId] = process.argv.slice(2);
const db = openDb({ path: dbPath });
try {
  completeTask(db, taskId, { author: 'w1', authorKind: 'human' });
  process.stdout.write('WON');
} catch (e) { process.stdout.write('ERR:' + (e && e.message)); process.exitCode = 3; }
finally { db.close(); }
`,
    );

    const releaseWorkerPath = join(dir, 'release-worker.ts');
    writeFileSync(
      releaseWorkerPath,
      `
import { openDb } from ${JSON.stringify(gdbPath)};
import { getTask, releaseTask, TaskReleaseError } from ${JSON.stringify(tsPath)};
const [dbPath, taskId] = process.argv.slice(2);
const db = openDb({ path: dbPath });
try {
  // Spin (bounded, WAL readers never block) until the concurrent \`done\` commits —
  // this lands the release attempt squarely in the post-completion window.
  let sawDone = false;
  for (let i = 0; i < 5_000_000; i++) {
    if (getTask(db, taskId)?.status === 'done') { sawDone = true; break; }
  }
  if (!sawDone) { process.stdout.write('NO_DONE'); process.exitCode = 4; }
  else {
    try {
      releaseTask(db, taskId, { author: 'eng-B', authorKind: 'claude-code' });
      process.stdout.write('WON'); // a WON here is a resurrection — the bug
    } catch (e) {
      if (e instanceof TaskReleaseError) process.stdout.write('REFUSED');
      else { process.stdout.write('ERR:' + (e && e.message)); process.exitCode = 3; }
    }
  }
} finally { db.close(); }
`,
    );

    const spawnWorker = (path: string) => {
      const proc = Bun.spawn(['bun', 'run', path, dbPath, task.id], { stdout: 'pipe', stderr: 'pipe' });
      return (async () => {
        const out = await new Response(proc.stdout).text();
        const err = await new Response(proc.stderr).text();
        const code = await proc.exited;
        return { out, err, code };
      })();
    };

    const settled = await Promise.allSettled([spawnWorker(doneWorkerPath), spawnWorker(releaseWorkerPath)]);
    const [doneRes, releaseRes] = settled.map((s) =>
      s.status === 'fulfilled' ? s.value : { out: 'REJECTED', err: String(s.reason), code: -1 },
    );

    if (doneRes.out !== 'WON' || releaseRes.out !== 'REFUSED') {
      console.error('done-vs-release outcomes:', JSON.stringify({ doneRes, releaseRes }));
    }

    // done wins; release is refused — exactly one winner, the loser gets the typed error.
    expect(doneRes.out).toBe('WON');
    expect(releaseRes.out).toBe('REFUSED');

    const verify = openDb({ path: dbPath });
    const finalTask = getTask(verify, task.id)!;
    const releaseEvents = getTaskEvents(verify, task.id).filter((e) => e.kind === 'release');
    verify.close();

    expect(finalTask.status).toBe('done'); // terminal — no 'ready' resurrection survived
    // Exactly one release event, from completeTask; the refused release added none.
    expect(releaseEvents.length).toBe(1);
    expect(releaseEvents[0].note).toBe('completed');
  }, 30_000);
});
