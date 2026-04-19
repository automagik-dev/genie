/**
 * Gap 1 (loop 2/2): `buildFullResumeParams` must raise
 * `MissingResumeSessionError` when the agent has no `claudeSessionId`.
 *
 * Pre-fix, `buildResumeParams` wrote `agent.claudeSessionId!` into
 * `SpawnParams.resume`, which collapsed a null value to undefined and
 * silently spawned a fresh Claude session — the exact stale-resume
 * regression Gap C's invariant is meant to prevent end-to-end.
 */

import { describe, expect, test } from 'bun:test';
import type { Agent } from '../../lib/agent-registry.js';
import { MissingResumeSessionError } from '../../lib/protocol-router.js';
import { buildFullResumeParams } from '../agents.js';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  const now = new Date().toISOString();
  return {
    id: 'agent-1',
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
    ...overrides,
  };
}

describe('buildFullResumeParams (Gap 1 — null claudeSessionId invariant)', () => {
  test('throws MissingResumeSessionError when claudeSessionId is undefined', async () => {
    const agent = makeAgent({ claudeSessionId: undefined });
    await expect(buildFullResumeParams(agent, undefined)).rejects.toBeInstanceOf(MissingResumeSessionError);
  });

  test('error carries workerId for operator diagnostics', async () => {
    const agent = makeAgent({ id: 'broken-worker', claudeSessionId: undefined });
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
