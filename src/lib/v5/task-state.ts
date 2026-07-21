/**
 * Genie v5 task state — CRUD, dependency edges, ready-set, atomic checkout
 * claim, append-only stage log, and the wish-group execution state machine.
 *
 * Every mutation runs against a `bun:sqlite` handle opened via `genie-db.ts`.
 * Functions take the handle explicitly (dependency injection) so tests can pass
 * an isolated DB and concurrent processes can each open the shared file.
 *
 * Concurrency contract (see TAXONOMY.md): the checkout claim is an atomic
 * conditional UPDATE inside an IMMEDIATE transaction — exactly one concurrent
 * claimant wins, losers receive `CheckoutConflictError`.
 */

import type { Database } from 'bun:sqlite';
import { createHash, randomBytes } from 'node:crypto';

// ============================================================================
// Type boundaries
// ============================================================================

export type TaskStatus = 'blocked' | 'ready' | 'in_progress' | 'done';

export interface TaskRow {
  id: string;
  boardId: string | null;
  title: string;
  status: TaskStatus;
  claimedBy: string | null;
  claimedAt: number | null;
  /** Wish slug this task belongs to, or null. */
  wish: string | null;
  /** Wish-group name this task belongs to, or null. */
  group: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateTaskInput {
  title: string;
  boardId?: string;
  /** Wish slug this task belongs to. */
  wish?: string;
  /** Wish-group name this task belongs to. */
  group?: string;
  /** Initial lifecycle lane placement (only meaningful on a lane-defining board). */
  lane?: string;
  /** IDs of existing tasks this task depends on. Non-empty ⇒ starts `blocked`. */
  dependsOn?: string[];
}

/**
 * A lifecycle lane on a board. `name` is the stored key; `label` overrides the
 * rendered header; `action` names the skill that advances a card out of the lane
 * and is DISPLAY-ONLY — no code path executes it (WISH Decision 1, Scope OUT).
 */
export interface Lane {
  name: string;
  label?: string;
  action?: string;
}

export interface BoardRow {
  id: string;
  name: string;
  /** Ordered lifecycle lanes, or null for a laneless (execution-status) board. */
  lanes: Lane[] | null;
  createdAt: number;
}

/**
 * The canonical genie lifecycle lanes, assigned to a board when `--lanes` is
 * omitted. `action` is a display-only hint (WISH Decision 1). Review/Done carry
 * no advancing skill.
 */
export const DEFAULT_LIFECYCLE_LANES: Lane[] = [
  { name: 'Idea', action: '/brainstorm' },
  { name: 'Brainstorm', action: '/wish' },
  { name: 'Wish', action: '/work' },
  { name: 'Work', action: '/review' },
  { name: 'Review' },
  { name: 'Done' },
];

/** Name of the default board `genie idea` captures into. */
export const ROADMAP_BOARD = 'roadmap';

/**
 * A task row plus its lane placement. Kept SEPARATE from {@link TaskRow} so the
 * frozen TaskRow contract — and the byte-identical laneless board `--json`,
 * MCP, and `task export` shapes that serialize it — never gains a `lane` field.
 * Only the additive lane-grouped render consumes this projection.
 */
export interface LaneTaskRow extends TaskRow {
  lane: string | null;
}

/**
 * A task row plus its lane placement AND runtime layer (identity, heartbeat,
 * enforced block). This is the SEPARATE projection the human board render and
 * `task status` consume so they can badge liveness/blocks — the frozen
 * {@link TaskRow} (board `--json`, MCP, `task export` tasks) never gains these
 * fields (WISH Decision 7). Every field beyond {@link LaneTaskRow} is nullable.
 */
export interface TaskCardRow extends LaneTaskRow {
  agentKind: string | null;
  heartbeatAt: number | null;
  blockedBy: string | null;
  blockedReason: string | null;
}

/**
 * Heartbeat-derived liveness of a claimed card. Never self-reported — a dead
 * session renders dead, killing the zombie `in_progress` lie (WISH Decision 8).
 */
export type Liveness = 'running' | 'idle' | 'stale';

/** A heartbeat newer than this reads as actively running (▶). */
export const LIVENESS_RUNNING_MS = 5 * 60 * 1000;
/** A heartbeat older than this reads as stale/dead (☠); between the two is idle (⏸). */
export const LIVENESS_STALE_MS = 2 * 60 * 60 * 1000;

/**
 * Pure liveness classification from a heartbeat timestamp and the current time.
 * A missing heartbeat on a claimed card is treated as stale — a claim that never
 * pulsed is exactly the zombie this render exists to expose. Deterministic:
 * tests inject `heartbeatAt`/`now`, never sleep.
 */
export function livenessFromHeartbeat(heartbeatAt: number | null, now: number): Liveness {
  if (heartbeatAt == null) return 'stale';
  const age = now - heartbeatAt;
  if (age < LIVENESS_RUNNING_MS) return 'running';
  if (age < LIVENESS_STALE_MS) return 'idle';
  return 'stale';
}

/** An authored, append-only card timeline event. */
export interface TaskEvent {
  id: number;
  taskId: string;
  kind: string;
  note: string | null;
  authorKind: string | null;
  author: string | null;
  createdAt: number;
}

export interface AppendEventInput {
  kind: string;
  note?: string;
  authorKind?: string;
  author?: string;
}

/** Author attribution for a card event. */
export interface EventAuthor {
  author: string | null;
  authorKind: string | null;
}

export interface StageEntry {
  id: number;
  taskId: string;
  stage: string;
  note: string | null;
  createdAt: number;
}

export interface ClaimOptions {
  /**
   * A task stuck `in_progress` whose claim is older than this many ms is
   * eligible for re-claim (crash recovery). Defaults to 15 minutes.
   */
  staleMs?: number;
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: number;
  /** Runtime identity recorded on the emitted `claim` timeline event. */
  author?: EventAuthor;
}

/** Default stale-claim horizon: 15 minutes. */
export const DEFAULT_STALE_MS = 15 * 60 * 1000;

export type WishGroupStatus = 'blocked' | 'ready' | 'in_progress' | 'done';

export interface WishGroupDef {
  name: string;
  dependsOn?: string[];
}

export interface WishGroupRow {
  wish: string;
  name: string;
  status: WishGroupStatus;
  dependsOn: string[];
  assignee: string | null;
  startedAt: number | null;
  completedAt: number | null;
}

// ============================================================================
// Typed errors
// ============================================================================

/** A dependency edge (or wish-group graph) would introduce a cycle. */
export class CycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CycleError';
  }
}

/** A referenced task does not exist. */
export class UnknownTaskError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`Task not found: ${id}`);
    this.name = 'UnknownTaskError';
    this.id = id;
  }
}

/** A referenced board does not exist. */
export class UnknownBoardError extends Error {
  readonly ref: string;
  constructor(ref: string) {
    super(`Board not found: ${ref}`);
    this.name = 'UnknownBoardError';
    this.ref = ref;
  }
}

/** A board with this (UNIQUE) name already exists. */
export class DuplicateBoardError extends Error {
  readonly boardName: string;
  constructor(name: string) {
    super(`Board "${name}" already exists`);
    this.name = 'DuplicateBoardError';
    this.boardName = name;
  }
}

/** An invalid lane reference or a move against a board that defines no lanes. */
export class LaneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaneError';
  }
}

/** Lost the race to claim a task — another worker holds a live claim. */
export class CheckoutConflictError extends Error {
  readonly taskId: string;
  constructor(taskId: string) {
    super(`Task ${taskId} is not claimable (already claimed or not ready)`);
    this.name = 'CheckoutConflictError';
    this.taskId = taskId;
  }
}

/**
 * A task with an enforced block (`blocked_by` set) refused checkout — the single
 * carved exception to the otherwise-untouched claim machine (WISH Decision 5).
 * Carries the provenance and reason so the CLI can tell the operator why.
 */
export class TaskBlockedError extends Error {
  readonly taskId: string;
  readonly blockedBy: string;
  readonly reason: string | null;
  constructor(taskId: string, blockedBy: string, reason: string | null) {
    super(`Task ${taskId} is blocked by ${blockedBy}${reason ? `: ${reason}` : ''} — cannot check out`);
    this.name = 'TaskBlockedError';
    this.taskId = taskId;
    this.blockedBy = blockedBy;
    this.reason = reason;
  }
}

/** A `blocked` task (unmet dependencies) cannot be completed. */
export class TaskNotReadyError extends Error {
  readonly taskId: string;
  constructor(taskId: string) {
    super(`Task ${taskId} is blocked — its dependencies are not all done; cannot complete`);
    this.name = 'TaskNotReadyError';
    this.taskId = taskId;
  }
}

/**
 * A release was refused because the card is not `in_progress` — there is no live
 * claim to hand back. The status is carried so the CLI can tell the operator why
 * (a completed card is the load-bearing case: releasing it would resurrect it).
 */
export class TaskReleaseError extends Error {
  readonly taskId: string;
  readonly status: TaskStatus;
  constructor(taskId: string, status: TaskStatus) {
    const detail = status === 'done' ? 'it is already done' : `it is ${status}, not in progress`;
    super(`Cannot release task ${taskId}: ${detail} — nothing to release`);
    this.name = 'TaskReleaseError';
    this.taskId = taskId;
    this.status = status;
  }
}

/** An invalid wish-group transition was attempted. */
export class WishGroupStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WishGroupStateError';
  }
}

/** The wish's group structure drifted from the signature stored at creation. */
export class WishGroupDriftError extends Error {
  readonly wish: string;
  constructor(wish: string) {
    super(`Wish "${wish}" group structure changed since state was created — re-create wish groups to proceed.`);
    this.name = 'WishGroupDriftError';
    this.wish = wish;
  }
}

// ============================================================================
// IDs
// ============================================================================

/** Time-sortable, collision-resistant id: `<prefix>_<base36 ms><random>`. */
function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
}

// ============================================================================
// Row mapping
// ============================================================================

interface RawTask {
  id: string;
  board_id: string | null;
  title: string;
  status: TaskStatus;
  claimed_by: string | null;
  claimed_at: number | null;
  wish: string | null;
  group_name: string | null;
  lane: string | null;
  agent_kind: string | null;
  heartbeat_at: number | null;
  blocked_by: string | null;
  blocked_reason: string | null;
  created_at: number;
  updated_at: number;
}

function mapTask(row: RawTask): TaskRow {
  return {
    id: row.id,
    boardId: row.board_id,
    title: row.title,
    status: row.status,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    wish: row.wish,
    group: row.group_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================================================
// Boards
// ============================================================================

interface RawBoardRow {
  id: string;
  name: string;
  lanes: string | null;
  created_at: number;
}

/** Parse the stored lanes JSON back into `Lane[]`, tolerating malformed data. */
function parseLanes(raw: string | null): Lane[] | null {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Lane[]) : null;
  } catch {
    return null;
  }
}

function mapBoard(row: RawBoardRow): BoardRow {
  return { id: row.id, name: row.name, lanes: parseLanes(row.lanes), createdAt: row.created_at };
}

/**
 * Create a board, optionally with lifecycle lanes (stored as JSON in the
 * additive `boards.lanes` column). Rejects a duplicate name up front with a
 * typed {@link DuplicateBoardError} rather than surfacing a raw UNIQUE-constraint
 * SqliteError. An empty lane list is normalized to null (laneless board).
 */
export function createBoard(db: Database, name: string, lanes?: Lane[]): BoardRow {
  if (getBoardByName(db, name)) throw new DuplicateBoardError(name);
  const id = newId('b');
  const createdAt = Date.now();
  const normalizedLanes = lanes && lanes.length > 0 ? lanes : null;
  const lanesJson = normalizedLanes ? JSON.stringify(normalizedLanes) : null;
  db.query('INSERT INTO boards (id, name, lanes, created_at) VALUES (?, ?, ?, ?)').run(id, name, lanesJson, createdAt);
  return { id, name, lanes: normalizedLanes, createdAt };
}

export function getBoard(db: Database, id: string): BoardRow | null {
  const row = db.query('SELECT id, name, lanes, created_at FROM boards WHERE id = ?').get(id) as RawBoardRow | null;
  return row ? mapBoard(row) : null;
}

export function getBoardByName(db: Database, name: string): BoardRow | null {
  const row = db.query('SELECT id, name, lanes, created_at FROM boards WHERE name = ?').get(name) as RawBoardRow | null;
  return row ? mapBoard(row) : null;
}

/** Every board, oldest first. Powers `genie board list`. */
export function listBoards(db: Database): BoardRow[] {
  const rows = db
    .query('SELECT id, name, lanes, created_at FROM boards ORDER BY created_at, id')
    .all() as RawBoardRow[];
  return rows.map(mapBoard);
}

/** Count of tasks assigned to a board — the card count for `board list`. */
export function countBoardTasks(db: Database, boardId: string): number {
  return (db.query('SELECT count(*) AS n FROM tasks WHERE board_id = ?').get(boardId) as { n: number }).n;
}

/**
 * Resolve a board by id first, then by unique name. Throws `UnknownBoardError`
 * if neither matches — lets the CLI accept `--board <id-or-name>` uniformly.
 */
export function resolveBoard(db: Database, ref: string): BoardRow {
  const board = getBoard(db, ref) ?? getBoardByName(db, ref);
  if (!board) throw new UnknownBoardError(ref);
  return board;
}

// ============================================================================
// Task CRUD
// ============================================================================

export function createTask(db: Database, input: CreateTaskInput): TaskRow {
  const deps = input.dependsOn ?? [];
  const id = newId('t');
  const now = Date.now();
  const status: TaskStatus = deps.length === 0 ? 'ready' : 'blocked';

  // Validate the board up front so a missing reference surfaces as a typed
  // UnknownBoardError rather than a raw foreign-key SqliteError from the insert.
  if (input.boardId != null && !getBoard(db, input.boardId)) {
    throw new UnknownBoardError(input.boardId);
  }

  const insert = db.transaction(() => {
    db.query(
      `INSERT INTO tasks (id, board_id, title, status, wish, group_name, lane, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.boardId ?? null,
      input.title,
      status,
      input.wish ?? null,
      input.group ?? null,
      input.lane ?? null,
      now,
      now,
    );
    for (const depId of deps) {
      addDependencyInTx(db, id, depId);
    }
  });
  insert();

  return getTask(db, id) as TaskRow;
}

export function getTask(db: Database, id: string): TaskRow | null {
  const row = db.query('SELECT * FROM tasks WHERE id = ?').get(id) as RawTask | null;
  return row ? mapTask(row) : null;
}

export interface TaskFilter {
  status?: TaskStatus;
  boardId?: string;
  wish?: string;
}

function buildTaskWhere(filter: TaskFilter): { where: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.boardId) {
    clauses.push('board_id = ?');
    params.push(filter.boardId);
  }
  if (filter.wish) {
    clauses.push('wish = ?');
    params.push(filter.wish);
  }
  return { where: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '', params };
}

export function listTasks(db: Database, filter: TaskFilter = {}): TaskRow[] {
  const { where, params } = buildTaskWhere(filter);
  const rows = db.query(`SELECT * FROM tasks${where} ORDER BY created_at`).all(...params) as RawTask[];
  return rows.map(mapTask);
}

/**
 * Lane-aware task listing — the same rows as {@link listTasks} plus each card's
 * `lane`. Consumed ONLY by the additive lane-grouped board render; the frozen
 * {@link TaskRow} path (board `--json`, MCP, export) stays byte-identical.
 */
export function listTasksWithLane(db: Database, filter: TaskFilter = {}): LaneTaskRow[] {
  const { where, params } = buildTaskWhere(filter);
  const rows = db.query(`SELECT * FROM tasks${where} ORDER BY created_at`).all(...params) as Array<
    RawTask & { lane: string | null }
  >;
  return rows.map((r) => ({ ...mapTask(r), lane: r.lane ?? null }));
}

/** The card's current lane, or null when unplaced. */
export function getTaskLane(db: Database, id: string): string | null {
  const row = db.query('SELECT lane FROM tasks WHERE id = ?').get(id) as { lane: string | null } | null;
  return row ? (row.lane ?? null) : null;
}

function mapTaskCard(row: RawTask): TaskCardRow {
  return {
    ...mapTask(row),
    lane: row.lane ?? null,
    agentKind: row.agent_kind ?? null,
    heartbeatAt: row.heartbeat_at ?? null,
    blockedBy: row.blocked_by ?? null,
    blockedReason: row.blocked_reason ?? null,
  };
}

/**
 * Card listing with lane + runtime layer — the projection the human board render
 * and `task status` consume. The frozen {@link TaskRow} path (board `--json`,
 * MCP, export) stays byte-identical because it maps through {@link mapTask}, not
 * this one.
 */
export function listTaskCards(db: Database, filter: TaskFilter = {}): TaskCardRow[] {
  const { where, params } = buildTaskWhere(filter);
  const rows = db.query(`SELECT * FROM tasks${where} ORDER BY created_at`).all(...params) as RawTask[];
  return rows.map(mapTaskCard);
}

/** One card with its lane + runtime layer, or null when unknown. */
export function getTaskCard(db: Database, id: string): TaskCardRow | null {
  const row = db.query('SELECT * FROM tasks WHERE id = ?').get(id) as RawTask | null;
  return row ? mapTaskCard(row) : null;
}

// ============================================================================
// Dependencies + cycle rejection
// ============================================================================

function requireTask(db: Database, id: string): void {
  const exists = db.query('SELECT 1 FROM tasks WHERE id = ?').get(id);
  if (!exists) throw new UnknownTaskError(id);
}

/**
 * True if `from` can reach `to` following `depends_on` edges — i.e. `from`
 * already (transitively) depends on `to`. Used to reject cycles pre-insert.
 */
function reaches(db: Database, from: string, to: string): boolean {
  const stmt = db.query('SELECT depends_on_id FROM task_dependencies WHERE task_id = ?');
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const node = stack.pop() as string;
    if (node === to) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    const rows = stmt.all(node) as Array<{ depends_on_id: string }>;
    for (const r of rows) stack.push(r.depends_on_id);
  }
  return false;
}

/** Insert one edge, rejecting self-deps and cycles. Caller owns the transaction. */
function addDependencyInTx(db: Database, taskId: string, dependsOnId: string): void {
  if (taskId === dependsOnId) throw new CycleError(`Task ${taskId} cannot depend on itself`);
  requireTask(db, taskId);
  requireTask(db, dependsOnId);
  // Adding taskId → dependsOnId cycles iff dependsOnId already reaches taskId.
  if (reaches(db, dependsOnId, taskId)) {
    throw new CycleError(`Adding dependency ${taskId} → ${dependsOnId} would create a cycle`);
  }
  db.query('INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)').run(taskId, dependsOnId);
}

/** Public dependency insertion — rejects cycles at insertion time. */
export function addDependency(db: Database, taskId: string, dependsOnId: string): void {
  const tx = db.transaction(() => addDependencyInTx(db, taskId, dependsOnId));
  tx();
}

/** IDs this task directly depends on. */
export function getDependencies(db: Database, taskId: string): string[] {
  const rows = db
    .query('SELECT depends_on_id FROM task_dependencies WHERE task_id = ? ORDER BY depends_on_id')
    .all(taskId) as Array<{ depends_on_id: string }>;
  return rows.map((r) => r.depends_on_id);
}

// ============================================================================
// Ready-set recompute (idempotent + monotonic)
// ============================================================================

/**
 * Promote every `blocked` task whose dependencies are all `done` to `ready`.
 * Monotonic: never demotes `ready`/`in_progress`/`done`. Idempotent: a second
 * call with no intervening change is a no-op. Returns the count promoted.
 */
export function recomputeReady(db: Database): number {
  const now = Date.now();
  const res = db
    .query(
      `UPDATE tasks SET status = 'ready', updated_at = ?
       WHERE status = 'blocked'
         AND NOT EXISTS (
           SELECT 1 FROM task_dependencies td
           JOIN tasks dep ON dep.id = td.depends_on_id
           WHERE td.task_id = tasks.id AND dep.status != 'done'
         )`,
    )
    .run(now);
  return res.changes;
}

export function readyTasks(db: Database): TaskRow[] {
  return listTasks(db, { status: 'ready' });
}

// ============================================================================
// Atomic checkout claim
// ============================================================================

/** Read a task's enforced-block provenance without widening the frozen TaskRow. */
function readBlock(db: Database, taskId: string): { blockedBy: string | null; blockedReason: string | null } | null {
  const row = db.query('SELECT blocked_by, blocked_reason FROM tasks WHERE id = ?').get(taskId) as {
    blocked_by: string | null;
    blocked_reason: string | null;
  } | null;
  return row ? { blockedBy: row.blocked_by ?? null, blockedReason: row.blocked_reason ?? null } : null;
}

/**
 * Translate a lost/blocked claim into the right typed error. An enforced block
 * (`blocked_by` set) is the single carved exception — it takes precedence over a
 * plain conflict so the operator sees the reason, not a generic "not claimable".
 */
function claimFailure(db: Database, taskId: string): never {
  const block = readBlock(db, taskId);
  if (!block) throw new UnknownTaskError(taskId);
  if (block.blockedBy != null) throw new TaskBlockedError(taskId, block.blockedBy, block.blockedReason);
  throw new CheckoutConflictError(taskId);
}

/**
 * Atomically claim a task for a worker. Wins iff the task is `ready` with no
 * enforced block, or is a stale `in_progress` claim past `staleMs`. The
 * `blocked_by IS NULL` guard is the SINGLE carved exception to the claim machine
 * (WISH Decision 5); the ready-set/dependency logic is otherwise untouched.
 * Exactly one concurrent claimant wins (conditional UPDATE affects one row);
 * losers get `CheckoutConflictError`, or `TaskBlockedError` when an enforced
 * block is what stopped them. A winning claim appends a `claim` timeline event
 * inside the same transaction so the card can never show a claim without it.
 */
export function claimTask(db: Database, taskId: string, worker: string, opts: ClaimOptions = {}): TaskRow {
  const now = opts.now ?? Date.now();
  const staleBefore = now - (opts.staleMs ?? DEFAULT_STALE_MS);

  const claim = db.transaction(() => {
    const res = db
      .query(
        `UPDATE tasks
         SET claimed_by = ?, claimed_at = ?, status = 'in_progress', updated_at = ?
         WHERE id = ?
           AND blocked_by IS NULL
           AND (
             status = 'ready'
             OR (status = 'in_progress' AND claimed_at IS NOT NULL AND claimed_at <= ?)
           )`,
      )
      .run(worker, now, now, taskId, staleBefore);
    if (res.changes === 1) {
      appendTaskEvent(db, taskId, {
        kind: 'claim',
        note: `claimed by ${worker}`,
        authorKind: opts.author?.authorKind ?? undefined,
        author: opts.author?.author ?? undefined,
      });
    }
    return res.changes;
  });
  let changes: number;
  try {
    changes = claim.immediate();
  } catch (err) {
    // Under heavy cross-process contention a straggler can exhaust
    // busy_timeout and surface SQLITE_BUSY instead of a clean 0-change
    // result. If the task is meanwhile gone or no longer claimable, that IS
    // a lost race — translate to the typed error the claim contract promises.
    // A still-claimable task (or any other error) stays a real error.
    if (err instanceof Error && err.message.includes('SQLITE_BUSY')) {
      const current = getTask(db, taskId);
      if (!current) throw new UnknownTaskError(taskId);
      // Not claimable (already claimed) OR under an enforced block → typed error.
      if (current.status !== 'ready' || readBlock(db, taskId)?.blockedBy != null) claimFailure(db, taskId);
    }
    throw err;
  }

  if (changes !== 1) claimFailure(db, taskId);
  return getTask(db, taskId) as TaskRow;
}

/**
 * Transition a claimed/in-progress task to `done`, then recompute the ready set.
 * Completion releases the card, so it appends a `release` timeline event. The
 * recompute/dependency logic itself is untouched — only the audit event is added.
 */
export function completeTask(db: Database, taskId: string, author?: EventAuthor): TaskRow {
  const task = getTask(db, taskId);
  if (!task) throw new UnknownTaskError(taskId);
  // A `blocked` task's dependencies are not all `done`; completing it would let
  // recomputeReady() promote downstream tasks whose real prerequisites were
  // skipped. Reject so a mistaken id can't bypass the dependency gate. Ready
  // and in_progress remain completable (direct completion + the checkout path).
  if (task.status === 'blocked') throw new TaskNotReadyError(taskId);
  const now = Date.now();
  const done = db.transaction(() => {
    db.query("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?").run(now, taskId);
    appendTaskEvent(db, taskId, {
      kind: 'release',
      note: 'completed',
      authorKind: author?.authorKind ?? undefined,
      author: author?.author ?? undefined,
    });
    recomputeReady(db);
  });
  done();
  return getTask(db, taskId) as TaskRow;
}

/** Translate a refused release (CAS matched no `in_progress` row) into a typed error. */
function releaseFailure(db: Database, taskId: string): never {
  const task = getTask(db, taskId);
  if (!task) throw new UnknownTaskError(taskId);
  throw new TaskReleaseError(taskId, task.status);
}

/**
 * Release a claim WITHOUT completing — returns an `in_progress` card to the
 * `ready` queue and clears the claim so another runtime can pick it up. The state
 * check lives IN the SQL (`WHERE ... AND status = 'in_progress'`) exactly like
 * {@link claimTask}, so a concurrent `done`/re-claim that transitions the card out
 * of `in_progress` between decision and write can never be clobbered: the
 * conditional UPDATE simply affects zero rows and we refuse with a typed
 * {@link TaskReleaseError} — critically, a completed card is NEVER resurrected to
 * `ready`. The `release` timeline event is emitted ONLY inside the winning
 * transaction, so a refused release leaves no phantom event.
 */
export function releaseTask(db: Database, taskId: string, author: EventAuthor): TaskRow {
  const now = Date.now();
  const release = db.transaction(() => {
    const res = db
      .query(
        `UPDATE tasks
         SET status = 'ready', claimed_by = NULL, claimed_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'in_progress'`,
      )
      .run(now, taskId);
    if (res.changes === 1) {
      appendTaskEvent(db, taskId, {
        kind: 'release',
        note: 'released',
        authorKind: author.authorKind ?? undefined,
        author: author.author ?? undefined,
      });
    }
    return res.changes;
  });
  if (release.immediate() !== 1) releaseFailure(db, taskId);
  return getTask(db, taskId) as TaskRow;
}

/**
 * Place an enforced block on a card: stores `blocked_by` (the acting runtime's
 * identity, which drives the checkout refusal) and `blocked_reason`, and appends
 * a `block` event. `blocked_by` is always non-null so the checkout gate can never
 * be defeated by a missing identity — an anonymous human falls back to its kind.
 */
export function blockTask(db: Database, taskId: string, reason: string, author: EventAuthor): TaskRow {
  requireTask(db, taskId);
  const blockedBy = author.author ?? author.authorKind ?? 'unknown';
  const now = Date.now();
  const tx = db.transaction(() => {
    db.query('UPDATE tasks SET blocked_by = ?, blocked_reason = ?, updated_at = ? WHERE id = ?').run(
      blockedBy,
      reason,
      now,
      taskId,
    );
    appendTaskEvent(db, taskId, {
      kind: 'block',
      note: reason,
      authorKind: author.authorKind ?? undefined,
      author: author.author ?? undefined,
    });
  });
  tx();
  return getTask(db, taskId) as TaskRow;
}

/** Clear an enforced block and append an `unblock` event. */
export function unblockTask(db: Database, taskId: string, author: EventAuthor): TaskRow {
  requireTask(db, taskId);
  const now = Date.now();
  const tx = db.transaction(() => {
    db.query('UPDATE tasks SET blocked_by = NULL, blocked_reason = NULL, updated_at = ? WHERE id = ?').run(now, taskId);
    appendTaskEvent(db, taskId, {
      kind: 'unblock',
      authorKind: author.authorKind ?? undefined,
      author: author.author ?? undefined,
    });
  });
  tx();
  return getTask(db, taskId) as TaskRow;
}

/**
 * Record a liveness heartbeat for a claimed card — a bare `heartbeat_at` write,
 * NOT a timeline event (liveness is render-derived from this timestamp, never
 * self-reported). Returns the timestamp written. Injectable clock for tests.
 */
export function recordHeartbeat(db: Database, taskId: string, now: number = Date.now()): number {
  requireTask(db, taskId);
  db.query('UPDATE tasks SET heartbeat_at = ?, updated_at = ? WHERE id = ?').run(now, now, taskId);
  return now;
}

// ============================================================================
// Append-only stage log
// ============================================================================

export function appendStage(db: Database, taskId: string, stage: string, note?: string): void {
  requireTask(db, taskId);
  db.query('INSERT INTO stage_log (task_id, stage, note, created_at) VALUES (?, ?, ?, ?)').run(
    taskId,
    stage,
    note ?? null,
    Date.now(),
  );
}

export function getStageLog(db: Database, taskId: string): StageEntry[] {
  const rows = db.query('SELECT * FROM stage_log WHERE task_id = ? ORDER BY id').all(taskId) as Array<{
    id: number;
    task_id: string;
    stage: string;
    note: string | null;
    created_at: number;
  }>;
  return rows.map((r) => ({ id: r.id, taskId: r.task_id, stage: r.stage, note: r.note, createdAt: r.created_at }));
}

// ============================================================================
// Append-only card timeline (task_events)
// ============================================================================

interface RawTaskEvent {
  id: number;
  task_id: string;
  kind: string;
  note: string | null;
  author_kind: string | null;
  author: string | null;
  created_at: number;
}

function mapTaskEvent(row: RawTaskEvent): TaskEvent {
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    note: row.note,
    authorKind: row.author_kind,
    author: row.author,
    createdAt: row.created_at,
  };
}

/**
 * Append one authored event to a card's timeline. This is the MINIMAL API the
 * move verb needs; the full verb surface (comment/block/release/report) lands in
 * a later group on top of this table.
 */
export function appendTaskEvent(db: Database, taskId: string, event: AppendEventInput): TaskEvent {
  requireTask(db, taskId);
  const createdAt = Date.now();
  const res = db
    .query('INSERT INTO task_events (task_id, kind, note, author_kind, author, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(taskId, event.kind, event.note ?? null, event.authorKind ?? null, event.author ?? null, createdAt);
  return {
    id: Number(res.lastInsertRowid),
    taskId,
    kind: event.kind,
    note: event.note ?? null,
    authorKind: event.authorKind ?? null,
    author: event.author ?? null,
    createdAt,
  };
}

/** A card's timeline events in append order. */
export function getTaskEvents(db: Database, taskId: string): TaskEvent[] {
  const rows = db.query('SELECT * FROM task_events WHERE task_id = ? ORDER BY id').all(taskId) as RawTaskEvent[];
  return rows.map(mapTaskEvent);
}

/**
 * Comment-event counts per task, as a `taskId → count` map (one grouped query,
 * so the board can badge 💬 without a per-card round-trip). Tasks with no
 * comments are absent from the map — callers default to 0.
 */
export function commentCounts(db: Database): Map<string, number> {
  const rows = db
    .query("SELECT task_id, count(*) AS n FROM task_events WHERE kind = 'comment' GROUP BY task_id")
    .all() as Array<{ task_id: string; n: number }>;
  return new Map(rows.map((r) => [r.task_id, r.n]));
}

// ============================================================================
// Lane moves
// ============================================================================

export interface MoveResult {
  task: TaskRow;
  from: string | null;
  to: string;
}

/**
 * Move a card to a lane defined by its board, recording a `move` event on the
 * card timeline. Rejects (typed {@link LaneError}) a card with no board, a board
 * that defines no lanes, or an undefined target lane — the error lists the valid
 * lanes so the CLI can surface them. The lane write + event append are one
 * transaction so a card can never show a lane without a matching timeline entry.
 */
export function moveTask(db: Database, taskId: string, toLane: string, author: EventAuthor): MoveResult {
  const task = getTask(db, taskId);
  if (!task) throw new UnknownTaskError(taskId);
  if (!task.boardId) {
    throw new LaneError(`Task ${taskId} is not on a board — moving between lanes requires a lane-defining board.`);
  }
  const board = getBoard(db, task.boardId);
  if (!board?.lanes || board.lanes.length === 0) {
    throw new LaneError(`Board "${board?.name ?? task.boardId}" defines no lanes — nothing to move between.`);
  }
  const laneNames = board.lanes.map((l) => l.name);
  if (!laneNames.includes(toLane)) {
    throw new LaneError(`Unknown lane "${toLane}". Valid lanes: ${laneNames.join(', ')}.`);
  }

  const from = getTaskLane(db, taskId);
  const note = `${from ?? '(none)'}→${toLane}`;
  const now = Date.now();
  const move = db.transaction(() => {
    db.query('UPDATE tasks SET lane = ?, updated_at = ? WHERE id = ?').run(toLane, now, taskId);
    appendTaskEvent(db, taskId, {
      kind: 'move',
      note,
      authorKind: author.authorKind ?? undefined,
      author: author.author ?? undefined,
    });
  });
  move();
  return { task: getTask(db, taskId) as TaskRow, from, to: toLane };
}

// ============================================================================
// Wish-group graph validation (ported from wish-state.ts — NOT imported)
// ============================================================================

/**
 * Deterministic signature of a wish's group structure: group names + sorted
 * `dependsOn` per group. Group/dep ordering does not affect the result. Prose
 * changes to WISH.md leave it untouched; only structural drift flips it.
 *
 * Ported (not imported) from `src/lib/wish-state.ts` — v5 must not import v4.
 */
export function computeGroupsSignature(groups: WishGroupDef[]): string {
  const canonical = groups
    .map((g) => ({ name: g.name, dependsOn: [...(g.dependsOn ?? [])].sort() }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Reject self-deps and references to groups not in the set. */
function validateGroupRefs(groups: WishGroupDef[]): void {
  const names = new Set(groups.map((g) => g.name));
  for (const group of groups) {
    if (group.dependsOn?.includes(group.name)) {
      throw new CycleError(`Group "${group.name}" depends on itself`);
    }
    for (const dep of group.dependsOn ?? []) {
      if (!names.has(dep)) {
        throw new WishGroupStateError(`Group "${group.name}" depends on non-existent group "${dep}"`);
      }
    }
  }
}

/** Detect dependency cycles via Kahn's topological sort. */
function detectGroupCycles(groups: WishGroupDef[]): void {
  const inDegree: Record<string, number> = {};
  const adjacency: Record<string, string[]> = {};
  for (const group of groups) {
    inDegree[group.name] = (group.dependsOn ?? []).length;
    adjacency[group.name] = [];
  }
  for (const group of groups) {
    for (const dep of group.dependsOn ?? []) adjacency[dep].push(group.name);
  }
  const queue = Object.entries(inDegree)
    .filter(([, deg]) => deg === 0)
    .map(([name]) => name);
  let processed = 0;
  while (queue.length > 0) {
    const node = queue.shift() as string;
    processed++;
    for (const neighbor of adjacency[node]) {
      inDegree[neighbor]--;
      if (inDegree[neighbor] === 0) queue.push(neighbor);
    }
  }
  if (processed !== groups.length) {
    const remaining = Object.entries(inDegree)
      .filter(([, deg]) => deg > 0)
      .map(([name]) => name);
    throw new CycleError(`Dependency cycle detected among groups: ${remaining.join(', ')}`);
  }
}

function validateGroups(groups: WishGroupDef[]): void {
  validateGroupRefs(groups);
  detectGroupCycles(groups);
}

// ============================================================================
// Wish-group state machine
// ============================================================================

function mapWishGroup(row: {
  wish: string;
  name: string;
  status: WishGroupStatus;
  depends_on: string;
  assignee: string | null;
  started_at: number | null;
  completed_at: number | null;
}): WishGroupRow {
  return {
    wish: row.wish,
    name: row.name,
    status: row.status,
    dependsOn: JSON.parse(row.depends_on) as string[],
    assignee: row.assignee,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

/**
 * (Re)create the group rows for a wish from definitions and stamp the drift
 * signature. Groups with no deps start `ready`, others `blocked`. Replaces any
 * prior state for the wish.
 */
export function createWishGroups(db: Database, wish: string, groups: WishGroupDef[]): WishGroupRow[] {
  validateGroups(groups);
  const now = Date.now();
  const signature = computeGroupsSignature(groups);

  const tx = db.transaction(() => {
    db.query('DELETE FROM wish_groups WHERE wish = ?').run(wish);
    for (const group of groups) {
      const deps = group.dependsOn ?? [];
      const status: WishGroupStatus = deps.length === 0 ? 'ready' : 'blocked';
      db.query(
        `INSERT INTO wish_groups (wish, name, status, depends_on, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(wish, group.name, status, JSON.stringify(deps), now, now);
    }
    db.query('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(wishSigKey(wish), signature);
  });
  tx();

  return getWishGroups(db, wish);
}

function wishSigKey(wish: string): string {
  return `wish_sig:${wish}`;
}

export function getWishGroups(db: Database, wish: string): WishGroupRow[] {
  const rows = db.query('SELECT * FROM wish_groups WHERE wish = ? ORDER BY name').all(wish) as Array<
    Parameters<typeof mapWishGroup>[0]
  >;
  return rows.map(mapWishGroup);
}

/**
 * Distinct known wish slugs (from tasks + wish_groups), longest first. Used to
 * disambiguate a `wish/<slug>-<group>` branch when the slug itself contains
 * hyphens (`genie-mcp` vs a `genie` wish with an `mcp` group).
 */
export function listWishSlugs(db: Database): string[] {
  const rows = db
    .query(
      // UNION already de-duplicates; order longest-first for prefix disambiguation.
      `SELECT wish FROM (
         SELECT wish FROM tasks WHERE wish IS NOT NULL
         UNION SELECT wish FROM wish_groups WHERE wish IS NOT NULL
       ) ORDER BY LENGTH(wish) DESC`,
    )
    .all() as Array<{ wish: string }>;
  return rows.map((r) => r.wish);
}

function getWishGroup(db: Database, wish: string, name: string): WishGroupRow | null {
  const row = db.query('SELECT * FROM wish_groups WHERE wish = ? AND name = ?').get(wish, name) as
    | Parameters<typeof mapWishGroup>[0]
    | null;
  return row ? mapWishGroup(row) : null;
}

/**
 * Throw `WishGroupDriftError` if the supplied definitions no longer match the
 * signature stored at creation. No-op when no signature is stored yet.
 */
export function assertWishSignature(db: Database, wish: string, groups: WishGroupDef[]): void {
  const stored = db.query('SELECT value FROM meta WHERE key = ?').get(wishSigKey(wish)) as { value: string } | null;
  if (!stored) return;
  if (stored.value !== computeGroupsSignature(groups)) throw new WishGroupDriftError(wish);
}

/** Transition a group `ready` → `in_progress`, refusing unmet dependencies. */
export function startWishGroup(db: Database, wish: string, name: string, assignee: string): WishGroupRow {
  const group = getWishGroup(db, wish, name);
  if (!group) throw new WishGroupStateError(`Group "${name}" not found in wish "${wish}"`);
  if (group.status === 'in_progress') {
    throw new WishGroupStateError(
      `Group "${name}" is already in progress (assigned to ${group.assignee ?? 'unknown'})`,
    );
  }
  if (group.status === 'done') throw new WishGroupStateError(`Group "${name}" is already done`);

  const blockers = pendingDeps(db, wish, group.dependsOn);
  if (blockers.length > 0) {
    throw new WishGroupStateError(`Cannot start group "${name}": unmet dependencies: ${blockers.join(', ')}`);
  }

  const now = Date.now();
  db.query(
    `UPDATE wish_groups SET status = 'in_progress', assignee = ?, started_at = COALESCE(started_at, ?), updated_at = ?
     WHERE wish = ? AND name = ?`,
  ).run(assignee, now, now, wish, name);
  return getWishGroup(db, wish, name) as WishGroupRow;
}

/** Names of a group's dependencies that are not yet `done`. */
function pendingDeps(db: Database, wish: string, deps: string[]): string[] {
  const pending: string[] = [];
  for (const dep of deps) {
    const row = getWishGroup(db, wish, dep);
    if (!row || row.status !== 'done') pending.push(dep);
  }
  return pending;
}

/**
 * Transition a group `in_progress` → `done` and promote any dependent group
 * whose dependencies are now all `done` from `blocked` to `ready`. Idempotent
 * on an already-`done` group.
 */
export function completeWishGroup(db: Database, wish: string, name: string): WishGroupRow {
  const group = getWishGroup(db, wish, name);
  if (!group) throw new WishGroupStateError(`Group "${name}" not found in wish "${wish}"`);
  if (group.status === 'done') return group;
  if (group.status !== 'in_progress') {
    throw new WishGroupStateError(`Cannot complete group "${name}": must be in_progress (currently ${group.status})`);
  }

  const now = Date.now();
  const tx = db.transaction(() => {
    db.query('UPDATE wish_groups SET status = ?, completed_at = ?, updated_at = ? WHERE wish = ? AND name = ?').run(
      'done',
      now,
      now,
      wish,
      name,
    );
    promoteReadyGroups(db, wish, now);
  });
  tx();
  return getWishGroup(db, wish, name) as WishGroupRow;
}

/** Promote `blocked` groups whose dependencies are all `done` to `ready`. */
function promoteReadyGroups(db: Database, wish: string, now: number): void {
  const groups = getWishGroups(db, wish);
  const doneNames = new Set(groups.filter((g) => g.status === 'done').map((g) => g.name));
  for (const group of groups) {
    if (group.status !== 'blocked') continue;
    if (group.dependsOn.every((dep) => doneNames.has(dep))) {
      db.query("UPDATE wish_groups SET status = 'ready', updated_at = ? WHERE wish = ? AND name = ?").run(
        now,
        wish,
        group.name,
      );
    }
  }
}

// ============================================================================
// Full-state export
// ============================================================================

/**
 * Complete, structure-preserving snapshot of every table in the database, as
 * raw rows keyed by table name. Powers `genie v5 task export` — a durable,
 * daemon-free dump of all operational state to JSON. Order-stable per table so
 * diffs stay legible.
 */
export interface StateExport {
  schemaVersion: number;
  meta: Array<{ key: string; value: string }>;
  boards: RawBoard[];
  tasks: RawTask[];
  task_dependencies: Array<{ task_id: string; depends_on_id: string }>;
  stage_log: RawStage[];
  task_events: RawTaskEvent[];
  wish_groups: RawWishGroup[];
}

interface RawBoard {
  id: string;
  name: string;
  lanes: string | null;
  created_at: number;
}

interface RawStage {
  id: number;
  task_id: string;
  stage: string;
  note: string | null;
  created_at: number;
}

interface RawWishGroup {
  wish: string;
  name: string;
  status: WishGroupStatus;
  depends_on: string;
  assignee: string | null;
  started_at: number | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
}

export function exportState(db: Database): StateExport {
  const schemaVersion = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
  return {
    schemaVersion,
    meta: db.query('SELECT key, value FROM meta ORDER BY key').all() as StateExport['meta'],
    boards: db.query('SELECT * FROM boards ORDER BY created_at, id').all() as RawBoard[],
    tasks: db.query('SELECT * FROM tasks ORDER BY created_at, id').all() as RawTask[],
    task_dependencies: db
      .query('SELECT task_id, depends_on_id FROM task_dependencies ORDER BY task_id, depends_on_id')
      .all() as StateExport['task_dependencies'],
    stage_log: db.query('SELECT * FROM stage_log ORDER BY id').all() as RawStage[],
    task_events: db.query('SELECT * FROM task_events ORDER BY id').all() as RawTaskEvent[],
    wish_groups: db.query('SELECT * FROM wish_groups ORDER BY wish, name').all() as RawWishGroup[],
  };
}
