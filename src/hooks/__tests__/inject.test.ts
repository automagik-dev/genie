import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { injectTeamHooks, isTeamHooked } from '../inject.js';
import { DISPATCHED_EVENTS, DISPATCHED_EVENT_MATCHERS } from '../types.js';

describe('hook injection', () => {
  const testDir = join(tmpdir(), `genie-hook-test-${Date.now()}`);
  const originalEnv = process.env.CLAUDE_CONFIG_DIR;
  const originalHome = process.env.GENIE_HOME;
  const originalHookBin = process.env.GENIE_HOOK_BIN;

  beforeEach(async () => {
    process.env.CLAUDE_CONFIG_DIR = testDir;
    // Pin GENIE_HOME to a tmp dir so the inject layer's compiled-binary
    // candidate (~/.genie/bin/genie-hook) doesn't resolve to a real binary
    // produced by postinstall on the CI runner. These tests assert the
    // bun-fork fallback shape; binary resolution is covered separately.
    process.env.GENIE_HOME = join(testDir, 'genie-home');
    process.env.GENIE_HOOK_BIN = join(testDir, 'genie-home', 'no-such-binary');
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    if (originalEnv) {
      process.env.CLAUDE_CONFIG_DIR = originalEnv;
    } else {
      process.env.CLAUDE_CONFIG_DIR = undefined;
    }
    if (originalHome === undefined) process.env.GENIE_HOME = undefined;
    else process.env.GENIE_HOME = originalHome;
    if (originalHookBin === undefined) process.env.GENIE_HOOK_BIN = undefined;
    else process.env.GENIE_HOOK_BIN = originalHookBin;
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
      expect(settings.hooks[event][0].hooks[0].command).toContain('hook dispatch');
      expect(settings.hooks[event][0].hooks[0].command).toContain('src/genie.ts');
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

  test('injectTeamHooks upgrades legacy bare genie dispatch commands', async () => {
    const teamDir = join(testDir, 'teams', 'test-team');
    await mkdir(teamDir, { recursive: true });

    const settingsPath = join(teamDir, 'settings.json');
    await writeFile(
      settingsPath,
      JSON.stringify({
        hooks: Object.fromEntries(
          DISPATCHED_EVENTS.map((event) => [
            event,
            [{ hooks: [{ type: 'command', command: 'genie hook dispatch', timeout: 15 }] }],
          ]),
        ),
      }),
    );

    const result = await injectTeamHooks('test-team');
    expect(result).toBe(true);

    const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
    for (const event of DISPATCHED_EVENTS) {
      const command = settings.hooks[event][0].hooks[0].command;
      expect(command).toContain('hook dispatch');
      expect(command).toContain('src/genie.ts');
    }
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

  // Mac-CPU fix D — narrow matchers + drop empty events
  describe('Mac-CPU fix D — narrowed matchers + dropped empty events', () => {
    test('DISPATCHED_EVENT_MATCHERS only wires events that have handlers', () => {
      // PreToolUse + PostToolUse are the only events with registered handlers
      // (UserPromptSubmit and Stop have handlers too, but inject path is
      // claude-only and those aren't currently wired through this layer)
      expect(Object.keys(DISPATCHED_EVENT_MATCHERS).sort()).toEqual(['PostToolUse', 'PreToolUse']);
      // Empty-handler events MUST NOT be wired
      expect(DISPATCHED_EVENT_MATCHERS).not.toHaveProperty('SessionStart');
      expect(DISPATCHED_EVENT_MATCHERS).not.toHaveProperty('SessionEnd');
      expect(DISPATCHED_EVENT_MATCHERS).not.toHaveProperty('TeammateIdle');
      expect(DISPATCHED_EVENT_MATCHERS).not.toHaveProperty('TaskCompleted');
    });

    test('PostToolUse is wired with SendMessage matcher (not "*")', async () => {
      await injectTeamHooks('test-team');
      const settingsPath = join(testDir, 'teams', 'test-team', 'settings.json');
      const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
      // The genie entry for PostToolUse must be SendMessage, not '*'
      const postToolUseEntries = settings.hooks.PostToolUse;
      expect(postToolUseEntries).toBeDefined();
      const genieEntry = postToolUseEntries.find((e: { matcher?: string }) => e.matcher === 'SendMessage');
      expect(genieEntry).toBeDefined();
      // No genie entry should have '*' matcher under PostToolUse
      const wildcardGenie = postToolUseEntries.find(
        (e: { matcher?: string; hooks?: Array<{ command?: string }> }) =>
          e.matcher === '*' && e.hooks?.some((h) => h.command?.includes('hook dispatch')),
      );
      expect(wildcardGenie).toBeUndefined();
    });

    test('injectIntoFile prunes obsolete genie entries (SessionStart, etc.) on re-inject', async () => {
      const teamDir = join(testDir, 'teams', 'test-team');
      await mkdir(teamDir, { recursive: true });
      const settingsPath = join(teamDir, 'settings.json');

      // Simulate pre-fix-D settings: SessionStart/SessionEnd/TeammateIdle/TaskCompleted
      // wired with the genie dispatch command
      const stalePath = '/path/to/genie/src/genie.ts';
      const staleCmd = `bun run '${stalePath}' hook dispatch`;
      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: staleCmd, timeout: 15 }] }],
            PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: staleCmd, timeout: 15 }] }],
            SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: staleCmd, timeout: 15 }] }],
            SessionEnd: [{ matcher: '*', hooks: [{ type: 'command', command: staleCmd, timeout: 15 }] }],
            TeammateIdle: [{ matcher: '*', hooks: [{ type: 'command', command: staleCmd, timeout: 15 }] }],
            TaskCompleted: [{ matcher: '*', hooks: [{ type: 'command', command: staleCmd, timeout: 15 }] }],
          },
        }),
      );

      const result = await injectTeamHooks('test-team');
      expect(result).toBe(true); // re-injected (changes detected)

      const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
      // Obsolete events with only-genie entries should be DELETED entirely
      expect(settings.hooks.SessionStart).toBeUndefined();
      expect(settings.hooks.SessionEnd).toBeUndefined();
      expect(settings.hooks.TeammateIdle).toBeUndefined();
      expect(settings.hooks.TaskCompleted).toBeUndefined();
      // Active events should remain
      expect(settings.hooks.PreToolUse).toBeDefined();
      expect(settings.hooks.PostToolUse).toBeDefined();
      // PostToolUse matcher must be narrowed
      expect(settings.hooks.PostToolUse[0].matcher).toBe('SendMessage');
    });

    test('injectIntoFile preserves user-defined hooks under obsolete events', async () => {
      const teamDir = join(testDir, 'teams', 'test-team');
      await mkdir(teamDir, { recursive: true });
      const settingsPath = join(teamDir, 'settings.json');

      // User has their own SessionStart hook (not genie's) — must be preserved
      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo user-hook', timeout: 5 }] }],
          },
        }),
      );

      await injectTeamHooks('test-team');

      const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
      // User's SessionStart hook MUST survive
      expect(settings.hooks.SessionStart).toBeDefined();
      expect(settings.hooks.SessionStart[0].hooks[0].command).toBe('echo user-hook');
    });
  });
});
