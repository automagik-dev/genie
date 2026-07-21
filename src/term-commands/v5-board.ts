/**
 * genie v5 board — a kanban view derived purely by query over the v5 SQLite
 * state engine (src/lib/v5). There is NO stored view state: the columns are the
 * four task statuses, and every invocation re-groups the live rows. Status
 * changes are reflected immediately on the next render with nothing to persist.
 *
 *   board [--board <ref>] [--wish <slug>] [--json]
 */

import type { Database } from 'bun:sqlite';
import type { Command } from 'commander';
import { color, padRight, truncate } from '../lib/term-format.js';
import { cardBadges } from '../lib/v5/card-render.js';
import { openDb } from '../lib/v5/genie-db.js';
import {
  type BoardRow,
  DEFAULT_LIFECYCLE_LANES,
  type Lane,
  type LaneTaskRow,
  type TaskCardRow,
  type TaskFilter,
  type TaskRow,
  type TaskStatus,
  commentCounts,
  countBoardTasks,
  createBoard,
  listBoards,
  listTaskCards,
  listTasks,
  listTasksWithLane,
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

/** Wrap a handler so typed errors become clean stderr + non-zero exit. */
function run(handler: () => void): void {
  try {
    handler();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

// ============================================================================
// Column model
// ============================================================================

/**
 * The `--json` grouping key is the raw four-status enum — FROZEN. Byte-freeze
 * (WISH Decision 7): the machine shape keeps all four keys and never gains a
 * runtime/lane field, even though the human render below collapses to three
 * columns. `groupByStatus` maps frozen {@link TaskRow}s (via {@link listTasks}),
 * so the serialized shape is byte-identical to the pre-runtime board.
 */
function groupByStatus(tasks: TaskRow[]): Record<TaskStatus, TaskRow[]> {
  const groups: Record<TaskStatus, TaskRow[]> = { blocked: [], ready: [], in_progress: [], done: [] };
  for (const t of tasks) groups[t.status].push(t);
  return groups;
}

/**
 * The HUMAN laneless render is three columns — `blocked` is a badge, never a
 * column (WISH Decision 1). A `blocked`-status card folds into Ready badged ⛔;
 * an enforced/agent block badges ⛔ inside whatever column its status lands it in.
 */
const LANELESS_COLUMNS: Array<{
  label: string;
  tint: Parameters<typeof color>[0];
  statuses: readonly TaskStatus[];
}> = [
  { label: 'Ready', tint: 'cyan', statuses: ['ready', 'blocked'] },
  { label: 'In Progress', tint: 'yellow', statuses: ['in_progress'] },
  { label: 'Done', tint: 'green', statuses: ['done'] },
];

function printCardColumn(
  label: string,
  tint: Parameters<typeof color>[0],
  cards: TaskCardRow[],
  now: number,
  comments: Map<string, number>,
): void {
  const count = cards.length;
  out(`\n${color(tint, `── ${label} (${count} card${count === 1 ? '' : 's'}) ──`)}`);
  if (count === 0) {
    out('  (empty)');
    return;
  }
  for (const t of cards) out(renderCardLine(t, now, comments));
}

/** One card's render line: id, title, claimant, wish, then runtime badges. */
function renderCardLine(t: TaskCardRow, now: number, comments: Map<string, number>): string {
  const claimed = t.claimedBy ? `  @${t.claimedBy}` : '';
  const wish = t.wish ? `  ${color('gray', t.group ? `${t.wish}#${t.group}` : t.wish)}` : '';
  const badges = cardBadges(t, now, comments.get(t.id) ?? 0);
  return `  ${padRight(t.id, 20)}  ${truncate(t.title, 40)}${claimed}${wish}${badges}`;
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
    let board: BoardRow | null = null;
    if (opts.board) {
      board = resolveBoard(db, opts.board);
      filter.boardId = board.id;
      scopeLabel = `board "${board.name}"`;
    }
    if (opts.wish) {
      filter.wish = opts.wish;
      scopeLabel = opts.board ? `${scopeLabel}, wish "${opts.wish}"` : `wish "${opts.wish}"`;
    }

    // A scoped board that defines lanes renders on the lifecycle axis. Every
    // other scope (no board, or a laneless board) falls through to the frozen
    // status render below — kept byte-identical (Group B owns any rework).
    if (board?.lanes && board.lanes.length > 0) {
      renderLaneBoard(db, board.lanes, filter, scopeLabel, opts.json ?? false);
      return;
    }

    // `--json` FROZEN path: frozen TaskRows grouped by the four raw statuses.
    if (opts.json) {
      const grouped = groupByStatus(listTasks(db, filter));
      out(JSON.stringify({ scope: scopeLabel, columns: grouped }, null, 2));
      return;
    }

    renderLanelessCards(db, filter, scopeLabel);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

/**
 * Human three-column render (Ready / In Progress / Done) with runtime badges.
 * Cards carry the runtime projection so each can show liveness (▶/⏸/☠), an
 * enforced/deps ⛔ block, and a 💬 comment count. `blocked`-status cards fold
 * into Ready (badged ⛔), keeping blocked a badge and never a column.
 */
function renderLanelessCards(db: Database, filter: TaskFilter, scopeLabel: string): void {
  const cards = listTaskCards(db, filter);
  const comments = commentCounts(db);
  const now = Date.now();
  const byColumn = LANELESS_COLUMNS.map((c) => ({
    ...c,
    cards: cards.filter((t) => c.statuses.includes(t.status)),
  }));

  out(`\nBoard — ${scopeLabel}`);
  out('═'.repeat(56));
  out(`  ${byColumn.map((c) => `${c.label}: ${c.cards.length}`).join('   ')}`);
  for (const column of byColumn) {
    printCardColumn(column.label, column.tint, column.cards, now, comments);
  }
  out('');
}

// ============================================================================
// Lane-grouped render — the lifecycle axis, additive to the status render.
// ============================================================================

/** Group cards into the board's lanes; NULL/unknown lanes fall into the first. */
function groupByLane<T extends LaneTaskRow>(lanes: Lane[], tasks: T[]): Map<string, T[]> {
  const byLane = new Map<string, T[]>();
  for (const lane of lanes) byLane.set(lane.name, []);
  const firstLane = lanes[0].name;
  for (const t of tasks) {
    const target = t.lane && byLane.has(t.lane) ? t.lane : firstLane;
    (byLane.get(target) as T[]).push(t);
  }
  return byLane;
}

function renderLaneBoard(db: Database, lanes: Lane[], filter: TaskFilter, scopeLabel: string, json: boolean): void {
  // `--json` keeps the additive lane shape with lane-only cards (no runtime
  // fields), matching the frozen laneless `--json`'s runtime-free contract.
  if (json) {
    const byLane = groupByLane(lanes, listTasksWithLane(db, filter));
    const laneGroups = lanes.map((l) => ({
      name: l.name,
      label: l.label ?? null,
      action: l.action ?? null,
      cards: byLane.get(l.name) ?? [],
    }));
    out(JSON.stringify({ scope: scopeLabel, lanes: laneGroups }, null, 2));
    return;
  }

  const byLane = groupByLane(lanes, listTaskCards(db, filter));
  const comments = commentCounts(db);
  const now = Date.now();
  out(`\nBoard — ${scopeLabel}`);
  out('═'.repeat(56));
  const counts = lanes.map((l) => `${l.label ?? l.name}: ${(byLane.get(l.name) ?? []).length}`).join('   ');
  out(`  ${counts}`);
  for (const lane of lanes) {
    const cards = byLane.get(lane.name) ?? [];
    // Display-only action hint on the lane header — nothing executes it.
    const hint = lane.action ? ` → ${lane.action}` : '';
    const header = `── ${lane.label ?? lane.name}${hint} (${cards.length} card${cards.length === 1 ? '' : 's'}) ──`;
    out(`\n${color('cyan', header)}`);
    if (cards.length === 0) {
      out('  (empty)');
      continue;
    }
    for (const t of cards) out(renderCardLine(t, now, comments));
  }
  out('');
}

// ============================================================================
// board create / board list
// ============================================================================

/** Parse `--lanes "A,B,C"` sugar into name-only lane objects. */
function parseLaneArg(raw: string): Lane[] {
  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) fail('--lanes must list at least one lane name.');
  return names.map((name) => ({ name }));
}

interface CreateBoardOptions {
  lanes?: string;
}

function handleCreateBoard(name: string, opts: CreateBoardOptions): void {
  const boardName = name?.trim();
  if (!boardName) fail('board name is required and must not be empty.');
  run(() => {
    const db = openDb();
    try {
      const lanes = opts.lanes ? parseLaneArg(opts.lanes) : DEFAULT_LIFECYCLE_LANES;
      const board = createBoard(db, boardName, lanes);
      const laneList = (board.lanes ?? []).map((l) => l.name).join(', ');
      out(`Created board "${board.name}" (${board.id}) with ${board.lanes?.length ?? 0} lanes: ${laneList}`);
    } finally {
      db.close();
    }
  });
}

interface ListBoardOptions {
  json?: boolean;
}

function handleListBoards(opts: ListBoardOptions): void {
  run(() => {
    const db = openDb();
    try {
      const rows = listBoards(db).map((b) => ({
        id: b.id,
        name: b.name,
        laneCount: b.lanes?.length ?? 0,
        cardCount: countBoardTasks(db, b.id),
      }));
      if (opts.json) {
        out(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        out('No boards found.');
        return;
      }
      out(`  ${padRight('NAME', 24)} ${padRight('ID', 20)} ${padRight('LANES', 7)} ${'CARDS'}`);
      out(`  ${'─'.repeat(64)}`);
      for (const r of rows) {
        out(
          `  ${padRight(truncate(r.name, 22), 24)} ${padRight(r.id, 20)} ${padRight(String(r.laneCount), 7)} ${r.cardCount}`,
        );
      }
      out(`\n  ${rows.length} board${rows.length === 1 ? '' : 's'}`);
    } finally {
      db.close();
    }
  });
}

// ============================================================================
// Registration
// ============================================================================

export function registerV5BoardCommands(v5: Command): void {
  const board = v5
    .command('board')
    .description('Kanban view derived by query (no stored view state)')
    .option('--board <ref>', 'Scope to a board id or name')
    .option('--wish <slug>', 'Scope to a wish slug')
    .option('--json', 'Output as JSON')
    .action((opts: BoardOptions) => handleBoard(opts));

  board
    .command('create <name>')
    .description('Create a board (defaults to the 6 lifecycle lanes)')
    .option('--lanes <lanes>', 'Comma-separated lane names (overrides the lifecycle default)')
    .action((name: string, opts: CreateBoardOptions) => handleCreateBoard(name, opts));

  board
    .command('list')
    .description('List boards with lane and card counts')
    .option('--json', 'Output as JSON')
    // Read via optsWithGlobals: the parent `board` also declares `--json`, so
    // commander may bind the flag at either level — merging resolves the clash.
    .action((_opts: ListBoardOptions, cmd: Command) => handleListBoards(cmd.optsWithGlobals()));
}
