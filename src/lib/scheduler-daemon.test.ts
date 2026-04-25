import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AgentState } from './agent-registry.js';
import type { MailboxMessage } from './mailbox.js';
import {
  ESCALATION_RECIPIENT,
  type LogEntry,
  MAX_DELIVERY_ATTEMPTS,
  type SchedulerConfig,
  type SchedulerDeps,
  TURN_AWARE_RECONCILER_FLAG,
  type WorkerInfo,
  _resetWorkerStatesForTesting,
  attemptAgentResume,
  claimDueTriggers,
  collectHeartbeats,
  collectMachineSnapshot,
  emitWorkerEvents,
  fireTrigger,
  isTurnAwareReconcilerEnabled,
  logReconcilerMode,
  logToFile,
  processMailboxRetryMessage,
  reclaimExpiredLeases,
  reconcileOrphanedRuns,
  reconcileOrphans,
  reconcileUnresumable,
  recoverOnStartup,
  runAgentRecoveryPass,
  startDaemon,
  terminalizeCleanExitUnverified,
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
  const insertedTriggers: Record<string, unknown>[] = [];
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
    if (query.includes('INSERT INTO triggers')) {
      insertedTriggers.push({ values });
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

  return { sql, queries, insertedRuns, insertedHeartbeats, insertedSnapshots, insertedTriggers, updatedTriggers };
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
  publishedEvents: { subject: string; data: unknown }[];
  mock: ReturnType<typeof createMockSql>;
} {
  const logs: LogEntry[] = [];
  const spawns: { command: string; env: Record<string, string> }[] = [];
  const publishedEvents: { subject: string; data: unknown }[] = [];
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
    publishEvent: async (subject, data) => {
      publishedEvents.push({ subject, data });
    },
    resumeAgent: async () => true,
    updateAgent: async () => {},
    ...overrides,
  };

  return { deps, logs, spawns, publishedEvents, mock };
}

const defaultConfig: SchedulerConfig = {
  maxConcurrent: 5,
  pollIntervalMs: 30_000,
  maxJitterMs: 30_000,
  jitterThreshold: 3,
  heartbeatIntervalMs: 60_000,
  orphanCheckIntervalMs: 300_000,
  deadHeartbeatThreshold: 2,
  leaseRecoveryIntervalMs: 60_000,
};

// ============================================================================
// Tests
// ============================================================================

describe('scheduler-daemon', () => {
  beforeEach(() => {
    process.env.GENIE_MAX_CONCURRENT = undefined;
    // Each test picks its own turn-aware flag value. Clear between tests so
    // one test's opt-out doesn't leak into the next.
    delete process.env[TURN_AWARE_RECONCILER_FLAG];
  });

  afterEach(() => {
    process.env.GENIE_MAX_CONCURRENT = undefined;
    delete process.env[TURN_AWARE_RECONCILER_FLAG];
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

    test('advances trigger to completed after successful fire', async () => {
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
          name: 'once-task',
          command: 'echo hi',
          run_spec: {},
          status: 'active',
          cron_expression: '@once',
        },
      ];

      const { deps, mock } = createMockDeps({ schedules });
      await fireTrigger(deps, trigger, 'daemon-1');

      const completionQuery = mock.queries.find(
        (q) => q.query.includes('UPDATE triggers') && q.query.includes('completed'),
      );
      expect(completionQuery).toBeDefined();
    });

    test('creates next trigger for recurring interval schedule', async () => {
      const trigger = {
        id: 'trig-1',
        schedule_id: 'sched-1',
        due_at: new Date('2026-03-20T11:50:00Z'),
        status: 'executing',
        idempotency_key: null,
        leased_by: 'daemon-1',
        leased_until: new Date('2026-03-20T12:05:00Z'),
      };
      const schedules = [
        {
          id: 'sched-1',
          name: 'recurring-task',
          command: 'genie spawn reviewer',
          run_spec: {},
          status: 'active',
          cron_expression: '@every 10m',
        },
      ];

      const { deps, mock, logs } = createMockDeps({ schedules });
      await fireTrigger(deps, trigger, 'daemon-1');

      expect(mock.insertedTriggers).toHaveLength(1);
      const nextTriggerLog = logs.find((l) => l.event === 'next_trigger_created');
      expect(nextTriggerLog).toBeDefined();
      expect(nextTriggerLog?.schedule_id).toBe('sched-1');
    });

    test('creates next trigger for cron schedule', async () => {
      const trigger = {
        id: 'trig-1',
        schedule_id: 'sched-1',
        due_at: new Date('2026-03-20T00:00:00Z'),
        status: 'executing',
        idempotency_key: null,
        leased_by: 'daemon-1',
        leased_until: new Date('2026-03-20T00:05:00Z'),
      };
      const schedules = [
        {
          id: 'sched-1',
          name: 'nightly-task',
          command: 'genie spawn reviewer',
          run_spec: {},
          status: 'active',
          cron_expression: '0 0 * * *',
        },
      ];

      const { deps, mock, logs } = createMockDeps({ schedules });
      await fireTrigger(deps, trigger, 'daemon-1');

      expect(mock.insertedTriggers).toHaveLength(1);
      const nextTriggerLog = logs.find((l) => l.event === 'next_trigger_created');
      expect(nextTriggerLog).toBeDefined();
    });

    test('does not create next trigger for @once schedule', async () => {
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
          name: 'once-task',
          command: 'echo hi',
          run_spec: {},
          status: 'active',
          cron_expression: '@once',
        },
      ];

      const { deps, mock, logs } = createMockDeps({ schedules });
      await fireTrigger(deps, trigger, 'daemon-1');

      expect(mock.insertedTriggers).toHaveLength(0);
      const nextTriggerLog = logs.find((l) => l.event === 'next_trigger_created');
      expect(nextTriggerLog).toBeUndefined();
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
  // Group 4: Runtime Event Emission
  // ==========================================================================

  describe('emitWorkerEvents', () => {
    beforeEach(() => {
      _resetWorkerStatesForTesting();
    });

    afterEach(() => {
      _resetWorkerStatesForTesting();
    });

    test('emits spawned event for new workers', async () => {
      const workers: WorkerInfo[] = [
        { id: 'engineer', paneId: '%1', repoPath: '/tmp/alpha', state: 'working', team: 'alpha' },
      ];
      const { deps, publishedEvents } = createMockDeps({}, { listWorkers: async () => workers });

      await emitWorkerEvents(deps);

      expect(publishedEvents).toHaveLength(1);
      expect(publishedEvents[0].subject).toBe('genie.agent.engineer.spawned');
      const data = publishedEvents[0].data as Record<string, unknown>;
      expect(data.kind).toBe('state');
      expect(data.agent).toBe('engineer');
      expect(data.team).toBe('alpha');
    });

    test('emits state change event when state changes', async () => {
      const workers: WorkerInfo[] = [
        { id: 'engineer', paneId: '%1', repoPath: '/tmp/alpha', state: 'working', team: 'alpha' },
      ];
      const { deps, publishedEvents } = createMockDeps({}, { listWorkers: async () => workers });

      // First call — spawned
      await emitWorkerEvents(deps);
      publishedEvents.length = 0;

      // Change state
      workers[0].state = 'idle';
      await emitWorkerEvents(deps);

      expect(publishedEvents).toHaveLength(1);
      expect(publishedEvents[0].subject).toBe('genie.agent.engineer.state');
      const data = publishedEvents[0].data as Record<string, unknown>;
      expect((data.data as Record<string, unknown>).previousState).toBe('working');
      expect((data.data as Record<string, unknown>).state).toBe('idle');
    });

    test('emits killed event when worker disappears', async () => {
      const workers: WorkerInfo[] = [
        { id: 'engineer', paneId: '%1', repoPath: '/tmp/alpha', state: 'working', team: 'alpha' },
      ];
      const { deps, publishedEvents } = createMockDeps({}, { listWorkers: async () => workers });

      // First call — spawned
      await emitWorkerEvents(deps);
      publishedEvents.length = 0;

      // Remove worker
      workers.length = 0;
      await emitWorkerEvents(deps);

      expect(publishedEvents).toHaveLength(1);
      expect(publishedEvents[0].subject).toBe('genie.agent.engineer.killed');
      const data = publishedEvents[0].data as Record<string, unknown>;
      expect(data.kind).toBe('state');
      expect((data.data as Record<string, unknown>).lastState).toBe('working');
    });

    test('emits wish group done event when agent with wish completes', async () => {
      const workers: WorkerInfo[] = [
        {
          id: 'eng-1',
          paneId: '%1',
          repoPath: '/tmp/alpha',
          state: 'working',
          team: 'alpha',
          wishSlug: 'genie-log',
          groupNumber: 4,
        },
      ];
      const { deps, publishedEvents } = createMockDeps({}, { listWorkers: async () => workers });

      // First call — spawned
      await emitWorkerEvents(deps);
      publishedEvents.length = 0;

      // Agent completes
      workers[0].state = 'done';
      await emitWorkerEvents(deps);

      // Should emit both state change and wish group done
      expect(publishedEvents).toHaveLength(2);
      expect(publishedEvents[0].subject).toBe('genie.agent.eng-1.state');
      expect(publishedEvents[1].subject).toBe('genie.wish.genie-log.group.4.done');
      const wishData = publishedEvents[1].data as Record<string, unknown>;
      expect(wishData.kind).toBe('system');
      expect((wishData.data as Record<string, unknown>).wishSlug).toBe('genie-log');
      expect((wishData.data as Record<string, unknown>).groupNumber).toBe(4);
    });

    test('does not emit when state unchanged', async () => {
      const workers: WorkerInfo[] = [
        { id: 'engineer', paneId: '%1', repoPath: '/tmp/alpha', state: 'working', team: 'alpha' },
      ];
      const { deps, publishedEvents } = createMockDeps({}, { listWorkers: async () => workers });

      // First call — spawned
      await emitWorkerEvents(deps);
      publishedEvents.length = 0;

      // Same state — no event
      await emitWorkerEvents(deps);

      expect(publishedEvents).toHaveLength(0);
    });

    test('handles multiple workers with mixed changes', async () => {
      const workers: WorkerInfo[] = [
        { id: 'eng-1', paneId: '%1', repoPath: '/tmp/alpha', state: 'working', team: 'alpha' },
        { id: 'eng-2', paneId: '%2', repoPath: '/tmp/alpha', state: 'idle', team: 'alpha' },
      ];
      const { deps, publishedEvents } = createMockDeps({}, { listWorkers: async () => workers });

      await emitWorkerEvents(deps);
      publishedEvents.length = 0;

      // eng-1 changes state, eng-2 removed, eng-3 added
      workers[0].state = 'idle';
      workers.splice(1, 1); // remove eng-2
      workers.push({ id: 'eng-3', paneId: '%3', repoPath: '/tmp/alpha', state: 'spawning', team: 'alpha' });

      await emitWorkerEvents(deps);

      const subjects = publishedEvents.map((e) => e.subject);
      expect(subjects).toContain('genie.agent.eng-1.state');
      expect(subjects).toContain('genie.agent.eng-2.killed');
      expect(subjects).toContain('genie.agent.eng-3.spawned');
    });

    test('gracefully handles publishEvent failure', async () => {
      const workers: WorkerInfo[] = [
        { id: 'engineer', paneId: '%1', repoPath: '/tmp/alpha', state: 'working', team: 'alpha' },
      ];
      const { deps } = createMockDeps(
        {},
        {
          listWorkers: async () => workers,
          publishEvent: async () => {
            throw new Error('event log down');
          },
        },
      );

      // Should not throw
      await expect(emitWorkerEvents(deps)).rejects.toThrow('event log down');
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
        currentSessionId: 'session-abc',
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
      // Two writes: (1) pre-spawn increment, (2) post-success explicit reset.
      // Post-fix/auto-resume-counter-persistence: the CLI no longer resets the
      // counter (it's invoked with --no-reset-attempts), so the scheduler owns
      // both the increment and the success-path reset.
      expect(updates).toHaveLength(2);
      expect(updates[0].updates.resumeAttempts).toBe(1);
      expect(updates[0].updates.lastResumeAttempt).toBeDefined();
      expect(updates[1].updates.resumeAttempts).toBe(0);

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
      const agent = makeWorker({ currentSessionId: undefined });
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

    // ========================================================================
    // Regression: fix/auto-resume-counter-persistence
    //
    // Before the fix, `defaultResumeAgent` shelled out to `genie agent resume`
    // without `--no-reset-attempts`, which invoked `resumeAgent(agent)` and
    // unconditionally did `registry.update({ resumeAttempts: 0 })` — wiping
    // the increment written by `attemptAgentResume` one tick earlier. Counter
    // stayed at 0 forever; `attempts >= maxAttempts` never fired; dead agents
    // were retried every ~60s forever (`genie ls` showed `0/3 resumes` while
    // the scheduler log showed `resume_attempts: 1` every minute).
    //
    // The tests below simulate the counter-persistence contract through the
    // scheduler's `updateAgent` dependency. They do NOT invoke the CLI
    // directly (unit scope); they encode the invariant that the scheduler
    // owns the counter end-to-end — which is exactly what the fix enforces
    // via the `--no-reset-attempts` CLI flag on the shell-out boundary.
    // ========================================================================

    test('failed attempts accumulate the counter (pre-fix stuck at 0)', async () => {
      let row: { resumeAttempts: number; lastResumeAttempt?: string } = {
        resumeAttempts: 0,
      };
      const { deps } = createMockDeps(
        {},
        {
          resumeAgent: async () => false, // simulate CLI failure
          updateAgent: async (_id, updates) => {
            row = { ...row, ...updates } as typeof row;
          },
        },
      );

      // Attempt 1: 0 → 1
      const a1 = makeWorker({ resumeAttempts: row.resumeAttempts });
      expect(await attemptAgentResume(deps, defaultConfig, a1)).toBe('skipped');
      expect(row.resumeAttempts).toBe(1);

      // Attempt 2: 1 → 2 (bypass cooldown by resetting lastResumeAttempt for test)
      const a2 = makeWorker({
        resumeAttempts: row.resumeAttempts,
        lastResumeAttempt: undefined,
      });
      expect(await attemptAgentResume(deps, defaultConfig, a2)).toBe('skipped');
      expect(row.resumeAttempts).toBe(2);

      // Attempt 3: 2 → 3 → exhausted (budget depleted after increment)
      const a3 = makeWorker({
        resumeAttempts: row.resumeAttempts,
        lastResumeAttempt: undefined,
      });
      expect(await attemptAgentResume(deps, defaultConfig, a3)).toBe('exhausted');
      expect(row.resumeAttempts).toBe(3);
    });

    test('exhaustion check fires on re-entry with attempts=maxAttempts', async () => {
      // Pre-fix this path was unreachable because the counter was always 0 on
      // re-entry. Post-fix the increment persists, so after 3 attempts the
      // next tick hits the early-exit `attempts >= maxAttempts` branch.
      //
      // Post-fix/wedged-terminal-state: the early-exit branch also persists
      // `autoResume=false` so the next cycle's resumable filter excludes the
      // agent (prevents `agent_resume_exhausted` re-logging every 60s).
      const agent = makeWorker({ resumeAttempts: 3, maxResumeAttempts: 3 });
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

      expect(result).toBe('exhausted');
      const exhausted = logs.find((l) => l.event === 'agent_resume_exhausted');
      expect(exhausted).toBeDefined();
      expect(exhausted?.resume_attempts).toBe(3);
      // Exactly one updateAgent call on early-exit exhaustion: the terminal
      // `autoResume=false` flip. We do NOT re-increment or reset counters
      // when the budget is already depleted.
      expect(updates).toHaveLength(1);
      expect(updates[0].updates.autoResume).toBe(false);
      // Critical invariant: no counter mutation on the early-exit branch.
      expect(updates[0].updates.resumeAttempts).toBeUndefined();
    });

    test('success path explicitly resets counter to 0', async () => {
      // After --no-reset-attempts, the CLI no longer resets; the scheduler
      // must do it explicitly so a healthy resumed agent carries a clean
      // retry budget into the next failure.
      const agent = makeWorker({ resumeAttempts: 2, maxResumeAttempts: 3 });
      const updates: { id: string; updates: Record<string, unknown> }[] = [];
      const { deps } = createMockDeps(
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

      // Expect two writes: (1) increment before spawn, (2) explicit reset on success.
      expect(updates.length).toBeGreaterThanOrEqual(2);
      const increment = updates.find((u) => u.updates.resumeAttempts === 3);
      const reset = updates.find((u) => u.updates.resumeAttempts === 0);
      expect(increment).toBeDefined();
      expect(reset).toBeDefined();
      // Order matters: increment first, reset on success.
      expect(updates.indexOf(increment!)).toBeLessThan(updates.indexOf(reset!));
    });

    test('scheduler-owned counter: increment not wiped by resumeAgent boundary', async () => {
      // This is the direct regression test for the original bug. Before the
      // fix, the CLI-wipe would undo the increment and the final state would
      // be `resumeAttempts=0`. Post-fix, the scheduler holds the counter end
      // to end: increment on attempt, reset only on explicit success.
      let row: { resumeAttempts: number; lastResumeAttempt?: string } = {
        resumeAttempts: 0,
      };
      let resumeAgentCalls = 0;
      const { deps } = createMockDeps(
        {},
        {
          // Simulate the CLI boundary: resumeAgent returns true without
          // touching the counter (that's what --no-reset-attempts guarantees
          // at the real CLI layer).
          resumeAgent: async () => {
            resumeAgentCalls += 1;
            return true;
          },
          updateAgent: async (_id, updates) => {
            row = { ...row, ...updates } as typeof row;
          },
        },
      );

      const agent = makeWorker({ resumeAttempts: 0 });
      const result = await attemptAgentResume(deps, defaultConfig, agent);

      expect(result).toBe('resumed');
      expect(resumeAgentCalls).toBe(1);
      // Counter progression: pre-spawn increment to 1, then success reset to 0.
      // The critical invariant is `lastResumeAttempt` — proving the pre-spawn
      // write landed before the success reset (if the CLI had wiped the
      // counter mid-flight, lastResumeAttempt would also be absent).
      expect(row.resumeAttempts).toBe(0);
      expect(row.lastResumeAttempt).toBeDefined();
    });
  });

  // ==========================================================================
  // Regression: fix/wedged-terminal-state
  //
  // Two bugs, same architectural shape — terminal-state agents that the
  // scheduler kept re-processing every cycle.
  //
  //  - Bug A: Rows in `state='error', auto_resume=true, claude_session_id=null`
  //    were dropped by the resumable filter (no session id), but stayed in
  //    `auto_resume=true` forever, misleading `genie ls` ("auto-resume: on")
  //    and polluting the worker list. The `reconcileUnresumable` pass flips
  //    those rows to `auto_resume=false`.
  //
  //  - Bug B: The `attempts >= maxAttempts` early-exit in `attemptAgentResume`
  //    logged `agent_resume_exhausted` and returned, but did NOT set
  //    `auto_resume=false`. Next scheduler tick (60s later) re-entered the
  //    same branch and re-logged the same exhaustion event — 9 agents on
  //    felipe's machine produced ~12K redundant events over a day. The fix
  //    persists `auto_resume=false` at the terminal boundary.
  //
  // Prior art: PR #1181 (zombie concurrency cap) + PR #1187 (counter
  // persistence). This is the final cleanup pass closing the
  // "terminal states should be terminal" theme.
  // ==========================================================================

  describe('reconcileUnresumable — Bug A: mark null-session error rows unresumable', () => {
    test('flips auto_resume to false for error-state agent with null session id', async () => {
      const workers: WorkerInfo[] = [
        {
          id: 'wedged-agent',
          paneId: '',
          state: 'error',
          autoResume: true,
          // currentSessionId intentionally undefined — simulates the DB NULL
          // observed on felipe's machine (genie-docs directory placeholders
          // + omni workers that died before capturing a Claude session).
          currentSessionId: undefined,
        },
      ];
      const updates: { id: string; updates: Record<string, unknown> }[] = [];
      const { deps, logs } = createMockDeps(
        {},
        {
          listWorkers: async () => workers,
          updateAgent: async (id, u) => {
            updates.push({ id, updates: u });
          },
        },
      );

      const flipped = await reconcileUnresumable(deps);

      expect(flipped).toBe(1);
      expect(updates).toHaveLength(1);
      expect(updates[0].id).toBe('wedged-agent');
      expect(updates[0].updates.autoResume).toBe(false);

      const marked = logs.find((l) => l.event === 'agent_marked_unresumable');
      expect(marked).toBeDefined();
      expect(marked?.agent_id).toBe('wedged-agent');
      expect(marked?.reason).toBe('no_session_id');
    });

    test('leaves error-state agents with a valid claude_session_id untouched', async () => {
      const workers: WorkerInfo[] = [
        {
          id: 'resumable-agent',
          paneId: '%42',
          state: 'error',
          autoResume: true,
          // Valid session id — the scheduler CAN still retry this agent.
          // The reconciler must NOT flip auto_resume here.
          currentSessionId: 'abcd-1234-valid-uuid',
        },
        {
          id: 'already-disabled',
          paneId: '%43',
          state: 'error',
          autoResume: false,
          currentSessionId: undefined,
        },
        {
          id: 'healthy-working',
          paneId: '%44',
          state: 'working',
          autoResume: true,
          currentSessionId: undefined,
        },
      ];
      const updates: { id: string; updates: Record<string, unknown> }[] = [];
      const { deps, logs } = createMockDeps(
        {},
        {
          listWorkers: async () => workers,
          updateAgent: async (id, u) => {
            updates.push({ id, updates: u });
          },
        },
      );

      const flipped = await reconcileUnresumable(deps);

      // None of the three rows match the (error + auto_resume=true + null-session) triple.
      expect(flipped).toBe(0);
      expect(updates).toHaveLength(0);
      const marked = logs.find((l) => l.event === 'agent_marked_unresumable');
      expect(marked).toBeUndefined();
    });
  });

  describe('attemptAgentResume exhaustion — Bug B: persist auto_resume=false', () => {
    function makeWorker(overrides: Partial<WorkerInfo> = {}): WorkerInfo {
      return {
        id: 'test-agent',
        paneId: '%42',
        state: 'error',
        currentSessionId: 'session-abc',
        autoResume: true,
        resumeAttempts: 0,
        maxResumeAttempts: 3,
        ...overrides,
      };
    }

    test('exhaustion branch persists auto_resume=false alongside the log event', async () => {
      // Direct reproduction of the Bug B observation: an already-exhausted
      // agent (attempts==max) re-entering attemptAgentResume must (1) still
      // fire `agent_resume_exhausted` for backward compat, AND (2) write
      // `auto_resume=false` so the next cycle's resumable filter excludes it.
      const agent = makeWorker({ resumeAttempts: 3, maxResumeAttempts: 3 });
      const updates: { id: string; updates: Record<string, unknown> }[] = [];
      const { deps, logs } = createMockDeps(
        {},
        {
          updateAgent: async (id, u) => {
            updates.push({ id, updates: u });
          },
        },
      );

      const result = await attemptAgentResume(deps, defaultConfig, agent);

      expect(result).toBe('exhausted');
      // Backward compat: exhaustion event still fires.
      const exhausted = logs.find((l) => l.event === 'agent_resume_exhausted');
      expect(exhausted).toBeDefined();
      expect(exhausted?.resume_attempts).toBe(3);
      // New invariant: auto_resume=false was persisted.
      const flip = updates.find((u) => u.updates.autoResume === false);
      expect(flip).toBeDefined();
      expect(flip?.id).toBe('test-agent');
    });

    test('subsequent recovery cycle excludes the now-unresumable agent (no new event)', async () => {
      // Simulate two consecutive scheduler ticks. On tick 1 the agent is
      // exhausted → auto_resume flipped to false. On tick 2 runAgentRecoveryPass
      // must exclude the agent entirely (the resumable filter already drops
      // `autoResume=false` implicitly via attemptAgentResume's early-skip,
      // but we test the end-to-end exclusion: no new `agent_resume_exhausted`
      // fires).
      //
      // Legacy semantics — Phase B (Group 8) defaults the turn-aware flag ON,
      // which would short-circuit a `state='error'` worker via
      // `agent_resume_skipped_turn_aware` before reaching the exhaustion
      // branch. Opt out explicitly so this test continues to exercise the
      // Bug B resume-exhaustion path.
      process.env[TURN_AWARE_RECONCILER_FLAG] = '0';
      let row: WorkerInfo = {
        id: 'exhausted-agent',
        paneId: '%99',
        state: 'error',
        currentSessionId: 'sess-valid',
        autoResume: true,
        resumeAttempts: 3,
        maxResumeAttempts: 3,
      };

      const { deps, logs } = createMockDeps(
        {},
        {
          listWorkers: async () => [row],
          isPaneAlive: async () => false,
          updateAgent: async (_id, u) => {
            row = { ...row, ...u } as WorkerInfo;
          },
        },
      );

      // Tick 1: runs the full recovery pass. Agent is exhausted → flipped.
      await runAgentRecoveryPass(deps, 'daemon-t1', defaultConfig);
      const exhaustedCountAfterT1 = logs.filter((l) => l.event === 'agent_resume_exhausted').length;
      expect(exhaustedCountAfterT1).toBe(1);
      expect(row.autoResume).toBe(false);

      // Tick 2: same agent, now with auto_resume=false from tick 1. The
      // recovery pass must NOT re-log `agent_resume_exhausted` — the agent
      // is filtered out before reaching the exhaustion check. Before the
      // Bug B fix, this count would grow by 1 on every 60s tick forever.
      await runAgentRecoveryPass(deps, 'daemon-t2', defaultConfig);
      const exhaustedCountAfterT2 = logs.filter((l) => l.event === 'agent_resume_exhausted').length;
      expect(exhaustedCountAfterT2).toBe(1);
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
          currentSessionId: 'sess-1',
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
        { id: 'agent-1', paneId: '%42', state: 'working', autoResume: false, currentSessionId: 'sess-1' },
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
          currentSessionId: 'sess-1',
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
    // Legacy semantics — these tests pre-date the turn-aware reconciler.
    // Phase B (Group 8) defaults the flag ON, which would route `state='idle'`
    // dead-pane workers into the D1 terminalize path instead of resume. Opt
    // out for the whole describe so each test exercises the pre-Phase-B
    // auto-resume-everything-dead behavior.
    beforeEach(() => {
      process.env[TURN_AWARE_RECONCILER_FLAG] = '0';
    });

    test('auto-resumes agents with dead panes on startup', async () => {
      const workers: WorkerInfo[] = [
        {
          id: 'agent-1',
          paneId: '%42',
          state: 'working',
          autoResume: true,
          currentSessionId: 'sess-1',
          resumeAttempts: 0,
        },
        {
          id: 'agent-2',
          paneId: '%43',
          state: 'idle',
          autoResume: true,
          currentSessionId: 'sess-2',
          resumeAttempts: 0,
        },
        { id: 'agent-done', paneId: '%44', state: 'done', currentSessionId: 'sess-3' },
        { id: 'agent-suspended', paneId: '%45', state: 'suspended', currentSessionId: 'sess-4' },
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
          currentSessionId: 'sess-1',
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

    test('per-worker isPaneAlive tmux-down failure is skipped (not counted as failed)', async () => {
      // Regression 1: fault isolation — one isPaneAlive throw must not abort
      // the recovery loop for remaining workers.
      //
      // Regression 2 (2026-04-21): when tmux is unreachable (stale socket, no
      // server running, server exited, error connecting), we cannot probe any
      // pane this tick. Emitting `recovery_worker_failed` at warn level per
      // worker per tick floods scheduler.log with useless noise while the
      // registry reconciler's dead-socket fast-path is the real recovery
      // mechanism. This test pins the quiet-skip behaviour: the worker is
      // skipped silently (debug event only) and does NOT count as failed.
      const workers: WorkerInfo[] = [
        {
          id: 'agent-first-tmux-down',
          paneId: '%42',
          state: 'working',
          autoResume: true,
          currentSessionId: 'sess-1',
          resumeAttempts: 0,
        },
        {
          id: 'agent-second-ok',
          paneId: '%43',
          state: 'idle',
          autoResume: true,
          currentSessionId: 'sess-2',
          resumeAttempts: 0,
        },
      ];

      const resumedAgents: string[] = [];
      const { deps, logs } = createMockDeps(
        { triggers: [], runs: [] },
        {
          listWorkers: async () => workers,
          isPaneAlive: async (paneId) => {
            if (paneId === '%42') {
              throw new Error(
                'Failed to execute tmux command: error connecting to /tmp/tmux-1000/genie (No such file or directory)',
              );
            }
            return false;
          },
          resumeAgent: async (id) => {
            resumedAgents.push(id);
            return true;
          },
          updateAgent: async () => {},
        },
      );

      await recoverOnStartup(deps, 'daemon-1', defaultConfig);

      expect(resumedAgents).toEqual(['agent-second-ok']);
      // Tmux-down path is quiet (debug), not warn — no recovery_worker_failed.
      const failureLog = logs.find(
        (l) => l.event === 'recovery_worker_failed' && l.worker_id === 'agent-first-tmux-down',
      );
      expect(failureLog).toBeUndefined();
      const skipLog = logs.find(
        (l) => l.event === 'recovery_worker_skipped_tmux_down' && l.worker_id === 'agent-first-tmux-down',
      );
      expect(skipLog).toBeDefined();
      expect(skipLog?.level).toBe('debug');
      // failed_agents does NOT include tmux-down — those are transient, not failures.
      const completed = logs.find((l) => l.event === 'recovery_completed');
      expect(completed?.resumed_agents).toBe(1);
      expect(completed?.failed_agents).toBe(0);
    });

    test('non-tmux per-worker probe error still logs recovery_worker_failed', async () => {
      // Defense in depth: real probe bugs (PG connection reset, assertion
      // errors, etc.) must still surface as warn-level failures so they
      // don't hide behind the tmux-down quiet path.
      const workers: WorkerInfo[] = [
        {
          id: 'agent-probe-bug',
          paneId: '%42',
          state: 'working',
          autoResume: true,
          currentSessionId: 'sess-1',
          resumeAttempts: 0,
        },
      ];

      const { deps, logs } = createMockDeps(
        { triggers: [], runs: [] },
        {
          listWorkers: async () => workers,
          isPaneAlive: async () => {
            throw new Error('ECONNRESET while probing pane');
          },
          resumeAgent: async () => true,
          updateAgent: async () => {},
        },
      );

      await recoverOnStartup(deps, 'daemon-1', defaultConfig);

      const failureLog = logs.find((l) => l.event === 'recovery_worker_failed' && l.worker_id === 'agent-probe-bug');
      expect(failureLog).toBeDefined();
      expect(failureLog?.level).toBe('warn');
      const completed = logs.find((l) => l.event === 'recovery_completed');
      expect(completed?.failed_agents).toBe(1);
    });

    test('schedules a retry when the initial pass has per-worker failures', async () => {
      const workers: WorkerInfo[] = [
        {
          id: 'agent-flaky',
          paneId: '%42',
          state: 'working',
          autoResume: true,
          currentSessionId: 'sess-1',
          resumeAttempts: 0,
        },
      ];

      const { deps, logs } = createMockDeps(
        { triggers: [], runs: [] },
        {
          listWorkers: async () => workers,
          isPaneAlive: async () => {
            throw new Error('tmux socket not ready');
          },
          resumeAgent: async () => true,
          updateAgent: async () => {},
        },
      );

      await recoverOnStartup(deps, 'daemon-1', defaultConfig);

      const retryScheduled = logs.find((l) => l.event === 'recovery_retry_scheduled');
      expect(retryScheduled).toBeDefined();
      expect(retryScheduled?.failed_agents).toBe(1);
    });

    test('does not schedule a retry when every worker recovers cleanly', async () => {
      const workers: WorkerInfo[] = [
        {
          id: 'agent-ok',
          paneId: '%42',
          state: 'working',
          autoResume: true,
          currentSessionId: 'sess-1',
          resumeAttempts: 0,
        },
      ];

      const { deps, logs } = createMockDeps(
        { triggers: [], runs: [] },
        {
          listWorkers: async () => workers,
          isPaneAlive: async () => false,
          resumeAgent: async () => true,
          updateAgent: async () => {},
        },
      );

      await recoverOnStartup(deps, 'daemon-1', defaultConfig);

      const retryScheduled = logs.find((l) => l.event === 'recovery_retry_scheduled');
      expect(retryScheduled).toBeUndefined();
    });
  });

  // ==========================================================================
  // Lease Recovery — periodic reclaim of expired trigger leases
  // ==========================================================================

  describe('periodic lease recovery', () => {
    test('reclaimExpiredLeases resets expired executing triggers to pending', async () => {
      const triggers = [
        {
          id: 'trig-stuck',
          schedule_id: 'sched-1',
          due_at: new Date('2026-03-20T10:00:00Z'),
          status: 'executing',
          leased_until: new Date('2026-03-20T11:50:00Z'),
          leased_by: 'crashed-daemon',
          idempotency_key: null,
        },
      ];
      const { deps, logs, mock } = createMockDeps({ triggers });

      const count = await reclaimExpiredLeases(deps, 'recovery-daemon');

      expect(count).toBe(1);
      const reclaimLog = logs.find((l) => l.event === 'expired_leases_reclaimed');
      expect(reclaimLog).toBeDefined();
      expect(reclaimLog?.count).toBe(1);
      expect(reclaimLog?.daemon_id).toBe('recovery-daemon');

      const updateQuery = mock.queries.find(
        (q) => q.query.includes('UPDATE triggers') && q.query.includes('leased_until'),
      );
      expect(updateQuery).toBeDefined();
    });

    test('does not reclaim triggers with valid (unexpired) leases', async () => {
      const { deps, logs } = createMockDeps({ triggers: [] });

      const count = await reclaimExpiredLeases(deps, 'daemon-1');

      expect(count).toBe(0);
      const reclaimLog = logs.find((l) => l.event === 'expired_leases_reclaimed');
      expect(reclaimLog).toBeUndefined();
    });

    test('startup recovery reclaims expired trigger leases', async () => {
      const triggers = [
        {
          id: 'trig-stuck-1',
          schedule_id: 'sched-1',
          due_at: new Date('2026-03-20T10:00:00Z'),
          status: 'executing',
          leased_until: new Date('2026-03-20T11:00:00Z'),
          leased_by: 'dead-daemon',
          idempotency_key: null,
        },
      ];
      const { deps, logs } = createMockDeps({ triggers, runs: [] });

      await recoverOnStartup(deps, 'new-daemon', defaultConfig);

      const recoveryLog = logs.find((l) => l.event === 'recovery_completed');
      expect(recoveryLog).toBeDefined();
      expect(recoveryLog?.reclaimed_leases).toBe(1);
    });

    test('daemon runs periodic lease recovery during operation', async () => {
      let reclaimCallCount = 0;
      const triggers = [
        {
          id: 'trig-stuck',
          schedule_id: 'sched-1',
          due_at: new Date('2026-03-20T10:00:00Z'),
          status: 'executing',
          leased_until: new Date('2026-03-20T11:00:00Z'),
          leased_by: 'crashed-daemon',
          idempotency_key: null,
        },
      ];
      const { deps } = createMockDeps(
        { triggers, runs: [] },
        {
          sleep: async () => {},
        },
      );

      const origGetConnection = deps.getConnection;
      deps.getConnection = async () => {
        const sql = await origGetConnection();
        const wrappedSql = (strings: TemplateStringsArray, ...values: unknown[]) => {
          const query = strings.join('?');
          if (query.includes('UPDATE triggers') && query.includes('leased_until')) {
            reclaimCallCount++;
          }
          return sql(strings, ...values);
        };
        wrappedSql.begin = sql.begin;
        wrappedSql.listen = sql.listen;
        wrappedSql.end = sql.end;
        return wrappedSql;
      };

      const handle = startDaemon(
        {
          pollIntervalMs: 200,
          leaseRecoveryIntervalMs: 50,
          heartbeatIntervalMs: 100_000,
          orphanCheckIntervalMs: 100_000,
        },
        deps,
      );

      await new Promise((resolve) => setTimeout(resolve, 300));
      handle.stop();
      await Promise.race([handle.done, new Promise((resolve) => setTimeout(resolve, 2000))]);

      expect(reclaimCallCount).toBeGreaterThanOrEqual(2);
    });

    test('claimDueTriggers sets 5-minute lease on claimed triggers', async () => {
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
      const { deps, mock } = createMockDeps({ triggers });

      await claimDueTriggers(deps, defaultConfig, 'daemon-1');

      const leaseQuery = mock.queries.find(
        (q) => q.query.includes('UPDATE triggers') && q.query.includes('leased_until') && q.query.includes('leased_by'),
      );
      expect(leaseQuery).toBeDefined();
      const expectedLeaseUntil = new Date('2026-03-20T12:05:00Z');
      if (leaseQuery?.values) {
        const leaseUntilValue = leaseQuery.values.find(
          (v) => v instanceof Date && (v as Date).getTime() === expectedLeaseUntil.getTime(),
        );
        expect(leaseUntilValue).toBeDefined();
      }
    });
  });

  // ============================================================================
  // Mailbox delivery retry — escalation recursion guards
  // ============================================================================
  //
  // Regression coverage for the 181K-event escalation loop observed on
  // felipe's machine over 8 days (2026-04-10 → 2026-04-17). The daemon's
  // retry loop escalated failed-delivery messages by posting a new mailbox
  // row `from='scheduler'`, `to='team-lead'`. Because `'team-lead'` is a
  // bare, unresolvable recipient, that escalation row itself hit
  // MAX_DELIVERY_ATTEMPTS and was escalated again → infinite chain.
  // `processMailboxRetryMessage` now applies 3 guards to break the loop.
  describe('processMailboxRetryMessage — escalation recursion guards', () => {
    function createRetryableMsg(overrides: Partial<MailboxMessage> = {}): MailboxMessage {
      return {
        id: 'msg-1',
        from: 'genie-configure',
        to: 'genie-reviewer',
        body: 'please review the draft',
        createdAt: '2026-04-17T12:00:00Z',
        read: false,
        deliveredAt: null,
        ...overrides,
      };
    }

    /**
     * Mock connection whose mailbox SELECT returns `delivery_attempts ===
     * MAX_DELIVERY_ATTEMPTS` so the retry logic hits the escalation branch.
     */
    function createExhaustedDeps(repoPath: string | null = '/tmp/repo') {
      const logs: LogEntry[] = [];
      const sentRows: { repoPath: string; from: string; to: string; body: string }[] = [];

      const sql: any = (strings: TemplateStringsArray, ..._values: unknown[]) => {
        const query = strings.join('?');
        if (query.includes('SELECT delivery_attempts, repo_path FROM mailbox')) {
          return [{ delivery_attempts: MAX_DELIVERY_ATTEMPTS, repo_path: repoPath }];
        }
        return [];
      };
      sql.begin = async (fn: (tx: typeof sql) => Promise<unknown>) => fn(sql);
      sql.listen = async () => {};
      sql.end = async () => {};

      const deps: SchedulerDeps = {
        getConnection: async () => sql,
        spawnCommand: async () => ({ pid: 0 }),
        log: (entry) => logs.push(entry),
        generateId: () => 'test-id',
        now: () => new Date('2026-04-17T12:00:00Z'),
        sleep: async () => {},
        jitter: (maxMs) => Math.floor(maxMs / 2),
        isPaneAlive: async () => true,
        listWorkers: async () => [],
        countTmuxSessions: async () => 0,
        publishEvent: async () => {},
        resumeAgent: async () => true,
        updateAgent: async () => {},
      };

      const deliverFn = async () => false; // delivery always fails — forces escalation branch
      const sendFn = async (repoArg: string, from: string, to: string, body: string) => {
        sentRows.push({ repoPath: repoArg, from, to, body });
        return { id: `msg-sent-${sentRows.length}`, from, to, body, createdAt: '', read: false, deliveredAt: null };
      };

      return { deps, logs, sentRows, deliverFn, sendFn };
    }

    test('Guard 1: scheduler-authored message does not produce a new escalation row', async () => {
      const { deps, logs, sentRows, deliverFn, sendFn } = createExhaustedDeps();
      const msg = createRetryableMsg({ from: 'scheduler', to: 'team-lead', body: '[escalation] older failure' });

      await processMailboxRetryMessage(deps, msg, { deliverFn, sendFn });

      expect(sentRows).toHaveLength(0);
      const dropped = logs.find((l) => l.event === 'mailbox_delivery_escalation_dropped');
      expect(dropped).toBeDefined();
      expect(dropped?.reason).toBe('already_escalated_by_scheduler');
      expect(dropped?.messageId).toBe('msg-1');
      expect(logs.find((l) => l.event === 'mailbox_delivery_escalated')).toBeUndefined();
    });

    test('Guard 2: [escalation]-prefixed body is dropped even without scheduler authorship', async () => {
      const { deps, logs, sentRows, deliverFn, sendFn } = createExhaustedDeps();
      const msg = createRetryableMsg({
        from: 'genie-configure',
        to: 'some-other-worker',
        body: '[escalation] replayed escalation from another sender',
      });

      await processMailboxRetryMessage(deps, msg, { deliverFn, sendFn });

      expect(sentRows).toHaveLength(0);
      const dropped = logs.find((l) => l.event === 'mailbox_delivery_escalation_dropped');
      expect(dropped).toBeDefined();
      expect(dropped?.reason).toBe('body_prefix');
    });

    test('Guard 3: message addressed to ESCALATION_RECIPIENT from a non-scheduler sender is dropped', async () => {
      const { deps, logs, sentRows, deliverFn, sendFn } = createExhaustedDeps();
      const msg = createRetryableMsg({
        from: 'genie-configure',
        to: ESCALATION_RECIPIENT,
        body: 'direct message to team-lead that exhausted retries',
      });

      await processMailboxRetryMessage(deps, msg, { deliverFn, sendFn });

      expect(sentRows).toHaveLength(0);
      const dropped = logs.find((l) => l.event === 'mailbox_delivery_escalation_dropped');
      expect(dropped).toBeDefined();
      expect(dropped?.reason).toBe('same_recipient');
    });

    test('positive path: legitimate worker→worker failure still produces an escalation row', async () => {
      const { deps, logs, sentRows, deliverFn, sendFn } = createExhaustedDeps();
      const msg = createRetryableMsg({
        from: 'genie-configure',
        to: 'genie-reviewer',
        body: 'please review this draft',
      });

      await processMailboxRetryMessage(deps, msg, { deliverFn, sendFn });

      expect(sentRows).toHaveLength(1);
      expect(sentRows[0].from).toBe('scheduler');
      expect(sentRows[0].to).toBe(ESCALATION_RECIPIENT);
      expect(sentRows[0].body.startsWith('[escalation] ')).toBe(true);
      expect(logs.find((l) => l.event === 'mailbox_delivery_escalated')).toBeDefined();
      expect(logs.find((l) => l.event === 'mailbox_delivery_escalation_dropped')).toBeUndefined();
    });

    test('regression: 10 consecutive 3-fail cycles on scheduler-authored team-lead row produce 0 new rows', async () => {
      const { deps, logs, sentRows, deliverFn, sendFn } = createExhaustedDeps();
      const msg = createRetryableMsg({
        from: 'scheduler',
        to: 'team-lead',
        body: '[escalation] Message msg-orig from "x" to "y" failed delivery',
      });

      for (let i = 0; i < 10; i++) {
        await processMailboxRetryMessage(deps, msg, { deliverFn, sendFn });
      }

      // Zero new mailbox rows from 10 cycles — this is the property that keeps
      // the mailbox table from growing by 1500/h indefinitely.
      expect(sentRows).toHaveLength(0);
      const dropped = logs.filter((l) => l.event === 'mailbox_delivery_escalation_dropped');
      expect(dropped).toHaveLength(10);
      expect(dropped.every((l) => l.reason === 'already_escalated_by_scheduler')).toBe(true);
    });
  });
});

// ============================================================================
// Turn-session-contract (Group 4) — D1 / D3 reconciler logic
// ============================================================================

/**
 * In-memory fake of the PG state touched by `terminalizeCleanExitUnverified`
 * and the flag-ON branch of `runAgentRecoveryPass`. Lets tests assert on the
 * exact writes (outcome, close_reason, current_executor_id) without spinning
 * up a real database.
 */
function createTerminalStateFake(seed: {
  agent: { id: string; currentExecutorId: string | null; state: AgentState };
  executor?: { id: string; closedAt: Date | null; outcome: string | null };
}) {
  const agentRow: { current_executor_id: string | null; state: string; last_state_change: string | null } = {
    current_executor_id: seed.agent.currentExecutorId,
    state: seed.agent.state,
    last_state_change: null,
  };
  const executorRow: { closed_at: Date | null; outcome: string | null; close_reason: string | null; state: string } = {
    closed_at: seed.executor?.closedAt ?? null,
    outcome: seed.executor?.outcome ?? null,
    close_reason: null,
    state: 'running',
  };
  const audit: Record<string, unknown>[] = [];

  const sql: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?');
    if (query.includes('SELECT current_executor_id FROM agents')) {
      return [{ current_executor_id: agentRow.current_executor_id }];
    }
    if (query.includes('SELECT closed_at, outcome FROM executors')) {
      return [{ closed_at: executorRow.closed_at, outcome: executorRow.outcome }];
    }
    if (query.includes('UPDATE executors')) {
      executorRow.state = 'error';
      executorRow.outcome = 'clean_exit_unverified';
      executorRow.close_reason = values[0] as string;
      executorRow.closed_at = new Date(values[1] as string);
      return [];
    }
    if (query.includes('UPDATE agents') && query.includes('current_executor_id = NULL')) {
      agentRow.current_executor_id = null;
      agentRow.state = 'error';
      agentRow.last_state_change = values[0] as string;
      return [];
    }
    if (query.includes('UPDATE agents')) {
      agentRow.state = 'error';
      agentRow.last_state_change = values[0] as string;
      return [];
    }
    if (query.includes('INSERT INTO audit_events')) {
      audit.push({ values });
      return [];
    }
    return [];
  };

  sql.begin = async (fn: (tx: typeof sql) => Promise<unknown>) => fn(sql);
  sql.json = (v: unknown) => v;

  return { sql, agentRow, executorRow, audit };
}

describe('terminalizeCleanExitUnverified (D1 write)', () => {
  const worker: WorkerInfo = {
    id: 'agent-idle-dead',
    paneId: '%77',
    state: 'idle',
    currentSessionId: 'sess-idle',
    autoResume: true,
    resumeAttempts: 0,
  };

  test('writes clean_exit_unverified terminal state when executor is open', async () => {
    const fake = createTerminalStateFake({
      agent: { id: worker.id, currentExecutorId: 'exec-1', state: 'idle' },
      executor: { id: 'exec-1', closedAt: null, outcome: null },
    });
    const { deps, logs } = createMockDeps({}, { getConnection: async () => fake.sql });

    const res = await terminalizeCleanExitUnverified(deps, worker, 'reconciler_idle_dead_pane');

    expect(res).toEqual({ terminalized: true, executorId: 'exec-1' });
    expect(fake.executorRow.outcome).toBe('clean_exit_unverified');
    expect(fake.executorRow.close_reason).toBe('reconciler_idle_dead_pane');
    expect(fake.executorRow.state).toBe('error');
    expect(fake.executorRow.closed_at).not.toBeNull();
    // Post-2026-04-25 power-outage post-mortem: keep current_executor_id
    // pointing at the just-terminated executor so its claude_session_id
    // survives as the recovery anchor for getResumeSessionId. Liveness is
    // gated by executor.state via getCurrentExecutor / getLiveExecutorState,
    // so the FK staying populated is safe — and required for post-crash
    // auto-resume to find the dormant session.
    expect(fake.agentRow.current_executor_id).toBe('exec-1');
    expect(fake.agentRow.state).toBe('error');
    expect(fake.audit).toHaveLength(1);
    expect(logs.find((l) => l.event === 'terminalize_clean_exit_unverified_failed')).toBeUndefined();
  });

  test('is idempotent when executor is already closed (first-writer-wins with pane trap / verbs)', async () => {
    const fake = createTerminalStateFake({
      agent: { id: worker.id, currentExecutorId: 'exec-2', state: 'idle' },
      executor: { id: 'exec-2', closedAt: new Date('2026-04-20T11:59:00Z'), outcome: 'done' },
    });
    const { deps } = createMockDeps({}, { getConnection: async () => fake.sql });

    const res = await terminalizeCleanExitUnverified(deps, worker, 'reconciler_idle_dead_pane');

    expect(res).toEqual({ terminalized: false, executorId: 'exec-2' });
    expect(fake.executorRow.outcome).toBe('done'); // not overwritten
    expect(fake.executorRow.close_reason).toBeNull();
    // Recovery-anchor preservation: even on the idempotent branch the FK
    // stays populated. See note above.
    expect(fake.agentRow.current_executor_id).toBe('exec-2');
    expect(fake.agentRow.state).toBe('error');
    expect(fake.audit).toHaveLength(0);
  });

  test('flips agent to error when current_executor_id is missing', async () => {
    const fake = createTerminalStateFake({
      agent: { id: worker.id, currentExecutorId: null, state: 'idle' },
    });
    const { deps } = createMockDeps({}, { getConnection: async () => fake.sql });

    const res = await terminalizeCleanExitUnverified(deps, worker, 'reconciler_idle_dead_pane');

    expect(res).toEqual({ terminalized: false, executorId: null });
    expect(fake.agentRow.state).toBe('error');
    expect(fake.audit).toHaveLength(0);
  });

  test('never throws — DB errors are logged and swallowed', async () => {
    const bomb = {
      begin: async () => {
        throw new Error('PG exploded');
      },
    };
    const { deps, logs } = createMockDeps({}, { getConnection: async () => bomb as any });

    const res = await terminalizeCleanExitUnverified(deps, worker, 'reconciler_idle_dead_pane');

    expect(res).toEqual({ terminalized: false, executorId: null });
    const failed = logs.find((l) => l.event === 'terminalize_clean_exit_unverified_failed');
    expect(failed).toBeDefined();
    expect(failed?.error).toBe('PG exploded');
  });
});

describe('runAgentRecoveryPass — turn-aware D1 / D3 routing', () => {
  const savedFlag = process.env[TURN_AWARE_RECONCILER_FLAG];

  beforeEach(() => {
    delete process.env[TURN_AWARE_RECONCILER_FLAG];
  });

  afterEach(() => {
    if (savedFlag === undefined) delete process.env[TURN_AWARE_RECONCILER_FLAG];
    else process.env[TURN_AWARE_RECONCILER_FLAG] = savedFlag;
  });

  function makeWorker(state: AgentState, id = 'agent-x'): WorkerInfo {
    return {
      id,
      paneId: '%99',
      state,
      currentSessionId: 'sess-x',
      autoResume: true,
      resumeAttempts: 0,
      maxResumeAttempts: 3,
    };
  }

  test('flag OFF: idle + dead pane still resumes (legacy behavior preserved)', async () => {
    process.env[TURN_AWARE_RECONCILER_FLAG] = '0';
    const w = makeWorker('idle');
    let resumeCalls = 0;
    const { deps } = createMockDeps(
      {},
      {
        listWorkers: async () => [w],
        isPaneAlive: async () => false,
        resumeAgent: async () => {
          resumeCalls++;
          return true;
        },
      },
    );

    const res = await runAgentRecoveryPass(deps, 'daemon-off', defaultConfig);

    expect(resumeCalls).toBe(1);
    expect(res.resumed).toBe(1);
    expect(res.terminalized).toBe(0);
  });

  test('flag ON: idle + dead pane → terminalize, no resume (D1)', async () => {
    process.env[TURN_AWARE_RECONCILER_FLAG] = '1';
    const w = makeWorker('idle', 'agent-d1');
    const fake = createTerminalStateFake({
      agent: { id: w.id, currentExecutorId: 'exec-d1', state: 'idle' },
      executor: { id: 'exec-d1', closedAt: null, outcome: null },
    });
    let resumeCalls = 0;
    const { deps, logs } = createMockDeps(
      {},
      {
        listWorkers: async () => [w],
        isPaneAlive: async () => false,
        resumeAgent: async () => {
          resumeCalls++;
          return true;
        },
        getConnection: async () => fake.sql,
      },
    );

    const res = await runAgentRecoveryPass(deps, 'daemon-d1', defaultConfig);

    expect(resumeCalls).toBe(0);
    expect(res.resumed).toBe(0);
    expect(res.terminalized).toBe(1);
    expect(fake.executorRow.outcome).toBe('clean_exit_unverified');
    expect(fake.agentRow.state).toBe('error');
    const terminalLog = logs.find((l) => l.event === 'agent_terminalized_clean_exit_unverified');
    expect(terminalLog).toBeDefined();
    expect(terminalLog?.agent_id).toBe('agent-d1');
    expect(terminalLog?.executor_id).toBe('exec-d1');
  });

  test.each<AgentState>(['working', 'permission', 'question'])(
    'flag ON: state=%s + dead pane → resume (D3)',
    async (state) => {
      process.env[TURN_AWARE_RECONCILER_FLAG] = '1';
      const w = makeWorker(state, `agent-d3-${state}`);
      let resumeCalls = 0;
      const { deps } = createMockDeps(
        {},
        {
          listWorkers: async () => [w],
          isPaneAlive: async () => false,
          resumeAgent: async () => {
            resumeCalls++;
            return true;
          },
        },
      );

      const res = await runAgentRecoveryPass(deps, `daemon-d3-${state}`, defaultConfig);

      expect(resumeCalls).toBe(1);
      expect(res.resumed).toBe(1);
      expect(res.terminalized).toBe(0);
    },
  );

  test('flag ON: state=error + dead pane → skipped, no resume (prevents post-D1 ghost loop)', async () => {
    process.env[TURN_AWARE_RECONCILER_FLAG] = '1';
    const w = makeWorker('error', 'agent-err');
    let resumeCalls = 0;
    const { deps, logs } = createMockDeps(
      {},
      {
        listWorkers: async () => [w],
        isPaneAlive: async () => false,
        resumeAgent: async () => {
          resumeCalls++;
          return true;
        },
      },
    );

    const res = await runAgentRecoveryPass(deps, 'daemon-err', defaultConfig);

    expect(resumeCalls).toBe(0);
    expect(res.terminalized).toBe(0);
    expect(logs.some((l) => l.event === 'agent_resume_skipped_turn_aware' && l.state === 'error')).toBe(true);
  });

  test('C20 regression: ghost-loop cannot replay across multiple ticks when idle+dead (flag ON)', async () => {
    process.env[TURN_AWARE_RECONCILER_FLAG] = '1';
    // Model the exact 2026-04-19 scenario: an agent sits in state='idle' while
    // its tmux pane is dead. Legacy code resumed on every tick (60s forever).
    // Under flag ON, tick 1 terminalizes to state='error'; tick 2 finds error
    // and skips — resume is never called.
    let row = makeWorker('idle', 'ghost-agent');
    const fake = createTerminalStateFake({
      agent: { id: row.id, currentExecutorId: 'exec-ghost', state: 'idle' },
      executor: { id: 'exec-ghost', closedAt: null, outcome: null },
    });

    let resumeCalls = 0;
    const { deps, logs } = createMockDeps(
      {},
      {
        listWorkers: async () => [row],
        isPaneAlive: async () => false,
        resumeAgent: async () => {
          resumeCalls++;
          return true;
        },
        getConnection: async () => fake.sql,
        updateAgent: async (_id, u) => {
          row = { ...row, ...u } as WorkerInfo;
        },
      },
    );

    // Tick 1: D1 terminalize
    const t1 = await runAgentRecoveryPass(deps, 'daemon-c20-t1', defaultConfig);
    expect(t1.terminalized).toBe(1);
    expect(resumeCalls).toBe(0);
    // Simulate agent-registry re-read after the terminal write
    row = { ...row, state: 'error' };

    // Ticks 2..5: state='error' → skipped
    for (let i = 0; i < 4; i++) {
      const tick = await runAgentRecoveryPass(deps, `daemon-c20-t${i + 2}`, defaultConfig);
      expect(tick.resumed).toBe(0);
      expect(tick.terminalized).toBe(0);
    }
    expect(resumeCalls).toBe(0);
    // And only ONE terminalize event fired across all ticks.
    expect(logs.filter((l) => l.event === 'agent_terminalized_clean_exit_unverified')).toHaveLength(1);
  });
});

// ============================================================================
// Turn-session-contract (Group 1) — reconciler flag scaffolding
// ============================================================================

describe('turn-aware reconciler flag', () => {
  const prev = process.env[TURN_AWARE_RECONCILER_FLAG];

  afterEach(() => {
    if (prev === undefined) delete process.env[TURN_AWARE_RECONCILER_FLAG];
    else process.env[TURN_AWARE_RECONCILER_FLAG] = prev;
  });

  test('flag constant matches expected name', () => {
    expect(TURN_AWARE_RECONCILER_FLAG).toBe('GENIE_RECONCILER_TURN_AWARE');
  });

  test('isTurnAwareReconcilerEnabled defaults to true when unset (Phase B, Group 8)', () => {
    expect(isTurnAwareReconcilerEnabled({})).toBe(true);
  });

  test('isTurnAwareReconcilerEnabled treats empty string as unset (Phase B default ON)', () => {
    expect(isTurnAwareReconcilerEnabled({ [TURN_AWARE_RECONCILER_FLAG]: '' })).toBe(true);
  });

  test('isTurnAwareReconcilerEnabled rollback: explicit 0/false/no → false', () => {
    expect(isTurnAwareReconcilerEnabled({ [TURN_AWARE_RECONCILER_FLAG]: '0' })).toBe(false);
    expect(isTurnAwareReconcilerEnabled({ [TURN_AWARE_RECONCILER_FLAG]: 'false' })).toBe(false);
    expect(isTurnAwareReconcilerEnabled({ [TURN_AWARE_RECONCILER_FLAG]: 'FALSE' })).toBe(false);
    expect(isTurnAwareReconcilerEnabled({ [TURN_AWARE_RECONCILER_FLAG]: 'no' })).toBe(false);
    expect(isTurnAwareReconcilerEnabled({ [TURN_AWARE_RECONCILER_FLAG]: ' False ' })).toBe(false);
  });

  test('isTurnAwareReconcilerEnabled accepts "1"/"true"/"yes" (case-insensitive)', () => {
    expect(isTurnAwareReconcilerEnabled({ [TURN_AWARE_RECONCILER_FLAG]: '1' })).toBe(true);
    expect(isTurnAwareReconcilerEnabled({ [TURN_AWARE_RECONCILER_FLAG]: 'true' })).toBe(true);
    expect(isTurnAwareReconcilerEnabled({ [TURN_AWARE_RECONCILER_FLAG]: 'TRUE' })).toBe(true);
    expect(isTurnAwareReconcilerEnabled({ [TURN_AWARE_RECONCILER_FLAG]: ' True ' })).toBe(true);
    expect(isTurnAwareReconcilerEnabled({ [TURN_AWARE_RECONCILER_FLAG]: 'yes' })).toBe(true);
  });

  test('logReconcilerMode emits turn-aware event when flag is unset (Phase B default ON)', () => {
    delete process.env[TURN_AWARE_RECONCILER_FLAG];
    const logs: LogEntry[] = [];
    logReconcilerMode({ log: (e) => logs.push(e), now: () => new Date('2026-04-20T00:00:00Z') }, 'daemon-abc');
    expect(logs).toHaveLength(1);
    expect(logs[0].event).toBe('reconciler_mode_turn_aware');
    expect(logs[0].enabled).toBe(true);
    expect(logs[0].flag).toBe('GENIE_RECONCILER_TURN_AWARE');
    expect(logs[0].daemon_id).toBe('daemon-abc');
  });

  test('logReconcilerMode emits legacy event when explicitly opted out', () => {
    process.env[TURN_AWARE_RECONCILER_FLAG] = '0';
    const logs: LogEntry[] = [];
    logReconcilerMode({ log: (e) => logs.push(e), now: () => new Date('2026-04-20T00:00:00Z') }, 'daemon-optout');
    expect(logs).toHaveLength(1);
    expect(logs[0].event).toBe('reconciler_mode_legacy');
    expect(logs[0].enabled).toBe(false);
    expect(logs[0].message).toContain('flag off');
  });

  test('logReconcilerMode emits turn-aware event when flag set to truthy value', () => {
    process.env[TURN_AWARE_RECONCILER_FLAG] = '1';
    const logs: LogEntry[] = [];
    logReconcilerMode({ log: (e) => logs.push(e), now: () => new Date('2026-04-20T00:00:00Z') }, 'daemon-xyz');
    expect(logs).toHaveLength(1);
    expect(logs[0].event).toBe('reconciler_mode_turn_aware');
    expect(logs[0].enabled).toBe(true);
    expect(logs[0].message).toContain('turn-aware reconciler enabled');
  });
});
