import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { formatFailure, residueEntries, scanResidue } from './undefined-residue';

const SCRIPT = join(import.meta.dir, 'undefined-residue.ts');
const scratchRoots: string[] = [];

afterEach(() => {
  for (const dir of scratchRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A committed repository with one tracked plugin package, every fixture under the system temp dir. */
function makeRepo(options: { ignoreRootUndefined?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'genie-undefined-residue-'));
  scratchRoots.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), 'seed\n');
  writeFileSync(
    join(root, '.gitignore'),
    options.ignoreRootUndefined ? 'node_modules/\n/undefined/\n' : 'node_modules/\n',
  );
  mkdirSync(join(root, 'plugins', 'x'), { recursive: true });
  writeFileSync(join(root, 'plugins', 'x', 'package.json'), '{}\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'seed');
  return root;
}

/** What a spawned bun leaves: a cache FILE, since git lists no empty directory. */
function plant(root: string, relative: string): void {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'cached\n');
}

function runCli(cwd: string): { exitCode: number; stdout: string; stderr: string } {
  const run = Bun.spawnSync([process.execPath, SCRIPT], {
    cwd,
    env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(cwd) },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { exitCode: run.exitCode ?? -1, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

describe('scanResidue over a real repository', () => {
  test('a clean tree passes', () => {
    const root = makeRepo({ ignoreRootUndefined: true });
    plant(root, 'node_modules/dep/index.js');
    expect(scanResidue(root)).toEqual([]);
  });

  test('an untracked undefined/ fails', () => {
    const root = makeRepo();
    plant(root, 'undefined/.bun/install/cache/pkg.tgz');
    expect(git(root, 'status', '--porcelain')).toContain('?? undefined/');
    expect(scanResidue(root)).toEqual(['undefined/']);
  });

  test('an IGNORED undefined/ fails although a plain git status shows nothing', () => {
    const root = makeRepo({ ignoreRootUndefined: true });
    plant(root, 'undefined/.bun/install/cache/pkg.tgz');
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(git(root, 'status', '--porcelain', '--ignored')).toContain('!! undefined/');
    expect(scanResidue(root)).toEqual(['undefined/']);
  });

  test('a nested one under a tracked package fails, found from a subdirectory too', () => {
    const root = makeRepo({ ignoreRootUndefined: true });
    plant(root, 'plugins/x/undefined/.bun/install/cache/pkg.tgz');
    expect(scanResidue(root)).toEqual(['plugins/x/undefined/']);
    expect(scanResidue(join(root, 'plugins', 'x'))).toEqual(['plugins/x/undefined/']);
  });

  test('a name that merely contains the word does not fail: the match is a whole path component', () => {
    const root = makeRepo();
    plant(root, 'undefined-behaviour.md');
    plant(root, 'undefined-probe/notes.txt');
    plant(root, 'plugins/x/not-undefined/notes.txt');
    plant(root, 'plugins/x/undefined.json');
    expect(scanResidue(root)).toEqual([]);
  });
});

describe('residueEntries (porcelain v1 -z)', () => {
  test('a rename is judged by its new path; the origin field is skipped', () => {
    const records = ['R  docs/new.md', 'undefined/old.md', '?? undefined/', '!! plugins/x/undefined/', ''].join('\0');
    expect(residueEntries(records)).toEqual(['undefined/', 'plugins/x/undefined/']);
    expect(residueEntries(['R  undefined/new.md', 'docs/old.md', ''].join('\0'))).toEqual(['undefined/new.md']);
  });

  test('empty output is clean', () => {
    expect(residueEntries('')).toEqual([]);
  });
});

describe('the CLI', () => {
  test('exit 0 with one line on stdout when the tree is clean', () => {
    const root = makeRepo({ ignoreRootUndefined: true });
    const run = runCli(root);
    expect(run).toEqual({
      exitCode: 0,
      stdout: 'undefined-residue: no entry named "undefined" in the tree\n',
      stderr: '',
    });
  });

  test('exit 1 naming every offending path, the cause and the remedy on stderr', () => {
    const root = makeRepo({ ignoreRootUndefined: true });
    plant(root, 'undefined/.bun/install/cache/pkg.tgz');
    plant(root, 'plugins/x/undefined/.bun/install/cache/pkg.tgz');
    const run = runCli(root);
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe(`${formatFailure(['plugins/x/undefined/', 'undefined/'])}\n`);
    expect(run.stderr).toContain('\n  undefined/\n');
    expect(run.stderr).toContain('\n  plugins/x/undefined/\n');
    expect(run.stderr).toContain('A bun run with HOME unset, or set to the text "undefined", wrote its cache there.\n');
    expect(run.stderr).toContain('Delete it and rerun; if it comes back, a test is leaking the environment.\n');
  });

  test('exit 2 when git cannot answer (not a repository)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'genie-undefined-residue-norepo-'));
    scratchRoots.push(dir);
    const run = runCli(dir);
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toStartWith('undefined-residue: cannot read the git status: ');
  });
});
