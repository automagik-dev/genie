/**
 * Cross-cutting resume tests — covers manual resume, auto-resume,
 * cooldown, concurrency cap, opt-out, and reboot recovery.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import type { Agent, AgentState } from '../lib/agent-registry.js';
import * as registry from '../lib/agent-registry.js';
import { getConnection } from '../lib/db.js';
import { MissingResumeSessionError } from '../lib/protocol-router.js';
import {
  type LogEntry,
  type SchedulerConfig,
  type SchedulerDeps,
  type WorkerInfo,
  attemptAgentResume,
  recoverOnStartup,
} from '../lib/scheduler-daemon.js';
import { DB_AVAILABLE, setupTestDatabase } from '../lib/test-db.js';
import { handleWorkerResume } from '../term-commands/agents.js';

const TEST_DIR = '/tmp/genie-resume-test';

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

let cleanupSchema: () => Promise<void>;

describe.skipIf(!DB_AVAILABLE)('resume', () => {
  beforeAll(async () => {
    cleanupSchema = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanupSchema();
  });

  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    process.env.GENIE_HOME = TEST_DIR;
    const sql = await getConnection();
    await sql`DELETE FROM agents`;
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    process.env.GENIE_HOME = undefined;
  });

  // --------------------------------------------------------------------------
  // Manual resume
  // --------------------------------------------------------------------------

  test('manual resume: suspended agent with sessionId is resumed', async () => {
    const agent = makeWorker({ state: 'suspended', currentSessionId: 'session-xyz' });
    const { deps, logs } = createMockDeps({ resumeAgent: async () => true });

    const result = await attemptAgentResume(deps, defaultConfig, agent);

    expect(result).toBe('resumed');
    expect(logs.some((l) => l.event === 'agent_resume_succeeded')).toBe(true);
  });

  test('manual resume: missing sessionId is rejected', async () => {
    const agent = makeWorker({ currentSessionId: undefined });
    const { deps, logs } = createMockDeps();

    const result = await attemptAgentResume(deps, defaultConfig, agent);

    expect(result).toBe('skipped');
    const skip = logs.find((l) => l.event === 'agent_resume_skipped');
    expect(skip?.reason).toBe('no_session_id');
  });

  test('manual resume: resets retry counter via registry update', async () => {
    const agentEntry: Agent = {
      id: 'retry-agent',
      paneId: '%42',
      session: 'genie',
      worktree: null,
      startedAt: '2026-03-20T12:00:00Z',
      state: 'suspended',
      lastStateChange: '2026-03-20T12:00:00Z',
      repoPath: '/tmp',
      resumeAttempts: 2,
      maxResumeAttempts: 3,
    };
    await registry.register(agentEntry);

    // Manual resume resets counter (mirrors what handleWorkerResume does)
    await registry.update('retry-agent', { resumeAttempts: 0 });
    const updated = await registry.get('retry-agent');
    expect(updated?.resumeAttempts).toBe(0);

    // After reset, daemon auto-resume has full budget
    const worker = makeWorker({ id: 'retry-agent', resumeAttempts: 0 });
    const { deps } = createMockDeps({ resumeAgent: async () => true });
    const result = await attemptAgentResume(deps, defaultConfig, worker);
    expect(result).toBe('resumed');
  });

  test('resume --all: identifies all eligible agents', async () => {
    // Post-migration-047: session lives on the current executor row, not on
    // the agent row. Eligibility now requires `state ∈ {suspended, error}`
    // AND `executors.claude_session_id IS NOT NULL` on the agent's current
    // executor. Seed agents + executors that cover all four cases.
    const executorRegistry = await import('../lib/executor-registry.js');
    const base = {
      session: 'genie',
      worktree: null as string | null,
      startedAt: '2026-03-20T12:00:00Z',
      lastStateChange: '2026-03-20T12:00:00Z',
      repoPath: '/tmp',
    };
    await registry.register({ ...base, id: 'a1', paneId: '%51', state: 'suspended', provider: 'claude' });
    await executorRegistry.createAndLinkExecutor('a1', 'claude', 'tmux', { claudeSessionId: 'sess-1' });

    await registry.register({ ...base, id: 'a2', paneId: '%52', state: 'error', provider: 'claude' });
    await executorRegistry.createAndLinkExecutor('a2', 'claude', 'tmux', { claudeSessionId: 'sess-2' });

    await registry.register({ ...base, id: 'a3', paneId: '%53', state: 'done' as AgentState, provider: 'claude' });
    // a3 is 'done' — not eligible regardless of session; no executor seeded.

    await registry.register({ ...base, id: 'a4', paneId: '%54', state: 'suspended', provider: 'claude' });
    // a4 has no executor → no session → not eligible.

    const workers = await registry.list();
    const eligible: Agent[] = [];
    for (const w of workers) {
      if (w.state !== 'suspended' && w.state !== 'error') continue;
      const executor = await executorRegistry.getCurrentExecutor(w.id);
      if (executor?.claudeSessionId) eligible.push(w);
    }

    expect(eligible).toHaveLength(2);
    expect(eligible.map((w) => w.id).sort()).toEqual(['a1', 'a2']);
  });

  // --------------------------------------------------------------------------
  // Auto-resume (daemon)
  // --------------------------------------------------------------------------

  test('auto-resume: daemon resumes dead agent and logs success', async () => {
    const agent = makeWorker({ autoResume: true, resumeAttempts: 0 });
    const { deps, logs, agentUpdates } = createMockDeps({ resumeAgent: async () => true });

    const result = await attemptAgentResume(deps, defaultConfig, agent);

    expect(result).toBe('resumed');
    // Two writes: (1) pre-spawn increment, (2) post-success explicit reset.
    // Post-fix/auto-resume-counter-persistence — scheduler owns the counter
    // end-to-end (the CLI shell-out is invoked with --no-reset-attempts).
    expect(agentUpdates).toHaveLength(2);
    expect(agentUpdates[0].updates.resumeAttempts).toBe(1);
    expect(agentUpdates[0].updates.lastResumeAttempt).toBeDefined();
    expect(agentUpdates[1].updates.resumeAttempts).toBe(0);
    expect(logs.some((l) => l.event === 'agent_resume_attempted')).toBe(true);
    expect(logs.some((l) => l.event === 'agent_resume_succeeded')).toBe(true);
  });

  test('auto-resume: exhausted after 3 failed attempts', async () => {
    const agent = makeWorker({ resumeAttempts: 2, maxResumeAttempts: 3 });
    const { deps, logs } = createMockDeps({ resumeAgent: async () => false });

    const result = await attemptAgentResume(deps, defaultConfig, agent);

    expect(result).toBe('exhausted');
    expect(logs.some((l) => l.event === 'agent_resume_failed')).toBe(true);
    expect(logs.some((l) => l.event === 'agent_resume_exhausted')).toBe(true);
  });

  test('auto-resume: cooldown prevents resume within 60s', async () => {
    const agent = makeWorker({
      lastResumeAttempt: new Date('2026-03-20T11:59:30Z').toISOString(), // 30s before "now"
    });
    const { deps, logs } = createMockDeps();

    const result = await attemptAgentResume(deps, defaultConfig, agent);

    expect(result).toBe('skipped');
    const skip = logs.find((l) => l.event === 'agent_resume_skipped');
    expect(skip?.reason).toBe('cooldown');
  });

  test('opt-out: --no-auto-resume disables daemon resume', async () => {
    const agent = makeWorker({ autoResume: false });
    const { deps, logs } = createMockDeps();

    const result = await attemptAgentResume(deps, defaultConfig, agent);

    expect(result).toBe('skipped');
    const skip = logs.find((l) => l.event === 'agent_resume_skipped');
    expect(skip?.reason).toBe('auto_resume_disabled');
  });

  test('concurrency cap: blocks resume when at max workers', async () => {
    // NOTE (auto-resume-zombie-cap fix): cap filter now verifies pane
    // liveness — "active workers" semantically require live panes, so we
    // override the shared mock (isPaneAlive=false) to reflect that.
    const agent = makeWorker();
    const activeWorkers: WorkerInfo[] = Array.from({ length: 5 }, (_, i) =>
      makeWorker({ id: `active-${i}`, state: 'working' }),
    );
    const { deps, logs } = createMockDeps({
      listWorkers: async () => activeWorkers,
      isPaneAlive: async () => true,
    });

    const result = await attemptAgentResume(deps, defaultConfig, agent);

    expect(result).toBe('skipped');
    const skip = logs.find((l) => l.event === 'agent_resume_skipped');
    expect(skip?.reason).toBe('concurrency_cap');
  });

  test('reboot recovery: resumes previously-running agents on startup', async () => {
    const workers: WorkerInfo[] = [
      makeWorker({ id: 'running-1', state: 'working', currentSessionId: 'sess-1', resumeAttempts: 0 }),
      makeWorker({ id: 'idle-1', state: 'idle', currentSessionId: 'sess-2', resumeAttempts: 0 }),
      makeWorker({ id: 'done-1', state: 'done', currentSessionId: 'sess-3' }),
      makeWorker({ id: 'suspended-1', state: 'suspended', currentSessionId: 'sess-4' }),
    ];

    const resumed: string[] = [];
    const { deps, logs } = createMockDeps({
      listWorkers: async () => workers,
      isPaneAlive: async () => false,
      resumeAgent: async (id) => {
        resumed.push(id);
        return true;
      },
    });

    await recoverOnStartup(deps, 'daemon-reboot', defaultConfig);

    // Only working + idle agents are resumed (not done, not suspended)
    expect(resumed).toHaveLength(2);
    expect(resumed).toContain('running-1');
    expect(resumed).toContain('idle-1');
    expect(resumed).not.toContain('done-1');
    expect(resumed).not.toContain('suspended-1');

    const recovery = logs.find((l) => l.event === 'recovery_completed');
    expect(recovery).toBeDefined();
    expect(recovery?.resumed_agents).toBe(2);
  });

  // --------------------------------------------------------------------------
  // Group 6 — MissingResumeSessionError (fail loudly when resume has no session)
  // --------------------------------------------------------------------------

  describe('Group 6 — MissingResumeSessionError', () => {
    test('handleWorkerResume throws MissingResumeSessionError for an agent without a session', async () => {
      const now = new Date().toISOString();
      const agentId = 'no-session-agent';
      const agent: Agent = {
        id: agentId,
        paneId: '%99',
        session: 'genie',
        worktree: null,
        startedAt: now,
        state: 'suspended',
        lastStateChange: now,
        repoPath: '/tmp',
        // currentSessionId intentionally omitted — this is the failure case.
      };
      await registry.register(agent);

      try {
        await handleWorkerResume(agentId, {});
        throw new Error('handleWorkerResume should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(MissingResumeSessionError);
        const e = err as MissingResumeSessionError;
        expect(e.name).toBe('MissingResumeSessionError');
        expect(e.workerId).toBe(agentId);
        expect(e.entityId).toBe(agentId);
        expect(e.reason).toBe('no_session_id');
        // Runbook hint surfaces in the message for the operator.
        expect(e.message).toContain(agentId);
        expect(e.message).toContain('genie reset');
      }
    });
  });
});
