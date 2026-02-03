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
 *   --focus               - Focus the worker pane (default: false)
 *   --resume              - Resume previous Claude session if available (default: true)
 *   --no-resume           - Start fresh session even if previous exists
 */

import { $ } from 'bun';
import { randomUUID } from 'crypto';
import * as tmux from '../lib/tmux.js';
import * as registry from '../lib/worker-registry.js';
import * as beadsRegistry from '../lib/beads-registry.js';
import { getBackend } from '../lib/task-backend.js';
import { EventMonitor } from '../lib/orchestrator/index.js';
import { join } from 'path';

// Use beads registry only when enabled AND bd exists on PATH
// (macro repos like blanco may run without bd)
// @ts-ignore
const useBeads = beadsRegistry.isBeadsRegistryEnabled() && (typeof (Bun as any).which === 'function' ? Boolean((Bun as any).which('bd')) : true);

// ============================================================================
// Types
// ============================================================================

export interface WorkOptions {
  noWorktree?: boolean;
  session?: string;
  focus?: boolean;
  prompt?: string;
  /** Resume previous Claude session if available */
  resume?: boolean;
}

interface BeadsIssue {
  id: string;
  title: string;
  status: string;
  description?: string;
  blockedBy?: string[];
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
    const parsed = JSON.parse(stdout);
    // bd show --json returns an array with single element
    const issue = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!issue) return null;
    return {
      id: issue.id,
      title: issue.title || issue.description?.substring(0, 50) || 'Untitled',
      status: issue.status,
      description: issue.description,
      blockedBy: issue.blockedBy || [],
    };
  } catch {
    return null;
  }
}

/**
 * Get next ready beads issue
 */
async function getNextReadyIssue(repoPath: string): Promise<BeadsIssue | null> {
  // If local backend is active, use its queue and synthesize a BeadsIssue-like object.
  const backend = getBackend(repoPath);
  if (backend.kind === 'local') {
    const q = await backend.queue();
    if (q.ready.length === 0) return null;
    const id = q.ready[0];
    const t = await backend.get(id);
    if (!t) return null;
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      description: t.description,
      blockedBy: t.blockedBy || [],
    };
  }

  // beads backend
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
        description: issue.description,
        blockedBy: issue.blockedBy || [],
      };
    }
    return null;
  } catch {
    const lines = stdout.split('\n').filter(l => l.trim());
    if (lines.length > 0) {
      const match = lines[0].match(/^(bd-\d+)/);
      if (match) return getBeadsIssue(match[1]);
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
 * Create worktree for worker in .genie/worktrees/<taskId>
 * Creates a .genie redirect file so bd commands work in the worktree
 */
async function createWorktree(
  taskId: string,
  repoPath: string
): Promise<string | null> {
  const fs = await import('fs/promises');
  const worktreeDir = join(repoPath, WORKTREE_DIR_NAME);
  const worktreePath = join(worktreeDir, taskId);

  // Ensure .genie/worktrees exists
  try {
    await fs.mkdir(worktreeDir, { recursive: true });
  } catch {
    // Directory may already exist
  }

  // Check if worktree already exists
  try {
    const stat = await fs.stat(worktreePath);
    if (stat.isDirectory()) {
      console.log(`ℹ️  Worktree for ${taskId} already exists`);
      return worktreePath;
    }
  } catch {
    // Doesn't exist, will create
  }

  // Create worktree using git directly (with branch)
  const branchName = `work/${taskId}`;
  try {
    // Create branch if it doesn't exist (ignore error if it already exists)
    try {
      await $`git -C ${repoPath} branch ${branchName}`.quiet();
    } catch {
      // Branch may already exist, that's ok
    }

    // Create worktree
    await $`git -C ${repoPath} worktree add ${worktreePath} ${branchName}`.quiet();

    // Set up .genie redirect so bd commands work in the worktree
    const genieRedirect = join(worktreePath, '.genie');
    await fs.mkdir(genieRedirect, { recursive: true });
    await fs.writeFile(join(genieRedirect, 'redirect'), join(repoPath, '.genie'));

    return worktreePath;
  } catch (error: any) {
    console.error(`⚠️  Failed to create worktree: ${error.message}`);
    return null;
  }
}

/**
 * Remove worktree for a worker
 */
async function removeWorktree(taskId: string, repoPath: string): Promise<void> {
  const worktreePath = join(repoPath, WORKTREE_DIR_NAME, taskId);

  try {
    // Remove worktree
    await $`git -C ${repoPath} worktree remove ${worktreePath} --force`.quiet();
  } catch {
    // Ignore errors - worktree may already be removed
  }
}

/**
 * Wait for Claude CLI to be ready to accept input
 * Polls pane content looking for Claude's input prompt indicator
 */
async function waitForClaudeReady(
  paneId: string,
  timeoutMs: number = 30000,
  pollIntervalMs: number = 500
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const content = await tmux.capturePaneContent(paneId, 50);

      // Claude CLI shows ">" prompt when ready for input
      // Also check for the input area indicator
      // The prompt appears at the end of output when Claude is waiting for input
      const lines = content.split('\n').filter(l => l.trim());
      if (lines.length > 0) {
        const lastFewLines = lines.slice(-5).join('\n');
        // Claude shows "❯" prompt when ready for input
        // Also detect welcome messages or input hints
        if (
          lastFewLines.includes('❯') ||
          lastFewLines.includes('? for shortcuts') ||
          lastFewLines.includes('What would you like') ||
          lastFewLines.includes('How can I help')
        ) {
          return true;
        }
      }
    } catch {
      // Pane may not exist yet, continue polling
    }

    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  // Timeout - return false but don't fail (caller can decide)
  return false;
}

/**
 * Spawn Claude worker in new pane (splits the CURRENT active pane)
 */
async function spawnWorkerPane(
  session: string,
  workingDir: string
): Promise<{ paneId: string } | null> {
  try {
    // Find session
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

    // Find the ACTIVE window (not first window)
    const activeWindow = windows.find(w => w.active) || windows[0];

    const panes = await tmux.listPanes(activeWindow.id);
    if (!panes || panes.length === 0) {
      console.error(`❌ No panes in window "${activeWindow.name}"`);
      return null;
    }

    // Find the ACTIVE pane (not first pane)
    const activePane = panes.find(p => p.active) || panes[0];

    // Split current pane horizontally (side by side)
    const newPane = await tmux.splitPane(
      activePane.id,
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
      issue = await getNextReadyIssue(repoPath);
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
      // If worker exists and has a session ID, offer to resume
      if (existingWorker.claudeSessionId && options.resume !== false) {
        console.log(`📋 Found existing worker for ${taskId} with resumable session`);
        console.log(`   Session ID: ${existingWorker.claudeSessionId}`);
        console.log(`   Resuming previous Claude session...`);

        // Get session
        const session = options.session || await getCurrentSession();
        if (!session) {
          console.error('❌ Not in a tmux session. Attach to a session first or use --session.');
          process.exit(1);
        }

        // Spawn a new pane for the resumed session
        const workingDir = existingWorker.worktree || existingWorker.repoPath;
        console.log(`🚀 Spawning worker pane...`);
        const paneResult = await spawnWorkerPane(session, workingDir);
        if (!paneResult) {
          process.exit(1);
        }

        const { paneId } = paneResult;

        // Update worker with new pane ID
        await registry.update(existingWorker.id, {
          paneId,
          session,
          state: 'spawning',
          lastStateChange: new Date().toISOString(),
        });
        if (useBeads) {
          await beadsRegistry.setAgentState(existingWorker.id, 'spawning').catch(() => {});
        }

        // Set BEADS_DIR so bd commands work in the worktree
        const beadsDir = join(existingWorker.repoPath, '.genie');
        const escapedWorkingDir = workingDir.replace(/'/g, "'\\''");

        // Resume Claude with the stored session ID
        await tmux.executeCommand(
          paneId,
          `cd '${escapedWorkingDir}' && BEADS_DIR='${beadsDir}' claude --resume '${existingWorker.claudeSessionId}'`,
          true,
          false
        );

        // Update state to working
        if (useBeads) {
          await beadsRegistry.setAgentState(existingWorker.id, 'working').catch(() => {});
        }
        await registry.updateState(existingWorker.id, 'working');

        // Start monitoring
        startWorkerMonitoring(existingWorker.id, session, paneId);

        // Focus pane (only if explicitly requested)
        if (options.focus === true) {
          await tmux.executeTmux(`select-pane -t '${paneId}'`);
        }

        console.log(`\n✅ Resumed worker for ${taskId}`);
        console.log(`   Pane: ${paneId}`);
        console.log(`   Session: ${session}`);
        console.log(`   Claude Session: ${existingWorker.claudeSessionId}`);
        console.log(`\nCommands:`);
        console.log(`   term workers        - Check worker status`);
        console.log(`   term approve ${taskId}  - Approve permissions`);
        console.log(`   term close ${taskId}    - Close issue when done`);
        console.log(`   term kill ${taskId}     - Force kill worker`);
        return;
      }

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

    // 4. Claim task (backend-dependent)
    console.log(`📝 Claiming ${taskId}...`);
    const backend = getBackend(repoPath);
    const claimed = await (backend.kind === 'local' ? backend.claim(taskId) : claimIssue(taskId));
    if (!claimed) {
      console.error(`❌ Failed to claim ${taskId}.`);
      if (backend.kind === 'beads') {
        console.error(`   Check \`bd show ${taskId}\`.`);
      } else {
        console.error(`   Check .genie/tasks.json`);
      }
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

    // 7. Generate Claude session ID for resume capability
    const claudeSessionId = randomUUID();

    // 8. Register worker (write to both registries during transition)
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
      claudeSessionId,
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
          claudeSessionId,
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

    // 9. Build prompt and start Claude with it as argument
    const prompt = options.prompt || `Work on beads issue ${taskId}: "${issue.title}"

## Description
${issue.description || 'No description provided.'}

When you're done, commit your changes and let me know.`;

    // Escape the prompt for shell (single quotes)
    const escapedPrompt = prompt.replace(/'/g, "'\\''");

    // Set BEADS_DIR so bd commands work in the worktree
    const beadsDir = join(repoPath, '.genie');

    // Escape workingDir for shell
    const escapedWorkingDir = workingDir.replace(/'/g, "'\\''");

    // Start Claude with session ID for resume capability
    // First cd to correct directory (shell rc files may have overridden tmux -c)
    await tmux.executeCommand(paneId, `cd '${escapedWorkingDir}' && BEADS_DIR='${beadsDir}' claude --session-id '${claudeSessionId}' '${escapedPrompt}'`, true, false);

    console.log(`   Session ID: ${claudeSessionId}`);

    // 10. Update state to working (both registries)
    if (useBeads) {
      await beadsRegistry.setAgentState(taskId, 'working').catch(() => {});
    }
    await registry.updateState(taskId, 'working');

    // 11. Start monitoring
    startWorkerMonitoring(taskId, session, paneId);

    // 12. Focus pane (only if explicitly requested)
    if (options.focus === true) {
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
