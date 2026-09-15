import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '..', 'genie.ts');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Invoke the CLI the way an operator does — a real process, real argv, real exit
 * code. A unit call on the handler would not prove the command is registered,
 * which is half of what `genie config get` is for.
 */
async function runCli(genieHome: string, args: string[]): Promise<RunResult> {
  const proc = Bun.spawn(['bun', CLI, ...args], {
    env: { ...process.env, GENIE_HOME: genieHome, NO_COLOR: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe('genie config get', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'genie-config-cmd-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('prints the schema default for a budget key on a fresh home', async () => {
    const result = await runCli(home, ['config', 'get', 'budgets.maxEscalationsPerGroup']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('2');
  });

  test('--json reports key, value, and a default source', async () => {
    const result = await runCli(home, ['config', 'get', 'budgets.maxEscalationsPerGroup', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      key: 'budgets.maxEscalationsPerGroup',
      value: 2,
      source: 'default',
    });
  });

  test('a configured value is reported with source "file"', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ budgets: { maxEscalationsPerGroup: 4 } }), 'utf-8');
    const bare = await runCli(home, ['config', 'get', 'budgets.maxEscalationsPerGroup']);
    expect(bare.stdout.trim()).toBe('4');
    const json = await runCli(home, ['config', 'get', 'budgets.maxEscalationsPerGroup', '--json']);
    expect(JSON.parse(json.stdout)).toEqual({
      key: 'budgets.maxEscalationsPerGroup',
      value: 4,
      source: 'file',
    });
  });

  test('a sibling key left out of the file still reports source "default"', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ budgets: { maxEscalationsPerGroup: 4 } }), 'utf-8');
    const result = await runCli(home, ['config', 'get', 'budgets.maxFableCallsPerWish', '--json']);
    expect(JSON.parse(result.stdout)).toEqual({
      key: 'budgets.maxFableCallsPerWish',
      value: 3,
      source: 'default',
    });
  });

  test('a value the schema refuses falls back to the default, never to the out-of-range file value', async () => {
    // A hand-edited config that tries to relax the gate past its ceiling is not
    // honoured: the parse fails and `loadGenieConfig` returns defaults.
    writeFileSync(join(home, 'config.json'), JSON.stringify({ budgets: { maxEscalationsPerGroup: 99 } }), 'utf-8');
    const result = await runCli(home, ['config', 'get', 'budgets.maxEscalationsPerGroup', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      key: 'budgets.maxEscalationsPerGroup',
      value: 2,
      source: 'default',
    });
  });

  test('an unknown key exits 1 with a stable stderr diagnostic and no stdout', async () => {
    const result = await runCli(home, ['config', 'get', 'budgets.nope']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe('Error (genie config get): unknown config key: budgets.nope');
  });

  test('a key under an open-ended container is not addressable', async () => {
    const result = await runCli(home, ['config', 'get', 'workerProfiles.anything']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('unknown config key: workerProfiles.anything');
  });

  test('a branch key prints its whole object', async () => {
    const result = await runCli(home, ['config', 'get', 'budgets']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ maxFableCallsPerWish: 3, maxEscalationsPerGroup: 2 });
  });
});
