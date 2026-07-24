import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTrustedExecutablePath } from './trusted-executable.js';

let home: string;

function fakeExecutable(path: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
}

function gitInit(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'trusted-exe-home-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('validateTrustedExecutablePath — home containment is not a trust signal (live-QA regression)', () => {
  test('a user-level CLI under ~/.local/bin is accepted when the CWD IS the home directory', () => {
    // The 2026-07-23 dogfood failure: `genie update` run from $HOME refused
    // /home/<user>/.local/bin/claude as "repository-local" because the bare CWD
    // containment rule swallowed the whole home tree.
    const claude = fakeExecutable(join(home, '.local', 'bin', 'claude'));
    expect(validateTrustedExecutablePath('claude CLI', claude, home, process.platform, home)).toBe(
      realpathSync(claude),
    );
  });

  test('a dotfiles git repository AT the home directory does not ban user-level CLIs', () => {
    gitInit(home);
    const claude = fakeExecutable(join(home, '.local', 'bin', 'claude'));
    expect(validateTrustedExecutablePath('claude CLI', claude, home, process.platform, home)).toBe(
      realpathSync(claude),
    );
  });

  test('a repository-local executable in a project BELOW home stays refused', () => {
    const project = join(home, 'workspace', 'proj');
    gitInit(project);
    const evil = fakeExecutable(join(project, 'bin', 'claude'));
    expect(() => validateTrustedExecutablePath('claude CLI', evil, project, process.platform, home)).toThrow(
      /repository-local/,
    );
  });

  test('a CWD-local executable in a plain (non-git) project directory stays refused', () => {
    const scratch = join(home, 'downloads', 'unpacked');
    const evil = fakeExecutable(join(scratch, 'claude'));
    expect(() => validateTrustedExecutablePath('claude CLI', evil, scratch, process.platform, home)).toThrow(
      /repository-local/,
    );
  });

  test('from inside a project, a user-level CLI outside the project is accepted', () => {
    const project = join(home, 'workspace', 'proj');
    gitInit(project);
    const claude = fakeExecutable(join(home, '.local', 'bin', 'claude'));
    expect(validateTrustedExecutablePath('claude CLI', claude, project, process.platform, home)).toBe(
      realpathSync(claude),
    );
  });
});
