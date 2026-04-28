/**
 * Scheduler `runBootPass` integration tests — exercises the boot pass against
 * a real PG database (cloned from the test template) to prove the canonical
 * chokepoint surfaces every in-flight agent and emits one audit event per
 * decision. Mock-based tests in `scheduler-daemon.test.ts` cover the
 * non-DB orchestration logic; these complement them by validating the
 * shouldResume integration.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { findOrCreateAgent, setCurrentExecutor } from './agent-registry.js';
import { completeAssignment, createAssignment } from './assignment-registry.js';
import { getConnection } from './db.js';
import { createExecutor } from './executor-registry.js';
import { type LogEntry, type SchedulerDeps, type WorkerInfo, runBootPass } from './scheduler-daemon.js';
import { DB_AVAILABLE, setupTestDatabase } from './test-db.js';

/**
 * Build a minimal SchedulerDeps that satisfies `runBootPass`. We inject
 * `listWorkers` and `getConnection` (real DB) and stub the rest with
 * no-ops; the boot pass only exercises the chokepoint + audit emission.
 */
function buildDeps(workers: WorkerInfo[], logs: LogEntry[]): SchedulerDeps {
  return {
    getConnection,
    spawnCommand: async () => ({ pid: undefined }),
    log: (entry) => logs.push(entry),
    generateId: () => 'boot-pass-test',
    now: () => new Date(),
    sleep: async () => {},
    jitter: () => 0,
    isPaneAlive: async () => true,
    listWorkers: async () => workers,
    countTmuxSessions: async () => 0,
    publishEvent: async () => {},
    resumeAgent: async () => true,
    updateAgent: async () => {},
  };
}

/** Build a `WorkerInfo` shape from a known agentId — `listWorkers` analogue. */
function workerOf(opts: {
  id: string;
  state?: WorkerInfo['state'];
  autoResume?: boolean;
  team?: string;
  paneId?: string;
}): WorkerInfo {
  return {
    id: opts.id,
    paneId: opts.paneId ?? '',
    state: opts.state ?? 'idle',
    team: opts.team,
    autoResume: opts.autoResume ?? true,
  } as WorkerInfo;
}

describe.skipIf(!DB_AVAILABLE)('runBootPass — chokepoint integration', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    const sql = await getConnection();
    await sql`DELETE FROM assignments`;
    await sql`DELETE FROM executors`;
    await sql`DELETE FROM agents`;
    await sql`DELETE FROM audit_events WHERE event_type LIKE 'agent.boot_pass.%' OR event_type LIKE 'resume.%'`;
  });

  async function seedAgent(opts: {
    name: string;
    team: string;
    reportsTo?: string | null;
    autoResume?: boolean;
  }): Promise<string> {
    const agent = await findOrCreateAgent(opts.name, opts.team, opts.name);
    const sql = await getConnection();
    // Migration 044 flipped the `auto_resume` column DEFAULT to false, so
    // every fresh row would otherwise be classified `auto_resume_disabled`
    // by the chokepoint. Default seeds to true here so the boot-pass test
    // exercises the resume verdict; tests that need the disabled path can
    // pass `autoResume: false` explicitly.
    const autoResume = opts.autoResume ?? true;
    await sql`UPDATE agents SET auto_resume = ${autoResume} WHERE id = ${agent.id}`;
    if (opts.reportsTo !== undefined) {
      await sql`UPDATE agents SET reports_to = ${opts.reportsTo} WHERE id = ${agent.id}`;
    }
    return agent.id;
  }

  async function eventsFor(agentId: string): Promise<{ event_type: string; details: Record<string, unknown> }[]> {
    const sql = await getConnection();
    const rows = await sql<{ event_type: string; details: Record<string, unknown> }[]>`
      SELECT event_type, details
      FROM audit_events
      WHERE entity_type = 'agent'
        AND entity_id = ${agentId}
        AND event_type LIKE 'agent.boot_pass.%'
      ORDER BY id ASC
    `;
    return rows;
  }

  test('empty inflight list: returns no decisions and no events', async () => {
    const logs: LogEntry[] = [];
    const result = await runBootPass(buildDeps([], logs), 'd-1');
    expect(result.decisions).toEqual([]);
    const completed = logs.find((l) => l.event === 'boot_pass_completed');
    expect(completed).toBeDefined();
    expect((completed as Record<string, unknown>).inflight_total).toBe(0);
  });

  test('permanent agent with active session: action=eager_invoke, emits agent.boot_pass.eager_invoked', async () => {
    const agentId = await seedAgent({ name: 'genie', team: 'genie', reportsTo: null });
    const exec = await createExecutor(agentId, 'claude', 'tmux', { claudeSessionId: 'sess-permanent' });
    await setCurrentExecutor(agentId, exec.id);

    const workers = [workerOf({ id: agentId, state: 'idle', team: 'genie' })];
    const result = await runBootPass(buildDeps(workers, []), 'd-2');

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].action).toBe('eager_invoke');
    expect(result.decisions[0].decision.sessionId).toBe('sess-permanent');

    const events = await eventsFor(agentId);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('agent.boot_pass.eager_invoked');
    expect(events[0].details.action).toBe('eager_invoke');
    expect(events[0].details.sessionId).toBe('sess-permanent');
  });

  test('task agent with open assignment: action=lazy_surface, emits agent.boot_pass.lazy_pending', async () => {
    const agentId = await seedAgent({ name: 'eng', team: 'sample', reportsTo: 'team-lead' });
    const exec = await createExecutor(agentId, 'claude', 'tmux', { claudeSessionId: 'sess-task' });
    await setCurrentExecutor(agentId, exec.id);
    await createAssignment(exec.id, 'task-1', 'wish-x', 1);

    const workers = [workerOf({ id: agentId, state: 'working', team: 'sample' })];
    const result = await runBootPass(buildDeps(workers, []), 'd-3');

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].action).toBe('lazy_surface');

    const events = await eventsFor(agentId);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('agent.boot_pass.lazy_pending');
  });

  test('task agent with closed assignment: action=skip, emits agent.boot_pass.skipped_task_done', async () => {
    const agentId = await seedAgent({ name: 'eng-done', team: 'sample', reportsTo: 'team-lead' });
    const exec = await createExecutor(agentId, 'claude', 'tmux', { claudeSessionId: 'sess-done' });
    await setCurrentExecutor(agentId, exec.id);
    const assn = await createAssignment(exec.id, 'task-done', 'wish-x', 2);
    await completeAssignment(assn.id, 'completed');

    const workers = [workerOf({ id: agentId, state: 'idle', team: 'sample' })];
    const result = await runBootPass(buildDeps(workers, []), 'd-4');

    expect(result.decisions[0].action).toBe('skip');
    const events = await eventsFor(agentId);
    expect(events[0].event_type).toBe('agent.boot_pass.skipped_task_done');
  });

  test('agent with auto_resume=false: skipped from listWorkers filter, no boot-pass row', async () => {
    const agentId = await seedAgent({ name: 'paused', team: 'sample', autoResume: false, reportsTo: null });

    // listWorkers reflects current state — `runBootPass` filters by autoResume too.
    const workers = [workerOf({ id: agentId, state: 'idle', autoResume: false, team: 'sample' })];
    const result = await runBootPass(buildDeps(workers, []), 'd-5');

    expect(result.decisions).toHaveLength(0);
    const events = await eventsFor(agentId);
    expect(events).toHaveLength(0);
  });

  test('done-state agent: skipped from listWorkers filter', async () => {
    const agentId = await seedAgent({ name: 'finished', team: 'sample', reportsTo: 'team-lead' });

    const workers = [workerOf({ id: agentId, state: 'done', team: 'sample' })];
    const result = await runBootPass(buildDeps(workers, []), 'd-6');

    expect(result.decisions).toHaveLength(0);
  });

  test('mix of permanent + task + skipped: each gets its own correctly-typed event', async () => {
    const permId = await seedAgent({ name: 'p-1', team: 'mixed', reportsTo: null });
    const permExec = await createExecutor(permId, 'claude', 'tmux', { claudeSessionId: 'sess-p1' });
    await setCurrentExecutor(permId, permExec.id);

    const taskId = await seedAgent({ name: 't-1', team: 'mixed', reportsTo: 'team-lead' });
    const taskExec = await createExecutor(taskId, 'claude', 'tmux', { claudeSessionId: 'sess-t1' });
    await setCurrentExecutor(taskId, taskExec.id);
    await createAssignment(taskExec.id, 'task-x', 'wish-x', 1);

    const noSessionId = await seedAgent({ name: 'no-sess', team: 'mixed', reportsTo: null });

    const workers = [
      workerOf({ id: permId, state: 'idle', team: 'mixed' }),
      workerOf({ id: taskId, state: 'working', team: 'mixed' }),
      workerOf({ id: noSessionId, state: 'idle', team: 'mixed' }),
    ];
    const result = await runBootPass(buildDeps(workers, []), 'd-7');

    expect(result.decisions).toHaveLength(3);

    const eager = result.decisions.find((d) => d.agentId === permId);
    expect(eager?.action).toBe('eager_invoke');

    const lazy = result.decisions.find((d) => d.agentId === taskId);
    expect(lazy?.action).toBe('lazy_surface');

    const skipped = result.decisions.find((d) => d.agentId === noSessionId);
    expect(skipped?.action).toBe('skip');

    expect((await eventsFor(permId))[0].event_type).toBe('agent.boot_pass.eager_invoked');
    expect((await eventsFor(taskId))[0].event_type).toBe('agent.boot_pass.lazy_pending');
    expect((await eventsFor(noSessionId))[0].event_type).toBe('agent.boot_pass.rehydrated');
  });

  test('logs boot_pass_completed with counts', async () => {
    const permId = await seedAgent({ name: 'log-p', team: 'logs', reportsTo: null });
    const permExec = await createExecutor(permId, 'claude', 'tmux', { claudeSessionId: 'sess-log-p' });
    await setCurrentExecutor(permId, permExec.id);

    const workers = [workerOf({ id: permId, state: 'idle', team: 'logs' })];
    const logs: LogEntry[] = [];
    await runBootPass(buildDeps(workers, logs), 'd-logs');

    const completed = logs.find((l) => l.event === 'boot_pass_completed') as Record<string, unknown> | undefined;
    expect(completed).toBeDefined();
    expect(completed?.inflight_total).toBe(1);
    expect(completed?.eager_invoked).toBe(1);
    expect(completed?.lazy_pending).toBe(0);
    expect(completed?.skipped).toBe(0);
  });
});
