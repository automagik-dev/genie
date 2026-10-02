import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// The wish gate's whole hook-liveness predicate is one POSIX command, `HOOKS_LIVE_COMMAND` in
// .claude/workflows/wish.js, which the gate runs verbatim from the worktree. It is lifted from the
// shipped text and executed here against REAL git repositories, because its traps are git's and the
// host's, not ours: a linked worktree resolves its hooks into the common git dir, and macOS hands out
// a /var temp dir whose real path is /private/var. Every fixture is built by hand — no package
// install, no network — and each hook's mode is set explicitly, never left to the host umask.

const ROOT = join(import.meta.dir, '..');
const SCRIPT = readFileSync(join(ROOT, '.claude', 'workflows', 'wish.js'), 'utf8');
const line = /^const HOOKS_LIVE_COMMAND = .*$/m.exec(SCRIPT)?.[0];
if (!line) throw new Error('wish.js: no one-line HOOKS_LIVE_COMMAND');
const HOOKS_LIVE_COMMAND = new Function(`${line}\nreturn HOOKS_LIVE_COMMAND`)() as string;

const EXECUTABLE = 0o755;
const NOT_EXECUTABLE = 0o644;
const DOES_NOT_EXIST = 'dead: the hooks directory git resolves does not exist\n';

let scratch = '';
let env: Record<string, string | undefined> = {};

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'wish-gate-hooks-')));
  const globalConfig = join(scratch, 'gitconfig-global');
  writeFileSync(globalConfig, '');
  mkdirSync(join(scratch, 'empty-template'));
  // No inherited GIT_* variable — a git hook that runs this suite exports GIT_DIR and friends — an
  // empty global config and no system config: each fixture's own config is the only one in play.
  env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  env.GIT_CONFIG_GLOBAL = globalConfig;
  env.GIT_CONFIG_NOSYSTEM = '1';
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} exited ${result.status}: ${result.stderr}`);
}

/** A fresh repository whose hooks directory starts EMPTY: an empty template, so no host template leaks in. */
function repository(name = 'repo'): string {
  const dir = join(scratch, name);
  mkdirSync(dir);
  git(dir, 'init', '-q', `--template=${join(scratch, 'empty-template')}`);
  return dir;
}

function hook(path: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, mode);
}

/** Sets the repository's hooks path through git itself, exactly as a hook manager's installer does. */
function hooksPath(dir: string, value: string): void {
  git(dir, 'config', 'core.hooksPath', value);
}

function liveness(cwd: string): { status: number | null; stdout: string } {
  const result = spawnSync('sh', ['-c', HOOKS_LIVE_COMMAND], { cwd, env, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout };
}

describe('the gate liveness command answers live, exit 0, for every hook system that would fire', () => {
  test('husky 9: core.hooksPath .husky/_ holding pre-push and pre-commit', () => {
    const dir = repository();
    hook(join(dir, '.husky', '_', 'pre-push'), EXECUTABLE);
    hook(join(dir, '.husky', '_', 'pre-commit'), EXECUTABLE);
    hooksPath(dir, '.husky/_');
    expect(liveness(dir)).toEqual({ status: 0, stdout: `live: ${dir}/.husky/_/pre-push\n` });
  });

  test('husky 6 to 8: core.hooksPath .husky, an executable pre-commit, and .husky/_ holding only husky.sh', () => {
    const dir = repository();
    hook(join(dir, '.husky', 'pre-commit'), EXECUTABLE);
    hook(join(dir, '.husky', '_', 'husky.sh'), NOT_EXECUTABLE);
    hooksPath(dir, '.husky');
    expect(liveness(dir)).toEqual({ status: 0, stdout: `live: ${dir}/.husky/pre-commit\n` });
  });

  test('.git/hooks/pre-commit seen from a linked worktree, where pre-commit and lefthook install', () => {
    const main = repository();
    git(
      main,
      '-c',
      'user.name=Gate Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'seed',
    );
    const linked = join(scratch, 'linked');
    git(main, 'worktree', 'add', '-q', '--detach', linked);
    // Installed after the seed commit and the checkout, so neither ran it.
    hook(join(main, '.git', 'hooks', 'pre-commit'), EXECUTABLE);
    expect(liveness(linked)).toEqual({ status: 0, stdout: `live: ${main}/.git/hooks/pre-commit\n` });
  });

  test('a tracked .githooks with core.hooksPath .githooks', () => {
    const dir = repository();
    hook(join(dir, '.githooks', 'pre-push'), EXECUTABLE);
    git(dir, 'add', '.githooks');
    hooksPath(dir, '.githooks');
    expect(liveness(dir)).toEqual({ status: 0, stdout: `live: ${dir}/.githooks/pre-push\n` });
  });
});

describe('the gate liveness command answers dead, exit 1, for every hook system that would not fire', () => {
  test('husky 9 with .husky/_ absent: the user hook alone fires nothing', () => {
    const dir = repository();
    hook(join(dir, '.husky', 'pre-commit'), EXECUTABLE);
    hooksPath(dir, '.husky/_');
    expect(liveness(dir)).toEqual({ status: 1, stdout: DOES_NOT_EXIST });
  });

  test('husky 9 with .husky/_ holding pre-commit but no pre-push', () => {
    const dir = repository();
    hook(join(dir, '.husky', '_', 'pre-commit'), EXECUTABLE);
    hooksPath(dir, '.husky/_');
    expect(liveness(dir)).toEqual({
      status: 1,
      stdout: `dead: the husky 9 hooks directory ${dir}/.husky/_ has no pre-push\n`,
    });
  });

  test('husky 6 to 8 with a non-executable .husky/pre-commit', () => {
    const dir = repository();
    hook(join(dir, '.husky', 'pre-commit'), NOT_EXECUTABLE);
    hook(join(dir, '.husky', '_', 'husky.sh'), NOT_EXECUTABLE);
    hooksPath(dir, '.husky');
    expect(liveness(dir)).toEqual({
      status: 1,
      stdout: `dead: no executable pre-push or pre-commit in ${dir}/.husky\n`,
    });
  });

  test('only .sample hooks, executable or not', () => {
    const dir = repository();
    hook(join(dir, '.git', 'hooks', 'pre-push.sample'), EXECUTABLE);
    hook(join(dir, '.git', 'hooks', 'pre-commit.sample'), EXECUTABLE);
    expect(liveness(dir)).toEqual({
      status: 1,
      stdout: `dead: no executable pre-push or pre-commit in ${dir}/.git/hooks\n`,
    });
  });

  test('a non-executable pre-push', () => {
    const dir = repository();
    hook(join(dir, '.git', 'hooks', 'pre-push'), NOT_EXECUTABLE);
    expect(liveness(dir)).toEqual({
      status: 1,
      stdout: `dead: no executable pre-push or pre-commit in ${dir}/.git/hooks\n`,
    });
  });

  test('core.hooksPath /dev/null', () => {
    const dir = repository();
    hook(join(dir, '.git', 'hooks', 'pre-push'), EXECUTABLE);
    hooksPath(dir, '/dev/null');
    expect(liveness(dir)).toEqual({ status: 1, stdout: DOES_NOT_EXIST });
  });

  test('core.hooksPath at a directory outside the repository, even one holding an executable pre-push', () => {
    const dir = repository();
    const outside = join(scratch, 'outside', 'hooks');
    hook(join(outside, 'pre-push'), EXECUTABLE);
    hooksPath(dir, outside);
    expect(liveness(dir)).toEqual({
      status: 1,
      stdout: `dead: ${outside} is outside the worktree and the repository git directory\n`,
    });
  });
});
