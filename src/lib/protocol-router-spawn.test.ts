/**
 * Protocol Router Spawn — Unit Tests
 *
 * Tests error surfacing in native inbox writes and resume context injection.
 * Uses mock.module to isolate from tmux, PG, and real file I/O.
 *
 * Run with: bun test src/lib/protocol-router-spawn.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

// ============================================================================
// Module mocks — isolate from tmux, PG, registry, native teams, mailbox
// ============================================================================

/** Track console.warn calls to verify error surfacing. */
let warnCalls: string[] = [];

/** Control whether writeNativeInbox should throw. */
let inboxWriteShouldFail = false;
let inboxWriteError = new Error('disk full');

/** Control whether mailbox.send should throw. */
let mailboxSendShouldFail = false;

/** Control whether findAnyGroupByAssignee returns a match. */
let wishGroupMatch: { slug: string; groupName: string; group: { status: string; startedAt: string } } | null = null;

mock.module('./claude-native-teams.js', () => ({
  ensureNativeTeam: async () => {},
  assignColor: async () => 'blue',
  registerNativeMember: async () => {},
  writeNativeInbox: async (_team: string, _target: string, _msg: unknown) => {
    if (inboxWriteShouldFail) throw inboxWriteError;
  },
  discoverClaudeParentSessionId: async () => 'parent-123',
}));

mock.module('./wish-state.js', () => ({
  findAnyGroupByAssignee: async () => wishGroupMatch,
}));

mock.module('./mailbox.js', () => ({
  send: async () => {
    if (mailboxSendShouldFail) throw new Error('PG connection refused');
    return {
      id: 'msg-1',
      from: 'genie',
      to: 'worker',
      body: 'resume',
      read: false,
      deliveredAt: null,
      createdAt: new Date().toISOString(),
    };
  },
}));

mock.module('./agent-registry.js', () => ({
  list: async () => [],
  register: async () => {},
  findOrCreateAgent: async (name: string, team: string) => ({ id: `${team}-${name}`, name, team }),
  saveTemplate: async () => {},
  setCurrentExecutor: async () => {},
}));

mock.module('./executor-registry.js', () => ({
  getCurrentExecutor: async () => null,
  createExecutor: async () => ({ id: 'exec-1' }),
  terminateActiveExecutor: async () => {},
}));

mock.module('./db.js', () => ({
  getConnection: async () => {
    const fakeSql: any = async () => [];
    fakeSql.begin = async (fn: any) => fn(fakeSql);
    return fakeSql;
  },
}));

mock.module('./team-manager.js', () => ({
  getTeam: async () => null,
  resolveLeaderName: async (team: string) => `${team}-lead`,
}));

mock.module('./provider-adapters.js', () => ({
  buildLaunchCommand: () => ({ command: 'echo test', env: {} }),
  validateSpawnParams: (p: any) => p,
}));

mock.module('./providers/registry.js', () => ({
  getProvider: () => null,
}));

mock.module('./tmux.js', () => ({
  applyPaneColor: async () => {},
  ensureTeamWindow: async () => ({ windowId: '@1', windowName: 'test' }),
  getCurrentSessionName: async () => 'test-session',
  listWindows: async () => [],
  resolveRepoSession: async () => 'test-session',
}));

mock.module('./tmux-wrapper.js', () => ({
  genieTmuxCmd: (cmd: string) => `tmux ${cmd}`,
}));

mock.module('./mosaic-layout.js', () => ({
  buildLayoutCommand: () => 'select-layout tiled',
  resolveLayoutMode: () => 'tiled',
}));

// Mock child_process.exec to avoid real tmux calls
mock.module('node:child_process', () => ({
  exec: (_cmd: string, cb: any) => {
    if (cb) cb(null, { stdout: '%999\n', stderr: '' });
    return { stdout: '%999\n' };
  },
}));

mock.module('node:util', () => ({
  promisify: () => async () => ({ stdout: '%999\n', stderr: '' }),
}));

// ============================================================================
// Tests
// ============================================================================

describe('protocol-router-spawn error surfacing', () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    inboxWriteShouldFail = false;
    inboxWriteError = new Error('disk full');
    mailboxSendShouldFail = false;
    wishGroupMatch = null;
    warnCalls = [];
    warnSpy = spyOn(console, 'warn').mockImplementation((...args: any[]) => {
      warnCalls.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Deliverable 1: Native inbox write error handling
  // -------------------------------------------------------------------------

  describe('native inbox write error handling', () => {
    test('failed inbox write logs warning with team and target', async () => {
      inboxWriteShouldFail = true;
      inboxWriteError = new Error('disk full');

      const { spawnWorkerFromTemplate } = await import('./protocol-router-spawn.js');

      const template = {
        id: 'test-team-engineer',
        team: 'test-team',
        role: 'engineer',
        provider: 'claude' as const,
        cwd: '/tmp/test-repo',
        lastSpawnedAt: new Date().toISOString(),
      };

      // Should NOT throw — inbox write failure is swallowed with a warning
      const result = await spawnWorkerFromTemplate(template);
      expect(result.worker).toBeTruthy();
      expect(result.paneId).toBe('%999');

      // Verify warning was logged with team name and target
      const inboxWarn = warnCalls.find((c) => c.includes('Native inbox write failed'));
      expect(inboxWarn).toBeTruthy();
      expect(inboxWarn).toContain('team="test-team"');
      expect(inboxWarn).toContain('target="test-team-lead"');
      expect(inboxWarn).toContain('disk full');
    });

    test('successful inbox write produces no warning', async () => {
      inboxWriteShouldFail = false;

      const { spawnWorkerFromTemplate } = await import('./protocol-router-spawn.js');

      const template = {
        id: 'test-team-worker',
        team: 'test-team',
        role: 'worker',
        provider: 'claude' as const,
        cwd: '/tmp/test-repo',
        lastSpawnedAt: new Date().toISOString(),
      };

      await spawnWorkerFromTemplate(template);

      const inboxWarn = warnCalls.find((c) => c.includes('Native inbox write failed'));
      expect(inboxWarn).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Deliverable 2: Resume context injection error surfacing
  // -------------------------------------------------------------------------

  describe('resume context injection error surfacing', () => {
    test('failed resume context injection logs warning', async () => {
      // Set up a matching group so injectResumeContext tries to build context
      wishGroupMatch = {
        slug: 'test-wish',
        groupName: '1',
        group: { status: 'in_progress', startedAt: '2026-03-31T00:00:00Z' },
      };
      // Make mailbox.send fail to trigger the catch path
      mailboxSendShouldFail = true;

      const { injectResumeContext } = await import('./protocol-router-spawn.js');

      // Should NOT throw — resume context is best-effort
      await injectResumeContext('/tmp/test-repo', 'worker-1', 'engineer', 'test-team');

      const resumeWarn = warnCalls.find((c) => c.includes('Resume context injection failed'));
      expect(resumeWarn).toBeTruthy();
      expect(resumeWarn).toContain('PG connection refused');
    });

    test('successful resume context injection produces no warning', async () => {
      wishGroupMatch = {
        slug: 'test-wish',
        groupName: '1',
        group: { status: 'in_progress', startedAt: '2026-03-31T00:00:00Z' },
      };
      mailboxSendShouldFail = false;

      const { injectResumeContext } = await import('./protocol-router-spawn.js');

      await injectResumeContext('/tmp/test-repo', 'worker-1', 'engineer', 'test-team');

      const resumeWarn = warnCalls.find((c) => c.includes('Resume context injection failed'));
      expect(resumeWarn).toBeUndefined();
    });

    test('no-op when no matching group exists', async () => {
      wishGroupMatch = null;

      const { injectResumeContext } = await import('./protocol-router-spawn.js');

      await injectResumeContext('/tmp/test-repo', 'worker-1', 'engineer', 'test-team');

      // No warnings at all — early return
      const anyWarn = warnCalls.find((c) => c.includes('[protocol-router]'));
      expect(anyWarn).toBeUndefined();
    });
  });
});
