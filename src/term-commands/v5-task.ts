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
import { openDb } from '../lib/v5/genie-db.js';
import {
  type TaskFilter,
  type TaskRow,
  type TaskStatus,
  UnknownTaskError,
  claimTask,
  completeTask,
  createTask,
  exportState,
  getDependencies,
  getStageLog,
  getTask,
  listTasks,
  resolveBoard,
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

function printTaskDetail(db: Database, task: TaskRow): void {
  out('');
  out(`Task ${task.id}: ${task.title}`);
  out('─'.repeat(60));
  out(`  Status:     ${statusLabel(task.status)}`);
  if (task.boardId) out(`  Board:      ${task.boardId}`);
  if (task.wish) out(`  Wish:       ${task.group ? `${task.wish}#${task.group}` : task.wish}`);
  if (task.claimedBy) {
    out(`  Claimed by: ${task.claimedBy} (since ${formatTimestamp(new Date(task.claimedAt ?? 0))})`);
  }
  out(`  Created:    ${formatTimestamp(new Date(task.createdAt))}`);
  out(`  Updated:    ${formatTimestamp(new Date(task.updatedAt))}`);

  const deps = getDependencies(db, task.id);
  if (deps.length > 0) {
    out('\n  Depends on:');
    for (const depId of deps) {
      const dep = getTask(db, depId);
      const label = dep ? `${dep.id} — ${truncate(dep.title, 40)} [${dep.status}]` : `${depId} (missing)`;
      out(`    ${label}`);
    }
  }

  const log = getStageLog(db, task.id);
  if (log.length > 0) {
    out('\n  Stage log:');
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
      const task = getTask(db, id);
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
      const task = completeTask(db, id);
      out(`Task ${task.id} marked done.`);
    } finally {
      db.close();
    }
  });
}

interface CheckoutOptions {
  worker?: string;
}

function handleCheckout(id: string, opts: CheckoutOptions): void {
  const worker = opts.worker ?? process.env.GENIE_AGENT_NAME ?? 'cli';
  run(() => {
    const db = openDb();
    try {
      const task = claimTask(db, id, worker);
      out(`Claimed task ${task.id} for "${worker}" (${task.status}).`);
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
  const task = v5.command('task').description('v5 task state (SQLite, zero-daemon)');

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
    .command('checkout <id>')
    .description('Atomically claim a ready task for a worker')
    .option('--worker <name>', 'Worker identity (defaults to $GENIE_AGENT_NAME or "cli")')
    .action((id: string, opts: CheckoutOptions) => handleCheckout(id, opts));

  task
    .command('export')
    .description('Emit the complete database state as JSON')
    .action(() => handleExport());
}
