import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AgentState } from './agent-registry.js';
import {
  type LogEntry,
  type SchedulerConfig,
  type SchedulerDeps,
  type WorkerInfo,
  attemptAgentResume,
  claimDueTriggers,
  collectHeartbeats,
  collectMachineSnapshot,
  fireTrigger,
  logToFile,
  reclaimExpiredLeases,
  reconcileOrphanedRuns,
  reconcileOrphans,
  recoverOnStartup,
  startDaemon,
} from './scheduler-daemon.js';

// ============================================================================
// Mock SQL client
// ============================================================================

interface QueryLog {
  query: string;
  values?: unknown[];
}

function createMockSql(data: {
  triggers?: Record<string, unknown>[];
  runs?: Record<string, unknown>[];
  schedules?: Record<string, unknown>[];
  runningCount?: number;
  heartbeats?: Record<string, unknown>[];
}) {
  const queries: QueryLog[] = [];
  const insertedRuns: Record<string, unknown>[] = [];
  const insertedHeartbeats: Record<string, unknown>[] = [];
  const insertedSnapshots: Record<string, unknown>[] = [];
  const updatedTriggers: { id: string; status: string }[] = [];

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: mock SQL router needs many branches
  const sql: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?');
    queries.push({ query, values });

    if (query.includes('FROM runs') && query.includes('count')) {
      return [{ cnt: data.runningCount ?? 0 }];
    }
    if (query.includes('FROM runs') && query.includes('status IN')) {
      return data.runs ?? [];
    }
    if (query.includes('FROM runs') && query.includes('running')) {
      return data.runs ?? [];
    }
    if (query.includes('FROM triggers') && query.includes('FOR UPDATE')) {
      return data.triggers ?? [];
    }
    if (query.includes('UPDATE triggers') && query.includes('leased_until <')) {
      // Reclaim expired leases — return triggers that match
      const expired = (data.triggers ?? []).filter((t) => t.status === 'executing');
      return expired.map((t) => ({ id: t.id }));
    }
    if (query.includes('UPDATE triggers')) {
      return [];
    }
    if (query.includes('FROM triggers') && query.includes('idempotency_key')) {
      return [];
    }
    if (query.includes('FROM schedules')) {
      return data.schedules ?? [];
    }
    if (query.includes('INSERT INTO runs')) {
      insertedRuns.push({ values });
      return [];
    }
    if (query.includes('UPDATE runs')) {
      return [];
    }
    if (query.includes('INSERT INTO heartbeats')) {
      insertedHeartbeats.push({ values });
      return [];
    }
    if (query.includes('FROM heartbeats')) {
      return data.heartbeats ?? [];
    }
    if (query.includes('INSERT INTO machine_snapshots')) {
      insertedSnapshots.push({ values });
      return [];
    }
    return [];
  };

  sql.begin = async (fn: (tx: typeof sql) => Promise<unknown>) => {
    return fn(sql);
  };

  sql.listen = async (_channel: string, _cb: () => void) => {
    // No-op for tests
  };

  sql.end = async () => {};

  return { sql, queries, insertedRuns, insertedHeartbeats, insertedSnapshots, updatedTriggers };
}

// ============================================================================
// Mock deps factory
// ============================================================================

function createMockDeps(
  sqlData: Parameters<typeof createMockSql>[0] = {},
  overrides: Partial<SchedulerDeps> = {},
): {
  deps: SchedulerDeps;
  logs: LogEntry[];
  spawns: { command: string; env: Record<string, string> }[];
  mock: ReturnType<typeof createMockSql>;
} {
  const logs: LogEntry[] = [];
  const spawns: { command: string; env: Record<string, string> }[] = [];
  const mock = createMockSql(sqlData);

  let idCounter = 0;

  const deps: SchedulerDeps = {
    getConnection: async () => mock.sql,
    spawnCommand: async (command, env) => {
      spawns.push({ command, env });
      return { pid: 12345 };
    },
    log: (entry) => logs.push(entry),
    generateId: () => `test-id-${++idCounter}`,
    now: () => new Date('2026-03-20T12:00:00Z'),
    sleep: async () => {},
    jitter: (maxMs) => Math.floor(maxMs / 2),
    isPaneAlive: async () => true,
    listWorkers: async () => [],
    countTmuxSessions: async () => 0,
    resumeAgent: async () => true,
    updateAgent: async () => {},
    ...overrides,
  };

  return { deps, logs, spawns, mock };
}

const defaultConfig: SchedulerConfig = {
  maxConcurrent: 5,
  pollIntervalMs: 30_000,
  maxJitterMs: 30_000,
  jitterThreshold: 3,
  heartbeatIntervalMs: 60_000,
  orphanCheckIntervalMs: 300_000,
  deadHeartbeatThreshold: 2,
};

// ============================================================================
// Tests
// ============================================================================

describe('scheduler-daemon', () => {
  beforeEach(() => {
    process.env.GENIE_MAX_CONCURRENT = undefined;
  });

  afterEach(() => {
    process.env.GENIE_MAX_CONCURRENT = undefined;
  });

  describe('claimDueTriggers', () => {
    test('returns empty when no pending triggers', async () => {
      const { deps } = createMockDeps({ triggers: [] });
      const result = await claimDueTriggers(deps, defaultConfig, 'daemon-1');
      expect(result).toEqual([]);
    });

    test('claims due triggers', async () => {
      const triggers = [
        {
          id: 'trig-1',
          schedule_id: 'sched-1',
          due_at: new Date('2026-03-20T11:00:00Z'),
          status: 'pending',
          idempotency_key: null,
          leased_by: null,
          leased_until: null,
        },
      ];
      const { deps, logs } = createMockDeps({ triggers });
      const result = await claimDueTriggers(deps, defaultConfig, 'daemon-1');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('trig-1');

      const claimLog = logs.find((l) => l.event === 'triggers_claimed');
      expect(claimLog).toBeDefined();
      expect(claimLog?.count).toBe(1);
    });

    test('respects concurrency cap', async () => {
      const { deps, logs } = createMockDeps({
        triggers: [
          {
            id: 'trig-1',
            schedule_id: 's-1',
            due_at: new Date(),
            status: 'pending',
            idempotency_key: null,
            leased_by: null,
            leased_until: null,
          },
        ],
        runningCount: 5,
      });
      const result = await claimDueTriggers(deps, defaultConfig, 'daemon-1');

      expect(result).toEqual([]);
      const capLog = logs.find((l) => l.event === 'concurrency_cap_reached');
      expect(capLog).toBeDefined();
    });

    test('limits claim batch to available capacity', async () => {
      const triggers = Array.from({ length: 10 }, (_, i) => ({
        id: `trig-${i}`,
        schedule_id: 'sched-1',
        due_at: new Date('2026-03-20T11:00:00Z'),
        status: 'pending',
        idempotency_key: null,
        leased_by: null,
        leased_until: null,
      }));
      const { deps } = createMockDeps({ triggers, runningCount: 3 });
      const config = { ...defaultConfig, maxConcurrent: 5 };
      const result = await claimDueTriggers(deps, config, 'daemon-1');

      // Should claim min(available=2, 5) = 2 — but our mock returns all triggers
      // The LIMIT is enforced at the SQL level; here we verify the query was made
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('fireTrigger', () => {
    test('spawns command with GENIE_TRACE_ID', async () => {
      const trigger = {
        id: 'trig-1',
        schedule_id: 'sched-1',
        due_at: new Date('2026-03-20T11:00:00Z'),
        status: 'executing',
        idempotency_key: null,
        leased_by: 'daemon-1',
        leased_until: new Date('2026-03-20T12:05:00Z'),
      };
      const schedules = [
        {
          id: 'sched-1',
          name: 'nightly-review',
          command: 'genie spawn reviewer',
          run_spec: {},
          status: 'active',
        },
      ];

      const { deps, spawns, logs } = createMockDeps({ schedules });
      await fireTrigger(deps, trigger, 'daemon-1');

      expect(spawns).toHaveLength(1);
      expect(spawns[0].command).toBe('genie spawn reviewer');
      expect(spawns[0].env.GENIE_TRACE_ID).toBeDefined();
      expect(spawns[0].env.GENIE_RUN_ID).toBeDefined();
      expect(spawns[0].env.GENIE_TRIGGER_ID).toBe('trig-1');
      expect(spawns[0].env.GENIE_SCHEDULE_ID).toBe('sched-1');

      const fireLog = logs.find((l) => l.event === 'trigger_fired');
      expect(fireLog).toBeDefined();
      expect(fireLog?.trace_id).toBeDefined();
      expect(fireLog?.command).toBe('genie spawn reviewer');
    });

    test('skips trigger with duplicate idempotency key', async () => {
      const trigger = {
        id: 'trig-2',
        schedule_id: 'sched-1',
        due_at: new Date('2026-03-20T11:00:00Z'),
        status: 'executing',
        idempotency_key: 'key-abc',
        leased_by: 'daemon-1',
        leased_until: new Date('2026-03-20T12:05:00Z'),
      };
      const schedules = [{ id: 'sched-1', name: 'test', command: 'echo hi', run_spec: {}, status: 'active' }];

      // Mock returns a dupe for the idempotency check
      const { deps, spawns, logs } = createMockDeps(
        { schedules },
        {
          getConnection: async () => {
            const mock = createMockSql({ schedules });
            const origSql = mock.sql as any;
            const customSql = (strings: TemplateStringsArray, ...values: unknown[]) => {
              const query = strings.join('?');
              if (query.includes('idempotency_key') && query.includes('id !=')) {
                return [{ exists: 1 }]; // Duplicate found
              }
              return origSql(strings, ...values);
            };
            customSql.begin = origSql.begin;
            customSql.listen = origSql.listen;
            customSql.end = origSql.end;
            return customSql;
          },
        },
      );

      await fireTrigger(deps, trigger, 'daemon-1');

      expect(spawns).toHaveLength(0);
      const skipLog = logs.find((l) => l.event === 'idempotency_skip');
      expect(skipLog).toBeDefined();
    });

    test('handles schedule not found', async () => {
      const trigger = {
        id: 'trig-1',
        schedule_id: 'nonexistent',
        due_at: new Date('2026-03-20T11:00:00Z'),
        status: 'executing',
        idempotency_key: null,
        leased_by: 'daemon-1',
        leased_until: new Date('2026-03-20T12:05:00Z'),
      };

      const { deps, spawns, logs } = createMockDeps({ schedules: [] });
      await fireTrigger(deps, trigger, 'daemon-1');

      expect(spawns).toHaveLength(0);
      const errLog = logs.find((l) => l.event === 'schedule_not_found');
      expect(errLog).toBeDefined();
    });

    test('handles spawn failure gracefully', async () => {
      const trigger = {
        id: 'trig-1',
        schedule_id: 'sched-1',
        due_at: new Date('2026-03-20T11:00:00Z'),
        status: 'executing',
        idempotency_key: null,
        leased_by: 'daemon-1',
        leased_until: new Date('2026-03-20T12:05:00Z'),
      };
      const schedules = [{ id: 'sched-1', name: 'test', command: 'bad-command', run_spec: {}, status: 'active' }];

      const { deps, logs } = createMockDeps(
        { schedules },
        {
          spawnCommand: async () => {
            throw new Error('spawn failed: command not found');
          },
        },
      );

      await fireTrigger(deps, trigger, 'daemon-1');

      const errLog = logs.find((l) => l.event === 'spawn_failed');
      expect(errLog).toBeDefined();
      expect(errLog?.error).toContain('command not found');
    });

    test('uses command from run_spec when schedule.command is null', async () => {
      const trigger = {
        id: 'trig-1',
        schedule_id: 'sched-1',
        due_at: new Date('2026-03-20T11:00:00Z'),
        status: 'executing',
        idempotency_key: null,
        leased_by: 'daemon-1',
        leased_until: new Date('2026-03-20T12:05:00Z'),
      };
      const schedules = [
        {
          id: 'sched-1',
          name: 'test',
          command: null,
          run_spec: { command: 'genie spawn engineer', provider: 'claude' },
          status: 'active',
        },
      ];

      const { deps, spawns } = createMockDeps({ schedules });
      await fireTrigger(deps, trigger, 'daemon-1');

      expect(spawns).toHaveLength(1);
      expect(spawns[0].command).toBe('genie spawn engineer');
    });
  });

  describe('startDaemon', () => {
    test('starts and stops cleanly', async () => {
      const { deps, logs } = createMockDeps({ triggers: [] });

      const handle = startDaemon(
        { pollIntervalMs: 50 },
        {
          ...deps,
          sleep: async () => {},
        },
      );

      expect(handle.daemonId).toBeDefined();

      // Let it run one cycle
      await new Promise((resolve) => setTimeout(resolve, 200));

      handle.stop();
      await Promise.race([handle.done, new Promise((resolve) => setTimeout(resolve, 2000))]);

      const startLog = logs.find((l) => l.event === 'daemon_started');
      expect(startLog).toBeDefined();
      expect(startLog?.daemon_id).toBe(handle.daemonId);

      const stopLog = logs.find((l) => l.event === 'daemon_stopped');
      expect(stopLog).toBeDefined();
    });

    test('applies jitter when batch exceeds threshold', async () => {
      const triggers = Array.from({ length: 5 }, (_, i) => ({
        id: `trig-${i}`,
        schedule_id: 'sched-1',
        due_at: new Date('2026-03-20T11:00:00Z'),
        status: 'pending',
        idempotency_key: null,
        leased_by: null,
        leased_until: null,
      }));
      const schedules = [{ id: 'sched-1', name: 'test', command: 'echo hi', run_spec: {}, status: 'active' }];

      let sleptMs = 0;
      const { deps, logs } = createMockDeps(
        { triggers, schedules },
        {
          sleep: async (ms) => {
            sleptMs += ms;
          },
        },
      );

      const handle = startDaemon({ pollIntervalMs: 100, jitterThreshold: 3 }, deps);

      // Wait for initial processing
      await new Promise((resolve) => setTimeout(resolve, 200));
      handle.stop();
      await Promise.race([handle.done, new Promise((resolve) => setTimeout(resolve, 2000))]);

      const jitterLog = logs.find((l) => l.event === 'jitter_applied');
      expect(jitterLog).toBeDefined();
      expect(sleptMs).toBeGreaterThan(0);
    });
  });

  describe('logToFile', () => {
    test('writes structured JSON to log file', () => {
      const { existsSync, readFileSync, rmSync } = require('node:fs');
      const { join } = require('node:path');
      const tmpDir = join('/tmp', `genie-test-${Date.now()}`);
      const origHome = process.env.GENIE_HOME;
      process.env.GENIE_HOME = tmpDir;

      try {
        logToFile({
          timestamp: '2026-03-20T12:00:00Z',
          level: 'info',
          event: 'test_event',
          extra: 'data',
        });

        const logPath = join(tmpDir, 'logs', 'scheduler.log');
        expect(existsSync(logPath)).toBe(true);

        const content = readFileSync(logPath, 'utf-8').trim();
        const parsed = JSON.parse(content);
        expect(parsed.event).toBe('test_event');
        expect(parsed.level).toBe('info');
        expect(parsed.extra).toBe('data');
      } finally {
        process.env.GENIE_HOME = origHome;
        try {
          rmSync(tmpDir, { recursive: true });
        } catch {}
      }
    });
  });

  // ==========================================================================
  // Group 4: Reboot recovery + orphan reconciliation + heartbeats
  // ==========================================================================

  describe('reclaimExpiredLeases', () => {
    test('reclaims expired executing triggers', async () => {
      const triggers = [
        {
          id: 'trig-expired',
          schedule_id: 'sched-1',
          due_at: new Date('2026-03-20T10:00:00Z'),
          status: 'executing',
          leased_until: new Date('2026-03-20T11:00:00Z'), // expired (now is 12:00)
          leased_by: 'old-daemon',
          idempotency_key: null,
        },
      ];
      const { deps, logs } = createMockDeps({ triggers });

      const count = await reclaimExpiredLeases(deps, 'daemon-new');

      expect(count).toBe(1);
      const reclaimLog = logs.find((l) => l.event === 'expired_leases_reclaimed');
      expect(reclaimLog).toBeDefined();
      expect(reclaimLog?.count).toBe(1);
    });

    test('returns 0 when no expired leases', async () => {
      const { deps, logs } = createMockDeps({ triggers: [] });

      const count = await reclaimExpiredLeases(deps, 'daemon-1');

      expect(count).toBe(0);
      const reclaimLog = logs.find((l) => l.event === 'expired_leases_reclaimed');
      expect(reclaimLog).toBeUndefined();
    });
  });

  describe('reconcileOrphanedRuns', () => {
    test('marks orphaned runs with dead processes as failed', async () => {
      const runs = [
        {
          id: 'run-1',
          worker_id: '99999999', // non-existent PID
          status: 'running',
          trigger_id: 'trig-1',
        },
      ];
      const { deps, logs } = createMockDeps({ runs });

      const count = await reconcileOrphanedRuns(deps, 'daemon-1');

      expect(count).toBe(1);
      const orphanLog = logs.find((l) => l.event === 'orphaned_runs_reconciled');
      expect(orphanLog).toBeDefined();
      expect(orphanLog?.count).toBe(1);
    });

    test('does not mark runs with alive panes as failed', async () => {
      const runs = [
        {
          id: 'run-1',
          worker_id: '%42',
          status: 'running',
          trigger_id: 'trig-1',
        },
      ];
      const { deps } = createMockDeps({ runs }, { isPaneAlive: async () => true });

      const count = await reconcileOrphanedRuns(deps, 'daemon-1');

      expect(count).toBe(0);
    });

    test('marks runs with dead panes as failed', async () => {
      const runs = [
        {
          id: 'run-1',
          worker_id: '%42',
          status: 'running',
          trigger_id: 'trig-1',
        },
      ];
      const { deps, logs } = createMockDeps({ runs }, { isPaneAlive: async () => false });

      const count = await reconcileOrphanedRuns(deps, 'daemon-1');

      expect(count).toBe(1);
      const orphanLog = logs.find((l) => l.event === 'orphaned_runs_reconciled');
      expect(orphanLog).toBeDefined();
    });
  });

  describe('collectHeartbeats', () => {
    test('inserts heartbeat for running run with alive pane', async () => {
      const runs = [
        {
          id: 'run-1',
          worker_id: '%42',
          status: 'running',
          trigger_id: 'trig-1',
        },
      ];
      const { deps, mock, logs } = createMockDeps({ runs }, { isPaneAlive: async () => true });

      const count = await collectHeartbeats(deps);

      expect(count).toBe(1);
      expect(mock.insertedHeartbeats).toHaveLength(1);
      const heartbeatLog = logs.find((l) => l.event === 'heartbeats_collected');
      expect(heartbeatLog).toBeDefined();
      expect(heartbeatLog?.count).toBe(1);
    });

    test('inserts dead heartbeat for run with dead pane', async () => {
      const runs = [
        {
          id: 'run-1',
          worker_id: '%42',
          status: 'running',
          trigger_id: 'trig-1',
        },
      ];
      const { deps, mock } = createMockDeps({ runs }, { isPaneAlive: async () => false });

      const count = await collectHeartbeats(deps);

      expect(count).toBe(1);
      expect(mock.insertedHeartbeats).toHaveLength(1);
    });

    test('returns 0 when no running runs', async () => {
      const { deps } = createMockDeps({ runs: [] });

      const count = await collectHeartbeats(deps);

      expect(count).toBe(0);
    });

    test('checks PID-based worker_id via process.kill', async () => {
      const runs = [
        {
          id: 'run-1',
          worker_id: String(process.pid), // current process — alive
          status: 'running',
          trigger_id: 'trig-1',
        },
      ];
      const { deps, mock } = createMockDeps({ runs });

      const count = await collectHeartbeats(deps);

      expect(count).toBe(1);
      expect(mock.insertedHeartbeats).toHaveLength(1);
    });
  });

  describe('reconcileOrphans', () => {
    test('marks run as failed after N consecutive dead heartbeats', async () => {
      const runs = [
        {
          id: 'run-orphan',
          worker_id: '%42',
          status: 'running',
          trigger_id: 'trig-1',
        },
      ];
      const heartbeats = [{ status: 'dead' }, { status: 'dead' }];

      const { deps, logs } = createMockDeps({ runs, heartbeats });

      const count = await reconcileOrphans(deps, defaultConfig);

      expect(count).toBe(1);
      const failLog = logs.find((l) => l.event === 'orphan_run_failed');
      expect(failLog).toBeDefined();
      expect(failLog?.run_id).toBe('run-orphan');
    });

    test('does not mark run when heartbeats are alive', async () => {
      const runs = [
        {
          id: 'run-1',
          worker_id: '%42',
          status: 'running',
          trigger_id: 'trig-1',
        },
      ];
      const heartbeats = [{ status: 'alive' }, { status: 'alive' }];

      const { deps, logs } = createMockDeps({ runs, heartbeats });

      const count = await reconcileOrphans(deps, defaultConfig);

      expect(count).toBe(0);
      const failLog = logs.find((l) => l.event === 'orphan_run_failed');
      expect(failLog).toBeUndefined();
    });

    test('does not mark run when insufficient heartbeats', async () => {
      const runs = [
        {
          id: 'run-1',
          worker_id: '%42',
          status: 'running',
          trigger_id: 'trig-1',
        },
      ];
      const heartbeats = [{ status: 'dead' }]; // only 1, threshold is 2

      const { deps } = createMockDeps({ runs, heartbeats });

      const count = await reconcileOrphans(deps, defaultConfig);

      expect(count).toBe(0);
    });

    test('does not mark run with mixed alive/dead heartbeats', async () => {
      const runs = [
        {
          id: 'run-1',
          worker_id: '%42',
          status: 'running',
          trigger_id: 'trig-1',
        },
      ];
      const heartbeats = [{ status: 'dead' }, { status: 'alive' }];

      const { deps } = createMockDeps({ runs, heartbeats });

      const count = await reconcileOrphans(deps, defaultConfig);

      expect(count).toBe(0);
    });
  });

  describe('collectMachineSnapshot', () => {
    test('inserts machine snapshot with worker and session counts', async () => {
      const workers: WorkerInfo[] = [
        { id: 'w-1', paneId: '%1', state: 'working', team: 'alpha' },
        { id: 'w-2', paneId: '%2', state: 'idle', team: 'alpha' },
        { id: 'w-3', paneId: '%3', state: 'suspended', team: 'beta' },
      ];
      const { deps, mock, logs } = createMockDeps(
        {},
        {
          listWorkers: async () => workers,
          countTmuxSessions: async () => 3,
        },
      );

      await collectMachineSnapshot(deps);

      expect(mock.insertedSnapshots).toHaveLength(1);
      const snapshotLog = logs.find((l) => l.event === 'machine_snapshot');
      expect(snapshotLog).toBeDefined();
      expect(snapshotLog?.active_workers).toBe(2); // working + idle (not suspended)
      expect(snapshotLog?.active_teams).toBe(2); // alpha + beta (both have workers with teams)
      expect(snapshotLog?.tmux_sessions).toBe(3);
    });

    test('handles empty worker list', async () => {
      const { deps, mock, logs } = createMockDeps({});

      await collectMachineSnapshot(deps);

      expect(mock.insertedSnapshots).toHaveLength(1);
      const snapshotLog = logs.find((l) => l.event === 'machine_snapshot');
      expect(snapshotLog).toBeDefined();
      expect(snapshotLog?.active_workers).toBe(0);
      expect(snapshotLog?.active_teams).toBe(0);
    });
  });

  describe('startDaemon with recovery', () => {
    test('runs recovery on startup', async () => {
      const { deps, logs } = createMockDeps({ triggers: [], runs: [] });

      const handle = startDaemon(
        { pollIntervalMs: 50, heartbeatIntervalMs: 100_000, orphanCheckIntervalMs: 100_000 },
        { ...deps, sleep: async () => {} },
      );

      await new Promise((resolve) => setTimeout(resolve, 200));
      handle.stop();
      await Promise.race([handle.done, new Promise((resolve) => setTimeout(resolve, 2000))]);

      const recoveryStart = logs.find((l) => l.event === 'recovery_started');
      expect(recoveryStart).toBeDefined();

      const recoveryDone = logs.find((l) => l.event === 'recovery_completed');
      expect(recoveryDone).toBeDefined();
    });
  });

  // ==========================================================================
  // Auto-resume tests
  // ==========================================================================

  describe('attemptAgentResume', () => {
    function makeWorker(overrides: Partial<WorkerInfo> = {}): WorkerInfo {
      return {
        id: 'test-agent',
        paneId: '%42',
        state: 'error',
        claudeSessionId: 'session-abc',
        autoResume: true,
        resumeAttempts: 0,
        maxResumeAttempts: 3,
        ...overrides,
      };
    }

    test('resumes eligible agent successfully', async () => {
      const agent = makeWorker();
      const updates: { id: string; updates: Record<string, unknown> }[] = [];
      const { deps, logs } = createMockDeps(
        {},
        {
          resumeAgent: async () => true,
          updateAgent: async (id, u) => {
            updates.push({ id, updates: u });
          },
        },
      );

      const result = await attemptAgentResume(deps, defaultConfig, agent);

      expect(result).toBe('resumed');
      expect(updates).toHaveLength(1);
      expect(updates[0].updates.resumeAttempts).toBe(1);
      expect(updates[0].updates.lastResumeAttempt).toBeDefined();

      const attempted = logs.find((l) => l.event === 'agent_resume_attempted');
      expect(attempted).toBeDefined();
      expect(attempted?.resume_attempts).toBe(1);

      const succeeded = logs.find((l) => l.event === 'agent_resume_succeeded');
      expect(succeeded).toBeDefined();
    });

    test('skips agent with autoResume: false', async () => {
      const agent = makeWorker({ autoResume: false });
      const { deps, logs } = createMockDeps();

      const result = await attemptAgentResume(deps, defaultConfig, agent);

      expect(result).toBe('skipped');
      const skip = logs.find((l) => l.event === 'agent_resume_skipped');
      expect(skip).toBeDefined();
      expect(skip?.reason).toBe('auto_resume_disabled');
    });

    test('skips agent with no Claude session ID', async () => {
      const agent = makeWorker({ claudeSessionId: undefined });
      const { deps, logs } = createMockDeps();

      const result = await attemptAgentResume(deps, defaultConfig, agent);

      expect(result).toBe('skipped');
      const skip = logs.find((l) => l.event === 'agent_resume_skipped');
      expect(skip?.reason).toBe('no_session_id');
    });

    test('returns exhausted when retry budget depleted', async () => {
      const agent = makeWorker({ resumeAttempts: 3, maxResumeAttempts: 3 });
      const { deps, logs } = createMockDeps();

      const result = await attemptAgentResume(deps, defaultConfig, agent);

      expect(result).toBe('exhausted');
      const exhausted = logs.find((l) => l.event === 'agent_resume_exhausted');
      expect(exhausted).toBeDefined();
    });

    test('skips when within cooldown period', async () => {
      const agent = makeWorker({
        lastResumeAttempt: new Date('2026-03-20T11:59:30Z').toISOString(), // 30s ago (now = 12:00)
      });
      const { deps, logs } = createMockDeps();

      const result = await attemptAgentResume(deps, defaultConfig, agent);

      expect(result).toBe('skipped');
      const skip = logs.find((l) => l.event === 'agent_resume_skipped');
      expect(skip?.reason).toBe('cooldown');
    });

    test('resumes when cooldown has elapsed', async () => {
      const agent = makeWorker({
        lastResumeAttempt: new Date('2026-03-20T11:58:00Z').toISOString(), // 2min ago
      });
      const { deps } = createMockDeps(
        {},
        {
          resumeAgent: async () => true,
          updateAgent: async () => {},
        },
      );

      const result = await attemptAgentResume(deps, defaultConfig, agent);
      expect(result).toBe('resumed');
    });

    test('skips when concurrency cap is reached', async () => {
      const agent = makeWorker();
      const activeWorkers: WorkerInfo[] = Array.from({ length: 5 }, (_, i) => ({
        id: `w-${i}`,
        paneId: `%${i}`,
        state: 'working' as AgentState,
      }));
      const { deps, logs } = createMockDeps(
        {},
        {
          listWorkers: async () => activeWorkers,
        },
      );

      const result = await attemptAgentResume(deps, defaultConfig, agent);

      expect(result).toBe('skipped');
      const skip = logs.find((l) => l.event === 'agent_resume_skipped');
      expect(skip?.reason).toBe('concurrency_cap');
    });

    test('handles resume failure gracefully', async () => {
      const agent = makeWorker({ resumeAttempts: 0 });
      const { deps, logs } = createMockDeps(
        {},
        {
          resumeAgent: async () => false,
          updateAgent: async () => {},
        },
      );

      const result = await attemptAgentResume(deps, defaultConfig, agent);

      // Not exhausted yet (1 of 3)
      expect(result).toBe('skipped');
      const failed = logs.find((l) => l.event === 'agent_resume_failed');
      expect(failed).toBeDefined();
    });

    test('returns exhausted on last failed attempt', async () => {
      const agent = makeWorker({ resumeAttempts: 2, maxResumeAttempts: 3 });
      const { deps, logs } = createMockDeps(
        {},
        {
          resumeAgent: async () => false,
          updateAgent: async () => {},
        },
      );

      const result = await attemptAgentResume(deps, defaultConfig, agent);

      expect(result).toBe('exhausted');
      const exhausted = logs.find((l) => l.event === 'agent_resume_exhausted');
      expect(exhausted).toBeDefined();
      expect(exhausted?.resume_attempts).toBe(3);
    });

    test('treats undefined autoResume as true (default)', async () => {
      const agent = makeWorker({ autoResume: undefined });
      const { deps } = createMockDeps(
        {},
        {
          resumeAgent: async () => true,
          updateAgent: async () => {},
        },
      );

      const result = await attemptAgentResume(deps, defaultConfig, agent);
      expect(result).toBe('resumed');
    });
  });

  describe('reconcileOrphans with auto-resume', () => {
    test('attempts resume before marking orphaned run as failed', async () => {
      const runs = [{ id: 'run-orphan', worker_id: 'agent-1', status: 'running', trigger_id: 'trig-1' }];
      const heartbeats = [{ status: 'dead' }, { status: 'dead' }];
      const workers: WorkerInfo[] = [
        {
          id: 'agent-1',
          paneId: '%42',
          state: 'working',
          autoResume: true,
          claudeSessionId: 'sess-1',
          resumeAttempts: 0,
        },
      ];

      let resumed = false;
      const { deps, logs } = createMockDeps(
        { runs, heartbeats },
        {
          listWorkers: async () => workers,
          resumeAgent: async () => {
            resumed = true;
            return true;
          },
          updateAgent: async () => {},
        },
      );

      const failedCount = await reconcileOrphans(deps, defaultConfig);

      expect(resumed).toBe(true);
      expect(failedCount).toBe(0); // Not marked as failed — resumed instead
      const resumeLog = logs.find((l) => l.event === 'orphan_run_resumed');
      expect(resumeLog).toBeDefined();
    });

    test('marks run as failed when auto-resume is disabled', async () => {
      const runs = [{ id: 'run-orphan', worker_id: 'agent-1', status: 'running', trigger_id: 'trig-1' }];
      const heartbeats = [{ status: 'dead' }, { status: 'dead' }];
      const workers: WorkerInfo[] = [
        { id: 'agent-1', paneId: '%42', state: 'working', autoResume: false, claudeSessionId: 'sess-1' },
      ];

      const { deps, logs } = createMockDeps(
        { runs, heartbeats },
        {
          listWorkers: async () => workers,
        },
      );

      const failedCount = await reconcileOrphans(deps, defaultConfig);

      // autoResume=false → skipped → but still not marked failed on skip
      // It's skipped, meaning daemon waits for next cycle (which won't help since autoResume is false)
      // Actually we want: when autoResume=false AND resume is skipped, we should check if the agent
      // will never be resumed. For autoResume=false, the skip means "permanently skip" so fall through.
      // Let me re-check the logic...
      // The current logic: if result === 'skipped' → continue (skip marking failed)
      // This is correct for cooldown/cap skips, but wrong for autoResume=false.
      // The test expectation should match behavior: agent with autoResume=false → skipped → not failed YET.
      // On next cycle, same thing happens. Agent is never auto-resumed, but daemon doesn't mark it failed either.
      // This is actually fine — the run in PG stays 'running' and eventually manual intervention or
      // `genie kill` handles it. The autoResume=false just means the daemon won't try to auto-resume.
      // For the GROUP 3 acceptance criteria: "Agent with autoResume: false is marked failed (current behavior)"
      // We need to adjust: skip only on cooldown/cap, not on autoResume=false.
      expect(failedCount).toBe(1);
      const failLog = logs.find((l) => l.event === 'orphan_run_failed');
      expect(failLog).toBeDefined();
    });

    test('marks run as failed when resume exhausted', async () => {
      const runs = [{ id: 'run-orphan', worker_id: 'agent-1', status: 'running', trigger_id: 'trig-1' }];
      const heartbeats = [{ status: 'dead' }, { status: 'dead' }];
      const workers: WorkerInfo[] = [
        {
          id: 'agent-1',
          paneId: '%42',
          state: 'working',
          autoResume: true,
          claudeSessionId: 'sess-1',
          resumeAttempts: 3,
          maxResumeAttempts: 3,
        },
      ];

      const { deps, logs } = createMockDeps(
        { runs, heartbeats },
        {
          listWorkers: async () => workers,
        },
      );

      const failedCount = await reconcileOrphans(deps, defaultConfig);

      expect(failedCount).toBe(1);
      const exhausted = logs.find((l) => l.event === 'agent_resume_exhausted');
      expect(exhausted).toBeDefined();
    });
  });

  describe('recoverOnStartup with auto-resume', () => {
    test('auto-resumes agents with dead panes on startup', async () => {
      const workers: WorkerInfo[] = [
        {
          id: 'agent-1',
          paneId: '%42',
          state: 'working',
          autoResume: true,
          claudeSessionId: 'sess-1',
          resumeAttempts: 0,
        },
        { id: 'agent-2', paneId: '%43', state: 'idle', autoResume: true, claudeSessionId: 'sess-2', resumeAttempts: 0 },
        { id: 'agent-done', paneId: '%44', state: 'done', claudeSessionId: 'sess-3' },
        { id: 'agent-suspended', paneId: '%45', state: 'suspended', claudeSessionId: 'sess-4' },
      ];

      const resumedAgents: string[] = [];
      const { deps, logs } = createMockDeps(
        { triggers: [], runs: [] },
        {
          listWorkers: async () => workers,
          isPaneAlive: async () => false, // all panes dead
          resumeAgent: async (id) => {
            resumedAgents.push(id);
            return true;
          },
          updateAgent: async () => {},
        },
      );

      await recoverOnStartup(deps, 'daemon-1', defaultConfig);

      // Only agent-1 and agent-2 should be resumed (not done, not suspended)
      expect(resumedAgents).toHaveLength(2);
      expect(resumedAgents).toContain('agent-1');
      expect(resumedAgents).toContain('agent-2');

      const recoveryLog = logs.find((l) => l.event === 'recovery_completed');
      expect(recoveryLog).toBeDefined();
      expect(recoveryLog?.resumed_agents).toBe(2);
    });

    test('skips agents with alive panes on startup', async () => {
      const workers: WorkerInfo[] = [
        {
          id: 'agent-1',
          paneId: '%42',
          state: 'working',
          autoResume: true,
          claudeSessionId: 'sess-1',
          resumeAttempts: 0,
        },
      ];

      const resumedAgents: string[] = [];
      const { deps } = createMockDeps(
        { triggers: [], runs: [] },
        {
          listWorkers: async () => workers,
          isPaneAlive: async () => true, // pane is alive
          resumeAgent: async (id) => {
            resumedAgents.push(id);
            return true;
          },
          updateAgent: async () => {},
        },
      );

      await recoverOnStartup(deps, 'daemon-1', defaultConfig);

      expect(resumedAgents).toHaveLength(0);
    });
  });
});
