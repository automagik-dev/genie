/**
 * Pane-trap safety-net tests — turn-session-contract Group 5.
 *
 * Covers the DB-layer idempotency contract (first writer wins) and the
 * pure string builders for tmux / shell install helpers. Real tmux
 * pane-death is exercised by the CLI wiring, not this unit suite.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { findOrCreateAgent, setCurrentExecutor } from './agent-registry.js';
import { getConnection } from './db.js';
import { createExecutor, getExecutor } from './executor-registry.js';
import { buildPaneDiedHookCmd, installTmuxPaneDiedHook, shellExitTrapSnippet, trapPaneExit } from './pane-trap.js';
import { DB_AVAILABLE, setupTestDatabase } from './test-db.js';
import { turnClose } from './turn-close.js';

describe('buildPaneDiedHookCmd', () => {
  test('scopes the hook to a specific pane with -p -t', () => {
    const cmd = buildPaneDiedHookCmd('%42');
    expect(cmd.startsWith('set-hook -p -t')).toBe(true);
    expect(cmd).toContain("-t '%42'");
    expect(cmd).toContain('pane-died');
  });

  test('expands #{hook_pane} so tmux substitutes the dying pane id', () => {
    const cmd = buildPaneDiedHookCmd('%1');
    expect(cmd).toContain('--pane-id=#{hook_pane}');
    expect(cmd).toContain('--reason=pane_died');
  });

  test('invokes the configured genie binary path', () => {
    const cmd = buildPaneDiedHookCmd('%9', '/custom/bin/genie');
    expect(cmd).toContain('/custom/bin/genie pane-trap');
  });
});

describe('installTmuxPaneDiedHook', () => {
  test('rejects obviously-invalid pane ids without calling tmux', async () => {
    // These should silently no-op — no throw, no tmux spawn.
    await installTmuxPaneDiedHook('');
    await installTmuxPaneDiedHook('inline');
    await installTmuxPaneDiedHook('not-a-pane');
  });
});

describe('shellExitTrapSnippet', () => {
  test('registers a bash trap on EXIT referencing $GENIE_EXECUTOR_ID', () => {
    const snippet = shellExitTrapSnippet();
    expect(snippet.startsWith('trap ')).toBe(true);
    expect(snippet.endsWith(' EXIT')).toBe(true);
    expect(snippet).toContain('$GENIE_EXECUTOR_ID');
    expect(snippet).toContain('--reason=shell_exit');
  });

  test('uses a custom genie binary when provided', () => {
    expect(shellExitTrapSnippet('/opt/genie/bin/genie')).toContain('/opt/genie/bin/genie pane-trap');
  });

  test('does not alter the shell exit code (|| true)', () => {
    expect(shellExitTrapSnippet()).toContain('|| true');
  });
});

describe.skipIf(!DB_AVAILABLE)('trapPaneExit (integration)', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
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

  async function seed(opts: { paneId?: string | null; state?: 'working' | 'idle' } = {}) {
    const agent = await findOrCreateAgent(
      `eng-trap-${Math.random().toString(36).slice(2, 7)}`,
      'test-team',
      'engineer',
    );
    const exec = await createExecutor(agent.id, 'claude', 'tmux', {
      state: opts.state ?? 'working',
      tmuxPaneId: opts.paneId === undefined ? '%7' : opts.paneId,
    });
    await setCurrentExecutor(agent.id, exec.id);
    return { agentId: agent.id, executorId: exec.id, paneId: exec.tmuxPaneId };
  }

  test('writes clean_exit_unverified outcome + state=error + closed_at', async () => {
    const { agentId, executorId } = await seed();

    const result = await trapPaneExit({ executorId, reason: 'pane_died', actor: 'tmux-hook' });

    expect(result.noop).toBe(false);
    expect(result.outcome).toBe('clean_exit_unverified');
    expect(result.reason).toBe('pane_died');

    const exec = await getExecutor(executorId);
    expect(exec!.outcome).toBe('clean_exit_unverified');
    expect(exec!.state).toBe('error');
    expect(exec!.closedAt).not.toBeNull();
    expect(exec!.closeReason).toBe('pane_died');
    expect(exec!.endedAt).not.toBeNull();

    const sql = await getConnection();
    const [agentRow] = await sql<{ current_executor_id: string | null }[]>`
      SELECT current_executor_id FROM agents WHERE id = ${agentId}
    `;
    // Post-2026-04-25 power-outage post-mortem: keep current_executor_id
    // pointing at the just-terminated executor so its claude_session_id
    // survives as the recovery anchor for getResumeSessionId. Prior contract
    // (null FK on terminate) erased the link to the dormant session UUID.
    // Liveness is gated by executor.state ∈ {error, terminated, done} via
    // getCurrentExecutor / getLiveExecutorState, so the FK staying populated
    // is safe.
    expect(agentRow.current_executor_id).toBe(executorId);

    const audits = await sql<{ event_type: string; actor: string; details: unknown }[]>`
      SELECT event_type, actor, details FROM audit_events
      WHERE entity_type = 'executor' AND entity_id = ${executorId}
    `;
    expect(audits.length).toBe(1);
    expect(audits[0].event_type).toBe('turn_close.clean_exit_unverified');
    expect(audits[0].actor).toBe('tmux-hook');
  });

  test('idempotent: verb fired first → trap is a no-op, verb outcome preserved', async () => {
    const { executorId } = await seed();
    await turnClose({ outcome: 'done', executorId, actor: 'agent' });

    const sql = await getConnection();
    const [before] = await sql<{ outcome: string; close_reason: string | null; closed_at: Date }[]>`
      SELECT outcome, close_reason, closed_at FROM executors WHERE id = ${executorId}
    `;

    const result = await trapPaneExit({ executorId, reason: 'pane_died' });
    expect(result.noop).toBe(true);

    const [after] = await sql<{ outcome: string; close_reason: string | null; closed_at: Date }[]>`
      SELECT outcome, close_reason, closed_at FROM executors WHERE id = ${executorId}
    `;
    expect(after.outcome).toBe('done'); // verb's outcome wins
    expect(after.close_reason).toBe(before.close_reason);
    expect(after.closed_at.toISOString()).toBe(before.closed_at.toISOString());

    const audits = await sql<{ event_type: string }[]>`
      SELECT event_type FROM audit_events WHERE entity_id = ${executorId} ORDER BY id
    `;
    // Only the verb's audit row — the trap must not emit a second.
    expect(audits.map((a: { event_type: string }) => a.event_type)).toEqual(['turn_close.done']);
  });

  test('idempotent: trap fires twice → second call is a no-op', async () => {
    const { executorId } = await seed();
    const first = await trapPaneExit({ executorId, reason: 'pane_died' });
    expect(first.noop).toBe(false);

    const second = await trapPaneExit({ executorId, reason: 'pane_died' });
    expect(second.noop).toBe(true);

    const sql = await getConnection();
    const audits = await sql<{ id: number }[]>`
      SELECT id FROM audit_events WHERE entity_id = ${executorId}
    `;
    expect(audits.length).toBe(1);
  });

  test('resolves executor by pane_id when executor_id is not supplied', async () => {
    const { executorId, paneId } = await seed({ paneId: '%99' });
    expect(paneId).toBe('%99');

    const result = await trapPaneExit({ paneId: '%99', reason: 'pane_died' });
    expect(result.noop).toBe(false);
    expect(result.executorId).toBe(executorId);

    const exec = await getExecutor(executorId);
    expect(exec!.outcome).toBe('clean_exit_unverified');
  });

  test('picks the most-recent executor when a pane id was reused', async () => {
    // Simulate tmux pane-id reuse: two executors bound to the same %N,
    // the newer one is the live turn. The trap must hit the newer one.
    const oldAgent = await findOrCreateAgent('reuse-old', 'test-team', 'engineer');
    const oldExec = await createExecutor(oldAgent.id, 'claude', 'tmux', { state: 'working', tmuxPaneId: '%55' });
    // Backdate the old executor so ORDER BY started_at DESC picks the new one.
    const sql = await getConnection();
    await sql`UPDATE executors SET started_at = now() - interval '1 hour' WHERE id = ${oldExec.id}`;

    const newAgent = await findOrCreateAgent('reuse-new', 'test-team', 'engineer');
    const newExec = await createExecutor(newAgent.id, 'claude', 'tmux', { state: 'working', tmuxPaneId: '%55' });

    const result = await trapPaneExit({ paneId: '%55', reason: 'pane_died' });
    expect(result.executorId).toBe(newExec.id);

    const newRow = await getExecutor(newExec.id);
    const oldRow = await getExecutor(oldExec.id);
    expect(newRow!.outcome).toBe('clean_exit_unverified');
    expect(oldRow!.outcome).toBeNull(); // untouched
  });

  test('shell_exit reason is written when supplied (inline executor path)', async () => {
    const { executorId } = await seed();
    const result = await trapPaneExit({ executorId, reason: 'shell_exit' });
    expect(result.reason).toBe('shell_exit');
    const exec = await getExecutor(executorId);
    expect(exec!.closeReason).toBe('shell_exit');
    expect(exec!.outcome).toBe('clean_exit_unverified');
  });

  test('no executor resolvable → silent no-op, no throw', async () => {
    // Neither executor_id nor a pane_id that matches anything.
    const result = await trapPaneExit({ paneId: '%does-not-exist', reason: 'pane_died' });
    expect(result.noop).toBe(true);
    expect(result.executorId).toBeNull();
    expect(result.outcome).toBeNull();
  });

  test('unknown executor_id → silent no-op, no throw', async () => {
    const result = await trapPaneExit({ executorId: 'never-existed', reason: 'pane_died' });
    expect(result.noop).toBe(true);
    // Implementation sets executorId on the result once resolved; for unknown
    // ids the SELECT returns zero rows and we short-circuit.
    expect(result.outcome).toBeNull();
  });
});
