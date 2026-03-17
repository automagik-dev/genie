/**
 * Tests for team-auto-spawn module
 *
 * Tests the core logic of isTeamActive and ensureTeamLead using dependency
 * injection — no real tmux sessions required.
 *
 * Run with: bun test src/lib/team-auto-spawn.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TeamAutoSpawnDeps } from './team-auto-spawn.js';
import { ensureTeamLead, isTeamActive } from './team-auto-spawn.js';

// ============================================================================
// Test helpers
// ============================================================================

/** Create a minimal deps object with sensible defaults. Override as needed. */
function makeDeps(overrides: Partial<TeamAutoSpawnDeps> = {}): TeamAutoSpawnDeps {
  return {
    loadConfig: async () => ({
      name: 'test-team',
      description: '',
      createdAt: Date.now(),
      leadAgentId: '',
      leadSessionId: '',
      members: [],
    }),
    findSessionByName: async () => ({ id: '$0', name: 'genie', attached: false, windows: 1 }),
    listWindows: async () => [{ id: '@1', name: 'test-team', active: false, sessionId: 'genie' }],
    listPanes: async () => [{ id: '%1', windowId: '@1', active: true, title: '' }],
    isPaneAlive: async () => true,
    getTeamLeadEntry: async () => null,
    saveTeamLeadEntry: async () => {},
    ensureNativeTeam: async () =>
      ({
        name: 'test-team',
        description: '',
        createdAt: Date.now(),
        leadAgentId: '',
        leadSessionId: '',
        members: [],
      }) as any,
    registerNativeMember: async () => {},
    createSession: async () => ({ id: '$0', name: 'genie', attached: false, windows: 0 }),
    ensureTeamWindow: async () => ({ windowId: '@2', windowName: 'test-team', paneId: '%5', created: true }),
    executeTmux: async () => '',
    existsSync: () => false,
    buildTeamLeadCommand: () => 'claude --team test-team',
    now: () => Date.now(),
    ...overrides,
  };
}

// ============================================================================
// isTeamActive tests
// ============================================================================

describe('isTeamActive', () => {
  test('returns false when no config exists', async () => {
    const deps = makeDeps({ loadConfig: async () => null });
    expect(await isTeamActive('test-team', 'genie', deps)).toBe(false);
  });

  test('returns false when no tmux session exists', async () => {
    const deps = makeDeps({ findSessionByName: async () => null });
    expect(await isTeamActive('test-team', 'genie', deps)).toBe(false);
  });

  test('returns false when no matching window exists', async () => {
    const deps = makeDeps({ listWindows: async () => [] });
    expect(await isTeamActive('test-team', 'genie', deps)).toBe(false);
  });

  test('returns false when window has no panes', async () => {
    const deps = makeDeps({ listPanes: async () => [] });
    expect(await isTeamActive('test-team', 'genie', deps)).toBe(false);
  });

  test('window exists + pane alive → returns true', async () => {
    const deps = makeDeps({ isPaneAlive: async () => true });
    expect(await isTeamActive('test-team', 'genie', deps)).toBe(true);
  });

  test('window exists + pane dead → returns false', async () => {
    const deps = makeDeps({
      isPaneAlive: async () => false,
      getTeamLeadEntry: async () => null,
    });
    expect(await isTeamActive('test-team', 'genie', deps)).toBe(false);
  });

  test('window exists + pane dead + spawned < 30s ago → returns true (grace period)', async () => {
    const now = Date.now();
    const deps = makeDeps({
      isPaneAlive: async () => false,
      getTeamLeadEntry: async () => ({
        id: 'team-lead:test-team',
        paneId: '%1',
        session: 'genie',
        worktree: null,
        startedAt: new Date(now - 15_000).toISOString(), // 15s ago
        state: 'spawning',
        lastStateChange: new Date().toISOString(),
        repoPath: '/tmp/test',
        role: 'team-lead',
        team: 'test-team',
      }),
      now: () => now,
    });
    expect(await isTeamActive('test-team', 'genie', deps)).toBe(true);
  });

  test('window exists + pane dead + spawned > 30s ago → returns false (grace expired)', async () => {
    const now = Date.now();
    const deps = makeDeps({
      isPaneAlive: async () => false,
      getTeamLeadEntry: async () => ({
        id: 'team-lead:test-team',
        paneId: '%1',
        session: 'genie',
        worktree: null,
        startedAt: new Date(now - 60_000).toISOString(), // 60s ago
        state: 'spawning',
        lastStateChange: new Date().toISOString(),
        repoPath: '/tmp/test',
        role: 'team-lead',
        team: 'test-team',
      }),
      now: () => now,
    });
    expect(await isTeamActive('test-team', 'genie', deps)).toBe(false);
  });

  test('handles listWindows error gracefully', async () => {
    const deps = makeDeps({
      listWindows: async () => {
        throw new Error('tmux: no server running');
      },
    });
    expect(await isTeamActive('test-team', 'genie', deps)).toBe(false);
  });
});

// ============================================================================
// ensureTeamLead tests
// ============================================================================

describe('ensureTeamLead', () => {
  test('returns immediately if team is already active', async () => {
    let saveCalled = false;
    const deps = makeDeps({
      isPaneAlive: async () => true,
      saveTeamLeadEntry: async () => {
        saveCalled = true;
      },
    });
    const result = await ensureTeamLead('test-team', '/tmp/work', deps);
    expect(result.created).toBe(false);
    expect(saveCalled).toBe(false);
  });

  test('stores pane ID in registry on new spawn', async () => {
    let savedPaneId = '' as string;
    let savedTeam = '' as string;
    const deps = makeDeps({
      // Make isTeamActive return false (no config)
      loadConfig: async () => null,
      ensureTeamWindow: async () => ({ windowId: '@3', windowName: 'test-team', paneId: '%42', created: true }),
      saveTeamLeadEntry: async (teamName, paneId) => {
        savedTeam = teamName;
        savedPaneId = paneId;
      },
    });
    const result = await ensureTeamLead('test-team', '/tmp/work', deps);
    expect(result.created).toBe(true);
    expect(savedPaneId).toBe('%42');
    expect(savedTeam).toBe('test-team');
  });

  test('cleans up stale window and re-creates', async () => {
    const killedWindows: string[] = [];
    let spawnCount = 0;
    const deps = makeDeps({
      // isTeamActive returns false (pane dead, grace expired)
      loadConfig: async () => null,
      // But a stale window exists in the session
      findSessionByName: async () => ({ id: '$0', name: 'genie', attached: false, windows: 1 }),
      listWindows: async () => [{ id: '@1', name: 'test-team', active: false, sessionId: 'genie' }],
      executeTmux: async (cmd) => {
        if (cmd.includes('kill-window')) {
          killedWindows.push(cmd);
        }
        return '';
      },
      ensureTeamWindow: async () => {
        spawnCount++;
        return { windowId: '@2', windowName: 'test-team', paneId: '%10', created: true };
      },
      saveTeamLeadEntry: async () => {},
    });
    const result = await ensureTeamLead('test-team', '/tmp/work', deps);
    expect(result.created).toBe(true);
    expect(killedWindows.length).toBe(1);
    expect(killedWindows[0]).toContain('kill-window');
    expect(spawnCount).toBe(1);
  });

  test('saves registry even when window already existed (not created)', async () => {
    let savedPaneId = '' as string;
    const deps = makeDeps({
      loadConfig: async () => null,
      findSessionByName: async () => null, // No existing session to clean up
      ensureTeamWindow: async () => ({ windowId: '@3', windowName: 'test-team', paneId: '%7', created: false }),
      saveTeamLeadEntry: async (_teamName, paneId) => {
        savedPaneId = paneId;
      },
    });
    const result = await ensureTeamLead('test-team', '/tmp/work', deps);
    expect(result.created).toBe(false);
    expect(savedPaneId).toBe('%7');
  });
});

// ============================================================================
// Config.json detection (preserved from original)
// ============================================================================

describe('team-auto-spawn: config.json detection', () => {
  const TEST_DIR = '/tmp/team-auto-spawn-test';
  const TEAMS_DIR = join(TEST_DIR, '.claude', 'teams');

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEAMS_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('team directory without config.json means team is not set up', () => {
    const teamDir = join(TEAMS_DIR, 'my-team');
    mkdirSync(teamDir, { recursive: true });
    mkdirSync(join(teamDir, 'inboxes'), { recursive: true });

    expect(existsSync(join(teamDir, 'config.json'))).toBe(false);
    expect(existsSync(join(teamDir, 'inboxes'))).toBe(true);
  });

  test('team directory with config.json means team is set up', () => {
    const teamDir = join(TEAMS_DIR, 'my-team');
    mkdirSync(teamDir, { recursive: true });
    mkdirSync(join(teamDir, 'inboxes'), { recursive: true });

    const config = {
      name: 'my-team',
      description: 'Genie team: my-team',
      createdAt: Date.now(),
      leadAgentId: 'team-lead@my-team',
      leadSessionId: 'pending',
      members: [],
    };
    writeFileSync(join(teamDir, 'config.json'), JSON.stringify(config, null, 2));

    expect(existsSync(join(teamDir, 'config.json'))).toBe(true);
    const loaded = JSON.parse(readFileSync(join(teamDir, 'config.json'), 'utf-8'));
    expect(loaded.name).toBe('my-team');
    expect(loaded.leadAgentId).toBe('team-lead@my-team');
  });

  test('inbox file can exist without config.json (the gap we are fixing)', () => {
    const teamDir = join(TEAMS_DIR, 'orphan-team');
    const inboxDir = join(teamDir, 'inboxes');
    mkdirSync(inboxDir, { recursive: true });

    const inboxMessage = [
      {
        from: 'omni',
        text: 'Hello from Omni',
        summary: 'Hello from Omni',
        timestamp: new Date().toISOString(),
        read: false,
      },
    ];
    writeFileSync(join(inboxDir, 'team-lead.json'), JSON.stringify(inboxMessage, null, 2));

    expect(existsSync(join(inboxDir, 'team-lead.json'))).toBe(true);
    expect(existsSync(join(teamDir, 'config.json'))).toBe(false);
  });
});

// ============================================================================
// EnsureTeamLeadResult type tests (preserved from original)
// ============================================================================

describe('team-auto-spawn: result types', () => {
  test('result shape for created team', () => {
    const result = { created: true, session: 'genie', window: 'my-team' };
    expect(result.created).toBe(true);
    expect(result.session).toBe('genie');
    expect(result.window).toBe('my-team');
  });

  test('result shape for existing team', () => {
    const result = { created: false, session: 'genie', window: 'my-team' };
    expect(result.created).toBe(false);
  });
});
