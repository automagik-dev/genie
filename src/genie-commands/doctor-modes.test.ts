/**
 * doctor-modes: on-disk mode drift inside every registered worktree.
 *
 * Every fixture is a REAL git repo with REAL `git worktree add` worktrees
 * under the system temp dir — the scanner's whole job is reading git truth and
 * lstat truth, so a mocked git would test nothing. Nothing outside
 * `mkdtempSync` roots is ever touched, and every fixture sets its modes
 * explicitly so no ambient umask can leak into an assertion.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkWorktreeModes, classifyModeDrift, repairWorktreeModes, scanWorktreeModes } from './doctor-modes.js';
import { cleanupLaunchWorktrees } from './doctor-worktrees.js';
import { doctorCommand } from './doctor.js';

const scratchRoots: string[] = [];

afterEach(() => {
  for (const dir of scratchRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

interface Fixture {
  /** Temp dir holding the repo, the worktrees base, and planted symlink targets. */
  dir: string;
  /** Main checkout. */
  root: string;
  /** Stand-in for the launch worktrees base. */
  base: string;
}

/** Seeded repo with tracked files at a.txt (644), sub/b.txt (644), bin/run.sh (755). */
function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'genie-doctor-modes-'));
  scratchRoots.push(dir);
  const root = join(dir, 'repo');
  const base = join(dir, 'worktrees');
  mkdirSync(root);
  mkdirSync(base);
  chmodSync(root, 0o755);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'a.txt'), 'alpha\n');
  chmodSync(join(root, 'a.txt'), 0o644);
  mkdirSync(join(root, 'sub'));
  chmodSync(join(root, 'sub'), 0o755);
  writeFileSync(join(root, 'sub', 'b.txt'), 'beta\n');
  chmodSync(join(root, 'sub', 'b.txt'), 0o644);
  mkdirSync(join(root, 'bin'));
  chmodSync(join(root, 'bin'), 0o755);
  writeFileSync(join(root, 'bin', 'run.sh'), '#!/bin/sh\necho hi\n');
  chmodSync(join(root, 'bin', 'run.sh'), 0o755);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'seed');
  git(root, 'branch', 'dev');
  return { dir, root, base };
}

/** Materialize a worktree under the base on a fresh branch, with explicit modes. */
function addWorktree(fixture: Fixture, branch: string): string {
  const path = join(fixture.base, branch.split('/').pop() ?? branch);
  git(fixture.root, 'worktree', 'add', '-q', '-b', branch, path);
  chmodSync(path, 0o755);
  return path;
}

function modeOf(path: string): number {
  return lstatSync(path).mode & 0o7777;
}

/** git reports canonical paths (macOS temp dirs live behind /private). */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The drift entries for one worktree path (canonicalized), optionally one relPath. */
function entriesFor(scan: ReturnType<typeof scanWorktreeModes>, worktree: string, relPath: string | null = null) {
  return scan.entries.filter(
    (entry) => entry.worktree === canonical(worktree) && (relPath === null || entry.relPath === relPath),
  );
}

/** Run the `--fix` half against the fixture, capturing its log lines. */
function runRepair(fixture: Fixture): string[] {
  const lines: string[] = [];
  repairWorktreeModes(fixture.root, { logSink: (line) => lines.push(line) });
  return lines;
}

describe('mode drift classification (pure)', () => {
  test('wider, stricter, and mixed are told apart; dir repair set is exactly 0775/0777', () => {
    expect(classifyModeDrift(0o666, 0o644, 'file')).toMatchObject({ disposition: 'wider' });
    expect(classifyModeDrift(0o777, 0o755, 'file')).toMatchObject({ disposition: 'wider' });
    expect(classifyModeDrift(0o600, 0o644, 'file')).toMatchObject({ disposition: 'stricter' });
    expect(classifyModeDrift(0o660, 0o644, 'file')).toMatchObject({ disposition: 'mixed' });
    expect(classifyModeDrift(0o644, 0o644, 'file')).toBeNull();

    expect(classifyModeDrift(0o775, 0o755, 'dir')).toMatchObject({ disposition: 'wider' });
    expect(classifyModeDrift(0o777, 0o755, 'dir')).toMatchObject({ disposition: 'wider' });
    expect(classifyModeDrift(0o700, 0o755, 'dir')).toMatchObject({ disposition: 'stricter' });
    expect(classifyModeDrift(0o770, 0o755, 'dir')).toMatchObject({ disposition: 'mixed' });
    // Wider than 0755 but outside the named set: setgid is plausibly intentional.
    expect(classifyModeDrift(0o2775, 0o755, 'dir')).toMatchObject({ disposition: 'refused' });
  });
});

describe('wider drift is reported and tightened to the index mode', () => {
  test('a 0666 file (index 0644) tightens to 0644; repair is idempotent', () => {
    const fixture = makeFixture();
    const wt = addWorktree(fixture, 'wish/demo-alpha');
    chmodSync(join(wt, 'a.txt'), 0o666);

    const entry = entriesFor(scanWorktreeModes(fixture.root), wt, 'a.txt')[0];
    expect(entry).toMatchObject({ kind: 'file', disposition: 'wider', indexMode: '644', diskMode: '666' });
    const report = checkWorktreeModes(fixture.root)
      .map((check) => `${check.name} — ${check.detail} — ${check.suggestion ?? ''}`)
      .join('\n');
    expect(report).toContain('1 wider');
    expect(report).toContain('--fix tightens to 644');
    expect(report).toContain('genie doctor --fix');

    const lines = runRepair(fixture).join('\n');
    expect(lines).toContain(`tightened ${canonical(wt)}/a.txt (666 → 644)`);
    expect(modeOf(join(wt, 'a.txt'))).toBe(0o644);

    // Second run: nothing wider left ⇒ strict no-op, no chatter.
    expect(runRepair(fixture)).toEqual([]);
    expect(scanWorktreeModes(fixture.root).entries).toEqual([]);
    expect(checkWorktreeModes(fixture.root)[0]).toMatchObject({
      name: 'mode drift',
      status: 'pass',
      detail: 'none found',
    });
  });

  test('a 0777 executable (index 0755) tightens to 0755', () => {
    const fixture = makeFixture();
    const wt = addWorktree(fixture, 'wish/demo-beta');
    chmodSync(join(wt, 'bin', 'run.sh'), 0o777);

    const entry = entriesFor(scanWorktreeModes(fixture.root), wt, 'bin/run.sh')[0];
    expect(entry).toMatchObject({ disposition: 'wider', indexMode: '755', diskMode: '777' });
    runRepair(fixture);
    expect(modeOf(join(wt, 'bin', 'run.sh'))).toBe(0o755);
  });

  test('drift in the main checkout is reported and repaired too', () => {
    const fixture = makeFixture();
    chmodSync(join(fixture.root, 'a.txt'), 0o666);

    const entry = entriesFor(scanWorktreeModes(fixture.root), fixture.root, 'a.txt')[0];
    expect(entry).toMatchObject({ disposition: 'wider', indexMode: '644', diskMode: '666' });
    runRepair(fixture);
    expect(modeOf(join(fixture.root, 'a.txt'))).toBe(0o644);
  });
});

describe('tighten-only: stricter modes survive --fix untouched', () => {
  test('a 0600 file is reported but never widened', () => {
    const fixture = makeFixture();
    const wt = addWorktree(fixture, 'wish/demo-alpha');
    chmodSync(join(wt, 'a.txt'), 0o600);

    const entry = entriesFor(scanWorktreeModes(fixture.root), wt, 'a.txt')[0];
    expect(entry).toMatchObject({ disposition: 'stricter', indexMode: '644', diskMode: '600' });
    const itemLine = checkWorktreeModes(fixture.root).find((check) => check.name.includes('a.txt'));
    expect(itemLine?.status).toBe('pass'); // informational, never a warning to fix
    expect(itemLine?.detail).toContain('never widened');

    expect(runRepair(fixture)).toEqual([]); // nothing wider ⇒ strict no-op
    expect(modeOf(join(wt, 'a.txt'))).toBe(0o600);
  });

  test('a 0700 dir is reported but never widened', () => {
    const fixture = makeFixture();
    const wt = addWorktree(fixture, 'wish/demo-beta');
    chmodSync(join(wt, 'sub'), 0o700);

    const entry = entriesFor(scanWorktreeModes(fixture.root), wt, 'sub')[0];
    expect(entry).toMatchObject({ kind: 'dir', disposition: 'stricter', indexMode: '755', diskMode: '700' });
    runRepair(fixture);
    expect(modeOf(join(wt, 'sub'))).toBe(0o700);
  });

  test('a mixed mode (0660 file, 0770 dir) is kept and never edited', () => {
    const fixture = makeFixture();
    const wt = addWorktree(fixture, 'wish/demo-gamma');
    chmodSync(join(wt, 'a.txt'), 0o660);
    chmodSync(join(wt, 'sub'), 0o770);

    expect(entriesFor(scanWorktreeModes(fixture.root), wt, 'a.txt')[0]).toMatchObject({ disposition: 'mixed' });
    expect(entriesFor(scanWorktreeModes(fixture.root), wt, 'sub')[0]).toMatchObject({ disposition: 'mixed' });
    runRepair(fixture);
    expect(modeOf(join(wt, 'a.txt'))).toBe(0o660);
    expect(modeOf(join(wt, 'sub'))).toBe(0o770);
  });
});

describe('directory repair is included', () => {
  test('0777 worktree root and 0775 nested dir tighten to 0755', () => {
    const fixture = makeFixture();
    const wt = addWorktree(fixture, 'wish/demo-alpha');
    chmodSync(wt, 0o777);
    chmodSync(join(wt, 'sub'), 0o775);

    const scan = scanWorktreeModes(fixture.root);
    expect(entriesFor(scan, wt, '')[0]).toMatchObject({
      kind: 'dir',
      disposition: 'wider',
      indexMode: '755',
      diskMode: '777',
    });
    expect(entriesFor(scan, wt, 'sub')[0]).toMatchObject({ kind: 'dir', disposition: 'wider', diskMode: '775' });

    runRepair(fixture);
    expect(modeOf(wt)).toBe(0o755);
    expect(modeOf(join(wt, 'sub'))).toBe(0o755);
  });
});

describe('planted symlinks are never followed', () => {
  test('a tracked file replaced by a symlink is refused; the target is never operated on', () => {
    const fixture = makeFixture();
    const wt = addWorktree(fixture, 'wish/demo-alpha');
    const victim = join(fixture.dir, 'victim.txt');
    writeFileSync(victim, 'secret\n');
    chmodSync(victim, 0o644);
    rmSync(join(wt, 'a.txt'));
    symlinkSync(victim, join(wt, 'a.txt'));

    const entry = entriesFor(scanWorktreeModes(fixture.root), wt, 'a.txt')[0];
    expect(entry).toMatchObject({ disposition: 'refused', indexMode: '644' });
    expect(entry.reason).toContain('symlink');
    const itemLine = checkWorktreeModes(fixture.root).find((check) => check.name.includes('a.txt'));
    expect(itemLine?.detail).toContain('--fix will not touch it');

    runRepair(fixture);
    expect(lstatSync(join(wt, 'a.txt')).isSymbolicLink()).toBe(true);
    expect(modeOf(victim)).toBe(0o644); // untouched through the link
  });

  test('a directory replaced by a symlink blocks every file beneath it', () => {
    const fixture = makeFixture();
    const wt = addWorktree(fixture, 'wish/demo-beta');
    const outdir = join(fixture.dir, 'outdir');
    mkdirSync(outdir);
    writeFileSync(join(outdir, 'precious.txt'), 'precious\n');
    chmodSync(join(outdir, 'precious.txt'), 0o600); // even a stricter target must not change
    chmodSync(outdir, 0o777);
    rmSync(join(wt, 'sub'), { recursive: true });
    symlinkSync(outdir, join(wt, 'sub'));

    const scan = scanWorktreeModes(fixture.root);
    const dirEntry = entriesFor(scan, wt, 'sub')[0];
    expect(dirEntry).toMatchObject({ kind: 'dir', disposition: 'refused' });
    expect(dirEntry.reason).toContain('never followed');
    const fileEntry = entriesFor(scan, wt, 'sub/b.txt')[0];
    expect(fileEntry).toMatchObject({ disposition: 'refused' });
    expect(fileEntry.reason).toContain('never followed');

    runRepair(fixture);
    expect(lstatSync(join(wt, 'sub')).isSymbolicLink()).toBe(true);
    expect(modeOf(join(outdir, 'precious.txt'))).toBe(0o600);
    expect(modeOf(outdir)).toBe(0o777);
  });

  test('tracked symlink (120000) and gitlink (160000) index entries are skipped outright', () => {
    const fixture = makeFixture();
    const wt = addWorktree(fixture, 'wish/demo-gamma');
    symlinkSync('a.txt', join(wt, 'link.txt'));
    git(wt, 'add', 'link.txt');
    git(wt, 'commit', '-q', '-m', 'add tracked symlink');
    git(wt, 'update-index', '--add', '--cacheinfo', '160000', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'submod');

    const scan = scanWorktreeModes(fixture.root);
    expect(scan.entries.some((entry) => entry.relPath === 'link.txt')).toBe(false);
    expect(scan.entries.some((entry) => entry.relPath === 'submod')).toBe(false);
    expect(runRepair(fixture)).toEqual([]);
    expect(lstatSync(join(wt, 'link.txt')).isSymbolicLink()).toBe(true);
  });
});

describe('probe errors keep the item with a reason', () => {
  test('a vanished worktree refuses the whole tree instead of assuming it is clean', () => {
    const fixture = makeFixture();
    const wt = addWorktree(fixture, 'wish/demo-alpha');
    // Porcelain prints canonical paths; once the directory is gone realpath
    // fails, so capture the canonical spelling while it still exists.
    const canonicalWt = canonical(wt);
    rmSync(wt, { recursive: true, force: true });

    const entry = scanWorktreeModes(fixture.root).entries.find((e) => e.worktree === canonicalWt);
    expect(entry).toMatchObject({ relPath: null, kind: 'worktree', disposition: 'refused' });
    expect(entry?.reason).toBe('worktree directory no longer exists');
    const report = checkWorktreeModes(fixture.root)
      .map((check) => `${check.name} — ${check.detail} — ${check.suggestion ?? ''}`)
      .join('\n');
    expect(report).toContain('--fix will not touch it');
    expect(report).toContain('Run `git worktree prune`');

    expect(runRepair(fixture)).toEqual([]);
  });

  test('outside a git repository: enumeration failure is surfaced; null root emits nothing', () => {
    const plainDir = mkdtempSync(join(tmpdir(), 'genie-doctor-modes-plain-'));
    scratchRoots.push(plainDir);
    const checks = checkWorktreeModes(plainDir);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ name: 'mode drift', status: 'warn' });
    expect(checks[0].detail).toContain('enumeration failed');

    expect(checkWorktreeModes(null)).toEqual([]);
    repairWorktreeModes(null, {
      logSink: () => {
        throw new Error('repair must not run without a repo root');
      },
    });
  });
});

describe('dirty worktrees: repair applies, removal stays refused', () => {
  test('--fix tightens drift inside a dirty worktree but never removes it', () => {
    const fixture = makeFixture();
    const wt = addWorktree(fixture, 'wish/demo-alpha');
    writeFileSync(join(wt, 'scratch.txt'), 'work in progress\n');
    chmodSync(join(wt, 'a.txt'), 0o666);

    // The worktrees-removal proof still refuses a dirty tree (regression).
    const cleanupLines: string[] = [];
    cleanupLaunchWorktrees(fixture.root, { worktreesBase: fixture.base, logSink: (line) => cleanupLines.push(line) });
    expect(cleanupLines).toEqual([]);
    expect(lstatSync(join(wt, 'scratch.txt')).isFile()).toBe(true);

    // Mode repair still applies: content hygiene does not depend on cleanliness.
    runRepair(fixture);
    expect(modeOf(join(wt, 'a.txt'))).toBe(0o644);
    expect(lstatSync(join(wt, 'scratch.txt')).isFile()).toBe(true);
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
  function isolate(fixture: Fixture): void {
    for (const key of ISOLATED_KEYS) {
      if (process.env[key] !== undefined) saved[key] = process.env[key];
    }
    const home = join(fixture.dir, 'home');
    mkdirSync(home, { recursive: true });
    chmodSync(home, 0o755);
    process.env.HOME = home;
    process.env.GENIE_HOME = join(home, 'genie');
    process.env.CODEX_HOME = join(home, 'codex');
    process.env.CLAUDE_CONFIG_DIR = join(home, 'claude');
    process.env.GENIE_WORKTREES_DIR = fixture.base;
  }

  async function runDoctor(
    fixture: Fixture,
    options: { json?: boolean; fix?: boolean },
  ): Promise<{ output: string; exitCode: number }> {
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
        root: fixture.root,
        databaseRoot: fixture.root,
        pluginProbe: { cliAvailable: false, status: 'unavailable', installed: false, detail: 'fixture absent' },
        codexActivation: null,
        projectContext: null,
        bunVersion: '1.3.10',
        bunPath: '/usr/bin/bun',
      });
      return { output: buffer, exitCode: typeof process.exitCode === 'number' ? process.exitCode : 0 };
    } finally {
      process.stdout.write = realWrite;
      process.exitCode = priorExit ?? 0;
    }
  }

  test('doctor --json reports per-worktree drift with dispositions; detect-only mutates nothing', async () => {
    const fixture = makeFixture();
    isolate(fixture);
    const wt = addWorktree(fixture, 'wish/demo-alpha');
    chmodSync(join(wt, 'a.txt'), 0o666);
    chmodSync(join(wt, 'sub'), 0o700);

    const { output, exitCode } = await runDoctor(fixture, { json: true });
    expect(exitCode).toBe(0);
    const json = JSON.parse(output) as {
      checks: Array<{ name: string; status: string; detail?: string }>;
    };
    const modeChecks = json.checks.filter((check) => check.name.startsWith('mode drift'));
    expect(modeChecks[0].detail).toContain('1 wider, 1 stricter');
    expect(modeChecks.map((check) => check.detail).join('\n')).toContain('--fix tightens to 644');
    expect(modeChecks.map((check) => check.detail).join('\n')).toContain('never widened');
    // Detect-only: reporting drift must not repair it — repair stays behind --fix.
    expect(modeOf(join(wt, 'a.txt'))).toBe(0o666);
    expect(modeOf(join(wt, 'sub'))).toBe(0o700);
  });

  test('doctor --fix tightens only the wider items; stricter items survive; report reflects the post-fix state', async () => {
    const fixture = makeFixture();
    isolate(fixture);
    const wt = addWorktree(fixture, 'wish/demo-alpha');
    // A real content change keeps the worktree alive through the removal sweep
    // (mode-only drift is invisible to `git status`), so repair can act on it.
    writeFileSync(join(wt, 'scratch.txt'), 'work in progress\n');
    chmodSync(join(wt, 'a.txt'), 0o666);
    chmodSync(join(wt, 'sub'), 0o700);

    const { output, exitCode } = await runDoctor(fixture, { json: true, fix: true });
    expect(exitCode).toBe(0);
    expect(lstatSync(join(wt, 'scratch.txt')).isFile()).toBe(true); // never removed
    expect(modeOf(join(wt, 'a.txt'))).toBe(0o644);
    expect(modeOf(join(wt, 'sub'))).toBe(0o700); // never widened
    const json = JSON.parse(output) as { checks: Array<{ name: string; detail?: string }> };
    const summary = json.checks.find((check) => check.name === 'mode drift');
    expect(summary?.detail).toContain('1 stricter');
    expect(summary?.detail).not.toContain('wider');
  });
});
