/**
 * Workers command - Show worker status
 *
 * Usage:
 *   term workers           - List all workers and their states
 *   term workers --json    - Output as JSON
 *   term workers --watch   - Live updates (TODO: Phase 1.5)
 */

import { $ } from 'bun';
import * as tmux from '../lib/tmux.js';
import * as registry from '../lib/worker-registry.js';
import { detectState, stripAnsi } from '../lib/orchestrator/index.js';

// ============================================================================
// Types
// ============================================================================

export interface WorkersOptions {
  json?: boolean;
  watch?: boolean;
}

interface WorkerDisplay {
  name: string;
  pane: string;
  task: string;
  state: string;
  time: string;
  alive: boolean;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if a pane still exists
 */
async function isPaneAlive(paneId: string): Promise<boolean> {
  try {
    await tmux.capturePaneContent(paneId, 1);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get current state from pane output
 */
async function getCurrentState(paneId: string): Promise<string> {
  try {
    const output = await tmux.capturePaneContent(paneId, 30);
    const state = detectState(output);

    // Map to display format
    switch (state.type) {
      case 'working':
      case 'tool_use':
        return 'working';
      case 'idle':
        return 'idle';
      case 'permission':
        return '⚠️ perm';
      case 'question':
        return '⚠️ question';
      case 'error':
        return '❌ error';
      case 'complete':
        return '✅ done';
      default:
        return state.type;
    }
  } catch {
    return 'unknown';
  }
}

/**
 * Get beads queue status
 */
async function getQueueStatus(): Promise<{ ready: string[]; blocked: string[] }> {
  const ready: string[] = [];
  const blocked: string[] = [];

  try {
    // Get ready issues
    const readyResult = await $`bd ready --json`.quiet();
    const readyOutput = readyResult.stdout.toString().trim();
    if (readyOutput) {
      try {
        const issues = JSON.parse(readyOutput);
        for (const issue of issues) {
          ready.push(`${issue.id}`);
        }
      } catch {
        // Parse line-based format
        const lines = readyOutput.split('\n').filter(l => l.trim());
        for (const line of lines) {
          const match = line.match(/^(bd-\d+)/);
          if (match) ready.push(match[1]);
        }
      }
    }
  } catch {
    // Ignore bd errors
  }

  try {
    // Get blocked issues
    const listResult = await $`bd list --json`.quiet();
    const listOutput = listResult.stdout.toString().trim();
    if (listOutput) {
      try {
        const issues = JSON.parse(listOutput);
        for (const issue of issues) {
          if (issue.blockedBy && issue.blockedBy.length > 0) {
            blocked.push(`${issue.id} (blocked by ${issue.blockedBy.join(', ')})`);
          }
        }
      } catch {
        // Ignore parse errors
      }
    }
  } catch {
    // Ignore bd errors
  }

  return { ready, blocked };
}

/**
 * Format time elapsed
 */
function formatElapsed(startedAt: string): string {
  const startTime = new Date(startedAt).getTime();
  const ms = Date.now() - startTime;
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m`;
  }
  return '<1m';
}

// ============================================================================
// Main Command
// ============================================================================

export async function workersCommand(options: WorkersOptions = {}): Promise<void> {
  try {
    const workers = await registry.list();

    // Gather display data for each worker
    const displayData: WorkerDisplay[] = [];

    for (const worker of workers) {
      const alive = await isPaneAlive(worker.paneId);
      let currentState = worker.state;

      if (alive) {
        // Get live state from pane
        currentState = await getCurrentState(worker.paneId);

        // Update registry if state differs
        const mappedState = mapDisplayStateToRegistry(currentState);
        if (mappedState && mappedState !== worker.state) {
          await registry.updateState(worker.id, mappedState);
        }
      } else {
        currentState = '💀 dead';
      }

      displayData.push({
        name: worker.id,
        pane: worker.paneId,
        task: worker.taskTitle
          ? `"${worker.taskTitle.substring(0, 25)}${worker.taskTitle.length > 25 ? '...' : ''}"`
          : worker.taskId,
        state: currentState,
        time: formatElapsed(worker.startedAt),
        alive,
      });
    }

    // Get queue status
    const queue = await getQueueStatus();

    // Filter out dead workers from ready count
    const activeTaskIds = workers.filter(w => displayData.find(d => d.name === w.id && d.alive)).map(w => w.taskId);
    const actuallyReady = queue.ready.filter(id => !activeTaskIds.includes(id));

    if (options.json) {
      console.log(JSON.stringify({
        workers: displayData,
        queue: {
          ready: actuallyReady,
          blocked: queue.blocked,
        },
      }, null, 2));
      return;
    }

    // Display workers table
    console.log('┌─────────────────────────────────────────────────────────────────┐');
    console.log('│ WORKERS                                                         │');
    console.log('├──────────┬──────────┬───────────────────────────┬──────────┬────┤');
    console.log('│ Name     │ Pane     │ Task                      │ State    │Time│');
    console.log('├──────────┼──────────┼───────────────────────────┼──────────┼────┤');

    if (displayData.length === 0) {
      console.log('│ (no workers)                                                    │');
    } else {
      for (const w of displayData) {
        const name = w.name.padEnd(8).substring(0, 8);
        const pane = w.pane.padEnd(8).substring(0, 8);
        const task = w.task.padEnd(25).substring(0, 25);
        const state = w.state.padEnd(8).substring(0, 8);
        const time = w.time.padStart(4).substring(0, 4);
        console.log(`│ ${name} │ ${pane} │ ${task} │ ${state} │${time}│`);
      }
    }

    console.log('└──────────┴──────────┴───────────────────────────┴──────────┴────┘');

    // Display queue
    if (queue.blocked.length > 0) {
      console.log(`\nBlocked: ${queue.blocked.slice(0, 5).join(', ')}${queue.blocked.length > 5 ? '...' : ''}`);
    }

    if (actuallyReady.length > 0) {
      console.log(`Ready: ${actuallyReady.slice(0, 5).join(', ')}${actuallyReady.length > 5 ? '...' : ''}`);
    } else if (displayData.length > 0) {
      console.log(`\nReady: (none - all assigned or blocked)`);
    }

    // Cleanup dead workers (optional - could prompt)
    const deadWorkers = displayData.filter(w => !w.alive);
    if (deadWorkers.length > 0) {
      console.log(`\n⚠️  ${deadWorkers.length} dead worker(s) detected. Run \`term kill <name>\` to clean up.`);
    }

  } catch (error: any) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Map display state to registry state
 */
function mapDisplayStateToRegistry(displayState: string): registry.WorkerState | null {
  if (displayState === 'working') return 'working';
  if (displayState === 'idle') return 'idle';
  if (displayState === '⚠️ perm') return 'permission';
  if (displayState === '⚠️ question') return 'question';
  if (displayState === '❌ error') return 'error';
  if (displayState === '✅ done') return 'done';
  return null;
}
