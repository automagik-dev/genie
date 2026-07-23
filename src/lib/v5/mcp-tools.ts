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

import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { type ProjectContext, resolveDbPath } from './genie-db.js';
import { BUSY_TIMEOUT_MS } from './sqlite-open.js';

// Re-exported so `genie mcp` (mcp.ts) pulls the fail-closed context resolver in
// the SAME lazy dynamic import that already loads the tool registry — keeping
// the readonly bun:sqlite open out of the eager genie.ts import graph.
export { isCurrentGenieDb, type ProjectContext, resolveProjectContext } from './genie-db.js';
import {
  type TaskFilter,
  type TaskRow,
  type WishGroupRow,
  getBoardByName,
  getTask,
  getWishGroups,
  listTasks,
  listWishSlugs,
} from './task-state.js';

// ============================================================================
// Read-only DB open (net-new; degrade to null when the file is absent)
// ============================================================================

/**
 * Open the repo's shared `.genie/genie.db` READ-ONLY. Returns `null` when the
 * file does not exist (readonly open of a missing file throws) so callers can
 * degrade to an empty board instead of crashing the server. The handle is the
 * caller's to close.
 *
 * The read-only connection is given the SAME `busy_timeout` as the shared write
 * primitive (see sqlite-open.ts): under concurrent access a straggling WAL
 * writer must be waited out, not surfaced as an instant `-32603 "database is
 * locked"`. `busy_timeout` is valid on a readonly connection and does not
 * mutate the file. An absent-db open still throws before the pragma runs, so the
 * degrade-to-`null` contract is preserved.
 */
export function openReadonlyDb(cwd?: string): Database | null {
  try {
    const db = new Database(resolveDbPath(cwd), { readonly: true });
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    return db;
  } catch {
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
 *   1. a `<slug>-<group>` where BOTH the slug is known AND `<group>` is a real
 *      group of it → a launch worktree (beats a same-named top-level slug);
 *   2. exact known slug → top-level branch, group = null;
 *   3. longest known slug that is a prefix + `-<group>` (group unverified);
 *   4. no known wish (brand-new branch) → last-dash heuristic, else whole rest.
 * Returns `null` only when the branch is not a `wish/…` branch.
 */
function resolveWishBranch(db: Database | null, branch: string): { wish: string; group: string | null } | null {
  const rest = branch.startsWith('wish/') ? branch.slice('wish/'.length) : null;
  if (!rest) return null;
  const known = db ? listWishSlugs(db) : []; // longest-first
  // 1. Verified launch worktree: the group actually exists on the prefix wish.
  if (db) {
    for (const slug of known) {
      if (!rest.startsWith(`${slug}-`)) continue;
      const group = rest.slice(slug.length + 1);
      if (group && getWishGroups(db, slug).some((g) => g.name === group)) return { wish: slug, group };
    }
  }
  // 2. Exact known slug → top-level branch (no group).
  if (known.includes(rest)) return { wish: rest, group: null };
  // 3. Longest known slug that is a prefix (group unverified) → best guess.
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
  const groups = getWishGroups(ctx.db, wish).map(({ wish: _w, ...rest }) => rest);
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

function genieTask(ctx: ToolContext, args: Record<string, unknown>): TaskRow | { error: 'not_found'; id: string } {
  const id = argString(args, 'id') ?? '';
  const task = ctx.db ? getTask(ctx.db, id) : null;
  return task ?? { error: 'not_found', id };
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
