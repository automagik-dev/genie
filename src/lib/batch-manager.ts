/**
 * Batch Manager - Registry CRUD for parallel spawn batches
 *
 * Manages batch state persistence in .genie/batches/<batch-id>.json.
 * Uses synchronous file operations for thread-safety (writeFileSync for atomic writes).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
} from 'fs';
import { join } from 'path';

// ============================================================================
// Types
// ============================================================================

export interface BatchWorker {
  paneId?: string;
  status: 'queued' | 'spawning' | 'running' | 'waiting' | 'complete' | 'failed' | 'cancelled';
  startedAt?: string;
  completedAt?: string;
}

export interface BatchOptions {
  skill?: string;
  autoApprove?: boolean;
  maxConcurrent?: number;
}

export interface Batch {
  id: string;                              // "batch-001"
  createdAt: string;                       // ISO timestamp
  status: 'active' | 'complete' | 'cancelled';
  wishes: string[];                        // ["wish-21", "wish-23"]
  workers: Record<string, BatchWorker>;    // keyed by wish-id
  options: BatchOptions;
}

export interface BatchCompletionSummary {
  total: number;
  running: number;
  complete: number;
  failed: number;
  queued: number;
  waiting: number;
  cancelled: number;
}

export interface BatchCompletionStatus {
  complete: boolean;
  summary: BatchCompletionSummary;
}

// ============================================================================
// Constants
// ============================================================================

const BATCHES_DIR_NAME = 'batches';

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Get the batches directory path for a given .genie directory.
 */
function getBatchesDir(genieDir: string): string {
  return join(genieDir, BATCHES_DIR_NAME);
}

/**
 * Get the file path for a specific batch.
 */
function getBatchFilePath(genieDir: string, batchId: string): string {
  return join(getBatchesDir(genieDir), `${batchId}.json`);
}

/**
 * Ensure the batches directory exists.
 */
function ensureBatchesDir(genieDir: string): void {
  const dir = getBatchesDir(genieDir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Path to the counter file that tracks the last assigned batch number.
 * This ensures IDs are never reused even after deletion.
 */
function getCounterFilePath(genieDir: string): string {
  return join(getBatchesDir(genieDir), '.counter');
}

/**
 * Read the current counter value. Falls back to scanning existing files
 * if no counter file exists (first run or migration).
 */
function readCounter(genieDir: string): number {
  const counterPath = getCounterFilePath(genieDir);

  // Try reading the persisted counter
  if (existsSync(counterPath)) {
    try {
      const value = parseInt(readFileSync(counterPath, 'utf-8').trim(), 10);
      if (!isNaN(value)) {
        return value;
      }
    } catch {
      // Fall through to file scan
    }
  }

  // Fallback: scan existing batch files to find the highest number
  const batchesDir = getBatchesDir(genieDir);
  let maxNumber = 0;

  if (existsSync(batchesDir)) {
    const files = readdirSync(batchesDir);
    for (const file of files) {
      const match = file.match(/^batch-(\d+)\.json$/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxNumber) {
          maxNumber = num;
        }
      }
    }
  }

  return maxNumber;
}

/**
 * Write the counter value to disk.
 */
function writeCounter(genieDir: string, value: number): void {
  ensureBatchesDir(genieDir);
  writeFileSync(getCounterFilePath(genieDir), String(value), 'utf-8');
}

/**
 * Generate the next sequential batch ID.
 * Uses a persisted counter to ensure IDs are never reused after deletion.
 */
function generateNextBatchId(genieDir: string): string {
  const current = readCounter(genieDir);
  const nextNumber = current + 1;
  writeCounter(genieDir, nextNumber);
  return `batch-${String(nextNumber).padStart(3, '0')}`;
}

/**
 * Persist a batch to disk as JSON using writeFileSync for atomic writes.
 */
function saveBatch(genieDir: string, batch: Batch): void {
  ensureBatchesDir(genieDir);
  const filePath = getBatchFilePath(genieDir, batch.id);
  writeFileSync(filePath, JSON.stringify(batch, null, 2), 'utf-8');
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Create a new batch with the given wish IDs and options.
 * Generates a sequential batch ID, initializes workers as 'queued', and persists to disk.
 */
export function createBatch(
  genieDir: string,
  wishes: string[],
  options: BatchOptions = {},
): Batch {
  const id = generateNextBatchId(genieDir);

  const workers: Record<string, BatchWorker> = {};
  for (const wishId of wishes) {
    workers[wishId] = { status: 'queued' };
  }

  const batch: Batch = {
    id,
    createdAt: new Date().toISOString(),
    status: 'active',
    wishes,
    workers,
    options,
  };

  saveBatch(genieDir, batch);
  return batch;
}

/**
 * Get a batch by its ID. Returns null if not found.
 */
export function getBatch(genieDir: string, batchId: string): Batch | null {
  const filePath = getBatchFilePath(genieDir, batchId);
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as Batch;
  } catch {
    return null;
  }
}

/**
 * List all batches, sorted by ID.
 */
export function listBatches(genieDir: string): Batch[] {
  const batchesDir = getBatchesDir(genieDir);
  if (!existsSync(batchesDir)) {
    return [];
  }

  const files = readdirSync(batchesDir)
    .filter(f => f.match(/^batch-\d+\.json$/))
    .sort();

  const batches: Batch[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(batchesDir, file), 'utf-8');
      batches.push(JSON.parse(content) as Batch);
    } catch {
      // Skip malformed files
    }
  }

  return batches;
}

/**
 * Update a batch with partial data. Merges the updates into the existing batch.
 * Returns the updated batch, or null if the batch does not exist.
 */
export function updateBatch(
  genieDir: string,
  batchId: string,
  updates: Partial<Omit<Batch, 'id' | 'createdAt'>>,
): Batch | null {
  const batch = getBatch(genieDir, batchId);
  if (!batch) {
    return null;
  }

  // Apply updates
  if (updates.status !== undefined) {
    batch.status = updates.status;
  }
  if (updates.wishes !== undefined) {
    batch.wishes = updates.wishes;
  }
  if (updates.workers !== undefined) {
    batch.workers = updates.workers;
  }
  if (updates.options !== undefined) {
    batch.options = updates.options;
  }

  saveBatch(genieDir, batch);
  return batch;
}

/**
 * Delete a batch by its ID. Returns true if deleted, false if not found.
 */
export function deleteBatch(genieDir: string, batchId: string): boolean {
  const filePath = getBatchFilePath(genieDir, batchId);
  if (!existsSync(filePath)) {
    return false;
  }

  try {
    unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Terminal statuses - workers in these states will not transition further.
 */
const TERMINAL_STATUSES: Set<BatchWorker['status']> = new Set([
  'complete',
  'failed',
  'cancelled',
]);

/**
 * Check whether all workers in a batch have reached a terminal state.
 *
 * Returns a BatchCompletionStatus with:
 *   - complete: true when every worker is in a terminal state (complete/failed/cancelled)
 *   - summary: counts by status category
 *
 * When complete=true and the batch status is still 'active', this function
 * automatically updates the batch status to 'complete' on disk.
 */
export function checkBatchCompletion(
  genieDir: string,
  batchId: string,
): BatchCompletionStatus {
  const emptySummary: BatchCompletionSummary = {
    total: 0,
    running: 0,
    complete: 0,
    failed: 0,
    queued: 0,
    waiting: 0,
    cancelled: 0,
  };

  const batch = getBatch(genieDir, batchId);
  if (!batch) {
    return { complete: false, summary: emptySummary };
  }

  const workers = Object.values(batch.workers);
  const summary: BatchCompletionSummary = {
    total: workers.length,
    running: 0,
    complete: 0,
    failed: 0,
    queued: 0,
    waiting: 0,
    cancelled: 0,
  };

  for (const worker of workers) {
    switch (worker.status) {
      case 'complete':
        summary.complete++;
        break;
      case 'failed':
        summary.failed++;
        break;
      case 'cancelled':
        summary.cancelled++;
        break;
      case 'queued':
        summary.queued++;
        break;
      case 'waiting':
        summary.waiting++;
        break;
      case 'running':
      case 'spawning':
        summary.running++;
        break;
    }
  }

  const allTerminal = workers.every(w => TERMINAL_STATUSES.has(w.status));
  // An empty batch is vacuously complete
  const isComplete = workers.length === 0 || allTerminal;

  // Auto-update batch status when completion is detected
  if (isComplete && batch.status === 'active') {
    updateBatch(genieDir, batchId, { status: 'complete' });
  }

  return { complete: isComplete, summary };
}
