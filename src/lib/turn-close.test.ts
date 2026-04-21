/**
 * Turn-close contract tests — atomic transaction + idempotency + rollback.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { findOrCreateAgent, setCurrentExecutor } from './agent-registry.js';
import { getConnection } from './db.js';
import { createExecutor, getExecutor } from './executor-registry.js';
import { DB_AVAILABLE, setupTestSchema } from './test-db.js';
import { turnClose } from './turn-close.js';

describe.skipIf(!DB_AVAILABLE)('turn-close', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    cleanup = await setupTestSchema();
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    const sql = await getConnection();
    await sql`DELETE FROM audit_events`;
    await sql`DELETE FROM assignments`;
    await sql`DELETE FROM executors`;
    await sql`DELETE FROM agents`;
  });

  const originalEnv = { executor: process.env.GENIE_EXECUTOR_ID, agent: process.env.GENIE_AGENT_NAME };
  afterEach(() => {
    process.env.GENIE_EXECUTOR_ID = originalEnv.executor;
    process.env.GENIE_AGENT_NAME = originalEnv.agent;
  });

  async function seed(): Promise<{ agentId: string; executorId: string }> {
    const agent = await findOrCreateAgent('eng-close', 'test-team', 'engineer');
    const exec = await createExecutor(agent.id, 'claude', 'tmux', { state: 'working' });
    await setCurrentExecutor(agent.id, exec.id);
    return { agentId: agent.id, executorId: exec.id };
  }

  test('happy path — writes outcome, clears agent FK, records audit row', async () => {
    const { agentId, executorId } = await seed();

    const result = await turnClose({ outcome: 'done', executorId, actor: 'eng-close' });

    expect(result.noop).toBe(false);
    expect(result.executorId).toBe(executorId);
    expect(result.outcome).toBe('done');
    expect(result.closedAt).not.toBeNull();

    const exec = await getExecutor(executorId);
    expect(exec!.outcome).toBe('done');
    expect(exec!.closedAt).not.toBeNull();
    expect(exec!.state).toBe('done');
    expect(exec!.endedAt).not.toBeNull();

    const sql = await getConnection();
    const [agentRow] = await sql<{ current_executor_id: string | null }[]>`
      SELECT current_executor_id FROM agents WHERE id = ${agentId}
    `;
    expect(agentRow.current_executor_id).toBeNull();

    const auditRows = await sql<{ event_type: string; actor: string; details: unknown }[]>`
      SELECT event_type, actor, details FROM audit_events
      WHERE entity_type = 'executor' AND entity_id = ${executorId}
    `;
    expect(auditRows.length).toBe(1);
    expect(auditRows[0].event_type).toBe('turn_close.done');
    expect(auditRows[0].actor).toBe('eng-close');
  });

  test('blocked and failed require --reason', async () => {
    const { executorId } = await seed();
    await expect(turnClose({ outcome: 'blocked', executorId })).rejects.toThrow(/reason/i);
    await expect(turnClose({ outcome: 'failed', executorId })).rejects.toThrow(/reason/i);
  });

  test('blocked writes outcome and close_reason', async () => {
    const { executorId } = await seed();
    const result = await turnClose({ outcome: 'blocked', reason: 'pg unreachable', executorId });
    expect(result.noop).toBe(false);
    const exec = await getExecutor(executorId);
    expect(exec!.outcome).toBe('blocked');
    expect(exec!.closeReason).toBe('pg unreachable');
  });

  test('failed writes outcome and close_reason', async () => {
    const { executorId } = await seed();
    const result = await turnClose({ outcome: 'failed', reason: 'test assertion broke', executorId });
    expect(result.noop).toBe(false);
    const exec = await getExecutor(executorId);
    expect(exec!.outcome).toBe('failed');
    expect(exec!.closeReason).toBe('test assertion broke');
  });

  test('idempotent — second call on already-closed executor is a no-op', async () => {
    const { executorId } = await seed();
    await turnClose({ outcome: 'done', executorId });

    const sql = await getConnection();
    const [first] = await sql<{ closed_at: Date }[]>`SELECT closed_at FROM executors WHERE id = ${executorId}`;
    const firstClosed = first.closed_at;

    const second = await turnClose({ outcome: 'done', executorId });
    expect(second.noop).toBe(true);

    const [after] = await sql<{ closed_at: Date }[]>`SELECT closed_at FROM executors WHERE id = ${executorId}`;
    expect(after.closed_at.toISOString()).toBe(firstClosed.toISOString());

    const auditRows = await sql<{ id: number }[]>`
      SELECT id FROM audit_events WHERE entity_type = 'executor' AND entity_id = ${executorId}
    `;
    expect(auditRows.length).toBe(1);
  });

  test('idempotent — no-op when executor is already in terminal state', async () => {
    const agent = await findOrCreateAgent('eng-terminal', 'test-team', 'engineer');
    const exec = await createExecutor(agent.id, 'claude', 'tmux', { state: 'terminated' });

    const result = await turnClose({ outcome: 'done', executorId: exec.id });
    expect(result.noop).toBe(true);

    const sql = await getConnection();
    const [row] = await sql<{ outcome: string | null }[]>`SELECT outcome FROM executors WHERE id = ${exec.id}`;
    expect(row.outcome).toBeNull();
  });

  test('throws when executor not found', async () => {
    await expect(turnClose({ outcome: 'done', executorId: 'does-not-exist' })).rejects.toThrow(/not found/i);
  });

  test('rollback — audit INSERT failure reverts executors + agents', async () => {
    const { agentId, executorId } = await seed();

    await expect(
      turnClose({
        outcome: 'done',
        executorId,
        auditInsert: async () => {
          throw new Error('simulated audit failure');
        },
      }),
    ).rejects.toThrow(/simulated audit failure/);

    const sql = await getConnection();
    const [execRow] = await sql<{ outcome: string | null; state: string; closed_at: Date | null }[]>`
      SELECT outcome, state, closed_at FROM executors WHERE id = ${executorId}
    `;
    expect(execRow.outcome).toBeNull();
    expect(execRow.state).toBe('working');
    expect(execRow.closed_at).toBeNull();

    const [agentRow] = await sql<{ current_executor_id: string | null }[]>`
      SELECT current_executor_id FROM agents WHERE id = ${agentId}
    `;
    expect(agentRow.current_executor_id).toBe(executorId);

    const auditRows = await sql<{ id: number }[]>`
      SELECT id FROM audit_events WHERE entity_id = ${executorId}
    `;
    expect(auditRows.length).toBe(0);
  });

  test('resolves executor id from GENIE_EXECUTOR_ID env', async () => {
    const { executorId } = await seed();
    process.env.GENIE_EXECUTOR_ID = executorId;
    const result = await turnClose({ outcome: 'done' });
    expect(result.executorId).toBe(executorId);
  });

  test('errors loudly when no executor id is resolvable', async () => {
    process.env.GENIE_EXECUTOR_ID = undefined;
    await expect(turnClose({ outcome: 'done' })).rejects.toThrow(/GENIE_EXECUTOR_ID/);
  });

  // --------------------------------------------------------------------------
  // Bug E — resolver fallback for ghost executors.
  //
  // Scenario: pgserve reset wipes the `executors` row but the live worker
  // pane retains `GENIE_EXECUTOR_ID` in env. `turnClose` must fall back to
  // `agent_id = GENIE_AGENT_NAME` and close successfully with a warning +
  // `rot.executor-ghost.detected` event, rather than throwing.
  // --------------------------------------------------------------------------

  test('fallback: env id ghost → resolves by GENIE_AGENT_NAME, closes cleanly', async () => {
    const { agentId, executorId } = await seed();
    // Simulate the ghost: env points to a UUID that does not exist in PG.
    const ghostId = '00000000-dead-4000-8000-000000000001';
    process.env.GENIE_EXECUTOR_ID = ghostId;
    process.env.GENIE_AGENT_NAME = agentId;

    const result = await turnClose({ outcome: 'done', actor: agentId });

    expect(result.noop).toBe(false);
    // Fallback resolved to the real executor for this agent.
    expect(result.executorId).toBe(executorId);
    expect(result.outcome).toBe('done');

    // The real executor row got closed, not the ghost UUID.
    const exec = await getExecutor(executorId);
    expect(exec!.outcome).toBe('done');
    expect(exec!.state).toBe('done');

    // Ghost UUID still has no row (we didn't invent one).
    const sql = await getConnection();
    const [ghostRow] = await sql<{ id: string }[]>`SELECT id FROM executors WHERE id = ${ghostId}`;
    expect(ghostRow).toBeUndefined();
  });

  test('fallback: picks most recent executor when agent has multiple', async () => {
    const { agentId } = await seed();
    // Second executor for the same agent — this should win the fallback.
    const newer = await createExecutor(agentId, 'claude', 'tmux', { state: 'working' });

    process.env.GENIE_EXECUTOR_ID = '00000000-dead-4000-8000-000000000002';
    process.env.GENIE_AGENT_NAME = agentId;

    const result = await turnClose({ outcome: 'done', actor: agentId });
    expect(result.executorId).toBe(newer.id);
  });

  test('fallback: no agent name env → throws (no silent pick)', async () => {
    await seed();
    process.env.GENIE_EXECUTOR_ID = '00000000-dead-4000-8000-000000000003';
    process.env.GENIE_AGENT_NAME = undefined;

    await expect(turnClose({ outcome: 'done' })).rejects.toThrow(/not found/);
  });

  test('fallback: agent name with zero executor rows → throws', async () => {
    process.env.GENIE_EXECUTOR_ID = '00000000-dead-4000-8000-000000000004';
    process.env.GENIE_AGENT_NAME = 'nonexistent-agent-xyz';
    // No seed — truly nothing exists for this agent.

    await expect(turnClose({ outcome: 'done' })).rejects.toThrow(/not found/);
  });

  test('happy path unchanged: env id resolves directly, no fallback warning', async () => {
    const { executorId, agentId } = await seed();
    process.env.GENIE_EXECUTOR_ID = executorId;
    process.env.GENIE_AGENT_NAME = agentId;

    // Capture stderr warnings — happy path must NOT emit the fallback warn.
    const originalWarn = console.warn;
    const warns: string[] = [];
    console.warn = (...args: unknown[]) => warns.push(args.join(' '));
    try {
      const result = await turnClose({ outcome: 'done', actor: agentId });
      expect(result.executorId).toBe(executorId);
    } finally {
      console.warn = originalWarn;
    }

    const fallbackWarns = warns.filter((w) => w.includes('falling back'));
    expect(fallbackWarns).toHaveLength(0);
  });
});
