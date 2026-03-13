/**
 * Close command - Close task and cleanup worker
 *
 * Usage:
 *   genie agent close <task-id>   - Close task, cleanup worktree, kill agent
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
import { getBackend } from '../lib/task-backend.js';
import * as tmux from '../lib/tmux.js';
import { cleanupEventFile } from './events.js';

// ============================================================================
// Types
// ============================================================================

export interface CloseOptions {
  keepWorktree?: boolean;
  merge?: boolean;
  yes?: boolean;
}

// ============================================================================
// Configuration
// ============================================================================

const WORKTREE_DIR_NAME = '.genie/worktrees';

// ============================================================================
// Helper Functions
// ============================================================================

async function mergeToMain(repoPath: string, branchName: string): Promise<boolean> {
  try {
    const currentResult = await $`git -C ${repoPath} branch --show-current`.quiet();
    const currentBranch = currentResult.stdout.toString().trim();

    if (currentBranch === branchName) {
      console.log(`⚠️  Already on branch ${branchName}. Skipping merge.`);
      return true;
    }

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

async function removeWorktree(taskId: string, repoPath: string): Promise<boolean> {
  const inProjectWorktree = join(repoPath, WORKTREE_DIR_NAME, taskId);
  try {
    await $`git -C ${repoPath} worktree remove ${inProjectWorktree} --force`.quiet();
    return true;
  } catch {
    return true;
  }
}

async function killWorkerPane(paneId: string): Promise<boolean> {
  try {
    await tmux.killPane(paneId);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Worker Cleanup Helpers
// ============================================================================

async function killWorkerTmux(w: registry.Agent): Promise<void> {
  if (w.windowId && w.session) {
    console.log(`💀 Killing agent window "${w.windowName || w.windowId}" (${w.id})...`);
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
    console.log(`💀 Killing agent window "${w.windowName}" (${w.id})...`);
    try {
      await tmux.killWindow(w.windowName);
      console.log('   ✅ Window killed');
    } catch {
      console.log('   ℹ️  Window already gone');
    }
    return;
  }
  console.log(`💀 Killing agent pane (${w.id})...`);
  await killWorkerPane(w.paneId);
  console.log('   ✅ Pane killed');
}

async function unregisterWorker(w: registry.Agent): Promise<void> {
  await registry.unregister(w.id);
  await cleanupEventFile(w.paneId).catch(() => {});
}

async function closeTaskByBackend(taskId: string): Promise<void> {
  const repoPath = process.cwd();
  const backend = getBackend(repoPath);
  console.log(`📝 Closing ${taskId}...`);
  const closed = await backend.markDone(taskId);
  console.log(closed ? '   ✅ Task marked as done' : `❌ Failed to close ${taskId}. Check .genie/tasks.json.`);
}

// ============================================================================
// Main Command
// ============================================================================

async function confirmClose(taskId: string, workerCount: number, worker: registry.Agent | null): Promise<boolean> {
  const workerMsg =
    workerCount > 1 ? ` and kill ${workerCount} agents` : worker ? ` and kill agent (pane ${worker.paneId})` : '';
  return confirm({ message: `Close ${taskId}${workerMsg}?`, default: true });
}

async function handleWorktreeCleanup(worker: registry.Agent, taskId: string, options: CloseOptions): Promise<void> {
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

async function killAndUnregisterAll(allWorkers: registry.Agent[]): Promise<void> {
  for (const w of allWorkers) {
    await killWorkerTmux(w);
    await unregisterWorker(w);
  }
  if (allWorkers.length > 0) console.log(`   ✅ ${allWorkers.length} agent(s) unregistered`);
}

export async function closeCommand(taskId: string, options: CloseOptions = {}): Promise<void> {
  try {
    const allWorkers = await registry.findAllByTask(taskId);
    const worker = allWorkers.length > 0 ? allWorkers[0] : null;

    if (allWorkers.length === 0) {
      console.log(`ℹ️  No active agent for ${taskId}. Closing task only.`);
    } else if (allWorkers.length > 1) {
      console.log(`📌 Found ${allWorkers.length} agents for ${taskId}`);
    }

    if (!options.yes) {
      if (!(await confirmClose(taskId, allWorkers.length, worker))) {
        console.log('Cancelled.');
        return;
      }
    }

    await closeTaskByBackend(taskId);
    if (worker) await handleWorktreeCleanup(worker, taskId, options);
    await killAndUnregisterAll(allWorkers);

    console.log(`\n✅ ${taskId} closed successfully`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ Error: ${message}`);
    process.exit(1);
  }
}
