/**
 * Genie v5 tool projections and historical dispatch handlers for
 * `.genie/genie.db`: 5 read tools (`MCP_TOOLS`) plus the retained 12 operative
 * write handlers (`MCP_WRITE_TOOLS`). The public write-capable MCP command is
 * retired; standalone board/task commands remain authoritative.
 *
 * The live read-only bridge loads this module without pulling its SQLite opens
 * into unrelated `genie board`, `genie task`, or `genie --help` paths.
 *
 * The retained {@link openWriteableDb} contract covers the historical hardened
 * write path and its degrade behavior. Readonly open internals remain live for
 * `genie ui-bridge`, which injects its own readonly open.
 */

import { constants, Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { assertLocalLifecycleEnabled } from '../orchestration-mode.js';
import {
  BusyDbError,
  type ProjectContext,
  type ProjectDatabaseBinding,
  isCurrentGenieDb,
  isReadableGenieDb,
  openDb,
  resolveDbPath,
  resolveProjectDatabaseBinding,
} from './genie-db.js';
import { resolveEventAuthor } from './identity.js';
import { type ToolErrorResult, isToolError, toolError } from './mcp-server.js';
import { resolveWishBranch } from './resolve-wish-branch.js';
import { BUSY_TIMEOUT_MS, isBusyError, openWithWalIndexRecovery } from './sqlite-open.js';

// Re-exported for the fail-closed bridge context path while keeping bun:sqlite
// opens out of the eager genie.ts import graph.
export { type ProjectContext, resolveProjectContext } from './genie-db.js';
import {
  type BlockKind,
  CheckoutConflictError,
  CycleError,
  type EventAuthor,
  type FrozenTaskRow,
  LaneError,
  TaskBlockedError,
  TaskCompleteError,
  type TaskFilter,
  TaskNotReadyError,
  TaskReleaseError,
  type TaskRow,
  UnknownBoardError,
  UnknownTaskError,
  type WishGroupRow,
  addDependency,
  appendTaskEvent,
  blockTask,
  claimTask,
  completeTask,
  createTask,
  getBoardByName,
  getTask,
  listTasks,
  listWishSlugs,
  moveTask,
  recordHeartbeat,
  releaseTask,
  resolveBoard,
  setTaskWish,
  toFrozenTaskRow,
  unblockTask,
} from './task-state.js';

// ============================================================================
// Read-only DB open (exact validated binding; null on any mismatch)
// ============================================================================

export interface ReadonlyDbOpenDependencies {
  /** Test seam around the constructor; production always opens Bun SQLite readonly. */
  openDatabase?: (path: string) => Database;
  /** Test seam for deterministic moved/unsupported-handle refusal. */
  verifyOpenedHandle?: (db: Database) => boolean;
}

/**
 * Ask SQLite's opened VFS handle whether its pathname still names that handle.
 * A nonzero return code, moved flag, or exception (including an unsupported
 * VFS) is a fail-closed mismatch.
 */
export function readonlyDatabaseHandleMatchesPath(db: Pick<Database, 'fileControl'>): boolean {
  const moved = new Int32Array(1);
  try {
    const result = db.fileControl(constants.SQLITE_FCNTL_HAS_MOVED, moved);
    return result === 0 && moved[0] === 0;
  } catch {
    return false;
  }
}

function closeReadonlyDb(db: Database | null): void {
  try {
    db?.close();
  } catch {
    // The caller is already failing closed; cleanup must not turn null into a throw.
  }
}

/**
 * Open the repo's shared `.genie/genie.db` READ-ONLY. A project MCP caller
 * supplies the exact physical binding produced by `resolveProjectContext`;
 * legacy callers may supply cwd and receive the same path validation here.
 * Symlinks, non-regular files, and identity substitutions return `null`.
 *
 * The read-only connection is given the SAME `busy_timeout` as the shared write
 * primitive (see sqlite-open.ts): under concurrent access a straggling WAL
 * writer must be waited out, not surfaced as an instant `-32603 "database is
 * locked"`. `busy_timeout` is valid on a readonly connection and does not
 * mutate the file. The binding is revalidated both before and after SQLite opens
 * it. SQLite's `SQLITE_FCNTL_HAS_MOVED` check additionally binds the opened VFS
 * handle itself, catching an A→B constructor race even if the path is restored
 * to A before post-open lstat. Unsupported VFS implementations fail closed.
 */
export function openReadonlyDb(
  target?: string | ProjectDatabaseBinding,
  dependencies: ReadonlyDbOpenDependencies = {},
): Database | null {
  assertLocalLifecycleEnabled();
  const initial =
    typeof target === 'object'
      ? resolveProjectDatabaseBinding(target.logicalPath, target)
      : resolveProjectDatabaseBinding(resolveDbPath(target));
  if (!initial.ok) return null;
  let db: Database | null = null;
  const verifyOpenedHandle = dependencies.verifyOpenedHandle ?? readonlyDatabaseHandleMatchesPath;
  try {
    db =
      dependencies.openDatabase?.(initial.binding.physicalPath) ??
      new Database(initial.binding.physicalPath, { readonly: true });
    if (!verifyOpenedHandle(db)) {
      closeReadonlyDb(db);
      return null;
    }
    const revalidated = resolveProjectDatabaseBinding(initial.binding.logicalPath, initial.binding);
    if (!revalidated.ok) {
      closeReadonlyDb(db);
      return null;
    }
    if (!verifyOpenedHandle(db)) {
      closeReadonlyDb(db);
      return null;
    }
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    return db;
  } catch {
    closeReadonlyDb(db);
    return null;
  }
}

/**
 * Read-only open that self-heals an additive-lag schema before failing closed.
 *
 * Additive columns land within `user_version = 1` and are backfilled only by
 * write-path opens (`openDb` → `ensureSchema`), so a database stamped by an
 * earlier build stays permanently rejected by `isCurrentGenieDb` for a consumer
 * that only ever reads — such as the read-only bridge. When (and only when) a successful
 * readonly open validates stale, run the same idempotent write-path open every
 * CLI command already performs, then reopen readonly through the full hardened
 * binding path.
 *
 * An ABSENT database never reaches the write open (`openReadonlyDb` returns
 * null first), preserving this module's no-create contract. A foreign, future
 * (`user_version` ≠ current), or malformed database is refused by `openDb`'s
 * typed guards, so everything that is not additive lag still fails closed —
 * with one carve-out: when the heal WRITE itself is impossible (read-only
 * filesystem) but the schema shape is already current, the database is served
 * readonly anyway via {@link isReadableGenieDb}.
 */
export function openReadonlyDbHealingStaleSchema(target?: string | ProjectDatabaseBinding): Database | null {
  const db = openReadonlyDb(target);
  if (db === null) return null;
  let current = false;
  try {
    current = isCurrentGenieDb(db);
  } catch {
    closeReadonlyDb(db);
    return null;
  }
  if (current) return db;
  closeReadonlyDb(db);
  try {
    if (typeof target === 'object') {
      // The validated readonly handle is closed, so nothing pins the path's
      // identity while openDb creates a WRITABLE handle. Revalidate the exact
      // binding at the last moment so a racing substitution cannot route
      // ensureSchema's DDL into a swapped file or symlink target; the
      // post-heal hardened reopen below re-verifies both the binding and the
      // opened handle before any tool can observe a healed database.
      if (!resolveProjectDatabaseBinding(target.logicalPath, target).ok) return null;
      openDb({ path: target.physicalPath }).close();
    } else {
      openDb({ path: resolveDbPath(target) }).close();
    }
  } catch {
    // The write-path heal itself failed — read-only mount, a sandboxed process
    // with read-but-not-write access to .genie/genie.db, a CI checkout. When
    // the database's SHAPE is already current and only a data-only migration
    // marker is pending, every read still works: degrade to serving it instead
    // of failing closed on state no read depends on. A shape-stale database
    // (missing columns this build queries) stays refused.
    return reopenReadableDespiteFailedHeal(target);
  }
  return openReadonlyDb(target);
}

/** Post-heal-failure fallback: serve the database readonly iff its shape is current. */
function reopenReadableDespiteFailedHeal(target?: string | ProjectDatabaseBinding): Database | null {
  const db = openReadonlyDb(target);
  if (db === null) return null;
  try {
    if (isReadableGenieDb(db)) return db;
  } catch {
    // malformed while inspecting — fall through to the close below
  }
  closeReadonlyDb(db);
  return null;
}

// ============================================================================
// Write-capable DB open (hardened write path + read-only-degrade fallback)
// ============================================================================

/**
 * Handles served by the read-only-degrade fallback inside {@link openWriteableDb}.
 * Membership is DERIVED FROM WHICH OPEN PRODUCED THE HANDLE — never a latched
 * session flag: a handle added here was produced by the readonly healing open
 * after the write path failed, so writes through it would raise SQLITE_READONLY.
 * The operative write tools (Group 2) consult {@link isDegradedReadonlyDb} to
 * return a typed `read_only_database` error instead of a protocol failure. The
 * per-open derivation means a repaired filesystem restores writes on the next
 * successful write open (fresh handle, no membership) and a later failure
 * re-degrades (fresh handle, membership again) — and the server loop re-opens
 * per call while its handle is degraded (`isDegradedHandle`), so that recovery
 * lands inside a live session instead of waiting for a client restart.
 */
const degradedReadonlyHandles = new WeakSet<Database>();

/** True when `db` was produced by the read-only-degrade fallback (writes would fail). */
export function isDegradedReadonlyDb(db: Database | null | undefined): boolean {
  return db !== null && db !== undefined && degradedReadonlyHandles.has(db);
}

/** Open a readonly fallback and mark it so writes stay typed and promotion keeps retrying. */
export function openDegradedReadonlyDb(target?: string | ProjectDatabaseBinding): Database | null {
  const degraded = openReadonlyDbHealingStaleSchema(target);
  if (degraded !== null) degradedReadonlyHandles.add(degraded);
  return degraded;
}

/**
 * Open the repo's shared `.genie/genie.db` WRITE-CAPABLE through the standard
 * hardened CLI path, degrading to the readonly healing open when the write is
 * impossible. Retained for its hardened open/degrade contract tests.
 *
 * 1. WRITE PATH — revalidate the exact `resolveProjectDatabaseBinding` binding
 *    (Decision 4: writes into a substituted/symlinked db are strictly worse
 *    than reads), refuse up front when the file is not writable (bun:sqlite
 *    silently opens a READONLY connection on some platforms instead of
 *    throwing — a pre-check keeps degrade deterministic everywhere), then
 *    `openDb` (WAL + `busy_timeout` + idempotent schema — the exact primitive
 *    every CLI command uses). EVERY throw (`MalformedDbError`, `ForeignDbError`,
 *    anything) is caught and translated to the loop's `null` contract: the
 *    injected open never lets an exception escape (the loop calls it outside
 *    any `try`). Post-open binding + VFS-handle revalidation mirrors the
 *    readonly path: a mid-open substitution is bounded to the open itself —
 *    DDL that already ran against a substituted file cannot be undone, but the
 *    mismatched handle is discarded before any tool can observe or mutate it
 *    (the same residual as the readonly healing path).
 * 2. STALE-READONLY-SIDECAR RECOVERY — a poisoned WAL index (the read-only
 *    header the degrade fallback's own close leaves in `-shm`) is healed around
 *    the write open by `openWithWalIndexRecovery` (see {@link tryWriteOpen}).
 *    The heal is scoped to THIS path — never the fleet-wide `openSqlite` — for
 *    the reason spelled out in sqlite-open.ts: only here is the poison created,
 *    and only here is the concurrency low enough for the probe to be safe. A
 *    poison the heal cannot repair (un-checkpointed frames, or a live peer)
 *    surfaces as a typed `WalIndexPoisonError` and falls through to (4).
 * 3. BUSY CARVE-OUT — when the write-open failure is a `BusyDbError` (the
 *    write lock was contended past `busy_timeout` + backoff — the db is
 *    healthy, another process is writing), return `null` WITHOUT the
 *    read-only-degrade fallback: a fully-writable db that merely lost a lock
 *    race must not be marked degraded for the session (write tools would
 *    otherwise report `read_only_database` for a merely-busy db). The loop's
 *    per-call reopen retries the write open on the next call.
 * 4. READ-ONLY-DEGRADE FALLBACK — when the write path still fails
 *    (write-protected file/filesystem, malformed, foreign), fall back to the
 *    readonly healing open. The loop's strict `validateReadonlyDb:
 *    isCurrentGenieDb` adjudicates the fallback handle: exactly the
 *    fully-current database is served, unchanged from today's behavior. The
 *    degraded handle is marked in {@link isDegradedReadonlyDb}; the state is
 *    recomputed per open, never latched.
 *
 * The no-create guarantee rests on resolver ordering (Decision 5): a non-`ok`
 * project context never reaches this open, so `openDb`'s mkdir/create side
 * effects are unreachable outside a healthy genie repo — MCP never creates
 * `.genie/` or `genie.db`.
 */
export interface WriteableDbOpenDependencies {
  /** Test seam around the write-path open; production always uses `genie-db`'s `openDb`. */
  openDatabase?: (path: string) => Database;
}

/** Result of one write-path attempt: a validated handle, or a null with its cause. */
interface WriteOpenAttempt {
  db: Database | null;
  /** True when the open failed on transient write-lock contention (`BusyDbError`). */
  busy: boolean;
}

export function openWriteableDb(
  target?: string | ProjectDatabaseBinding,
  dependencies: WriteableDbOpenDependencies = {},
): Database | null {
  const initial =
    typeof target === 'object'
      ? resolveProjectDatabaseBinding(target.logicalPath, target)
      : resolveProjectDatabaseBinding(resolveDbPath(target));
  let db: Database | null = null;
  if (initial.ok) {
    const attempt = tryWriteOpen(initial.binding, dependencies);
    if (attempt.busy) return null; // contended write lock — never degrade a healthy-but-busy db
    db = attempt.db;
  }
  if (db !== null) return db;
  return openDegradedReadonlyDb(target);
}

/** True when the db file itself is writable (bun:sqlite would open it read-write). */
function isFileWritable(path: string): boolean {
  try {
    accessSync(path, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * One write-path attempt: writability gate → open (under WAL-index recovery) →
 * post-open revalidation.
 *
 * This is the ONE place `openWithWalIndexRecovery` is wired in, because this is
 * the one place that CREATES the poison it heals: the degrade fallback below
 * hands out a read-only handle, and closing that handle (the loop's
 * `promoteDegradedHandle`) is what writes the read-only WAL-index header into
 * `-shm`. Scoping the heal here keeps the probe's journal-mode churn out of the
 * fleet-wide `openSqlite` hot path, where the virgin-vs-poison header ambiguity
 * would fire it on healthy contended databases (see the recovery section in
 * sqlite-open.ts). A single-owner MCP session is exactly the low-concurrency
 * context the heal is safe in.
 */
function tryWriteOpen(binding: ProjectDatabaseBinding, dependencies: WriteableDbOpenDependencies): WriteOpenAttempt {
  if (!isFileWritable(binding.physicalPath)) return { db: null, busy: false };
  const open = (): Database =>
    dependencies.openDatabase?.(binding.physicalPath) ?? openDb({ path: binding.physicalPath });
  let db: Database | null = null;
  try {
    db = openWithWalIndexRecovery(binding.physicalPath, open);
    // Post-open revalidation: the binding AND the opened VFS handle must still
    // name the validated file before any tool can observe or mutate it. This
    // bounds a mid-open substitution to the open itself — DDL that already ran
    // against a substituted file cannot be undone, but the mismatched handle is
    // discarded here, never visible to a tool.
    if (!resolveProjectDatabaseBinding(binding.logicalPath, binding).ok || !readonlyDatabaseHandleMatchesPath(db)) {
      closeReadonlyDb(db);
      return { db: null, busy: false };
    }
    return { db, busy: false };
  } catch (err) {
    // A contended lock (typed by the shared open, or raw from an injected one)
    // is transient: the caller must not degrade the session for it.
    closeReadonlyDb(db);
    return { db: null, busy: err instanceof BusyDbError || isBusyError(err) };
  }
}

// ============================================================================
// Payload shapes
// ============================================================================

export interface TaskSummary {
  id: string;
  title: string;
  status: TaskRow['status'];
  claimedBy: string | null;
  wish: string | null;
  group: string | null;
}

function toSummary(t: TaskRow): TaskSummary {
  return { id: t.id, title: t.title, status: t.status, claimedBy: t.claimedBy, wish: t.wish, group: t.group };
}

interface StatusCounts {
  blocked: number;
  ready: number;
  in_progress: number;
  done: number;
  total: number;
}

function tally(tasks: TaskRow[]): StatusCounts {
  const counts: StatusCounts = { blocked: 0, ready: 0, in_progress: 0, done: 0, total: 0 };
  for (const t of tasks) {
    counts[t.status]++;
    counts.total++;
  }
  return counts;
}

// ============================================================================
// Git branch resolution (for genie_worktree_context)
// ============================================================================

/** Current git branch of `cwd`, or `null` when unavailable (detached / not a repo). */
function currentBranch(cwd: string): string | null {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    return null;
  }
}

/**
 * `wish/<slug>[-<group>]` disambiguation lives in the shared
 * {@link resolveWishBranch} module — same implementation the SessionStart hook
 * bundles (see resolve-wish-branch.ts). The board supplies genie.db slugs,
 * longest-first; the hook supplies its own merged slug list.
 */

// ============================================================================
// Tool context + registry
// ============================================================================

export interface ToolContext {
  /** Database handle for this call (write-capable or degraded-readonly), or `null` when absent. */
  db: Database | null;
  /** Working directory for git branch resolution. Defaults to `process.cwd()`. */
  cwd: string;
  /**
   * The fail-closed project context resolved by the server loop when a resolver
   * is injected. When its `kind` is not `ok`, the loop returns a typed error for
   * every tool call instead of an empty board (see mcp-server.ts). Absent for
   * consumers (e.g. ui-bridge) that do not opt into fail-closed resolution.
   */
  context?: ProjectContext;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(ctx: ToolContext, args: Record<string, unknown>): unknown;
}

function argString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// --- genie_board -----------------------------------------------------------

interface BoardPayload {
  board: string | null;
  counts: StatusCounts;
  tasks: TaskSummary[];
}

function genieBoard(ctx: ToolContext, args: Record<string, unknown>): BoardPayload {
  const emptyCounts: StatusCounts = { blocked: 0, ready: 0, in_progress: 0, done: 0, total: 0 };
  const boardArg = argString(args, 'board');
  const wishArg = argString(args, 'wish');
  if (!ctx.db) return { board: boardArg ?? null, counts: emptyCounts, tasks: [] };

  const filter: TaskFilter = {};
  let boardName: string | null = null;
  if (boardArg) {
    const board = getBoardByName(ctx.db, boardArg);
    // Unknown board name → empty projection (never throws at caller).
    if (!board) return { board: boardArg, counts: emptyCounts, tasks: [] };
    boardName = board.name;
    filter.boardId = board.id;
  }
  if (wishArg) filter.wish = wishArg;

  const tasks = listTasks(ctx.db, filter);
  return { board: boardName, counts: tally(tasks), tasks: tasks.map(toSummary) };
}

// --- genie_wish_status -----------------------------------------------------

interface WishStatusPayload {
  wish: string;
  groups: Array<Omit<WishGroupRow, 'wish'>>;
  tasks: TaskSummary[];
}

function genieWishStatus(ctx: ToolContext, args: Record<string, unknown>): WishStatusPayload {
  const wish = argString(args, 'wish') ?? '';
  if (!ctx.db) return { wish, groups: [], tasks: [] };
  const groups: WishStatusPayload['groups'] = []; // wish-group machinery is production-dead — literal empty
  const tasks = listTasks(ctx.db, { wish });
  return { wish, groups, tasks: tasks.map(toSummary) };
}

// --- genie_worktree_context ------------------------------------------------

interface WorktreeContextPayload {
  branch: string | null;
  resolved: boolean;
  wish: string | null;
  group: string | null;
  tasks: TaskSummary[];
}

function genieWorktreeContext(ctx: ToolContext, args: Record<string, unknown>): WorktreeContextPayload {
  const branch = argString(args, 'branch') ?? currentBranch(ctx.cwd);
  const parsed = branch ? resolveWishBranch(ctx.db ? listWishSlugs(ctx.db) : [], branch) : null;

  if (parsed) {
    const wishTasks = ctx.db ? listTasks(ctx.db, { wish: parsed.wish }) : [];
    // Top-level wish branch (no group) → all of the wish's tasks; a group branch → just that group.
    const tasks = parsed.group === null ? wishTasks : wishTasks.filter((t) => t.group === parsed.group);
    return { branch, resolved: true, wish: parsed.wish, group: parsed.group, tasks: tasks.map(toSummary) };
  }

  // Non-wish branch (or none) → repo-board fallback: all tasks, unresolved.
  const tasks = ctx.db ? listTasks(ctx.db, {}) : [];
  return { branch, resolved: false, wish: null, group: null, tasks: tasks.map(toSummary) };
}

// --- genie_task ------------------------------------------------------------

// The frozen `genie_task` payload is exactly the pre-assignment TaskRow key
// set (WISH Decision 7) — the shared projection lives in task-state.ts next
// to TaskRow, so `task list --json` and this MCP shape cannot drift apart.

function genieTask(
  ctx: ToolContext,
  args: Record<string, unknown>,
): FrozenTaskRow | { error: 'not_found'; id: string } {
  const id = argString(args, 'id') ?? '';
  const task = ctx.db ? getTask(ctx.db, id) : null;
  return task ? toFrozenTaskRow(task) : { error: 'not_found', id };
}

// --- genie_active ----------------------------------------------------------

interface ActiveTask extends TaskSummary {
  claimedAt: number | null;
}

function genieActive(ctx: ToolContext): { tasks: ActiveTask[] } {
  if (!ctx.db) return { tasks: [] };
  const tasks = listTasks(ctx.db, { status: 'in_progress' });
  return { tasks: tasks.map((t) => ({ ...toSummary(t), claimedAt: t.claimedAt })) };
}

// ============================================================================
// The 5 read tools (the read registry ui-bridge splices)
// ============================================================================

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'genie_board',
    description: 'Board status counts and tasks; optional board name and wish-slug filters.',
    inputSchema: {
      type: 'object',
      properties: {
        board: { type: 'string', description: 'board name; default repo board' },
        wish: { type: 'string', description: 'filter to a wish slug' },
      },
      required: [],
    },
    handler: genieBoard,
  },
  {
    name: 'genie_wish_status',
    description: "A wish's execution groups (DAG progress) and its tasks.",
    inputSchema: {
      type: 'object',
      properties: { wish: { type: 'string', description: 'wish slug' } },
      required: ['wish'],
    },
    handler: genieWishStatus,
  },
  {
    name: 'genie_worktree_context',
    description:
      "Resolve a wish/<slug>-<group> git branch to its wish, group, and tasks (the pane's 'what am I here for').",
    inputSchema: {
      type: 'object',
      properties: { branch: { type: 'string', description: 'override; default = current git branch' } },
      required: [],
    },
    handler: genieWorktreeContext,
  },
  {
    name: 'genie_task',
    description: 'Full detail for a single task by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'task id, e.g. t_...' } },
      required: ['id'],
    },
    handler: genieTask,
  },
  {
    name: 'genie_active',
    description: 'All in-progress tasks and who claimed each.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: (ctx) => genieActive(ctx),
  },
];

// ============================================================================
// Operative write tools (Group 2 of wish mcp-write-tools)
// ============================================================================
//
// The 12 operative-core mutation verbs as thin wrappers over the EXACT
// `task-state.ts` functions `genie task` uses (Decision 3: never reimplement
// the mutation semantics). Each tool:
//   1. refuses a null/degraded handle up front (typed `read_only_database`);
//   2. dispatches to the same function + argument shapes as v5-task.ts;
//   3. wraps the mutation in ONE catch boundary mapping the task-state domain
//      error classes to typed `isError: true` payload codes.
//
// Error payload codes (documented per tool in `description`):
//   claim_conflict    — CheckoutConflictError (lost the claim race)
//   not_found         — UnknownTaskError / UnknownBoardError (board ref in `detail`)
//   invalid_lane      — LaneError
//   dependency_cycle  — CycleError
//   refused_transition— TaskBlockedError / TaskNotReadyError /
//                       TaskCompleteError / TaskReleaseError (class name in `detail`)
//   read_only_database— degraded readonly handle (checked first) OR a raw
//                       SQLite readonly-class write failure past that check
//   invalid_arguments — missing/malformed tool arguments
//   database_unavailable — defensive null-handle guard (unreachable in the
//                       fail-closed server, which refuses to dispatch on null)
// Unexpected errors are NOT mapped — they propagate to the loop's `-32603`
// backstop.

/** A mapped write-tool error payload: `error` code plus per-code fields. */
type WriteErrorPayload = Record<string, unknown> & { error: string };

/**
 * True for raw SQLite readonly-class write failures (`SQLITE_READONLY` and its
 * extended variants) — the belt-and-suspenders backstop for a write that
 * reaches a degraded readonly handle past the {@link isDegradedReadonlyDb}
 * check. bun surfaces these as `SQLiteError` with `code: 'SQLITE_READONLY'`
 * and `errno: 8` (the primary SQLite result code; extended codes keep it in
 * the low byte).
 */
function isSqliteReadonlyError(err: Error): boolean {
  const errno = (err as { errno?: unknown }).errno;
  if (typeof errno === 'number' && (errno & 0xff) === 8) return true;
  return /SQLITE_READONLY|readonly database/i.test(err.message);
}

/** Map a thrown task-state domain error to a typed payload, or null to rethrow. */
function mapWriteError(err: unknown): WriteErrorPayload | null {
  if (err instanceof CheckoutConflictError) {
    return { error: 'claim_conflict', taskId: err.taskId, message: err.message };
  }
  if (err instanceof UnknownTaskError) {
    return { error: 'not_found', id: err.id, message: err.message };
  }
  if (err instanceof UnknownBoardError) {
    return { error: 'not_found', detail: err.ref, message: err.message };
  }
  if (err instanceof LaneError) {
    return { error: 'invalid_lane', message: err.message };
  }
  if (err instanceof CycleError) {
    return { error: 'dependency_cycle', message: err.message };
  }
  if (
    err instanceof TaskBlockedError ||
    err instanceof TaskNotReadyError ||
    err instanceof TaskCompleteError ||
    err instanceof TaskReleaseError
  ) {
    return { error: 'refused_transition', detail: err.constructor.name, message: err.message };
  }
  if (err instanceof Error && isSqliteReadonlyError(err)) {
    return { error: 'read_only_database', detail: err.message };
  }
  return null; // unexpected — propagate to the loop's -32603 backstop
}

/** ONE catch boundary per tool: run the mutation, mapping domain errors. */
function runWrite<T>(mutation: () => T): T | ToolErrorResult<WriteErrorPayload> {
  try {
    return mutation();
  } catch (err) {
    const mapped = mapWriteError(err);
    if (mapped !== null) return toolError(mapped);
    throw err;
  }
}

/**
 * Shared write-tool guard: a null or degraded-readonly handle is a typed error,
 * checked FIRST so no mutation reaches a handle that cannot write.
 */
function requireWriteHandle(ctx: ToolContext): Database | ToolErrorResult<WriteErrorPayload> {
  if (!ctx.db) {
    // Unreachable in the fail-closed server (the loop refuses to dispatch with
    // a null handle) — defensive for any future legacy consumer.
    return toolError({ error: 'database_unavailable', detail: 'no database handle' });
  }
  if (isDegradedReadonlyDb(ctx.db)) {
    return toolError({
      error: 'read_only_database',
      detail: 'the database is served read-only (write path unavailable); restore write access and retry',
    });
  }
  return ctx.db;
}

// ============================================================================
// Identity (the shared resolvers in identity.ts — Decision 8)
// ============================================================================

/**
 * Per-call `author` arg wins; the server-process env identity resolved by the
 * shared {@link resolveEventAuthor} is the fallback (Decision 8), so multiple
 * agents on one long-lived server attribute correctly.
 */
function resolveAuthor(args: Record<string, unknown>): EventAuthor {
  const explicit = argString(args, 'author');
  return explicit === undefined ? resolveEventAuthor() : { author: explicit, authorKind: null };
}

/** Require a non-empty string arg, returning a typed error payload when absent. */
function requireArg(args: Record<string, unknown>, key: string): string | ToolErrorResult<WriteErrorPayload> {
  const value = argString(args, key);
  return value === undefined ? toolError({ error: 'invalid_arguments', detail: `${key} is required.` }) : value;
}

// --- genie_task_create ------------------------------------------------------

function genieTaskCreate(ctx: ToolContext, args: Record<string, unknown>): unknown {
  const db = requireWriteHandle(ctx);
  if (isToolError(db)) return db;
  const title = argString(args, 'title')?.trim();
  if (!title) return toolError({ error: 'invalid_arguments', detail: 'title is required and must not be empty.' });
  const wish = argString(args, 'wish');
  const group = argString(args, 'group');
  if (group && !wish) return toolError({ error: 'invalid_arguments', detail: 'group requires wish.' });
  const board = argString(args, 'board');
  return runWrite(() => {
    const boardId = board ? resolveBoard(db, board).id : undefined;
    const task = createTask(db, { title, boardId, wish, group });
    return { task: toSummary(task) };
  });
}

// --- genie_task_checkout ----------------------------------------------------

function genieTaskCheckout(ctx: ToolContext, args: Record<string, unknown>): unknown {
  const db = requireWriteHandle(ctx);
  if (isToolError(db)) return db;
  const id = requireArg(args, 'id');
  if (isToolError(id)) return id;
  const worker = requireArg(args, 'worker');
  if (isToolError(worker)) return worker;
  return runWrite(() => {
    const task = claimTask(db, id, worker, { author: resolveAuthor(args) });
    return { task: toSummary(task) };
  });
}

// --- genie_task_done --------------------------------------------------------

function genieTaskDone(ctx: ToolContext, args: Record<string, unknown>): unknown {
  const db = requireWriteHandle(ctx);
  if (isToolError(db)) return db;
  const id = requireArg(args, 'id');
  if (isToolError(id)) return id;
  return runWrite(() => {
    // completeTask runs recomputeReady inside its winning transaction — the
    // same ready-set recompute the CLI's `task done` triggers.
    const task = completeTask(db, id, resolveAuthor(args));
    return { task: toSummary(task) };
  });
}

// --- genie_task_move --------------------------------------------------------

function genieTaskMove(ctx: ToolContext, args: Record<string, unknown>): unknown {
  const db = requireWriteHandle(ctx);
  if (isToolError(db)) return db;
  const id = requireArg(args, 'id');
  if (isToolError(id)) return id;
  const to = requireArg(args, 'to');
  if (isToolError(to)) return to;
  return runWrite(() => {
    const result = moveTask(db, id, to, resolveAuthor(args));
    return { task: toSummary(result.task), from: result.from, to: result.to };
  });
}

// --- genie_task_block -------------------------------------------------------

function genieTaskBlock(ctx: ToolContext, args: Record<string, unknown>): unknown {
  const db = requireWriteHandle(ctx);
  if (isToolError(db)) return db;
  const id = requireArg(args, 'id');
  if (isToolError(id)) return id;
  const reason = argString(args, 'reason')?.trim();
  if (!reason) return toolError({ error: 'invalid_arguments', detail: 'reason is required and must not be empty.' });
  const kind: BlockKind = args.hold === true ? 'hold' : 'work';
  return runWrite(() => {
    const task = blockTask(db, id, reason, resolveAuthor(args), kind);
    return { task: toSummary(task) };
  });
}

// --- genie_task_unblock -----------------------------------------------------

function genieTaskUnblock(ctx: ToolContext, args: Record<string, unknown>): unknown {
  const db = requireWriteHandle(ctx);
  if (isToolError(db)) return db;
  const id = requireArg(args, 'id');
  if (isToolError(id)) return id;
  return runWrite(() => {
    const task = unblockTask(db, id, resolveAuthor(args));
    return { task: toSummary(task) };
  });
}

// --- genie_task_release -----------------------------------------------------

function genieTaskRelease(ctx: ToolContext, args: Record<string, unknown>): unknown {
  const db = requireWriteHandle(ctx);
  if (isToolError(db)) return db;
  const id = requireArg(args, 'id');
  if (isToolError(id)) return id;
  return runWrite(() => {
    const task = releaseTask(db, id, resolveAuthor(args));
    return { task: toSummary(task) };
  });
}

// --- genie_task_comment / genie_task_report ---------------------------------

function appendNoteEvent(ctx: ToolContext, args: Record<string, unknown>, kind: 'comment' | 'report'): unknown {
  const db = requireWriteHandle(ctx);
  if (isToolError(db)) return db;
  const id = requireArg(args, 'id');
  if (isToolError(id)) return id;
  const text = argString(args, 'text')?.trim();
  if (!text) return toolError({ error: 'invalid_arguments', detail: 'text is required and must not be empty.' });
  return runWrite(() => {
    if (!getTask(db, id)) throw new UnknownTaskError(id);
    const author = resolveAuthor(args);
    const event = appendTaskEvent(db, id, {
      kind,
      note: text,
      authorKind: author.authorKind ?? undefined,
      author: author.author ?? undefined,
    });
    return { taskId: id, event };
  });
}

function genieTaskComment(ctx: ToolContext, args: Record<string, unknown>): unknown {
  return appendNoteEvent(ctx, args, 'comment');
}

function genieTaskReport(ctx: ToolContext, args: Record<string, unknown>): unknown {
  return appendNoteEvent(ctx, args, 'report');
}

// --- genie_task_heartbeat ---------------------------------------------------

function genieTaskHeartbeat(ctx: ToolContext, args: Record<string, unknown>): unknown {
  const db = requireWriteHandle(ctx);
  if (isToolError(db)) return db;
  const id = requireArg(args, 'id');
  if (isToolError(id)) return id;
  return runWrite(() => {
    if (!getTask(db, id)) throw new UnknownTaskError(id);
    const heartbeatAt = recordHeartbeat(db, id);
    return { taskId: id, heartbeatAt };
  });
}

// --- genie_task_set_wish ----------------------------------------------------

function genieTaskSetWish(ctx: ToolContext, args: Record<string, unknown>): unknown {
  const db = requireWriteHandle(ctx);
  if (isToolError(db)) return db;
  const id = requireArg(args, 'id');
  if (isToolError(id)) return id;
  const wish = argString(args, 'wish')?.trim() || undefined;
  const group = argString(args, 'group')?.trim() || undefined;
  const clear = args.clear === true;
  // A SUPPLIED but empty/blank group fails loudly, exactly as `task set-wish
  // --group ''` does — silently dropping it would attach the card to the wish
  // with no group and report success (CLI parity, v5-task.ts handleSetWish).
  if (args.group !== undefined && !group) {
    return toolError({ error: 'invalid_arguments', detail: 'group must not be empty.' });
  }
  if (group && !wish) return toolError({ error: 'invalid_arguments', detail: 'group requires wish.' });
  if (clear && wish) return toolError({ error: 'invalid_arguments', detail: 'clear cannot be combined with wish.' });
  if (!clear && !wish) return toolError({ error: 'invalid_arguments', detail: 'wish <slug> or clear is required.' });
  return runWrite(() => {
    const to = { wish: wish ?? null, group: group ?? null };
    const result = setTaskWish(db, id, to, resolveAuthor(args));
    return { task: toSummary(result.task), from: result.from, to: result.to };
  });
}

// --- genie_task_add_dependency ----------------------------------------------

function genieTaskAddDependency(ctx: ToolContext, args: Record<string, unknown>): unknown {
  const db = requireWriteHandle(ctx);
  if (isToolError(db)) return db;
  const id = requireArg(args, 'id');
  if (isToolError(id)) return id;
  const dependsOn = requireArg(args, 'depends_on');
  if (isToolError(dependsOn)) return dependsOn;
  return runWrite(() => {
    addDependency(db, id, dependsOn);
    return { taskId: id, dependsOnId: dependsOn };
  });
}

// ============================================================================
// The 12 operative write tools
// ============================================================================

export const MCP_WRITE_TOOLS: McpTool[] = [
  {
    name: 'genie_task_create',
    description:
      'Create a task. Errors: invalid_arguments (missing title, or group without wish), not_found (unknown board), read_only_database (db served read-only), database_unavailable.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'task title (required, non-empty)' },
        board: { type: 'string', description: 'board id or name; default repo board' },
        wish: { type: 'string', description: 'wish slug this task belongs to' },
        group: { type: 'string', description: 'wish-group name (requires wish)' },
      },
      required: ['title'],
    },
    handler: genieTaskCreate,
  },
  {
    name: 'genie_task_checkout',
    description:
      "Atomically claim a ready task for a worker (the CLI's task checkout). Errors: claim_conflict (already claimed or not ready), refused_transition (enforced block), not_found (unknown id), invalid_arguments (missing id/worker), read_only_database, database_unavailable.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'task id, e.g. t_... (required)' },
        worker: { type: 'string', description: 'worker identity recorded in claimed_by (required)' },
        author: { type: 'string', description: 'event attribution; defaults to the server env identity' },
      },
      required: ['id', 'worker'],
    },
    handler: genieTaskCheckout,
  },
  {
    name: 'genie_task_done',
    description:
      "Mark a task done and recompute the ready set (the CLI's task done). Errors: not_found (unknown id), refused_transition (blocked or already-done task), invalid_arguments (missing id), read_only_database, database_unavailable.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'task id, e.g. t_... (required)' },
        author: { type: 'string', description: 'event attribution; defaults to the server env identity' },
      },
      required: ['id'],
    },
    handler: genieTaskDone,
  },
  {
    name: 'genie_task_move',
    description:
      "Move a card to a lane defined by its board (the CLI's task move). Errors: not_found (unknown id), invalid_lane (no lanes or unknown target lane), invalid_arguments (missing id/to), read_only_database, database_unavailable.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'task id, e.g. t_... (required)' },
        to: { type: 'string', description: 'target lane name (required)' },
        author: { type: 'string', description: 'event attribution; defaults to the server env identity' },
      },
      required: ['id', 'to'],
    },
    handler: genieTaskMove,
  },
  {
    name: 'genie_task_block',
    description:
      "Place an enforced block on a card, refusing checkout until cleared (the CLI's task block). Errors: not_found (unknown id), invalid_arguments (missing id/reason), read_only_database, database_unavailable.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'task id, e.g. t_... (required)' },
        reason: { type: 'string', description: 'why the card is blocked (required, non-empty)' },
        hold: { type: 'boolean', description: 'record as a deliberate hold (parked) rather than a work problem' },
        author: { type: 'string', description: 'event attribution; defaults to the server env identity' },
      },
      required: ['id', 'reason'],
    },
    handler: genieTaskBlock,
  },
  {
    name: 'genie_task_unblock',
    description:
      "Clear an enforced block from a card (the CLI's task unblock). Errors: not_found (unknown id), invalid_arguments (missing id), read_only_database, database_unavailable.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'task id, e.g. t_... (required)' },
        author: { type: 'string', description: 'event attribution; defaults to the server env identity' },
      },
      required: ['id'],
    },
    handler: genieTaskUnblock,
  },
  {
    name: 'genie_task_release',
    description:
      "Release a claim, returning an in-progress card to the ready queue (the CLI's task release). Errors: not_found (unknown id), refused_transition (not in_progress), invalid_arguments (missing id), read_only_database, database_unavailable.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'task id, e.g. t_... (required)' },
        author: { type: 'string', description: 'event attribution; defaults to the server env identity' },
      },
      required: ['id'],
    },
    handler: genieTaskRelease,
  },
  {
    name: 'genie_task_comment',
    description:
      "Append an authored comment to the card timeline (the CLI's task comment). Errors: not_found (unknown id), invalid_arguments (missing id/text), read_only_database, database_unavailable.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'task id, e.g. t_... (required)' },
        text: { type: 'string', description: 'comment text (required, non-empty)' },
        author: { type: 'string', description: 'event attribution; defaults to the server env identity' },
      },
      required: ['id', 'text'],
    },
    handler: genieTaskComment,
  },
  {
    name: 'genie_task_report',
    description:
      "Append an authored worker report to the card timeline (the CLI's task report). Errors: not_found (unknown id), invalid_arguments (missing id/text), read_only_database, database_unavailable.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'task id, e.g. t_... (required)' },
        text: { type: 'string', description: 'report text (required, non-empty)' },
        author: { type: 'string', description: 'event attribution; defaults to the server env identity' },
      },
      required: ['id', 'text'],
    },
    handler: genieTaskReport,
  },
  {
    name: 'genie_task_heartbeat',
    description:
      "Record a liveness heartbeat for a claimed card (the CLI's task heartbeat). Errors: not_found (unknown id), invalid_arguments (missing id), read_only_database, database_unavailable.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'task id, e.g. t_... (required)' },
      },
      required: ['id'],
    },
    handler: genieTaskHeartbeat,
  },
  {
    name: 'genie_task_set_wish',
    description:
      "Attach, re-point, or clear the wish identity on a card (the CLI's task set-wish). Errors: not_found (unknown id), invalid_arguments (missing id, empty group, group without wish, clear with wish, or neither wish nor clear), read_only_database, database_unavailable.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'task id, e.g. t_... (required)' },
        wish: { type: 'string', description: 'wish slug to attach the card to' },
        group: { type: 'string', description: 'wish-group name (requires wish)' },
        clear: { type: 'boolean', description: 'remove the wish and group from the card' },
        author: { type: 'string', description: 'event attribution; defaults to the server env identity' },
      },
      required: ['id'],
    },
    handler: genieTaskSetWish,
  },
  {
    name: 'genie_task_add_dependency',
    description:
      'Insert a dependency edge taskId depends_on dependsOnId, rejecting self-deps and cycles (the task-state addDependency the CLI uses at create). Errors: not_found (unknown task), dependency_cycle (self or transitive cycle), invalid_arguments (missing id/depends_on), read_only_database, database_unavailable.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'task id, e.g. t_... (required)' },
        depends_on: { type: 'string', description: 'id of the task this task depends on (required)' },
      },
      required: ['id', 'depends_on'],
    },
    handler: genieTaskAddDependency,
  },
];
