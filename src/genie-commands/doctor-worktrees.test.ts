import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type LaunchWorktreeEntry,
  checkLaunchWorktrees,
  cleanupLaunchWorktrees,
  parseWorktreePorcelain,
  resolveIntegrationBranch,
  scanLaunchWorktrees,
} from './doctor-worktrees.js';
import { doctorCommand } from './doctor.js';

/**
 * Every fixture here is a REAL git repo with REAL `git worktree add` worktrees,
 * created under the system temp dir — the classifier's whole job is reading git
 * truth, so a mocked git would test nothing. Nothing outside `mkdtempSync`
 * roots is ever touched.
 */

const scratchRoots: string[] = [];

afterEach(() => {
  for (const dir of scratchRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

interface Fixture {
  /** Temp dir holding the repo, the worktrees base, and any bare remote. */
  dir: string;
  /** Main checkout. */
  root: string;
  /** Stand-in for `<GENIE_HOME>/worktrees`. */
  base: string;
}

/** Seeded repo + empty worktrees base. `integration: 'none'` omits the `dev` branch. */
function makeFixture(options: { integration?: 'dev' | 'none' } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'genie-doctor-wt-'));
  scratchRoots.push(dir);
  const root = join(dir, 'repo');
  const base = join(dir, 'worktrees');
  mkdirSync(root);
  mkdirSync(base);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), 'seed\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'seed');
  if (options.integration !== 'none') git(root, 'branch', 'dev');
  return { dir, root, base };
}

/** Materialize a worktree at `<parent ?? base>/<name>` on a new branch. */
function addWorktree(fx: Fixture, name: string, branch: string, parent?: string): string {
  const path = join(parent ?? fx.base, name);
  git(fx.root, 'worktree', 'add', '-q', '-b', branch, path);
  return path;
}

function branchExists(root: string, branch: string): boolean {
  return git(root, 'branch', '--list', branch).trim() !== '';
}

/** Run the `--fix` half against the fixture, capturing its log lines. */
function runFix(fx: Fixture): string[] {
  const lines: string[] = [];
  cleanupLaunchWorktrees(fx.root, { worktreesBase: fx.base, logSink: (line) => lines.push(line) });
  return lines;
}

function only(fx: Fixture): LaunchWorktreeEntry {
  const { entries } = scanLaunchWorktrees(fx.root, fx.base);
  expect(entries).toHaveLength(1);
  return entries[0];
}

/** Human `genie doctor` detail text for a check whose name starts with `launch worktrees`. */
function details(fx: Fixture): string {
  return checkLaunchWorktrees(fx.root, { worktreesBase: fx.base })
    .map((check) => `${check.name} — ${check.detail} — ${check.suggestion ?? ''}`)
    .join('\n');
}

describe('launch worktree enumeration', () => {
  test('parses porcelain records, including detached and bare worktrees', () => {
    const records = parseWorktreePorcelain(
      [
        'worktree /repo',
        'HEAD 1111111111111111111111111111111111111111',
        'branch refs/heads/main',
        '',
        'worktree /wt/detached',
        'HEAD 2222222222222222222222222222222222222222',
        'detached',
        '',
        'worktree /wt/group',
        'HEAD 3333333333333333333333333333333333333333',
        'branch refs/heads/wish/demo-alpha',
        '',
      ].join('\n'),
    );
    expect(records).toEqual([
      { path: '/repo', branch: 'main' },
      { path: '/wt/detached', branch: null },
      { path: '/wt/group', branch: 'wish/demo-alpha' },
    ]);
  });

  test('a directory git does not know about is neither reported nor removed', () => {
    const fx = makeFixture();
    const impostor = join(fx.base, 'repo-demo-ghost');
    mkdirSync(impostor);
    writeFileSync(join(impostor, 'keep.txt'), 'not a worktree\n');

    expect(scanLaunchWorktrees(fx.root, fx.base).entries).toEqual([]);
    expect(runFix(fx)).toEqual([]);
    expect(existsSync(impostor)).toBe(true);
  });

  test('the repo doctor runs from is never a removal candidate', () => {
    const fx = makeFixture();
    const wt = addWorktree(fx, 'repo-demo-alpha', 'wish/demo-alpha');
    // Scanning FROM the launch worktree still enumerates the repo's worktrees,
    // but the current checkout drops out rather than becoming removable.
    expect(scanLaunchWorktrees(wt, fx.base).entries).toEqual([]);
    expect(existsSync(wt)).toBe(true);
  });
});

describe('integration branch resolution', () => {
  test('prefers a local dev branch', () => {
    const fx = makeFixture();
    expect(resolveIntegrationBranch(fx.root)).toBe('dev');
  });

  test('falls back to the remote default branch when there is no dev', () => {
    const fx = makeFixture({ integration: 'none' });
    const origin = join(fx.dir, 'origin.git');
    git(fx.dir, 'init', '--bare', '-q', origin);
    git(fx.root, 'remote', 'add', 'origin', origin);
    git(fx.root, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    git(fx.root, 'remote', 'set-head', 'origin', 'main');

    expect(resolveIntegrationBranch(fx.root)).toBe('origin/main');
    // And the proof still runs end to end against it.
    addWorktree(fx, 'repo-demo-alpha', 'wish/demo-alpha');
    expect(only(fx).disposition).toBe('removable');
  });

  test('fails closed when neither a dev branch nor a remote default exists', () => {
    const fx = makeFixture({ integration: 'none' });
    const wt = addWorktree(fx, 'repo-demo-alpha', 'wish/demo-alpha');
    const scan = scanLaunchWorktrees(fx.root, fx.base);

    expect(scan.integrationBranch).toBeNull();
    expect(scan.entries[0].disposition).toBe('unresolved');
    expect(scan.entries[0].reason).toBe('integration branch unresolvable');
    expect(details(fx)).toContain('integration branch unresolvable — --fix will remove nothing');

    expect(runFix(fx)).toEqual([]);
    expect(existsSync(wt)).toBe(true);
    expect(branchExists(fx.root, 'wish/demo-alpha')).toBe(true);
  });
});

describe('classification and fail-closed removal', () => {
  test('merged + clean is reclaimable; --fix removes it with its branch and is idempotent', () => {
    const fx = makeFixture();
    const wt = addWorktree(fx, 'repo-demo-alpha', 'wish/demo-alpha');

    const entry = only(fx);
    expect(entry.disposition).toBe('removable');
    expect(entry.reason).toBe('merged+clean');
    expect(entry.sizeBytes).toBeGreaterThan(0);
    const report = details(fx);
    expect(report).toContain('1 of 1 reclaimable (merged into dev, clean)');
    // The line names what the reclaim actually deletes: gitignored content too.
    expect(report).toContain('reclaimable (merged+clean; includes gitignored files)');
    expect(report).toContain('genie doctor --fix');

    // git reports canonical paths (macOS temp dirs live behind /private).
    const reported = realpathSync(wt);
    const lines = runFix(fx).join('\n');
    expect(lines).toContain(`removed ${reported} (wish/demo-alpha)`);
    expect(existsSync(wt)).toBe(false);
    expect(branchExists(fx.root, 'wish/demo-alpha')).toBe(false);

    // Second run: nothing provably removable ⇒ strict no-op, no chatter.
    expect(runFix(fx)).toEqual([]);
    expect(scanLaunchWorktrees(fx.root, fx.base).entries).toEqual([]);
    expect(details(fx)).toContain('launch worktrees — none found');
  });

  test('an uncommitted change keeps the worktree and blocks --fix', () => {
    const fx = makeFixture();
    const wt = addWorktree(fx, 'repo-demo-alpha', 'wish/demo-alpha');
    writeFileSync(join(wt, 'scratch.txt'), 'work in progress\n');

    const entry = only(fx);
    expect(entry.disposition).toBe('dirty');
    expect(entry.sizeBytes).toBe(0);
    const report = details(fx);
    expect(report).toContain('kept (uncommitted changes) — not counted as reclaimable; --fix will not touch it');
    expect(report).toContain('0 of 1 reclaimable — all kept (integration branch: dev)');

    expect(runFix(fx)).toEqual([]);
    expect(existsSync(join(wt, 'scratch.txt'))).toBe(true);
    expect(branchExists(fx.root, 'wish/demo-alpha')).toBe(true);
  });

  test('a commit the integration branch lacks keeps the worktree and blocks --fix', () => {
    const fx = makeFixture();
    const wt = addWorktree(fx, 'repo-demo-beta', 'wish/demo-beta');
    writeFileSync(join(wt, 'feature.txt'), 'unmerged work\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-q', '-m', 'feature');

    const entry = only(fx);
    expect(entry.disposition).toBe('unmerged');
    expect(entry.reason).toBe('commits not in dev');
    expect(details(fx)).toContain('kept (commits not in dev) — not counted as reclaimable; --fix will not touch it');

    expect(runFix(fx)).toEqual([]);
    expect(existsSync(wt)).toBe(true);
    expect(branchExists(fx.root, 'wish/demo-beta')).toBe(true);
  });

  test('a tag shadowing the launch branch cannot fake the ancestry proof', () => {
    const fx = makeFixture();
    const wt = addWorktree(fx, 'repo-demo-alpha', 'wish/demo-alpha');
    writeFileSync(join(wt, 'feature.txt'), 'unmerged work\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-q', '-m', 'feature');
    // A bare name resolves refs/tags/ BEFORE refs/heads/, so this tag — pointing
    // at the integration branch — would answer the ancestry probe in the
    // branch's place, proving "merged" about a ref that carries none of its
    // commits while `git branch -D` still deletes the real, unmerged branch.
    git(fx.root, 'tag', 'wish/demo-alpha', 'dev');

    const entry = only(fx);
    expect(entry.disposition).toBe('unmerged');
    expect(entry.reason).toBe('commits not in dev');

    expect(runFix(fx)).toEqual([]);
    expect(existsSync(join(wt, 'feature.txt'))).toBe(true);
    expect(branchExists(fx.root, 'wish/demo-alpha')).toBe(true);
  });

  test('a tag shadowing the integration branch cannot fake the ancestry proof', () => {
    const fx = makeFixture();
    const wt = addWorktree(fx, 'repo-demo-beta', 'wish/demo-beta');
    writeFileSync(join(wt, 'feature.txt'), 'unmerged work\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-q', '-m', 'feature');
    // The integration side shadows identically: a `dev` TAG sitting on the
    // launch branch tip satisfies a bare-name probe while `refs/heads/dev`
    // still lacks every commit the branch carries.
    git(fx.root, 'tag', 'dev', 'refs/heads/wish/demo-beta');

    const entry = only(fx);
    expect(entry.disposition).toBe('unmerged');
    expect(entry.reason).toBe('commits not in dev');

    expect(runFix(fx)).toEqual([]);
    expect(existsSync(join(wt, 'feature.txt'))).toBe(true);
    expect(branchExists(fx.root, 'wish/demo-beta')).toBe(true);
  });

  test('a failing git probe keeps the worktree instead of assuming it is safe', () => {
    const fx = makeFixture();
    const wt = addWorktree(fx, 'repo-demo-alpha', 'wish/demo-alpha');
    // The directory disappears while git still tracks it: every probe run
    // inside it now fails, so nothing about the branch is proven.
    rmSync(wt, { recursive: true, force: true });

    const entry = only(fx);
    expect(entry.disposition).toBe('error');
    expect(entry.reason).not.toBe('');
    const report = details(fx);
    expect(report).toContain('not counted as reclaimable; --fix will not touch it');
    // A vanished directory can never be proven safe, so the check offers the one
    // thing that clears it instead of warning forever with no remedy.
    expect(report).toContain('Run `git worktree prune`');

    expect(runFix(fx)).toEqual([]);
    expect(branchExists(fx.root, 'wish/demo-alpha')).toBe(true);
  });

  test('worktrees outside the base or off the launch branch shape stay foreign', () => {
    const fx = makeFixture();
    const outside = join(fx.dir, 'manual');
    mkdirSync(outside);
    const elsewhere = addWorktree(fx, 'looks-like-launch', 'wish/demo-alpha', outside);
    const insideBase = addWorktree(fx, 'repo-demo-gamma', 'feature/manual');

    const scan = scanLaunchWorktrees(fx.root, fx.base);
    expect(scan.entries.map((entry) => entry.disposition)).toEqual(['foreign', 'foreign']);

    // Foreign checkouts never get a line each — they collapse into one count.
    const checks = checkLaunchWorktrees(fx.root, { worktreesBase: fx.base });
    expect(checks).toHaveLength(2);
    expect(checks[0]).toMatchObject({ name: 'launch worktrees', status: 'pass', detail: 'none found' });
    expect(checks[1]).toMatchObject({
      name: 'launch worktrees: other checkouts',
      status: 'pass',
      detail: '2 kept (not launch worktrees of this repo) — never touched by --fix',
    });

    expect(runFix(fx)).toEqual([]);
    expect(existsSync(elsewhere)).toBe(true);
    expect(existsSync(insideBase)).toBe(true);
  });

  test('one refused entry does not block a provably safe sibling', () => {
    const fx = makeFixture();
    const dirty = addWorktree(fx, 'repo-demo-alpha', 'wish/demo-alpha');
    writeFileSync(join(dirty, 'scratch.txt'), 'wip\n');
    const clean = addWorktree(fx, 'repo-demo-beta', 'wish/demo-beta');

    runFix(fx);
    expect(existsSync(dirty)).toBe(true);
    expect(branchExists(fx.root, 'wish/demo-alpha')).toBe(true);
    expect(existsSync(clean)).toBe(false);
    expect(branchExists(fx.root, 'wish/demo-beta')).toBe(false);
  });

  test('emits no check at all outside a git repository', () => {
    expect(checkLaunchWorktrees(null)).toEqual([]);
    cleanupLaunchWorktrees(null, {
      logSink: () => {
        throw new Error('cleanup must not run without a repo root');
      },
    });
  });
});

describe('doctor wiring', () => {
  const ISOLATED_KEYS = ['HOME', 'GENIE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GENIE_WORKTREES_DIR'] as const;
  let saved: Partial<Record<(typeof ISOLATED_KEYS)[number], string>> = {};

  afterEach(() => {
    for (const key of ISOLATED_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    saved = {};
  });

  /** Point every home-shaped env at the fixture so doctor never reads the real host. */
  function isolate(fx: Fixture): void {
    for (const key of ISOLATED_KEYS) {
      if (process.env[key] !== undefined) saved[key] = process.env[key];
    }
    const home = join(fx.dir, 'home');
    mkdirSync(home, { recursive: true });
    process.env.HOME = home;
    process.env.GENIE_HOME = join(home, 'genie');
    process.env.CODEX_HOME = join(home, 'codex');
    process.env.CLAUDE_CONFIG_DIR = join(home, 'claude');
    // The seam `checkLaunchWorktrees(root)` resolves through inside doctor.
    process.env.GENIE_WORKTREES_DIR = fx.base;
  }

  async function runDoctor(fx: Fixture, options: { json?: boolean; fix?: boolean }): Promise<string> {
    const realWrite = process.stdout.write.bind(process.stdout);
    const priorExit = process.exitCode;
    process.exitCode = 0;
    let buffer = '';
    process.stdout.write = ((chunk: string) => {
      buffer += chunk;
      return true;
    }) as typeof process.stdout.write;
    try {
      await doctorCommand(options, {
        root: fx.root,
        databaseRoot: fx.root,
        pluginProbe: { cliAvailable: false, status: 'unavailable', installed: false, detail: 'fixture absent' },
        codexActivation: null,
        projectContext: null,
        bunVersion: '1.3.10',
        bunPath: '/usr/bin/bun',
      });
      return buffer;
    } finally {
      process.stdout.write = realWrite;
      process.exitCode = priorExit ?? 0;
    }
  }

  test('doctor --json lists each worktree with its disposition and reclaimable size', async () => {
    const fx = makeFixture();
    isolate(fx);
    const clean = addWorktree(fx, 'repo-demo-alpha', 'wish/demo-alpha');
    const dirty = addWorktree(fx, 'repo-demo-beta', 'wish/demo-beta');
    writeFileSync(join(dirty, 'scratch.txt'), 'wip\n');

    const json = JSON.parse(await runDoctor(fx, { json: true })) as {
      checks: Array<{ name: string; status: string; detail?: string }>;
    };
    const worktreeChecks = json.checks.filter((check) => check.name.startsWith('launch worktrees'));
    expect(worktreeChecks[0].detail).toContain('1 of 2 reclaimable (merged into dev, clean)');
    expect(worktreeChecks.map((check) => check.detail).join('\n')).toContain(
      'reclaimable (merged+clean; includes gitignored files)',
    );
    expect(worktreeChecks.map((check) => check.detail).join('\n')).toContain('kept (uncommitted changes)');
    // Detect-only: reporting a worktree as reclaimable must not remove it —
    // cleanup stays behind `--fix`, asserted here rather than inferred.
    expect(existsSync(clean)).toBe(true);
    expect(branchExists(fx.root, 'wish/demo-alpha')).toBe(true);
  });

  test('doctor --fix reclaims only the provably safe worktree', async () => {
    const fx = makeFixture();
    isolate(fx);
    const clean = addWorktree(fx, 'repo-demo-alpha', 'wish/demo-alpha');
    const dirty = addWorktree(fx, 'repo-demo-beta', 'wish/demo-beta');
    writeFileSync(join(dirty, 'scratch.txt'), 'wip\n');

    const output = await runDoctor(fx, { json: true, fix: true });
    expect(existsSync(clean)).toBe(false);
    expect(branchExists(fx.root, 'wish/demo-alpha')).toBe(false);
    expect(existsSync(dirty)).toBe(true);
    expect(branchExists(fx.root, 'wish/demo-beta')).toBe(true);
    // The report reflects the POST-fix state: one worktree left, still kept.
    const json = JSON.parse(output) as { checks: Array<{ name: string; detail?: string }> };
    expect(json.checks.find((check) => check.name === 'launch worktrees')?.detail).toContain('0 of 1 reclaimable');
  });
});
