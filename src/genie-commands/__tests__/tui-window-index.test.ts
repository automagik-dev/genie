/**
 * Tests for TUI window targeting — verifies that createTuiSession uses
 * the actual window ID from listWindows instead of hardcoding ':0'.
 *
 * Covers: https://github.com/automagik-dev/genie/issues/519
 * Run with: bun test src/genie-commands/__tests__/tui-window-index.test.ts
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';

// ============================================================================
// Mock setup — must be before imports
// ============================================================================

let mockTmuxCalls: string[] = [];
let mockSessionExists = false;
let mockWindowId = '@0'; // default window ID

// Mock tmux module
mock.module('../../lib/tmux.js', () => ({
  createSession: async (name: string) => {
    mockTmuxCalls.push(`createSession:${name}`);
    return { id: '$1', name, attached: false, windows: 1 };
  },
  listWindows: async (sessionId: string) => {
    mockTmuxCalls.push(`listWindows:${sessionId}`);
    return [{ id: mockWindowId, name: 'bash', active: true, sessionId }];
  },
  findSessionByName: async (name: string) => {
    mockTmuxCalls.push(`findSessionByName:${name}`);
    if (mockSessionExists) {
      return { id: '$1', name, attached: false, windows: 1 };
    }
    // After createSession is called, return the session
    if (mockTmuxCalls.some((c) => c.startsWith('createSession:'))) {
      return { id: '$1', name, attached: false, windows: 1 };
    }
    return null;
  },
  executeTmux: async (cmd: string) => {
    mockTmuxCalls.push(`executeTmux:${cmd}`);
    return '';
  },
  ensureTeamWindow: async () => ({ windowId: '@1', windowName: 'team', paneId: '%0', created: false }),
  killSession: async () => {},
}));

// Mock claude-native-teams (avoid filesystem side effects)
mock.module('../../lib/claude-native-teams.js', () => ({
  ensureNativeTeam: async () => {},
  registerNativeMember: async () => {},
  sanitizeTeamName: (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, '_'),
  deleteNativeTeam: async () => {},
}));

// Mock child_process.spawnSync to prevent actual tmux attach
mock.module('node:child_process', () => ({
  spawnSync: (..._args: unknown[]) => ({ status: 0 }),
}));

// Import after mocks
const { tuiCommand } = await import('../tui.js');

// ============================================================================
// Tests
// ============================================================================

describe('TUI window targeting (issue #519)', () => {
  beforeEach(() => {
    mockTmuxCalls = [];
    mockSessionExists = false;
    mockWindowId = '@0';
  });

  test('uses window ID from listWindows, not hardcoded :0', async () => {
    mockWindowId = '@0';
    await tuiCommand({ name: 'test-tui', dir: '/tmp' });

    // Should have called listWindows to discover actual window
    const listWindowsCalls = mockTmuxCalls.filter((c) => c.startsWith('listWindows:'));
    expect(listWindowsCalls.length).toBeGreaterThanOrEqual(1);

    // rename-window should target the window ID, not 'test-tui:0'
    const renameCalls = mockTmuxCalls.filter((c) => c.includes('rename-window'));
    expect(renameCalls.length).toBe(1);
    expect(renameCalls[0]).toContain("'@0'");
    expect(renameCalls[0]).not.toContain(':0');
  });

  test('works when base-index is 1 (window @1)', async () => {
    mockWindowId = '@1';
    await tuiCommand({ name: 'test-tui', dir: '/tmp' });

    const renameCalls = mockTmuxCalls.filter((c) => c.includes('rename-window'));
    expect(renameCalls.length).toBe(1);
    expect(renameCalls[0]).toContain("'@1'");

    const setOptionCalls = mockTmuxCalls.filter((c) => c.includes('set-window-option'));
    expect(setOptionCalls.length).toBe(1);
    expect(setOptionCalls[0]).toContain("'@1'");
  });

  test('works with arbitrary window ID (@5)', async () => {
    mockWindowId = '@5';
    await tuiCommand({ name: 'test-tui', dir: '/tmp' });

    const renameCalls = mockTmuxCalls.filter((c) => c.includes('rename-window'));
    expect(renameCalls[0]).toContain("'@5'");
  });

  test('does not contain hardcoded :0 in any tmux call', async () => {
    mockWindowId = '@3';
    await tuiCommand({ name: 'mytest', dir: '/tmp' });

    const hardcoded = mockTmuxCalls.filter((c) => c.includes("'mytest:0'") || c.includes('"mytest:0"'));
    expect(hardcoded).toEqual([]);
  });

  test('skips session creation if session already exists', async () => {
    mockSessionExists = true;
    await tuiCommand({ name: 'test-tui', dir: '/tmp' });

    const createCalls = mockTmuxCalls.filter((c) => c.startsWith('createSession:'));
    expect(createCalls).toEqual([]);
    const listWindowsCalls = mockTmuxCalls.filter((c) => c.startsWith('listWindows:'));
    expect(listWindowsCalls).toEqual([]);
  });
});
