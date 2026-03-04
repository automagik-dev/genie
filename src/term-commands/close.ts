/**
 * Close command - Close task/issue and cleanup worker
 *
 * Supports both local wishes (.genie/tasks.json) and beads issues.
 * Backend is auto-detected based on whether .genie/ directory exists.
 *
 * Usage:
 *   genie worker close <task-id>   - Close task, cleanup worktree, kill worker
 *
 * Options:
 *   --no-sync              - Skip bd sync (beads only, no-op for local)
 *   --keep-worktree        - Don't remove the worktree
 *   --merge                - Merge worktree changes to main branch
 *   -y, --yes              - Skip confirmation
 */

import { join } from 'node:path';
import { confirm } from '@inquirer/prompts';
import { $ } from 'bun';
import * as registry from '../lib/agent-registry.js';
import * as beadsRegistry from '../lib/beads-registry.js';
import { type TaskBackend, getBackend } from '../lib/task-backend.js';
import * as tmux from '../lib/tmux.js';
import { cleanupEventFile } from './events.js';

// Use beads registry only when enabled AND bd exists on PATH
const useBeadsRegistry =
  beadsRegistry.isBeadsRegistryEnabled() &&
  (() => {
    const BunExt = Bun as unknown as { which?: (name: string) => string | null };
    return typeof BunExt.which === 'function' ? Boolean(BunExt.which('bd')) : true;
  })();

// ============================================================================
// Types
// ============================================================================

export interface CloseOptions {
  noSync?: boolean;
  keepWorktree?: boolean;
  merge?: boolean;
  yes?: boolean;
}

// ============================================================================
// Configuration
// ============================================================================

// Worktrees are created inside the project at .genie/worktrees/<taskId>
const WORKTREE_DIR_NAME = '.genie/worktrees';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Run bd command
 */
async function runBd(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  try {
    const result = await $`bd ${args}`.quiet();
    return { stdout: result.stdout.toString().trim(), exitCode: 0 };
  } catch (error) {
    const shellErr = error as { stdout?: Buffer; exitCode?: number };
    return { stdout: shellErr.stdout?.toString().trim() || '', exitCode: shellErr.exitCode || 1 };
  }
}

/**
 * Close beads issue via `bd close`
 */
async function closeBeadsIssue(taskId: string): Promise<boolean> {
  const { exitCode } = await runBd(['close', taskId]);
  return exitCode === 0;
}

/**
 * Close local wish by marking it as done
 */
async function closeLocalTask(backend: TaskBackend, taskId: string): Promise<boolean> {
  return backend.markDone(taskId);
}

/**
 * Sync beads to git
 */
async function syncBeads(): Promise<boolean> {
  const { exitCode } = await runBd(['sync']);
  return exitCode === 0;
}

/**
 * Merge worktree branch to main
 */
async function mergeToMain(repoPath: string, branchName: string): Promise<boolean> {
  try {
    // Get current branch
    const currentResult = await $`git -C ${repoPath} branch --show-current`.quiet();
    const currentBranch = currentResult.stdout.toString().trim();

    if (currentBranch === branchName) {
      console.log(`⚠️  Already on branch ${branchName}. Skipping merge.`);
      return true;
    }

    // Checkout main and merge
    console.log(`   Switching to ${currentBranch}...`);
    await $`git -C ${repoPath} checkout ${currentBranch}`.quiet();

    console.log(`   Merging ${branchName}...`);
    await $`git -C ${repoPath} merge ${branchName} --no-edit`.quiet();

    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`⚠️  Merge failed: ${message}`);
    return false;
  }
}

/**
 * Remove worktree
 * Checks .genie/worktrees first, then bd worktree
 */
async function removeWorktree(taskId: string, repoPath: string): Promise<boolean> {
  // First, check .genie/worktrees location
  const inProjectWorktree = join(repoPath, WORKTREE_DIR_NAME, taskId);
  try {
    await $`git -C ${repoPath} worktree remove ${inProjectWorktree} --force`.quiet();
    return true;
  } catch {
    // Worktree may not exist at this location, continue checking
  }

  // Try bd worktree when beads registry is enabled
  if (useBeadsRegistry) {
    try {
      const removed = await beadsRegistry.removeWorktree(taskId);
      if (removed) return true;
    } catch {
      // Fall through
    }
  }

  return true; // Already doesn't exist
}

/**
 * Kill worker pane
 */
async function killWorkerPane(paneId: string): Promise<boolean> {
  try {
    await tmux.killPane(paneId);
    return true;
  } catch {
    return false; // Pane may already be gone
  }
}

// ============================================================================
// Worker Cleanup Helpers
// ============================================================================

/**
 * Kill a single worker's window or pane via tmux.
 */
async function killWorkerTmux(w: registry.Worker): Promise<void> {
  if (w.windowId && w.session) {
    console.log(`💀 Killing worker window "${w.windowName || w.windowId}" (${w.id})...`);
    try {
      const sessionObj = await tmux.findSessionByName(w.session);
      if (sessionObj) {
        try {
          await tmux.killWindowQualified(sessionObj.id, w.windowId);
        } catch {
          await tmux.killWindow(w.windowId);
        }
      } else {
        await tmux.killWindow(w.windowId);
      }
      console.log('   ✅ Window killed');
    } catch {
      console.log('   ℹ️  Window already gone');
    }
    return;
  }
  if (w.windowName) {
    console.log(`💀 Killing worker window "${w.windowName}" (${w.id})...`);
    try {
      await tmux.killWindow(w.windowName);
      console.log('   ✅ Window killed');
    } catch {
      console.log('   ℹ️  Window already gone');
    }
    return;
  }
  console.log(`💀 Killing worker pane (${w.id})...`);
  await killWorkerPane(w.paneId);
  console.log('   ✅ Pane killed');
}

/**
 * Unregister a worker from all registries and clean up event files.
 */
async function unregisterWorker(w: registry.Worker): Promise<void> {
  if (useBeadsRegistry) {
    try {
      await beadsRegistry.unbindWork(w.id);
      await beadsRegistry.setAgentState(w.id, 'done');
      await beadsRegistry.deleteAgent(w.id);
    } catch {
      /* Non-fatal */
    }
  }
  await registry.unregister(w.id);
  await cleanupEventFile(w.paneId).catch(() => {});
}

/**
 * Close a task using the appropriate backend.
 */
async function closeTaskByBackend(backend: TaskBackend, taskId: string, isLocal: boolean): Promise<void> {
  console.log(`📝 Closing ${taskId}...`);
  if (isLocal) {
    const closed = await closeLocalTask(backend, taskId);
    console.log(closed ? '   ✅ Task marked as done' : `❌ Failed to close ${taskId}. Check .genie/tasks.json.`);
  } else {
    const closed = await closeBeadsIssue(taskId);
    console.log(closed ? '   ✅ Issue closed' : `❌ Failed to close ${taskId}. Check \`bd show ${taskId}\`.`);
  }
}

// ============================================================================
// Main Command
// ============================================================================

/**
 * Find representative worker for a task.
 */
async function findRepresentativeWorker(
  allWorkers: registry.Worker[],
  taskId: string,
): Promise<registry.Worker | null> {
  if (useBeadsRegistry) {
    const w = await beadsRegistry.findByTask(taskId);
    if (w) return w;
  }
  return allWorkers.length > 0 ? allWorkers[0] : null;
}

/**
 * Prompt user to confirm closing a task.
 */
async function confirmClose(taskId: string, workerCount: number, worker: registry.Worker | null): Promise<boolean> {
  const workerMsg =
    workerCount > 1 ? ` and kill ${workerCount} workers` : worker ? ` and kill worker (pane ${worker.paneId})` : '';
  return confirm({ message: `Close ${taskId}${workerMsg}?`, default: true });
}

/**
 * Handle worktree cleanup (merge + remove).
 */
async function handleWorktreeCleanup(worker: registry.Worker, taskId: string, options: CloseOptions): Promise<void> {
  if (!worker.worktree || options.keepWorktree) return;
  if (options.merge) {
    console.log('🔀 Merging changes...');
    const merged = await mergeToMain(worker.repoPath, taskId);
    if (merged) console.log('   ✅ Merged to main');
  }
  console.log('🌳 Removing worktree...');
  const removed = await removeWorktree(taskId, worker.repoPath);
  if (removed) console.log('   ✅ Worktree removed');
}

/**
 * Sync beads to git if applicable.
 */
async function maybeSyncBeads(isLocal: boolean, noSync: boolean | undefined): Promise<void> {
  if (isLocal || noSync) return;
  console.log('🔄 Syncing beads...');
  console.log((await syncBeads()) ? '   ✅ Synced to git' : '   ⚠️  Sync failed (non-fatal)');
}

/**
 * Kill and unregister all workers for a task.
 */
async function killAndUnregisterAll(allWorkers: registry.Worker[]): Promise<void> {
  for (const w of allWorkers) {
    await killWorkerTmux(w);
    await unregisterWorker(w);
  }
  if (allWorkers.length > 0) console.log(`   ✅ ${allWorkers.length} worker(s) unregistered`);
}

export async function closeCommand(taskId: string, options: CloseOptions = {}): Promise<void> {
  try {
    const repoPath = process.cwd();
    const backend = getBackend(repoPath);
    const isLocal = backend.kind === 'local';

    const allWorkers = await registry.findAllByTask(taskId);
    const worker = await findRepresentativeWorker(allWorkers, taskId);

    if (allWorkers.length === 0) {
      console.log(`ℹ️  No active worker for ${taskId}. Closing ${isLocal ? 'task' : 'issue'} only.`);
    } else if (allWorkers.length > 1) {
      console.log(`📌 Found ${allWorkers.length} workers for ${taskId}`);
    }

    if (!options.yes) {
      if (!(await confirmClose(taskId, allWorkers.length, worker))) {
        console.log('Cancelled.');
        return;
      }
    }

    await closeTaskByBackend(backend, taskId, isLocal);
    await maybeSyncBeads(isLocal, options.noSync);
    if (worker) await handleWorktreeCleanup(worker, taskId, options);
    await killAndUnregisterAll(allWorkers);

    console.log(`\n✅ ${taskId} closed successfully`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ Error: ${message}`);
    process.exit(1);
  }
}
