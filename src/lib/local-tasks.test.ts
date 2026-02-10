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
  isLocalTasksEnabled,
  markDone,
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
