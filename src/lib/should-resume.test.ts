/**
 * shouldResume — chokepoint tests.
 *
 * Covers the four orthogonal axes the chokepoint reads:
 *   1. agent existence
 *   2. auto_resume flag
 *   3. latest assignment outcome
 *   4. session UUID lookup (DB happy path delegates to getResumeSessionId)
 * Plus the boot-pass classification + parallel decision orchestration.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { findOrCreateAgent, setCurrentExecutor } from './agent-registry.js';
import { completeAssignment, createAssignment } from './assignment-registry.js';
import { getConnection } from './db.js';
import { createExecutor } from './executor-registry.js';
import {
  BOOT_PASS_CONCURRENCY_CAP,
  bootPassDecisions,
  bootPassEventType,
  classifyBootPass,
  shouldResume,
} from './should-resume.js';
import { DB_AVAILABLE, setupTestDatabase } from './test-db.js';

describe.skipIf(!DB_AVAILABLE)('should-resume chokepoint', () => {
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
    await sql`DELETE FROM audit_events WHERE event_type LIKE 'resume.%' OR event_type LIKE 'agent.boot_pass.%'`;
  });

  /**
   * Helper: seed an agent with explicit reports_to so we can exercise the
   * permanent vs task-bound classification axis. `reports_to=null` →
   * permanent; non-null → task-bound.
   */
  async function seedAgent(
    opts: {
      name?: string;
      team?: string;
      role?: string;
      reportsTo?: string | null;
      autoResume?: boolean;
      repoPath?: string;
    } = {},
  ): Promise<string> {
    const name = opts.name ?? 'eng';
    const team = opts.team ?? 'test-team';
    const agent = await findOrCreateAgent(name, team, opts.role);
    const sql = await getConnection();
    const updates: Record<string, unknown> = {};
    if (opts.reportsTo !== undefined) updates.reports_to = opts.reportsTo;
    if (opts.autoResume !== undefined) updates.auto_resume = opts.autoResume;
    if (opts.repoPath !== undefined) updates.repo_path = opts.repoPath;
    if (Object.keys(updates).length > 0) {
      await sql`UPDATE agents SET ${sql(updates)} WHERE id = ${agent.id}`;
    }
    return agent.id;
  }

  // ==========================================================================
  // Existence axis
  // ==========================================================================

  test('unknown agent: returns resume=false reason=unknown_agent rehydrate=lazy', async () => {
    const result = await shouldResume('00000000-0000-0000-0000-000000000000');
    expect(result.resume).toBe(false);
    expect(result.reason).toBe('unknown_agent');
    expect(result.rehydrate).toBe('lazy');
    expect(result.sessionId).toBeUndefined();
  });

  // ==========================================================================
  // auto_resume axis
  // ==========================================================================

  test('auto_resume=false: resume=false reason=auto_resume_disabled', async () => {
    const agentId = await seedAgent({ autoResume: false, reportsTo: null });
    const exec = await createExecutor(agentId, 'claude', 'tmux', { claudeSessionId: 'sess-paused' });
    await setCurrentExecutor(agentId, exec.id);

    const result = await shouldResume(agentId);
    expect(result.resume).toBe(false);
    expect(result.reason).toBe('auto_resume_disabled');
    // Session UUID still surfaces for forensic display.
    expect(result.sessionId).toBe('sess-paused');
  });

  // ==========================================================================
  // assignment outcome axis
  // ==========================================================================

  test('latest assignment closed: resume=false reason=assignment_closed', async () => {
    const agentId = await seedAgent({ reportsTo: 'team-lead', autoResume: true });
    const exec = await createExecutor(agentId, 'claude', 'tmux', { claudeSessionId: 'sess-task' });
    await setCurrentExecutor(agentId, exec.id);

    const assignment = await createAssignment(exec.id, 'task-1', 'wish-x', 1);
    await completeAssignment(assignment.id, 'completed');

    const result = await shouldResume(agentId);
    expect(result.resume).toBe(false);
    expect(result.reason).toBe('assignment_closed');
    expect(result.sessionId).toBe('sess-task');
    expect(result.rehydrate).toBe('lazy');
  });

  test('latest assignment open: resume=true reason=ok', async () => {
    const agentId = await seedAgent({ reportsTo: 'team-lead', autoResume: true });
    const exec = await createExecutor(agentId, 'claude', 'tmux', { claudeSessionId: 'sess-open' });
    await setCurrentExecutor(agentId, exec.id);
    await createAssignment(exec.id, 'task-2', 'wish-y', 2);

    const result = await shouldResume(agentId);
    expect(result.resume).toBe(true);
    expect(result.reason).toBe('ok');
    expect(result.sessionId).toBe('sess-open');
    expect(result.rehydrate).toBe('lazy');
  });

  test('most-recent assignment is the one consulted (older completed, newer open)', async () => {
    const agentId = await seedAgent({ reportsTo: 'team-lead', autoResume: true });
    const exec = await createExecutor(agentId, 'claude', 'tmux', { claudeSessionId: 'sess-multi' });
    await setCurrentExecutor(agentId, exec.id);

    const older = await createAssignment(exec.id, 'task-old', 'wish-x', 1);
    await completeAssignment(older.id, 'completed');
    // Newer, still open.
    await createAssignment(exec.id, 'task-new', 'wish-x', 2);

    const result = await shouldResume(agentId);
    expect(result.resume).toBe(true);
    expect(result.reason).toBe('ok');
  });

  // ==========================================================================
  // session UUID axis (delegated to getResumeSessionId)
  // ==========================================================================

  test('no executor + no JSONL fallback: resume=false reason=no_session_id', async () => {
    const agentId = await seedAgent({ reportsTo: null, autoResume: true });
    const result = await shouldResume(agentId);
    expect(result.resume).toBe(false);
    expect(result.reason).toBe('no_session_id');
    expect(result.sessionId).toBeUndefined();
  });

  test('happy path (permanent agent): resume=true reason=ok rehydrate=eager', async () => {
    const agentId = await seedAgent({ reportsTo: null, autoResume: true });
    const exec = await createExecutor(agentId, 'claude', 'tmux', { claudeSessionId: 'sess-perm' });
    await setCurrentExecutor(agentId, exec.id);

    const result = await shouldResume(agentId);
    expect(result.resume).toBe(true);
    expect(result.reason).toBe('ok');
    expect(result.sessionId).toBe('sess-perm');
    expect(result.rehydrate).toBe('eager');
  });

  // ==========================================================================
  // Permanence inference (Decision #5: identity-shape, not lifecycle)
  // ==========================================================================

  test('dir:-prefixed agent: rehydrate=eager (permanent placeholder)', async () => {
    const sql = await getConnection();
    // dir:-prefixed rows are placeholders the directory layer creates and
    // never deletes. We insert one directly because findOrCreateAgent mints
    // UUIDs.
    await sql`
      INSERT INTO agents (id, custom_name, team, role, started_at, state, reports_to, auto_resume)
      VALUES ('dir:test/eng', 'eng', 'test-team', 'engineer', now(), null, 'team-lead', true)
    `;
    const exec = await createExecutor('dir:test/eng', 'claude', 'tmux', { claudeSessionId: 'sess-dir' });
    await setCurrentExecutor('dir:test/eng', exec.id);

    const result = await shouldResume('dir:test/eng');
    expect(result.rehydrate).toBe('eager'); // dir:-prefix → permanent
    expect(result.sessionId).toBe('sess-dir');
  });

  test('reports_to=null agent: rehydrate=eager (root identity)', async () => {
    const agentId = await seedAgent({ reportsTo: null, autoResume: true });
    const exec = await createExecutor(agentId, 'claude', 'tmux', { claudeSessionId: 'sess-root' });
    await setCurrentExecutor(agentId, exec.id);

    const result = await shouldResume(agentId);
    expect(result.rehydrate).toBe('eager');
  });

  test('task agent (reports_to set): rehydrate=lazy', async () => {
    const agentId = await seedAgent({ reportsTo: 'team-lead-uuid', autoResume: true });
    const exec = await createExecutor(agentId, 'claude', 'tmux', { claudeSessionId: 'sess-task' });
    await setCurrentExecutor(agentId, exec.id);
    await createAssignment(exec.id, 'task-x', 'wish-x', 1);

    const result = await shouldResume(agentId);
    expect(result.rehydrate).toBe('lazy');
  });

  // ==========================================================================
  // Boot-pass classification
  // ==========================================================================

  test('classifyBootPass: eager_invoke for permanent + resume=true', () => {
    const decision = classifyBootPass('agent-1', {
      resume: true,
      reason: 'ok',
      sessionId: 'sess-1',
      rehydrate: 'eager',
    });
    expect(decision.action).toBe('eager_invoke');
  });

  test('classifyBootPass: lazy_surface for task + resume=true', () => {
    const decision = classifyBootPass('agent-2', {
      resume: true,
      reason: 'ok',
      sessionId: 'sess-2',
      rehydrate: 'lazy',
    });
    expect(decision.action).toBe('lazy_surface');
  });

  test('classifyBootPass: skip for resume=false', () => {
    const decision = classifyBootPass('agent-3', {
      resume: false,
      reason: 'auto_resume_disabled',
      rehydrate: 'eager',
    });
    expect(decision.action).toBe('skip');
  });

  test('bootPassEventType: maps actions to documented event names', () => {
    expect(bootPassEventType('eager_invoke', { resume: true, reason: 'ok', rehydrate: 'eager' })).toBe(
      'agent.boot_pass.eager_invoked',
    );
    expect(bootPassEventType('lazy_surface', { resume: true, reason: 'ok', rehydrate: 'lazy' })).toBe(
      'agent.boot_pass.lazy_pending',
    );
    expect(bootPassEventType('skip', { resume: false, reason: 'assignment_closed', rehydrate: 'lazy' })).toBe(
      'agent.boot_pass.skipped_task_done',
    );
    expect(bootPassEventType('skip', { resume: false, reason: 'no_session_id', rehydrate: 'eager' })).toBe(
      'agent.boot_pass.rehydrated',
    );
  });

  test('BOOT_PASS_CONCURRENCY_CAP is 32', () => {
    expect(BOOT_PASS_CONCURRENCY_CAP).toBe(32);
  });

  // ==========================================================================
  // Parallel boot-pass orchestration
  // ==========================================================================

  test('bootPassDecisions: runs across many agents and returns one decision per agent', async () => {
    const ids: string[] = [];
    // Mix of permanent and task-bound agents, some with sessions, some without.
    for (let i = 0; i < 5; i++) {
      const id = await seedAgent({
        name: `eng-${i}`,
        team: `team-${i}`,
        reportsTo: i % 2 === 0 ? null : 'team-lead',
        autoResume: true,
      });
      if (i % 2 === 0) {
        const exec = await createExecutor(id, 'claude', 'tmux', { claudeSessionId: `sess-${i}` });
        await setCurrentExecutor(id, exec.id);
      }
      ids.push(id);
    }

    const decisions = await bootPassDecisions(ids);
    expect(decisions).toHaveLength(5);
    expect(decisions.map((d) => d.agentId).sort()).toEqual([...ids].sort());

    // Permanent agents (even indexes) with sessions → eager_invoke.
    const permanentEager = decisions.filter((d) => d.action === 'eager_invoke');
    expect(permanentEager.length).toBe(3); // indexes 0, 2, 4

    // Task agents (odd indexes) with no session → skip.
    const taskSkipped = decisions.filter((d) => d.action === 'skip');
    expect(taskSkipped.length).toBe(2);
  });

  test('bootPassDecisions: empty list returns []', async () => {
    expect(await bootPassDecisions([])).toEqual([]);
  });

  // ==========================================================================
  // Read-path purity (Group 1 of observability-signal-normalization)
  //
  // Pre-Group-1, every shouldResume() call funneled into getResumeSessionId,
  // which emitted `resume.found` on the DB happy path. With status, ls, and
  // TUI work-state all calling shouldResume hundreds of times per minute on
  // felipe's daily-use DB, the result was 242,553 `resume.found` rows in 24h.
  //
  // Group 1 makes the read path pure: getResumeSessionId no longer emits;
  // emission moved to acquireResumeSessionForAttempt (called from actual
  // resume sites — buildFullResumeParams, team-auto-spawn,
  // protocol-router.resolveResumeSessionId). These tests pin that contract
  // so a future regression that re-introduces emission from the read path
  // gets caught at gate-time.
  // ==========================================================================
  describe('read-path purity', () => {
    async function countResumeAuditRows(agentId: string): Promise<{ found: number; recovered: number }> {
      const sql = await getConnection();
      const rows = await sql<{ event_type: string; cnt: number }[]>`
        SELECT event_type, COUNT(*)::int AS cnt
        FROM audit_events
        WHERE entity_type = 'agent'
          AND entity_id = ${agentId}
          AND event_type IN ('resume.found', 'resume.recovered_via_jsonl')
        GROUP BY event_type
      `;
      const out = { found: 0, recovered: 0 };
      for (const row of rows) {
        if (row.event_type === 'resume.found') out.found = row.cnt;
        if (row.event_type === 'resume.recovered_via_jsonl') out.recovered = row.cnt;
      }
      return out;
    }

    test('repeated shouldResume on a happy-path agent inserts zero resume.* audit rows', async () => {
      const agentId = await seedAgent({ reportsTo: null, autoResume: true });
      const exec = await createExecutor(agentId, 'claude', 'tmux', { claudeSessionId: 'sess-read-pure' });
      await setCurrentExecutor(agentId, exec.id);

      // 50 reads — mimics sustained TUI ticks + status reads on a live agent.
      // Pre-Group-1: 50 `resume.found` rows. Post-Group-1: 0.
      for (let i = 0; i < 50; i++) {
        const decision = await shouldResume(agentId);
        expect(decision.resume).toBe(true);
        expect(decision.sessionId).toBe('sess-read-pure');
      }

      const counts = await countResumeAuditRows(agentId);
      expect(counts.found).toBe(0);
      expect(counts.recovered).toBe(0);
    });

    test('shouldResume on auto_resume_disabled agent is silent (forensic sessionId still surfaced)', async () => {
      const agentId = await seedAgent({ autoResume: false, reportsTo: null });
      const exec = await createExecutor(agentId, 'claude', 'tmux', { claudeSessionId: 'sess-paused' });
      await setCurrentExecutor(agentId, exec.id);

      for (let i = 0; i < 10; i++) {
        const decision = await shouldResume(agentId);
        expect(decision.resume).toBe(false);
        expect(decision.sessionId).toBe('sess-paused');
      }

      const counts = await countResumeAuditRows(agentId);
      expect(counts.found).toBe(0);
      expect(counts.recovered).toBe(0);
    });

    test('shouldResume on assignment-closed agent is silent', async () => {
      const agentId = await seedAgent({ reportsTo: 'team-lead', autoResume: true });
      const exec = await createExecutor(agentId, 'claude', 'tmux', { claudeSessionId: 'sess-closed' });
      await setCurrentExecutor(agentId, exec.id);
      const assignment = await createAssignment(exec.id, 'task-closed', 'wish-x', 1);
      await completeAssignment(assignment.id, 'completed');

      for (let i = 0; i < 10; i++) {
        const decision = await shouldResume(agentId);
        expect(decision.resume).toBe(false);
        expect(decision.reason).toBe('assignment_closed');
      }

      const counts = await countResumeAuditRows(agentId);
      expect(counts.found).toBe(0);
      expect(counts.recovered).toBe(0);
    });

    test('bootPassDecisions on a fixture of 10 agents inserts zero resume.* rows', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        const id = await seedAgent({
          name: `read-pure-${i}`,
          team: `read-pure-team-${i}`,
          reportsTo: i % 2 === 0 ? null : 'team-lead',
          autoResume: true,
        });
        const exec = await createExecutor(id, 'claude', 'tmux', { claudeSessionId: `sess-bp-${i}` });
        await setCurrentExecutor(id, exec.id);
        ids.push(id);
      }

      const decisions = await bootPassDecisions(ids);
      expect(decisions).toHaveLength(10);

      // Verify NONE of the agents got a resume audit row from the boot pass.
      const sql = await getConnection();
      const rows = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM audit_events
        WHERE entity_type = 'agent'
          AND entity_id = ANY(${ids})
          AND event_type IN ('resume.found', 'resume.recovered_via_jsonl')
      `;
      expect(rows[0].count).toBe(0);
    });
  });
});
