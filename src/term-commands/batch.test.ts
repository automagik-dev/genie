/**
 * Batch status/list/cancel command tests
 *
 * Tests the batch status display, batch listing, and batch cancellation
 * commands that operate on batch-manager data.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Batch } from '../lib/batch-manager.js';

import {
  renderBatchStatus,
  renderBatchList,
  cancelBatch,
} from './batch.js';

// ============================================================================
// Helpers
// ============================================================================

let testDir: string;

function setupTestDir(): string {
  const dir = join(tmpdir(), `batch-cmd-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, 'batches'), { recursive: true });
  return dir;
}

function writeBatch(genieDir: string, batch: Batch): void {
  const filePath = join(genieDir, 'batches', `${batch.id}.json`);
  writeFileSync(filePath, JSON.stringify(batch, null, 2), 'utf-8');
}

function readBatch(genieDir: string, batchId: string): Batch {
  const filePath = join(genieDir, 'batches', `${batchId}.json`);
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

// ============================================================================
// Test Data Factories
// ============================================================================

function makeActiveBatch(overrides: Partial<Batch> = {}): Batch {
  return {
    id: 'batch-001',
    createdAt: '2026-02-03T20:00:00Z',
    status: 'active',
    wishes: ['wish-21', 'wish-23', 'wish-24'],
    workers: {
      'wish-21': { paneId: '%85', status: 'running', startedAt: '2026-02-03T20:00:10Z' },
      'wish-23': { paneId: '%86', status: 'complete', startedAt: '2026-02-03T20:00:10Z', completedAt: '2026-02-03T20:05:00Z' },
      'wish-24': { paneId: '%87', status: 'waiting', startedAt: '2026-02-03T20:00:10Z' },
    },
    options: { skill: 'forge', autoApprove: true },
    ...overrides,
  };
}

function makeCompleteBatch(): Batch {
  return {
    id: 'batch-002',
    createdAt: '2026-02-03T18:00:00Z',
    status: 'complete',
    wishes: ['wish-10', 'wish-11'],
    workers: {
      'wish-10': { paneId: '%70', status: 'complete', startedAt: '2026-02-03T18:00:10Z', completedAt: '2026-02-03T18:10:00Z' },
      'wish-11': { paneId: '%71', status: 'complete', startedAt: '2026-02-03T18:00:10Z', completedAt: '2026-02-03T18:12:00Z' },
    },
    options: {},
  };
}

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
  testDir = setupTestDir();
});

afterEach(() => {
  if (testDir && existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ============================================================================
// renderBatchStatus
// ============================================================================

describe('renderBatchStatus', () => {
  it('shows batch ID and worker count', () => {
    const batch = makeActiveBatch();
    const output = renderBatchStatus(batch);
    expect(output).toContain('batch-001');
    expect(output).toContain('3 workers');
  });

  it('shows each wish-id in the output', () => {
    const batch = makeActiveBatch();
    const output = renderBatchStatus(batch);
    expect(output).toContain('wish-21');
    expect(output).toContain('wish-23');
    expect(output).toContain('wish-24');
  });

  it('shows pane IDs for each worker', () => {
    const batch = makeActiveBatch();
    const output = renderBatchStatus(batch);
    expect(output).toContain('%85');
    expect(output).toContain('%86');
    expect(output).toContain('%87');
  });

  it('shows Running status indicator for running workers', () => {
    const batch = makeActiveBatch();
    const output = renderBatchStatus(batch);
    expect(output).toContain('Running');
  });

  it('shows Complete status indicator for complete workers', () => {
    const batch = makeActiveBatch();
    const output = renderBatchStatus(batch);
    expect(output).toContain('Complete');
  });

  it('shows Waiting status indicator for waiting workers', () => {
    const batch = makeActiveBatch();
    const output = renderBatchStatus(batch);
    expect(output).toContain('Waiting');
  });

  it('shows progress summary line', () => {
    const batch = makeActiveBatch();
    const output = renderBatchStatus(batch);
    // 1/3 complete, 1 running, 1 waiting
    expect(output).toContain('1/3 complete');
    expect(output).toContain('1 running');
    expect(output).toContain('1 waiting');
  });

  it('uses ANSI green for running workers', () => {
    const batch = makeActiveBatch();
    const output = renderBatchStatus(batch);
    // Green ANSI code
    expect(output).toContain('\x1b[32m');
  });

  it('uses ANSI yellow for waiting workers', () => {
    const batch = makeActiveBatch();
    const output = renderBatchStatus(batch);
    // Yellow ANSI code
    expect(output).toContain('\x1b[33m');
  });

  it('handles batch with all complete workers', () => {
    const batch = makeCompleteBatch();
    const output = renderBatchStatus(batch);
    expect(output).toContain('2/2 complete');
  });

  it('handles batch with no workers', () => {
    const batch = makeActiveBatch({ wishes: [], workers: {} });
    const output = renderBatchStatus(batch);
    expect(output).toContain('0 workers');
  });

  it('handles workers without paneId', () => {
    const batch = makeActiveBatch({
      wishes: ['wish-30'],
      workers: {
        'wish-30': { status: 'queued' },
      },
    });
    const output = renderBatchStatus(batch);
    expect(output).toContain('wish-30');
    expect(output).toContain('Queued');
  });

  it('shows cancelled workers with Cancelled status', () => {
    const batch = makeActiveBatch({
      wishes: ['wish-40'],
      workers: {
        'wish-40': { paneId: '%90', status: 'cancelled' },
      },
    });
    const output = renderBatchStatus(batch);
    expect(output).toContain('Cancelled');
  });

  it('shows failed workers with Failed status', () => {
    const batch = makeActiveBatch({
      wishes: ['wish-50'],
      workers: {
        'wish-50': { paneId: '%91', status: 'failed' },
      },
    });
    const output = renderBatchStatus(batch);
    expect(output).toContain('Failed');
  });
});

// ============================================================================
// renderBatchList
// ============================================================================

describe('renderBatchList', () => {
  it('shows all batches', () => {
    const batches = [makeActiveBatch(), makeCompleteBatch()];
    const output = renderBatchList(batches);
    expect(output).toContain('batch-001');
    expect(output).toContain('batch-002');
  });

  it('shows worker count per batch', () => {
    const batches = [makeActiveBatch(), makeCompleteBatch()];
    const output = renderBatchList(batches);
    // batch-001 has 3 workers, batch-002 has 2
    expect(output).toContain('3');
    expect(output).toContain('2');
  });

  it('shows batch status for each batch', () => {
    const batches = [makeActiveBatch(), makeCompleteBatch()];
    const output = renderBatchList(batches);
    expect(output).toContain('active');
    expect(output).toContain('complete');
  });

  it('shows header', () => {
    const batches = [makeActiveBatch()];
    const output = renderBatchList(batches);
    expect(output).toContain('BATCHES');
  });

  it('shows a message when no batches exist', () => {
    const output = renderBatchList([]);
    expect(output.toLowerCase()).toContain('no batches');
  });

  it('shows progress counts per batch', () => {
    const batches = [makeActiveBatch()];
    const output = renderBatchList(batches);
    // batch-001: 1/3 complete, 1 running, 1 waiting
    expect(output).toContain('1/3 complete');
  });
});

// ============================================================================
// cancelBatch
// ============================================================================

describe('cancelBatch', () => {
  it('marks all non-complete workers as cancelled', () => {
    const batch = makeActiveBatch();
    writeBatch(testDir, batch);

    const result = cancelBatch(testDir, 'batch-001');

    expect(result).not.toBeNull();
    expect(result!.workers['wish-21'].status).toBe('cancelled');
    expect(result!.workers['wish-24'].status).toBe('cancelled');
  });

  it('does not change already-complete workers', () => {
    const batch = makeActiveBatch();
    writeBatch(testDir, batch);

    const result = cancelBatch(testDir, 'batch-001');

    expect(result!.workers['wish-23'].status).toBe('complete');
  });

  it('updates batch status to cancelled', () => {
    const batch = makeActiveBatch();
    writeBatch(testDir, batch);

    const result = cancelBatch(testDir, 'batch-001');

    expect(result!.status).toBe('cancelled');
  });

  it('persists the cancellation to disk', () => {
    const batch = makeActiveBatch();
    writeBatch(testDir, batch);

    cancelBatch(testDir, 'batch-001');

    const onDisk = readBatch(testDir, 'batch-001');
    expect(onDisk.status).toBe('cancelled');
    expect(onDisk.workers['wish-21'].status).toBe('cancelled');
    expect(onDisk.workers['wish-23'].status).toBe('complete');
  });

  it('returns null if batch does not exist', () => {
    const result = cancelBatch(testDir, 'batch-999');
    expect(result).toBeNull();
  });

  it('does not change already-failed workers', () => {
    const batch = makeActiveBatch({
      wishes: ['wish-60', 'wish-61'],
      workers: {
        'wish-60': { paneId: '%92', status: 'failed' },
        'wish-61': { paneId: '%93', status: 'running' },
      },
    });
    writeBatch(testDir, batch);

    const result = cancelBatch(testDir, 'batch-001');

    expect(result!.workers['wish-60'].status).toBe('failed');
    expect(result!.workers['wish-61'].status).toBe('cancelled');
  });

  it('does not change already-cancelled workers', () => {
    const batch = makeActiveBatch({
      wishes: ['wish-70'],
      workers: {
        'wish-70': { paneId: '%94', status: 'cancelled' },
      },
    });
    writeBatch(testDir, batch);

    const result = cancelBatch(testDir, 'batch-001');

    expect(result!.workers['wish-70'].status).toBe('cancelled');
    expect(result!.status).toBe('cancelled');
  });
});
