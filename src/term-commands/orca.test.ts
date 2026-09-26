import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ORCA_RETIRED_NOTICE } from './orca.js';

const CLI = join(import.meta.dir, '..', 'genie.ts');

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'genie-orca-stub-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'genie-orca-stub-cwd-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function cli(...args: string[]): { code: number; stdout: string; stderr: string } {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), GENIE_HOME: home };
  env.NO_COLOR = '1';
  const result = Bun.spawnSync(['bun', CLI, ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  return { code: result.exitCode ?? -1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

// The Orca integration is retired. `genie orca` survives one release so a host
// script gets a named notice instead of `unknown command`; it writes nothing.
describe('retired genie orca stub', () => {
  test.each([
    [['orca', 'mirror', '--to', 'SHIPPED', '--evidence', 'x']],
    [['orca', 'mirror', '--to', 'REVIEW', '--verdict', 'SHIP', '--evidence', 'x', '--worktree', 'active']],
    [['orca']],
    [['orca', 'mirror', '--help']],
  ])('%p prints the retirement notice on stderr and exits 2', (args) => {
    const result = cli(...args);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(`${ORCA_RETIRED_NOTICE}\n`);
    expect(readdirSync(home)).toEqual([]);
    expect(readdirSync(cwd)).toEqual([]);
  });

  test('stays visible in --help for its one release', () => {
    const result = cli('--help');
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^ {2}orca\b.*Retired/m);
  });
});
