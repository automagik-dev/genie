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
import { randomBytes } from 'node:crypto';
import { STAGE_LOG_BACKFILL_KEY, backfillStageLog } from './genie-db.js';

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
  /**
   * Declared roster agent that works this card, or null when the current
   * orchestrating agent does (W1 routing). Imported values are untrusted
   * TEXT — a hand-merged roadmap.json reaches this row unvalidated — so shell
   * and prompt consumers must call {@link requireRosterAgent} first.
   */
  assignedAgent: string | null;
  /** Why the declared agent was assigned; always present when assignedAgent is set. */
  assignedReason: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * The frozen pre-assignment TaskRow key set. The two declared-routing fields
 * live on TaskRow but serialize on the additive lane board `--json` path only
 * (WISH decision: lane-path-only); every other machine-readable task payload
 * ships this projection.
 */
export type FrozenTaskRow = Omit<TaskRow, 'assignedAgent' | 'assignedReason'>;

/** Explicit key-picking — strips the two assignment fields. */
export function toFrozenTaskRow(t: TaskRow): FrozenTaskRow {
  return {
    id: t.id,
    boardId: t.boardId,
    title: t.title,
    status: t.status,
    claimedBy: t.claimedBy,
    claimedAt: t.claimedAt,
    wish: t.wish,
    group: t.group,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
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
  /** Declared roster agent that works this card; requires `assignedReason` (W1 routing). */
  assignedAgent?: string;
  /** Why `assignedAgent` was chosen; only valid together with `assignedAgent`. */
  assignedReason?: string;
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
 * Why a card carries an enforced block. `work` — the default — means something
 * is wrong and must be resolved before the card moves. `hold` means the card is
 * deliberately parked: nothing is broken, it simply must not be picked up yet.
 * Both refuse checkout identically; the kind exists so a reader can tell the two
 * apart without parsing the reason prose.
 */
export type BlockKind = 'work' | 'hold';

/** An enforced block as the lane projection exposes it. */
export interface EnforcedBlock {
  reason: string;
  kind: BlockKind;
}

/**
 * A task row plus its lane placement. Kept SEPARATE from {@link TaskRow} so the
 * frozen TaskRow contract — and the byte-identical laneless board `--json`,
 * MCP, and `task export` shapes that serialize it — never gains a `lane` field.
 * Only the additive lane-grouped render consumes this projection.
 */
export interface LaneTaskRow extends TaskRow {
  lane: string | null;
  /**
   * The card's enforced block, or null when it carries none. The ONE deliberate
   * runtime field on this projection: a lane-board consumer must be able to tell
   * a parked card from a live one, which the lane grouping alone cannot express.
   * The frozen surfaces — {@link TaskRow}, the laneless board `--json`, MCP, and
   * `task export` — deliberately do NOT carry it.
   */
  enforcedBlock: EnforcedBlock | null;
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
// Declared routing roster (cross-agent-delegate W1)
// ============================================================================

/**
 * The allowlisted coding agents a card can be declared to. A typed in-code
 * constant, NOT config (WISH Decision 2): `assigned_agent` text eventually
 * reaches a shell and another agent's prompt, so every write path validates
 * against this closed set. Extension is a one-line change.
 */
export const ROSTER = ['claude', 'codex', 'pi', 'hermes', 'prime'] as const;

/** One member of the {@link ROSTER} allowlist. */
export type RosterAgent = (typeof ROSTER)[number];

/** True when `agent` names a member of the roster allowlist. */
export function isRosterAgent(agent: string): agent is RosterAgent {
  return (ROSTER as readonly string[]).includes(agent);
}

/**
 * Validate an agent name against the roster allowlist, throwing
 * {@link UnknownRosterAgentError} with the allowed names when it is not a
 * member. The one funnel every assignment write path uses.
 */
export function requireRosterAgent(agent: string): RosterAgent {
  if (!isRosterAgent(agent)) throw new UnknownRosterAgentError(agent);
  return agent;
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

/**
 * An assignment write named an agent outside the {@link ROSTER} allowlist (WISH
 * Decision 2). `assigned_agent` text reaches a shell and another agent's prompt
 * in W2, so the closed roster is enforced at every write path and the allowed
 * names ride the error so the CLI can surface them verbatim.
 */
export class UnknownRosterAgentError extends Error {
  readonly agent: string;
  constructor(agent: string) {
    super(
      `Unknown agent "${agent}" — not in the roster (${ROSTER.join(', ')}). Assignment requires an allowlisted agent.`,
    );
    this.name = 'UnknownRosterAgentError';
    this.agent = agent;
  }
}

/**
 * An assignment write omitted half of the required pair (WISH Decision 3: an
 * assignment carries its rationale — `--agent` requires `--why`, and `--why`
 * alone is equally rejected). Thrown for both a declared agent with no reason
 * and a reason with no declared agent: a half-written assignment is exactly the
 * invisible routing this wish exists to kill.
 */
export class AssignmentReasonRequiredError extends Error {
  constructor() {
    super('Assignment requires both halves: a declared agent AND the reason it was assigned (--agent requires --why).');
    this.name = 'AssignmentReasonRequiredError';
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

/**
 * A completion was refused because the status CAS in {@link completeTask}
 * matched no row: the card is already `done` (or a concurrent transition moved
 * it out of a completable status between decision and write). The status is
 * carried so the CLI can tell the operator why. Completion analogue of
 * {@link TaskReleaseError} (release-side refusals).
 */
export class TaskCompleteError extends Error {
  readonly taskId: string;
  readonly status: TaskStatus;
  constructor(taskId: string, status: TaskStatus) {
    const detail = status === 'done' ? 'it is already done' : `it is ${status}, not completable`;
    super(`Cannot complete task ${taskId}: ${detail}`);
    this.name = 'TaskCompleteError';
    this.taskId = taskId;
    this.status = status;
  }
}

/**
 * A delete was refused because other cards still `depends-on` the target. The
 * dependent ids are carried so the operator learns what to re-point first.
 */
export class TaskHasDependentsError extends Error {
  readonly taskId: string;
  readonly dependents: string[];
  constructor(taskId: string, dependents: string[]) {
    const shown = dependents.slice(0, 3).join(', ');
    const rest = dependents.length > 3 ? ` +${dependents.length - 3} more` : '';
    const one = dependents.length === 1;
    super(
      `Cannot delete task ${taskId}: ${dependents.length} task${one ? ' depends' : 's depend'} on it (${shown}${rest}). Delete or re-point ${one ? 'it' : 'them'} first.`,
    );
    this.name = 'TaskHasDependentsError';
    this.taskId = taskId;
    this.dependents = dependents;
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
  block_kind: string | null;
  assigned_agent: string | null;
  assigned_reason: string | null;
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
    assignedAgent: row.assigned_agent,
    assignedReason: row.assigned_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Stored kinds are untrusted TEXT — the column is additive and nullable, and a
 * hand-merged roadmap.json reaches this mapper unvalidated — so anything that is
 * not exactly `hold` reads as the `work` default.
 */
function blockKindOf(raw: string | null): BlockKind {
  return raw === 'hold' ? 'hold' : 'work';
}

/**
 * Project a row's enforced block. Presence is keyed on `blocked_by` — the column
 * the checkout gate reads — so the serialized field can never disagree with
 * whether checkout is actually refused. A row blocked without a stored reason
 * (possible from an older snapshot) projects an empty reason rather than
 * dropping the block.
 */
function mapEnforcedBlock(row: RawTask): EnforcedBlock | null {
  if (row.blocked_by == null) return null;
  return { reason: row.blocked_reason ?? '', kind: blockKindOf(row.block_kind) };
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

  // Assignment invariants enforced at the API boundary (WISH Decisions 2-3):
  // agent allowlisted, both halves or neither. Pure validation, so it runs
  // before any DB read.
  const assignment = validateAssignmentPair(input.assignedAgent ?? null, input.assignedReason ?? null);

  // Validate the board up front so a missing reference surfaces as a typed
  // UnknownBoardError rather than a raw foreign-key SqliteError from the insert.
  if (input.boardId != null && !getBoard(db, input.boardId)) {
    throw new UnknownBoardError(input.boardId);
  }

  const insert = db.transaction(() => {
    db.query(
      `INSERT INTO tasks (id, board_id, title, status, wish, group_name, lane,
                          assigned_agent, assigned_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.boardId ?? null,
      input.title,
      status,
      input.wish ?? null,
      input.group ?? null,
      input.lane ?? null,
      assignment.agent,
      assignment.reason,
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
 * `lane` and {@link LaneTaskRow.enforcedBlock}. Consumed ONLY by the additive
 * lane-grouped board render; the frozen {@link TaskRow} path (board `--json`,
 * MCP, export) stays byte-identical.
 */
export function listTasksWithLane(db: Database, filter: TaskFilter = {}): LaneTaskRow[] {
  const { where, params } = buildTaskWhere(filter);
  const rows = db.query(`SELECT * FROM tasks${where} ORDER BY created_at`).all(...params) as RawTask[];
  return rows.map((r) => ({ ...mapTask(r), lane: r.lane ?? null, enforcedBlock: mapEnforcedBlock(r) }));
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
    enforcedBlock: mapEnforcedBlock(row),
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
// Deletion — the only removal path (hard, unarchived, dependency-refused)
// ============================================================================

/** What a {@link deleteTask} removed, for the CLI to report back. */
export interface DeleteTaskResult {
  /** The card as it stood immediately before removal. */
  task: TaskRow;
  /** Outgoing `depends-on` edges removed with it. */
  dependencies: number;
  /** Timeline events removed with it. */
  events: number;
  /** Deprecated stage_log rows removed with it. */
  stages: number;
}

/**
 * Permanently remove one card, its dependency edges, and its timeline. There is
 * no archive and no undo — the roadmap snapshot in git is the only history a
 * deleted card leaves behind.
 *
 * **Refused while any other card depends on it**, and that refusal is the whole
 * safety story. `task_dependencies` declares both columns
 * `REFERENCES tasks(id) ON DELETE CASCADE`, so deleting a depended-on card would
 * silently erase the edge rather than fail: the dependent keeps `status =
 * 'blocked'` with nothing left to block it, and the next {@link recomputeReady}
 * — which `task done` runs on any unrelated card — finds no unmet dependency and
 * promotes it to `ready`. That delayed, unattributable unblock is exactly what a
 * dependent-refusal prevents. Re-point or delete the dependents first.
 *
 * Deletion is allowed in any status, claimed or not: a mistakenly created card
 * must be removable without first releasing whoever picked it up.
 *
 * No ready-set recompute is needed. Only the target's OUTGOING edges disappear
 * (incoming ones are what the refusal guarantees do not exist), and those gate
 * nothing but the card being removed.
 */
export function deleteTask(db: Database, taskId: string): DeleteTaskResult {
  const remove = db.transaction(() => {
    const task = getTask(db, taskId);
    if (!task) throw new UnknownTaskError(taskId);

    const dependentRows = db
      .query('SELECT task_id FROM task_dependencies WHERE depends_on_id = ? ORDER BY task_id')
      .all(taskId) as Array<{ task_id: string }>;
    if (dependentRows.length > 0) {
      throw new TaskHasDependentsError(
        taskId,
        dependentRows.map((r) => r.task_id),
      );
    }

    // Explicit child deletes rather than leaning on ON DELETE CASCADE: the
    // removal is then total whether or not `PRAGMA foreign_keys` is on for this
    // connection, and each statement reports what it actually removed.
    const dependencies = db.query('DELETE FROM task_dependencies WHERE task_id = ?').run(taskId).changes;
    const events = db.query('DELETE FROM task_events WHERE task_id = ?').run(taskId).changes;
    const stages = db.query('DELETE FROM stage_log WHERE task_id = ?').run(taskId).changes;
    db.query('DELETE FROM tasks WHERE id = ?').run(taskId);
    return { task, dependencies, events, stages };
  });
  // BEGIN IMMEDIATE: the dependent check and the delete must not interleave with
  // a concurrent worktree adding an edge into this card, which would otherwise
  // land between the read and the write and be cascaded away unseen.
  return remove.immediate() as DeleteTaskResult;
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
  // Status CAS mirroring releaseTask's state-check-in-SQL idiom: a card that
  // concurrently left the completable statuses (already `done`, or re-blocked)
  // matches zero rows and we refuse with a typed {@link TaskCompleteError} — a
  // done card is never clobbered. There is deliberately NO claimed_by fence:
  // `task done` is the orchestrator's verb (mark REVIEWED work done), so the
  // completing identity is routinely NOT the claimant — the worker claims via
  // `checkout --worker w`, the orchestrator completes after review. The author
  // param attributes the timeline event; it does not gate the write. The
  // `release` event + recompute run ONLY inside the winning transaction.
  const complete = db.transaction(() => {
    const res = db
      .query(
        `UPDATE tasks
         SET status = 'done', updated_at = ?
         WHERE id = ?
           AND status IN ('ready', 'in_progress')`,
      )
      .run(now, taskId);
    if (res.changes === 1) {
      appendTaskEvent(db, taskId, {
        kind: 'release',
        note: 'completed',
        authorKind: author?.authorKind ?? undefined,
        author: author?.author ?? undefined,
      });
      recomputeReady(db);
    }
    return res.changes;
  });
  if (complete.immediate() !== 1) completeFailure(db, taskId);
  return getTask(db, taskId) as TaskRow;
}

/** Translate a refused completion (status CAS matched no completable row) into a typed error. */
function completeFailure(db: Database, taskId: string): never {
  const task = getTask(db, taskId);
  if (!task) throw new UnknownTaskError(taskId);
  // A block landing between the pre-check and the UPDATE still surfaces the
  // dependency-gate error, never a generic completion refusal.
  if (task.status === 'blocked') throw new TaskNotReadyError(taskId);
  throw new TaskCompleteError(taskId, task.status);
}

/** Translate a refused release (CAS matched no `in_progress` row) into a typed error. */
function releaseFailure(db: Database, taskId: string): never {
  const task = getTask(db, taskId);
  if (!task) throw new UnknownTaskError(taskId);
  throw new TaskReleaseError(taskId, task.status);
}

/**
 * Release a claim WITHOUT completing — returns an `in_progress` card to the
 * `ready` queue and clears the claim (including `heartbeat_at`, so the next
 * runtime to check the card out does not inherit the prior owner's liveness) so
 * another runtime can pick it up. The state
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
         SET status = 'ready', claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL, updated_at = ?
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
 * identity, which drives the checkout refusal), `blocked_reason`, and the
 * {@link BlockKind}, and appends a `block` event. `blocked_by` is always non-null
 * so the checkout gate can never be defeated by a missing identity — an anonymous
 * human falls back to its kind. The block kind is descriptive only: a `hold`
 * refuses checkout exactly as a `work` block does.
 */
export function blockTask(
  db: Database,
  taskId: string,
  reason: string,
  author: EventAuthor,
  kind: BlockKind = 'work',
): TaskRow {
  requireTask(db, taskId);
  const blockedBy = author.author ?? author.authorKind ?? 'unknown';
  const now = Date.now();
  const tx = db.transaction(() => {
    db.query('UPDATE tasks SET blocked_by = ?, blocked_reason = ?, block_kind = ?, updated_at = ? WHERE id = ?').run(
      blockedBy,
      reason,
      kind,
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

/** Clear an enforced block — provenance, reason, and kind together — and append an `unblock` event. */
export function unblockTask(db: Database, taskId: string, author: EventAuthor): TaskRow {
  requireTask(db, taskId);
  const now = Date.now();
  const tx = db.transaction(() => {
    db.query(
      'UPDATE tasks SET blocked_by = NULL, blocked_reason = NULL, block_kind = NULL, updated_at = ? WHERE id = ?',
    ).run(now, taskId);
    appendTaskEvent(db, taskId, {
      kind: 'unblock',
      authorKind: author.authorKind ?? undefined,
      author: author.author ?? undefined,
    });
  });
  tx();
  return getTask(db, taskId) as TaskRow;
}

// ============================================================================
// Declared routing (cross-agent-delegate W1)
// ============================================================================

/**
 * Validate one assignment pair against the W1 invariants — agent allowlisted
 * (WISH Decision 2) and both halves or neither (Decision 3) — returning the
 * normalized pair (reason trimmed). `null`/blank on both sides is the valid
 * "no assignment" state; exactly one blank half is rejected; a non-blank agent
 * must be a roster member. The single funnel every assignment write path uses.
 */
function validateAssignmentPair(
  agent: string | null,
  reason: string | null,
): { agent: RosterAgent | null; reason: string | null } {
  const agentValue = agent?.trim() || null;
  const reasonValue = reason?.trim() || null;
  if (agentValue == null && reasonValue == null) return { agent: null, reason: null };
  if (agentValue == null || reasonValue == null) throw new AssignmentReasonRequiredError();
  return { agent: requireRosterAgent(agentValue), reason: reasonValue };
}

/**
 * Declare which roster agent works a card and why — the W1 routing substrate
 * (assignment is declaration-only: no checkout gating, WISH Scope OUT). Works
 * at any card status; only the assignment columns and `updated_at` move, and an
 * `assign` event records the routing on the card timeline so the history rides
 * the thread. The write and the event are one transaction, so a card can never
 * carry an assignment with no matching timeline entry.
 *
 * Re-assigning the exact stored pair is fully silent: no row write (so
 * `updated_at` keeps its earlier value) and no timeline entry — the
 * set-wish/--clear precedent.
 */
export function assignTask(
  db: Database,
  taskId: string,
  agent: string,
  reason: string,
  author: EventAuthor = { author: null, authorKind: null },
  now: number = Date.now(),
): TaskRow {
  requireTask(db, taskId);
  const pair = validateAssignmentPair(agent, reason);
  if (pair.agent == null) throw new AssignmentReasonRequiredError();
  // The current-row read and no-op check run INSIDE the immediate transaction,
  // so concurrent assign/clear/reassign writers each decide against the row
  // state their own transaction serialized — never a read taken before another
  // writer's commit (and a card deleted in the window throws UnknownTaskError,
  // not an FK-constraint error from the event insert).
  const apply = db.transaction((): TaskRow => {
    const current = getTask(db, taskId);
    if (!current) throw new UnknownTaskError(taskId);
    if (current.assignedAgent === pair.agent && current.assignedReason === pair.reason) return current;
    db.query('UPDATE tasks SET assigned_agent = ?, assigned_reason = ?, updated_at = ? WHERE id = ?').run(
      pair.agent,
      pair.reason,
      now,
      taskId,
    );
    appendTaskEvent(db, taskId, {
      kind: 'assign',
      note: `assigned to ${pair.agent}: ${pair.reason}`,
      authorKind: author.authorKind ?? undefined,
      author: author.author ?? undefined,
    });
    return getTask(db, taskId) as TaskRow;
  });
  return apply.immediate() as TaskRow;
}

/**
 * Remove a card's declared routing — both halves together — and append a
 * `clear` event that names what was removed, so the routing history stays a
 * self-contained thread. Declaration-only like {@link assignTask}: no status
 * gate, and clearing an already-unassigned card is a silent no-op (the
 * set-wish/--clear precedent: no row write, no timeline entry).
 */
export function clearTaskAssignment(
  db: Database,
  taskId: string,
  author: EventAuthor = { author: null, authorKind: null },
  now: number = Date.now(),
): TaskRow {
  requireTask(db, taskId);
  // Read + no-op check inside the immediate transaction — the `was …` note must
  // name the pair this transaction actually serialized against (see assignTask).
  const apply = db.transaction((): TaskRow => {
    const current = getTask(db, taskId);
    if (!current) throw new UnknownTaskError(taskId);
    if (current.assignedAgent == null && current.assignedReason == null) return current;
    db.query('UPDATE tasks SET assigned_agent = NULL, assigned_reason = NULL, updated_at = ? WHERE id = ?').run(
      now,
      taskId,
    );
    appendTaskEvent(db, taskId, {
      kind: 'clear',
      note: `assignment cleared (was ${current.assignedAgent}: ${current.assignedReason})`,
      authorKind: author.authorKind ?? undefined,
      author: author.author ?? undefined,
    });
    return getTask(db, taskId) as TaskRow;
  });
  return apply.immediate() as TaskRow;
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
// Wish-slug resolution (read-only; the wish_groups UNION keeps legacy slugs)
// Wish identity
// ============================================================================

/** The lifecycle slug + wish-group a card carries. Both null ⇒ the card is wishless. */
export interface WishIdentity {
  wish: string | null;
  group: string | null;
}

export interface SetWishResult {
  task: TaskRow;
  from: WishIdentity;
  to: WishIdentity;
}

/** Render a wish identity for humans and timeline notes: `slug#group`, `slug`, or `(none)`. */
export function formatWishRef(identity: WishIdentity): string {
  if (!identity.wish) return '(none)';
  return identity.group ? `${identity.wish}#${identity.group}` : identity.wish;
}

/**
 * Re-point a card's lifecycle identity — attach, re-slug, or clear its `wish`
 * (and wish-group) — without delete-and-recreate. `id`, `created_at`, and the
 * checkout claim are untouched; only `wish`, `group_name`, and `updated_at`
 * move, recording a `wish` event on the card timeline.
 *
 * A group name is only meaningful under the wish it was declared in, so the new
 * identity is taken whole: nothing of the previous group survives a wish change,
 * and clearing the wish clears the group with it. Slugs are unvalidated TEXT,
 * exactly as {@link createTask} treats them. The current-row read, no-op check,
 * write, and event append all run inside one immediate transaction, so
 * concurrent assign/clear/reassign writers each derive their `from` (and the
 * timeline note) from the row state their transaction actually serialized
 * against — never from a read taken before another writer's commit.
 *
 * Re-pointing a card at the identity it already carries is fully silent: no row
 * write (so `updated_at` keeps its earlier value) and no timeline entry.
 */
export function setTaskWish(
  db: Database,
  taskId: string,
  to: WishIdentity,
  author: EventAuthor,
  now: number = Date.now(),
): SetWishResult {
  const next: WishIdentity = to.wish === null ? { wish: null, group: null } : to;
  const apply = db.transaction((): SetWishResult => {
    const task = getTask(db, taskId);
    if (!task) throw new UnknownTaskError(taskId);
    const from: WishIdentity = { wish: task.wish, group: task.group };
    if (from.wish === next.wish && from.group === next.group) return { task, from, to: next };
    const note = `${formatWishRef(from)}→${formatWishRef(next)}`;
    db.query('UPDATE tasks SET wish = ?, group_name = ?, updated_at = ? WHERE id = ?').run(
      next.wish,
      next.group,
      now,
      taskId,
    );
    appendTaskEvent(db, taskId, {
      kind: 'wish',
      note,
      authorKind: author.authorKind ?? undefined,
      author: author.author ?? undefined,
    });
    return { task: getTask(db, taskId) as TaskRow, from, to: next };
  });
  return apply.immediate() as SetWishResult;
}

/**
 * Link an existing card to a wish and, optionally, one of its groups — the
 * attach-only face of {@link setTaskWish}, kept for callers that always name a
 * wish. An omitted group clears any prior group association, and the wish does
 * not need to exist on disk; callers may intentionally create an orphan
 * association. Every mutation rule — the metadata-only UPDATE, the `wish`
 * timeline event, the silent no-op — is the one shared write path's.
 */
export function linkTaskToWish(
  db: Database,
  taskId: string,
  wish: string,
  group?: string,
  now: number = Date.now(),
  author: EventAuthor = { author: null, authorKind: null },
): TaskRow {
  return setTaskWish(db, taskId, { wish, group: group ?? null }, author, now).task;
}

// ============================================================================

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
  task_events: RawTaskEvent[];
  wish_groups: RawWishGroup[];
  hire_roster: RawHire[];
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
    hire_roster: db.query('SELECT * FROM hire_roster ORDER BY wish, agent_adapter_id').all() as RawHire[],
  };
}

// ============================================================================
// Full-state import (the other half of exportState — cross-machine resume)
// ============================================================================

/** A snapshot's structure or schemaVersion cannot be imported by this build. */
export class SnapshotFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotFormatError';
  }
}

/** Import refused because the database already holds state (use replace). */
export class NonEmptyImportError extends Error {
  constructor() {
    super(
      'Database already contains state. Re-run with --replace to overwrite it with the snapshot, or export the local state first if it must be kept.',
    );
    this.name = 'NonEmptyImportError';
  }
}

export interface ImportSummary {
  boards: number;
  tasks: number;
  dependencies: number;
  events: number;
  wishGroups: number;
  hires: number;
}

const SNAPSHOT_TABLE_KEYS = [
  'meta',
  'boards',
  'tasks',
  'task_dependencies',
  'stage_log',
  'task_events',
  'wish_groups',
  'hire_roster',
] as const;

/** Shape-validate an untrusted parsed snapshot; returns it typed or throws. */
function validateSnapshot(db: Database, snapshot: unknown): StateExport {
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new SnapshotFormatError('Snapshot is not a JSON object.');
  }
  const candidate = snapshot as Record<string, unknown>;
  if (typeof candidate.schemaVersion !== 'number') {
    throw new SnapshotFormatError('Snapshot is missing a numeric schemaVersion.');
  }
  for (const key of SNAPSHOT_TABLE_KEYS) {
    if (!Array.isArray(candidate[key])) {
      throw new SnapshotFormatError(`Snapshot is missing the "${key}" table array.`);
    }
  }
  const current = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (candidate.schemaVersion !== current) {
    throw new SnapshotFormatError(
      `Snapshot schemaVersion ${candidate.schemaVersion} does not match this database (${current}). Re-export the snapshot with a matching genie version.`,
    );
  }
  return candidate as unknown as StateExport;
}

/**
 * True when any operational table holds rows (meta alone does not count). By
 * default `hire_roster` counts; pass `includeHireRoster: false` for
 * roadmap-scoped decisions, where hires must never gate (their rows are
 * machine-local and excluded from the snapshot).
 */
export function hasOperationalState(db: Database, opts: { includeHireRoster?: boolean } = {}): boolean {
  const tables = ['boards', 'tasks', 'task_events', 'stage_log', 'wish_groups'];
  if (opts.includeHireRoster !== false) tables.push('hire_roster');
  for (const table of tables) {
    const row = db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    if (row.n > 0) return true;
  }
  return false;
}

/**
 * Insert the tasks slice of a snapshot. Column enumeration lives HERE — 18
 * columns, the widest row the snapshot carries. Nullable-with-?? throughout:
 * additive columns (lane, agent_kind, …, assigned_agent/assigned_reason)
 * backfill without a user_version bump, so a same-version snapshot from an
 * older build may legitimately omit them.
 */
function insertTaskRows(db: Database, tasks: StateExport['tasks']): void {
  const task = db.query(
    `INSERT INTO tasks (id, board_id, title, status, claimed_by, claimed_at, wish, group_name,
                        assigned_agent, assigned_reason,
                        lane, agent_kind, heartbeat_at, blocked_by, blocked_reason, block_kind, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const t of tasks) {
    task.run(
      t.id,
      t.board_id ?? null,
      t.title,
      t.status,
      t.claimed_by ?? null,
      t.claimed_at ?? null,
      t.wish ?? null,
      t.group_name ?? null,
      t.assigned_agent ?? null,
      t.assigned_reason ?? null,
      t.lane ?? null,
      t.agent_kind ?? null,
      t.heartbeat_at ?? null,
      t.blocked_by ?? null,
      t.blocked_reason ?? null,
      t.block_kind ?? null,
      t.created_at,
      t.updated_at,
    );
  }
}

function insertSnapshotRows(db: Database, state: StateExport): void {
  const meta = db.query('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  for (const m of state.meta) meta.run(m.key, m.value);

  const board = db.query('INSERT INTO boards (id, name, lanes, created_at) VALUES (?, ?, ?, ?)');
  for (const b of state.boards) board.run(b.id, b.name, b.lanes ?? null, b.created_at);

  insertTaskRows(db, state.tasks);

  const dep = db.query('INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)');
  for (const d of state.task_dependencies) dep.run(d.task_id, d.depends_on_id);

  const stage = db.query('INSERT INTO stage_log (id, task_id, stage, note, created_at) VALUES (?, ?, ?, ?, ?)');
  for (const s of state.stage_log) stage.run(s.id, s.task_id, s.stage, s.note ?? null, s.created_at);

  const event = db.query(
    'INSERT INTO task_events (id, task_id, kind, note, author_kind, author, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const e of state.task_events) {
    event.run(e.id, e.task_id, e.kind, e.note ?? null, e.author_kind ?? null, e.author ?? null, e.created_at);
  }

  // wish_groups is tolerated-and-dropped: the machinery that wrote it is
  // production-dead, so a legacy snapshot's rows are never re-inserted and
  // the surviving table stays empty. validateSnapshot still requires the key
  // (SNAPSHOT_TABLE_KEYS) so older binaries' snapshots import cleanly.

  const hire = db.query(
    'INSERT INTO hire_roster (wish, agent_adapter_id, profile, worktree, hired_at, state) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const h of state.hire_roster) {
    hire.run(h.wish, h.agent_adapter_id, h.profile ?? null, h.worktree, h.hired_at, h.state);
  }
}

/** True when the failure is a row-schema problem (constraint, NOT NULL, datatype). */
function isRowSchemaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code;
  return typeof code === 'string' && (code.startsWith('SQLITE_CONSTRAINT') || code === 'SQLITE_MISMATCH');
}

/**
 * Clear every table under replace so the db becomes EXACT snapshot state. A db
 * with only meta rows (e.g. the backfill marker a fresh open stamps) must not
 * merge stale keys into the snapshot's meta — a retained wish_sig marker would
 * misdescribe the imported rows as drifted. Children before parents so FK
 * cascades never fire mid-wipe; hire_roster sits with its parent tables, only
 * when it is not preserved.
 */
function wipeAllTables(db: Database, preserveHireRoster: boolean): void {
  const wipe = [
    'task_events',
    'stage_log',
    'task_dependencies',
    'tasks',
    ...(preserveHireRoster ? [] : ['hire_roster']),
    'wish_groups',
    'boards',
    'meta',
  ];
  for (const table of wipe) {
    db.query(`DELETE FROM ${table}`).run();
  }
}

/**
 * Reclassify an apply() failure: structural and row-schema problems become
 * {@link SnapshotFormatError}; transient SQLITE_BUSY / LOCKED / IOERR and
 * unrelated failures propagate unchanged, so a healthy snapshot owner is never
 * told to "repair the malformed rows" over a lock contention.
 */
function rethrowImportFailure(err: unknown): never {
  if (err instanceof SnapshotFormatError || err instanceof NonEmptyImportError) throw err;
  if (!isRowSchemaError(err)) throw err;
  throw new SnapshotFormatError(
    `Snapshot rows could not be imported: ${err instanceof Error ? err.message : String(err)}. The database was left unchanged; re-export the snapshot or repair the malformed rows.`,
  );
}

/** Options controlling snapshot import. */
export interface ImportOptions {
  replace?: boolean;
  /**
   * Leave the local hire_roster untouched (neither wiped nor inserted). Set for
   * roadmap-scoped snapshots: hires carry machine-local worktree paths that
   * must never travel between machines.
   */
  preserveHireRoster?: boolean;
}

/**
 * Restore a full {@link exportState} snapshot into this database — the resume
 * path for a fresh clone on another machine (`genie task import`). Refuses a
 * database that already holds operational state unless `replace` is set, in
 * which case every table is cleared and rebuilt from the snapshot inside one
 * transaction. Row ids (including event/stage autoincrement ids) are preserved
 * exactly, so an export → import round-trip is lossless. The emptiness guard
 * skips `hire_roster` when it is preserved, since rows the import never touches
 * cannot justify a refusal.
 */
export function importState(db: Database, snapshot: unknown, opts: ImportOptions = {}): ImportSummary {
  const state = validateSnapshot(db, snapshot);
  const hires = opts.preserveHireRoster ? [] : state.hire_roster;
  const apply = db.transaction(() => {
    if (hasOperationalState(db, { includeHireRoster: !opts.preserveHireRoster }) && !opts.replace) {
      throw new NonEmptyImportError();
    }
    if (opts.replace) wipeAllTables(db, opts.preserveHireRoster ?? false);
    insertSnapshotRows(db, { ...state, hire_roster: hires });
    // A legacy snapshot predates the task_events timeline: it carries
    // stage_log history and no events. The fresh open already stamped the
    // backfill marker, so the one-time migration would never mirror these
    // rows; clear the guard (--replace already wiped it via wipeAllTables) and
    // re-run the backfill HERE, inside the import transaction. Deferring it to
    // the next openDb left this handle's timeline empty and let syncRoadmap
    // record a pre-backfill baseline hash — the next `task sync` (run by the
    // git hooks) then saw dbChanged && !fileChanged and rewrote the
    // git-tracked roadmap.json purely because the migration fired between two
    // unrelated commands. Stage rows whose events are already in the snapshot
    // (task_events non-empty) are left alone — no duplication.
    if (state.stage_log.length > 0 && state.task_events.length === 0) {
      db.query('DELETE FROM meta WHERE key = ?').run(STAGE_LOG_BACKFILL_KEY);
      backfillStageLog(db);
    } else {
      // Non-legacy snapshot: its timeline (if any) is already complete. Re-stamp
      // the backfill marker in case `--replace` wiped meta and the snapshot's own
      // meta rows lost the marker (e.g. a hand-merged roadmap.json). Without
      // this, the next openDb would find the shape current but the marker
      // absent and re-run backfillStageLog over stage rows whose events the
      // snapshot already carried — duplicating every mirrored timeline row.
      db.query('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(STAGE_LOG_BACKFILL_KEY, String(Date.now()));
    }
  });
  try {
    apply();
  } catch (err) {
    // A malformed row that passed shape validation (roadmap.json survives git
    // merges) surfaces as a raw SQLite constraint error — rethrow it in the
    // same actionable class as the structural checks. The transaction rolled
    // back; the error classifier keeps unrelated failures untouched.
    rethrowImportFailure(err);
  }
  return {
    boards: state.boards.length,
    tasks: state.tasks.length,
    dependencies: state.task_dependencies.length,
    events: state.task_events.length,
    // wish_groups rows are tolerated-and-dropped (see insertSnapshotRows), so
    // the summary reports what was actually inserted — never the snapshot's
    // discarded row count.
    wishGroups: 0,
    hires: hires.length,
  };
}
