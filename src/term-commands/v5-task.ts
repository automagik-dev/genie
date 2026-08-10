/**
 * genie v5 task — thin CLI over the v5 SQLite state engine (src/lib/v5).
 *
 * Every subcommand opens the repo's shared `.genie/genie.db`, runs one
 * transaction through the state module, and exits. Zero daemons, zero Postgres,
 * no runtime registry — the database is the only shared medium.
 *
 * Subcommands:
 *   task create --title <t> [--board <ref>] [--wish <slug>] [--group <name>]
 *   task link <id> --wish <slug> [--group <name>]
 *   task list [--status <s>] [--board <ref>] [--wish <slug>] [--json]
 *   task status <id>
 *   task set-wish <id> (--wish <slug> [--group <name>] | --clear)
 *   task delete <id>
 *   task done <id>
 *   task checkout <id> [--worker <name>]
 *   task export [--write [file]]
 *   task import [file] [--replace]
 *   task sync
 */

import type { Database } from 'bun:sqlite';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import { color, formatTimestamp, padRight, truncate } from '../lib/term-format.js';
import { livenessBadge } from '../lib/v5/card-render.js';
import { openDb, resolveRoadmapPath } from '../lib/v5/genie-db.js';
import {
  recordExportBaseline,
  recordImportBaseline,
  roadmapSnapshot,
  syncRoadmap,
  writeSnapshotFile,
} from '../lib/v5/roadmap-sync.js';
import {
  type BlockKind,
  type EventAuthor,
  type ImportSummary,
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
  deleteTask,
  exportState,
  formatWishRef,
  getDependencies,
  getStageLog,
  getTask,
  getTaskCard,
  getTaskEvents,
  importState,
  linkTaskToWish,
  listTasks,
  moveTask,
  recordHeartbeat,
  releaseTask,
  resolveBoard,
  setTaskWish,
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
    const kind = task.enforcedBlock?.kind ?? 'work';
    out(`  Blocked by: ${task.blockedBy} (${kind})${reason}`);
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

interface LinkOptions {
  wish: string;
  group?: string;
}

function handleLink(id: string, opts: LinkOptions): void {
  const wish = opts.wish?.trim();
  if (!wish) fail('--wish is required and must not be empty.');
  const group = opts.group?.trim();
  if (opts.group !== undefined && !group) fail('--group must not be empty.');

  run(() => {
    const db = openDb();
    try {
      const task = linkTaskToWish(db, id, wish, group, Date.now(), resolveEventAuthor());
      out(`Linked task ${task.id} to wish ${formatWishRef(task)}.`);
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

interface SetWishOptions {
  wish?: string;
  group?: string;
  clear?: boolean;
}

/**
 * Re-point an existing card's lifecycle identity. `--group requires --wish.` is
 * the same guard (and the same message) `create` enforces, so the two verbs
 * accept identical wish arguments; slugs stay unvalidated on both.
 */
function handleSetWish(id: string, opts: SetWishOptions): void {
  const wish = opts.wish?.trim();
  const group = opts.group?.trim();
  if (opts.group !== undefined && !group) fail('--group must not be empty.');
  if (group && !wish) fail('--group requires --wish.');
  if (opts.clear && wish) fail('--clear cannot be combined with --wish.');
  if (!opts.clear && !wish) fail('--wish <slug> or --clear is required.');

  run(() => {
    const db = openDb();
    try {
      const to = { wish: wish ?? null, group: group ?? null };
      const result = setTaskWish(db, id, to, resolveEventAuthor());
      out(`Task ${result.task.id} wish: ${formatWishRef(result.from)} → ${formatWishRef(result.to)}.`);
    } finally {
      db.close();
    }
  });
}

/**
 * Remove a mistakenly created card outright. The verb is deliberately flagless:
 * a hard delete with no archive, refused while anything depends on the card, and
 * published by the next `task sync` like any other board mutation.
 */
function handleDelete(id: string): void {
  run(() => {
    const db = openDb();
    try {
      const { task, dependencies, events } = deleteTask(db, id);
      out(
        `Deleted task ${task.id} "${task.title}" (${dependencies} dependency edge${dependencies === 1 ? '' : 's'}, ${events} timeline event${events === 1 ? '' : 's'}).`,
      );
      out('Run `genie task sync` (or commit) to publish the removal to .genie/roadmap.json.');
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
 * Resolve the worker identity from the environment: `GENIE_AGENT_NAME`, then
 * `GENIE_AGENT_ID`, flooring at 'cli'. The ONE identity resolver shared by the
 * claim side (`handleCheckout`'s worker → `claimed_by`) and the complete side
 * (`resolveEventAuthor().author` → event attribution), so the two sides always
 * record the same identity for the same runtime. NOTE: completion is NOT
 * identity-fenced — completeTask deliberately has no claimed_by check (`task
 * done` is the orchestrator's verb, routinely run by a non-claimant); a shared
 * resolver only keeps claim rows and event attribution consistent. Previously
 * the two chains diverged — the claim chain ignored GENIE_AGENT_ID and floored
 * at 'cli', the complete chain preferred NAME then ID and floored at null — so
 * a GENIE_AGENT_ID-only runtime claimed as 'cli' but attributed events as the
 * ID.
 */
function resolveWorkerIdentity(): string {
  return process.env.GENIE_AGENT_NAME ?? process.env.GENIE_AGENT_ID ?? 'cli';
}

/**
 * Resolve the acting author for a card event from the environment: identity via
 * {@link resolveWorkerIdentity} (so a no-env CLI writes 'cli', matching what
 * checkout wrote to `claimed_by`), kind via {@link resolveAuthorKind}. The
 * single author resolver shared by every authored verb and `moveTask`.
 */
function resolveEventAuthor(): EventAuthor {
  return {
    author: resolveWorkerIdentity(),
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
  const worker = opts.worker ?? resolveWorkerIdentity();
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
  hold?: boolean;
}

function handleBlock(id: string, opts: BlockOptions): void {
  const reason = opts.reason?.trim();
  if (!reason) fail('--reason <text> is required.');
  const kind: BlockKind = opts.hold ? 'hold' : 'work';
  run(() => {
    const db = openDb();
    try {
      const task = blockTask(db, id, reason, resolveEventAuthor(), kind);
      out(`Blocked task ${task.id} (${task.status}, ${kind}).`);
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

interface ExportOptions {
  write?: string | boolean;
}

/**
 * Realpath-normalized form for path IDENTITY comparison. A raw string compare is
 * wrong twice over: `--write <relative>` resolves against process.cwd() while
 * `resolveRoadmapPath()` resolves against the git COMMON root, and macOS spells
 * the same directory two ways (`/var/...` vs `/private/var/...`). The target file
 * itself may not exist yet, so normalize the existing parent + basename.
 */
function normalizedPath(path: string): string {
  try {
    return join(realpathSync(dirname(path)), basename(path));
  } catch {
    return path;
  }
}

function samePath(a: string, b: string): boolean {
  return normalizedPath(a) === normalizedPath(b);
}

/**
 * True for ANY target spelled `<dir>/.genie/roadmap.json`, not just this repo's
 * canonical file — a subdirectory or linked-worktree spelling resolves elsewhere
 * yet is still a git-trackable file under the canonical name. Such a file gets
 * the roadmap slice so full-state `hire_roster` rows (machine-local worktree
 * paths) can never travel in it. Custom-file writes and the plain stdout dump
 * stay the complete database, so a backup file round-trips lossless.
 */
function isRoadmapSlicePath(path: string): boolean {
  const normalized = normalizedPath(path);
  return basename(normalized) === 'roadmap.json' && basename(dirname(normalized)) === '.genie';
}

function handleExport(opts: ExportOptions): void {
  run(() => {
    const db = openDb();
    try {
      const target = opts.write ? (typeof opts.write === 'string' ? resolve(opts.write) : resolveRoadmapPath()) : null;
      if (target === null) {
        process.stdout.write(`${JSON.stringify(exportState(db), null, 2)}\n`);
        return;
      }
      const sliced = isRoadmapSlicePath(target);
      const canonical = sliced && samePath(target, resolveRoadmapPath());
      // ONE immediate transaction over snapshot → file write → baseline. genie.db
      // is shared across worktrees, so a writer landing mid-sequence would
      // otherwise yield a torn snapshot (dependency rows whose tasks were missed)
      // or a baseline dbHash describing a NEWER db than the published file — the
      // next `task sync` then reads as in-sync and silently drops that change.
      const publish = db.transaction(() => {
        const state = sliced ? roadmapSnapshot(db) : exportState(db);
        // Atomic (temp + rename) so a torn write can never leave the canonical
        // board — or a custom backup — truncated mid-command.
        writeSnapshotFile(target, state);
        // Writing the canonical snapshot declares "this pair is intentional" —
        // it is the keep-the-local-board resolution for a diverged sync. Only the
        // true canonical path may stamp it; a same-named file elsewhere must not.
        if (canonical) recordExportBaseline(state);
      });
      publish.immediate();
      out(`Wrote board snapshot to ${target}.`);
    } finally {
      db.close();
    }
  });
}

interface ImportOptions {
  replace?: boolean;
}

function handleSync(): void {
  run(() => {
    const db = openDb();
    try {
      const result = syncRoadmap(db);
      out(result.message ?? `Board and snapshot are in sync (${result.action}).`);
      if (result.action === 'diverged') process.exit(1);
    } finally {
      db.close();
    }
  });
}

function handleImport(file: string | undefined, opts: ImportOptions): void {
  run(() => {
    // Normalize before the canonical comparison: an explicit relative spelling
    // of the roadmap path must behave exactly like omitting it.
    const source = file ? resolve(file) : resolveRoadmapPath();
    if (!existsSync(source)) {
      fail(`Snapshot not found: ${source}. Generate one with \`genie task export --write\` and commit it.`);
    }
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(readFileSync(source, 'utf-8'));
    } catch (err) {
      fail(`Snapshot at ${source} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    const db = openDb();
    try {
      // A roadmap-sliced snapshot carries no hires, so local hires stay untouched;
      // only the true canonical file may stamp the sync baseline.
      const sliced = isRoadmapSlicePath(source);
      const canonical = sliced && samePath(source, resolveRoadmapPath());
      // ONE immediate transaction over import → baseline (importState's own
      // transaction nests as a savepoint): the baseline's post-import db
      // re-snapshot must not see another worktree's write, or the marker would
      // claim a db state the file never described and the next `task sync` would
      // report in-sync while that change stayed unpublished.
      const apply = db.transaction(() => {
        const result = importState(db, snapshot, { replace: opts.replace, preserveHireRoster: sliced });
        if (canonical) recordImportBaseline(db, snapshot);
        return result;
      });
      const summary = apply.immediate() as ImportSummary;
      out(
        `Imported ${summary.tasks} tasks, ${summary.boards} boards, ${summary.dependencies} dependencies, ${summary.events} events, ${summary.wishGroups} wish groups, ${summary.hires} hires from ${source}.`,
      );
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
    .command('link <id>')
    .description('Link an existing task to a wish (appends a wish event)')
    .requiredOption('--wish <slug>', 'Wish slug this task belongs to')
    .option('--group <name>', 'Optional wish-group name')
    .action((id: string, opts: LinkOptions) => handleLink(id, opts));

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
    .command('set-wish <id>')
    .description('Attach, re-point, or clear the wish identity on a card (appends a wish event)')
    .option('--wish <slug>', 'Wish slug to attach the card to')
    .option('--group <name>', 'Wish-group name (requires --wish)')
    .option('--clear', 'Remove the wish and group from the card')
    .action((id: string, opts: SetWishOptions) => handleSetWish(id, opts));

  task
    .command('delete <id>')
    .description('Permanently delete a card, its edges, and its timeline (refused while other cards depend on it)')
    .addHelpText(
      'after',
      `
Hard delete, no archive and no undo: the card, its dependency edges, its
timeline, and its stage log are removed outright. The card's history survives
only in whatever .genie/roadmap.json revisions git already holds. Any status is
deletable, claimed or not.

Refused while another card depends on this one, naming the dependents. The edge
table cascades on delete, so removing a depended-on card would erase the edge
instead of failing — the dependent would stay "blocked" with nothing blocking
it, and the next ready-set recompute (which any \`task done\` triggers) would
silently promote it to "ready". Re-point or delete the dependents first.

The removal reaches .genie/roadmap.json through the ordinary \`task sync\`
export, with two caveats:
  * \`task import --replace\` rebuilds the database as exact snapshot state, so
    replaying an older snapshot resurrects the deleted card. (Plain \`task
    import\` refuses a non-empty database outright.)
  * Deleting the LAST card can hand the next sync to the import branch instead
    of the export branch — it takes that path only when no board or wish-group
    rows remain either. Publish with \`task export --write\` when emptying the
    board completely.`,
    )
    .action((id: string) => handleDelete(id));

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
    .option('--hold', 'Record the block as a deliberate hold (parked) rather than a work problem')
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
    .option('--write [file]', 'Write the snapshot to a file instead of stdout (default: .genie/roadmap.json)')
    .action((opts: ExportOptions) => handleExport(opts));

  task
    .command('import [file]')
    .description('Restore database state from an export snapshot (default: .genie/roadmap.json)')
    .option('--replace', 'Overwrite existing state instead of refusing a non-empty database')
    .action((file: string | undefined, opts: ImportOptions) => handleImport(file, opts));

  task
    .command('sync')
    .description('Reconcile genie.db with the canonical .genie/roadmap.json (imports, exports, or warns on divergence)')
    .action(() => handleSync());
}
