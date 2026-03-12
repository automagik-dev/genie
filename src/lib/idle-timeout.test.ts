import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Agent } from './agent-registry.js';
import type { IdleDeps } from './idle-timeout.js';
import { WATCHDOG_POLL_INTERVAL_MS, checkIdleWorkers, getIdleTimeoutMs, suspendWorker } from './idle-timeout.js';

// ============================================================================
// Mock deps — injected directly, no mock.module needed
// ============================================================================

let mockWorkers: Agent[] = [];
let mockUpdates: Array<{ id: string; updates: Partial<Agent> }> = [];
let mockExecuteTmuxCalls: string[] = [];
let mockPaneAliveMap: Record<string, boolean> = {};

function makeDeps(): IdleDeps {
  return {
    registryGet: async (id: string) => mockWorkers.find((w) => w.id === id) ?? null,
    registryList: async () => mockWorkers,
    registryUpdate: async (id: string, updates: Partial<Agent>) => {
      mockUpdates.push({ id, updates });
      const w = mockWorkers.find((w) => w.id === id);
      if (w) Object.assign(w, updates);
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

function makeWorker(overrides: Partial<Agent> = {}): Agent {
  return {
    id: `test-worker-${Math.random().toString(36).slice(2, 8)}`,
    paneId: `%${Math.floor(Math.random() * 100)}`,
    session: 'genie',
    state: 'idle',
    lastStateChange: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h ago
    startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    repoPath: '/tmp/test',
    provider: 'claude',
    transport: 'tmux',
    team: 'test-team',
    ...overrides,
  } as Agent;
}

// ============================================================================
// Tests
// ============================================================================

describe('idle-timeout', () => {
  beforeEach(() => {
    mockWorkers = [];
    mockUpdates = [];
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
    test('returns false for non-existent worker', async () => {
      const result = await suspendWorker('nonexistent', makeDeps());
      expect(result).toBe(false);
    });

    test('returns true for already-suspended worker', async () => {
      const w = makeWorker({ state: 'suspended' });
      mockWorkers.push(w);
      const result = await suspendWorker(w.id, makeDeps());
      expect(result).toBe(true);
      expect(mockExecuteTmuxCalls).toHaveLength(0);
    });

    test('kills pane and updates state for idle worker', async () => {
      const w = makeWorker({ paneId: '%42' });
      mockWorkers.push(w);

      const result = await suspendWorker(w.id, makeDeps());
      expect(result).toBe(true);
      expect(mockExecuteTmuxCalls).toContain("kill-pane -t '%42'");
      expect(mockUpdates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: w.id,
            updates: expect.objectContaining({ state: 'suspended' }),
          }),
        ]),
      );
    });

    test('skips pane kill for inline workers', async () => {
      const w = makeWorker({ paneId: 'inline' });
      mockWorkers.push(w);

      const result = await suspendWorker(w.id, makeDeps());
      expect(result).toBe(true);
      expect(mockExecuteTmuxCalls).toHaveLength(0);
    });

    test('sets suspendedAt timestamp', async () => {
      const w = makeWorker();
      mockWorkers.push(w);

      await suspendWorker(w.id, makeDeps());
      const update = mockUpdates.find((u) => u.id === w.id);
      expect(update?.updates.suspendedAt).toBeDefined();
      const ts = new Date(update?.updates.suspendedAt as string).getTime();
      expect(ts).toBeGreaterThan(Date.now() - 5000);
    });
  });

  describe('checkIdleWorkers', () => {
    test('returns empty when timeout is disabled', async () => {
      process.env.GENIE_IDLE_TIMEOUT_MS = '0';
      const w = makeWorker();
      mockWorkers.push(w);
      mockPaneAliveMap[w.paneId] = true;

      const result = await checkIdleWorkers(makeDeps());
      expect(result).toHaveLength(0);
    });

    test('skips non-idle workers', async () => {
      process.env.GENIE_IDLE_TIMEOUT_MS = '1000';
      const w = makeWorker({ state: 'working' });
      mockWorkers.push(w);
      mockPaneAliveMap[w.paneId] = true;

      const result = await checkIdleWorkers(makeDeps());
      expect(result).toHaveLength(0);
    });

    test('skips already-suspended workers', async () => {
      process.env.GENIE_IDLE_TIMEOUT_MS = '1000';
      const w = makeWorker({
        state: 'suspended',
        lastStateChange: new Date(Date.now() - 5000).toISOString(),
      });
      mockWorkers.push(w);

      const result = await checkIdleWorkers(makeDeps());
      expect(result).toHaveLength(0);
    });

    test('skips workers within timeout window', async () => {
      process.env.GENIE_IDLE_TIMEOUT_MS = String(2 * 60 * 60 * 1000); // 2h
      const w = makeWorker({
        lastStateChange: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30m ago
      });
      mockWorkers.push(w);
      mockPaneAliveMap[w.paneId] = true;

      const result = await checkIdleWorkers(makeDeps());
      expect(result).toHaveLength(0);
    });

    test('suspends idle workers past timeout', async () => {
      process.env.GENIE_IDLE_TIMEOUT_MS = '1000'; // 1s
      const w = makeWorker({
        lastStateChange: new Date(Date.now() - 5000).toISOString(), // 5s ago
      });
      mockWorkers.push(w);
      mockPaneAliveMap[w.paneId] = true;

      const result = await checkIdleWorkers(makeDeps());
      expect(result).toContain(w.id);
    });

    test('marks dead-pane workers as suspended without kill', async () => {
      process.env.GENIE_IDLE_TIMEOUT_MS = '1000';
      const w = makeWorker({
        lastStateChange: new Date(Date.now() - 5000).toISOString(),
      });
      mockWorkers.push(w);
      mockPaneAliveMap[w.paneId] = false;

      const result = await checkIdleWorkers(makeDeps());
      expect(result).toContain(w.id);
      // Should not have kill-pane call (pane already dead, goes direct update path)
      expect(mockExecuteTmuxCalls.filter((c) => c.includes('kill-pane'))).toHaveLength(0);
    });

    test('suspends multiple idle workers', async () => {
      process.env.GENIE_IDLE_TIMEOUT_MS = '1000';
      const w1 = makeWorker({
        id: 'worker-1',
        paneId: '%10',
        lastStateChange: new Date(Date.now() - 5000).toISOString(),
      });
      const w2 = makeWorker({
        id: 'worker-2',
        paneId: '%11',
        lastStateChange: new Date(Date.now() - 5000).toISOString(),
      });
      mockWorkers.push(w1, w2);
      mockPaneAliveMap['%10'] = true;
      mockPaneAliveMap['%11'] = true;

      const result = await checkIdleWorkers(makeDeps());
      expect(result).toHaveLength(2);
      expect(result).toContain('worker-1');
      expect(result).toContain('worker-2');
    });
  });
});
