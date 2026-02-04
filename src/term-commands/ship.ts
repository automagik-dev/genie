/**
 * Ship command - Mark task as done and cleanup worker
 *
 * Usage:
 *   term ship <task-id>     - Mark done, cleanup worktree, kill worker
 *
 * Options:
 *   --keep-worktree        - Don't remove the worktree
 *   --merge                - Merge worktree changes to main branch
 *   -y, --yes              - Skip confirmation
 */

import { $ } from 'bun';
import { confirm } from '@inquirer/prompts';
import * as tmux from '../lib/tmux.js';
import * as registry from '../lib/worker-registry.js';
import * as beadsRegistry from '../lib/beads-registry.js';
import { getBackend } from '../lib/task-backend.js';
import { cleanupEventFile } from './events.js';
import { join } from 'path';

// Use beads registry only when enabled AND bd exists on PATH
// @ts-ignore
const useBeads = beadsRegistry.isBeadsRegistryEnabled() && (typeof (Bun as any).which === 'function' ? Boolean((Bun as any).which('bd')) : true);

// ============================================================================
// Types
// ============================================================================

export interface ShipOptions {
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
 * Get the current branch name
 */
export async function getCurrentBranch(repoPath: string): Promise<string> {
  const result = await $`git -C ${repoPath} branch --show-current`.quiet();
  return result.stdout.toString().trim();
}

/**
 * Check if current branch is main/master and exit if so
 * Used to prevent accidental pushes to protected branches
 */
export async function assertNotMainBranch(repoPath: string): Promise<void> {
  const branch = await getCurrentBranch(repoPath);
  if (branch === 'main' || branch === 'master') {
    console.error('❌ Cannot push from main/master. Use a feature branch.');
    console.error('   Run: git checkout -b work/<wish-id>');
    process.exit(1);
  }
}

/**
 * Merge worktree branch to main
 */
async function mergeToMain(
  repoPath: string,
  branchName: string
): Promise<boolean> {
  try {
    // Get main branch name (could be main or master)
    let mainBranch = 'main';
    try {
      const result = await $`git -C ${repoPath} symbolic-ref refs/remotes/origin/HEAD`.quiet();
      const ref = result.stdout.toString().trim();
      mainBranch = ref.replace('refs/remotes/origin/', '');
    } catch {
      // Default to main if we can't detect
    }

    // Get current branch
    const currentResult = await $`git -C ${repoPath} branch --show-current`.quiet();
    const currentBranch = currentResult.stdout.toString().trim();

    if (currentBranch === branchName) {
      // We're on the worktree branch, need to switch to main first
      console.log(`   Switching to ${mainBranch}...`);
      await $`git -C ${repoPath} checkout ${mainBranch}`.quiet();
    }

    console.log(`   Merging ${branchName} into ${mainBranch}...`);
    await $`git -C ${repoPath} merge ${branchName} --no-edit`.quiet();

    return true;
  } catch (error: any) {
    console.error(`   Merge failed: ${error.message}`);
    return false;
  }
}

/**
 * Remove worktree
 */
async function removeWorktree(taskId: string, repoPath: string): Promise<boolean> {
  const worktreePath = join(repoPath, WORKTREE_DIR_NAME, taskId);

  try {
    await $`git -C ${repoPath} worktree remove ${worktreePath} --force`.quiet();
    return true;
  } catch {
    // Worktree may already be removed
    return true;
  }
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

export async function shipCommand(
  taskId: string,
  options: ShipOptions = {}
): Promise<void> {
  try {
    const repoPath = process.cwd();
    const backend = getBackend(repoPath);

    // Branch protection: refuse to ship from main/master
    await assertNotMainBranch(repoPath);

    // Find worker in registry
    let worker = useBeads
      ? await beadsRegistry.findByTask(taskId)
      : null;
    if (!worker) {
      worker = await registry.findByTask(taskId);
    }

    // Get task info
    const task = await backend.get(taskId);
    if (!task) {
      console.error(`❌ Task "${taskId}" not found.`);
      if (backend.kind === 'local') {
        console.error(`   Check .genie/tasks.json`);
      } else {
        console.error(`   Run \`bd show ${taskId}\` to check.`);
      }
      process.exit(1);
    }

    // Confirm with user
    if (!options.yes) {
      const message = worker
        ? `Ship ${taskId} "${task.title}"? (mark done, kill worker pane ${worker.paneId}${options.merge ? ', merge to main' : ''})`
        : `Ship ${taskId} "${task.title}"? (mark done${options.merge ? ', merge to main' : ''})`;

      const confirmed = await confirm({
        message,
        default: true,
      });

      if (!confirmed) {
        console.log('Cancelled.');
        return;
      }
    }

    // 1. Mark task as done
    console.log(`📦 Marking ${taskId} as done...`);
    const marked = await backend.markDone(taskId);
    if (!marked) {
      console.error(`   Failed to mark ${taskId} as done.`);
      // Continue with cleanup anyway
    } else {
      console.log(`   ✅ Task marked as done`);
    }

    // 2. Handle worktree
    if (worker?.worktree && !options.keepWorktree) {
      // Merge if requested
      if (options.merge) {
        console.log(`🔀 Merging changes...`);
        const branchName = `work/${taskId}`;
        const merged = await mergeToMain(worker.repoPath, branchName);
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

    // 3. Kill worker window (or pane if no window name)
    if (worker) {
      if (worker.windowName) {
        console.log(`💀 Killing worker window "${worker.windowName}"...`);
        try {
          await tmux.killWindow(worker.windowName);
          console.log(`   ✅ Window killed`);
        } catch {
          console.log(`   ℹ️  Window already gone`);
        }
      } else {
        console.log(`💀 Killing worker pane...`);
        await killWorkerPane(worker.paneId);
        console.log(`   ✅ Pane killed`);
      }

      // 4. Unregister worker from both registries
      if (useBeads) {
        try {
          // Unbind work from agent
          await beadsRegistry.unbindWork(worker.id);
          // Set agent state to done
          await beadsRegistry.setAgentState(worker.id, 'done');
          // Delete agent bead
          await beadsRegistry.deleteAgent(worker.id);
        } catch {
          // Non-fatal if beads cleanup fails
        }
      }
      await registry.unregister(worker.id);
      // Cleanup event file
      await cleanupEventFile(worker.paneId).catch(() => {});
      console.log(`   ✅ Worker unregistered`);
    }

    console.log(`\n🚀 ${taskId} shipped successfully!`);

  } catch (error: any) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
}
