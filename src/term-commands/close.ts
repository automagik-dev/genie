/**
 * Close command - Close task/issue and cleanup worker
 *
 * Supports both local wishes (.genie/tasks.json) and beads issues.
 * Backend is auto-detected based on whether .genie/ directory exists.
 *
 * Usage:
 *   term close <task-id>   - Close task, cleanup worktree, kill worker
 *
 * Options:
 *   --no-sync              - Skip bd sync (beads only, no-op for local)
 *   --keep-worktree        - Don't remove the worktree
 *   --merge                - Merge worktree changes to main branch
 *   -y, --yes              - Skip confirmation
 */

import { $ } from 'bun';
import { confirm } from '@inquirer/prompts';
import * as tmux from '../lib/tmux.js';
import * as registry from '../lib/worker-registry.js';
import * as beadsRegistry from '../lib/beads-registry.js';
import { getBackend, TaskBackend } from '../lib/task-backend.js';
import { cleanupEventFile } from './events.js';
import { join } from 'path';

// Use beads registry only when enabled AND bd exists on PATH
// @ts-ignore
const useBeadsRegistry = beadsRegistry.isBeadsRegistryEnabled() && (typeof (Bun as any).which === 'function' ? Boolean((Bun as any).which('bd')) : true);

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
  } catch (error: any) {
    return { stdout: error.stdout?.toString().trim() || '', exitCode: error.exitCode || 1 };
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
async function mergeToMain(
  repoPath: string,
  branchName: string
): Promise<boolean> {
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
  } catch (error: any) {
    console.error(`⚠️  Merge failed: ${error.message}`);
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
// Main Command
// ============================================================================

export async function closeCommand(
  taskId: string,
  options: CloseOptions = {}
): Promise<void> {
  try {
    // Detect repo path from cwd
    const repoPath = process.cwd();

    // Get backend (local vs beads)
    const backend = getBackend(repoPath);
    const isLocal = backend.kind === 'local';

    // Find ALL workers for this task (supports N workers per task)
    const allWorkers = await registry.findAllByTask(taskId);
    const workerCount = allWorkers.length;

    // Find a representative worker for worktree operations
    let worker: registry.Worker | null = null;
    if (useBeadsRegistry) {
      worker = await beadsRegistry.findByTask(taskId);
    }
    if (!worker && allWorkers.length > 0) {
      worker = allWorkers[0];
    }

    if (workerCount === 0) {
      console.log(`ℹ️  No active worker for ${taskId}. Closing ${isLocal ? 'task' : 'issue'} only.`);
    } else if (workerCount > 1) {
      console.log(`📌 Found ${workerCount} workers for ${taskId}`);
    }

    // Confirm with user
    if (!options.yes) {
      const workerMsg = workerCount > 1
        ? ` and kill ${workerCount} workers`
        : worker ? ` and kill worker (pane ${worker.paneId})` : '';
      const confirmed = await confirm({
        message: `Close ${taskId}${workerMsg}?`,
        default: true,
      });

      if (!confirmed) {
        console.log('Cancelled.');
        return;
      }
    }

    // 1. Close task/issue based on backend
    console.log(`📝 Closing ${taskId}...`);
    let closed: boolean;
    if (isLocal) {
      // Local backend: mark task as done in tasks.json
      closed = await closeLocalTask(backend, taskId);
      if (!closed) {
        console.error(`❌ Failed to close ${taskId}. Check .genie/tasks.json.`);
        // Continue with cleanup anyway
      } else {
        console.log(`   ✅ Task marked as done`);
      }
    } else {
      // Beads backend: use bd close
      closed = await closeBeadsIssue(taskId);
      if (!closed) {
        console.error(`❌ Failed to close ${taskId}. Check \`bd show ${taskId}\`.`);
        // Continue with cleanup anyway
      } else {
        console.log(`   ✅ Issue closed`);
      }
    }

    // 2. Sync beads (unless --no-sync or using local backend)
    if (!isLocal && !options.noSync) {
      console.log(`🔄 Syncing beads...`);
      const synced = await syncBeads();
      if (synced) {
        console.log(`   ✅ Synced to git`);
      } else {
        console.log(`   ⚠️  Sync failed (non-fatal)`);
      }
    }

    // 3. Handle worktree
    if (worker?.worktree && !options.keepWorktree) {
      // Merge if requested
      if (options.merge) {
        console.log(`🔀 Merging changes...`);
        const merged = await mergeToMain(worker.repoPath, taskId);
        if (merged) {
          console.log(`   ✅ Merged to main`);
        }
      }

      // Remove worktree
      console.log(`🌳 Removing worktree...`);
      const removed = await removeWorktree(taskId, worker.repoPath);
      if (removed) {
        console.log(`   ✅ Worktree removed`);
      }
    }

    // 4. Kill ALL worker windows/panes (supports N workers per task)
    for (const w of allWorkers) {
      if (w.windowId && w.session) {
        // Prefer session-qualified window ID for reliable cleanup (DEC-2)
        console.log(`💀 Killing worker window "${w.windowName || w.windowId}" (${w.id})...`);
        try {
          const sessionObj = await tmux.findSessionByName(w.session);
          if (sessionObj) {
            try {
              await tmux.killWindowQualified(sessionObj.id, w.windowId);
            } catch {
              // Session-qualified kill failed (window may have moved) — fallback to direct kill
              await tmux.killWindow(w.windowId);
            }
          } else {
            // Session gone — try direct window kill as fallback
            await tmux.killWindow(w.windowId);
          }
          console.log(`   ✅ Window killed`);
        } catch {
          console.log(`   ℹ️  Window already gone`);
        }
      } else if (w.windowName) {
        // Fallback: name-based kill for workers without windowId (backward compat)
        console.log(`💀 Killing worker window "${w.windowName}" (${w.id})...`);
        try {
          await tmux.killWindow(w.windowName);
          console.log(`   ✅ Window killed`);
        } catch {
          console.log(`   ℹ️  Window already gone`);
        }
      } else {
        console.log(`💀 Killing worker pane (${w.id})...`);
        await killWorkerPane(w.paneId);
        console.log(`   ✅ Pane killed`);
      }

      // 5. Unregister worker from both registries
      if (useBeadsRegistry) {
        try {
          // Unbind work from agent
          await beadsRegistry.unbindWork(w.id);
          // Set agent state to done
          await beadsRegistry.setAgentState(w.id, 'done');
          // Delete agent bead
          await beadsRegistry.deleteAgent(w.id);
        } catch {
          // Non-fatal if beads cleanup fails
        }
      }
      await registry.unregister(w.id);
      // Cleanup event file
      await cleanupEventFile(w.paneId).catch(() => {});
    }

    if (allWorkers.length > 0) {
      console.log(`   ✅ ${allWorkers.length} worker(s) unregistered`);
    }

    console.log(`\n✅ ${taskId} closed successfully`);

  } catch (error: any) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
}
