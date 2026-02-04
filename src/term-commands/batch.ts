/**
 * Batch status/list/cancel commands
 *
 * Provides rendering and mutation for parallel spawn batches:
 *   - batchStatusCommand(genieDir, batchId) - show workers with status, pane, wish-id, progress
 *   - batchListCommand(genieDir) - show all batches with summary
 *   - batchCancelCommand(genieDir, batchId) - cancel all active workers, update batch status
 *
 * Reuses status indicator patterns from dashboard.ts for consistent color coding.
 */

import { getBatch, listBatches, updateBatch } from '../lib/batch-manager.js';
import type { Batch, BatchWorker } from '../lib/batch-manager.js';

// ============================================================================
// ANSI Color Constants (matching dashboard.ts)
// ============================================================================

const ANSI_RESET = '\x1b[0m';
const ANSI_GREEN = '\x1b[32m';
const ANSI_YELLOW = '\x1b[33m';
const ANSI_RED = '\x1b[31m';
const ANSI_GRAY = '\x1b[90m';
const ANSI_BOLD = '\x1b[1m';

// ============================================================================
// Worker Status Indicator
// ============================================================================

interface WorkerStatusResult {
  text: string;
  ansi: string;
}

/**
 * Get a status indicator for a batch worker.
 * Maps batch worker statuses to display text and ANSI-colored strings.
 */
function workerStatusIndicator(status: BatchWorker['status']): WorkerStatusResult {
  switch (status) {
    case 'running':
    case 'spawning':
      return {
        text: 'Running',
        ansi: `${ANSI_GREEN}\u25CF Running${ANSI_RESET}`,
      };
    case 'complete':
      return {
        text: 'Complete',
        ansi: `${ANSI_GREEN}\u2713 Complete${ANSI_RESET}`,
      };
    case 'waiting':
      return {
        text: 'Waiting',
        ansi: `${ANSI_YELLOW}\u23F3 Waiting${ANSI_RESET}`,
      };
    case 'queued':
      return {
        text: 'Queued',
        ansi: `${ANSI_GRAY}\u25CB Queued${ANSI_RESET}`,
      };
    case 'failed':
      return {
        text: 'Failed',
        ansi: `${ANSI_RED}\u2716 Failed${ANSI_RESET}`,
      };
    case 'cancelled':
      return {
        text: 'Cancelled',
        ansi: `${ANSI_RED}\u2500 Cancelled${ANSI_RESET}`,
      };
    default:
      return {
        text: 'Unknown',
        ansi: `${ANSI_GRAY}? Unknown${ANSI_RESET}`,
      };
  }
}

// ============================================================================
// Status Counting
// ============================================================================

interface StatusCounts {
  total: number;
  complete: number;
  running: number;
  waiting: number;
  queued: number;
  failed: number;
  cancelled: number;
  spawning: number;
}

function countStatuses(workers: Record<string, BatchWorker>): StatusCounts {
  const counts: StatusCounts = {
    total: 0,
    complete: 0,
    running: 0,
    waiting: 0,
    queued: 0,
    failed: 0,
    cancelled: 0,
    spawning: 0,
  };

  for (const worker of Object.values(workers)) {
    counts.total++;
    switch (worker.status) {
      case 'complete': counts.complete++; break;
      case 'running': counts.running++; break;
      case 'waiting': counts.waiting++; break;
      case 'queued': counts.queued++; break;
      case 'failed': counts.failed++; break;
      case 'cancelled': counts.cancelled++; break;
      case 'spawning': counts.spawning++; break;
    }
  }

  return counts;
}

/**
 * Build a human-readable progress summary from status counts.
 * Example: "1/3 complete, 1 running, 1 waiting"
 */
function progressSummary(counts: StatusCounts): string {
  const parts: string[] = [];

  parts.push(`${counts.complete}/${counts.total} complete`);

  if (counts.running > 0) {
    parts.push(`${counts.running} running`);
  }
  if (counts.spawning > 0) {
    parts.push(`${counts.spawning} spawning`);
  }
  if (counts.waiting > 0) {
    parts.push(`${counts.waiting} waiting`);
  }
  if (counts.queued > 0) {
    parts.push(`${counts.queued} queued`);
  }
  if (counts.failed > 0) {
    parts.push(`${counts.failed} failed`);
  }
  if (counts.cancelled > 0) {
    parts.push(`${counts.cancelled} cancelled`);
  }

  return parts.join(', ');
}

// ============================================================================
// renderBatchStatus
// ============================================================================

/**
 * Render a single batch's status display.
 *
 * Output format:
 * ```
 * Batch batch-001: 3 workers
 *   ● wish-21  %85  Running
 *   ✓ wish-23  %86  Complete
 *   ⏳ wish-24  %87  Waiting
 *
 * Progress: 1/3 complete, 1 running, 1 waiting
 * ```
 */
export function renderBatchStatus(batch: Batch): string {
  const lines: string[] = [];
  const counts = countStatuses(batch.workers);

  // Header
  lines.push(`${ANSI_BOLD}Batch ${batch.id}${ANSI_RESET}: ${counts.total} workers`);

  // Worker rows
  for (const wishId of batch.wishes) {
    const worker = batch.workers[wishId];
    if (!worker) continue;

    const indicator = workerStatusIndicator(worker.status);
    const pane = worker.paneId ? `  ${worker.paneId}` : '  -';

    lines.push(`  ${indicator.ansi}${pane}  ${wishId}`);
  }

  // Progress summary
  lines.push('');
  lines.push(`Progress: ${progressSummary(counts)}`);

  return lines.join('\n');
}

// ============================================================================
// renderBatchList
// ============================================================================

/**
 * Render a list of all batches with summary information.
 *
 * Output format:
 * ```
 * BATCHES
 * ────────────────────────────────────
 * batch-001  active    3 workers  1 complete, 1 running, 1 waiting
 * batch-002  complete  2 workers  2 complete
 * ```
 */
export function renderBatchList(batches: Batch[]): string {
  const lines: string[] = [];

  lines.push(`${ANSI_BOLD}BATCHES${ANSI_RESET}`);
  lines.push('\u2500'.repeat(64));

  if (batches.length === 0) {
    lines.push(`${ANSI_GRAY}No batches found${ANSI_RESET}`);
    lines.push('');
    return lines.join('\n');
  }

  for (const batch of batches) {
    const counts = countStatuses(batch.workers);
    const statusColor = batch.status === 'active'
      ? ANSI_GREEN
      : batch.status === 'cancelled'
        ? ANSI_RED
        : ANSI_GRAY;

    const batchId = batch.id.padEnd(12);
    const status = `${statusColor}${batch.status}${ANSI_RESET}`.padEnd(10 + statusColor.length + ANSI_RESET.length);
    const workerCount = `${counts.total} workers`.padEnd(12);
    const progress = progressSummary(counts);

    lines.push(`  ${batchId}${status}  ${workerCount}${progress}`);
  }

  lines.push('');
  return lines.join('\n');
}

// ============================================================================
// cancelBatch
// ============================================================================

/**
 * Terminal statuses that should not be changed by cancellation.
 */
const TERMINAL_STATUSES: Set<BatchWorker['status']> = new Set([
  'complete',
  'failed',
  'cancelled',
]);

/**
 * Cancel all active workers in a batch.
 *
 * - Workers in terminal states (complete, failed, cancelled) are left unchanged.
 * - All other workers are marked as 'cancelled'.
 * - The batch status is set to 'cancelled'.
 * - Changes are persisted to disk.
 *
 * Returns the updated batch, or null if the batch does not exist.
 */
export function cancelBatch(genieDir: string, batchId: string): Batch | null {
  const batch = getBatch(genieDir, batchId);
  if (!batch) {
    return null;
  }

  // Mark non-terminal workers as cancelled
  const updatedWorkers = { ...batch.workers };
  for (const [wishId, worker] of Object.entries(updatedWorkers)) {
    if (!TERMINAL_STATUSES.has(worker.status)) {
      updatedWorkers[wishId] = { ...worker, status: 'cancelled' };
    }
  }

  // Update and persist
  const updated = updateBatch(genieDir, batchId, {
    status: 'cancelled',
    workers: updatedWorkers,
  });

  return updated;
}

// ============================================================================
// Top-level Commands (for CLI integration)
// ============================================================================

/**
 * `term batch status <batch-id>` - Show aggregated status for a batch.
 */
export async function batchStatusCommand(genieDir: string, batchId: string): Promise<void> {
  const batch = getBatch(genieDir, batchId);
  if (!batch) {
    console.error(`Error: batch '${batchId}' not found`);
    process.exit(1);
  }
  console.log(renderBatchStatus(batch));
}

/**
 * `term batch list` - Show all batches with summary.
 */
export async function batchListCommand(genieDir: string): Promise<void> {
  const batches = listBatches(genieDir);
  console.log(renderBatchList(batches));
}

/**
 * `term batch cancel <batch-id>` - Cancel all workers in a batch.
 */
export async function batchCancelCommand(genieDir: string, batchId: string): Promise<void> {
  const result = cancelBatch(genieDir, batchId);
  if (!result) {
    console.error(`Error: batch '${batchId}' not found`);
    process.exit(1);
  }
  console.log(`Batch ${batchId} cancelled.`);
  console.log(renderBatchStatus(result));
}
