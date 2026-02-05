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
 *   --skill <name>        - Skill to invoke (e.g., 'forge'). Auto-detects 'forge' if wish.md exists.
 *   --repo <path>         - Target a specific nested repo (e.g., 'code/genie-cli')
 *   --profile <name>      - Worker profile to use (from ~/.genie/config.json workerProfiles)
 */

import { $ } from 'bun';
import { randomUUID } from 'crypto';
import * as tmux from '../lib/tmux.js';
import * as registry from '../lib/worker-registry.js';
import * as beadsRegistry from '../lib/beads-registry.js';
import { getBackend } from '../lib/task-backend.js';
import { EventMonitor } from '../lib/orchestrator/index.js';
import { cleanupEventFile } from './events.js';
import { join, resolve, isAbsolute } from 'path';
import { getWorktreeManager } from '../lib/worktree-manager.js';
import { buildSpawnCommand } from '../lib/spawn-command.js';
import { loadGenieConfig, getWorkerProfile, getDefaultWorkerProfile } from '../lib/genie-config.js';
import type { WorkerProfile } from '../types/genie-config.js';

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
  /** Skill to invoke (e.g., 'forge'). Auto-detected from wish.md if not specified. */
  skill?: string;
  /** Target a specific nested repo (e.g., 'code/genie-cli') */
  repo?: string;
  /** Disable auto-approve for this worker */
  noAutoApprove?: boolean;
  /** Worker profile to use (from ~/.genie/config.json workerProfiles) */
  profile?: string;
}

/**
 * Parsed wish metadata from wish.md
 */
interface WishMetadata {
  title?: string;
  status?: string;
  slug?: string;
  repo?: string;
  description?: string;
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

/**
 * Known nested repo patterns for heuristic detection
 * Maps keywords in wish title/description to relative repo paths
 */
const KNOWN_NESTED_REPOS: Record<string, string> = {
  'genie-cli': 'code/genie-cli',
  'term-cli': 'code/genie-cli',
  'term work': 'code/genie-cli',
  'term ship': 'code/genie-cli',
  'term push': 'code/genie-cli',
};

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
 * Parse wish.md file for metadata including repo field
 */
async function parseWishMetadata(wishPath: string): Promise<WishMetadata> {
  const fs = await import('fs/promises');
  const metadata: WishMetadata = {};

  try {
    const content = await fs.readFile(wishPath, 'utf-8');
    const lines = content.split('\n');

    // Parse title from first heading
    const titleMatch = lines[0]?.match(/^#\s+(?:Wish\s+\d+:\s+)?(.+)$/i);
    if (titleMatch) {
      metadata.title = titleMatch[1].trim();
    }

    // Parse metadata fields like **Status:**, **Slug:**, **repo:** etc.
    for (const line of lines.slice(0, 20)) { // Only check first 20 lines
      const statusMatch = line.match(/^\*\*Status:\*\*\s*(.+)$/i);
      if (statusMatch) {
        metadata.status = statusMatch[1].trim();
        continue;
      }

      const slugMatch = line.match(/^\*\*Slug:\*\*\s*`?([^`]+)`?$/i);
      if (slugMatch) {
        metadata.slug = slugMatch[1].trim();
        continue;
      }

      // Match repo: field (case insensitive)
      const repoMatch = line.match(/^\*\*repo:\*\*\s*`?([^`]+)`?$/i);
      if (repoMatch) {
        metadata.repo = repoMatch[1].trim();
        continue;
      }
    }

    // Get description from Summary section if present
    const summaryIndex = content.indexOf('## Summary');
    if (summaryIndex !== -1) {
      const afterSummary = content.slice(summaryIndex + 10);
      const nextSection = afterSummary.indexOf('\n## ');
      const summaryContent = nextSection !== -1
        ? afterSummary.slice(0, nextSection)
        : afterSummary.slice(0, 500);
      metadata.description = summaryContent.trim();
    }

    return metadata;
  } catch {
    return metadata;
  }
}

/**
 * Detect target repo using heuristics from wish title and description
 * Returns relative path to nested repo or null if no match
 */
async function detectRepoFromHeuristics(
  title: string,
  description: string | undefined,
  repoPath: string
): Promise<string | null> {
  const fs = await import('fs/promises');
  const searchText = `${title} ${description || ''}`.toLowerCase();

  for (const [keyword, relativePath] of Object.entries(KNOWN_NESTED_REPOS)) {
    if (searchText.includes(keyword.toLowerCase())) {
      // Verify the path exists and is a git repo
      const fullPath = join(repoPath, relativePath);
      try {
        const gitPath = join(fullPath, '.git');
        await fs.access(gitPath);
        return relativePath;
      } catch {
        // Path doesn't exist or isn't a git repo, continue checking
      }
    }
  }

  return null;
}

/**
 * Detect the target repository for worktree creation
 *
 * Priority order:
 * 1. Explicit --repo flag
 * 2. repo: field in wish.md metadata
 * 3. Heuristic detection from wish title/description
 * 4. Default: use current repo (repoPath)
 *
 * @returns Absolute path to the target repository
 */
async function detectTargetRepo(
  taskId: string,
  repoPath: string,
  explicitRepo?: string,
  issueTitle?: string,
  issueDescription?: string
): Promise<{ targetRepo: string; detectionMethod: string }> {
  // 1. Explicit --repo flag takes priority
  if (explicitRepo) {
    const targetPath = isAbsolute(explicitRepo)
      ? explicitRepo
      : resolve(repoPath, explicitRepo);
    return { targetRepo: targetPath, detectionMethod: '--repo flag' };
  }

  // 2. Check wish.md for repo: field
  const wishPath = join(repoPath, '.genie', 'wishes', taskId, 'wish.md');
  const metadata = await parseWishMetadata(wishPath);

  if (metadata.repo) {
    const targetPath = isAbsolute(metadata.repo)
      ? metadata.repo
      : resolve(repoPath, metadata.repo);
    return { targetRepo: targetPath, detectionMethod: 'wish.md repo: field' };
  }

  // 3. Heuristic detection from title/description
  const title = metadata.title || issueTitle || '';
  const description = metadata.description || issueDescription || '';
  const heuristicPath = await detectRepoFromHeuristics(title, description, repoPath);

  if (heuristicPath) {
    const targetPath = resolve(repoPath, heuristicPath);
    return { targetRepo: targetPath, detectionMethod: `heuristic (matched "${heuristicPath}")` };
  }

  // 4. Default: use current repo
  return { targetRepo: repoPath, detectionMethod: 'default (current repo)' };
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
 * Create worktree for worker using WorktreeManager
 * Creates worktree in .genie/worktrees/<taskId> with branch work/<taskId>
 */
async function createWorktreeForTask(
  taskId: string,
  repoPath: string
): Promise<string | null> {
  try {
    const manager = await getWorktreeManager(repoPath);
    const info = await manager.create(taskId, repoPath);
    return info.path;
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
 * Check if a wish.md file exists for the given task
 */
async function wishFileExists(taskId: string, repoPath: string): Promise<boolean> {
  const fs = await import('fs/promises');
  const wishPath = join(repoPath, '.genie', 'wishes', taskId, 'wish.md');
  try {
    await fs.access(wishPath);
    return true;
  } catch {
    return false;
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
 * Ensure a dedicated tmux window exists for the task and return pane 0.
 * Idempotent: if the window already exists, returns its first pane.
 */
async function ensureWorkerWindow(
  session: string,
  taskId: string,
  workingDir: string
): Promise<{ paneId: string; windowCreated: boolean } | null> {
  try {
    // Find session
    const sessionObj = await tmux.findSessionByName(session);
    if (!sessionObj) {
      console.error(`❌ Session "${session}" not found`);
      return null;
    }

    // Check if window already exists for this task
    const existingWindow = await tmux.findWindowByName(sessionObj.id, taskId);
    if (existingWindow) {
      // Window exists -- get pane 0
      const panes = await tmux.listPanes(existingWindow.id);
      if (!panes || panes.length === 0) {
        console.error(`❌ No panes in existing window "${taskId}"`);
        return null;
      }
      return { paneId: panes[0].id, windowCreated: false };
    }

    // Create new window named after the task
    const newWindow = await tmux.createWindow(sessionObj.id, taskId, workingDir);
    if (!newWindow) {
      console.error(`❌ Failed to create window "${taskId}"`);
      return null;
    }

    // Get pane 0 of the new window
    const panes = await tmux.listPanes(newWindow.id);
    if (!panes || panes.length === 0) {
      console.error(`❌ No panes in new window "${taskId}"`);
      return null;
    }

    return { paneId: panes[0].id, windowCreated: true };
  } catch (error: any) {
    console.error(`❌ Error ensuring worker window: ${error.message}`);
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
    // Cleanup event file
    cleanupEventFile(paneId).catch(() => {});
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

    // Load and validate worker profile (before creating pane)
    const config = await loadGenieConfig();
    let workerProfile: WorkerProfile | undefined;

    if (options.profile) {
      workerProfile = getWorkerProfile(config, options.profile);
      if (!workerProfile) {
        const available = Object.keys(config.workerProfiles || {});
        console.error(`Profile '${options.profile}' not found.`);
        if (available.length > 0) {
          console.log(`Available profiles: ${available.join(', ')}`);
        } else {
          console.log('No profiles configured in ~/.genie/config.json');
        }
        process.exit(1);
      }
    } else {
      workerProfile = getDefaultWorkerProfile(config);
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
      // Check local backend first, then fall back to beads
      const backend = getBackend(repoPath);
      if (backend.kind === 'local') {
        const localTask = await backend.get(target);
        if (localTask) {
          issue = {
            id: localTask.id,
            title: localTask.title,
            status: localTask.status,
            description: localTask.description,
            blockedBy: localTask.blockedBy || [],
          };
        }
      }
      
      // Fall back to beads if not found locally
      if (!issue) {
        issue = await getBeadsIssue(target);
      }
      
      if (!issue) {
        const backend = getBackend(repoPath);
        if (backend.kind === 'local') {
          console.error(`❌ Issue "${target}" not found. Check \`.genie/tasks.json\`.`);
        } else {
          console.error(`❌ Issue "${target}" not found. Run \`bd list\` to see issues.`);
        }
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

        // Ensure dedicated window for the resumed session
        const workingDir = existingWorker.worktree || existingWorker.repoPath;
        console.log(`🚀 Ensuring worker window...`);
        const paneResult = await ensureWorkerWindow(session, taskId, workingDir);
        if (!paneResult) {
          process.exit(1);
        }

        const { paneId } = paneResult;

        // Update worker with new pane ID and window name
        await registry.update(existingWorker.id, {
          paneId,
          session,
          windowName: taskId,
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
        // Uses profile configuration if available
        const resumeCmd = buildSpawnCommand(workerProfile, {
          resume: existingWorker.claudeSessionId,
          beadsDir,
        });
        await tmux.executeCommand(
          paneId,
          `cd '${escapedWorkingDir}' && ${resumeCmd}`,
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

        // Focus window (only if explicitly requested)
        if (options.focus === true) {
          await tmux.executeTmux(`select-window -t '${session}:${taskId}'`);
        }

        console.log(`\n✅ Resumed worker for ${taskId}`);
        console.log(`   Window: ${taskId}`);
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

    // 5. Detect target repo for worktree creation
    const { targetRepo, detectionMethod } = await detectTargetRepo(
      taskId,
      repoPath,
      options.repo,
      issue.title,
      issue.description
    );

    // Log if using a nested repo
    if (targetRepo !== repoPath) {
      console.log(`🎯 Detected nested repo: ${targetRepo}`);
      console.log(`   Detection: ${detectionMethod}`);
    }

    // 6. Create worktree (unless --no-worktree)
    let workingDir = targetRepo;
    let worktreePath: string | null = null;

    if (!options.noWorktree) {
      console.log(`🌳 Creating worktree for ${taskId} in ${targetRepo}...`);
      worktreePath = await createWorktreeForTask(taskId, targetRepo);
      if (worktreePath) {
        workingDir = worktreePath;
        console.log(`   Created: ${worktreePath}`);
        console.log(`   Branch: work/${taskId}`);
      } else {
        console.log(`⚠️  Worktree creation failed. Using shared repo.`);
      }
    }

    // 7. Ensure dedicated window for worker
    console.log(`🚀 Creating worker window "${taskId}"...`);
    const paneResult = await ensureWorkerWindow(session, taskId, workingDir);
    if (!paneResult) {
      process.exit(1);
    }

    const { paneId } = paneResult;

    // 8. Generate Claude session ID for resume capability
    const claudeSessionId = randomUUID();

    // 9. Register worker (write to both registries during transition)
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
      repoPath: targetRepo, // Store the target repo, not the macro repo
      claudeSessionId,
      windowName: taskId,
    };

    // Register in beads (creates agent bead)
    if (useBeads) {
      try {
        const agentId = await beadsRegistry.ensureAgent(taskId, {
          paneId,
          session,
          worktree: worktreePath,
          repoPath: targetRepo,
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

    // 10. Detect skill and build prompt
    // If --skill is explicitly set, use that. Otherwise check for wish.md to auto-detect forge.
    let skill = options.skill;
    if (!skill && !options.prompt) {
      const hasWish = await wishFileExists(taskId, repoPath);
      if (hasWish) {
        skill = 'forge';
        console.log(`📋 Found wish.md - using /forge skill`);
      }
    }

    // Build prompt: if skill is set, use /<skill>, otherwise use default or custom prompt
    let prompt: string;
    if (skill) {
      prompt = `/${skill}`;
    } else {
      prompt = options.prompt || `Work on beads issue ${taskId}: "${issue.title}"

## Description
${issue.description || 'No description provided.'}

When you're done, commit your changes and let me know.`;
    }

    // Escape the prompt for shell (single quotes)
    const escapedPrompt = prompt.replace(/'/g, "'\\''");

    // Set BEADS_DIR so bd commands work in the worktree
    const beadsDir = join(repoPath, '.genie');

    // Escape workingDir for shell
    const escapedWorkingDir = workingDir.replace(/'/g, "'\\''");

    // Start Claude with session ID for resume capability (without prompt)
    // First cd to correct directory (shell rc files may have overridden tmux -c)
    // Uses profile configuration if available
    const spawnCmd = buildSpawnCommand(workerProfile, {
      sessionId: claudeSessionId,
      beadsDir,
    });
    await tmux.executeCommand(paneId, `cd '${escapedWorkingDir}' && ${spawnCmd}`, true, false);

    console.log(`   Session ID: ${claudeSessionId}`);

    // Wait for Claude to be ready, then send prompt via send-keys
    // This avoids shell argument length limits and escaping issues
    const ready = await waitForClaudeReady(paneId);
    if (!ready) {
      console.log('   (Claude startup timed out, sending prompt anyway)');
    }
    await tmux.executeTmux(`send-keys -t '${paneId}' '${escapedPrompt}' Enter`);

    // 11. Update state to working (both registries)
    if (useBeads) {
      await beadsRegistry.setAgentState(taskId, 'working').catch(() => {});
    }
    await registry.updateState(taskId, 'working');

    // 12. Start monitoring
    startWorkerMonitoring(taskId, session, paneId);

    // 13. Focus window (only if explicitly requested)
    if (options.focus === true) {
      await tmux.executeTmux(`select-window -t '${session}:${taskId}'`);
    }

    console.log(`\n✅ Worker started for ${taskId}`);
    console.log(`   Window: ${taskId}`);
    console.log(`   Pane: ${paneId}`);
    console.log(`   Session: ${session}`);
    if (worktreePath) {
      console.log(`   Worktree: ${worktreePath}`);
      console.log(`   Branch: work/${taskId}`);
    }
    if (targetRepo !== repoPath) {
      console.log(`   Target repo: ${targetRepo}`);
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
