/**
 * Kill command - Force kill a worker
 *
 * Usage:
 *   term kill <worker>     - Kill worker by ID or pane
 *
 * Options:
 *   -y, --yes              - Skip confirmation
 *   --keep-worktree        - Don't remove the worktree
 */

import { confirm } from '@inquirer/prompts';
import * as tmux from '../lib/tmux.js';
import * as registry from '../lib/worker-registry.js';
import { WorktreeManager } from '../lib/worktree.js';
import { join } from 'path';
import { homedir } from 'os';

// ============================================================================
// Types
// ============================================================================

export interface KillOptions {
  yes?: boolean;
  keepWorktree?: boolean;
}

// ============================================================================
// Configuration
// ============================================================================

const WORKTREE_BASE = join(homedir(), '.local', 'share', 'term', 'worktrees');

// ============================================================================
// Helper Functions
// ============================================================================

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

/**
 * Remove worktree
 */
async function removeWorktree(taskId: string, repoPath: string): Promise<boolean> {
  try {
    const manager = new WorktreeManager({
      baseDir: WORKTREE_BASE,
      repoPath,
    });

    if (await manager.worktreeExists(taskId)) {
      await manager.removeWorktree(taskId);
      return true;
    }
    return true; // Already doesn't exist
  } catch (error: any) {
    console.error(`⚠️  Failed to remove worktree: ${error.message}`);
    return false;
  }
}

// ============================================================================
// Main Command
// ============================================================================

export async function killCommand(
  target: string,
  options: KillOptions = {}
): Promise<void> {
  try {
    // Find worker by ID or pane
    let worker = await registry.get(target);

    if (!worker) {
      // Try finding by pane ID
      worker = await registry.findByPane(target);
    }

    if (!worker) {
      // Try finding by task ID
      worker = await registry.findByTask(target);
    }

    if (!worker) {
      console.error(`❌ Worker "${target}" not found.`);
      console.log(`   Run \`term workers\` to see active workers.`);
      process.exit(1);
    }

    // Confirm with user
    if (!options.yes) {
      const confirmed = await confirm({
        message: `Kill worker ${worker.id} (pane ${worker.paneId})?`,
        default: true,
      });

      if (!confirmed) {
        console.log('Cancelled.');
        return;
      }
    }

    // 1. Kill worker pane
    console.log(`💀 Killing worker pane ${worker.paneId}...`);
    const killed = await killWorkerPane(worker.paneId);
    if (killed) {
      console.log(`   ✅ Pane killed`);
    } else {
      console.log(`   ℹ️  Pane already gone`);
    }

    // 2. Remove worktree (unless --keep-worktree)
    if (worker.worktree && !options.keepWorktree) {
      console.log(`🌳 Removing worktree...`);
      const removed = await removeWorktree(worker.taskId, worker.repoPath);
      if (removed) {
        console.log(`   ✅ Worktree removed`);
      }
    }

    // 3. Unregister worker
    await registry.unregister(worker.id);
    console.log(`   ✅ Worker unregistered`);

    // 4. Note about task status
    console.log(`\n⚠️  Task ${worker.taskId} is still in_progress in beads.`);
    console.log(`   Run \`bd update ${worker.taskId} --status open\` to reopen,`);
    console.log(`   or \`term work ${worker.taskId}\` to start a new worker.`);

  } catch (error: any) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
}
