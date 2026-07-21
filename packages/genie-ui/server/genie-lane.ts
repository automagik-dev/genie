// genie-lane.ts — the genie lane: wishes menu + hire roster + worktree binding.
//
// This module is the G2 seam that turns the fleet floor into a wish-organized cockpit:
// the left menu lists genie WISHES (git-tracked `.genie/wishes/<slug>/WISH.md`), each
// wish opens its board/task STATE (read from `.genie/genie.db`), hiring a fleet member is
// a roster entry ONLY (no process, no db write), and `worktreeFor` binds that entry to the
// per-group worktree `genie launch` already mints — reusing, never minting.
//
// RUNTIME SPLIT (the load-bearing design call — see README "Runtime split").  The server
// process runs under **node** (bun's `node-pty onData` is dead), where `bun:sqlite` does
// not exist; but this module's colocated tests run under **bun**, where `node:sqlite` does
// not exist ("No such built-in module: node:sqlite"). Neither engine is importable in the
// other runtime, so a single static `import` cannot serve both. The read path therefore
// selects the sqlite module at CALL time — `node:sqlite` (readOnly) under the node server,
// `bun:sqlite` (readonly) under `bun test` — using only the `.prepare(sql).get()/.all()`
// surface both engines expose identically. This is a READ replica (SELECT-only), never a
// second write path into genie.db (the `genie mcp` precedent); it degrades to empty when
// `.genie/genie.db` is absent. The shared DB is resolved across worktrees via
// `git rev-parse --git-common-dir` (mirrors `genie-db.resolveRepoRoot`). No PTY, no ACP.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

// ============================================================================
// Public types
// ============================================================================

/** The real harnesses a fleet member can run (drives G3's capability table). */
export type Harness = 'claude' | 'codex' | 'hermes' | 'rlmx';

/** A wish as surfaced in the left menu — git-tracked markdown plus its Status field. */
export interface WishSummary {
  /** Directory name under `.genie/wishes`; the launch/branch slug. */
  slug: string;
  /** First `# ` heading, else the slug. */
  title: string;
  /** `| **Status** | … |` metadata value, or '' when the field is absent. */
  status: string;
  /** Absolute path to the wish's `WISH.md`. */
  path: string;
}

/** One wish-group's state row (from `wish_groups`), degrade-to-empty when the DB is absent. */
export interface WishGroupState {
  wish: string;
  name: string;
  status: string;
  assignee: string | null;
}

/** One task row for a wish (from `tasks`), the finer-grained state under a group. */
export interface WishTaskState {
  id: string;
  title: string;
  status: string;
  group: string | null;
}

/** The worktree-bound context selecting a wish opens: its markdown summary + live state. */
export interface WishContext {
  wish: WishSummary | null;
  groups: WishGroupState[];
  tasks: WishTaskState[];
}

/** A fleet member available to hire onto a wish (the roster input). */
export interface FleetMember {
  /** Stable id, reused as the transport channel key (e.g. `fable`, `codex`, `hermes-review`). */
  id: string;
  /** Which real harness this member runs. */
  harness: Harness;
  /** Human label; defaults to `id`. */
  name?: string;
  /**
   * The wish-group this member is hired onto. It selects the `genie launch` per-group
   * worktree the member's faces reuse — a member is bound to a group, not a bare wish.
   */
  group: string;
}

/** A hire: a fleet member bound to a wish's group. A roster entry ONLY — no live process. */
export interface RosterEntry {
  wishSlug: string;
  memberId: string;
  harness: Harness;
  name: string;
  /** The ready group whose `genie launch` worktree this entry reuses. */
  group: string;
  hiredAt: number;
}

/** Injectable resolution for the lane; tests point `root` at a fixture `.genie`. */
export interface LaneOptions {
  /** Repo root owning `.genie`. Defaults to the git-common-dir parent of `cwd`. */
  root?: string;
  /** Working dir for git resolution. Defaults to `process.cwd()`. */
  cwd?: string;
}

/** Injectable resolution for {@link worktreeFor}; mirrors `launch.ts` worktree inputs. */
export interface WorktreeOptions extends LaneOptions {
  /** Base dir worktrees live under; mirrors `launch.ts` `resolveWorktreesBase`. */
  worktreesDir?: string;
  /** Probe deciding whether a group worktree has been launched. Injectable for tests. */
  isLaunched?: (worktreePath: string) => boolean;
}

// ============================================================================
// Repo / DB path resolution (worktree-aware, mirrors genie-db.resolveRepoRoot)
// ============================================================================

/** Canonicalize macOS `/private`-prefixed paths so worktrees resolve identically. */
function normalizeGitPath(path: string): string {
  if (process.platform !== 'darwin') return path;
  if (!path.startsWith('/private/')) return path;
  const logical = path.slice('/private'.length);
  return existsSync(logical) ? logical : path;
}

/**
 * Resolve the repo root that owns the shared `.genie/`. `git rev-parse
 * --git-common-dir`'s parent is the MAIN repo root even from a linked worktree, so every
 * worktree resolves to one genie.db (the CLAUDE.md contract). Falls back to `cwd` outside
 * a git repo.
 */
export function resolveGenieRoot(cwd: string = process.cwd()): string {
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    }).trim();
    return normalizeGitPath(dirname(commonDir));
  } catch {
    return normalizeGitPath(cwd);
  }
}

function resolveRoot(opts: LaneOptions): string {
  return opts.root ?? resolveGenieRoot(opts.cwd);
}

// ============================================================================
// Read-only DB reader (runtime-adaptive: node:sqlite | bun:sqlite)
// ============================================================================

/** The minimal prepared-statement surface both bun:sqlite and node:sqlite expose. */
interface RoStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
/** The minimal read-only DB surface both engines expose (prepare + close). */
interface RoDatabase {
  prepare(sql: string): RoStatement;
  close(): void;
}

/** True when running under bun (bun:sqlite present); false under node (node:sqlite). */
function runningUnderBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
}

/**
 * Open `.genie/genie.db` READ-ONLY, or return null when it is absent or cannot be opened
 * (degrade-to-empty — the `genie mcp` precedent). Picks the sqlite engine at call time so
 * the same module works under the node server (`node:sqlite`, `readOnly`) and under
 * `bun test` (`bun:sqlite`, `readonly`); both are opened read-only and neither can write.
 */
function openReadOnlyDb(dbPath: string): RoDatabase | null {
  if (!existsSync(dbPath)) return null;
  try {
    if (runningUnderBun()) {
      const { Database } = require('bun:sqlite') as {
        Database: new (p: string, o: { readonly: boolean }) => RoDatabase;
      };
      return new Database(dbPath, { readonly: true });
    }
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (p: string, o: { readOnly: boolean }) => RoDatabase;
    };
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

function dbPathFor(root: string): string {
  return join(root, '.genie', 'genie.db');
}

// ============================================================================
// listWishes / wishContext — the left menu + its worktree-bound state
// ============================================================================

/** Extract a `| **Field** | value |` metadata-table value (mirrors wishes-lint). */
function metadataValue(text: string, field: string): string {
  const pattern = new RegExp(`^\\|\\s*\\*\\*${field}\\*\\*\\s*\\|\\s*(.*?)\\s*\\|\\s*$`, 'im');
  return pattern.exec(text)?.[1]?.trim() ?? '';
}

/** First `# ` heading of a WISH.md, else '' . */
function firstHeading(text: string): string {
  return /^#\s+(.+?)\s*$/m.exec(text)?.[1]?.trim() ?? '';
}

function parseWish(slug: string, wishMd: string): WishSummary {
  const text = readFileSync(wishMd, 'utf8');
  return { slug, title: firstHeading(text) || slug, status: metadataValue(text, 'Status'), path: wishMd };
}

/**
 * List genie wishes for the left menu, read from git-tracked `.genie/wishes/<slug>/WISH.md`
 * markdown. Sorted by slug; degrades to `[]` when `.genie/wishes` is absent.
 */
export function listWishes(opts: LaneOptions = {}): WishSummary[] {
  const wishesDir = join(resolveRoot(opts), '.genie', 'wishes');
  if (!existsSync(wishesDir)) return [];
  const out: WishSummary[] = [];
  for (const entry of readdirSync(wishesDir)) {
    const dir = join(wishesDir, entry);
    const wishMd = join(dir, 'WISH.md');
    if (!statSync(dir).isDirectory() || !existsSync(wishMd)) continue;
    out.push(parseWish(entry, wishMd));
  }
  return out.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

function readWishGroups(db: RoDatabase, slug: string): WishGroupState[] {
  const rows = db
    .prepare('SELECT wish, name, status, assignee FROM wish_groups WHERE wish = ? ORDER BY name')
    .all(slug) as Array<{ wish: string; name: string; status: string; assignee: string | null }>;
  return rows.map((r) => ({ wish: r.wish, name: r.name, status: r.status, assignee: r.assignee ?? null }));
}

function readWishTasks(db: RoDatabase, slug: string): WishTaskState[] {
  const rows = db
    .prepare('SELECT id, title, status, group_name FROM tasks WHERE wish = ? ORDER BY created_at')
    .all(slug) as Array<{ id: string; title: string; status: string; group_name: string | null }>;
  return rows.map((r) => ({ id: r.id, title: r.title, status: r.status, group: r.group_name ?? null }));
}

/**
 * Open a wish's worktree-bound context: its markdown summary plus board/task state read
 * READ-ONLY from `.genie/genie.db`. Groups + tasks are `[]` when the DB is absent
 * (degrade-to-empty); `wish` is null when no matching `WISH.md` exists.
 */
export function wishContext(slug: string, opts: LaneOptions = {}): WishContext {
  const root = resolveRoot(opts);
  const wish = listWishes({ root }).find((w) => w.slug === slug) ?? null;
  const db = openReadOnlyDb(dbPathFor(root));
  try {
    return {
      wish,
      groups: db ? readWishGroups(db, slug) : [],
      tasks: db ? readWishTasks(db, slug) : [],
    };
  } finally {
    db?.close();
  }
}

// ============================================================================
// hire — a roster entry ONLY (no live process, no db write)
// ============================================================================

/**
 * Hire a fleet member onto a wish. Pure: builds and returns a {@link RosterEntry} — it
 * spawns NO process (PTY faces spawn lazily on tab-open, ACP faces on first @-mention) and
 * writes NOTHING to genie.db. The caller (server/client) owns the roster collection.
 */
export function hire(wishSlug: string, member: FleetMember): RosterEntry {
  return {
    wishSlug,
    memberId: member.id,
    harness: member.harness,
    name: member.name ?? member.id,
    group: member.group,
    hiredAt: Date.now(),
  };
}

// ============================================================================
// worktreeFor — reuse genie launch's per-group worktree, NEVER mint one
// ============================================================================

/** Reduce a string to a filesystem-/branch-safe component (verbatim from `launch.ts`). */
function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-');
}

/** Base dir for worktrees: explicit override, else `<GENIE_HOME>/worktrees` (mirrors `launch.ts`). */
function resolveWorktreesBase(opts: WorktreeOptions): string {
  if (opts.worktreesDir) return opts.worktreesDir;
  if (process.env.GENIE_WORKTREES_DIR) return process.env.GENIE_WORKTREES_DIR;
  const genieHome = process.env.GENIE_HOME ?? join(homedir(), '.genie');
  return join(genieHome, 'worktrees');
}

/**
 * The deterministic worktree path `genie launch` would create for a roster entry:
 * `<worktreesBase>/<repo>-<slug>-<group>` (verbatim from `launch.ts buildLaunchPlan`).
 * Pure — computes the path, touches nothing.
 */
export function groupWorktreePath(entry: RosterEntry, opts: WorktreeOptions = {}): string {
  const repoBase = basename(resolveRoot(opts));
  const worktreesBase = resolveWorktreesBase(opts);
  return join(worktreesBase, sanitize(`${repoBase}-${entry.wishSlug}-${entry.group}`));
}

/** The branch `genie launch` uses for a roster entry's group worktree. */
export function branchFor(entry: RosterEntry): string {
  return `wish/${entry.wishSlug}-${entry.group}`;
}

/**
 * True when a path is an already-launched linked worktree: it exists AND carries the
 * `.git` file every `git worktree add` writes. A bare `mkdir` has no `.git`, so this never
 * mistakes a stray directory for a launched worktree — and never runs `git` itself.
 */
function defaultIsLaunched(worktreePath: string): boolean {
  return existsSync(worktreePath) && existsSync(join(worktreePath, '.git'));
}

/**
 * Resolve a roster entry to the `genie launch` per-group worktree it REUSES, or null when
 * that group has not been launched yet (unbound). It NEVER mints a worktree — binding is
 * `genie launch`'s job; this only reports the path once it exists. The two faces of an
 * agent (terminal + read-only chat) both `cd` into this one worktree (the coherence
 * contract); the shared `.genie` git artifacts are what make the wish's chat wish-scoped
 * across differently-bound agents.
 */
export function worktreeFor(entry: RosterEntry, opts: WorktreeOptions = {}): string | null {
  const worktree = groupWorktreePath(entry, opts);
  const isLaunched = opts.isLaunched ?? defaultIsLaunched;
  return isLaunched(worktree) ? worktree : null;
}
