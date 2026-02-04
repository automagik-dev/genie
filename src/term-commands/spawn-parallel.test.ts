/**
 * Tests for spawn-parallel command
 * Run with: bun test src/term-commands/spawn-parallel.test.ts
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { join } from 'path';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'fs';

import {
  resolveWishIds,
  findReadyWishes,
  type SpawnParallelOptions,
  type SpawnParallelResult,
} from './spawn-parallel.js';

import { getBatch, listBatches } from '../lib/batch-manager.js';

// ============================================================================
// Test Setup
// ============================================================================

const TEST_DIR = '/tmp/spawn-parallel-test';
const TEST_GENIE_DIR = join(TEST_DIR, '.genie');
const TEST_WISHES_DIR = join(TEST_GENIE_DIR, 'wishes');

function cleanTestDir(): void {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore
  }
  mkdirSync(TEST_WISHES_DIR, { recursive: true });
}

/**
 * Create a fake wish directory with a wish.md file
 */
function createWish(slug: string, status: string = 'READY'): void {
  const wishDir = join(TEST_WISHES_DIR, slug);
  mkdirSync(wishDir, { recursive: true });
  writeFileSync(
    join(wishDir, 'wish.md'),
    `# Wish: ${slug}\n\n**Status:** ${status}\n**Slug:** \`${slug}\`\n\n## Summary\n\nTest wish.\n`,
    'utf-8'
  );
}

// ============================================================================
// resolveWishIds - Explicit list
// ============================================================================

describe('resolveWishIds', () => {
  beforeEach(cleanTestDir);

  test('should return explicit wish IDs when they exist', () => {
    createWish('wish-21');
    createWish('wish-23');

    const result = resolveWishIds(['wish-21', 'wish-23'], TEST_GENIE_DIR);
    expect(result.resolved).toEqual(['wish-21', 'wish-23']);
    expect(result.notFound).toEqual([]);
  });

  test('should report not-found wish IDs', () => {
    createWish('wish-21');

    const result = resolveWishIds(['wish-21', 'wish-99'], TEST_GENIE_DIR);
    expect(result.resolved).toEqual(['wish-21']);
    expect(result.notFound).toEqual(['wish-99']);
  });

  test('should match glob patterns against wish directories', () => {
    createWish('wish-21');
    createWish('wish-22');
    createWish('wish-23');
    createWish('wish-30');

    const result = resolveWishIds(['wish-2*'], TEST_GENIE_DIR);
    expect(result.resolved.sort()).toEqual(['wish-21', 'wish-22', 'wish-23']);
    expect(result.notFound).toEqual([]);
  });

  test('should handle mixed explicit and glob patterns', () => {
    createWish('wish-21');
    createWish('wish-22');
    createWish('wish-30');

    const result = resolveWishIds(['wish-30', 'wish-2*'], TEST_GENIE_DIR);
    // Should contain all unique matches
    const sorted = result.resolved.sort();
    expect(sorted).toEqual(['wish-21', 'wish-22', 'wish-30']);
  });

  test('should return empty for glob with no matches', () => {
    createWish('wish-21');

    const result = resolveWishIds(['wish-9*'], TEST_GENIE_DIR);
    expect(result.resolved).toEqual([]);
    expect(result.notFound).toEqual(['wish-9*']);
  });

  test('should deduplicate results', () => {
    createWish('wish-21');

    const result = resolveWishIds(['wish-21', 'wish-2*'], TEST_GENIE_DIR);
    expect(result.resolved).toEqual(['wish-21']);
  });
});

// ============================================================================
// findReadyWishes - --all-ready flag
// ============================================================================

describe('findReadyWishes', () => {
  beforeEach(cleanTestDir);

  test('should find wishes with Status: READY', () => {
    createWish('wish-21', 'READY');
    createWish('wish-22', 'IN_PROGRESS');
    createWish('wish-23', 'READY');
    createWish('wish-24', 'DONE');

    const ready = findReadyWishes(TEST_GENIE_DIR);
    expect(ready.sort()).toEqual(['wish-21', 'wish-23']);
  });

  test('should return empty when no wishes are ready', () => {
    createWish('wish-21', 'IN_PROGRESS');
    createWish('wish-22', 'DONE');

    const ready = findReadyWishes(TEST_GENIE_DIR);
    expect(ready).toEqual([]);
  });

  test('should return empty when no wishes exist', () => {
    const ready = findReadyWishes(TEST_GENIE_DIR);
    expect(ready).toEqual([]);
  });

  test('should handle case-insensitive status matching', () => {
    createWish('wish-21', 'ready');
    createWish('wish-22', 'Ready');
    createWish('wish-23', 'READY');

    const ready = findReadyWishes(TEST_GENIE_DIR);
    expect(ready.sort()).toEqual(['wish-21', 'wish-22', 'wish-23']);
  });
});

// ============================================================================
// spawnParallelCommand - Integration (with mocked workCommand)
// ============================================================================

describe('spawnParallelCommand', () => {
  beforeEach(cleanTestDir);

  // We test the orchestration logic by importing the internal function
  // that creates the batch and prepares spawn calls, without actually spawning
  // (workCommand requires tmux which is not available in tests)

  test('should create batch for resolved wishes', async () => {
    createWish('wish-21');
    createWish('wish-23');

    // Use the prepareBatch helper (testable without tmux)
    const { prepareBatch } = await import('./spawn-parallel.js');
    const batch = prepareBatch(
      ['wish-21', 'wish-23'],
      { skill: 'forge' },
      TEST_GENIE_DIR
    );

    expect(batch.id).toMatch(/^batch-\d{3}$/);
    expect(batch.wishes).toEqual(['wish-21', 'wish-23']);
    expect(batch.workers['wish-21'].status).toBe('queued');
    expect(batch.workers['wish-23'].status).toBe('queued');
    expect(batch.options.skill).toBe('forge');

    // Verify it was persisted
    const fetched = getBatch(TEST_GENIE_DIR, batch.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.wishes).toEqual(['wish-21', 'wish-23']);
  });

  test('should record autoApprove option from noAutoApprove flag', async () => {
    createWish('wish-21');

    const { prepareBatch } = await import('./spawn-parallel.js');
    const batch = prepareBatch(
      ['wish-21'],
      { noAutoApprove: true },
      TEST_GENIE_DIR
    );

    expect(batch.options.autoApprove).toBe(false);
  });

  test('should set autoApprove to true by default', async () => {
    createWish('wish-21');

    const { prepareBatch } = await import('./spawn-parallel.js');
    const batch = prepareBatch(
      ['wish-21'],
      {},
      TEST_GENIE_DIR
    );

    expect(batch.options.autoApprove).toBe(true);
  });

  test('should handle --all-ready by resolving ready wishes', () => {
    createWish('wish-21', 'READY');
    createWish('wish-22', 'IN_PROGRESS');
    createWish('wish-23', 'READY');

    const ready = findReadyWishes(TEST_GENIE_DIR);
    expect(ready.sort()).toEqual(['wish-21', 'wish-23']);
  });
});

// ============================================================================
// Concurrency control - --max N and processQueue
// ============================================================================

describe('Concurrency control', () => {
  beforeEach(cleanTestDir);

  test('prepareBatch should record maxConcurrent option', async () => {
    createWish('wish-21');
    createWish('wish-22');
    createWish('wish-23');

    const { prepareBatch } = await import('./spawn-parallel.js');
    const batch = prepareBatch(
      ['wish-21', 'wish-22', 'wish-23'],
      { max: 2 },
      TEST_GENIE_DIR
    );

    expect(batch.options.maxConcurrent).toBe(2);
  });

  test('getWishesToSpawn should return all wishes when no max is set', async () => {
    createWish('wish-21');
    createWish('wish-22');
    createWish('wish-23');

    const { prepareBatch, getWishesToSpawn } = await import('./spawn-parallel.js');
    const batch = prepareBatch(
      ['wish-21', 'wish-22', 'wish-23'],
      {},
      TEST_GENIE_DIR
    );

    const toSpawn = getWishesToSpawn(batch);
    expect(toSpawn).toEqual(['wish-21', 'wish-22', 'wish-23']);
  });

  test('getWishesToSpawn should limit to max when set', async () => {
    createWish('wish-21');
    createWish('wish-22');
    createWish('wish-23');

    const { prepareBatch, getWishesToSpawn } = await import('./spawn-parallel.js');
    const batch = prepareBatch(
      ['wish-21', 'wish-22', 'wish-23'],
      { max: 2 },
      TEST_GENIE_DIR
    );

    const toSpawn = getWishesToSpawn(batch);
    expect(toSpawn).toEqual(['wish-21', 'wish-22']);
  });

  test('getWishesToSpawn should account for already running workers', async () => {
    createWish('wish-21');
    createWish('wish-22');
    createWish('wish-23');

    const { prepareBatch, getWishesToSpawn } = await import('./spawn-parallel.js');
    const { updateBatch } = await import('../lib/batch-manager.js');

    const batch = prepareBatch(
      ['wish-21', 'wish-22', 'wish-23'],
      { max: 2 },
      TEST_GENIE_DIR
    );

    // Simulate wish-21 already running
    updateBatch(TEST_GENIE_DIR, batch.id, {
      workers: {
        ...batch.workers,
        'wish-21': { status: 'running', paneId: '%85' },
      },
    });

    const updatedBatch = getBatch(TEST_GENIE_DIR, batch.id)!;
    const toSpawn = getWishesToSpawn(updatedBatch);

    // With max=2 and 1 running, should only spawn 1 more
    expect(toSpawn).toEqual(['wish-22']);
  });

  test('processQueue should spawn next queued worker when slot available', async () => {
    createWish('wish-21');
    createWish('wish-22');
    createWish('wish-23');

    const { prepareBatch, processQueue } = await import('./spawn-parallel.js');
    const { updateBatch } = await import('../lib/batch-manager.js');

    const batch = prepareBatch(
      ['wish-21', 'wish-22', 'wish-23'],
      { max: 2 },
      TEST_GENIE_DIR
    );

    // Simulate wish-21 complete, wish-22 running, wish-23 queued
    updateBatch(TEST_GENIE_DIR, batch.id, {
      workers: {
        'wish-21': { status: 'complete', completedAt: new Date().toISOString() },
        'wish-22': { status: 'running', paneId: '%86' },
        'wish-23': { status: 'queued' },
      },
    });

    // Track spawn calls
    const spawnedWishes: string[] = [];
    const mockSpawnFn = async (wishId: string) => {
      spawnedWishes.push(wishId);
    };

    const result = await processQueue(TEST_GENIE_DIR, batch.id, mockSpawnFn);

    // With max=2, 1 running, 1 complete -> 1 slot available
    expect(result.spawned).toBe(1);
    expect(spawnedWishes).toEqual(['wish-23']);
  });

  test('processQueue should not spawn when at max capacity', async () => {
    createWish('wish-21');
    createWish('wish-22');
    createWish('wish-23');

    const { prepareBatch, processQueue } = await import('./spawn-parallel.js');
    const { updateBatch } = await import('../lib/batch-manager.js');

    const batch = prepareBatch(
      ['wish-21', 'wish-22', 'wish-23'],
      { max: 2 },
      TEST_GENIE_DIR
    );

    // Simulate wish-21 and wish-22 running, wish-23 queued
    updateBatch(TEST_GENIE_DIR, batch.id, {
      workers: {
        'wish-21': { status: 'running', paneId: '%85' },
        'wish-22': { status: 'running', paneId: '%86' },
        'wish-23': { status: 'queued' },
      },
    });

    const spawnedWishes: string[] = [];
    const mockSpawnFn = async (wishId: string) => {
      spawnedWishes.push(wishId);
    };

    const result = await processQueue(TEST_GENIE_DIR, batch.id, mockSpawnFn);

    // At max capacity, should not spawn
    expect(result.spawned).toBe(0);
    expect(spawnedWishes).toEqual([]);
  });

  test('processQueue should handle batch without maxConcurrent (unlimited)', async () => {
    createWish('wish-21');
    createWish('wish-22');
    createWish('wish-23');

    const { prepareBatch, processQueue } = await import('./spawn-parallel.js');
    const { updateBatch } = await import('../lib/batch-manager.js');

    const batch = prepareBatch(
      ['wish-21', 'wish-22', 'wish-23'],
      {}, // No max set
      TEST_GENIE_DIR
    );

    // Simulate all wishes still queued
    // (no max means all should be spawned initially, but test processQueue behavior)
    updateBatch(TEST_GENIE_DIR, batch.id, {
      workers: {
        'wish-21': { status: 'queued' },
        'wish-22': { status: 'queued' },
        'wish-23': { status: 'queued' },
      },
    });

    const spawnedWishes: string[] = [];
    const mockSpawnFn = async (wishId: string) => {
      spawnedWishes.push(wishId);
    };

    const result = await processQueue(TEST_GENIE_DIR, batch.id, mockSpawnFn);

    // No max means spawn all queued
    expect(result.spawned).toBe(3);
    expect(spawnedWishes).toEqual(['wish-21', 'wish-22', 'wish-23']);
  });

  test('processQueue should return 0 when no queued workers', async () => {
    createWish('wish-21');
    createWish('wish-22');

    const { prepareBatch, processQueue } = await import('./spawn-parallel.js');
    const { updateBatch } = await import('../lib/batch-manager.js');

    const batch = prepareBatch(
      ['wish-21', 'wish-22'],
      { max: 2 },
      TEST_GENIE_DIR
    );

    // All workers complete
    updateBatch(TEST_GENIE_DIR, batch.id, {
      workers: {
        'wish-21': { status: 'complete' },
        'wish-22': { status: 'complete' },
      },
    });

    const spawnedWishes: string[] = [];
    const mockSpawnFn = async (wishId: string) => {
      spawnedWishes.push(wishId);
    };

    const result = await processQueue(TEST_GENIE_DIR, batch.id, mockSpawnFn);

    expect(result.spawned).toBe(0);
    expect(spawnedWishes).toEqual([]);
  });

  test('processQueue should count spawning status as active', async () => {
    createWish('wish-21');
    createWish('wish-22');
    createWish('wish-23');

    const { prepareBatch, processQueue } = await import('./spawn-parallel.js');
    const { updateBatch } = await import('../lib/batch-manager.js');

    const batch = prepareBatch(
      ['wish-21', 'wish-22', 'wish-23'],
      { max: 2 },
      TEST_GENIE_DIR
    );

    // wish-21 spawning (counts as active), wish-22 running, wish-23 queued
    updateBatch(TEST_GENIE_DIR, batch.id, {
      workers: {
        'wish-21': { status: 'spawning' },
        'wish-22': { status: 'running', paneId: '%86' },
        'wish-23': { status: 'queued' },
      },
    });

    const spawnedWishes: string[] = [];
    const mockSpawnFn = async (wishId: string) => {
      spawnedWishes.push(wishId);
    };

    const result = await processQueue(TEST_GENIE_DIR, batch.id, mockSpawnFn);

    // spawning + running = 2, at max capacity
    expect(result.spawned).toBe(0);
    expect(spawnedWishes).toEqual([]);
  });

  test('processQueue should update worker status to spawning then running', async () => {
    createWish('wish-21');

    const { prepareBatch, processQueue } = await import('./spawn-parallel.js');

    const batch = prepareBatch(
      ['wish-21'],
      {},
      TEST_GENIE_DIR
    );

    let statusDuringSpawn: string | undefined;
    const mockSpawnFn = async (wishId: string) => {
      // Capture status during spawn (should be 'spawning')
      const currentBatch = getBatch(TEST_GENIE_DIR, batch.id)!;
      statusDuringSpawn = currentBatch.workers[wishId].status;
    };

    await processQueue(TEST_GENIE_DIR, batch.id, mockSpawnFn);

    // During spawn, status should have been 'spawning'
    expect(statusDuringSpawn).toBe('spawning');

    // After processQueue completes, status should be 'running'
    const finalBatch = getBatch(TEST_GENIE_DIR, batch.id)!;
    expect(finalBatch.workers['wish-21'].status).toBe('running');
  });

  test('processQueue should mark worker as failed when spawnFn throws', async () => {
    createWish('wish-21');
    createWish('wish-22');

    const { prepareBatch, processQueue } = await import('./spawn-parallel.js');

    const batch = prepareBatch(
      ['wish-21', 'wish-22'],
      {},
      TEST_GENIE_DIR
    );

    const mockSpawnFn = async (wishId: string) => {
      if (wishId === 'wish-22') {
        throw new Error('Spawn failed');
      }
    };

    const result = await processQueue(TEST_GENIE_DIR, batch.id, mockSpawnFn);

    expect(result.spawned).toBe(1);
    expect(result.failed).toBe(1);

    const finalBatch = getBatch(TEST_GENIE_DIR, batch.id)!;
    expect(finalBatch.workers['wish-21'].status).toBe('running');
    expect(finalBatch.workers['wish-22'].status).toBe('failed');
  });

  test('processQueue should return zeros for non-existent batch', async () => {
    const { processQueue } = await import('./spawn-parallel.js');

    const mockSpawnFn = async (_wishId: string) => {};

    const result = await processQueue(TEST_GENIE_DIR, 'non-existent-batch', mockSpawnFn);

    expect(result.spawned).toBe(0);
    expect(result.failed).toBe(0);
  });

  test('processQueue should spawn multiple workers when multiple slots available', async () => {
    createWish('wish-21');
    createWish('wish-22');
    createWish('wish-23');
    createWish('wish-24');

    const { prepareBatch, processQueue } = await import('./spawn-parallel.js');
    const { updateBatch } = await import('../lib/batch-manager.js');

    const batch = prepareBatch(
      ['wish-21', 'wish-22', 'wish-23', 'wish-24'],
      { max: 3 },
      TEST_GENIE_DIR
    );

    // wish-21 complete, wish-22/23/24 queued (3 slots available)
    updateBatch(TEST_GENIE_DIR, batch.id, {
      workers: {
        'wish-21': { status: 'complete' },
        'wish-22': { status: 'queued' },
        'wish-23': { status: 'queued' },
        'wish-24': { status: 'queued' },
      },
    });

    const spawnedWishes: string[] = [];
    const mockSpawnFn = async (wishId: string) => {
      spawnedWishes.push(wishId);
    };

    const result = await processQueue(TEST_GENIE_DIR, batch.id, mockSpawnFn);

    // With max=3 and 0 active (complete doesn't count), should spawn 3
    expect(result.spawned).toBe(3);
    expect(spawnedWishes).toEqual(['wish-22', 'wish-23', 'wish-24']);
  });
});

// ============================================================================
// Export validation (for Group E integration)
// ============================================================================

describe('Export validation', () => {
  test('processQueue is exported and callable', async () => {
    const { processQueue } = await import('./spawn-parallel.js');
    expect(typeof processQueue).toBe('function');
  });

  test('getWishesToSpawn is exported and callable', async () => {
    const { getWishesToSpawn } = await import('./spawn-parallel.js');
    expect(typeof getWishesToSpawn).toBe('function');
  });

  test('ProcessQueueResult type is exported', async () => {
    // Type-only import check - we can't test types at runtime,
    // but we can verify the function returns the expected shape
    const { processQueue } = await import('./spawn-parallel.js');

    // Create minimal test env
    cleanTestDir();
    createWish('test-wish');

    const { prepareBatch } = await import('./spawn-parallel.js');
    const batch = prepareBatch(['test-wish'], {}, TEST_GENIE_DIR);

    const result = await processQueue(TEST_GENIE_DIR, batch.id, async () => {});

    // Verify ProcessQueueResult shape
    expect(typeof result.spawned).toBe('number');
    expect(typeof result.failed).toBe('number');
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
