import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { injectTeamHooks, isTeamHooked } from '../inject.js';
import { DISPATCHED_EVENTS } from '../types.js';

describe('hook injection', () => {
  const testDir = join(tmpdir(), `genie-hook-test-${Date.now()}`);
  const originalEnv = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(async () => {
    process.env.CLAUDE_CONFIG_DIR = testDir;
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    if (originalEnv) {
      process.env.CLAUDE_CONFIG_DIR = originalEnv;
    } else {
      process.env.CLAUDE_CONFIG_DIR = undefined;
    }
    await rm(testDir, { recursive: true, force: true });
  });

  test('injectTeamHooks creates settings.json with hooks', async () => {
    const result = await injectTeamHooks('test-team');
    expect(result).toBe(true);

    const settingsPath = join(testDir, 'teams', 'test-team', 'settings.json');
    expect(existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
    expect(settings.hooks).toBeDefined();

    for (const event of DISPATCHED_EVENTS) {
      expect(settings.hooks[event]).toBeDefined();
      expect(settings.hooks[event][0].hooks[0].command).toBe('genie hook dispatch');
    }
  });

  test('injectTeamHooks is idempotent', async () => {
    await injectTeamHooks('test-team');
    const result = await injectTeamHooks('test-team');
    expect(result).toBe(false); // already injected
  });

  test('injectTeamHooks preserves existing settings', async () => {
    const teamDir = join(testDir, 'teams', 'test-team');
    await mkdir(teamDir, { recursive: true });

    const settingsPath = join(teamDir, 'settings.json');
    await writeFile(
      settingsPath,
      JSON.stringify({
        permissions: { allow: ['Bash(*)'] },
        customField: 'preserved',
      }),
    );

    await injectTeamHooks('test-team');

    const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
    expect(settings.permissions.allow).toEqual(['Bash(*)']);
    expect(settings.customField).toBe('preserved');
    expect(settings.hooks).toBeDefined();
  });

  test('isTeamHooked returns false for missing team', async () => {
    const result = await isTeamHooked('nonexistent');
    expect(result).toBe(false);
  });

  test('isTeamHooked returns true after injection', async () => {
    await injectTeamHooks('test-team');
    const result = await isTeamHooked('test-team');
    expect(result).toBe(true);
  });
});
