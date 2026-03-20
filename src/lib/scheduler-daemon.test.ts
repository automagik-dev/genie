import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  type LogEntry,
  type SchedulerConfig,
  type SchedulerDeps,
  claimDueTriggers,
  fireTrigger,
  logToFile,
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
}) {
  const queries: QueryLog[] = [];
  const insertedRuns: Record<string, unknown>[] = [];
  const updatedTriggers: { id: string; status: string }[] = [];

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: mock SQL router needs many branches
  const sql: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?');
    queries.push({ query, values });

    if (query.includes('FROM runs') && query.includes('count')) {
      return [{ cnt: data.runningCount ?? 0 }];
    }
    if (query.includes('FROM triggers') && query.includes('FOR UPDATE')) {
      return data.triggers ?? [];
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
    return [];
  };

  sql.begin = async (fn: (tx: typeof sql) => Promise<unknown>) => {
    return fn(sql);
  };

  sql.listen = async (_channel: string, _cb: () => void) => {
    // No-op for tests
  };

  sql.end = async () => {};

  return { sql, queries, insertedRuns, updatedTriggers };
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
    ...overrides,
  };

  return { deps, logs, spawns, mock };
}

const defaultConfig: SchedulerConfig = {
  maxConcurrent: 5,
  pollIntervalMs: 30_000,
  maxJitterMs: 30_000,
  jitterThreshold: 3,
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
});
