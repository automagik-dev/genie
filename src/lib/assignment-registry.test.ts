/**
 * Assignment Registry — Comprehensive Tests
 *
 * Covers: CRUD, lifecycle outcomes, active assignment tracking,
 * task history, executor assignments, and edge cases.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { findOrCreateAgent } from './agent-registry.js';
import {
  completeAssignment,
  createAssignment,
  getActiveAssignment,
  getAssignment,
  getExecutorAssignments,
  getTaskHistory,
} from './assignment-registry.js';
import { getConnection } from './db.js';
import { createExecutor } from './executor-registry.js';
import type { AssignmentOutcome } from './executor-types.js';
import { DB_AVAILABLE, setupTestDatabase } from './test-db.js';

describe.skipIf(!DB_AVAILABLE)('assignment-registry', () => {
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
  });

  /** Helper: create agent + executor, return executor ID. */
  async function seedExecutor(name = 'eng', team = 'test') {
    const agent = await findOrCreateAgent(name, team, 'engineer');
    const exec = await createExecutor(agent.id, 'claude', 'tmux');
    return exec.id;
  }

  // ==========================================================================
  // CRUD
  // ==========================================================================

  describe('createAssignment', () => {
    test('creates with all fields', async () => {
      const execId = await seedExecutor();
      const a = await createAssignment(execId, 'task-101', 'my-wish', 3);

      expect(a.id).toBeTruthy();
      expect(a.executorId).toBe(execId);
      expect(a.taskId).toBe('task-101');
      expect(a.wishSlug).toBe('my-wish');
      expect(a.groupNumber).toBe(3);
      expect(a.startedAt).toBeTruthy();
      expect(a.endedAt).toBeNull();
      expect(a.outcome).toBeNull();
    });

    test('creates with null taskId', async () => {
      const execId = await seedExecutor();
      const a = await createAssignment(execId, null);

      expect(a.taskId).toBeNull();
      expect(a.wishSlug).toBeNull();
      expect(a.groupNumber).toBeNull();
    });

    test('creates with optional fields as null', async () => {
      const execId = await seedExecutor();
      const a = await createAssignment(execId, 'task-1', null, null);

      expect(a.taskId).toBe('task-1');
      expect(a.wishSlug).toBeNull();
      expect(a.groupNumber).toBeNull();
    });

    test('generates unique IDs', async () => {
      const execId = await seedExecutor();
      const a1 = await createAssignment(execId, 'task-1');
      const a2 = await createAssignment(execId, 'task-2');
      expect(a1.id).not.toBe(a2.id);
    });
  });

  describe('getAssignment', () => {
    test('returns assignment by ID', async () => {
      const execId = await seedExecutor();
      const created = await createAssignment(execId, 'task-1', 'wish-1', 5);
      const fetched = await getAssignment(created.id);

      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.taskId).toBe('task-1');
      expect(fetched!.wishSlug).toBe('wish-1');
      expect(fetched!.groupNumber).toBe(5);
    });

    test('returns null for nonexistent ID', async () => {
      expect(await getAssignment('nonexistent')).toBeNull();
    });
  });

  // ==========================================================================
  // Completion + Outcomes
  // ==========================================================================

  describe('completeAssignment', () => {
    test('sets ended_at and outcome', async () => {
      const execId = await seedExecutor();
      const a = await createAssignment(execId, 'task-1');

      await completeAssignment(a.id, 'completed');
      const completed = (await getAssignment(a.id))!;
      expect(completed.outcome).toBe('completed');
      expect(completed.endedAt).not.toBeNull();
    });

    test('supports all outcome types', async () => {
      const outcomes: AssignmentOutcome[] = ['completed', 'failed', 'reassigned', 'abandoned'];

      for (const outcome of outcomes) {
        const execId = await seedExecutor(`eng-${outcome}`, `team-${outcome}`);
        const a = await createAssignment(execId, `task-${outcome}`);
        await completeAssignment(a.id, outcome);

        const fetched = (await getAssignment(a.id))!;
        expect(fetched.outcome).toBe(outcome);
        expect(fetched.endedAt).not.toBeNull();
      }
    });

    test('completion timestamps are after start timestamps', async () => {
      const execId = await seedExecutor();
      const a = await createAssignment(execId, 'task-1');
      await completeAssignment(a.id, 'completed');

      const fetched = (await getAssignment(a.id))!;
      expect(new Date(fetched.endedAt!).getTime()).toBeGreaterThanOrEqual(new Date(fetched.startedAt).getTime());
    });
  });

  // ==========================================================================
  // Active Assignment Tracking
  // ==========================================================================

  describe('getActiveAssignment', () => {
    test('returns active (not ended) assignment', async () => {
      const execId = await seedExecutor();
      const a = await createAssignment(execId, 'task-1');

      const active = await getActiveAssignment(execId);
      expect(active).not.toBeNull();
      expect(active!.id).toBe(a.id);
    });

    test('returns null when no assignments', async () => {
      const execId = await seedExecutor();
      expect(await getActiveAssignment(execId)).toBeNull();
    });

    test('returns null when all assignments completed', async () => {
      const execId = await seedExecutor();
      const a = await createAssignment(execId, 'task-1');
      await completeAssignment(a.id, 'completed');

      expect(await getActiveAssignment(execId)).toBeNull();
    });

    test('returns latest active when multiple exist', async () => {
      const execId = await seedExecutor();
      await createAssignment(execId, 'task-1');
      // Small delay to ensure ordering
      await new Promise((r) => setTimeout(r, 10));
      const a2 = await createAssignment(execId, 'task-2');

      const active = await getActiveAssignment(execId);
      expect(active!.id).toBe(a2.id);
    });

    test('transitions correctly: active → complete → new active', async () => {
      const execId = await seedExecutor();

      // First assignment active
      const a1 = await createAssignment(execId, 'task-1');
      expect((await getActiveAssignment(execId))!.id).toBe(a1.id);

      // Complete first
      await completeAssignment(a1.id, 'completed');
      expect(await getActiveAssignment(execId)).toBeNull();

      // New assignment active
      const a2 = await createAssignment(execId, 'task-2');
      expect((await getActiveAssignment(execId))!.id).toBe(a2.id);
    });
  });

  // ==========================================================================
  // Task History
  // ==========================================================================

  describe('getTaskHistory', () => {
    test('returns all executors that worked a task', async () => {
      const exec1 = await seedExecutor('eng1', 'team1');
      const exec2 = await seedExecutor('eng2', 'team1');

      await createAssignment(exec1, 'task-shared');
      await createAssignment(exec2, 'task-shared');

      const history = await getTaskHistory('task-shared');
      expect(history.length).toBe(2);
      expect(history.map((a) => a.executorId).sort()).toEqual([exec1, exec2].sort());
    });

    test('returns empty for task with no assignments', async () => {
      expect(await getTaskHistory('task-nonexistent')).toEqual([]);
    });

    test('returns in ascending started_at order', async () => {
      const exec1 = await seedExecutor('eng1', 'team1');
      const exec2 = await seedExecutor('eng2', 'team1');

      const a1 = await createAssignment(exec1, 'task-ordered');
      await new Promise((r) => setTimeout(r, 10));
      const a2 = await createAssignment(exec2, 'task-ordered');

      const history = await getTaskHistory('task-ordered');
      expect(history[0].id).toBe(a1.id);
      expect(history[1].id).toBe(a2.id);
    });

    test('includes completed and active assignments', async () => {
      const exec1 = await seedExecutor('eng1', 'team1');
      const exec2 = await seedExecutor('eng2', 'team1');

      const a1 = await createAssignment(exec1, 'task-mix');
      await completeAssignment(a1.id, 'failed');
      await createAssignment(exec2, 'task-mix'); // Still active

      const history = await getTaskHistory('task-mix');
      expect(history.length).toBe(2);
      expect(history[0].outcome).toBe('failed');
      expect(history[1].outcome).toBeNull();
    });
  });

  // ==========================================================================
  // Executor Assignments
  // ==========================================================================

  describe('getExecutorAssignments', () => {
    test('returns all assignments for an executor', async () => {
      const execId = await seedExecutor();
      await createAssignment(execId, 'task-1');
      await createAssignment(execId, 'task-2');
      await createAssignment(execId, 'task-3');

      const assignments = await getExecutorAssignments(execId);
      expect(assignments.length).toBe(3);
    });

    test('returns empty for executor with no assignments', async () => {
      const execId = await seedExecutor();
      expect(await getExecutorAssignments(execId)).toEqual([]);
    });

    test('returns in ascending started_at order', async () => {
      const execId = await seedExecutor();
      const a1 = await createAssignment(execId, 'task-1');
      await new Promise((r) => setTimeout(r, 10));
      const a2 = await createAssignment(execId, 'task-2');

      const assignments = await getExecutorAssignments(execId);
      expect(assignments[0].id).toBe(a1.id);
      expect(assignments[1].id).toBe(a2.id);
    });
  });

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe('edge cases', () => {
    test('reassignment flow: executor1 fails, executor2 picks up', async () => {
      const exec1 = await seedExecutor('eng1', 'team1');
      const exec2 = await seedExecutor('eng2', 'team1');

      // Executor 1 starts and fails
      const a1 = await createAssignment(exec1, 'task-important', 'wish-1', 1);
      await completeAssignment(a1.id, 'failed');

      // Executor 2 picks up
      const a2 = await createAssignment(exec2, 'task-important', 'wish-1', 1);
      await completeAssignment(a2.id, 'completed');

      // Task history shows both
      const history = await getTaskHistory('task-important');
      expect(history.length).toBe(2);
      expect(history[0].outcome).toBe('failed');
      expect(history[1].outcome).toBe('completed');
    });

    test('sequential task work by single executor', async () => {
      const execId = await seedExecutor();

      const a1 = await createAssignment(execId, 'task-1', 'wish-1', 1);
      await completeAssignment(a1.id, 'completed');

      const a2 = await createAssignment(execId, 'task-2', 'wish-1', 2);
      await completeAssignment(a2.id, 'completed');

      await createAssignment(execId, 'task-3', 'wish-1', 3);
      // Still active

      const assignments = await getExecutorAssignments(execId);
      expect(assignments.length).toBe(3);
      expect(assignments[0].outcome).toBe('completed');
      expect(assignments[1].outcome).toBe('completed');
      expect(assignments[2].outcome).toBeNull();
    });

    test('assignment with null task_id (unlinked work)', async () => {
      const execId = await seedExecutor();
      const a = await createAssignment(execId, null, 'wish-1');

      expect(a.taskId).toBeNull();
      expect(a.wishSlug).toBe('wish-1');

      // getTaskHistory with null taskId should not crash
      // (no assignments with null task_id will match a real task search)
      const history = await getTaskHistory('nonexistent-task');
      expect(history).toEqual([]);
    });

    test('abandoned assignment flow', async () => {
      const execId = await seedExecutor();
      const a = await createAssignment(execId, 'task-1');

      await completeAssignment(a.id, 'abandoned');
      const abandoned = (await getAssignment(a.id))!;
      expect(abandoned.outcome).toBe('abandoned');
      expect(abandoned.endedAt).not.toBeNull();
    });

    test('cascade: deleting executor removes its assignments', async () => {
      const agent = await findOrCreateAgent('temp', 'temp-team');
      const exec = await createExecutor(agent.id, 'claude', 'tmux');
      const a = await createAssignment(exec.id, 'task-1');

      const sql = await getConnection();
      await sql`DELETE FROM executors WHERE id = ${exec.id}`;

      expect(await getAssignment(a.id)).toBeNull();
    });
  });
});
