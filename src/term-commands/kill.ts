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

import { $ } from 'bun';
import { confirm } from '@inquirer/prompts';
import * as tmux from '../lib/tmux.js';
import * as registry from '../lib/worker-registry.js';
import * as beadsRegistry from '../lib/beads-registry.js';
import { WorktreeManager } from '../lib/worktree.js';
import { cleanupEventFile } from './events.js';
import { join } from 'path';
import { homedir } from 'os';

// Use beads registry only when enabled AND bd exists on PATH
// @ts-ignore
const useBeads = beadsRegistry.isBeadsRegistryEnabled() && (typeof (Bun as any).which === 'function' ? Boolean((Bun as any).which('bd')) : true);

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
// Worktrees are created inside the project at .genie/worktrees/<taskId>
const WORKTREE_DIR_NAME = '.genie/worktrees';

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
 * Checks .genie/worktrees first, then bd worktree, then WorktreeManager
 */
async function removeWorktree(taskId: string, repoPath: string): Promise<boolean> {
  // First, check .genie/worktrees location (new location)
  const inProjectWorktree = join(repoPath, WORKTREE_DIR_NAME, taskId);
  try {
    await $`git -C ${repoPath} worktree remove ${inProjectWorktree} --force`.quiet();
    return true;
  } catch {
    // Worktree may not exist at this location, continue checking
  }

  // Try bd worktree when beads is enabled
  if (useBeads) {
    try {
      const removed = await beadsRegistry.removeWorktree(taskId);
      if (removed) return true;
      // Fall through to WorktreeManager if bd worktree fails
    } catch {
      // Fall through
    }
  }

  // Fallback to WorktreeManager (legacy location)
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
    // Find worker by ID or pane (check both registries during transition)
    let worker = await registry.get(target);

    if (!worker && useBeads) {
      // Try beads registry
      worker = await beadsRegistry.getWorker(target);
    }

    if (!worker) {
      // Try finding by pane ID
      worker = await registry.findByPane(target);
    }

    if (!worker && useBeads) {
      worker = await beadsRegistry.findByPane(target);
    }

    if (!worker) {
      // Try finding by task ID
      worker = await registry.findByTask(target);
    }

    if (!worker && useBeads) {
      worker = await beadsRegistry.findByTask(target);
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

    // 1. Kill worker window (or pane if no window name)
    if (worker.windowName) {
      console.log(`💀 Killing worker window "${worker.windowName}"...`);
      try {
        await tmux.killWindow(worker.windowName);
        console.log(`   ✅ Window killed`);
      } catch {
        console.log(`   ℹ️  Window already gone`);
      }
    } else {
      console.log(`💀 Killing worker pane ${worker.paneId}...`);
      const killed = await killWorkerPane(worker.paneId);
      if (killed) {
        console.log(`   ✅ Pane killed`);
      } else {
        console.log(`   ℹ️  Pane already gone`);
      }
    }

    // 2. Remove worktree (unless --keep-worktree)
    if (worker.worktree && !options.keepWorktree) {
      console.log(`🌳 Removing worktree...`);
      const removed = await removeWorktree(worker.taskId, worker.repoPath);
      if (removed) {
        console.log(`   ✅ Worktree removed`);
      }
    }

    // 3. Unregister worker from both registries
    if (useBeads) {
      try {
        // Unbind work from agent
        await beadsRegistry.unbindWork(worker.id);
        // Set agent state to error (killed, not done)
        await beadsRegistry.setAgentState(worker.id, 'error');
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

    // 4. Note about task status
    console.log(`\n⚠️  Task ${worker.taskId} is still in_progress in beads.`);
    console.log(`   Run \`bd update ${worker.taskId} --status open\` to reopen,`);
    console.log(`   or \`term work ${worker.taskId}\` to start a new worker.`);

  } catch (error: any) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
}
