/**
 * Genie v5 MCP tools — the read-only projection of `.genie/genie.db` exposed
 * over the hand-rolled stdio MCP server (see `src/term-commands/mcp.ts`).
 *
 * This module is intentionally LAZY-LOADED: `genie mcp` dynamic-imports it
 * inside the command body so that non-mcp code paths (`genie board`, `genie
 * task`, `genie --help`) never touch the read-only `bun:sqlite` open here. The
 * import-graph probe in `mcp.test.ts` locks that contract.
 *
 * The DB is opened NET-NEW and READ-ONLY (`new Database(path, {readonly:true})`)
 * — deliberately NOT `openSqlite()`/`openDb()`, which force-create the file and
 * run write pragmas. An absent db (readonly open throws) degrades to `null`, and
 * every tool renders an empty board rather than erroring.
 */

import { constants, Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { accessSync, constants as fsConstants, readFileSync, rmSync, statSync } from 'node:fs';
import {
  type ProjectContext,
  type ProjectDatabaseBinding,
  isCurrentGenieDb,
  isReadableGenieDb,
  openDb,
  resolveDbPath,
  resolveProjectDatabaseBinding,
} from './genie-db.js';
import { BUSY_TIMEOUT_MS } from './sqlite-open.js';

// Re-exported so `genie mcp` (mcp.ts) pulls the fail-closed context resolver in
// the SAME lazy dynamic import that already loads the tool registry — keeping
// the readonly bun:sqlite open out of the eager genie.ts import graph.
export { isCurrentGenieDb, type ProjectContext, resolveProjectContext } from './genie-db.js';
import {
  type FrozenTaskRow,
  type TaskFilter,
  type TaskRow,
  type WishGroupRow,
  getBoardByName,
  getTask,
  listTasks,
  listWishSlugs,
  toFrozenTaskRow,
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
 *    `BusyDbError`, anything) is caught and translated to the loop's `null`
 *    contract: the injected open never lets an exception escape (the loop calls
 *    it outside any `try`). The post-open binding + VFS-handle revalidation
 *    mirrors the readonly path, so `openDb`'s DDL never runs against a file
 *    substituted mid-open.
 * 2. STALE-READONLY-SIDECAR RECOVERY — when the write open fails and the
 *    leftover `-shm` carries SQLite's deliberate read-only WAL-index header
 *    (page-size + db-size fields zeroed — written when a DEGRADED readonly
 *    connection closed while the file was write-protected) and the `-wal` is
 *    empty (no un-checkpointed frames to lose), remove both sidecars and retry
 *    the write open once. This is what lets a repaired filesystem restore
 *    writes on the next open — without it, the stale header would keep every
 *    later writer failing closed on macOS/bun.
 * 3. READ-ONLY-DEGRADE FALLBACK — when the write path still fails
 *    (write-protected file/filesystem, malformed, foreign, busy), fall back to
 *    the readonly healing open. The loop's strict `validateReadonlyDb:
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
export function openWriteableDb(target?: string | ProjectDatabaseBinding): Database | null {
  const initial =
    typeof target === 'object'
      ? resolveProjectDatabaseBinding(target.logicalPath, target)
      : resolveProjectDatabaseBinding(resolveDbPath(target));
  let db: Database | null = null;
  if (initial.ok) {
    const binding = initial.binding;
    db = tryWriteOpen(binding);
    if (db === null && hasStaleReadonlyWalIndex(binding) && walSidecarsEmpty(binding)) {
      // A prior degraded session left SQLite's read-only WAL-index header in
      // -shm; both sidecars must be rebuilt before any writer can proceed.
      try {
        rmSync(`${binding.physicalPath}-shm`, { force: true });
        rmSync(`${binding.physicalPath}-wal`, { force: true });
      } catch {
        // Sidecar removal is best-effort; the fallback below still adjudicates.
      }
      db = tryWriteOpen(binding);
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
 * the page-size and db-size header fields are zeroed (a live index always has
 * both nonzero). This is the exact state a degraded readonly connection leaves
 * behind when it closes while the database file is write-protected — the one
 * state that would otherwise keep every later writer failing.
 */
function hasStaleReadonlyWalIndex(binding: ProjectDatabaseBinding): boolean {
  try {
    const shm = readFileSync(`${binding.physicalPath}-shm`);
    if (shm.length < 24) return false;
    return shm.readUInt32BE(8) === 0 && shm.readUInt32BE(20) === 0;
  } catch {
    return false;
  }
}

/** True when the `-wal` is absent or empty — removing the sidecars loses no frames. */
function walSidecarsEmpty(binding: ProjectDatabaseBinding): boolean {
  try {
    const wal = statSync(`${binding.physicalPath}-wal`);
    return wal.size === 0;
  } catch {
    return false;
  }
}

/** One write-path attempt: writability gate → openDb → post-open revalidation. */
function tryWriteOpen(binding: ProjectDatabaseBinding): Database | null {
  if (!isFileWritable(binding.physicalPath)) return null;
  let db: Database | null = null;
  try {
    db = openDb({ path: binding.physicalPath });
    // Post-open revalidation: the binding AND the opened VFS handle must still
    // name the validated file before any tool can observe or mutate it.
    if (!resolveProjectDatabaseBinding(binding.logicalPath, binding).ok || !readonlyDatabaseHandleMatchesPath(db)) {
      closeReadonlyDb(db);
      return null;
    }
    return db;
  } catch {
    closeReadonlyDb(db);
    return null;
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
  /** Read-only handle, or `null` when the db is absent (degrade to empty). */
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
    // Unknown board name → empty projection (read-only; never throws at caller).
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
// The 5 read-only tools
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
