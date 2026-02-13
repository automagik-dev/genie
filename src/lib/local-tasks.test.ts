/**
 * Tests for local-tasks.ts — graceful init and claim guards
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ensureTasksFile,
  createWishTask,
  claimTask,
  getTask,
  listTasks,
  getQueue,
  updateTask,
  isLocalTasksEnabled,
  markDone,
  computePriorityScore,
  type PriorityScores,
} from './local-tasks.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'local-tasks-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ============================================================================
// ensureTasksFile
// ============================================================================

describe('ensureTasksFile', () => {
  it('should create .genie dir and tasks.json when missing', async () => {
    const created = await ensureTasksFile(tempDir);
    expect(created).toBe(true);

    const content = JSON.parse(await readFile(join(tempDir, '.genie', 'tasks.json'), 'utf-8'));
    expect(content.tasks).toEqual({});
    expect(content.order).toEqual([]);
    expect(content.lastUpdated).toBeTruthy();
  });

  it('should return false when tasks.json already exists', async () => {
    // First call creates
    await ensureTasksFile(tempDir);
    // Second call should be idempotent
    const created = await ensureTasksFile(tempDir);
    expect(created).toBe(false);
  });

  it('should throw with clear message on read-only directory', async () => {
    const { chmod } = await import('fs/promises');
    const readOnlyDir = join(tempDir, 'readonly-repo');
    await mkdir(readOnlyDir, { recursive: true });
    // Make directory read-only
    await chmod(readOnlyDir, 0o444);

    try {
      await expect(ensureTasksFile(readOnlyDir)).rejects.toThrow(/read-only|EACCES|EROFS|permission/i);
    } finally {
      // Restore permissions for cleanup
      await chmod(readOnlyDir, 0o755);
    }
  });

  it('should preserve existing tasks.json content', async () => {
    // Create a task first
    await mkdir(join(tempDir, '.genie'), { recursive: true });
    await ensureTasksFile(tempDir);
    await createWishTask(tempDir, 'Test task');

    // Ensure again — should not overwrite
    await ensureTasksFile(tempDir);
    const tasks = await listTasks(tempDir);
    expect(tasks.length).toBe(1);
    expect(tasks[0].title).toBe('Test task');
  });
});

// ============================================================================
// claimTask guards
// ============================================================================

describe('claimTask', () => {
  it('should return false for non-existent task', async () => {
    await ensureTasksFile(tempDir);
    const result = await claimTask(tempDir, 'wish-999');
    expect(result).toBe(false);
  });

  it('should return false when tasks.json does not exist', async () => {
    // No .genie dir at all
    const result = await claimTask(tempDir, 'wish-1');
    expect(result).toBe(false);
  });

  it('should claim a ready task', async () => {
    await ensureTasksFile(tempDir);
    const task = await createWishTask(tempDir, 'Claimable task');
    expect(task.status).toBe('ready');

    const claimed = await claimTask(tempDir, task.id);
    expect(claimed).toBe(true);

    const updated = await getTask(tempDir, task.id);
    expect(updated?.status).toBe('in_progress');
  });

  it('should return false when task is already in_progress', async () => {
    await ensureTasksFile(tempDir);
    const task = await createWishTask(tempDir, 'Already claimed');

    // Claim it
    await claimTask(tempDir, task.id);

    // Try to claim again
    const result = await claimTask(tempDir, task.id);
    expect(result).toBe(false);
  });

  it('should return false when task is done', async () => {
    await ensureTasksFile(tempDir);
    const task = await createWishTask(tempDir, 'Done task');

    // Manually set to done
    await markDone(tempDir, task.id);

    const result = await claimTask(tempDir, task.id);
    expect(result).toBe(false);
  });
});

// ============================================================================
// isLocalTasksEnabled
// ============================================================================

describe('isLocalTasksEnabled', () => {
  it('should return false for dir without .genie', () => {
    expect(isLocalTasksEnabled(tempDir)).toBe(false);
  });

  it('should return true after ensureTasksFile creates .genie', async () => {
    await ensureTasksFile(tempDir);
    expect(isLocalTasksEnabled(tempDir)).toBe(true);
  });
});

// ============================================================================
// computePriorityScore
// ============================================================================

describe('computePriorityScore', () => {
  it('should compute weighted sum correctly', () => {
    const scores: PriorityScores = {
      blocking: 5,
      stability: 3,
      crossImpact: 4,
      quickWin: 2,
      complexityInverse: 1,
    };
    // 5*0.30 + 3*0.25 + 4*0.20 + 2*0.15 + 1*0.10 = 1.50 + 0.75 + 0.80 + 0.30 + 0.10 = 3.45
    expect(computePriorityScore(scores)).toBeCloseTo(3.45, 10);
  });

  it('should return 0 for all-zero scores', () => {
    const scores: PriorityScores = {
      blocking: 0,
      stability: 0,
      crossImpact: 0,
      quickWin: 0,
      complexityInverse: 0,
    };
    expect(computePriorityScore(scores)).toBe(0);
  });

  it('should return 5 for all-max scores', () => {
    const scores: PriorityScores = {
      blocking: 5,
      stability: 5,
      crossImpact: 5,
      quickWin: 5,
      complexityInverse: 5,
    };
    // 5*(0.30+0.25+0.20+0.15+0.10) = 5*1.00 = 5.00
    expect(computePriorityScore(scores)).toBeCloseTo(5.0, 10);
  });
});

// ============================================================================
// getQueue — priority sorting
// ============================================================================

describe('getQueue priority sorting', () => {
  it('should return tasks sorted by priority score (highest first)', async () => {
    await ensureTasksFile(tempDir);

    // Create 3 tasks — will be in creation order: wish-1, wish-2, wish-3
    const low = await createWishTask(tempDir, 'Low priority');
    const high = await createWishTask(tempDir, 'High priority');
    const mid = await createWishTask(tempDir, 'Mid priority');

    // Assign scores: high > mid > low
    await updateTask(tempDir, high.id, {});
    await updateTask(tempDir, mid.id, {});
    await updateTask(tempDir, low.id, {});

    // We need to write priorityScores directly — updateTask doesn't support it yet,
    // so we'll manipulate the tasks file
    const tasksPath = join(tempDir, '.genie', 'tasks.json');
    const file = JSON.parse(await readFile(tasksPath, 'utf-8'));

    file.tasks[high.id].priorityScores = {
      blocking: 5, stability: 5, crossImpact: 5, quickWin: 5, complexityInverse: 5,
    }; // score = 5.0

    file.tasks[mid.id].priorityScores = {
      blocking: 3, stability: 3, crossImpact: 3, quickWin: 3, complexityInverse: 3,
    }; // score = 3.0

    file.tasks[low.id].priorityScores = {
      blocking: 1, stability: 1, crossImpact: 1, quickWin: 1, complexityInverse: 1,
    }; // score = 1.0

    await writeFile(tasksPath, JSON.stringify(file, null, 2));

    const queue = await getQueue(tempDir);
    expect(queue.ready).toEqual([high.id, mid.id, low.id]);
  });

  it('should place tasks without scores after tasks with scores', async () => {
    await ensureTasksFile(tempDir);

    const noScore = await createWishTask(tempDir, 'No score');
    const withScore = await createWishTask(tempDir, 'With score');

    // Set score on second task only
    const tasksPath = join(tempDir, '.genie', 'tasks.json');
    const file = JSON.parse(await readFile(tasksPath, 'utf-8'));

    file.tasks[withScore.id].priorityScores = {
      blocking: 2, stability: 2, crossImpact: 2, quickWin: 2, complexityInverse: 2,
    }; // score = 2.0, which is > -1 (no score)

    await writeFile(tasksPath, JSON.stringify(file, null, 2));

    const queue = await getQueue(tempDir);
    expect(queue.ready[0]).toBe(withScore.id);
    expect(queue.ready[1]).toBe(noScore.id);
  });

  it('should still include blocked tasks in the blocked array', async () => {
    await ensureTasksFile(tempDir);

    const parent = await createWishTask(tempDir, 'Parent');
    const child = await createWishTask(tempDir, 'Child', { parent: parent.id });

    const queue = await getQueue(tempDir);
    expect(queue.ready).toContain(parent.id);
    expect(queue.blocked.length).toBe(1);
    expect(queue.blocked[0]).toContain(child.id);
  });
});

// ============================================================================
// listTasks — priority sorting
// ============================================================================

describe('listTasks priority sorting', () => {
  it('should return tasks sorted by priority score (highest first)', async () => {
    await ensureTasksFile(tempDir);

    const a = await createWishTask(tempDir, 'Task A');
    const b = await createWishTask(tempDir, 'Task B');
    const c = await createWishTask(tempDir, 'Task C');

    // Assign scores: B(high) > C(mid) > A(low)
    const tasksPath = join(tempDir, '.genie', 'tasks.json');
    const file = JSON.parse(await readFile(tasksPath, 'utf-8'));

    file.tasks[a.id].priorityScores = {
      blocking: 1, stability: 1, crossImpact: 1, quickWin: 1, complexityInverse: 1,
    }; // score = 1.0

    file.tasks[b.id].priorityScores = {
      blocking: 5, stability: 5, crossImpact: 5, quickWin: 5, complexityInverse: 5,
    }; // score = 5.0

    file.tasks[c.id].priorityScores = {
      blocking: 3, stability: 3, crossImpact: 3, quickWin: 3, complexityInverse: 3,
    }; // score = 3.0

    await writeFile(tasksPath, JSON.stringify(file, null, 2));

    const tasks = await listTasks(tempDir);
    expect(tasks[0].id).toBe(b.id);
    expect(tasks[1].id).toBe(c.id);
    expect(tasks[2].id).toBe(a.id);
  });

  it('should put unscored tasks after scored tasks', async () => {
    await ensureTasksFile(tempDir);

    const unscored = await createWishTask(tempDir, 'Unscored');
    const scored = await createWishTask(tempDir, 'Scored');

    const tasksPath = join(tempDir, '.genie', 'tasks.json');
    const file = JSON.parse(await readFile(tasksPath, 'utf-8'));

    file.tasks[scored.id].priorityScores = {
      blocking: 1, stability: 1, crossImpact: 1, quickWin: 1, complexityInverse: 1,
    };

    await writeFile(tasksPath, JSON.stringify(file, null, 2));

    const tasks = await listTasks(tempDir);
    expect(tasks[0].id).toBe(scored.id);
    expect(tasks[1].id).toBe(unscored.id);
  });
});
