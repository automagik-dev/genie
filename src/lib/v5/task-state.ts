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
  /** IDs of existing tasks this task depends on. Non-empty ⇒ starts `blocked`. */
  dependsOn?: string[];
}

export interface BoardRow {
  id: string;
  name: string;
  createdAt: number;
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

/** A single hire-roster entry: one agent adapter hired into one wish. */
export interface HireRosterRow {
  /** Wish slug this hire belongs to. */
  wish: string;
  /** Agent adapter id (the runtime/provider slot) hired into the wish. */
  agentAdapterId: string;
  /** Optional provider profile; null when unset. */
  profile: string | null;
  /** Worktree binding for this hire. */
  worktree: string;
  hiredAt: number;
  /** Free-form lifecycle state of the hire (defaults to `hired`). */
  state: string;
}

export interface HireAgentInput {
  wish: string;
  agentAdapterId: string;
  profile?: string;
  worktree: string;
  /** Lifecycle state to stamp. Defaults to `hired`. */
  state?: string;
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

/** Lost the race to claim a task — another worker holds a live claim. */
export class CheckoutConflictError extends Error {
  readonly taskId: string;
  constructor(taskId: string) {
    super(`Task ${taskId} is not claimable (already claimed or not ready)`);
    this.name = 'CheckoutConflictError';
    this.taskId = taskId;
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

export function createBoard(db: Database, name: string): BoardRow {
  const id = newId('b');
  const createdAt = Date.now();
  db.query('INSERT INTO boards (id, name, created_at) VALUES (?, ?, ?)').run(id, name, createdAt);
  return { id, name, createdAt };
}

export function getBoard(db: Database, id: string): BoardRow | null {
  const row = db.query('SELECT id, name, created_at FROM boards WHERE id = ?').get(id) as {
    id: string;
    name: string;
    created_at: number;
  } | null;
  return row ? { id: row.id, name: row.name, createdAt: row.created_at } : null;
}

export function getBoardByName(db: Database, name: string): BoardRow | null {
  const row = db.query('SELECT id, name, created_at FROM boards WHERE name = ?').get(name) as {
    id: string;
    name: string;
    created_at: number;
  } | null;
  return row ? { id: row.id, name: row.name, createdAt: row.created_at } : null;
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
      `INSERT INTO tasks (id, board_id, title, status, wish, group_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.boardId ?? null, input.title, status, input.wish ?? null, input.group ?? null, now, now);
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

export function listTasks(db: Database, filter: TaskFilter = {}): TaskRow[] {
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
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.query(`SELECT * FROM tasks${where} ORDER BY created_at`).all(...params) as RawTask[];
  return rows.map(mapTask);
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

/**
 * Atomically claim a task for a worker. Wins iff the task is `ready`, or is a
 * stale `in_progress` claim past `staleMs`. Exactly one concurrent claimant
 * wins (conditional UPDATE affects one row); losers get `CheckoutConflictError`.
 * Runs in an IMMEDIATE transaction so the write lock is held for the whole
 * read-modify-write.
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
           AND (
             status = 'ready'
             OR (status = 'in_progress' AND claimed_at IS NOT NULL AND claimed_at <= ?)
           )`,
      )
      .run(worker, now, now, taskId, staleBefore);
    return res.changes;
  });
  let changes: number;
  try {
    changes = claim.immediate();
  } catch (err) {
    // Under heavy cross-process contention a straggler can exhaust
    // busy_timeout and surface SQLITE_BUSY instead of a clean 0-change
    // result. If the task is meanwhile gone or no longer claimable, that IS
    // a lost race — translate to the typed conflict the claim contract
    // promises. A still-claimable task (or any other error) stays a real error.
    if (err instanceof Error && err.message.includes('SQLITE_BUSY')) {
      const current = getTask(db, taskId);
      if (!current) throw new UnknownTaskError(taskId);
      if (current.status !== 'ready') throw new CheckoutConflictError(taskId);
    }
    throw err;
  }

  if (changes !== 1) {
    if (!getTask(db, taskId)) throw new UnknownTaskError(taskId);
    throw new CheckoutConflictError(taskId);
  }
  return getTask(db, taskId) as TaskRow;
}

/** Transition a claimed/in-progress task to `done`, then recompute the ready set. */
export function completeTask(db: Database, taskId: string): TaskRow {
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
    recomputeReady(db);
  });
  done();
  return getTask(db, taskId) as TaskRow;
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
// Hire roster (single-row upsert / delete — the bridge's write surface)
// ============================================================================

interface RawHire {
  wish: string;
  agent_adapter_id: string;
  profile: string | null;
  worktree: string;
  hired_at: number;
  state: string;
}

function mapHire(row: RawHire): HireRosterRow {
  return {
    wish: row.wish,
    agentAdapterId: row.agent_adapter_id,
    profile: row.profile,
    worktree: row.worktree,
    hiredAt: row.hired_at,
    state: row.state,
  };
}

/**
 * Hire an agent adapter into a wish. Idempotent single-row upsert keyed on
 * `(wish, agent_adapter_id)`: a re-hire refreshes profile/worktree/state but
 * preserves the original `hired_at` by OMITTING `hired_at` from the `ON CONFLICT
 * DO UPDATE SET` list — an unset column keeps its stored value, so the first
 * hire's timestamp survives every re-hire and the call converges on one row. A
 * single statement is atomic on its own; the WAL + busy_timeout the handle
 * carries (see sqlite-open.ts) serializes it against concurrent writers.
 */
export function hireAgent(db: Database, input: HireAgentInput): HireRosterRow {
  const now = Date.now();
  const state = input.state ?? 'hired';
  db.query(
    `INSERT INTO hire_roster (wish, agent_adapter_id, profile, worktree, hired_at, state)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(wish, agent_adapter_id) DO UPDATE SET
       profile  = excluded.profile,
       worktree = excluded.worktree,
       state    = excluded.state`,
  ).run(input.wish, input.agentAdapterId, input.profile ?? null, input.worktree, now, state);
  return getHire(db, input.wish, input.agentAdapterId) as HireRosterRow;
}

/**
 * Unhire an agent adapter from a wish. Idempotent single-row delete: removing an
 * absent hire is a no-op that returns false; a real removal returns true.
 */
export function unhireAgent(db: Database, wish: string, agentAdapterId: string): boolean {
  const res = db.query('DELETE FROM hire_roster WHERE wish = ? AND agent_adapter_id = ?').run(wish, agentAdapterId);
  return res.changes > 0;
}

export function getHire(db: Database, wish: string, agentAdapterId: string): HireRosterRow | null {
  const row = db
    .query('SELECT * FROM hire_roster WHERE wish = ? AND agent_adapter_id = ?')
    .get(wish, agentAdapterId) as RawHire | null;
  return row ? mapHire(row) : null;
}

/** Hires for a wish, or the whole roster when `wish` is omitted. Order-stable. */
export function listHires(db: Database, wish?: string): HireRosterRow[] {
  const rows = wish
    ? (db.query('SELECT * FROM hire_roster WHERE wish = ? ORDER BY agent_adapter_id').all(wish) as RawHire[])
    : (db.query('SELECT * FROM hire_roster ORDER BY wish, agent_adapter_id').all() as RawHire[]);
  return rows.map(mapHire);
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
  wish_groups: RawWishGroup[];
  hire_roster: RawHire[];
}

interface RawBoard {
  id: string;
  name: string;
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
    wish_groups: db.query('SELECT * FROM wish_groups ORDER BY wish, name').all() as RawWishGroup[],
    hire_roster: db.query('SELECT * FROM hire_roster ORDER BY wish, agent_adapter_id').all() as RawHire[],
  };
}
