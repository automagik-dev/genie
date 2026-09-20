/**
 * genie v5 task — thin CLI over the v5 SQLite state engine (src/lib/v5).
 *
 * Every subcommand opens the repo's shared `.genie/genie.db`, runs one
 * transaction through the state module, and exits. Zero daemons, zero Postgres,
 * no runtime registry — the database is the only shared medium.
 *
 * Subcommands:
 *   task create --title <t> [--board <ref>] [--wish <slug>] [--group <name>] [--agent <name> --why <reason>]
 *   task link <id> --wish <slug> [--group <name>]
 *   task list [--status <s>] [--board <ref>] [--wish <slug>] [--json]
 *   task status <id>
 *   task set-wish <id> (--wish <slug> [--group <name>] | --clear)
 *   task assign <id> (--agent <name> --why <reason> | --clear)
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
import { orcaOwnsLifecycle } from '../lib/orchestration-mode.js';
import { color, formatTimestamp, padRight, truncate } from '../lib/term-format.js';
import { livenessBadge } from '../lib/v5/card-render.js';
import { openDb, resolveRoadmapPath } from '../lib/v5/genie-db.js';
import { resolveEventAuthor, resolveWorkerIdentity } from '../lib/v5/identity.js';
import {
  hasGenieWorkspace,
  recordExportBaseline,
  recordImportBaseline,
  resolveWorkspaceDir,
  roadmapSnapshot,
  serializeSnapshot,
  syncRoadmap,
  writeSnapshotFile,
} from '../lib/v5/roadmap-sync.js';
import {
  type BlockKind,
  type ImportSummary,
  SnapshotFormatError,
  type TaskCardRow,
  type TaskFilter,
  type TaskRow,
  type TaskStatus,
  UnknownTaskError,
  adoptTask,
  appendReportEvent,
  appendTaskEvent,
  assignTask,
  blockTask,
  claimTask,
  clearTaskAssignment,
  completeTask,
  createTask,
  deleteTask,
  formatWishRef,
  getBoard,
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
  toFrozenTaskRow,
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

/**
 * The lane `task status` reports — the SAME placement `genie board` renders,
 * not merely the stored `tasks.lane` column. `groupByLane` puts a card whose
 * lane is null (or names a lane the board no longer defines) in the board's
 * FIRST lane, so printing the raw column alone would let status and board
 * disagree. Returns null when there is no lane to speak of (no board, or a
 * laneless board and an unplaced card).
 *
 * Dogfood r5 Z7: status printed no lane at all, so the only way to learn where
 * a card sat was `genie board --json` or reading its move events.
 */
function laneLine(db: Database, task: TaskCardRow): string | null {
  const lanes = task.boardId ? (getBoard(db, task.boardId)?.lanes ?? null) : null;
  if (lanes === null || lanes.length === 0) {
    if (!task.lane) return null;
    const why = task.boardId ? ' (board defines no lanes)' : '';
    return `  Lane:       ${task.lane}${why}`;
  }
  if (task.lane && lanes.some((lane) => lane.name === task.lane)) return `  Lane:       ${task.lane}`;
  const first = lanes[0].name;
  if (task.lane) return `  Lane:       ${first} (stored lane "${task.lane}" is not on this board)`;
  return `  Lane:       ${first} (default — the card has never been moved)`;
}

function printDetailHeader(db: Database, task: TaskCardRow): void {
  out('');
  out(`Task ${task.id}: ${task.title}`);
  out('─'.repeat(60));
  out(`  Status:     ${statusLabel(task.status)}`);
  if (task.boardId) out(`  Board:      ${task.boardId}`);
  const lane = laneLine(db, task);
  if (lane) out(lane);
  if (task.wish) out(`  Wish:       ${task.group ? `${task.wish}#${task.group}` : task.wish}`);
  if (task.assignedAgent) {
    const why = task.assignedReason ? ` — ${task.assignedReason}` : '';
    out(`  Assigned to: ${task.assignedAgent}${why}`);
  }
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

/**
 * Render the structured half of a worker report. The prose note stays on the
 * timeline line; this is the part a reviewer needs without re-reading a
 * transcript — what changed, what ran, what to look at, what is still unknown.
 */
function printStructuredReport(payload: string): void {
  let parsed: { files?: string[]; checks?: string[]; artifacts?: string[]; risk?: string | null };
  try {
    parsed = JSON.parse(payload) as typeof parsed;
  } catch {
    out(`    (unreadable structured payload, ${payload.length} bytes)`);
    return;
  }
  const section = (label: string, items: string[] | undefined) => {
    if (!items || items.length === 0) return;
    out(`    ${label}:`);
    for (const item of items) out(`      - ${item}`);
  };
  section('Changed files', parsed.files);
  section('Checks run', parsed.checks);
  section('Artifacts', parsed.artifacts);
  if (parsed.risk) {
    out('    Remaining risk:');
    out(`      ${parsed.risk}`);
  }
}

function printTaskDetail(db: Database, task: TaskCardRow): void {
  printDetailHeader(db, task);
  printDependencies(db, task.id);

  const events = getTaskEvents(db, task.id);
  if (events.length > 0) {
    out('\n  Timeline:');
    for (const e of events) out(`    ${formatEventLine(e)}`);
  }

  const structured = events.filter((e) => e.kind === 'report' && e.payload);
  for (const e of structured) {
    out(`\n  Report (${e.author ?? 'unknown'}):`);
    printStructuredReport(e.payload as string);
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
  agent?: string;
  why?: string;
}

function handleCreate(opts: CreateOptions): void {
  const title = opts.title?.trim();
  if (!title) fail('--title is required and must not be empty.');
  if (opts.group && !opts.wish) fail('--group requires --wish.');

  run(() => {
    const db = openDb();
    try {
      // `!== undefined`, not truthiness: an explicit `--board ""` must reach the
      // resolver and be refused, never widen to "no board".
      const boardId = opts.board !== undefined ? resolveBoard(db, opts.board).id : undefined;
      // The assignment pair invariant (both halves or neither) and the roster
      // allowlist are enforced by the state API — the typed errors surface here
      // through run() with the roster named verbatim.
      const task = createTask(db, {
        title,
        boardId,
        wish: opts.wish,
        group: opts.group,
        assignedAgent: opts.agent,
        assignedReason: opts.why,
      });
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
      if (opts.board !== undefined) filter.boardId = resolveBoard(db, opts.board).id;
      if (opts.wish) filter.wish = opts.wish;
      const tasks = listTasks(db, filter);
      if (opts.json) {
        // Assignment serializes on the lane board `--json` path only; this
        // machine-readable payload stays on the frozen pre-assignment shape.
        out(JSON.stringify(tasks.map(toFrozenTaskRow), null, 2));
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

interface AssignOptions {
  agent?: string;
  why?: string;
  clear?: boolean;
}

/**
 * Declare which roster agent works a card and why — or `--clear` the
 * declaration. Mirrors the `set-wish`/`--clear` precedent: the pair invariant
 * (both halves or neither) and the roster allowlist are enforced by the state
 * API, which also appends the assign/clear timeline note inside its own
 * transaction, so this verb only maps flags and prints the result.
 */
function handleAssign(id: string, opts: AssignOptions): void {
  const agent = opts.agent?.trim();
  const why = opts.why?.trim();
  if (opts.clear && (agent || why)) fail('--clear cannot be combined with --agent or --why.');

  run(() => {
    const db = openDb();
    try {
      const task = opts.clear
        ? clearTaskAssignment(db, id, resolveEventAuthor())
        : assignTask(db, id, agent ?? '', why ?? '', resolveEventAuthor());
      out(
        opts.clear
          ? `Cleared assignment on task ${task.id}.`
          : `Assigned task ${task.id} to ${task.assignedAgent}: ${task.assignedReason}.`,
      );
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

interface AdoptOptions {
  board?: string;
  lane?: string;
}

function handleAdopt(id: string, opts: AdoptOptions): void {
  const boardRef = opts.board?.trim();
  const lane = opts.lane?.trim();
  if (!boardRef) fail('--board <ref> is required.');
  if (!lane) fail('--lane <name> is required.');
  run(() => {
    const db = openDb();
    try {
      const result = adoptTask(db, id, boardRef, lane, resolveEventAuthor());
      out(`Adopted task ${result.task.id} onto board "${result.board.name}" in lane ${result.lane}.`);
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

interface AuthoredNoteOptions {
  worker?: string;
}

/** Timeline prose crosses the DSH board input contract (4000 bytes, no control characters); bound it at the CLI too. */
const NOTE_MAX_BYTES = 4000;
function boundedNote(text: string | undefined, what: string): string {
  const note = text?.trim() ?? '';
  if (!note) fail(`a non-empty ${what} is required.`);
  // Tab, line feed and carriage return are text (the board's own contract keeps
  // newlines verbatim); every other C0 control and DEL is refused.
  for (const character of note) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x7f || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d))
      fail(`${what} must not contain control characters.`);
  }
  if (Buffer.byteLength(note) > NOTE_MAX_BYTES) fail(`${what} must be at most ${NOTE_MAX_BYTES} bytes.`);
  return note;
}

/** `--worker` names the speaker the way `checkout --worker` does; kind still comes from the runtime. */
function authoredBy(opts: AuthoredNoteOptions): { author: string; authorKind: string | undefined } {
  const base = resolveEventAuthor();
  const worker = opts.worker?.trim();
  return { author: worker || base.author || 'cli', authorKind: base.authorKind ?? undefined };
}

interface ChecklistRow {
  position: number;
  text: string;
  checked_at: number | null;
  checked_by: string | null;
  evidence: string | null;
}

/** Ordered definition-of-done items for one card. */
function checklistRows(db: Database, id: string): ChecklistRow[] {
  return db
    .query(
      'SELECT position, text, checked_at, checked_by, evidence FROM task_checklist WHERE task_id = ? ORDER BY position',
    )
    .all(id) as ChecklistRow[];
}

function requireChecklistItem(db: Database, id: string, raw: string): ChecklistRow {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) fail(`Checklist position must be a positive integer, got "${raw}".`);
  const row = checklistRows(db, id).find((r) => r.position === n);
  if (!row) fail(`Task ${id} has no checklist item ${n}.`);
  return row;
}

function handleChecklist(id: string): void {
  run(() => {
    const db = openDb();
    try {
      if (!getTask(db, id)) throw new UnknownTaskError(id);
      const rows = checklistRows(db, id);
      if (rows.length === 0) {
        out(`No checklist items on ${id}.`);
        return;
      }
      const done = rows.filter((r) => r.checked_at !== null).length;
      out(`Checklist for ${id} (${done}/${rows.length} done):`);
      for (const r of rows) {
        const mark = r.checked_at === null ? 'open' : 'done';
        const by = r.checked_by ? ` [${r.checked_by}]` : '';
        const evidence = r.evidence ? ` — ${r.evidence}` : '';
        out(`  ${r.position}. [${mark}] ${r.text}${by}${evidence}`);
      }
    } finally {
      db.close();
    }
  });
}

function handleChecklistAdd(id: string, text: string, opts: AuthoredNoteOptions): void {
  const item = boundedNote(text, 'checklist item');
  run(() => {
    const db = openDb();
    try {
      if (!getTask(db, id)) throw new UnknownTaskError(id);
      const next = (
        db.query('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM task_checklist WHERE task_id = ?').get(id) as {
          p: number;
        }
      ).p;
      db.query('INSERT INTO task_checklist (task_id, position, text, created_at) VALUES (?, ?, ?, ?)').run(
        id,
        next,
        item,
        Date.now(),
      );
      const author = authoredBy(opts);
      appendTaskEvent(db, id, {
        kind: 'checklist_add',
        note: `${next}. ${item}`,
        authorKind: author.authorKind,
        author: author.author,
      });
      out(`Added checklist item ${next} to ${id}.`);
    } finally {
      db.close();
    }
  });
}

function handleChecklistCheck(id: string, position: string, opts: AuthoredNoteOptions & { evidence?: string }): void {
  const evidence = opts.evidence === undefined ? undefined : boundedNote(opts.evidence, 'checklist evidence');
  run(() => {
    const db = openDb();
    try {
      if (!getTask(db, id)) throw new UnknownTaskError(id);
      const item = requireChecklistItem(db, id, position);
      const author = authoredBy(opts);
      db.query(
        'UPDATE task_checklist SET checked_at = ?, checked_by = ?, evidence = ? WHERE task_id = ? AND position = ?',
      ).run(Date.now(), author.author, evidence ?? item.evidence, id, item.position);
      appendTaskEvent(db, id, {
        kind: 'checklist_check',
        note: `${item.position}. ${item.text}${evidence ? ` — ${evidence}` : ''}`,
        authorKind: author.authorKind,
        author: author.author,
      });
      out(`Checked item ${item.position} on ${id}${evidence ? ' with evidence' : ''}.`);
    } finally {
      db.close();
    }
  });
}

function handleChecklistUncheck(id: string, position: string, opts: AuthoredNoteOptions): void {
  run(() => {
    const db = openDb();
    try {
      if (!getTask(db, id)) throw new UnknownTaskError(id);
      const item = requireChecklistItem(db, id, position);
      const author = authoredBy(opts);
      // Reopening clears the tick AND its evidence: the checklist row is current
      // state, not history — the checklist_check event already preserves what was
      // claimed and by whom.
      db.query(
        'UPDATE task_checklist SET checked_at = NULL, checked_by = NULL, evidence = NULL WHERE task_id = ? AND position = ?',
      ).run(id, item.position);
      appendTaskEvent(db, id, {
        kind: 'checklist_uncheck',
        note: `${item.position}. ${item.text}`,
        authorKind: author.authorKind,
        author: author.author,
      });
      out(`Reopened item ${item.position} on ${id}.`);
    } finally {
      db.close();
    }
  });
}

function handleComment(id: string, text: string, opts: AuthoredNoteOptions): void {
  const note = boundedNote(text, 'comment');
  run(() => {
    const db = openDb();
    try {
      if (!getTask(db, id)) throw new UnknownTaskError(id);
      const author = authoredBy(opts);
      appendTaskEvent(db, id, { kind: 'comment', note, authorKind: author.authorKind, author: author.author });
      out(`Commented on task ${id} as ${author.author}.`);
    } finally {
      db.close();
    }
  });
}

interface ReportOptions extends AuthoredNoteOptions {
  files?: string;
  check?: string[];
  artifact?: string[];
  risk?: string;
}

/** One report may not carry an unbounded pile of evidence; the timeline is not a data store. */
const REPORT_PAYLOAD_MAX_BYTES = 8 * 1024;

/**
 * The structured half of a worker report, as JSON text — or undefined when the
 * caller gave only prose, which keeps the free-text report byte-identical to
 * what it has always been.
 */
function buildReportPayload(opts: ReportOptions): string | undefined {
  const files = (opts.files ?? '')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
  const checks = (opts.check ?? []).map((c) => c.trim()).filter(Boolean);
  const artifacts = (opts.artifact ?? []).map((a) => a.trim()).filter(Boolean);
  const risk = opts.risk?.trim() ?? '';
  if (files.length === 0 && checks.length === 0 && artifacts.length === 0 && !risk) return undefined;
  const payload = JSON.stringify({
    files,
    checks,
    artifacts,
    risk: risk || null,
  });
  if (Buffer.byteLength(payload, 'utf8') > REPORT_PAYLOAD_MAX_BYTES) {
    fail(
      `report refused: the structured fields are ${Buffer.byteLength(payload, 'utf8')} bytes, over the ${REPORT_PAYLOAD_MAX_BYTES}-byte limit. Link to the detail instead of pasting it.`,
    );
  }
  return payload;
}

function handleReport(id: string, text: string, opts: ReportOptions): void {
  const note = boundedNote(text, 'report');
  const payload = buildReportPayload(opts);
  run(() => {
    const db = openDb();
    try {
      const task = getTask(db, id);
      if (!task) throw new UnknownTaskError(id);
      const author = authoredBy(opts);
      // The report tag is a trust signal: only the card's current claimant may post one.
      if (task.claimedBy !== author.author) {
        fail(
          task.claimedBy
            ? `report refused: task ${id} is claimed by ${task.claimedBy}, not ${author.author}. Use comment, or checkout first.`
            : `report refused: task ${id} is not claimed. Checkout as ${author.author} first, or use comment.`,
        );
      }
      // One report per claim-to-handoff span (the promise `task report --help`
      // makes): the span rule lives in the state module so the probe and the
      // insert share one write lock.
      appendReportEvent(db, id, { note, payload, authorKind: author.authorKind, author: author.author });
      const structured = payload ? describeReportPayload(payload) : '';
      out(`Reported on task ${id} as ${author.author} (${author.authorKind ?? 'unknown'})${structured}.`);
    } finally {
      db.close();
    }
  });
}

/** Name what was recorded, so the caller can see the shape landed and not just that it did. */
function describeReportPayload(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as {
      files?: string[];
      checks?: string[];
      artifacts?: string[];
      risk?: string | null;
    };
    const parts = [
      `${parsed.files?.length ?? 0} file(s)`,
      `${parsed.checks?.length ?? 0} check(s)`,
      `${parsed.artifacts?.length ?? 0} artifact(s)`,
    ];
    if (parsed.risk) parts.push('risk noted');
    return ` with ${parts.join(', ')}`;
  } catch {
    return ' with structured fields';
  }
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
 * yet is still a git-trackable file under the canonical name.
 *
 * It no longer decides what the snapshot CONTAINS (every export is the roadmap
 * slice — see {@link handleExport}); it decides only that an import of such a
 * file must leave local hires alone, the same way the canonical one does.
 */
function isRoadmapSlicePath(path: string): boolean {
  const normalized = normalizedPath(path);
  return basename(normalized) === 'roadmap.json' && basename(dirname(normalized)) === '.genie';
}

/**
 * Emit the database as a snapshot — to stdout, or atomically to a file.
 *
 * EVERY export is {@link roadmapSnapshot}, whatever the destination: a snapshot
 * is a publishable artifact wherever it is written — stdout gets piped into a
 * gist, a `--write /tmp/backup.json` gets attached to an issue — so the
 * published slice must never depend on the caller having spelled the canonical
 * path. Since v6 that slice is the whole database: `hire_roster`, the one table
 * it ever excluded, was dropped by the v1 -> v2 migration.
 */
function handleExport(opts: ExportOptions): void {
  run(() => {
    const db = openDb();
    try {
      const target = opts.write ? (typeof opts.write === 'string' ? resolve(opts.write) : resolveRoadmapPath()) : null;
      if (target === null) {
        // Same serializer AND same slice as `--write`: one export of one
        // database is one byte sequence, whatever each machine's physical
        // column order or local hires happen to be.
        process.stdout.write(serializeSnapshot(roadmapSnapshot(db)));
        return;
      }
      const canonical = samePath(target, resolveRoadmapPath());
      // ONE immediate transaction over snapshot → file write → baseline. genie.db
      // is shared across worktrees, so a writer landing mid-sequence would
      // otherwise yield a torn snapshot (dependency rows whose tasks were missed)
      // or a baseline dbHash describing a NEWER db than the published file — the
      // next `task sync` then reads as in-sync and silently drops that change.
      const publish = db.transaction(() => {
        const state = roadmapSnapshot(db);
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
    // The one carve-out from the orca gate in `src/genie.ts` (see
    // `isOrcaForbiddenInvocation`). Orca owns lifecycle state, so there is no
    // local board and no snapshot to reconcile and nothing to report about
    // either: exit 0 with both streams empty. This sits BEFORE the workspace
    // guard on purpose — an orca-mode repository that was never `genie init`-ed
    // must be silent too, because `.husky/pre-commit` runs `task sync` on every
    // commit and any line here is a warning the operator can do nothing about.
    // `=== 'orca'` on purpose, not truthiness. Silence is right when Orca
    // genuinely owns the state, because there is then nothing to reconcile and
    // nothing the operator can act on. An authority genie could not PARSE is a
    // real, repairable fault: it keeps the pre-existing typed refusal so it is
    // seen and fixed, rather than being hidden behind a clean exit 0 forever.
    if (orcaOwnsLifecycle() === 'orca') return;
    // Ask BEFORE openDb, which would create `.genie/genie.db` and with it the
    // very directory being tested. A directory that was never `genie init`-ed
    // has neither side of the pair to reconcile, and reporting it "in sync"
    // (exit 0) is a clean bill sync never verified — the `|| true` git hooks
    // gate on `.genie/roadmap.json`, so they never reach this refusal.
    if (!hasGenieWorkspace()) {
      fail(
        `no Genie workspace at ${resolveWorkspaceDir()} — there is no board and no snapshot to reconcile. Run \`genie init\` here first.`,
      );
    }
    const db = openDb();
    try {
      const result = syncRoadmap(db);
      // The git hooks run this as `task sync || true`, so the exit code alone
      // reaches nobody: a refusal has to be readable in the hook output, on the
      // stream reserved for it, and has to name the two resolving commands.
      if (result.action === 'diverged') {
        const detail = result.message ?? 'The local board and .genie/roadmap.json both changed since the last sync.';
        process.stderr.write(`warn: ${detail}\n`);
        process.exit(1);
      }
      out(result.message ?? `Board and snapshot are in sync (${result.action}).`);
    } finally {
      db.close();
    }
  });
}

/**
 * Run the import transaction, re-labelling a snapshot-format refusal with the
 * source path. Every other failure (lock contention, IO) propagates untouched.
 */
function runImport(apply: { immediate: () => unknown }, source: string): ImportSummary {
  try {
    return apply.immediate() as ImportSummary;
  } catch (err) {
    if (err instanceof SnapshotFormatError) throw new SnapshotFormatError(`${source}: ${err.message}`);
    throw err;
  }
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
      const canonical = isRoadmapSlicePath(source) && samePath(source, resolveRoadmapPath());
      // ONE immediate transaction over import → baseline (importState's own
      // transaction nests as a savepoint): the baseline's post-import db
      // re-snapshot must not see another worktree's write, or the marker would
      // claim a db state the file never described and the next `task sync` would
      // report in-sync while that change stayed unpublished.
      const apply = db.transaction(() => {
        const result = importState(db, snapshot, { replace: opts.replace });
        if (canonical) recordImportBaseline(db, snapshot);
        return result;
      });
      // A malformed snapshot names the file it came from: `validateSnapshot`
      // knows the table/row/column, only this frame knows the path.
      const summary = runImport(apply, source);
      out(
        `Imported ${summary.tasks} tasks, ${summary.boards} boards, ${summary.dependencies} dependencies, ${summary.events} events, ${summary.wishGroups} wish groups from ${source}.`,
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
    .option('--agent <name>', 'Declared roster agent for this task (claude|codex|pi|hermes|prime; requires --why)')
    .option('--why <reason>', 'Why the declared agent was assigned (requires --agent)')
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
    .command('assign <id>')
    .description('Declare which roster agent works a card and why (appends an assign event; --clear removes)')
    .option('--agent <name>', 'Roster agent to declare (claude|codex|pi|hermes|prime; requires --why)')
    .option('--why <reason>', 'Why the agent was assigned (requires --agent)')
    .option('--clear', 'Remove the assignment from the card')
    .action((id: string, opts: AssignOptions) => handleAssign(id, opts));

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
    .command('adopt <id>')
    .description('Place a laneless card onto a board lane (one-time; appends a move event from (none))')
    .requiredOption('--board <ref>', 'Board id or name')
    .requiredOption('--lane <name>', 'Lane on that board')
    .action((id: string, opts: AdoptOptions) => handleAdopt(id, opts));

  task
    .command('checkout <id>')
    .description('Atomically claim a ready task for a worker')
    .option('--worker <name>', 'Worker identity (defaults to $GENIE_AGENT_NAME or "cli")')
    .action((id: string, opts: CheckoutOptions) => handleCheckout(id, opts));

  task
    .command('comment <id> <text>')
    .description('Append an authored comment to the card timeline (use -- before text that starts with a dash)')
    .option('--worker <name>', 'Speaker identity (defaults to $GENIE_AGENT_NAME or "cli")')
    .action((id: string, text: string, opts: AuthoredNoteOptions) => handleComment(id, text, opts));

  task
    .command('report <id> <text>')
    .description(
      "Append the claimant's worker report to the card timeline (one per claim-to-handoff span; a new checkout opens the next)",
    )
    .option('--worker <name>', 'Speaker identity (defaults to $GENIE_AGENT_NAME or "cli")')
    .option('--files <paths>', 'Comma-separated paths this work changed')
    .option('--check <result...>', 'A command you ran and its outcome (repeatable)')
    .option('--artifact <path...>', 'An artifact worth reviewing (repeatable)')
    .option('--risk <text>', 'What remains unverified or risky')
    .action((id: string, text: string, opts: ReportOptions) => handleReport(id, text, opts));

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
    .command('checklist <id>')
    .description('Show the definition-of-done checklist for a card')
    .action((id: string) => handleChecklist(id));

  task
    .command('checklist-add <id> <text>')
    .description('Append a definition-of-done item to a card (appends a checklist event)')
    .option('--worker <name>', 'Speaker identity (defaults to $GENIE_AGENT_NAME or "cli")')
    .action((id: string, text: string, opts: AuthoredNoteOptions) => handleChecklistAdd(id, text, opts));

  task
    .command('checklist-check <id> <position>')
    .description('Tick a definition-of-done item, recording who did it and optional evidence')
    .option('--evidence <text>', 'Short evidence note recorded with the tick')
    .option('--worker <name>', 'Speaker identity (defaults to $GENIE_AGENT_NAME or "cli")')
    .action((id: string, position: string, opts: AuthoredNoteOptions & { evidence?: string }) =>
      handleChecklistCheck(id, position, opts),
    );

  task
    .command('checklist-uncheck <id> <position>')
    .description('Reopen a definition-of-done item (clears the tick and its evidence)')
    .option('--worker <name>', 'Speaker identity (defaults to $GENIE_AGENT_NAME or "cli")')
    .action((id: string, position: string, opts: AuthoredNoteOptions) => handleChecklistUncheck(id, position, opts));

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
