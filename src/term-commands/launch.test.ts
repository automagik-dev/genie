import type { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { openDb } from '../lib/v5/genie-db.js';
import { createTask } from '../lib/v5/task-state.js';
import {
  BareRepoError,
  EmptyReadySetError,
  InvalidGroupNameError,
  InvalidSlugError,
  type LaunchDeps,
  LaunchError,
  WorktreeCollisionError,
  executeLaunch,
} from './launch.js';

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

interface Fixture {
  root: string; // test-scoped tmp dir (cleaned up)
  repo: string; // git repo root
  worktrees: string; // injected worktrees base (never the real ~/.genie)
  warp: string; // injected Warp config dir
  db: Database;
}

let fx: Fixture;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/** A git repo with one commit so `git worktree add … HEAD` has a base. */
function makeRepo(root: string): string {
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'root'], {
    cwd: repo,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return repo;
}

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'genie-launch-'));
  const repo = makeRepo(root);
  const worktrees = join(root, 'worktrees');
  const warp = join(root, 'warp');
  const db = openDb({ path: join(repo, '.genie', 'genie.db') });
  fx = { root, repo, worktrees, warp, db };
});

afterEach(() => {
  fx.db.close();
  rmSync(fx.root, { recursive: true, force: true });
});

/** Base deps wiring every injectable to the isolated fixture. */
function deps(extra: Partial<LaunchDeps> = {}): LaunchDeps {
  return {
    cwd: fx.repo,
    db: fx.db,
    worktreesDir: fx.worktrees,
    warpDir: fx.warp,
    platform: 'darwin',
    write: () => {},
    ...extra,
  };
}

/** Expected worktree dir for a group (mirrors launch.ts sanitize + naming). */
function worktreeFor(slug: string, group: string): string {
  return join(fx.worktrees, `${basename(fx.repo)}-${slug}-${group}`);
}

function configPath(slug: string): string {
  return join(fx.warp, `genie-${slug}.yaml`);
}

// ----------------------------------------------------------------------------
// --dry-run: computes the plan, touches nothing
// ----------------------------------------------------------------------------

describe('genie launch --dry-run', () => {
  test('emits one pane per group with correct titles/cwds/commands and ZERO side effects', () => {
    const slug = 'feature-x';
    const a = createTask(fx.db, { title: 'build the api', wish: slug, group: 'api' });
    const b = createTask(fx.db, { title: 'build the ui', wish: slug, group: 'ui' });

    const lines: string[] = [];
    const plan = executeLaunch(slug, { dryRun: true }, deps({ write: (l) => lines.push(l) }));

    // Pane structure derives from the YAML the config emitter produced.
    const config = Bun.YAML.parse(plan.yaml) as {
      windows: Array<{ tabs: Array<{ layout: unknown }> }>;
    };
    const leaves = flattenLeaves(config.windows[0].tabs[0].layout);
    expect(leaves.map((l) => l.title)).toEqual(['api', 'ui']);
    expect(leaves.map((l) => l.cwd)).toEqual([worktreeFor(slug, 'api'), worktreeFor(slug, 'ui')]);
    expect((leaves[0].commands as Array<{ exec: string }>)[0].exec).toBe(
      `claude "$(cat "${join(worktreeFor(slug, 'api'), '.genie', 'launch', 'api.prompt')}")"`,
    );

    // Prompt content lists both tasks' ids (verified via the plan, not disk).
    const apiGroup = plan.groups.find((g) => g.name === 'api');
    expect(apiGroup?.prompt).toContain(a.id);
    const uiGroup = plan.groups.find((g) => g.name === 'ui');
    expect(uiGroup?.prompt).toContain(b.id);

    // ZERO side effects: no worktrees, no config, no prompt files.
    expect(existsSync(fx.worktrees)).toBe(false);
    expect(existsSync(worktreeFor(slug, 'api'))).toBe(false);
    expect(existsSync(configPath(slug))).toBe(false);
    expect(existsSync(fx.warp)).toBe(false);
    expect(lines.join('\n')).toContain('DRY RUN');
  });
});

/** Flatten a Warp layout tree into its leaf panes, left-to-right. */
function flattenLeaves(layout: unknown): Array<Record<string, unknown>> {
  const node = layout as Record<string, unknown>;
  if (Array.isArray(node.panes)) return (node.panes as unknown[]).flatMap(flattenLeaves);
  return [node];
}

// ----------------------------------------------------------------------------
// Real run (--no-open): worktrees, prompts, config, core.bare intact
// ----------------------------------------------------------------------------

describe('genie launch (real run, --no-open)', () => {
  test('creates worktrees on the right branches, writes prompts, emits config, keeps core.bare false', () => {
    const slug = 'ship-it';
    const t1 = createTask(fx.db, { title: 'task one', wish: slug, group: 'core' });
    const t2 = createTask(fx.db, { title: 'task two', wish: slug, group: 'core' });
    const t3 = createTask(fx.db, { title: 'task three', wish: slug, group: 'docs' });

    const opened: string[] = [];
    const record = (uri: string): boolean => {
      opened.push(uri);
      return true;
    };
    executeLaunch(slug, { open: false }, deps({ openImpl: record }));

    // Worktrees exist and are registered on the expected branches.
    const coreWt = worktreeFor(slug, 'core');
    const docsWt = worktreeFor(slug, 'docs');
    expect(existsSync(coreWt)).toBe(true);
    expect(existsSync(docsWt)).toBe(true);
    expect(git(coreWt, ['symbolic-ref', '--short', 'HEAD'])).toBe(`wish/${slug}-core`);
    expect(git(docsWt, ['symbolic-ref', '--short', 'HEAD'])).toBe(`wish/${slug}-docs`);

    // Prompt for the core group lists BOTH of its ready task ids.
    const corePrompt = readFileSync(join(coreWt, '.genie', 'launch', 'core.prompt'), 'utf-8');
    expect(corePrompt).toContain(t1.id);
    expect(corePrompt).toContain(t2.id);
    const docsPrompt = readFileSync(join(docsWt, '.genie', 'launch', 'docs.prompt'), 'utf-8');
    expect(docsPrompt).toContain(t3.id);

    // Config file written.
    expect(existsSync(configPath(slug))).toBe(true);

    // Parent repo did NOT flip to bare.
    expect(git(fx.repo, ['config', '--get', 'core.bare'])).toBe('false');

    // --no-open means the opener is never invoked.
    expect(opened).toEqual([]);
  });

  test('opens Warp best-effort when open is enabled', () => {
    const slug = 'openable';
    createTask(fx.db, { title: 'a task', wish: slug, group: 'main' });
    const opened: string[] = [];
    const record = (uri: string): boolean => {
      opened.push(uri);
      return true;
    };
    executeLaunch(slug, {}, deps({ openImpl: record }));
    expect(opened).toHaveLength(1);
    expect(opened[0]).toBe(`warp://launch/${configPath(slug)}`);
  });
});

// ----------------------------------------------------------------------------
// Reuse, collision, subset, empty
// ----------------------------------------------------------------------------

describe('genie launch worktree lifecycle', () => {
  test('a second run silently reuses the existing worktree', () => {
    const slug = 'reuse-me';
    createTask(fx.db, { title: 'a task', wish: slug, group: 'main' });

    executeLaunch(slug, { open: false }, deps());
    const lines: string[] = [];
    // Second run must not throw and must report the worktree as reused.
    expect(() => executeLaunch(slug, { open: false }, deps({ write: (l) => lines.push(l) }))).not.toThrow();
    expect(lines.join('\n')).toContain('[reused]');
    expect(git(fx.repo, ['config', '--get', 'core.bare'])).toBe('false');
  });

  test('a plain directory squatting the worktree path raises WorktreeCollisionError', () => {
    const slug = 'collide';
    createTask(fx.db, { title: 'a task', wish: slug, group: 'main' });
    mkdirSync(worktreeFor(slug, 'main'), { recursive: true });
    expect(() => executeLaunch(slug, { open: false }, deps())).toThrow(WorktreeCollisionError);
  });

  test('--groups launches only the named subset', () => {
    const slug = 'subset';
    createTask(fx.db, { title: 'api task', wish: slug, group: 'api' });
    createTask(fx.db, { title: 'ui task', wish: slug, group: 'ui' });

    const plan = executeLaunch(slug, { open: false, groups: ['api'] }, deps());
    expect(plan.groups.map((g) => g.name)).toEqual(['api']);
    expect(existsSync(worktreeFor(slug, 'api'))).toBe(true);
    expect(existsSync(worktreeFor(slug, 'ui'))).toBe(false);
  });

  test('--groups matching no ready group raises LaunchError', () => {
    const slug = 'nomatch';
    createTask(fx.db, { title: 'api task', wish: slug, group: 'api' });
    expect(() => executeLaunch(slug, { open: false, groups: ['ghost'] }, deps())).toThrow(/have ready tasks/);
  });

  test('an empty ready set raises EmptyReadySetError suggesting the board', () => {
    const slug = 'nothing-ready';
    expect(() => executeLaunch(slug, { open: false }, deps())).toThrow(EmptyReadySetError);
    try {
      executeLaunch(slug, { open: false }, deps());
    } catch (err) {
      expect((err as Error).message).toContain(`genie board --wish ${slug}`);
    }
  });

  test('a null-group task lands in the "main" pane', () => {
    const slug = 'null-group';
    createTask(fx.db, { title: 'ungrouped', wish: slug });
    const plan = executeLaunch(slug, { dryRun: true }, deps());
    expect(plan.groups.map((g) => g.name)).toEqual(['main']);
  });
});

// ----------------------------------------------------------------------------
// Group-name validation (MEDIUM): reject unsafe names before ANY side effect
// ----------------------------------------------------------------------------

describe('genie launch group-name validation', () => {
  test('a name with a space is rejected up front, creating nothing', () => {
    const slug = 'spacey';
    createTask(fx.db, { title: 'a task', wish: slug, group: 'bad name' });

    let caught: unknown;
    try {
      executeLaunch(slug, { open: false }, deps());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidGroupNameError);
    expect((caught as InvalidGroupNameError).names).toEqual(['bad name']);

    // Failing before materialize means nothing landed on disk.
    expect(existsSync(fx.worktrees)).toBe(false);
    expect(existsSync(worktreeFor(slug, 'bad name'))).toBe(false);
    expect(existsSync(fx.warp)).toBe(false);
  });

  test('a name with a slash (a/b) is rejected — the silent-collision vector is closed', () => {
    const slug = 'seps';
    createTask(fx.db, { title: 'slashy', wish: slug, group: 'a/b' });

    let caught: unknown;
    try {
      executeLaunch(slug, { open: false }, deps());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidGroupNameError);
    expect((caught as InvalidGroupNameError).names).toEqual(['a/b']);
    expect(existsSync(fx.worktrees)).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// Stale-branch attach (LOW): existing branch, missing worktree → informational
// ----------------------------------------------------------------------------

describe('genie launch stale-branch attach', () => {
  test('a branch with no worktree is attached as-is and announced with its short SHA', () => {
    const slug = 'attachy';
    createTask(fx.db, { title: 'a task', wish: slug, group: 'main' });

    // First run cuts the branch + worktree from HEAD.
    executeLaunch(slug, { open: false }, deps());
    const wt = worktreeFor(slug, 'main');
    // Prune the worktree but keep the branch → next run must attach, not recreate.
    git(fx.repo, ['worktree', 'remove', '--force', wt]);
    expect(existsSync(wt)).toBe(false);

    const lines: string[] = [];
    executeLaunch(slug, { open: false }, deps({ write: (l) => lines.push(l) }));

    expect(lines.join('\n')).toMatch(
      /\[attach] wish\/attachy-main at [0-9a-f]+ \(existing branch; not recreated from HEAD\)/,
    );
    expect(existsSync(wt)).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// Slug validation: reject unsafe wish slugs before ANY side effect
// ----------------------------------------------------------------------------

describe('genie launch slug validation', () => {
  test('a slug with a slash is rejected up front, creating nothing', () => {
    let caught: unknown;
    try {
      executeLaunch('a/b', { open: false }, deps());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidSlugError);
    expect((caught as InvalidSlugError).slug).toBe('a/b');

    // Validation precedes the DB read + git call, so nothing lands on disk.
    expect(existsSync(fx.worktrees)).toBe(false);
    expect(existsSync(fx.warp)).toBe(false);
  });

  test('a slug with a space is rejected up front, creating nothing', () => {
    let caught: unknown;
    try {
      executeLaunch('bad slug', { open: false }, deps());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidSlugError);
    expect(existsSync(fx.worktrees)).toBe(false);
    expect(existsSync(fx.warp)).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// Non-git cwd: resolveRepoRoot surfaces a typed error, not a subprocess trace
// ----------------------------------------------------------------------------

describe('genie launch outside a git repository', () => {
  test('a non-git cwd raises a typed LaunchError, not a raw git failure', () => {
    const nonGit = mkdtempSync(join(tmpdir(), 'genie-launch-nogit-'));
    try {
      let caught: unknown;
      try {
        executeLaunch('some-slug', { open: false }, deps({ cwd: nonGit }));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LaunchError);
      expect((caught as Error).message).toBe('genie launch must be run inside a git repository.');
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });
});

// ----------------------------------------------------------------------------
// Stale worktree prune: an rm-rfed worktree dir is pruned + recreated next run
// ----------------------------------------------------------------------------

describe('genie launch stale-worktree prune', () => {
  test('a manually rm-rfed worktree dir is pruned so the next run re-attaches its branch', () => {
    const slug = 'prune-me';
    createTask(fx.db, { title: 'a task', wish: slug, group: 'main' });

    executeLaunch(slug, { open: false }, deps());
    const wt = worktreeFor(slug, 'main');
    expect(existsSync(wt)).toBe(true);

    // Delete the worktree dir out-of-band, leaving git's stale registration behind.
    // Without a `git worktree prune`, the next `git worktree add` refuses the branch.
    rmSync(wt, { recursive: true, force: true });
    expect(existsSync(wt)).toBe(false);

    const lines: string[] = [];
    expect(() => executeLaunch(slug, { open: false }, deps({ write: (l) => lines.push(l) }))).not.toThrow();

    // Prune cleared the stale registration; the surviving branch drives the attach path.
    expect(existsSync(wt)).toBe(true);
    expect(lines.join('\n')).toContain('[attach]');
    expect(git(fx.repo, ['config', '--get', 'core.bare'])).toBe('false');
  });
});

// ----------------------------------------------------------------------------
// Workspace-guard inclusive (HIGH): the CLI preAction runs `genie launch` only
// through the real entry point, which executeLaunch() bypasses. Drive the built
// bundle as a subprocess from a clean repo with NO workspace.json in its
// ancestry and an isolated GENIE_HOME (so no saved-workspaceRoot fallback can
// satisfy the legacy guard). This test fails (exit 2) if `launch` is dropped
// from WORKSPACE_EXEMPT.
// ----------------------------------------------------------------------------

describe('genie launch (built CLI, workspace-guard inclusive)', () => {
  const REPO_ROOT = join(import.meta.dir, '..', '..');
  let bundleDir: string;
  let bundle: string;

  beforeAll(() => {
    bundleDir = mkdtempSync(join(tmpdir(), 'genie-launch-bundle-'));
    bundle = join(bundleDir, 'genie.js');
    const res = spawnSync(
      'bun',
      ['build', join(REPO_ROOT, 'src', 'genie.ts'), '--target', 'bun', '--external', 'bun', '--outfile', bundle],
      { cwd: REPO_ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    if (res.status !== 0) throw new Error(`bundle build failed:\n${res.stderr}`);
  });

  afterAll(() => {
    rmSync(bundleDir, { recursive: true, force: true });
  });

  let cliRepo: string;
  let cliBase: string;
  let cliHome: string;

  beforeEach(() => {
    cliBase = mkdtempSync(join(tmpdir(), 'genie-launch-cli-'));
    cliRepo = join(cliBase, 'repo');
    mkdirSync(cliRepo, { recursive: true });
    git(cliRepo, ['init', '-q']);
    git(cliRepo, ['config', 'user.email', 'test@example.com']);
    git(cliRepo, ['config', 'user.name', 'Test']);
    git(cliRepo, ['config', 'commit.gpgsign', 'false']);
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'root'], {
      cwd: cliRepo,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    cliHome = join(cliBase, 'home');
    mkdirSync(cliHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(cliBase, { recursive: true, force: true });
  });

  function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const res = spawnSync('bun', [bundle, ...args], {
      cwd: cliRepo,
      encoding: 'utf-8',
      input: '',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GENIE_HOME: cliHome, CI: '1' },
    });
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  }

  test('task create + launch --dry-run both exit 0 with no workspace.json anywhere', () => {
    const create = runCli(['task', 'create', '--title', 'build api', '--wish', 'warp-x', '--group', 'api']);
    expect(create.status).toBe(0);

    const launch = runCli(['launch', 'warp-x', '--dry-run']);
    expect(launch.status).toBe(0);
    expect(launch.stdout).toContain('DRY RUN');
    expect(launch.stdout).toContain('Launch config YAML:');
    expect(launch.stdout).toContain('api');
  });
});

// Reference BareRepoError so the export contract is exercised even though the
// bare-flip path can't be provoked without corrupting the fixture repo.
test('BareRepoError is exported for the core.bare guard', () => {
  expect(new BareRepoError('/x')).toBeInstanceOf(Error);
});
