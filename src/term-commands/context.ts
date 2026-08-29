/**
 * genie context — the single spawn-context contract point.
 *
 * Resolves what a spawn must be based on and prints it as ONE line of
 * versioned JSON on stdout — nothing else. remotty's spawn consumes exactly
 * this output:
 *
 *   genie context --wish <slug> --group <g>   wish-scoped (first non-plan resolution records the base)
 *   genie context --wish <slug>               wish branch + all its ready tasks
 *   genie context [--wish ...] --plan         same payload, strictly read-only (writes nothing)
 *   genie context                             wishless: integration branch + SHA (no state at all)
 *
 * Payload (version 1), one line (fields in this exact order):
 *   wish + group: {"version":1,"wish":"<slug>","branch":"wish/<slug>-<g>","base":"<40-hex>","tasks":[{"id":"...","title":"..."}],"group":"<g>"}
 *   wish only:    {"version":1,"wish":"<slug>","branch":"wish/<slug>","base":"<40-hex>","tasks":[...]}
 *   wishless:     {"version":1,"branch":"<integration-name>","base":"<40-hex>","tasks":[]}
 *
 * `base` is always a full 40-hex commit SHA (`^{commit}`-verified) — no raw
 * ref crosses the boundary. `base` is the ONLY thing a consumer may build a
 * worktree from; `branch` merely NAMES the integration line (wishless form:
 * the logical local branch name — the remote prefix of the fallback path is
 * stripped, e.g. `main`, never `origin/main`). The composed
 * `wish/<slug>-<group>` branch is opaque to consumers — the slug/group
 * boundary is unrecoverable from it (slugs may contain `-`).
 *
 * Every degradation exits non-zero with a machine-readable JSON line on
 * stderr: {"error":"<code>","reason":"<text>"}. An empty `tasks` array is
 * NOT a degradation: whenever branch+base resolve, the payload is emitted
 * with exit 0 — a group with no ready tasks (all claimed/done, or task rows
 * missing) still gets its base, so a resumed or re-spawned session never
 * degrades to a missing worktree base.
 *
 * Injection hardening: the wish slug and group name are validated by genie
 * (the sole validator) against the launch charset plus everything `git
 * check-ref-format` rejects in the composed ref — no leading `-` (git-option
 * hazard) or `.`, no trailing `.`, no `..`, no `.lock` suffix. Names are only
 * ever woven into the composed `wish/...` branch NAME and JSON-escaped in the
 * output — nothing user-supplied is ever passed to git or a shell. The
 * recorded base is re-verified with the same `^{commit}` peel before it is
 * returned.
 *
 * Recorded base state (one `meta` row `wish_base:<slug>` per wish, see
 * src/lib/v5/base-state.ts): the wish skill writes it at plan time (on
 * APPROVED); a legacy wish's first non-`--plan` resolution records it
 * (no base → resolve+record+return); later calls return the recorded SHA;
 * `--re-resolve` refreshes it from the integration branch. `--plan` never
 * writes — not the record, not the DB, not a file. Carve-out: on SQLite
 * builds that reject the immutable URI filename (observed: bun's Linux
 * binary), the `--plan` read-only open falls back to a plain readonly
 * connection and SQLite's own VFS may recreate its `-shm`/`-wal` sidecar
 * files; genie itself never writes through it (see
 * {@link openReadonlyHandle}).
 */

import { Database } from 'bun:sqlite';
import { existsSync, statSync } from 'node:fs';
import type { Command } from 'commander';
import { resolveGitWorktreeRoot } from '../lib/codex-project-mcp.js';
import { assertLocalLifecycleEnabled } from '../lib/orchestration-mode.js';
import {
  type IntegrationBranch,
  peelCommit,
  readWishBase,
  resolveIntegration,
  writeWishBase,
} from '../lib/v5/base-state.js';
import { isReadableGenieDb, openDb, resolveDbPath } from '../lib/v5/genie-db.js';
import { BUSY_TIMEOUT_MS } from '../lib/v5/sqlite-open.js';
import { listTasks } from '../lib/v5/task-state.js';

// ============================================================================
// Contract surface
// ============================================================================

/** The payload schema version. Consumers must check this before parsing fields. */
export const CONTEXT_VERSION = 1;

/**
 * Allowed charset for the wish slug and group name, which are woven into the
 * composed `wish/<slug>-<group>` branch name in the payload. Genie is the sole
 * validator of this charset (the spawn side consumes the names opaque). The
 * FIRST character may not be `-` (a git-option hazard for any consumer that
 * ever passes it through) or `.` (hidden-path hazard), matching the wish
 * skill's own scaffold gate.
 */
export const NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/**
 * True when `value` is a safe wish slug / group name: the {@link NAME_PATTERN}
 * charset PLUS everything `git check-ref-format` rejects in the composed ref —
 * no `..` anywhere, no trailing `.`, and no `.lock` suffix (case-insensitive,
 * matching modern git).
 */
export function isSafeName(value: string): boolean {
  return NAME_PATTERN.test(value) && !value.includes('..') && !value.endsWith('.') && !/\.lock$/i.test(value);
}

/** One ready task in the payload — id for `genie task checkout`, title for the kickoff prompt. */
export interface ContextTask {
  id: string;
  title: string;
}

/** The versioned payload printed on success. */
export interface ContextPayload {
  version: typeof CONTEXT_VERSION;
  /** Wish slug — present only in the wish-scoped form. */
  wish?: string;
  /** Group name — present only when `--group` was given. */
  group?: string;
  /**
   * Branch the spawn should live on: the composed `wish/<slug>-<group>` /
   * recorded wish branch (wish form) or the integration branch name (wishless).
   */
  branch: string;
  /** Full 40-hex commit SHA the branch is based on — the only value that crosses the boundary. */
  base: string;
  /** Ready tasks of the group (or of the whole wish without `--group`). Always `[]` wishless. */
  tasks: ContextTask[];
}

export interface ContextOptions {
  wish?: string;
  group?: string;
  plan?: boolean;
  reResolve?: boolean;
}

/** Test seam: cwd, DB path, clock, and the two output sinks. */
export interface ContextDeps {
  cwd?: string;
  dbPath?: string;
  now?: () => number;
  write?: (line: string) => void;
  writeErr?: (line: string) => void;
}

/** Every degradation carries a stable machine-readable code. */
export class ContextError extends Error {
  readonly code: string;
  constructor(code: string, reason: string) {
    super(reason);
    this.name = 'ContextError';
    this.code = code;
  }
}

function failClosed(code: string, reason: string): never {
  throw new ContextError(code, reason);
}

// ============================================================================
// DB open (writes only when NOT --plan; --plan opens read-only or not at all)
// ============================================================================

/**
 * Open a read-only handle for an existing DB file, or null when the open
 * itself fails (absent file, transient lock, malformed header). Never creates
 * and never writes — the only open `--plan` may perform.
 *
 * Preferred: SQLite immutable semantics (`file:…?immutable=1`) when no
 * uncheckpointed WAL frames exist (no `-wal`, or a 0-byte one — the normal
 * state right after any writer closed). It creates NO `-shm`/`-wal` sidecars
 * and works on read-only mounts. Two fallbacks, both documented contract
 * carve-outs rather than silent behavior:
 *   - a non-empty `-wal` (a concurrent or crashed writer left frames): a
 *     plain readonly open so reads see the WAL; the writer already created
 *     the sidecars, so nothing new appears;
 *   - a SQLite build that rejects the URI filename form (observed: bun's
 *     Linux binary) makes the immutable open throw: fall back to the same
 *     plain readonly open — consistent reads, and SQLite's own VFS may
 *     recreate its `-shm`/`-wal` sidecars. Genie itself never writes the
 *     database, never adds a row, and never creates any other file.
 * The immutable read is as-of the last checkpoint; a writer that starts in
 * the tiny stat→open window can leave a fresh preview slightly stale, never
 * wrong about the resolved base policy.
 */
export function openReadonlyHandle(dbPath: string): Database | null {
  assertLocalLifecycleEnabled();
  try {
    let walBytes = 0;
    try {
      walBytes = statSync(`${dbPath}-wal`).size;
    } catch {
      walBytes = 0;
    }
    if (walBytes > 0) return openPlainReadonly(dbPath);
    try {
      return new Database(`file:${dbPath}?immutable=1`, { readonly: true });
    } catch {
      return openPlainReadonly(dbPath);
    }
  } catch {
    return null;
  }
}

/** Plain readonly open with the shared busy_timeout. Null on any failure. */
function openPlainReadonly(dbPath: string): Database | null {
  try {
    const db = new Database(dbPath, { readonly: true });
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    return db;
  } catch {
    return null;
  }
}

/**
 * The DB handle for a wish-scoped resolution. Non-plan uses the standard
 * write-path open (which may create/backfill the DB — the record write is the
 * point); `--plan` opens the existing file read-only with zero sidecar
 * creation (validated shape, no heal — healing writes) or returns null when
 * the file is absent.
 */
function openWishDb(options: ContextOptions, deps: ContextDeps, cwd: string): Database | null {
  const dbPath = deps.dbPath ?? resolveDbPath(cwd);
  if (options.plan !== true) {
    try {
      return openDb({ path: dbPath });
    } catch (err) {
      failClosed(
        'unreadable-db',
        `Cannot open genie state DB at ${dbPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (!existsSync(dbPath)) return null;
  const db = openReadonlyHandle(dbPath);
  if (db === null)
    failClosed('unreadable-db', `Cannot open genie state DB read-only at ${dbPath} (locked or malformed).`);
  let readable = false;
  try {
    readable = isReadableGenieDb(db);
  } catch {
    readable = false;
  }
  if (!readable) {
    db.close();
    failClosed(
      'unreadable-db',
      `Genie state DB at ${dbPath} is not readable by this build; run any genie task command once to migrate it.`,
    );
  }
  return db;
}

// ============================================================================
// Base resolution (recorded base → integration policy → fail closed)
// ============================================================================

/** Resolve the root of the git worktree containing `cwd`, failing closed outside one. */
function requireRepoRoot(deps: ContextDeps): string {
  const root = resolveGitWorktreeRoot(deps.cwd ?? process.cwd());
  if (root === null) failClosed('not-a-git-repo', 'genie context must be run inside a git repository.');
  return root;
}

interface ResolvedBase {
  base: string;
  /** Wish branch the payload uses when no `--group` is given. */
  branch: string;
  /** True when the base was freshly resolved from the integration branch (record absent or --re-resolve). */
  fresh: boolean;
}

/**
 * The base a wish-scoped payload is cut from. A valid recorded base is
 * re-verified (never re-resolved) and returned unless `--re-resolve` asks for
 * a fresh one; the integration branch via the shared policy otherwise. The
 * caller persists a freshly resolved base on non-plan resolutions only.
 */
function resolveWishBase(
  root: string,
  db: Database | null,
  slug: string,
  reResolve: boolean | undefined,
): ResolvedBase {
  const record = db === null ? null : readWishBase(db, slug);
  if (record === 'corrupt' && reResolve !== true) {
    failClosed(
      'corrupt-base-record',
      `Recorded base for wish ${JSON.stringify(slug)} is malformed; re-run with --re-resolve to replace it.`,
    );
  }
  if (record !== null && record !== 'corrupt' && reResolve !== true) {
    if (peelCommit(root, record.base) === null) {
      failClosed(
        'recorded-base-missing',
        `Recorded base ${record.base} for wish ${JSON.stringify(slug)} no longer resolves in this repository; re-run with --re-resolve.`,
      );
    }
    return { base: record.base, branch: record.branch, fresh: false };
  }
  const integration = resolveIntegration(root);
  if (integration === null) {
    failClosed(
      'no-integration-branch',
      'No integration branch resolvable (create a local `dev` branch or set the remote default: `git remote set-head origin -a`).',
    );
  }
  const sha = peelCommit(root, integration.ref);
  if (sha === null) {
    failClosed(
      'unresolvable-base',
      `Integration branch ${integration.ref} does not resolve to a commit in this repository.`,
    );
  }
  return { base: sha, branch: `wish/${slug}`, fresh: true };
}

// ============================================================================
// Resolvers
// ============================================================================

/**
 * The branch name the wishless payload reports for an integration line. The
 * shared policy names a local `dev` branch `dev` but the remote-HEAD fallback
 * path as a remote-tracking name (`origin/main`); reporting THAT would let a
 * consumer pass it to `git worktree add -b` and silently create
 * `refs/heads/origin/main`. Strip the remote prefix so the payload names the
 * logical local branch (`main`). Display only — consumers must build
 * worktrees from `base`, never from this name.
 */
function integrationLineBranch(integration: IntegrationBranch): string {
  const slash = integration.name.indexOf('/');
  return slash === -1 ? integration.name : integration.name.slice(slash + 1);
}

/** Wishless form: integration branch name + its SHA. Reads git only — no DB open, no writes, ever. */
function resolveWishlessContext(deps: ContextDeps): ContextPayload {
  const root = requireRepoRoot(deps);
  const integration = resolveIntegration(root);
  if (integration === null) {
    failClosed(
      'no-integration-branch',
      'No integration branch resolvable (create a local `dev` branch or set the remote default: `git remote set-head origin -a`).',
    );
  }
  const sha = peelCommit(root, integration.ref);
  if (sha === null) {
    failClosed(
      'unresolvable-base',
      `Integration branch ${integration.ref} does not resolve to a commit in this repository.`,
    );
  }
  return { version: CONTEXT_VERSION, branch: integrationLineBranch(integration), base: sha, tasks: [] };
}

/** Wish-scoped form: recorded-or-resolved base, composed branch, and the ready tasks of the group/wish. */
function resolveWishContext(slug: string, options: ContextOptions, deps: ContextDeps): ContextPayload {
  if (!isSafeName(slug)) {
    failClosed(
      'invalid-wish-slug',
      `Invalid wish slug ${JSON.stringify(slug)}. Slugs must match ${NAME_PATTERN.source} with no '..', no leading '-' or '.', no trailing '.', and no '.lock' suffix.`,
    );
  }
  const group = options.group;
  if (group !== undefined && !isSafeName(group)) {
    failClosed(
      'invalid-group-name',
      `Invalid group name ${JSON.stringify(group)}. Group names must match ${NAME_PATTERN.source} with no '..', no leading '-' or '.', no trailing '.', and no '.lock' suffix.`,
    );
  }
  const cwd = deps.cwd ?? process.cwd();
  const root = requireRepoRoot(deps);
  const db = openWishDb(options, deps, cwd);
  try {
    const resolved = resolveWishBase(root, db, slug, options.reResolve);
    // Persist a freshly resolved base on the first non-plan resolution only:
    // no base → resolve+record+return; recorded → return it (done above);
    // --re-resolve refreshes. --plan never writes.
    if (db !== null && options.plan !== true && resolved.fresh) {
      writeWishBase(db, slug, { branch: resolved.branch, base: resolved.base, recordedAt: (deps.now ?? Date.now)() });
    }
    // Tasks are advisory payload, never a gate: once branch+base resolve the
    // payload is emitted with exit 0 even when the ready set is empty (all
    // tasks claimed/done, task rows missing, or no genie.db at all) — a
    // resumed or re-spawned session must still receive its base.
    const ready = db === null ? [] : listTasks(db, { wish: slug, status: 'ready' });
    const tasks = ready
      .filter((task) => group === undefined || task.group === group)
      .map((task) => ({ id: task.id, title: task.title }));
    const payload: ContextPayload = {
      version: CONTEXT_VERSION,
      wish: slug,
      branch: group === undefined ? resolved.branch : `wish/${slug}-${group}`,
      base: resolved.base,
      tasks,
    };
    if (group !== undefined) payload.group = group;
    return payload;
  } finally {
    db?.close();
  }
}

// ============================================================================
// Command entry
// ============================================================================

/**
 * Run the context resolution and print the payload (stdout, one line, exit 0)
 * or the machine-readable failure (stderr, one JSON line, exit 1). Never
 * throws.
 */
export function contextCommand(options: ContextOptions, deps: ContextDeps = {}): number {
  const write = deps.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const writeErr = deps.writeErr ?? ((line: string) => process.stderr.write(`${line}\n`));
  try {
    if (options.group !== undefined && options.wish === undefined) {
      failClosed('group-requires-wish', '--group requires --wish.');
    }
    if (options.reResolve === true && options.wish === undefined) {
      failClosed('re-resolve-requires-wish', '--re-resolve requires --wish.');
    }
    const payload =
      options.wish === undefined ? resolveWishlessContext(deps) : resolveWishContext(options.wish, options, deps);
    write(JSON.stringify(payload));
    return 0;
  } catch (err) {
    const failure =
      err instanceof ContextError
        ? err
        : new ContextError('internal', err instanceof Error ? err.message : String(err));
    writeErr(JSON.stringify({ error: failure.code, reason: failure.message }));
    return 1;
  }
}

/** Register `genie context` on the CLI program. */
export function registerContextCommand(program: Command): void {
  program
    .command('context')
    .description('Resolve spawn context: wish/group branch + base SHA, or the integration branch (versioned JSON)')
    .option('--wish <slug>', 'Wish slug (charset-restricted); absent = wishless integration lookup')
    .option('--group <name>', 'Wish group (requires --wish)')
    .option('--plan', 'Print the payload strictly read-only — writes nothing, including the recorded base')
    .option('--re-resolve', 'Refresh the recorded base SHA instead of returning it (requires --wish)')
    .action((options: ContextOptions) => {
      process.exit(contextCommand(options));
    });
}
