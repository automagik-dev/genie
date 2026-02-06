/**
 * Spawn Parallel - Launch multiple Claude Code workers in parallel
 *
 * Usage:
 *   term spawn-parallel wish-21 wish-23 wish-24    - Spawn specific wishes
 *   term spawn-parallel 'wish-2*'                  - Spawn by glob pattern
 *   term spawn-parallel --all-ready                - Spawn all wishes with Status: READY
 *   term spawn-parallel --all-ready --max 3        - Spawn up to 3 concurrent workers
 *
 * Options:
 *   --all-ready           - Find all wishes with Status: READY in wish.md
 *   --skill <name>        - Skill to invoke (e.g., 'forge')
 *   --no-auto-approve     - Disable auto-approve for workers
 *   --max <n>             - Limit concurrent workers (queue remaining)
 *   -s, --session <name>  - Target tmux session
 *
 * Concurrency Control:
 *   When --max N is specified, only N workers are spawned initially.
 *   Remaining wishes stay with status 'queued' in the batch.
 *   Use processQueue() to spawn next workers when slots become available.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { createBatch, getBatch, updateBatch, type Batch, type BatchOptions } from '../lib/batch-manager.js';
import { getRepoGenieDir } from '../lib/genie-dir.js';

// ============================================================================
// Types
// ============================================================================

export interface SpawnParallelOptions {
  allReady?: boolean;
  skill?: string;
  noAutoApprove?: boolean;
  max?: number;
  session?: string;
}

export interface SpawnParallelResult {
  batchId: string;
  spawned: string[];
  failed: string[];
  skipped: string[];
}

interface ResolveResult {
  resolved: string[];
  notFound: string[];
}

// ============================================================================
// Pattern matching helpers
// ============================================================================

/**
 * Test if a string contains glob characters (* or ?)
 */
function isGlobPattern(input: string): boolean {
  return input.includes('*') || input.includes('?');
}

/**
 * Convert a simple glob pattern to a RegExp.
 * Supports * (any characters) and ? (single character).
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape regex specials except * and ?
    .replace(/\*/g, '.*')                    // * -> .*
    .replace(/\?/g, '.');                    // ? -> .
  return new RegExp(`^${escaped}$`);
}

/**
 * List all wish directory names under .genie/wishes/
 */
function listWishDirs(genieDir: string): string[] {
  const wishesDir = join(genieDir, 'wishes');
  if (!existsSync(wishesDir)) {
    return [];
  }
  try {
    return readdirSync(wishesDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort();
  } catch {
    return [];
  }
}

// ============================================================================
// Public: Resolve wish IDs
// ============================================================================

/**
 * Resolve a list of wish-id arguments (explicit names or glob patterns)
 * into actual wish directory names.
 *
 * For each argument:
 * - If it contains * or ?, treat as glob and match against wish directories
 * - Otherwise, check if a wish directory with that name exists
 *
 * Returns deduplicated resolved IDs and any not-found entries.
 */
export function resolveWishIds(args: string[], genieDir: string): ResolveResult {
  const allWishes = listWishDirs(genieDir);
  const resolvedSet = new Set<string>();
  const notFound: string[] = [];

  for (const arg of args) {
    if (isGlobPattern(arg)) {
      const regex = globToRegExp(arg);
      const matches = allWishes.filter(w => regex.test(w));
      if (matches.length === 0) {
        notFound.push(arg);
      } else {
        for (const match of matches) {
          resolvedSet.add(match);
        }
      }
    } else {
      // Explicit wish ID - check existence
      const wishDir = join(genieDir, 'wishes', arg);
      if (existsSync(wishDir)) {
        resolvedSet.add(arg);
      } else {
        notFound.push(arg);
      }
    }
  }

  return {
    resolved: Array.from(resolvedSet),
    notFound,
  };
}

// ============================================================================
// Public: Find ready wishes
// ============================================================================

/**
 * Scan all wish.md files for Status: READY.
 * Returns wish directory names that have a READY status.
 */
export function findReadyWishes(genieDir: string): string[] {
  const allWishes = listWishDirs(genieDir);
  const ready: string[] = [];

  for (const wishName of allWishes) {
    const wishPath = join(genieDir, 'wishes', wishName, 'wish.md');
    if (!existsSync(wishPath)) {
      continue;
    }

    try {
      const content = readFileSync(wishPath, 'utf-8');
      // Look for **Status:** READY (case insensitive)
      const statusMatch = content.match(/^\*\*Status:\*\*\s*(.+)$/im);
      if (statusMatch) {
        const status = statusMatch[1].trim().toUpperCase();
        if (status === 'READY') {
          ready.push(wishName);
        }
      }
    } catch {
      // Skip files we can't read
    }
  }

  return ready;
}

// ============================================================================
// Public: Prepare batch (testable without tmux)
// ============================================================================

/**
 * Create a batch in the registry for the given wish IDs.
 * This is the pure-data part of spawn-parallel, separated for testability.
 */
export function prepareBatch(
  wishIds: string[],
  options: SpawnParallelOptions,
  genieDir: string,
): Batch {
  const batchOptions: BatchOptions = {
    skill: options.skill,
    autoApprove: options.noAutoApprove ? false : true,
    maxConcurrent: options.max,
  };

  return createBatch(genieDir, wishIds, batchOptions);
}

// ============================================================================
// Public: Concurrency control helpers
// ============================================================================

/**
 * Count workers in active states (spawning or running).
 * These count against the maxConcurrent limit.
 */
function countActiveWorkers(batch: Batch): number {
  let count = 0;
  for (const worker of Object.values(batch.workers)) {
    if (worker.status === 'spawning' || worker.status === 'running') {
      count++;
    }
  }
  return count;
}

/**
 * Get the list of queued wish IDs from a batch.
 */
function getQueuedWishes(batch: Batch): string[] {
  const queued: string[] = [];
  for (const wishId of batch.wishes) {
    if (batch.workers[wishId]?.status === 'queued') {
      queued.push(wishId);
    }
  }
  return queued;
}

/**
 * Determine which wishes should be spawned based on batch state and maxConcurrent.
 *
 * Without maxConcurrent: returns all queued wishes
 * With maxConcurrent: returns up to (max - active) queued wishes
 */
export function getWishesToSpawn(batch: Batch): string[] {
  const queued = getQueuedWishes(batch);
  const max = batch.options.maxConcurrent;

  // No limit - spawn all queued
  if (!max) {
    return queued;
  }

  const active = countActiveWorkers(batch);
  const availableSlots = Math.max(0, max - active);

  return queued.slice(0, availableSlots);
}

/**
 * Result from processQueue operation
 */
export interface ProcessQueueResult {
  spawned: number;
  failed: number;
}

/**
 * Process the queue for a batch, spawning workers as slots become available.
 *
 * This is called when a worker completes to potentially spawn the next queued worker.
 * The spawnFn is called for each wish that should be spawned.
 *
 * @param genieDir - Path to .genie directory
 * @param batchId - Batch to process
 * @param spawnFn - Function to spawn a worker for a wish ID
 * @returns Number of workers spawned and failed
 */
export async function processQueue(
  genieDir: string,
  batchId: string,
  spawnFn: (wishId: string) => Promise<void>,
): Promise<ProcessQueueResult> {
  const batch = getBatch(genieDir, batchId);
  if (!batch) {
    return { spawned: 0, failed: 0 };
  }

  const toSpawn = getWishesToSpawn(batch);

  let spawned = 0;
  let failed = 0;

  for (const wishId of toSpawn) {
    try {
      // Re-read batch from disk each iteration to get latest worker state
      const currentBatch = getBatch(genieDir, batchId);
      if (!currentBatch) break;

      // Update status to spawning before calling spawnFn
      const workers = { ...currentBatch.workers };
      workers[wishId] = {
        ...workers[wishId],
        status: 'spawning',
        startedAt: new Date().toISOString(),
      };
      updateBatch(genieDir, batchId, { workers });

      await spawnFn(wishId);

      // Re-read after spawn to avoid overwriting concurrent changes
      const afterSpawn = getBatch(genieDir, batchId);
      if (!afterSpawn) break;

      // Update status to running after successful spawn
      const updatedWorkers = { ...afterSpawn.workers };
      updatedWorkers[wishId] = {
        ...updatedWorkers[wishId],
        status: 'running',
      };
      updateBatch(genieDir, batchId, { workers: updatedWorkers });

      spawned++;
    } catch {
      // Re-read batch from disk for latest state
      const currentBatch = getBatch(genieDir, batchId);
      if (!currentBatch) break;

      // Update status to failed
      const workers = { ...currentBatch.workers };
      workers[wishId] = {
        ...workers[wishId],
        status: 'failed',
        completedAt: new Date().toISOString(),
      };
      updateBatch(genieDir, batchId, { workers });

      failed++;
    }
  }

  return { spawned, failed };
}

// ============================================================================
// Main command
// ============================================================================

/**
 * Spawn multiple workers in parallel.
 *
 * 1. Resolve wish IDs (explicit, glob, or --all-ready)
 * 2. Validate all wishes exist
 * 3. Create a batch in the registry
 * 4. Spawn each wish as a worker via workCommand
 * 5. Update batch with worker pane info
 * 6. Report results
 */
export async function spawnParallelCommand(
  wishIds: string[],
  options: SpawnParallelOptions = {},
): Promise<SpawnParallelResult> {
  const repoPath = process.cwd();
  const genieDir = getRepoGenieDir(repoPath);

  // 1. Resolve wish IDs
  let resolvedIds: string[];

  if (options.allReady) {
    resolvedIds = findReadyWishes(genieDir);
    if (resolvedIds.length === 0) {
      console.log('No wishes with Status: READY found.');
      return { batchId: '', spawned: [], failed: [], skipped: [] };
    }
    console.log(`Found ${resolvedIds.length} ready wish(es): ${resolvedIds.join(', ')}`);
  } else if (wishIds.length === 0) {
    console.error('Error: No wish IDs provided. Use wish IDs, glob patterns, or --all-ready.');
    return { batchId: '', spawned: [], failed: [], skipped: [] };
  } else {
    const result = resolveWishIds(wishIds, genieDir);
    resolvedIds = result.resolved;

    if (result.notFound.length > 0) {
      console.warn(`Warning: Not found: ${result.notFound.join(', ')}`);
    }
    if (resolvedIds.length === 0) {
      console.error('Error: No valid wishes to spawn.');
      return { batchId: '', spawned: [], failed: [], skipped: [] };
    }
  }

  // 2. Create batch
  const batch = prepareBatch(resolvedIds, options, genieDir);
  console.log(`Created ${batch.id} with ${resolvedIds.length} wish(es)`);

  // 3. Determine which wishes to spawn now (respects --max)
  const wishesToSpawn = getWishesToSpawn(batch);
  const queued = resolvedIds.filter(id => !wishesToSpawn.includes(id));

  if (queued.length > 0) {
    console.log(`Queued ${queued.length} wish(es) (max ${options.max} concurrent): ${queued.join(', ')}`);
  }

  // 4. Spawn workers
  const { workCommand } = await import('./work.js');
  const spawned: string[] = [];
  const failed: string[] = [];

  for (const wishId of wishesToSpawn) {
    try {
      console.log(`Spawning worker for ${wishId}...`);

      // Update worker status to spawning
      const workers = { ...batch.workers };
      workers[wishId] = {
        ...workers[wishId],
        status: 'spawning',
        startedAt: new Date().toISOString(),
      };
      updateBatch(genieDir, batch.id, { workers });

      // Call the existing work command (skip per-worker blocking; we block once after all spawn)
      await workCommand(wishId, {
        session: options.session,
        skill: options.skill,
        noAutoApprove: options.noAutoApprove,
        _skipAutoApproveBlock: true,
      });

      // Update worker status to running
      workers[wishId] = {
        ...workers[wishId],
        status: 'running',
      };
      updateBatch(genieDir, batch.id, { workers });

      spawned.push(wishId);
    } catch (error: any) {
      console.error(`Failed to spawn ${wishId}: ${error.message}`);

      // Update worker status to failed
      const workers = { ...batch.workers };
      workers[wishId] = {
        ...workers[wishId],
        status: 'failed',
        completedAt: new Date().toISOString(),
      };
      updateBatch(genieDir, batch.id, { workers });

      failed.push(wishId);
    }
  }

  // 5. Report
  console.log(`\nBatch ${batch.id} summary:`);
  console.log(`  Spawned: ${spawned.length}`);
  if (queued.length > 0) {
    console.log(`  Queued: ${queued.length} (${queued.join(', ')})`);
  }
  if (failed.length > 0) {
    console.log(`  Failed: ${failed.length} (${failed.join(', ')})`);
  }

  // 6. Block for auto-approve if any workers were spawned with auto-approve enabled
  if (!options.noAutoApprove && spawned.length > 0) {
    console.log(`\n🔒 Auto-approve active for ${spawned.length} worker(s). Press Ctrl+C to detach.`);
    await new Promise<void>((resolve) => {
      process.on('SIGINT', () => {
        console.log('\n🔒 Auto-approve stopped.');
        resolve();
        process.exit(0);
      });
    });
  }

  return {
    batchId: batch.id,
    spawned,
    failed,
    skipped: queued,
  };
}
