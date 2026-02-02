/**
 * Work command - Spawn worker bound to beads issue
 *
 * Usage:
 *   term work <bd-id>     - Work on specific beads issue
 *   term work next        - Work on next ready issue
 *   term work wish        - Create a new wish (deferred)
 *
 * Options:
 *   --no-worktree         - Use shared repo instead of worktree
 *   -s, --session <name>  - Target tmux session
 *   --focus               - Focus the worker pane (default: true)
 */

import { $ } from 'bun';
import * as tmux from '../lib/tmux.js';
import * as registry from '../lib/worker-registry.js';
import * as beadsRegistry from '../lib/beads-registry.js';
import { WorktreeManager } from '../lib/worktree.js';
import { EventMonitor, detectState } from '../lib/orchestrator/index.js';
import { join } from 'path';
import { homedir } from 'os';

// Use beads registry when enabled
const useBeads = beadsRegistry.isBeadsRegistryEnabled();

// ============================================================================
// Types
// ============================================================================

export interface WorkOptions {
  noWorktree?: boolean;
  session?: string;
  focus?: boolean;
  prompt?: string;
}

interface BeadsIssue {
  id: string;
  title: string;
  status: string;
  blockedBy?: string[];
}

// ============================================================================
// Configuration
// ============================================================================

const WORKTREE_BASE = join(homedir(), '.local', 'share', 'term', 'worktrees');

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Run bd command and parse output
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
 * Get a beads issue by ID
 */
async function getBeadsIssue(id: string): Promise<BeadsIssue | null> {
  const { stdout, exitCode } = await runBd(['show', id, '--json']);
  if (exitCode !== 0 || !stdout) return null;

  try {
    const issue = JSON.parse(stdout);
    return {
      id: issue.id,
      title: issue.title || issue.description?.substring(0, 50) || 'Untitled',
      status: issue.status,
      blockedBy: issue.blockedBy || [],
    };
  } catch {
    return null;
  }
}

/**
 * Get next ready beads issue
 */
async function getNextReadyIssue(): Promise<BeadsIssue | null> {
  const { stdout, exitCode } = await runBd(['ready', '--json']);
  if (exitCode !== 0 || !stdout) return null;

  try {
    const issues = JSON.parse(stdout);
    if (Array.isArray(issues) && issues.length > 0) {
      const issue = issues[0];
      return {
        id: issue.id,
        title: issue.title || issue.description?.substring(0, 50) || 'Untitled',
        status: issue.status,
        blockedBy: issue.blockedBy || [],
      };
    }
    return null;
  } catch {
    // Try parsing as single issue or line-based format
    const lines = stdout.split('\n').filter(l => l.trim());
    if (lines.length > 0) {
      // Extract ID from first line (format: "bd-1: title" or just "bd-1")
      const match = lines[0].match(/^(bd-\d+)/);
      if (match) {
        return getBeadsIssue(match[1]);
      }
    }
    return null;
  }
}

/**
 * Mark beads issue as in_progress
 */
async function claimIssue(id: string): Promise<boolean> {
  const { exitCode } = await runBd(['update', id, '--status', 'in_progress']);
  return exitCode === 0;
}

/**
 * Get current tmux session name
 */
async function getCurrentSession(): Promise<string | null> {
  try {
    const result = await tmux.executeTmux(`display-message -p '#{session_name}'`);
    return result.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Create worktree for worker
 * Uses bd worktree when beads registry is enabled (auto .beads redirect)
 * Falls back to WorktreeManager otherwise
 */
async function createWorktree(
  taskId: string,
  repoPath: string
): Promise<string | null> {
  // Try bd worktree first when beads is enabled
  if (useBeads) {
    try {
      // Check if worktree exists via beads
      const existing = await beadsRegistry.getWorktree(taskId);
      if (existing) {
        console.log(`ℹ️  Worktree for ${taskId} already exists`);
        return existing.path;
      }

      // Create via bd worktree (includes .beads redirect)
      const info = await beadsRegistry.createWorktree(taskId);
      if (info) {
        return info.path;
      }
      // Fall through to WorktreeManager if bd worktree fails
      console.log(`⚠️  bd worktree failed, falling back to git worktree`);
    } catch (error: any) {
      console.log(`⚠️  bd worktree error: ${error.message}, falling back`);
    }
  }

  // Fallback to WorktreeManager
  try {
    const manager = new WorktreeManager({
      baseDir: WORKTREE_BASE,
      repoPath,
    });

    // Check if worktree already exists
    if (await manager.worktreeExists(taskId)) {
      console.log(`ℹ️  Worktree for ${taskId} already exists`);
      return manager.getWorktreePath(taskId);
    }

    // Create new worktree with branch
    const info = await manager.createWorktree(taskId, true);
    return info.path;
  } catch (error: any) {
    console.error(`⚠️  Failed to create worktree: ${error.message}`);
    return null;
  }
}

/**
 * Spawn Claude worker in new pane
 */
async function spawnWorkerPane(
  session: string,
  workingDir: string
): Promise<{ paneId: string } | null> {
  try {
    // Find current window
    const sessionObj = await tmux.findSessionByName(session);
    if (!sessionObj) {
      console.error(`❌ Session "${session}" not found`);
      return null;
    }

    const windows = await tmux.listWindows(sessionObj.id);
    if (!windows || windows.length === 0) {
      console.error(`❌ No windows in session "${session}"`);
      return null;
    }

    const panes = await tmux.listPanes(windows[0].id);
    if (!panes || panes.length === 0) {
      console.error(`❌ No panes in session "${session}"`);
      return null;
    }

    // Split current pane horizontally (side by side)
    const newPane = await tmux.splitPane(
      panes[0].id,
      'horizontal',
      50,
      workingDir
    );

    if (!newPane) {
      console.error(`❌ Failed to create new pane`);
      return null;
    }

    return { paneId: newPane.id };
  } catch (error: any) {
    console.error(`❌ Error spawning worker pane: ${error.message}`);
    return null;
  }
}

/**
 * Start monitoring worker state and update registry
 * Updates both beads and JSON registry during transition
 */
function startWorkerMonitoring(
  workerId: string,
  session: string,
  paneId: string
): void {
  const monitor = new EventMonitor(session, {
    pollIntervalMs: 1000,
    paneId,
  });

  monitor.on('state_change', async (event) => {
    if (!event.state) return;

    let newState: registry.WorkerState;
    switch (event.state.type) {
      case 'working':
      case 'tool_use':
        newState = 'working';
        break;
      case 'idle':
        newState = 'idle';
        break;
      case 'permission':
        newState = 'permission';
        break;
      case 'question':
        newState = 'question';
        break;
      case 'error':
        newState = 'error';
        break;
      case 'complete':
        newState = 'done';
        break;
      default:
        return; // Don't update for unknown states
    }

    try {
      // Update both registries during transition
      if (useBeads) {
        await beadsRegistry.updateState(workerId, newState);
      }
      await registry.updateState(workerId, newState);
    } catch {
      // Ignore errors in background monitoring
    }
  });

  monitor.on('poll_error', () => {
    // Pane may have been killed - unregister worker
    if (useBeads) {
      beadsRegistry.unregister(workerId).catch(() => {});
    }
    registry.unregister(workerId).catch(() => {});
    monitor.stop();
  });

  monitor.start().catch(() => {
    // Session/pane not found - ignore
  });

  // Store monitor reference for cleanup (could be enhanced)
  // For now, monitoring is fire-and-forget
}

// ============================================================================
// Main Command
// ============================================================================

export async function workCommand(
  target: string,
  options: WorkOptions = {}
): Promise<void> {
  try {
    // Get current working directory as repo path
    const repoPath = process.cwd();

    // Ensure beads daemon is running for auto-sync
    if (useBeads) {
      const daemonStatus = await beadsRegistry.checkDaemonStatus();
      if (!daemonStatus.running) {
        console.log('🔄 Starting beads daemon for auto-sync...');
        const started = await beadsRegistry.startDaemon({ autoCommit: true });
        if (started) {
          console.log('   ✅ Daemon started');
        } else {
          console.log('   ⚠️  Daemon failed to start (non-fatal)');
        }
      }
    }

    // 1. Resolve target
    let issue: BeadsIssue | null = null;

    if (target === 'next') {
      console.log('🔍 Finding next ready issue...');
      issue = await getNextReadyIssue();
      if (!issue) {
        console.log('ℹ️  No ready issues. Run `bd ready` to see the queue.');
        return;
      }
      console.log(`📋 Found: ${issue.id} - "${issue.title}"`);
    } else if (target === 'wish') {
      console.error('❌ `term work wish` is not yet implemented. Coming in Phase 1.5.');
      process.exit(1);
    } else {
      // Validate bd-id exists
      issue = await getBeadsIssue(target);
      if (!issue) {
        console.error(`❌ Issue "${target}" not found. Run \`bd list\` to see issues.`);
        process.exit(1);
      }
    }

    const taskId = issue.id;

    // 2. Check not already assigned (check both registries)
    let existingWorker = useBeads
      ? await beadsRegistry.findByTask(taskId)
      : null;
    if (!existingWorker) {
      existingWorker = await registry.findByTask(taskId);
    }
    if (existingWorker) {
      console.error(`❌ ${taskId} already has a worker (pane ${existingWorker.paneId})`);
      console.log(`   Run \`term kill ${existingWorker.id}\` first, or work on a different issue.`);
      process.exit(1);
    }

    // 3. Get session
    const session = options.session || await getCurrentSession();
    if (!session) {
      console.error('❌ Not in a tmux session. Attach to a session first or use --session.');
      process.exit(1);
    }

    // 4. Claim in beads
    console.log(`📝 Claiming ${taskId}...`);
    const claimed = await claimIssue(taskId);
    if (!claimed) {
      console.error(`❌ Failed to claim ${taskId}. Check \`bd show ${taskId}\`.`);
      process.exit(1);
    }

    // 5. Create worktree (unless --no-worktree)
    let workingDir = repoPath;
    let worktreePath: string | null = null;

    if (!options.noWorktree) {
      console.log(`🌳 Creating worktree for ${taskId}...`);
      worktreePath = await createWorktree(taskId, repoPath);
      if (worktreePath) {
        workingDir = worktreePath;
        console.log(`   Created: ${worktreePath}`);
      } else {
        console.log(`⚠️  Worktree creation failed. Using shared repo.`);
      }
    }

    // 6. Spawn Claude pane
    console.log(`🚀 Spawning worker pane...`);
    const paneResult = await spawnWorkerPane(session, workingDir);
    if (!paneResult) {
      process.exit(1);
    }

    const { paneId } = paneResult;

    // 7. Register worker (write to both registries during transition)
    const worker: registry.Worker = {
      id: taskId,
      paneId,
      session,
      worktree: worktreePath,
      taskId,
      taskTitle: issue.title,
      startedAt: new Date().toISOString(),
      state: 'spawning',
      lastStateChange: new Date().toISOString(),
      repoPath,
    };

    // Register in beads (creates agent bead)
    if (useBeads) {
      try {
        const agentId = await beadsRegistry.ensureAgent(taskId, {
          paneId,
          session,
          worktree: worktreePath,
          repoPath,
          taskId,
          taskTitle: issue.title,
        });

        // Bind work to agent
        await beadsRegistry.bindWork(taskId, taskId);

        // Set initial state
        await beadsRegistry.setAgentState(taskId, 'spawning');
      } catch (error: any) {
        console.log(`⚠️  Beads registration failed: ${error.message} (non-fatal)`);
      }
    }

    // Also register in JSON registry (parallel operation during transition)
    await registry.register(worker);

    // 8. Start Claude in pane
    await tmux.executeCommand(paneId, 'claude', false, false);

    // Wait a bit for Claude to start
    await new Promise(r => setTimeout(r, 2000));

    // 9. Send initial prompt
    const prompt = options.prompt || `Work on beads issue ${taskId}: "${issue.title}"

Read the issue details with: bd show ${taskId}

When you're done, commit your changes and let me know.`;

    await tmux.executeCommand(paneId, prompt, false, false);

    // 10. Update state to working (both registries)
    if (useBeads) {
      await beadsRegistry.setAgentState(taskId, 'working').catch(() => {});
    }
    await registry.updateState(taskId, 'working');

    // 11. Start monitoring
    startWorkerMonitoring(taskId, session, paneId);

    // 12. Focus pane (unless disabled)
    if (options.focus !== false) {
      await tmux.executeTmux(`select-pane -t '${paneId}'`);
    }

    console.log(`\n✅ Worker started for ${taskId}`);
    console.log(`   Pane: ${paneId}`);
    console.log(`   Session: ${session}`);
    if (worktreePath) {
      console.log(`   Worktree: ${worktreePath}`);
    }
    console.log(`\nCommands:`);
    console.log(`   term workers        - Check worker status`);
    console.log(`   term approve ${taskId}  - Approve permissions`);
    console.log(`   term close ${taskId}    - Close issue when done`);
    console.log(`   term kill ${taskId}     - Force kill worker`);

  } catch (error: any) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
}
