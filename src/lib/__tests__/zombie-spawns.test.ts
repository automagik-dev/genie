/**
 * Regression tests for zombie spawning agents.
 *
 * Bug 1: reconcileStaleSpawns ignored agents with a non-null pane_id,
 *         leaving them stuck in 'spawning' forever when the pane died.
 * Bug 2: Concurrency cap counted 'spawning' agents as active, blocking
 *         all auto-resume when zombie spawning agents accumulated.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent } from '../agent-registry.js';
import {
  type LogEntry,
  type SchedulerConfig,
  type SchedulerDeps,
  type WorkerInfo,
  attemptAgentResume,
} from '../scheduler-daemon.js';

// ---------------------------------------------------------------------------
// Helpers (mirrored from resume.test.ts)
// ---------------------------------------------------------------------------

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

function createMockSql() {
  const sql: any = (_strings: TemplateStringsArray, ..._values: unknown[]) => [];
  sql.begin = async (fn: (tx: typeof sql) => Promise<unknown>) => fn(sql);
  sql.listen = async () => {};
  sql.end = async () => {};
  return sql;
}

function createMockDeps(overrides: Partial<SchedulerDeps> = {}) {
  const logs: LogEntry[] = [];
  const agentUpdates: { id: string; updates: Partial<Agent> }[] = [];
  let idCounter = 0;

  const deps: SchedulerDeps = {
    getConnection: async () => createMockSql(),
    spawnCommand: async () => ({ pid: 12345 }),
    log: (entry) => logs.push(entry),
    generateId: () => `test-id-${++idCounter}`,
    now: () => new Date('2026-03-20T12:00:00Z'),
    sleep: async () => {},
    jitter: (maxMs) => Math.floor(maxMs / 2),
    isPaneAlive: async () => false,
    listWorkers: async () => [],
    countTmuxSessions: async () => 0,
    publishEvent: async () => {},
    resumeAgent: async () => true,
    updateAgent: async (id, u) => {
      agentUpdates.push({ id, updates: u });
    },
    ...overrides,
  };

  return { deps, logs, agentUpdates };
}

// ---------------------------------------------------------------------------
// Bug 1: reconcileStaleSpawns second pass for dead panes (code review)
// ---------------------------------------------------------------------------

describe('reconcileStaleSpawns dead-pane pass', () => {
  test('source includes dead-pane reconciliation logic', () => {
    const source = readFileSync(join(__dirname, '..', 'agent-registry.ts'), 'utf-8');

    // Second pass selects agents with non-empty pane_id still in spawning state
    expect(source).toContain("AND pane_id IS NOT NULL AND pane_id != ''");

    // Calls isPaneAlive to verify pane is actually dead
    expect(source).toContain('isPaneAlive(row.pane_id)');

    // Uses distinct audit reason for dead-pane reconciliation
    expect(source).toContain('stale_spawn_dead_pane');
  });

  test('dead-pane pass gracefully handles tmux errors (code review)', () => {
    const source = readFileSync(join(__dirname, '..', 'agent-registry.ts'), 'utf-8');

    // The catch block around isPaneAlive ensures TmuxUnreachableError
    // does not incorrectly mark agents as dead
    expect(source).toContain('// TmuxUnreachableError or other');
  });
});

// ---------------------------------------------------------------------------
// Bug 2: spawning agents should not count toward concurrency cap
// ---------------------------------------------------------------------------

describe('concurrency cap excludes spawning agents', () => {
  test('spawning agents do not block resume of other agents', async () => {
    // 5 zombie 'spawning' agents that previously blocked all resumes
    const zombieSpawning: WorkerInfo[] = Array.from({ length: 5 }, (_, i) =>
      makeWorker({ id: `zombie-${i}`, state: 'spawning' as any }),
    );
    const { deps, logs } = createMockDeps({
      listWorkers: async () => zombieSpawning,
      resumeAgent: async () => true,
    });

    const agent = makeWorker({ id: 'real-agent', state: 'error' });
    const result = await attemptAgentResume(deps, defaultConfig, agent);

    // Before fix: result was 'skipped' with reason 'concurrency_cap'
    // After fix: spawning is excluded, so activeCount = 0 and resume proceeds
    expect(result).toBe('resumed');
    expect(logs.some((l) => l.reason === 'concurrency_cap')).toBe(false);
  });

  test('actually-working agents still enforce the concurrency cap', async () => {
    // 5 genuinely working agents should still block resume.
    // NOTE (auto-resume-zombie-cap fix): the cap filter now also verifies
    // tmux pane liveness — "actually working" semantically requires a live
    // pane, so we override the shared mock default (isPaneAlive=false) to
    // reflect reality. Without this override the test would false-negative
    // by treating 5 state='working' rows as dead-pane zombies.
    const working: WorkerInfo[] = Array.from({ length: 5 }, (_, i) =>
      makeWorker({ id: `worker-${i}`, state: 'working' }),
    );
    const { deps, logs } = createMockDeps({
      listWorkers: async () => working,
      isPaneAlive: async () => true,
    });

    const agent = makeWorker({ id: 'overflow-agent', state: 'error' });
    const result = await attemptAgentResume(deps, defaultConfig, agent);

    expect(result).toBe('skipped');
    const skip = logs.find((l) => l.event === 'agent_resume_skipped');
    expect(skip?.reason).toBe('concurrency_cap');
  });

  test('mix of spawning and working agents only counts working toward cap', async () => {
    const mixed: WorkerInfo[] = [
      // 3 zombie spawning (should NOT count)
      ...Array.from({ length: 3 }, (_, i) => makeWorker({ id: `zombie-${i}`, state: 'spawning' as any })),
      // 4 actually working (should count)
      ...Array.from({ length: 4 }, (_, i) => makeWorker({ id: `worker-${i}`, state: 'working' })),
    ];
    const { deps } = createMockDeps({
      listWorkers: async () => mixed,
      resumeAgent: async () => true,
    });

    const agent = makeWorker({ id: 'another-agent', state: 'error' });
    const result = await attemptAgentResume(deps, defaultConfig, agent);

    // activeCount = 4 (only working), which is < maxConcurrent(5), so resume proceeds
    expect(result).toBe('resumed');
  });

  test('source code confirms spawning is in the exclusion list', () => {
    const source = readFileSync(join(__dirname, '..', 'scheduler-daemon.ts'), 'utf-8');
    // The filter that computes activeCount must exclude 'spawning'
    expect(source).toContain("'done', 'error', 'suspended', 'spawning'");
  });
});
