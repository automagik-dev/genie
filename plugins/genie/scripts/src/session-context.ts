#!/usr/bin/env node

/**
 * Bounded, read-only Genie context for SessionStart — the db-backed,
 * context-aware injection shipped by hooks-v2#session-context.
 *
 * Resolution ladder (first match wins):
 *   1. the session branch resolves through the shared `resolveWishBranch`
 *      against genie.db slugs merged with the wish-file scan's → that wish's
 *      status, base/ready task counts, its task cards, and the plan path —
 *      the wish's own context, never a listing of other wishes;
 *   2. otherwise GENIE_AGENT_ID / GENIE_AGENT_NAME → this agent's claimed
 *      (in_progress) task cards;
 *   3. otherwise one compact, framed line: repo, branch, active wish count.
 *
 * Named read mechanism: `node:sqlite` — the hook runs as
 * `node …/session-context.cjs` from all three manifests, so `bun:sqlite` does
 * not exist at runtime. Minimum Node 22.13 (declared in the manifest doc table
 * in plugins/genie/README.md). A missing driver, an absent/unreadable genie.db,
 * and unsupported .git layouts are FIRST-CLASS degradations to the bounded
 * wish-file scan, each cause logged distinguishably on stderr — never a masked
 * failure. The file scan also supplies the slug/status data every mode shares,
 * so both degradation causes produce the same output shapes.
 *
 * Sharing contract: `resolveWishBranch` is the single implementation in
 * src/lib/v5/resolve-wish-branch.ts, imported by the board AND bundled into
 * this .cjs — it is pure (no sqlite import), so esbuild inlines it without
 * dragging `bun:sqlite` into the node-runtime bundle. A second implementation
 * is the drift class this wish exists to kill.
 *
 * Repository wish files and db rows are untrusted input. This hook emits only
 * validated slugs/groups, enumerated statuses, sanitized task ids, and integer
 * counts; it never forwards task titles, wish-file headings, or prose
 * into developer context. It performs no writes, subprocess calls, dependency
 * installation, or global synchronization.
 */

import { existsSync, lstatSync, opendirSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  WISH_SLUG_PATTERN,
  extractLegacyStatusValue,
  extractStatusCell,
  readBoundedWishFile,
  readBoundedWishHead,
} from '../../../../src/lib/wish-status.js';
import { resolveWishBranch, type ResolvedWishBranch } from '../../../../src/lib/v5/resolve-wish-branch.js';
import { isUuid } from '../../../../src/hooks/env-identity.js';

const MAX_CONTEXT_BYTES = 2_048;
/** Per-file size cap for the scan's head reads (larger files are refused). */
const MAX_WISH_FILE_BYTES = 256 * 1_024;
/** Head bytes read per wish for status extraction — the Status table is at
 * the top, and 64 candidates × this cap stays inside the 256 KiB budget. */
const MAX_WISH_HEAD_BYTES = 4 * 1_024;
const MAX_CANDIDATE_ENTRIES = 64;
const MAX_PARENT_LEVELS = 32;
const MAX_HOOK_INPUT_BYTES = 64 * 1_024;
const MAX_GIT_FILE_BYTES = 4 * 1_024;
const MAX_TASK_ROWS = 24;
const ACTIVE_STATUSES = new Set(['DRAFT', 'FIX-FIRST', 'APPROVED', 'IN_PROGRESS', 'BLOCKED']);
const TASK_STATUSES = new Set(['blocked', 'ready', 'in_progress', 'done']);
/** Display vocabulary: the active set plus every terminal status seen in the
 * corpora — a token outside it is unknown, never forwarded as free-form text. */
const DISPLAY_STATUSES = new Set([
  'DRAFT',
  'FIX-FIRST',
  'APPROVED',
  'IN_PROGRESS',
  'BLOCKED',
  'SHIPPED',
  'DONE',
  'EXECUTED',
  'MERGED',
]);

/** Same charset/admissibility contract as the pre-hooks-v2 inline regexes. */
const STATUS_CELL_ADMISSIBLE = /^\s*[A-Z_ -]+\s*$/;
const LEGACY_LINE_ADMISSIBLE = /^\s*[A-Z_ -]/;
const LEGACY_STATUS_PREFIX = /^[A-Z_ -]+/;

const GROUP_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

interface HookInput {
  hookEventName: string;
  cwd?: string;
}

function readHookInput(): HookInput {
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= MAX_HOOK_INPUT_BYTES) {
      const buffer = Buffer.allocUnsafe(Math.min(16 * 1_024, MAX_HOOK_INPUT_BYTES + 1 - total));
      const count = readSync(0, buffer, 0, buffer.byteLength, null);
      if (count === 0) break;
      chunks.push(buffer.subarray(0, count));
      total += count;
    }
    if (total > MAX_HOOK_INPUT_BYTES) return { hookEventName: 'SessionStart' };
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) return { hookEventName: 'SessionStart' };
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { hookEventName: 'SessionStart' };
    }
    const event = (value as Record<string, unknown>).hook_event_name;
    const cwd = (value as Record<string, unknown>).cwd;
    return {
      hookEventName: event === 'SessionStart' ? event : 'SessionStart',
      cwd: typeof cwd === 'string' && isAbsolute(cwd) ? cwd : undefined,
    };
  } catch {
    return { hookEventName: 'SessionStart' };
  }
}

// ============================================================================
// Wish-file scan (the shared data source in db-backed and degraded modes)
// ============================================================================

/** Raw admissible status span (table first, then legacy), or null. */
function rawStatusSpan(content: string): string | null {
  const table = extractStatusCell(content, 'first-pipe', (cell) => STATUS_CELL_ADMISSIBLE.test(cell)) ?? undefined;
  const legacy = extractLegacyStatusValue(content, (value) => LEGACY_LINE_ADMISSIBLE.test(value))?.match(
    LEGACY_STATUS_PREFIX,
  )?.[0];
  return (table ?? legacy)?.trim() ?? null;
}

/** The leading status token when it is in the display vocabulary, else null. */
function displayStatus(content: string): string | null {
  const token = rawStatusSpan(content)?.split(/\s+[—-]\s+/)[0]?.trim();
  return token && DISPLAY_STATUSES.has(token) ? token : null;
}

function physicalDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function hasPhysicalWishes(root: string): boolean {
  return physicalDirectory(join(root, '.genie')) && physicalDirectory(join(root, '.genie', 'wishes'));
}

interface WishScanEntry {
  slug: string;
  /** Display status token (charset-gated), or null when unreadable/absent. */
  status: string | null;
  /** Whether the declared status is a non-terminal one. */
  active: boolean;
}

function scanWishes(baseDir: string): WishScanEntry[] {
  const wishesDir = join(baseDir, '.genie', 'wishes');
  if (!hasPhysicalWishes(baseDir)) return [];

  const results: WishScanEntry[] = [];
  try {
    const slugs: string[] = [];
    const directory = opendirSync(wishesDir);
    try {
      for (let examined = 0; examined < MAX_CANDIDATE_ENTRIES; examined++) {
        const entry = directory.readSync();
        if (!entry) break;
        if (entry.isDirectory() && !entry.isSymbolicLink() && WISH_SLUG_PATTERN.test(entry.name)) slugs.push(entry.name);
      }
    } finally {
      try {
        directory.closeSync();
      } catch {
        // Some Node versions close automatically after the final read.
      }
    }
    slugs.sort();

    for (const slug of slugs) {
      const uppercase = join(wishesDir, slug, 'WISH.md');
      const wishFile = existsSync(uppercase) ? uppercase : join(wishesDir, slug, 'wish.md');
      if (!existsSync(wishFile)) continue;

      // Head-only read: every candidate gets its status counted instead of
      // late-sorted wishes being starved by a cumulative full-file budget.
      const content = readBoundedWishHead(wishFile, MAX_WISH_FILE_BYTES, MAX_WISH_HEAD_BYTES);
      if (content === null) continue;
      const status = displayStatus(content);
      results.push({ slug, status, active: status !== null && ACTIVE_STATUSES.has(status) });
    }
  } catch (error) {
    process.stderr.write(`[session-context] unable to read wish state: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  return results;
}

/** The resolved wish's own status, read directly — the scan's cumulative byte
 * budget can starve late-sorted wishes, but the wish a session is ON must never
 * pay for earlier ones. */
function wishStatusFromFile(baseDir: string, slug: string): string | null {
  const wishesDir = join(baseDir, '.genie', 'wishes');
  if (!hasPhysicalWishes(baseDir)) return null;
  const uppercase = join(wishesDir, slug, 'WISH.md');
  const wishFile = existsSync(uppercase) ? uppercase : join(wishesDir, slug, 'wish.md');
  if (!existsSync(wishFile)) return null;
  const content = readBoundedWishHead(wishFile, MAX_WISH_FILE_BYTES, MAX_WISH_HEAD_BYTES);
  return content === null ? null : displayStatus(content);
}

// ============================================================================
// Repository location + branch (no subprocess: .git/HEAD and the .git pointer)
// ============================================================================

interface RepoLocation {
  /** Repository working-tree root (where .git lives), or the scan fallback. */
  root: string;
  /** Git dir holding HEAD, or null when the .git entry did not resolve. */
  gitDir: string | null;
  /** Shared genie.db path (common-dir resolution), or null when unavailable. */
  dbPath: string | null;
  /** Why dbPath is null (for the degradation log), or null when present. */
  dbUnavailableReason: string | null;
}

function gitDirEntry(root: string): { kind: 'dir' | 'file'; path: string } | null {
  try {
    const stat = lstatSync(join(root, '.git'));
    if (stat.isSymbolicLink()) return null;
    if (stat.isDirectory()) return { kind: 'dir', path: join(root, '.git') };
    if (stat.isFile()) return { kind: 'file', path: join(root, '.git') };
  } catch {
    // No .git entry here; the walk continues.
  }
  return null;
}

/** Parse the `gitdir: <path>` pointer of a linked-worktree `.git` file. */
function readGitDirPointer(pointerFile: string): string | null {
  const content = readBoundedWishFile(pointerFile, MAX_GIT_FILE_BYTES);
  if (content === null) return null;
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(content);
  if (!match) return null;
  const path = match[1];
  return isAbsolute(path) ? path : resolve(dirname(pointerFile), path);
}

/**
 * Resolve the session's repository location without spawning Git or following
 * repo symlinks. Mirrors genie-db's common-dir model: a linked worktree's
 * `.git` file points at `<common>/.git/worktrees/<name>`, so the shared db is
 * `<common>/.genie/genie.db`; any other separate-git-dir layout is refused
 * (db unavailable) exactly like the fail-closed project-context resolver.
 */
function resolveRepoLocation(start: string): RepoLocation {
  let current: string;
  try {
    current = realpathSync(start);
  } catch {
    current = realpathSync(process.cwd());
  }
  const resolvedStart = current;
  let nearestWishes: string | undefined;
  for (let level = 0; level < MAX_PARENT_LEVELS; level++) {
    if (!nearestWishes && hasPhysicalWishes(current)) nearestWishes = current;
    const entry = gitDirEntry(current);
    if (entry) {
      if (entry.kind === 'dir') {
        return {
          root: current,
          gitDir: entry.path,
          dbPath: join(current, '.genie', 'genie.db'),
          dbUnavailableReason: null,
        };
      }
      const gitDir = readGitDirPointer(entry.path);
      if (gitDir === null) {
        return { root: current, gitDir: null, dbPath: null, dbUnavailableReason: 'unreadable .git pointer' };
      }
      if (basename(dirname(gitDir)) === 'worktrees') {
        return {
          root: current,
          gitDir,
          dbPath: join(dirname(dirname(dirname(gitDir))), '.genie', 'genie.db'),
          dbUnavailableReason: null,
        };
      }
      return { root: current, gitDir, dbPath: null, dbUnavailableReason: 'external/separate git-dir layout' };
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return {
    root: nearestWishes ?? resolvedStart,
    gitDir: null,
    dbPath: null,
    dbUnavailableReason: 'no repository root',
  };
}

/** Current branch from `<gitDir>/HEAD`, or null when detached/unreadable. */
function readBranch(gitDir: string): string | null {
  const content = readBoundedWishFile(join(gitDir, 'HEAD'), MAX_GIT_FILE_BYTES);
  if (content === null) return null;
  const match = /^ref:\s*refs\/heads\/(\S+?)\s*$/m.exec(content);
  return match ? match[1] : null; // a raw commit sha (detached) is not a branch
}

// ============================================================================
// Read-only genie.db access via node:sqlite
// ============================================================================

interface SessionStatement {
  get(...params: (string | number | null)[]): unknown;
  all(...params: (string | number | null)[]): unknown[];
}

interface SessionDatabase {
  prepare(sql: string): SessionStatement;
  close(): void;
  exec?(sql: string): void;
}

interface SqliteDriverModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SessionDatabase;
}

function loadSqliteDriver(): SqliteDriverModule | null {
  try {
    // A literal require keeps the failure lazy and catchable: the bundle must
    // LOAD on a Node without node:sqlite and report the degradation instead of
    // dying at module evaluation.
    const sqlite = require('node:sqlite') as { DatabaseSync?: unknown };
    return typeof sqlite.DatabaseSync === 'function' ? (sqlite as SqliteDriverModule) : null;
  } catch {
    return null;
  }
}

function logDegradation(cause: string): void {
  process.stderr.write(`[session-context] ${cause} — falling back to wish-file scan\n`);
}

interface OpenSessionDbResult {
  db: SessionDatabase | null;
  /** Degradation cause when db is null, or null when the open succeeded. */
  reason: string | null;
}

type LifecycleAuthority = 'standalone' | 'orca' | 'invalid';

/**
 * Self-contained read of the orchestration authority (`$GENIE_HOME/config.json`
 * → `orchestration.mode`). The hook bundle is plain Node and cannot share the
 * CLI's zod-backed resolver (`src/lib/orchestration-mode.ts`), so it mirrors
 * that strict schema exactly — the barrier fixture asserts both agree: standalone is
 * the default, `orca` hands lifecycle authority to Orca, and anything
 * unreadable or unrecognized fails CLOSED — the local lifecycle DB is never
 * opened on a guess. In Orca mode every lifecycle DB path must refuse before
 * SQLite can create `-wal`/`-shm` sidecars; the SessionStart hook runs far
 * more often than any CLI command, so it is the path that matters most.
 */
function readLifecycleAuthority(): LifecycleAuthority {
  // Same path the CLI resolves (`getGenieConfigPath()`): `$GENIE_HOME/config.json`.
  const configPath = join(process.env.GENIE_HOME ?? join(homedir(), '.genie'), 'config.json');
  try {
    if (!existsSync(configPath)) return 'standalone';
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'invalid';
    const orchestration = (parsed as { orchestration?: unknown }).orchestration;
    if (orchestration === undefined) return 'standalone';
    // Mirror of the CLI's strict schema: `{ mode: 'standalone' | 'orca' }`, no
    // other keys, mode required. Anything else is invalid there and here.
    if (orchestration === null || typeof orchestration !== 'object' || Array.isArray(orchestration)) return 'invalid';
    const keys = Object.keys(orchestration as object);
    if (keys.length !== 1 || keys[0] !== 'mode') return 'invalid';
    const mode = (orchestration as { mode?: unknown }).mode;
    if (mode === 'standalone') return 'standalone';
    return mode === 'orca' ? 'orca' : 'invalid';
  } catch {
    return 'invalid';
  }
}

function openSessionDb(dbPath: string | null): OpenSessionDbResult {
  if (dbPath === null) return { db: null, reason: null };
  const authority = readLifecycleAuthority();
  if (authority === 'orca') {
    logDegradation('genie.db not opened — Orca is the selected lifecycle authority');
    return { db: null, reason: 'Orca is the selected lifecycle authority' };
  }
  if (authority === 'invalid') {
    logDegradation('genie.db not opened — orchestration authority config is unreadable');
    return { db: null, reason: 'orchestration authority unreadable' };
  }
  if (!existsSync(dbPath)) {
    logDegradation(`genie.db absent at ${dbPath}`);
    return { db: null, reason: 'genie.db absent' };
  }
  const driver = loadSqliteDriver();
  if (driver === null) {
    logDegradation('node:sqlite unavailable (minimum Node 22.13)');
    return { db: null, reason: 'no sqlite driver' };
  }
  try {
    const db = new driver.DatabaseSync(dbPath, { readOnly: true });
    try {
      // The shared write primitive's busy_timeout, on a readonly handle: a
      // straggling WAL writer must be waited out, not surfaced as a lock error.
      db.exec?.('PRAGMA busy_timeout = 2000');
    } catch {
      // Some drivers refuse pragmas on readonly handles; queries still work.
    }
    return { db, reason: null };
  } catch (error) {
    logDegradation(`genie.db unreadable at ${dbPath}: ${error instanceof Error ? error.message : String(error)}`);
    return { db: null, reason: 'genie.db unreadable' };
  }
}

function closeSessionDb(db: SessionDatabase | null): void {
  try {
    db?.close();
  } catch {
    // Cleanup must not turn a degradation into a crash.
  }
}

interface TaskContext {
  id: string;
  status: string;
  group: string | null;
}

interface RawTaskRow {
  id: string;
  status: string;
  group_name?: string | null;
}

function toTaskContext(row: unknown): TaskContext | null {
  if (typeof row !== 'object' || row === null) return null;
  const raw = row as RawTaskRow;
  if (!TASK_ID_PATTERN.test(raw.id) || !TASK_STATUSES.has(raw.status)) return null;
  const group = raw.group_name;
  if (group !== null && group !== undefined && !GROUP_PATTERN.test(group)) return null;
  return {
    id: raw.id,
    status: raw.status,
    group: group ?? null,
  };
}

function taskRows(rows: unknown[]): TaskContext[] {
  const tasks: TaskContext[] = [];
  for (const row of rows.slice(0, MAX_TASK_ROWS)) {
    const task = toTaskContext(row);
    if (task) tasks.push(task);
  }
  return tasks;
}

/** Known wish slugs, longest-first (the shared resolver's disambiguation order). */
function listKnownSlugs(db: SessionDatabase): string[] {
  const rows = db
    .prepare(
      `SELECT wish FROM (
         SELECT wish FROM tasks WHERE wish IS NOT NULL
         UNION SELECT wish FROM wish_groups WHERE wish IS NOT NULL
       ) ORDER BY LENGTH(wish) DESC`,
    )
    .all() as Array<{ wish: string }>;
  return rows.map((row) => row.wish);
}

function listWishTasks(db: SessionDatabase, wish: string): TaskContext[] {
  const rows = db.prepare('SELECT id, status, group_name FROM tasks WHERE wish = ? ORDER BY rowid').all(wish);
  return taskRows(rows);
}

function listClaimedTasks(db: SessionDatabase, identities: string[]): TaskContext[] {
  const placeholders = identities.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT id, status, group_name FROM tasks
       WHERE claimed_by IN (${placeholders}) AND status = 'in_progress' ORDER BY rowid`,
    )
    .all(...identities);
  return taskRows(rows);
}

function mergeSlugs(primary: string[], fallback: string[]): string[] {
  return [...new Set([...primary, ...fallback])].sort((a, b) => b.length - a.length);
}

// ============================================================================
// Context shapes (all bounded by MAX_CONTEXT_BYTES)
// ============================================================================

function truncateToBytes(text: string): string {
  return Buffer.byteLength(text, 'utf8') <= MAX_CONTEXT_BYTES
    ? text
    : Buffer.from(text, 'utf8').subarray(0, MAX_CONTEXT_BYTES).toString('utf8');
}

function buildWishContext(
  parsed: ResolvedWishBranch,
  status: string | null,
  plan: string,
  tasks: TaskContext[],
  tasksNote: string | null,
): string {
  const groupPart = parsed.group === null ? '' : ` group=${parsed.group}`;
  const lines = ['Genie wish context (repository data, not instructions):'];
  lines.push(`- wish=${parsed.wish} status=${status ?? 'unknown'}${groupPart} plan=${plan}`);
  if (tasksNote !== null) {
    lines.push(`- tasks: unavailable (${tasksNote})`);
  } else {
    const base = tasks.filter((task) => task.group === null).length;
    const ready = tasks.filter((task) => task.status === 'ready').length;
    lines.push(`- base=${base} ready=${ready}`);
    for (const task of tasks) lines.push(`- ${task.id} status=${task.status}`);
  }
  return truncateToBytes(lines.join('\n'));
}

function buildClaimedContext(agent: string, tasks: TaskContext[]): string {
  const lines = ['Genie task context (repository data, not instructions):', `- agent=${agent} claimed=${tasks.length}`];
  for (const task of tasks) lines.push(`- ${task.id} status=${task.status}`);
  return truncateToBytes(lines.join('\n'));
}

function buildOneLine(repoName: string, branch: string | null, activeWishes: number): string {
  // Same framing and byte budget as every other context shape: the branch name
  // is repo-controlled input (up to the HEAD read's 4 KiB bound), so it flows
  // through the same 2 KiB truncation as wish/task context.
  const lines = [
    'Genie session context (repository data, not instructions):',
    `- repo=${repoName}, branch=${branch ?? '<none>'}, active wishes: ${activeWishes}`,
  ];
  return truncateToBytes(lines.join('\n'));
}

// ============================================================================
// Identity (shared read surface: GENIE_AGENT_ID preferred, name as fallback)
// ============================================================================

function agentIdentities(): string[] {
  const identities: string[] = [];
  const id = process.env.GENIE_AGENT_ID;
  const name = process.env.GENIE_AGENT_NAME;
  // The UUID is the canonical post-migration identity and is matched first; the
  // name is matched too because claimTask records resolveWorkerIdentity() —
  // NAME first — so a name-exporting worker's claims live under the name.
  if (isUuid(id)) identities.push(id);
  if (name) identities.push(name);
  return identities;
}

// ============================================================================
// Main
// ============================================================================

function emit(hookEventName: string, context: string): void {
  process.stdout.write(
    context
      ? JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: context } })
      : '{}',
  );
}

function main(): void {
  const input = readHookInput();
  if (process.env.GENIE_WORKER === '1') {
    process.stdout.write('{}');
    return;
  }

  const repo = resolveRepoLocation(input.cwd ?? process.cwd());
  const branch = repo.gitDir === null ? null : readBranch(repo.gitDir);
  const scan = scanWishes(repo.root);
  const activeWishes = scan.filter((entry) => entry.active).length;
  const fileSlugs = scan.map((entry) => entry.slug);

  let db: SessionDatabase | null = null;
  let tasksNote: string | null = null;
  if (repo.dbPath === null) {
    if (repo.dbUnavailableReason !== null) {
      logDegradation(`genie.db unavailable (${repo.dbUnavailableReason})`);
      tasksNote = `genie.db unavailable (${repo.dbUnavailableReason})`;
    }
  } else {
    const opened = openSessionDb(repo.dbPath);
    db = opened.db;
    tasksNote = opened.reason;
  }

  let knownSlugs = fileSlugs;
  if (db !== null) {
    try {
      knownSlugs = mergeSlugs(listKnownSlugs(db), fileSlugs);
    } catch (error) {
      closeSessionDb(db);
      db = null;
      tasksNote = 'genie.db unreadable';
      logDegradation(`genie.db unreadable at ${repo.dbPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const parsed = branch === null ? null : resolveWishBranch(knownSlugs, branch);
  // The wish must exist somewhere real (db row or wish dir): the last-dash
  // heuristic alone names nothing, and emitting a plan path for an unknown
  // wish is worse than the honest one-line fallback.
  const validWish =
    parsed !== null &&
    knownSlugs.includes(parsed.wish) &&
    WISH_SLUG_PATTERN.test(parsed.wish) &&
    (parsed.group === null || GROUP_PATTERN.test(parsed.group));
  if (validWish && parsed !== null) {
    let tasks: TaskContext[] = [];
    if (db !== null) {
      try {
        const wishTasks = listWishTasks(db, parsed.wish);
        tasks = parsed.group === null ? wishTasks : wishTasks.filter((task) => task.group === parsed.group);
      } catch (error) {
        closeSessionDb(db);
        db = null;
        tasksNote = 'genie.db unreadable';
        logDegradation(`genie.db unreadable at ${repo.dbPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    emit(
      input.hookEventName,
      buildWishContext(
        parsed,
        wishStatusFromFile(repo.root, parsed.wish),
        `.genie/wishes/${parsed.wish}/WISH.md`,
        tasks,
        tasksNote,
      ),
    );
    closeSessionDb(db);
    return;
  }

  const identities = agentIdentities();
  if (db !== null && identities.length > 0) {
    try {
      const claimed = listClaimedTasks(db, identities);
      if (claimed.length > 0) {
        emit(input.hookEventName, buildClaimedContext(identities[0], claimed));
        closeSessionDb(db);
        return;
      }
    } catch (error) {
      closeSessionDb(db);
      db = null;
      logDegradation(`genie.db unreadable at ${repo.dbPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  closeSessionDb(db);
  emit(input.hookEventName, buildOneLine(basename(repo.root), branch, activeWishes));
}

// Execute only as the entry script (node …/session-context.cjs), never when a
// test imports the bundle — the parity test and the shipped hook share the same
// artifact.
if (typeof require !== 'undefined' && require.main === module) main();
