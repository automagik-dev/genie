/**
 * Genie v5 MCP tools — the projection + dispatch surface of `.genie/genie.db`
 * exposed over the hand-rolled stdio MCP server (see
 * `src/term-commands/mcp.ts`): 5 read tools (`MCP_TOOLS`) + 12 operative write
 * tools (`MCP_WRITE_TOOLS`).
 *
 * This module is intentionally LAZY-LOADED: `genie mcp` dynamic-imports it
 * inside the command body so that non-mcp code paths (`genie board`, `genie
 * task`, `genie --help`) never touch the `bun:sqlite` opens here. The
 * import-graph probe in `mcp.test.ts` locks that contract.
 *
 * `genie mcp` opens through {@link openWriteableDb} — the standard hardened CLI
 * write path (`openDb` + binding revalidation), degrading to the readonly
 * healing open only when the write is impossible (see the degrade section
 * below). The readonly open internals (`openReadonlyDb`, ...) stay in
 * production for that fallback and for `genie ui-bridge`, which injects its own
 * readonly open.
 */

import { constants, Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { accessSync, constants as fsConstants, readFileSync, rmSync, statSync } from 'node:fs';
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
import { type ToolErrorResult, isToolError, toolError } from './mcp-server.js';
import { BUSY_TIMEOUT_MS } from './sqlite-open.js';

// Re-exported so `genie mcp` (mcp.ts) pulls the fail-closed context resolver in
// the SAME lazy dynamic import that already loads the tool registry — keeping
// the bun:sqlite opens out of the eager genie.ts import graph.
export { isCurrentGenieDb, type ProjectContext, resolveProjectContext } from './genie-db.js';
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
 * that only ever reads — exactly the post-update Codex plugin, whose first
 * contact with the repo is `genie mcp`. When (and only when) a successful
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
 * re-degrades (fresh handle, membership again).
 */
const degradedReadonlyHandles = new WeakSet<Database>();

/** True when `db` was produced by the read-only-degrade fallback (writes would fail). */
export function isDegradedReadonlyDb(db: Database | null | undefined): boolean {
  return db !== null && db !== undefined && degradedReadonlyHandles.has(db);
}

/**
 * Open the repo's shared `.genie/genie.db` WRITE-CAPABLE through the standard
 * hardened CLI path, degrading to the readonly healing open when the write is
 * impossible. This is the open `genie mcp` injects into the shared loop.
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
 * 2. STALE-READONLY-SIDECAR RECOVERY — when the write open fails and the
 *    leftover `-shm` carries SQLite's deliberate read-only WAL-index header
 *    (iChange + nPage zeroed — written when a DEGRADED readonly connection
 *    closed while the file was write-protected) and the `-wal` is absent or
 *    empty (no un-checkpointed frames to lose), remove both sidecars and retry
 *    the write open once. This is what lets a repaired filesystem restore
 *    writes on the next open — without it, the stale header would keep every
 *    later writer failing closed on the affected platforms.
 * 3. BUSY CARVE-OUT — when the write-open failure is a `BusyDbError` (the
 *    write lock was contended past `busy_timeout` + backoff — the db is
 *    healthy, another process is writing), return `null` WITHOUT sidecar
 *    recovery and WITHOUT the read-only-degrade fallback: a fully-writable db
 *    that merely lost a lock race must not be marked degraded for the session
 *    (write tools would otherwise report `read_only_database` for a merely-busy
 *    db). The loop's per-call reopen retries the write open on the next call.
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
    const binding = initial.binding;
    const first = tryWriteOpen(binding, dependencies);
    if (first.busy) return null; // contended write lock — never degrade a healthy-but-busy db
    db = first.db;
    if (db === null && hasStaleReadonlyWalIndex(binding) && walSidecarsEmpty(binding)) {
      // A prior degraded session left SQLite's read-only WAL-index header in
      // -shm; both sidecars must be rebuilt before any writer can proceed.
      // Re-check the header immediately before removal: a concurrent writer may
      // have rebuilt live sidecars since the check above (TOCTOU window).
      if (hasStaleReadonlyWalIndex(binding) && walSidecarsEmpty(binding)) {
        try {
          rmSync(`${binding.physicalPath}-shm`, { force: true });
          rmSync(`${binding.physicalPath}-wal`, { force: true });
        } catch {
          // Sidecar removal is best-effort; the fallback below still adjudicates.
        }
      }
      const retried = tryWriteOpen(binding, dependencies);
      if (retried.busy) return null;
      db = retried.db;
    }
  }
  if (db !== null) return db;
  const degraded = openReadonlyDbHealingStaleSchema(target);
  if (degraded !== null) degradedReadonlyHandles.add(degraded);
  return degraded;
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
 * True when the `-shm` holds SQLite's deliberate read-only WAL-index header:
 * the change counter (iChange, offset 8) and the db-size-in-pages (nPage,
 * offset 20) header fields are zeroed (a live index always has both nonzero).
 * This is the exact state a degraded readonly connection leaves behind when it
 * closes while the database file is write-protected — the one state that would
 * otherwise keep every later writer failing. Reproduced on macOS/bun, where
 * `new Database(path)` silently opens a write-protected db as READONLY and the
 * close writes the zeroed read-only header (iVersion + isInit still set) into
 * `-shm`; a fully-checkpointed db has no `-wal` frames, so the recovery only
 * ever discards empty sidecars.
 *
 * IMPORTANT (verified on this machine): the REAL poison is byte-for-byte
 * identical to the virgin header bun writes when it freshly (re)creates the
 * index on any healthy open — all 32768 bytes, no checksum/salt/copy-2
 * difference. So this predicate alone CANNOT be used as a post-open test: a
 * healthy fresh open also reports stale. The open itself also does NOT throw
 * on the poison (bun opens silently READONLY, or a writable-looking handle
 * whose writes fail with "disk I/O error"); only a real write distinguishes
 * them. That is why {@link tryWriteOpen} re-checks this predicate after a
 * successful open and, when stale, exercises the handle with a PASSIVE
 * checkpoint (healthy: succeeds and self-heals the header; poison: throws)
 * before routing the stale case into the remove-and-retry recovery below.
 */
export function hasStaleReadonlyWalIndex(binding: ProjectDatabaseBinding): boolean {
  try {
    const shm = readFileSync(`${binding.physicalPath}-shm`);
    if (shm.length < 24) return false;
    return shm.readUInt32BE(8) === 0 && shm.readUInt32BE(20) === 0;
  } catch {
    return false;
  }
}

/**
 * True when the `-wal` is absent or empty — removing the sidecars loses no
 * frames. ENOENT is the common case (a fully-checkpointed db has no `-wal`);
 * only a stat failure other than absence stays conservative (false).
 */
export function walSidecarsEmpty(binding: ProjectDatabaseBinding): boolean {
  try {
    const wal = statSync(`${binding.physicalPath}-wal`);
    return wal.size === 0;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/** One write-path attempt: writability gate → openDb → post-open revalidation. */
function tryWriteOpen(binding: ProjectDatabaseBinding, dependencies: WriteableDbOpenDependencies): WriteOpenAttempt {
  if (!isFileWritable(binding.physicalPath)) return { db: null, busy: false };
  let db: Database | null = null;
  try {
    db = dependencies.openDatabase?.(binding.physicalPath) ?? openDb({ path: binding.physicalPath });
    // Post-open revalidation: the binding AND the opened VFS handle must still
    // name the validated file before any tool can observe or mutate it. This
    // bounds a mid-open substitution to the open itself — DDL that already ran
    // against a substituted file cannot be undone, but the mismatched handle is
    // discarded here, never visible to a tool.
    if (!resolveProjectDatabaseBinding(binding.logicalPath, binding).ok || !readonlyDatabaseHandleMatchesPath(db)) {
      closeReadonlyDb(db);
      return { db: null, busy: false };
    }
    // Post-open stale-sidecar re-check: a zeroed iChange/nPage header in -shm
    // is AMBIGUOUS right after an open on this platform. bun writes a
    // byte-identical virgin header when it (re)creates the index (HEALTHY —
    // the first real write rebuilds it), and the degraded-readonly close
    // writes the same bytes (POISON — every later write fails with a raw
    // SQLITE_READONLY or "disk I/O error", reads still serve). We verified the
    // files are byte-for-byte identical (all 32768 bytes), so no file-level
    // predicate can tell them apart — the minimal additional state lives on
    // the HANDLE: exercise the wal-index write path with a PASSIVE checkpoint.
    // Healthy virgin: succeeds (and self-heals the header). Poison: throws.
    // Busy (live writer): checkpoint returns a busy row without throwing, so
    // a healthy-but-busy db is never mislabeled — and a BusyDbError from the
    // open itself still short-circuits above with busy=true, no recovery, no
    // degrade (F3 carve-out intact).
    if (hasStaleReadonlyWalIndex(binding)) {
      try {
        db.query('PRAGMA wal_checkpoint(PASSIVE)').all();
      } catch (probeErr) {
        closeReadonlyDb(db);
        return { db: null, busy: probeErr instanceof BusyDbError };
      }
    }
    return { db, busy: false };
  } catch (err) {
    closeReadonlyDb(db);
    return { db: null, busy: err instanceof BusyDbError };
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
 * Resolve a `wish/<slug>[-<group>]` branch into `{ wish, group }`. Both slug and
 * group may contain hyphens, so a raw last-dash split is ambiguous
 * (`wish/genie-mcp` is the `genie-mcp` wish with no group, NOT a `genie` wish
 * with an `mcp` group). Disambiguate against the db, most-authoritative first:
 *   1. exact known slug → top-level branch, group = null;
 *   2. longest known slug that is a prefix + `-<group>` (group unverified);
 *   3. no known wish (brand-new branch) → last-dash heuristic, else whole rest.
 * Returns `null` only when the branch is not a `wish/…` branch.
 *
 * There is no verified-launch-worktree step: wish-group rows are production-dead
 * (no writer), so a `<slug>-<group>` branch can never be confirmed against a
 * live group — the group is taken at face value from the branch name.
 */
function resolveWishBranch(db: Database | null, branch: string): { wish: string; group: string | null } | null {
  const rest = branch.startsWith('wish/') ? branch.slice('wish/'.length) : null;
  if (!rest) return null;
  const known = db ? listWishSlugs(db) : []; // longest-first
  // 1. Exact known slug → top-level branch (no group).
  if (known.includes(rest)) return { wish: rest, group: null };
  // 2. Longest known slug that is a prefix (group unverified) → best guess.
  for (const slug of known) {
    if (rest.startsWith(`${slug}-`)) {
      const group = rest.slice(slug.length + 1);
      if (group) return { wish: slug, group };
    }
  }
  // 4. No known wish yet → last-dash heuristic, else the whole rest as the wish.
  const dash = rest.lastIndexOf('-');
  if (dash > 0 && dash < rest.length - 1) return { wish: rest.slice(0, dash), group: rest.slice(dash + 1) };
  return { wish: rest, group: null };
}

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
  const parsed = branch ? resolveWishBranch(ctx.db, branch) : null;

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
// Identity (mirrors the CLI resolvers in term-commands/v5-task.ts — Decision 8)
// ============================================================================

/**
 * Env identity fallback: `GENIE_AGENT_NAME`, then `GENIE_AGENT_ID`, flooring at
 * 'cli' — byte-for-byte the CLI's `resolveWorkerIdentity`. Used ONLY when the
 * per-call `worker`/`author` arg is absent, so multiple agents on one
 * long-lived server attribute correctly.
 */
function resolveWorkerIdentity(): string {
  return process.env.GENIE_AGENT_NAME ?? process.env.GENIE_AGENT_ID ?? 'cli';
}

/**
 * Env runtime-kind fallback: `GENIE_AGENT_KIND`, then the coding-agent markers,
 * flooring at 'human' — byte-for-byte the CLI's `resolveAuthorKind`.
 */
function resolveAuthorKind(): string {
  const env = process.env;
  if (env.GENIE_AGENT_KIND) return env.GENIE_AGENT_KIND;
  if (env.CLAUDECODE || env.CLAUDE_CODE) return 'claude-code';
  if (env.CODEX_THREAD_ID) return 'codex';
  if (env.HERMES || env.HERMES_HOME) return 'hermes';
  return 'human';
}

/** The server-process env identity, used ONLY when no per-call arg is given. */
function resolveEventAuthor(): EventAuthor {
  return { author: resolveWorkerIdentity(), authorKind: resolveAuthorKind() };
}

/** Per-call `author` arg wins; the env identity is the fallback (Decision 8). */
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
