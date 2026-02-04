/**
 * Tests for batch-manager - Batch registry CRUD operations
 * Run with: bun test src/lib/batch-manager.test.ts
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';

import {
  createBatch,
  getBatch,
  listBatches,
  updateBatch,
  deleteBatch,
  checkBatchCompletion,
  type Batch,
  type BatchWorker,
  type BatchOptions,
  type BatchCompletionStatus,
} from './batch-manager.js';

// ============================================================================
// Test Setup
// ============================================================================

const TEST_DIR = '/tmp/batch-manager-test';
const TEST_GENIE_DIR = join(TEST_DIR, '.genie');
const TEST_BATCHES_DIR = join(TEST_GENIE_DIR, 'batches');

function cleanTestDir(): void {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore
  }
  mkdirSync(TEST_GENIE_DIR, { recursive: true });
}

// ============================================================================
// Type checks
// ============================================================================

describe('Batch types', () => {
  test('BatchWorker should accept all valid statuses', () => {
    const statuses: BatchWorker['status'][] = [
      'queued', 'spawning', 'running', 'waiting', 'complete', 'failed', 'cancelled',
    ];
    for (const status of statuses) {
      const worker: BatchWorker = { status };
      expect(worker.status).toBe(status);
    }
  });

  test('BatchWorker should accept optional fields', () => {
    const worker: BatchWorker = {
      paneId: '%85',
      status: 'running',
      startedAt: '2026-02-03T20:00:00Z',
      completedAt: '2026-02-03T21:00:00Z',
    };
    expect(worker.paneId).toBe('%85');
    expect(worker.startedAt).toBeDefined();
    expect(worker.completedAt).toBeDefined();
  });

  test('Batch should accept all valid statuses', () => {
    const statuses: Batch['status'][] = ['active', 'complete', 'cancelled'];
    for (const status of statuses) {
      expect(status).toBeDefined();
    }
  });

  test('BatchOptions should accept optional fields', () => {
    const opts: BatchOptions = {
      skill: 'forge',
      autoApprove: true,
      maxConcurrent: 3,
    };
    expect(opts.skill).toBe('forge');
    expect(opts.autoApprove).toBe(true);
    expect(opts.maxConcurrent).toBe(3);
  });
});

// ============================================================================
// createBatch
// ============================================================================

describe('createBatch', () => {
  beforeEach(cleanTestDir);

  test('should create a batch with sequential ID batch-001', () => {
    const batch = createBatch(TEST_GENIE_DIR, ['wish-21', 'wish-23']);

    expect(batch.id).toBe('batch-001');
    expect(batch.status).toBe('active');
    expect(batch.wishes).toEqual(['wish-21', 'wish-23']);
    expect(batch.createdAt).toBeDefined();
    expect(new Date(batch.createdAt).toISOString()).toBe(batch.createdAt);
  });

  test('should persist batch as JSON file in .genie/batches/', () => {
    const batch = createBatch(TEST_GENIE_DIR, ['wish-21']);

    const filePath = join(TEST_BATCHES_DIR, 'batch-001.json');
    expect(existsSync(filePath)).toBe(true);

    const persisted = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(persisted.id).toBe('batch-001');
    expect(persisted.wishes).toEqual(['wish-21']);
  });

  test('should create batches directory if it does not exist', () => {
    // Ensure batches dir does not exist
    expect(existsSync(TEST_BATCHES_DIR)).toBe(false);

    createBatch(TEST_GENIE_DIR, ['wish-21']);

    expect(existsSync(TEST_BATCHES_DIR)).toBe(true);
  });

  test('should generate sequential IDs', () => {
    const batch1 = createBatch(TEST_GENIE_DIR, ['wish-21']);
    const batch2 = createBatch(TEST_GENIE_DIR, ['wish-23']);
    const batch3 = createBatch(TEST_GENIE_DIR, ['wish-24']);

    expect(batch1.id).toBe('batch-001');
    expect(batch2.id).toBe('batch-002');
    expect(batch3.id).toBe('batch-003');
  });

  test('should initialize workers from wish list with queued status', () => {
    const batch = createBatch(TEST_GENIE_DIR, ['wish-21', 'wish-23']);

    expect(batch.workers['wish-21']).toBeDefined();
    expect(batch.workers['wish-21'].status).toBe('queued');
    expect(batch.workers['wish-23']).toBeDefined();
    expect(batch.workers['wish-23'].status).toBe('queued');
  });

  test('should accept batch options', () => {
    const opts: BatchOptions = { skill: 'forge', autoApprove: true, maxConcurrent: 2 };
    const batch = createBatch(TEST_GENIE_DIR, ['wish-21'], opts);

    expect(batch.options.skill).toBe('forge');
    expect(batch.options.autoApprove).toBe(true);
    expect(batch.options.maxConcurrent).toBe(2);
  });

  test('should default to empty options when none provided', () => {
    const batch = createBatch(TEST_GENIE_DIR, ['wish-21']);

    expect(batch.options).toBeDefined();
  });
});

// ============================================================================
// getBatch
// ============================================================================

describe('getBatch', () => {
  beforeEach(cleanTestDir);

  test('should return batch by ID', () => {
    const created = createBatch(TEST_GENIE_DIR, ['wish-21', 'wish-23']);
    const fetched = getBatch(TEST_GENIE_DIR, 'batch-001');

    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.wishes).toEqual(created.wishes);
  });

  test('should return null for non-existent batch', () => {
    const result = getBatch(TEST_GENIE_DIR, 'batch-999');
    expect(result).toBeNull();
  });

  test('should return null when batches directory does not exist', () => {
    // Use a fresh dir with no batches subdir
    const freshDir = join(TEST_DIR, 'fresh-genie');
    mkdirSync(freshDir, { recursive: true });

    const result = getBatch(freshDir, 'batch-001');
    expect(result).toBeNull();
  });
});

// ============================================================================
// listBatches
// ============================================================================

describe('listBatches', () => {
  beforeEach(cleanTestDir);

  test('should return empty array when no batches exist', () => {
    const batches = listBatches(TEST_GENIE_DIR);
    expect(batches).toEqual([]);
  });

  test('should return all batches', () => {
    createBatch(TEST_GENIE_DIR, ['wish-21']);
    createBatch(TEST_GENIE_DIR, ['wish-23']);
    createBatch(TEST_GENIE_DIR, ['wish-24']);

    const batches = listBatches(TEST_GENIE_DIR);
    expect(batches).toHaveLength(3);
    const ids = batches.map(b => b.id);
    expect(ids).toContain('batch-001');
    expect(ids).toContain('batch-002');
    expect(ids).toContain('batch-003');
  });

  test('should return empty array when batches directory does not exist', () => {
    const freshDir = join(TEST_DIR, 'fresh-genie2');
    mkdirSync(freshDir, { recursive: true });

    const batches = listBatches(freshDir);
    expect(batches).toEqual([]);
  });
});

// ============================================================================
// updateBatch
// ============================================================================

describe('updateBatch', () => {
  beforeEach(cleanTestDir);

  test('should update batch status', () => {
    createBatch(TEST_GENIE_DIR, ['wish-21']);
    const updated = updateBatch(TEST_GENIE_DIR, 'batch-001', { status: 'complete' });

    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('complete');

    // Verify persistence
    const fetched = getBatch(TEST_GENIE_DIR, 'batch-001');
    expect(fetched!.status).toBe('complete');
  });

  test('should update worker status within a batch', () => {
    createBatch(TEST_GENIE_DIR, ['wish-21', 'wish-23']);

    const updated = updateBatch(TEST_GENIE_DIR, 'batch-001', {
      workers: {
        'wish-21': { status: 'running', paneId: '%85', startedAt: '2026-02-03T20:00:00Z' },
        'wish-23': { status: 'queued' },
      },
    });

    expect(updated!.workers['wish-21'].status).toBe('running');
    expect(updated!.workers['wish-21'].paneId).toBe('%85');
  });

  test('should return null for non-existent batch', () => {
    const result = updateBatch(TEST_GENIE_DIR, 'batch-999', { status: 'complete' });
    expect(result).toBeNull();
  });

  test('should persist changes to disk', () => {
    createBatch(TEST_GENIE_DIR, ['wish-21']);
    updateBatch(TEST_GENIE_DIR, 'batch-001', { status: 'cancelled' });

    const filePath = join(TEST_BATCHES_DIR, 'batch-001.json');
    const persisted = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(persisted.status).toBe('cancelled');
  });
});

// ============================================================================
// deleteBatch
// ============================================================================

describe('deleteBatch', () => {
  beforeEach(cleanTestDir);

  test('should delete batch file', () => {
    createBatch(TEST_GENIE_DIR, ['wish-21']);
    const filePath = join(TEST_BATCHES_DIR, 'batch-001.json');
    expect(existsSync(filePath)).toBe(true);

    const deleted = deleteBatch(TEST_GENIE_DIR, 'batch-001');
    expect(deleted).toBe(true);
    expect(existsSync(filePath)).toBe(false);
  });

  test('should return false for non-existent batch', () => {
    const result = deleteBatch(TEST_GENIE_DIR, 'batch-999');
    expect(result).toBe(false);
  });

  test('getBatch should return null after deletion', () => {
    createBatch(TEST_GENIE_DIR, ['wish-21']);
    deleteBatch(TEST_GENIE_DIR, 'batch-001');

    const result = getBatch(TEST_GENIE_DIR, 'batch-001');
    expect(result).toBeNull();
  });

  test('listBatches should not include deleted batch', () => {
    createBatch(TEST_GENIE_DIR, ['wish-21']);
    createBatch(TEST_GENIE_DIR, ['wish-23']);
    deleteBatch(TEST_GENIE_DIR, 'batch-001');

    const batches = listBatches(TEST_GENIE_DIR);
    expect(batches).toHaveLength(1);
    expect(batches[0].id).toBe('batch-002');
  });
});

// ============================================================================
// Sequential ID generation edge cases
// ============================================================================

describe('Sequential ID generation', () => {
  beforeEach(cleanTestDir);

  test('should continue sequence after deletion', () => {
    createBatch(TEST_GENIE_DIR, ['wish-21']);
    createBatch(TEST_GENIE_DIR, ['wish-23']);
    deleteBatch(TEST_GENIE_DIR, 'batch-002');

    const batch3 = createBatch(TEST_GENIE_DIR, ['wish-24']);
    expect(batch3.id).toBe('batch-003');
  });

  test('should handle gaps in sequence', () => {
    createBatch(TEST_GENIE_DIR, ['wish-21']);
    createBatch(TEST_GENIE_DIR, ['wish-23']);
    createBatch(TEST_GENIE_DIR, ['wish-24']);
    deleteBatch(TEST_GENIE_DIR, 'batch-001');
    deleteBatch(TEST_GENIE_DIR, 'batch-002');

    const batch4 = createBatch(TEST_GENIE_DIR, ['wish-25']);
    expect(batch4.id).toBe('batch-004');
  });
});

// ============================================================================
// checkBatchCompletion
// ============================================================================

describe('checkBatchCompletion', () => {
  beforeEach(cleanTestDir);

  test('should return complete=false when workers are still running', () => {
    const batch = createBatch(TEST_GENIE_DIR, ['wish-21', 'wish-23', 'wish-24']);
    updateBatch(TEST_GENIE_DIR, batch.id, {
      workers: {
        'wish-21': { paneId: '%85', status: 'running', startedAt: '2026-02-03T20:00:00Z' },
        'wish-23': { paneId: '%86', status: 'complete', startedAt: '2026-02-03T20:00:00Z', completedAt: '2026-02-03T20:05:00Z' },
        'wish-24': { paneId: '%87', status: 'queued' },
      },
    });

    const result = checkBatchCompletion(TEST_GENIE_DIR, batch.id);

    expect(result.complete).toBe(false);
    expect(result.summary.total).toBe(3);
    expect(result.summary.running).toBe(1);
    expect(result.summary.complete).toBe(1);
    expect(result.summary.queued).toBe(1);
    expect(result.summary.failed).toBe(0);
    expect(result.summary.waiting).toBe(0);
    expect(result.summary.cancelled).toBe(0);
  });

  test('should return complete=true when all workers are complete', () => {
    const batch = createBatch(TEST_GENIE_DIR, ['wish-21', 'wish-23']);
    updateBatch(TEST_GENIE_DIR, batch.id, {
      workers: {
        'wish-21': { paneId: '%85', status: 'complete', startedAt: '2026-02-03T20:00:00Z', completedAt: '2026-02-03T20:10:00Z' },
        'wish-23': { paneId: '%86', status: 'complete', startedAt: '2026-02-03T20:00:00Z', completedAt: '2026-02-03T20:12:00Z' },
      },
    });

    const result = checkBatchCompletion(TEST_GENIE_DIR, batch.id);

    expect(result.complete).toBe(true);
    expect(result.summary.total).toBe(2);
    expect(result.summary.complete).toBe(2);
    expect(result.summary.running).toBe(0);
    expect(result.summary.queued).toBe(0);
    expect(result.summary.failed).toBe(0);
  });

  test('should return complete=true when all workers are in terminal states (complete/failed/cancelled)', () => {
    const batch = createBatch(TEST_GENIE_DIR, ['wish-21', 'wish-23', 'wish-24']);
    updateBatch(TEST_GENIE_DIR, batch.id, {
      workers: {
        'wish-21': { paneId: '%85', status: 'complete', startedAt: '2026-02-03T20:00:00Z', completedAt: '2026-02-03T20:10:00Z' },
        'wish-23': { paneId: '%86', status: 'failed', startedAt: '2026-02-03T20:00:00Z' },
        'wish-24': { paneId: '%87', status: 'cancelled' },
      },
    });

    const result = checkBatchCompletion(TEST_GENIE_DIR, batch.id);

    expect(result.complete).toBe(true);
    expect(result.summary.total).toBe(3);
    expect(result.summary.complete).toBe(1);
    expect(result.summary.failed).toBe(1);
    expect(result.summary.cancelled).toBe(1);
  });

  test('should update batch status to complete when all workers done', () => {
    const batch = createBatch(TEST_GENIE_DIR, ['wish-21']);
    updateBatch(TEST_GENIE_DIR, batch.id, {
      workers: {
        'wish-21': { paneId: '%85', status: 'complete', startedAt: '2026-02-03T20:00:00Z', completedAt: '2026-02-03T20:10:00Z' },
      },
    });

    const result = checkBatchCompletion(TEST_GENIE_DIR, batch.id);

    expect(result.complete).toBe(true);

    // Verify batch status was updated on disk
    const fetched = getBatch(TEST_GENIE_DIR, batch.id);
    expect(fetched!.status).toBe('complete');
  });

  test('should not update batch status when workers are still active', () => {
    const batch = createBatch(TEST_GENIE_DIR, ['wish-21', 'wish-23']);
    updateBatch(TEST_GENIE_DIR, batch.id, {
      workers: {
        'wish-21': { paneId: '%85', status: 'running', startedAt: '2026-02-03T20:00:00Z' },
        'wish-23': { paneId: '%86', status: 'queued' },
      },
    });

    checkBatchCompletion(TEST_GENIE_DIR, batch.id);

    const fetched = getBatch(TEST_GENIE_DIR, batch.id);
    expect(fetched!.status).toBe('active');
  });

  test('should return complete=false with empty summary for non-existent batch', () => {
    const result = checkBatchCompletion(TEST_GENIE_DIR, 'batch-999');

    expect(result.complete).toBe(false);
    expect(result.summary.total).toBe(0);
    expect(result.summary.running).toBe(0);
    expect(result.summary.complete).toBe(0);
    expect(result.summary.failed).toBe(0);
    expect(result.summary.queued).toBe(0);
    expect(result.summary.waiting).toBe(0);
    expect(result.summary.cancelled).toBe(0);
  });

  test('should count waiting workers correctly', () => {
    const batch = createBatch(TEST_GENIE_DIR, ['wish-21', 'wish-23']);
    updateBatch(TEST_GENIE_DIR, batch.id, {
      workers: {
        'wish-21': { paneId: '%85', status: 'waiting', startedAt: '2026-02-03T20:00:00Z' },
        'wish-23': { paneId: '%86', status: 'running', startedAt: '2026-02-03T20:00:00Z' },
      },
    });

    const result = checkBatchCompletion(TEST_GENIE_DIR, batch.id);

    expect(result.complete).toBe(false);
    expect(result.summary.waiting).toBe(1);
    expect(result.summary.running).toBe(1);
  });

  test('should handle batch with all queued workers as not complete', () => {
    const batch = createBatch(TEST_GENIE_DIR, ['wish-21', 'wish-23']);
    // Workers are initialized as queued by createBatch

    const result = checkBatchCompletion(TEST_GENIE_DIR, batch.id);

    expect(result.complete).toBe(false);
    expect(result.summary.queued).toBe(2);
  });

  test('should handle batch with empty workers as complete', () => {
    const batch = createBatch(TEST_GENIE_DIR, []);

    const result = checkBatchCompletion(TEST_GENIE_DIR, batch.id);

    // An empty batch is considered complete (vacuously true)
    expect(result.complete).toBe(true);
    expect(result.summary.total).toBe(0);
  });

  test('should not update already-complete batch status', () => {
    const batch = createBatch(TEST_GENIE_DIR, ['wish-21']);
    updateBatch(TEST_GENIE_DIR, batch.id, {
      status: 'complete',
      workers: {
        'wish-21': { paneId: '%85', status: 'complete', startedAt: '2026-02-03T20:00:00Z', completedAt: '2026-02-03T20:10:00Z' },
      },
    });

    const result = checkBatchCompletion(TEST_GENIE_DIR, batch.id);

    expect(result.complete).toBe(true);
    const fetched = getBatch(TEST_GENIE_DIR, batch.id);
    expect(fetched!.status).toBe('complete');
  });

  test('should count spawning workers as active (not complete)', () => {
    const batch = createBatch(TEST_GENIE_DIR, ['wish-21']);
    updateBatch(TEST_GENIE_DIR, batch.id, {
      workers: {
        'wish-21': { paneId: '%85', status: 'spawning', startedAt: '2026-02-03T20:00:00Z' },
      },
    });

    const result = checkBatchCompletion(TEST_GENIE_DIR, batch.id);

    expect(result.complete).toBe(false);
    // spawning is counted in running since it's an active state
    expect(result.summary.total).toBe(1);
  });
});

// ============================================================================
// Cleanup
// ============================================================================

afterAll(() => {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore
  }
});
