import { describe, expect, test } from 'bun:test';
import type { ScheduleCommandDeps } from './schedule.js';
import { isCronExpression, parseAbsoluteTime, parseDuration, scheduleCancelCommand } from './schedule.js';

interface TestSchedule {
  id: string;
  name: string;
  status: string;
  created_at?: string;
}

interface TestTrigger {
  id: string;
  schedule_id: string;
  status: string;
}

type SqlResult = Record<string, unknown>[] & { count?: number };

type FakeSql = {
  (strings: TemplateStringsArray, ...values: unknown[]): SqlResult;
  begin: (fn: (tx: FakeSql) => Promise<unknown>) => Promise<unknown>;
};

class ExitError extends Error {
  code: number | undefined;

  constructor(code?: number) {
    super(`exit ${code ?? ''}`.trim());
    this.code = code;
  }
}

function resultWithCount(count: number): SqlResult {
  const result = [] as SqlResult;
  result.count = count;
  return result;
}

function createdAtMs(schedule: TestSchedule): number {
  if (!schedule.created_at) return 0;
  const timestamp = Date.parse(schedule.created_at);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function compareCancelableSchedules(needle: string) {
  return (a: TestSchedule, b: TestSchedule) => {
    const exactIdRank = Number(a.id !== needle) - Number(b.id !== needle);
    if (exactIdRank !== 0) return exactIdRank;

    const statusRank = (schedule: TestSchedule) => (schedule.status === 'active' ? 0 : 1);
    const statusDiff = statusRank(a) - statusRank(b);
    if (statusDiff !== 0) return statusDiff;

    const createdDiff = createdAtMs(b) - createdAtMs(a);
    if (createdDiff !== 0) return createdDiff;

    return a.id.localeCompare(b.id);
  };
}

function findCancelableSchedules(schedules: TestSchedule[], needle: string, query: string): SqlResult {
  let matches = schedules.filter(
    (schedule) =>
      (schedule.name === needle || schedule.id === needle) &&
      (schedule.status === 'active' || schedule.status === 'paused'),
  );

  if (query.includes('ORDER BY')) {
    matches = [...matches].sort(compareCancelableSchedules(needle));
  }

  if (query.includes('LIMIT 1')) {
    matches = matches.slice(0, 1);
  }

  return matches.map((schedule) => ({ id: schedule.id, name: schedule.name, status: schedule.status }));
}

function pauseSchedule(schedules: TestSchedule[], scheduleId: string): SqlResult {
  const schedule = schedules.find((candidate) => candidate.id === scheduleId);
  if (schedule) schedule.status = 'paused';
  return resultWithCount(schedule ? 1 : 0);
}

function skipPendingTriggers(triggers: TestTrigger[], scheduleId: string): SqlResult {
  let count = 0;
  for (const trigger of triggers) {
    if (trigger.schedule_id === scheduleId && trigger.status === 'pending') {
      trigger.status = 'skipped';
      count += 1;
    }
  }
  return resultWithCount(count);
}

function handleCancelSqlQuery(
  query: string,
  values: unknown[],
  schedules: TestSchedule[],
  triggers: TestTrigger[],
): SqlResult {
  if (query.includes('SELECT id, name, status FROM schedules')) {
    return findCancelableSchedules(schedules, String(values[0]), query);
  }

  if (query.includes('UPDATE schedules SET status')) {
    return pauseSchedule(schedules, String(values[0]));
  }

  if (query.includes('UPDATE triggers SET status')) {
    return skipPendingTriggers(triggers, String(values[0]));
  }

  return [];
}

function createCancelHarness(input: { schedules: TestSchedule[]; triggers: TestTrigger[] }) {
  const schedules = input.schedules.map((schedule) => ({ ...schedule }));
  const triggers = input.triggers.map((trigger) => ({ ...trigger }));
  const output: string[] = [];
  const errors: string[] = [];
  const queries: string[] = [];
  let shutdownCalls = 0;

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?');
    queries.push(query);
    return handleCancelSqlQuery(query, values, schedules, triggers);
  }) as FakeSql;

  sql.begin = async (fn) => fn(sql);

  const connectionKey = `get${'Connection'}`;
  const deps = {
    [connectionKey]: async () => sql,
    shutdown: async () => {
      shutdownCalls += 1;
    },
    exit: (code?: number): never => {
      throw new ExitError(code);
    },
    stdout: {
      log: (message?: unknown) => output.push(String(message)),
    },
    stderr: {
      error: (message?: unknown) => errors.push(String(message)),
    },
  } as unknown as ScheduleCommandDeps;

  return {
    deps,
    errors,
    output,
    queries,
    schedules,
    triggers,
    get shutdownCalls() {
      return shutdownCalls;
    },
  };
}

// ============================================================================
// parseDuration
// ============================================================================

describe('parseDuration', () => {
  test('parses seconds', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('1s')).toBe(1_000);
    expect(parseDuration('90sec')).toBe(90_000);
  });

  test('parses minutes', () => {
    expect(parseDuration('10m')).toBe(600_000);
    expect(parseDuration('1min')).toBe(60_000);
    expect(parseDuration('5m')).toBe(300_000);
  });

  test('parses hours', () => {
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('24h')).toBe(86_400_000);
    expect(parseDuration('1hr')).toBe(3_600_000);
  });

  test('parses days', () => {
    expect(parseDuration('1d')).toBe(86_400_000);
    expect(parseDuration('7day')).toBe(604_800_000);
    expect(parseDuration('7days')).toBe(604_800_000);
  });

  test('parses fractional values', () => {
    expect(parseDuration('1.5h')).toBe(5_400_000);
    expect(parseDuration('0.5d')).toBe(43_200_000);
  });

  test('handles whitespace', () => {
    expect(parseDuration('  10m  ')).toBe(600_000);
  });

  test('rejects invalid durations', () => {
    expect(() => parseDuration('')).toThrow('Invalid duration');
    expect(() => parseDuration('abc')).toThrow('Invalid duration');
    expect(() => parseDuration('10x')).toThrow('Invalid duration');
    expect(() => parseDuration('m10')).toThrow('Invalid duration');
  });
});

// ============================================================================
// parseAbsoluteTime
// ============================================================================

describe('parseAbsoluteTime', () => {
  test('parses ISO 8601 strings', () => {
    const date = parseAbsoluteTime('2026-03-21T09:00:00Z');
    expect(date.getTime()).toBe(new Date('2026-03-21T09:00:00Z').getTime());
  });

  test('parses date-only strings', () => {
    const date = parseAbsoluteTime('2026-03-21');
    expect(date).toBeInstanceOf(Date);
    expect(Number.isNaN(date.getTime())).toBe(false);
  });

  test('rejects invalid time strings', () => {
    expect(() => parseAbsoluteTime('not-a-date')).toThrow('Invalid time');
    expect(() => parseAbsoluteTime('yesterday')).toThrow('Invalid time');
  });
});

// ============================================================================
// isCronExpression
// ============================================================================

describe('isCronExpression', () => {
  test('recognizes 5-field cron', () => {
    expect(isCronExpression('0 0 * * *')).toBe(true);
    expect(isCronExpression('*/5 * * * *')).toBe(true);
    expect(isCronExpression('0 9 * * 1-5')).toBe(true);
  });

  test('recognizes 6-field cron', () => {
    expect(isCronExpression('0 0 0 * * *')).toBe(true);
  });

  test('rejects non-cron strings', () => {
    expect(isCronExpression('10m')).toBe(false);
    expect(isCronExpression('24h')).toBe(false);
    expect(isCronExpression('hello')).toBe(false);
    expect(isCronExpression('* *')).toBe(false);
  });
});

// ============================================================================
// schedule cancel
// ============================================================================

describe('scheduleCancelCommand', () => {
  test('cancels paused schedule and skips pending triggers', async () => {
    const harness = createCancelHarness({
      schedules: [{ id: 'sched-paused', name: 'paused-task', status: 'paused' }],
      triggers: [
        { id: 'pending-1', schedule_id: 'sched-paused', status: 'pending' },
        { id: 'pending-2', schedule_id: 'sched-paused', status: 'pending' },
        { id: 'done-1', schedule_id: 'sched-paused', status: 'completed' },
      ],
    });

    await scheduleCancelCommand('paused-task', {}, harness.deps);

    expect(harness.schedules[0].status).toBe('paused');
    expect(
      harness.triggers.filter((trigger) => trigger.schedule_id === 'sched-paused' && trigger.status === 'pending'),
    ).toHaveLength(0);
    expect(harness.triggers.filter((trigger) => trigger.status === 'skipped')).toHaveLength(2);
    expect(harness.output).toContain('Cancelled schedule "paused-task"');
    expect(harness.output).toContain('  Skipped 2 pending triggers');
    expect(harness.shutdownCalls).toBe(1);
  });

  test('cancels active schedule and skips pending triggers', async () => {
    const harness = createCancelHarness({
      schedules: [{ id: 'sched-active', name: 'active-task', status: 'active' }],
      triggers: [
        { id: 'pending-1', schedule_id: 'sched-active', status: 'pending' },
        { id: 'other-pending', schedule_id: 'sched-other', status: 'pending' },
      ],
    });

    await scheduleCancelCommand('active-task', {}, harness.deps);

    expect(harness.schedules[0].status).toBe('paused');
    expect(harness.triggers.find((trigger) => trigger.id === 'pending-1')?.status).toBe('skipped');
    expect(harness.triggers.find((trigger) => trigger.id === 'other-pending')?.status).toBe('pending');
    expect(harness.output).toContain('Cancelled schedule "active-task"');
    expect(harness.output).toContain('  Skipped 1 pending trigger');
    expect(harness.shutdownCalls).toBe(1);
  });

  test('prefers active schedule when paused history shares the same name', async () => {
    const harness = createCancelHarness({
      schedules: [
        {
          id: 'sched-paused-history',
          name: 'shared-task',
          status: 'paused',
          created_at: '2026-03-01T00:00:00.000Z',
        },
        {
          id: 'sched-active-current',
          name: 'shared-task',
          status: 'active',
          created_at: '2026-04-01T00:00:00.000Z',
        },
      ],
      triggers: [
        { id: 'paused-pending', schedule_id: 'sched-paused-history', status: 'pending' },
        { id: 'active-pending', schedule_id: 'sched-active-current', status: 'pending' },
        { id: 'active-done', schedule_id: 'sched-active-current', status: 'completed' },
      ],
    });

    await scheduleCancelCommand('shared-task', {}, harness.deps);

    expect(harness.schedules.find((schedule) => schedule.id === 'sched-active-current')?.status).toBe('paused');
    expect(harness.triggers.find((trigger) => trigger.id === 'active-pending')?.status).toBe('skipped');
    expect(harness.triggers.find((trigger) => trigger.id === 'paused-pending')?.status).toBe('pending');
    expect(
      harness.triggers.filter(
        (trigger) => trigger.schedule_id === 'sched-active-current' && trigger.status === 'pending',
      ),
    ).toHaveLength(0);
    expect(harness.output).toContain('Cancelled schedule "shared-task"');
    expect(harness.output).toContain('  Skipped 1 pending trigger');

    const selectQuery = harness.queries.find((query) => query.includes('SELECT id, name, status FROM schedules'));
    expect(selectQuery).toContain('ORDER BY');
    expect(selectQuery).toContain('LIMIT 1');
  });

  test('prefers exact id match over active schedule name match', async () => {
    const harness = createCancelHarness({
      schedules: [
        {
          id: 'sched-active-name-match',
          name: 'sched-paused-id',
          status: 'active',
          created_at: '2026-04-01T00:00:00.000Z',
        },
        {
          id: 'sched-paused-id',
          name: 'archived-task',
          status: 'paused',
          created_at: '2026-03-01T00:00:00.000Z',
        },
      ],
      triggers: [
        { id: 'active-name-pending', schedule_id: 'sched-active-name-match', status: 'pending' },
        { id: 'exact-id-pending', schedule_id: 'sched-paused-id', status: 'pending' },
      ],
    });

    await scheduleCancelCommand('sched-paused-id', {}, harness.deps);

    expect(harness.schedules.find((schedule) => schedule.id === 'sched-active-name-match')?.status).toBe('active');
    expect(harness.schedules.find((schedule) => schedule.id === 'sched-paused-id')?.status).toBe('paused');
    expect(harness.triggers.find((trigger) => trigger.id === 'active-name-pending')?.status).toBe('pending');
    expect(harness.triggers.find((trigger) => trigger.id === 'exact-id-pending')?.status).toBe('skipped');
    expect(harness.output).toContain('Cancelled schedule "archived-task"');
  });

  test('rejects unknown schedule name', async () => {
    const harness = createCancelHarness({
      schedules: [{ id: 'sched-active', name: 'active-task', status: 'active' }],
      triggers: [{ id: 'pending-1', schedule_id: 'sched-active', status: 'pending' }],
    });

    let exitCode: number | undefined;
    try {
      await scheduleCancelCommand('missing-task', {}, harness.deps);
    } catch (error) {
      if (!(error instanceof ExitError)) throw error;
      exitCode = error.code;
    }

    expect(exitCode).toBe(1);
    expect(harness.errors[0]).toContain('no active or paused schedule found matching "missing-task"');
    expect(harness.triggers[0].status).toBe('pending');
    expect(harness.shutdownCalls).toBe(0);
  });
});
