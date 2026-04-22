/**
 * `buildFullResumeParams` must raise `MissingResumeSessionError` when the
 * agent has no resumable session.
 *
 * Pre-fix, `buildResumeParams` wrote `agent.claudeSessionId!` into
 * `SpawnParams.resume`, which collapsed a null value to undefined and
 * silently spawned a fresh Claude session — the exact stale-resume
 * regression Gap C's invariant is meant to prevent end-to-end.
 *
 * Post-migration-047: the session lives on the current executor, not on the
 * agent row. `buildFullResumeParams` calls `getResumeSessionId(agent.id)`,
 * which joins `agents.current_executor_id → executors.claude_session_id`.
 * This test seeds an agent with NO current executor and asserts the typed
 * error still fires.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as registry from '../../lib/agent-registry.js';
import { getConnection } from '../../lib/db.js';
import { MissingResumeSessionError } from '../../lib/protocol-router.js';
import { DB_AVAILABLE, setupTestSchema } from '../../lib/test-db.js';
import { buildFullResumeParams } from '../agents.js';

describe.skipIf(!DB_AVAILABLE)('buildFullResumeParams — MissingResumeSessionError invariant', () => {
  let cleanupSchema: () => Promise<void>;

  beforeAll(async () => {
    cleanupSchema = await setupTestSchema();
  });

  afterAll(async () => {
    await cleanupSchema();
  });

  beforeEach(async () => {
    const sql = await getConnection();
    await sql`TRUNCATE TABLE agents CASCADE`;
  });

  async function seedAgentWithoutExecutor(id: string): Promise<registry.Agent> {
    const now = new Date().toISOString();
    await registry.register({
      id,
      paneId: '%1',
      session: 'test-session',
      worktree: null,
      startedAt: now,
      state: 'error',
      lastStateChange: now,
      repoPath: '/tmp/test',
      role: 'engineer',
      team: 'alpha',
      provider: 'claude',
    });
    const fresh = await registry.get(id);
    if (!fresh) throw new Error(`seedAgentWithoutExecutor: agent "${id}" not persisted`);
    return fresh;
  }

  test('throws MissingResumeSessionError when the agent has no current executor', async () => {
    const agent = await seedAgentWithoutExecutor('agent-1');
    await expect(buildFullResumeParams(agent, undefined)).rejects.toBeInstanceOf(MissingResumeSessionError);
  });

  test('error carries workerId for operator diagnostics', async () => {
    const agent = await seedAgentWithoutExecutor('broken-worker');
    try {
      await buildFullResumeParams(agent, undefined);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingResumeSessionError);
      const e = err as MissingResumeSessionError;
      expect(e.workerId).toBe('broken-worker');
      expect(e.message).toContain('broken-worker');
      expect(e.message).toContain('claude_session_id');
    }
  });
});
