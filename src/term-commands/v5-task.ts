/**
 * genie v5 task — thin CLI over the v5 SQLite state engine (src/lib/v5).
 *
 * Every subcommand opens the repo's shared `.genie/genie.db`, runs one
 * transaction through the state module, and exits. Zero daemons, zero Postgres,
 * no runtime registry — the database is the only shared medium.
 *
 * Subcommands:
 *   task create --title <t> [--board <ref>] [--wish <slug>] [--group <name>]
 *   task list [--status <s>] [--board <ref>] [--wish <slug>] [--json]
 *   task status <id>
 *   task done <id>
 *   task checkout <id> [--worker <name>]
 *   task export
 */

import type { Database } from 'bun:sqlite';
import type { Command } from 'commander';
import { color, formatTimestamp, padRight, truncate } from '../lib/term-format.js';
import { livenessBadge } from '../lib/v5/card-render.js';
import { openDb } from '../lib/v5/genie-db.js';
import {
  type EventAuthor,
  type TaskCardRow,
  type TaskFilter,
  type TaskRow,
  type TaskStatus,
  UnknownTaskError,
  appendTaskEvent,
  blockTask,
  claimTask,
  completeTask,
  createTask,
  exportState,
  getDependencies,
  getStageLog,
  getTask,
  getTaskCard,
  getTaskEvents,
  listTasks,
  moveTask,
  recordHeartbeat,
  releaseTask,
  resolveBoard,
  unblockTask,
} from '../lib/v5/task-state.js';

// ============================================================================
// Output helpers (process.stdout/stderr — no console.* in v5 source)
// ============================================================================

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function fail(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

const VALID_STATUSES: TaskStatus[] = ['blocked', 'ready', 'in_progress', 'done'];

/** Wrap a handler so typed errors become clean stderr + non-zero exit. */
function run(handler: () => void): void {
  try {
    handler();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

// ============================================================================
// Rendering
// ============================================================================

const STATUS_COLOR: Record<TaskStatus, Parameters<typeof color>[0]> = {
  blocked: 'red',
  ready: 'cyan',
  in_progress: 'yellow',
  done: 'green',
};

function statusLabel(status: TaskStatus): string {
  return color(STATUS_COLOR[status], status);
}

function printTaskTable(tasks: TaskRow[]): void {
  if (tasks.length === 0) {
    out('No tasks found.');
    return;
  }
  const header = `  ${padRight('ID', 20)} ${padRight('TITLE', 40)} ${padRight('STATUS', 12)} ${padRight('CLAIMED BY', 16)} ${'WISH'}`;
  out(header);
  out(`  ${'─'.repeat(96)}`);
  for (const t of tasks) {
    const wishGroup = t.wish ? (t.group ? `${t.wish}#${t.group}` : t.wish) : '-';
    out(
      `  ${padRight(t.id, 20)} ${padRight(truncate(t.title, 38), 40)} ${padRight(statusLabel(t.status), 12)} ${padRight(t.claimedBy ?? '-', 16)} ${truncate(wishGroup, 24)}`,
    );
  }
  out(`\n  ${tasks.length} task${tasks.length === 1 ? '' : 's'}`);
}

type TaskEvent = ReturnType<typeof getTaskEvents>[number];

/** One timeline line: `<ts>  <kind> by <who>[ — note]`. Shared by detail + briefing. */
function formatEventLine(e: TaskEvent): string {
  const who = e.author ? `${e.author}${e.authorKind ? ` (${e.authorKind})` : ''}` : (e.authorKind ?? 'unknown');
  const note = e.note ? ` — ${e.note}` : '';
  return `${formatTimestamp(new Date(e.createdAt))}  ${e.kind} by ${who}${note}`;
}

function printDetailHeader(task: TaskCardRow): void {
  out('');
  out(`Task ${task.id}: ${task.title}`);
  out('─'.repeat(60));
  out(`  Status:     ${statusLabel(task.status)}`);
  if (task.boardId) out(`  Board:      ${task.boardId}`);
  if (task.wish) out(`  Wish:       ${task.group ? `${task.wish}#${task.group}` : task.wish}`);
  if (task.claimedBy) {
    const badge = livenessBadge(task, Date.now());
    const liveness = badge ? ` ${badge}` : '';
    out(`  Claimed by: ${task.claimedBy} (since ${formatTimestamp(new Date(task.claimedAt ?? 0))})${liveness}`);
  }
  if (task.blockedBy != null) {
    const reason = task.blockedReason ? ` — ${task.blockedReason}` : '';
    out(`  Blocked by: ${task.blockedBy}${reason}`);
  }
  out(`  Created:    ${formatTimestamp(new Date(task.createdAt))}`);
  out(`  Updated:    ${formatTimestamp(new Date(task.updatedAt))}`);
}

function printDependencies(db: Database, taskId: string): void {
  const deps = getDependencies(db, taskId);
  if (deps.length === 0) return;
  out('\n  Depends on:');
  for (const depId of deps) {
    const dep = getTask(db, depId);
    const label = dep ? `${dep.id} — ${truncate(dep.title, 40)} [${dep.status}]` : `${depId} (missing)`;
    out(`    ${label}`);
  }
}

function printTaskDetail(db: Database, task: TaskCardRow): void {
  printDetailHeader(task);
  printDependencies(db, task.id);

  const events = getTaskEvents(db, task.id);
  if (events.length > 0) {
    out('\n  Timeline:');
    for (const e of events) out(`    ${formatEventLine(e)}`);
  }

  const log = getStageLog(db, task.id);
  if (log.length > 0) {
    out('\n  Stage log (deprecated):');
    for (const entry of log) {
      const note = entry.note ? ` — ${entry.note}` : '';
      out(`    ${formatTimestamp(new Date(entry.createdAt))}  ${entry.stage}${note}`);
    }
  }
  out('');
}

// ============================================================================
// Handlers
// ============================================================================

interface CreateOptions {
  title: string;
  board?: string;
  wish?: string;
  group?: string;
}

function handleCreate(opts: CreateOptions): void {
  const title = opts.title?.trim();
  if (!title) fail('--title is required and must not be empty.');
  if (opts.group && !opts.wish) fail('--group requires --wish.');

  run(() => {
    const db = openDb();
    try {
      const boardId = opts.board ? resolveBoard(db, opts.board).id : undefined;
      const task = createTask(db, { title, boardId, wish: opts.wish, group: opts.group });
      out(`Created task ${task.id} "${task.title}" (${task.status}).`);
    } finally {
      db.close();
    }
  });
}

interface ListOptions {
  status?: string;
  board?: string;
  wish?: string;
  json?: boolean;
}

function handleList(opts: ListOptions): void {
  if (opts.status && !VALID_STATUSES.includes(opts.status as TaskStatus)) {
    fail(`Invalid --status "${opts.status}". Valid: ${VALID_STATUSES.join(', ')}.`);
  }
  run(() => {
    const db = openDb();
    try {
      const filter: TaskFilter = {};
      if (opts.status) filter.status = opts.status as TaskStatus;
      if (opts.board) filter.boardId = resolveBoard(db, opts.board).id;
      if (opts.wish) filter.wish = opts.wish;
      const tasks = listTasks(db, filter);
      if (opts.json) {
        out(JSON.stringify(tasks, null, 2));
        return;
      }
      printTaskTable(tasks);
    } finally {
      db.close();
    }
  });
}

function handleStatus(id: string): void {
  run(() => {
    const db = openDb();
    try {
      const task = getTaskCard(db, id);
      if (!task) throw new UnknownTaskError(id);
      printTaskDetail(db, task);
    } finally {
      db.close();
    }
  });
}

function handleDone(id: string): void {
  run(() => {
    const db = openDb();
    try {
      const task = completeTask(db, id, resolveEventAuthor());
      out(`Task ${task.id} marked done.`);
    } finally {
      db.close();
    }
  });
}

/**
 * Infer the acting runtime kind from the environment. An explicit
 * `GENIE_AGENT_KIND` always wins; otherwise the coding-agent markers are probed
 * in order (Claude Code, Codex, Hermes), falling back to 'human'. This is the
 * ONE place runtime kind is resolved — every verb and `moveTask`'s CLI caller
 * flow through {@link resolveEventAuthor}.
 */
function resolveAuthorKind(): string {
  const env = process.env;
  if (env.GENIE_AGENT_KIND) return env.GENIE_AGENT_KIND;
  if (env.CLAUDECODE || env.CLAUDE_CODE) return 'claude-code';
  if (env.CODEX_THREAD_ID) return 'codex';
  if (env.HERMES || env.HERMES_HOME) return 'hermes';
  return 'human';
}

/**
 * Resolve the acting author for a card event from the environment: identity from
 * `GENIE_AGENT_NAME`/`GENIE_AGENT_ID`, kind via {@link resolveAuthorKind}. The
 * single author resolver shared by every authored verb and `moveTask`.
 */
function resolveEventAuthor(): EventAuthor {
  return {
    author: process.env.GENIE_AGENT_NAME ?? process.env.GENIE_AGENT_ID ?? null,
    authorKind: resolveAuthorKind(),
  };
}

interface MoveOptions {
  to?: string;
}

function handleMove(id: string, opts: MoveOptions): void {
  const toLane = opts.to?.trim();
  if (!toLane) fail('--to <lane> is required.');
  run(() => {
    const db = openDb();
    try {
      const result = moveTask(db, id, toLane, resolveEventAuthor());
      out(`Moved task ${result.task.id}: ${result.from ?? '(none)'} → ${result.to}.`);
    } finally {
      db.close();
    }
  });
}

interface CheckoutOptions {
  worker?: string;
}

/** Print a card's prior timeline as a reassignment briefing at checkout. */
function printTimelineBriefing(events: TaskEvent[]): void {
  out('\n  Prior timeline (reassignment briefing):');
  for (const e of events) out(`    ${formatEventLine(e)}`);
}

function handleCheckout(id: string, opts: CheckoutOptions): void {
  const worker = opts.worker ?? process.env.GENIE_AGENT_NAME ?? 'cli';
  run(() => {
    const db = openDb();
    try {
      // Capture the timeline BEFORE claiming so the briefing reflects prior
      // runtimes' history, not the claim event this checkout is about to append.
      const priorEvents = getTaskEvents(db, id);
      const task = claimTask(db, id, worker, { author: resolveEventAuthor() });
      out(`Claimed task ${task.id} for "${worker}" (${task.status}).`);
      if (priorEvents.length > 0) printTimelineBriefing(priorEvents);
    } finally {
      db.close();
    }
  });
}

function handleComment(id: string, text: string): void {
  const note = text?.trim();
  if (!note) fail('a non-empty comment is required.');
  run(() => {
    const db = openDb();
    try {
      if (!getTask(db, id)) throw new UnknownTaskError(id);
      const author = resolveEventAuthor();
      appendTaskEvent(db, id, {
        kind: 'comment',
        note,
        authorKind: author.authorKind ?? undefined,
        author: author.author ?? undefined,
      });
      out(`Commented on task ${id}.`);
    } finally {
      db.close();
    }
  });
}

function handleReport(id: string, text: string): void {
  const note = text?.trim();
  if (!note) fail('a non-empty report is required.');
  run(() => {
    const db = openDb();
    try {
      if (!getTask(db, id)) throw new UnknownTaskError(id);
      const author = resolveEventAuthor();
      appendTaskEvent(db, id, {
        kind: 'report',
        note,
        authorKind: author.authorKind ?? undefined,
        author: author.author ?? undefined,
      });
      out(`Reported on task ${id} (${author.authorKind}).`);
    } finally {
      db.close();
    }
  });
}

interface BlockOptions {
  reason?: string;
}

function handleBlock(id: string, opts: BlockOptions): void {
  const reason = opts.reason?.trim();
  if (!reason) fail('--reason <text> is required.');
  run(() => {
    const db = openDb();
    try {
      const task = blockTask(db, id, reason, resolveEventAuthor());
      out(`Blocked task ${task.id} (${task.status}).`);
    } finally {
      db.close();
    }
  });
}

function handleUnblock(id: string): void {
  run(() => {
    const db = openDb();
    try {
      const task = unblockTask(db, id, resolveEventAuthor());
      out(`Unblocked task ${task.id}.`);
    } finally {
      db.close();
    }
  });
}

function handleRelease(id: string): void {
  run(() => {
    const db = openDb();
    try {
      const task = releaseTask(db, id, resolveEventAuthor());
      out(`Released task ${task.id} (${task.status}).`);
    } finally {
      db.close();
    }
  });
}

function handleHeartbeat(id: string): void {
  run(() => {
    const db = openDb();
    try {
      if (!getTask(db, id)) throw new UnknownTaskError(id);
      recordHeartbeat(db, id);
      out(`Heartbeat recorded for task ${id}.`);
    } finally {
      db.close();
    }
  });
}

function handleExport(): void {
  run(() => {
    const db = openDb();
    try {
      out(JSON.stringify(exportState(db), null, 2));
    } finally {
      db.close();
    }
  });
}

// ============================================================================
// Registration
// ============================================================================

export function registerV5TaskCommands(v5: Command): void {
  const task = v5.command('task').description('task state (SQLite, zero-daemon)');

  task
    .command('create')
    .description('Create a task')
    .requiredOption('--title <title>', 'Task title')
    .option('--board <ref>', 'Board id or name')
    .option('--wish <slug>', 'Wish slug this task belongs to')
    .option('--group <name>', 'Wish-group name (requires --wish)')
    .action((opts: CreateOptions) => handleCreate(opts));

  task
    .command('list')
    .description('List tasks with optional filters')
    .option('--status <status>', 'Filter by status (blocked|ready|in_progress|done)')
    .option('--board <ref>', 'Filter by board id or name')
    .option('--wish <slug>', 'Filter by wish slug')
    .option('--json', 'Output as JSON')
    .action((opts: ListOptions) => handleList(opts));

  task
    .command('status <id>')
    .description('Show task detail, dependencies, and stage log')
    .action((id: string) => handleStatus(id));

  task
    .command('done <id>')
    .description('Mark a task done and recompute the ready set')
    .action((id: string) => handleDone(id));

  task
    .command('move <id>')
    .description('Move a card to a lane defined by its board (appends a move event)')
    .requiredOption('--to <lane>', 'Target lane name')
    .action((id: string, opts: MoveOptions) => handleMove(id, opts));

  task
    .command('checkout <id>')
    .description('Atomically claim a ready task for a worker')
    .option('--worker <name>', 'Worker identity (defaults to $GENIE_AGENT_NAME or "cli")')
    .action((id: string, opts: CheckoutOptions) => handleCheckout(id, opts));

  task
    .command('comment <id> <text>')
    .description('Append an authored comment to the card timeline')
    .action((id: string, text: string) => handleComment(id, text));

  task
    .command('report <id> <text>')
    .description('Append an authored worker report to the card timeline')
    .action((id: string, text: string) => handleReport(id, text));

  task
    .command('block <id>')
    .description('Place an enforced block on a card (refuses checkout until cleared)')
    .requiredOption('--reason <text>', 'Why the card is blocked')
    .action((id: string, opts: BlockOptions) => handleBlock(id, opts));

  task
    .command('unblock <id>')
    .description('Clear an enforced block from a card')
    .action((id: string) => handleUnblock(id));

  task
    .command('release <id>')
    .description('Release a claim, returning the card to the ready queue')
    .action((id: string) => handleRelease(id));

  task
    .command('heartbeat <id>')
    .description('Record a liveness heartbeat for a claimed card')
    .action((id: string) => handleHeartbeat(id));

  task
    .command('export')
    .description('Emit the complete database state as JSON')
    .action(() => handleExport());
}
