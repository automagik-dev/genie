import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Executor } from './executor-types.js';
import type { IdleDeps } from './idle-timeout.js';
import { WATCHDOG_POLL_INTERVAL_MS, checkIdleWorkers, getIdleTimeoutMs, suspendWorker } from './idle-timeout.js';

// ============================================================================
// Mock deps — injected directly, no mock.module needed
// ============================================================================

let mockExecutors: Executor[] = [];
let mockTerminated: string[] = [];
let mockStateUpdates: Array<{ id: string; state: string }> = [];
let mockExecuteTmuxCalls: string[] = [];
let mockPaneAliveMap: Record<string, boolean> = {};

function makeDeps(): IdleDeps {
  return {
    listExecutors: async () => mockExecutors,
    terminateExecutor: async (id: string) => {
      mockTerminated.push(id);
      const e = mockExecutors.find((e) => e.id === id);
      if (e) e.state = 'terminated';
    },
    updateExecutorState: async (id: string, state: Executor['state']) => {
      mockStateUpdates.push({ id, state });
      const e = mockExecutors.find((e) => e.id === id);
      if (e) e.state = state;
    },
    executeTmux: async (cmd: string) => {
      mockExecuteTmuxCalls.push(cmd);
      return '';
    },
    isPaneAlive: async (paneId: string) => mockPaneAliveMap[paneId] ?? false,
  };
}

// ============================================================================
// Helpers
// ============================================================================

function makeExecutor(overrides: Partial<Executor> = {}): Executor {
  return {
    id: `exec-${Math.random().toString(36).slice(2, 8)}`,
    agentId: `agent-${Math.random().toString(36).slice(2, 8)}`,
    provider: 'claude',
    transport: 'tmux',
    pid: null,
    tmuxSession: 'genie',
    tmuxPaneId: `%${Math.floor(Math.random() * 100)}`,
    tmuxWindow: null,
    tmuxWindowId: null,
    claudeSessionId: null,
    state: 'idle',
    metadata: {},
    worktree: null,
    repoPath: '/tmp/test',
    paneColor: null,
    startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    endedAt: null,
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h ago
    turnId: null,
    outcome: null,
    closedAt: null,
    closeReason: null,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('idle-timeout', () => {
  beforeEach(() => {
    mockExecutors = [];
    mockTerminated = [];
    mockStateUpdates = [];
    mockExecuteTmuxCalls = [];
    mockPaneAliveMap = {};
    process.env.GENIE_IDLE_TIMEOUT_MS = undefined;
  });

  afterEach(() => {
    process.env.GENIE_IDLE_TIMEOUT_MS = undefined;
  });

  describe('getIdleTimeoutMs', () => {
    test('returns default 30 minutes when env not set', () => {
      expect(getIdleTimeoutMs()).toBe(30 * 60 * 1000);
    });

    test('reads GENIE_IDLE_TIMEOUT_MS env var', () => {
      process.env.GENIE_IDLE_TIMEOUT_MS = '60000';
      expect(getIdleTimeoutMs()).toBe(60000);
    });

    test('returns 0 when env is 0 (disabled)', () => {
      process.env.GENIE_IDLE_TIMEOUT_MS = '0';
      expect(getIdleTimeoutMs()).toBe(0);
    });

    test('returns default for invalid env value', () => {
      process.env.GENIE_IDLE_TIMEOUT_MS = 'not-a-number';
      expect(getIdleTimeoutMs()).toBe(30 * 60 * 1000);
    });

    test('returns default for empty string', () => {
      process.env.GENIE_IDLE_TIMEOUT_MS = '';
      expect(getIdleTimeoutMs()).toBe(30 * 60 * 1000);
    });

    test('returns default for negative value', () => {
      process.env.GENIE_IDLE_TIMEOUT_MS = '-5000';
      expect(getIdleTimeoutMs()).toBe(30 * 60 * 1000);
    });
  });

  describe('WATCHDOG_POLL_INTERVAL_MS', () => {
    test('is 60 seconds', () => {
      expect(WATCHDOG_POLL_INTERVAL_MS).toBe(60_000);
    });
  });

  describe('suspendWorker', () => {
    test('returns false for non-existent executor', async () => {
      const result = await suspendWorker('nonexistent', makeDeps());
      expect(result).toBe(false);
    });

    test('returns true for already-terminated executor', async () => {
      const e = makeExecutor({ state: 'terminated' });
      mockExecutors.push(e);
      const result = await suspendWorker(e.id, makeDeps());
      expect(result).toBe(true);
      expect(mockExecuteTmuxCalls).toHaveLength(0);
    });

    test('kills pane and terminates idle executor', async () => {
      const e = makeExecutor({ tmuxPaneId: '%42' });
      mockExecutors.push(e);

      const result = await suspendWorker(e.id, makeDeps());
      expect(result).toBe(true);
      expect(mockExecuteTmuxCalls).toContain("kill-pane -t '%42'");
      expect(mockTerminated).toContain(e.id);
    });

    test('skips pane kill for executors without pane', async () => {
      const e = makeExecutor({ tmuxPaneId: null, transport: 'api' });
      mockExecutors.push(e);

      const result = await suspendWorker(e.id, makeDeps());
      expect(result).toBe(true);
      expect(mockExecuteTmuxCalls).toHaveLength(0);
    });
  });

  describe('checkIdleWorkers', () => {
    test('returns empty when timeout is disabled', async () => {
      process.env.GENIE_IDLE_TIMEOUT_MS = '0';
      const e = makeExecutor();
      mockExecutors.push(e);
      mockPaneAliveMap[e.tmuxPaneId!] = true;

      const result = await checkIdleWorkers(makeDeps());
      expect(result).toHaveLength(0);
    });

    test('skips non-idle executors', async () => {
      process.env.GENIE_IDLE_TIMEOUT_MS = '1000';
      const e = makeExecutor({ state: 'working' });
      mockExecutors.push(e);
      mockPaneAliveMap[e.tmuxPaneId!] = true;

      const result = await checkIdleWorkers(makeDeps());
      expect(result).toHaveLength(0);
    });

    test('skips already-terminated executors', async () => {
      process.env.GENIE_IDLE_TIMEOUT_MS = '1000';
      const e = makeExecutor({
        state: 'terminated',
        updatedAt: new Date(Date.now() - 5000).toISOString(),
      });
      mockExecutors.push(e);

      const result = await checkIdleWorkers(makeDeps());
      expect(result).toHaveLength(0);
    });

    test('skips executors within timeout window', async () => {
      process.env.GENIE_IDLE_TIMEOUT_MS = String(2 * 60 * 60 * 1000); // 2h
      const e = makeExecutor({
        updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30m ago
      });
      mockExecutors.push(e);
      mockPaneAliveMap[e.tmuxPaneId!] = true;

      const result = await checkIdleWorkers(makeDeps());
      expect(result).toHaveLength(0);
    });

    test('terminates idle executors past timeout', async () => {
      process.env.GENIE_IDLE_TIMEOUT_MS = '1000'; // 1s
      const e = makeExecutor({
        updatedAt: new Date(Date.now() - 5000).toISOString(), // 5s ago
      });
      mockExecutors.push(e);
      mockPaneAliveMap[e.tmuxPaneId!] = true;

      const result = await checkIdleWorkers(makeDeps());
      expect(result).toContain(e.id);
    });

    test('marks dead-pane executors as terminated without kill', async () => {
      process.env.GENIE_IDLE_TIMEOUT_MS = '1000';
      const e = makeExecutor({
        updatedAt: new Date(Date.now() - 5000).toISOString(),
      });
      mockExecutors.push(e);
      mockPaneAliveMap[e.tmuxPaneId!] = false;

      const result = await checkIdleWorkers(makeDeps());
      expect(result).toContain(e.id);
      // Should not have kill-pane call (pane already dead, goes direct terminate path)
      expect(mockExecuteTmuxCalls.filter((c) => c.includes('kill-pane'))).toHaveLength(0);
    });

    test('terminates multiple idle executors', async () => {
      process.env.GENIE_IDLE_TIMEOUT_MS = '1000';
      const e1 = makeExecutor({
        id: 'exec-1',
        tmuxPaneId: '%10',
        updatedAt: new Date(Date.now() - 5000).toISOString(),
      });
      const e2 = makeExecutor({
        id: 'exec-2',
        tmuxPaneId: '%11',
        updatedAt: new Date(Date.now() - 5000).toISOString(),
      });
      mockExecutors.push(e1, e2);
      mockPaneAliveMap['%10'] = true;
      mockPaneAliveMap['%11'] = true;

      const result = await checkIdleWorkers(makeDeps());
      expect(result).toHaveLength(2);
      expect(result).toContain('exec-1');
      expect(result).toContain('exec-2');
    });
  });
});
