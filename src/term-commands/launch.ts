/**
 * genie launch <slug> — one command from a wish slug to an opened Warp cockpit.
 *
 * Reads the ready tasks for a wish from the per-repo `.genie/genie.db`, groups
 * them by wish-group (null group ⇒ "main"), and turns each distinct group into
 * ONE Warp pane. Each group gets its own git worktree
 * (`<worktreesBase>/<repo>-<slug>-<group>/`, branch `wish/<slug>-<group>`),
 * a kickoff prompt written into that worktree, and a pane that runs
 * `claude "$(cat <prompt>)"`. The panes are emitted as a Warp Launch
 * Configuration (see {@link ./../lib/v5/warp-launch}) and opened best-effort.
 *
 * Emitting the config is the contract; opening is a convenience. A platform with
 * no known opener, or an opener that fails, still exits 0 after printing the
 * config path + URI.
 *
 * `--dry-run` computes the whole plan and prints it while touching nothing: no
 * worktrees, no prompt files, no config file.
 */

import type { Database } from 'bun:sqlite';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Command } from 'commander';
import { openDb } from '../lib/v5/genie-db.js';
import { type TaskRow, listTasks } from '../lib/v5/task-state.js';
import { type PaneSpec, buildLaunchConfigYaml, launchUri, writeLaunchConfig } from '../lib/v5/warp-launch.js';
import { genieHome } from '../lib/workspace.js';

// ============================================================================
// Typed errors
// ============================================================================

/** Base class for every failure raised while planning or launching a cockpit. */
export class LaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaunchError';
  }
}

/** The wish has no `ready` tasks, so there is nothing to launch. */
export class EmptyReadySetError extends LaunchError {
  readonly slug: string;
  constructor(slug: string) {
    super(`No ready tasks for wish "${slug}". Inspect the board with: genie board --wish ${slug}`);
    this.name = 'EmptyReadySetError';
    this.slug = slug;
  }
}

/**
 * Allowed charset for a group name once it becomes a filesystem/branch
 * component. Kept in sync with {@link sanitize} — every character it would
 * rewrite is rejected up front instead, so a validated name survives both the
 * worktree directory and the `wish/<slug>-<group>` branch ref unchanged.
 */
const GROUP_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Allowed charset for the wish slug, which is woven into the same worktree dirs
 * (`<repo>-<slug>-<group>`) and branch refs (`wish/<slug>-<group>`) as the group
 * name — so it carries the identical filesystem/branch-safety constraint.
 */
const SLUG_PATTERN = /^[A-Za-z0-9._-]+$/;

/** The wish slug is not a safe filesystem/branch component. */
export class InvalidSlugError extends LaunchError {
  readonly slug: string;
  constructor(slug: string) {
    super(
      `Invalid wish slug ${JSON.stringify(slug)}. ` +
        `Slugs must match ${SLUG_PATTERN.source} (letters, digits, '.', '_', '-').`,
    );
    this.name = 'InvalidSlugError';
    this.slug = slug;
  }
}

/** One or more selected group names are not safe filesystem/branch components. */
export class InvalidGroupNameError extends LaunchError {
  readonly names: string[];
  constructor(names: string[]) {
    super(
      `Invalid group name(s): ${names.map((n) => JSON.stringify(n)).join(', ')}. ` +
        `Group names must match ${GROUP_NAME_PATTERN.source} (letters, digits, '.', '_', '-').`,
    );
    this.name = 'InvalidGroupNameError';
    this.names = names;
  }
}

/** A path collides with the intended worktree location but is not a worktree of this repo. */
export class WorktreeCollisionError extends LaunchError {
  readonly path: string;
  constructor(path: string) {
    super(`Path ${JSON.stringify(path)} exists but is not a git worktree of this repo. Remove it and retry.`);
    this.name = 'WorktreeCollisionError';
    this.path = path;
  }
}

/** Creating a worktree flipped the parent repo into bare mode (historical corruption). */
export class BareRepoError extends LaunchError {
  readonly repoRoot: string;
  constructor(repoRoot: string) {
    super(
      `Aborting: repo at ${repoRoot} became bare (core.bare=true) after worktree creation. This corrupts the repo.`,
    );
    this.name = 'BareRepoError';
    this.repoRoot = repoRoot;
  }
}

// ============================================================================
// Plan types
// ============================================================================

/** One group's slice of the launch plan. */
export interface LaunchGroupPlan {
  /** Group name as stored (null group surfaces as "main"). */
  name: string;
  /** Absolute worktree path the pane opens in. */
  worktree: string;
  /** Branch created for the worktree (`wish/<slug>-<group>`). */
  branch: string;
  /** Absolute path the kickoff prompt is (or would be) written to. */
  promptPath: string;
  /** Kickoff prompt content handed to the pane's `claude` invocation. */
  prompt: string;
  /** Every ready task the group owns. */
  tasks: TaskRow[];
}

/** The full, side-effect-free plan a launch would execute. */
export interface LaunchPlan {
  slug: string;
  repoRoot: string;
  groups: LaunchGroupPlan[];
  panes: PaneSpec[];
  yaml: string;
}

// ============================================================================
// Injectable dependencies (defaults hit the real host; tests override)
// ============================================================================

export interface LaunchDeps {
  /** Working directory used to resolve the repo root + open the DB. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Base directory worktrees are created under. Defaults to `<GENIE_HOME>/worktrees`. */
  worktreesDir?: string;
  /** Pre-opened DB handle (tests inject an isolated one). Defaults to `openDb({cwd})`. */
  db?: Database;
  /** Platform used to pick the opener + Warp config dir. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Explicit Warp config output dir (tests). Defaults to the platform dir. */
  warpDir?: string;
  /** Opener used when `open` is enabled. Defaults to `open`/`xdg-open`. Returns success. */
  openImpl?: (uri: string, platform: NodeJS.Platform) => boolean;
  /** Stdout writer. Defaults to `process.stdout.write`. */
  write?: (line: string) => void;
}

export interface LaunchOptions {
  /** Compute + print the plan, touch nothing. */
  dryRun?: boolean;
  /** Open the emitted config in Warp. Defaults to true. */
  open?: boolean;
  /** Subset of group names to launch. Absent ⇒ all groups with ready tasks. */
  groups?: string[];
}

// ============================================================================
// Small helpers
// ============================================================================

/**
 * Reduce a string to a filesystem-/branch-safe slug component.
 *
 * Group names are validated against {@link GROUP_NAME_PATTERN} before this is
 * ever reached, so for the group portion this is a pass-through; it still
 * guards the repo basename + wish slug woven into the same path, which are not
 * separately validated here.
 */
function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-');
}

/**
 * Absolute repo root that owns the shared `.genie/` (git working-tree root).
 * Run outside a git repository, `git rev-parse` exits non-zero and `execFileSync`
 * throws a raw subprocess error; catch it and surface a typed, actionable
 * {@link LaunchError} instead of leaking the subprocess trace.
 */
function resolveRepoRoot(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    }).trim();
  } catch {
    throw new LaunchError('genie launch must be run inside a git repository.');
  }
}

/** Base dir for worktrees: explicit override, else `<GENIE_HOME>/worktrees`. */
function resolveWorktreesBase(deps: LaunchDeps): string {
  return deps.worktreesDir ?? process.env.GENIE_WORKTREES_DIR ?? join(genieHome(), 'worktrees');
}

/** Group ready tasks by group name (null ⇒ "main"), preserving first-seen order. */
function groupReadyTasks(tasks: TaskRow[]): Map<string, TaskRow[]> {
  const groups = new Map<string, TaskRow[]>();
  for (const task of tasks) {
    const name = task.group ?? 'main';
    const bucket = groups.get(name);
    if (bucket) bucket.push(task);
    else groups.set(name, [task]);
  }
  return groups;
}

/** Kickoff prompt for a group: wish + group, every ready task, per-task claim, WISH.md pointer. */
function buildPrompt(slug: string, group: string, tasks: TaskRow[]): string {
  const lines = [
    `Wish: ${slug}`,
    `Group: ${group}`,
    '',
    `You own group "${group}" of wish "${slug}". It has ${tasks.length} ready task(s).`,
    'Claim each task before you work it, then mark it done when complete:',
    '',
  ];
  for (const task of tasks) {
    lines.push(`- ${task.id}  ${task.title}`);
    lines.push(`    claim:  genie task checkout ${task.id} --worker ${group}`);
    lines.push(`    finish: genie task done ${task.id}`);
  }
  lines.push('');
  lines.push(`Full context for this group lives in: .genie/wishes/${slug}/WISH.md`);
  lines.push('');
  return lines.join('\n');
}

// ============================================================================
// Plan construction (no filesystem writes)
// ============================================================================

/**
 * Build the launch plan for `slug`: read ready tasks, group them, and compute
 * each group's worktree path, branch, prompt, and pane. Pure w.r.t. the
 * filesystem — reads the DB and git, writes nothing. `--dry-run` prints exactly
 * this.
 *
 * @throws {InvalidSlugError} if the wish slug is not a safe filesystem/branch
 *   component (validated first, before any DB read or git call).
 * @throws {EmptyReadySetError} if the wish has no ready tasks.
 * @throws {LaunchError} if `--groups` selects no ready group.
 * @throws {InvalidGroupNameError} if any selected group name is not a safe
 *   filesystem/branch component (validated before anything is created).
 */
export function buildLaunchPlan(db: Database, slug: string, deps: LaunchDeps, opts: LaunchOptions): LaunchPlan {
  if (!SLUG_PATTERN.test(slug)) throw new InvalidSlugError(slug);
  const cwd = deps.cwd ?? process.cwd();
  const repoRoot = resolveRepoRoot(cwd);
  const repoBase = basename(repoRoot);
  const worktreesBase = resolveWorktreesBase(deps);

  const ready = listTasks(db, { wish: slug, status: 'ready' });
  if (ready.length === 0) throw new EmptyReadySetError(slug);

  const grouped = groupReadyTasks(ready);
  const selected = selectGroups(grouped, opts.groups);
  validateGroupNames([...selected.keys()]);

  const groups: LaunchGroupPlan[] = [];
  const panes: PaneSpec[] = [];
  for (const [name, tasks] of selected) {
    const worktree = join(worktreesBase, sanitize(`${repoBase}-${slug}-${name}`));
    const promptPath = join(worktree, '.genie', 'launch', `${sanitize(name)}.prompt`);
    groups.push({
      name,
      worktree,
      branch: `wish/${slug}-${name}`,
      promptPath,
      prompt: buildPrompt(slug, name, tasks),
      tasks,
    });
    panes.push({ title: name, cwd: worktree, command: `claude "$(cat "${promptPath}")"` });
  }

  return { slug, repoRoot, groups, panes, yaml: buildLaunchConfigYaml({ slug, panes }) };
}

/**
 * Reject any selected group name that isn't a safe filesystem/branch component
 * BEFORE a single worktree, branch, or prompt is created. Two failures this
 * prevents: (a) a name with spaces/slashes produced an invalid git ref, which
 * crashed `git worktree add` mid-run after earlier groups had already been
 * materialized; (b) two names differing only by separators (e.g. `a/b` vs
 * `a-b`) both sanitized to the same worktree dir + prompt path while keeping
 * distinct raw branch refs — a silent collision that overwrote one group's
 * prompt and pointed it at the wrong branch.
 *
 * With the charset enforced here, a validated name equals its sanitized dir
 * component, so two DISTINCT valid names can never collide on the worktree dir;
 * identical names are already impossible because {@link groupReadyTasks} keys
 * its Map by group name. No separate dir-collision pass is therefore needed.
 */
function validateGroupNames(names: string[]): void {
  const invalid = names.filter((name) => !GROUP_NAME_PATTERN.test(name));
  if (invalid.length > 0) throw new InvalidGroupNameError(invalid);
}

/** Apply the optional `--groups` subset, erroring if it selects nothing ready. */
function selectGroups(grouped: Map<string, TaskRow[]>, subset?: string[]): Map<string, TaskRow[]> {
  if (!subset || subset.length === 0) return grouped;
  const wanted = new Set(subset);
  const selected = new Map<string, TaskRow[]>();
  for (const [name, tasks] of grouped) {
    if (wanted.has(name)) selected.set(name, tasks);
  }
  if (selected.size === 0) {
    const available = [...grouped.keys()].join(', ') || '(none)';
    throw new LaunchError(
      `None of the requested groups [${subset.join(', ')}] have ready tasks. Available: ${available}`,
    );
  }
  return selected;
}

// ============================================================================
// Worktree lifecycle
// ============================================================================

/** Canonicalize a path (resolving symlinks); fall back to the raw path if it can't be resolved. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** True when `worktreePath` is already a registered worktree of `repoRoot`. */
function isRegisteredWorktree(repoRoot: string, worktreePath: string): boolean {
  const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: repoRoot,
  });
  const target = canonical(worktreePath);
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (canonical(line.slice('worktree '.length).trim()) === target) return true;
    }
  }
  return false;
}

/** True when a local branch already exists. */
function branchExists(repoRoot: string, branch: string): boolean {
  const res = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
    stdio: 'ignore',
    cwd: repoRoot,
  });
  return res.status === 0;
}

type WorktreeAction = 'created' | 'reused';

/**
 * Ensure `worktreePath` is a worktree of `repoRoot` on `branch`. Reuses an
 * existing valid worktree silently; errors if the path exists but is not one.
 * A missing worktree is materialized one of two ways:
 *   - branch does NOT exist → a fresh branch is cut from the current HEAD;
 *   - branch already exists (stale from an earlier run whose worktree was
 *     pruned) → it is attached AS-IS, not recreated from HEAD, and an
 *     informational `[attach]` line naming its short SHA is printed so the
 *     divergence from HEAD is never silent.
 */
function ensureWorktree(repoRoot: string, plan: LaunchGroupPlan, write: (line: string) => void): WorktreeAction {
  if (existsSync(plan.worktree)) {
    if (isRegisteredWorktree(repoRoot, plan.worktree)) return 'reused';
    throw new WorktreeCollisionError(plan.worktree);
  }
  mkdirSync(dirname(plan.worktree), { recursive: true });
  const attaching = branchExists(repoRoot, plan.branch);
  if (attaching) {
    write(`  [attach] ${plan.branch} at ${shortSha(repoRoot, plan.branch)} (existing branch; not recreated from HEAD)`);
  }
  const args = attaching
    ? ['worktree', 'add', plan.worktree, plan.branch]
    : ['worktree', 'add', '-b', plan.branch, plan.worktree, 'HEAD'];
  execFileSync('git', args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: repoRoot });
  assertNotBare(repoRoot);
  return 'created';
}

/** Short SHA of a ref (e.g. a branch tip), for informational output. */
function shortSha(repoRoot: string, ref: string): string {
  return execFileSync('git', ['rev-parse', '--short', ref], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: repoRoot,
  }).trim();
}

/** Abort if creating a worktree flipped the parent repo into bare mode. */
function assertNotBare(repoRoot: string): void {
  const bare = execFileSync('git', ['config', '--get', 'core.bare'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: repoRoot,
  }).trim();
  if (bare === 'true') throw new BareRepoError(repoRoot);
}

// ============================================================================
// Execution
// ============================================================================

/** Default opener: `open` on macOS, `xdg-open` on Linux; unknown platforms decline. */
function defaultOpen(uri: string, platform: NodeJS.Platform): boolean {
  const cmd = platform === 'darwin' ? 'open' : platform === 'linux' ? 'xdg-open' : null;
  if (!cmd) return false;
  const res = spawnSync(cmd, [uri], { stdio: 'ignore' });
  return !res.error && (res.status === 0 || res.status === null);
}

/**
 * Plan and (unless `--dry-run`) execute a launch: create/reuse worktrees, write
 * prompts, emit the Warp config, and open it best-effort. Returns the plan.
 */
export function executeLaunch(slug: string, opts: LaunchOptions, deps: LaunchDeps = {}): LaunchPlan {
  const write = deps.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const db = deps.db ?? openDb({ cwd: deps.cwd });
  const ownsDb = deps.db === undefined;
  try {
    const plan = buildLaunchPlan(db, slug, deps, opts);
    if (opts.dryRun) {
      printDryRun(plan, write);
      return plan;
    }
    materialize(plan, deps, write, opts.open !== false);
    return plan;
  } finally {
    if (ownsDb) db.close();
  }
}

/**
 * Best-effort `git worktree prune`: drops registrations left dangling by a
 * worktree directory that was deleted out-of-band (`rm -rf`) without
 * `git worktree remove`. A stale registration makes `git worktree add` refuse
 * to re-attach the branch; pruning first clears it so the attach path recreates
 * the worktree. Pruning is a cleanup convenience — a failure must never block a
 * launch, so it is swallowed.
 */
function pruneWorktrees(repoRoot: string): void {
  try {
    execFileSync('git', ['worktree', 'prune'], { stdio: 'ignore', cwd: repoRoot });
  } catch {
    // Intentionally ignored — see the doc comment.
  }
}

/** Create worktrees + prompts, write the config, and open it. */
function materialize(plan: LaunchPlan, deps: LaunchDeps, write: (line: string) => void, openEnabled: boolean): void {
  const platform = deps.platform ?? process.platform;
  pruneWorktrees(plan.repoRoot);
  write(`Launching wish "${plan.slug}" — ${plan.groups.length} group(s):`);
  for (const group of plan.groups) {
    const action = ensureWorktree(plan.repoRoot, group, write);
    mkdirSync(dirname(group.promptPath), { recursive: true });
    writeFileSync(group.promptPath, group.prompt, 'utf-8');
    write(`  ${group.name}  →  ${group.worktree}  [${action}]`);
  }

  const configPath = writeLaunchConfig({ slug: plan.slug, panes: plan.panes }, { dir: deps.warpDir, platform });
  const uri = launchUri(configPath);
  write(`Wrote launch config: ${configPath}`);

  const openImpl = deps.openImpl ?? defaultOpen;
  if (openEnabled && openImpl(uri, platform)) {
    write(`Opening Warp: ${uri}`);
    return;
  }
  write('Open it manually:');
  write(`  ${configPath}`);
  write(`  ${uri}`);
}

/** Print the full plan without touching the filesystem. */
function printDryRun(plan: LaunchPlan, write: (line: string) => void): void {
  write('DRY RUN — no worktrees, prompts, or config will be written.');
  write('');
  write(`Wish "${plan.slug}" — ${plan.groups.length} group(s):`);
  for (const group of plan.groups) {
    write(`  ${group.name}  (branch ${group.branch}, ${group.tasks.length} task(s))`);
    write(`    worktree: ${group.worktree}`);
    write(`    prompt:   ${group.promptPath}`);
  }
  write('');
  write('Launch config YAML:');
  write(plan.yaml);
}

// ============================================================================
// CLI wiring
// ============================================================================

interface LaunchCliOptions {
  dryRun?: boolean;
  open?: boolean;
  groups?: string;
}

function handleLaunch(slug: string, cli: LaunchCliOptions): void {
  const opts: LaunchOptions = {
    dryRun: cli.dryRun,
    open: cli.open,
    groups: cli.groups
      ? cli.groups
          .split(',')
          .map((g) => g.trim())
          .filter((g) => g.length > 0)
      : undefined,
  };
  try {
    executeLaunch(slug, opts);
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

export function registerLaunchCommand(program: Command): void {
  program
    .command('launch <slug>')
    .description('Open a Warp cockpit for a wish: one pane per ready group, each in its own worktree')
    .option('--dry-run', 'Print the plan (YAML, worktrees, prompts) without touching anything')
    .option('--no-open', 'Emit the launch config but do not open Warp')
    .option('--groups <csv>', 'Launch only these comma-separated group names')
    .action((slug: string, opts: LaunchCliOptions) => handleLaunch(slug, opts));
}
