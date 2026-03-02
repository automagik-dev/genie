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
import { cleanupEventFile } from './events.js';
import { join } from 'path';

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

  // Try bd worktree when beads is enabled
  if (useBeads) {
    try {
      const removed = await beadsRegistry.removeWorktree(taskId);
      if (removed) return true;
    } catch {
      // Fall through
    }
  }

  return true; // Already doesn't exist
}

// ============================================================================
// Main Command
// ============================================================================

export async function killCommand(
  target: string,
  options: KillOptions = {}
): Promise<void> {
  try {
    // Find worker by ID, pane, or task
    let worker: registry.Worker | null = null;

    if (useBeads) {
      worker = await beadsRegistry.getWorker(target);
      if (!worker) worker = await beadsRegistry.findByPane(target);
      if (!worker) worker = await beadsRegistry.findByTask(target);
    } else {
      worker = await registry.get(target);
      if (!worker) worker = await registry.findByPane(target);
      if (!worker) worker = await registry.findByTask(target);
    }

    if (!worker) {
      console.error(`❌ Worker "${target}" not found.`);
      console.log(`   Run \`genie workers\` to see active workers.`);
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
    if (worker.windowId && worker.session) {
      // Prefer session-qualified window ID for reliable cleanup (DEC-2)
      console.log(`💀 Killing worker window "${worker.windowName || worker.windowId}"...`);
      try {
        const sessionObj = await tmux.findSessionByName(worker.session);
        if (sessionObj) {
          try {
            await tmux.killWindowQualified(sessionObj.id, worker.windowId);
          } catch {
            // Session-qualified kill failed (window may have moved) — fallback to direct kill
            await tmux.killWindow(worker.windowId);
          }
        } else {
          // Session gone — try direct window kill as fallback
          await tmux.killWindow(worker.windowId);
        }
        console.log(`   ✅ Window killed`);
      } catch {
        console.log(`   ℹ️  Window already gone`);
      }
    } else if (worker.windowName) {
      // Fallback: name-based kill for workers without windowId (backward compat)
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
