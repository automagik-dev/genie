/**
 * genie v5 board — a kanban view derived purely by query over the v5 SQLite
 * state engine (src/lib/v5). There is NO stored view state: the columns are the
 * four task statuses, and every invocation re-groups the live rows. Status
 * changes are reflected immediately on the next render with nothing to persist.
 *
 *   board [--board <ref>] [--wish <slug>] [--json]
 */

import type { Command } from 'commander';
import { color, padRight, truncate } from '../lib/term-format.js';
import { openDb } from '../lib/v5/genie-db.js';
import { type TaskFilter, type TaskRow, type TaskStatus, listTasks, resolveBoard } from '../lib/v5/task-state.js';

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

// ============================================================================
// Column model — the kanban pipeline is the task status enum, left to right.
// ============================================================================

const COLUMNS: Array<{ status: TaskStatus; label: string; tint: Parameters<typeof color>[0] }> = [
  { status: 'blocked', label: 'Blocked', tint: 'red' },
  { status: 'ready', label: 'Ready', tint: 'cyan' },
  { status: 'in_progress', label: 'In Progress', tint: 'yellow' },
  { status: 'done', label: 'Done', tint: 'green' },
];

function groupByStatus(tasks: TaskRow[]): Record<TaskStatus, TaskRow[]> {
  const groups: Record<TaskStatus, TaskRow[]> = { blocked: [], ready: [], in_progress: [], done: [] };
  for (const t of tasks) groups[t.status].push(t);
  return groups;
}

function printColumn(label: string, tint: Parameters<typeof color>[0], colTasks: TaskRow[]): void {
  const count = colTasks.length;
  out(`\n${color(tint, `── ${label} (${count} task${count === 1 ? '' : 's'}) ──`)}`);
  if (count === 0) {
    out('  (empty)');
    return;
  }
  for (const t of colTasks) {
    const claimed = t.claimedBy ? `  @${t.claimedBy}` : '';
    const wish = t.wish ? `  ${color('gray', t.group ? `${t.wish}#${t.group}` : t.wish)}` : '';
    out(`  ${padRight(t.id, 20)}  ${truncate(t.title, 40)}${claimed}${wish}`);
  }
}

// ============================================================================
// Handler
// ============================================================================

interface BoardOptions {
  board?: string;
  wish?: string;
  json?: boolean;
}

function handleBoard(opts: BoardOptions): void {
  const db = openDb();
  try {
    const filter: TaskFilter = {};
    let scopeLabel = 'all tasks';
    if (opts.board) {
      const board = resolveBoard(db, opts.board);
      filter.boardId = board.id;
      scopeLabel = `board "${board.name}"`;
    }
    if (opts.wish) {
      filter.wish = opts.wish;
      scopeLabel = opts.board ? `${scopeLabel}, wish "${opts.wish}"` : `wish "${opts.wish}"`;
    }

    const tasks = listTasks(db, filter);
    const grouped = groupByStatus(tasks);

    if (opts.json) {
      out(JSON.stringify({ scope: scopeLabel, columns: grouped }, null, 2));
      return;
    }

    out(`\nBoard — ${scopeLabel}`);
    out('═'.repeat(56));
    const counts = COLUMNS.map((c) => `${c.label}: ${grouped[c.status].length}`).join('   ');
    out(`  ${counts}`);
    for (const column of COLUMNS) {
      printColumn(column.label, column.tint, grouped[column.status]);
    }
    out('');
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

// ============================================================================
// Registration
// ============================================================================

export function registerV5BoardCommands(v5: Command): void {
  v5.command('board')
    .description('Kanban view derived by query (no stored view state)')
    .option('--board <ref>', 'Scope to a board id or name')
    .option('--wish <slug>', 'Scope to a wish slug')
    .option('--json', 'Output as JSON')
    .action((opts: BoardOptions) => handleBoard(opts));
}
