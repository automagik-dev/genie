/**
 * Tests for buildResumeContext — resume context injection for agents.
 *
 * Requires pgserve (auto-started via getConnection).
 * Each test uses a unique repo_path for isolation.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Agent } from '../lib/agent-registry.js';
import { DB_AVAILABLE, setupTestSchema } from '../lib/test-db.js';
import * as wishState from '../lib/wish-state.js';
import { buildResumeContext } from './agents.js';

let cwd: string;

describe.skipIf(!DB_AVAILABLE)('pg', () => {
  let cleanupSchema: () => Promise<void>;

  beforeAll(async () => {
    cleanupSchema = await setupTestSchema();
  });

  afterAll(async () => {
    await cleanupSchema();
  });

  beforeEach(() => {
    cwd = `/tmp/genie-resume-ctx-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  });

  function makeAgent(overrides: Partial<Agent> = {}): Agent {
    return {
      id: 'test-agent',
      paneId: '%42',
      session: 'genie',
      worktree: null,
      startedAt: '2026-03-24T00:00:00Z',
      state: 'suspended',
      lastStateChange: '2026-03-24T00:00:00Z',
      repoPath: cwd,
      ...overrides,
    };
  }

  describe('buildResumeContext', () => {
    test('team-lead with wish state includes group statuses', async () => {
      await wishState.createState(
        'resume-test',
        [{ name: '1' }, { name: '2', dependsOn: ['1'] }, { name: '3', dependsOn: ['1'] }],
        cwd,
      );
      await wishState.startGroup('resume-test', '1', 'engineer', cwd);
      await wishState.completeGroup('resume-test', '1', cwd);

      const agent = makeAgent({
        role: 'team-lead',
        wishSlug: 'resume-test',
        team: 'test-team',
      });

      const context = await buildResumeContext(agent);

      expect(context).toBeDefined();
      expect(context).toContain('You were resumed after a crash');
      expect(context).toContain('Wish: resume-test');
      expect(context).toContain('Group 1: done');
      expect(context).toContain('Group 2: ready');
      expect(context).toContain('Group 3: ready');
      expect(context).toContain('Continue from where you left off');
      expect(context).toContain('genie status resume-test');
    });

    test('team-lead with in_progress group shows started timestamp', async () => {
      await wishState.createState('ts-test', [{ name: '1' }, { name: '2', dependsOn: ['1'] }], cwd);
      await wishState.startGroup('ts-test', '1', 'engineer', cwd);

      const agent = makeAgent({
        role: 'team-lead',
        wishSlug: 'ts-test',
        team: 'test-team',
      });

      const context = await buildResumeContext(agent);

      expect(context).toBeDefined();
      expect(context).toContain('Group 1: in_progress (started at');
      expect(context).toContain('Group 2: blocked (depends on 1)');
    });

    test('team-lead without wish state returns undefined', async () => {
      const agent = makeAgent({
        role: 'team-lead',
        wishSlug: 'nonexistent-wish',
      });

      const context = await buildResumeContext(agent);

      expect(context).toBeUndefined();
    });

    test('non-team-lead with team gets simple message', async () => {
      const agent = makeAgent({
        role: 'engineer',
        team: 'test-team',
      });

      const context = await buildResumeContext(agent);

      expect(context).toBe("You were resumed. Check your team's current state with `genie status`.");
    });

    test('agent without team or wish returns undefined', async () => {
      const agent = makeAgent({
        role: 'engineer',
      });

      const context = await buildResumeContext(agent);

      expect(context).toBeUndefined();
    });

    test('team-lead with wish slug but no state falls back to simple message', async () => {
      const agent = makeAgent({
        role: 'team-lead',
        wishSlug: 'no-such-wish',
        team: 'test-team',
      });

      const context = await buildResumeContext(agent);

      // No wish state found, but has team — falls through to simple message
      expect(context).toBe("You were resumed. Check your team's current state with `genie status`.");
    });
  });
});
