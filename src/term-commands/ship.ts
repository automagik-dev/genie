/**
 * Ship command - Mark task as done and cleanup worker
 *
 * Usage:
 *   genie worker ship <task-id>     - Mark done, cleanup worktree, kill worker
 *
 * Options:
 *   --keep-worktree        - Don't remove the worktree
 *   --merge                - Merge worktree changes to main branch
 *   -y, --yes              - Skip confirmation
 */

import { join } from 'node:path';
import { confirm } from '@inquirer/prompts';
import { $ } from 'bun';
import * as registry from '../lib/agent-registry.js';
import * as beadsRegistry from '../lib/beads-registry.js';
import { getBackend } from '../lib/task-backend.js';
import * as tmux from '../lib/tmux.js';
import { cleanupEventFile } from './events.js';

// Use beads registry only when enabled AND bd exists on PATH
const useBeads =
  beadsRegistry.isBeadsRegistryEnabled() &&
  (() => {
    const BunExt = Bun as unknown as { which?: (name: string) => string | null };
    return typeof BunExt.which === 'function' ? Boolean(BunExt.which('bd')) : true;
  })();

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
async function getCurrentBranch(repoPath: string): Promise<string> {
  const result = await $`git -C ${repoPath} branch --show-current`.quiet();
  return result.stdout.toString().trim();
}

/**
 * Check if current branch is main/master and exit if so
 * Used to prevent accidental pushes to protected branches
 */
async function assertNotMainBranch(repoPath: string): Promise<void> {
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
async function mergeToMain(repoPath: string, branchName: string): Promise<boolean> {
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`   Merge failed: ${message}`);
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

/**
 * Kill and unregister a worker, cleaning up tmux and registries.
 */
async function cleanupWorker(worker: registry.Agent): Promise<void> {
  if (worker.windowName) {
    console.log(`💀 Killing worker window "${worker.windowName}"...`);
    try {
      await tmux.killWindow(worker.windowName);
      console.log('   ✅ Window killed');
    } catch {
      console.log('   ℹ️  Window already gone');
    }
  } else {
    console.log('💀 Killing worker pane...');
    await killWorkerPane(worker.paneId);
    console.log('   ✅ Pane killed');
  }

  if (useBeads) {
    try {
      await beadsRegistry.unbindWork(worker.id);
      await beadsRegistry.setAgentState(worker.id, 'done');
      await beadsRegistry.deleteAgent(worker.id);
    } catch {
      /* Non-fatal */
    }
  }
  await registry.unregister(worker.id);
  await cleanupEventFile(worker.paneId).catch(() => {});
  console.log('   ✅ Worker unregistered');
}

/**
 * Find the worker for a task across registries.
 */
async function findWorkerForTask(taskId: string): Promise<registry.Agent | null> {
  if (useBeads) {
    const w = await beadsRegistry.findByTask(taskId);
    if (w) return w;
  }
  return registry.findByTask(taskId);
}

/**
 * Build ship confirmation message.
 */
function buildShipMessage(taskId: string, title: string, worker: registry.Agent | null, merge: boolean): string {
  const mergeNote = merge ? ', merge to main' : '';
  if (worker) return `Ship ${taskId} "${title}"? (mark done, kill worker pane ${worker.paneId}${mergeNote})`;
  return `Ship ${taskId} "${title}"? (mark done${mergeNote})`;
}

/**
 * Handle worktree operations for ship (merge + remove).
 */
async function handleShipWorktree(worker: registry.Agent, taskId: string, options: ShipOptions): Promise<void> {
  if (!worker.worktree || options.keepWorktree) return;
  if (options.merge) {
    console.log('🔀 Merging changes...');
    const merged = await mergeToMain(worker.repoPath, `work/${taskId}`);
    if (merged) console.log('   ✅ Merged to main');
  }
  console.log('🌳 Removing worktree...');
  const removed = await removeWorktree(taskId, worker.repoPath);
  if (removed) console.log('   ✅ Worktree removed');
}

export async function shipCommand(taskId: string, options: ShipOptions = {}): Promise<void> {
  try {
    const repoPath = process.cwd();
    const backend = getBackend(repoPath);
    await assertNotMainBranch(repoPath);

    const worker = await findWorkerForTask(taskId);
    const task = await backend.get(taskId);
    if (!task) {
      console.error(`❌ Task "${taskId}" not found.`);
      console.error(backend.kind === 'local' ? '   Check .genie/tasks.json' : `   Run \`bd show ${taskId}\` to check.`);
      process.exit(1);
    }

    if (!options.yes) {
      const confirmed = await confirm({
        message: buildShipMessage(taskId, task.title, worker, !!options.merge),
        default: true,
      });
      if (!confirmed) {
        console.log('Cancelled.');
        return;
      }
    }

    console.log(`📦 Marking ${taskId} as done...`);
    console.log(
      (await backend.markDone(taskId)) ? '   ✅ Task marked as done' : `   Failed to mark ${taskId} as done.`,
    );

    if (worker) {
      await handleShipWorktree(worker, taskId, options);
      await cleanupWorker(worker);
    }

    console.log(`\n🚀 ${taskId} shipped successfully!`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ Error: ${message}`);
    process.exit(1);
  }
}
