/**
 * Work command - Spawn worker bound to beads issue
 *
 * Usage:
 *   genie work <bd-id>     - Work on specific beads issue
 *   genie work next        - Work on next ready issue
 *   genie work wish        - Create a new wish (deferred)
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

import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { $ } from 'bun';
import * as registry from '../lib/agent-registry.js';
import { type AutoApproveEngine, createAutoApproveEngine, sendApprovalViaTmux } from '../lib/auto-approve-engine.js';
import { loadFullAutoApproveConfig } from '../lib/auto-approve.js';
import * as beadsRegistry from '../lib/beads-registry.js';
import type { PermissionRequest } from '../lib/event-listener.js';
import { getDefaultWorkerProfile, getSessionName, getWorkerProfile, loadGenieConfig } from '../lib/genie-config.js';
import { EventMonitor } from '../lib/orchestrator/index.js';
import { extractPermissionDetails } from '../lib/orchestrator/state-detector.js';
import { buildSpawnCommand } from '../lib/spawn-command.js';
import { getBackend } from '../lib/task-backend.js';
import * as tmux from '../lib/tmux.js';
import { getWorktreeManager } from '../lib/worktree-manager.js';
import type { WorkerProfile } from '../types/genie-config.js';
import { cleanupEventFile } from './events.js';

// Use beads registry only when enabled AND bd exists on PATH
// (macro repos like blanco may run without bd)
const useBeads =
  beadsRegistry.isBeadsRegistryEnabled() &&
  (() => {
    const BunExt = Bun as unknown as { which?: (name: string) => string | null };
    return typeof BunExt.which === 'function' ? Boolean(BunExt.which('bd')) : true;
  })();

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
  /** Custom worker name (for N workers per task) */
  name?: string;
  /** Worker role (for N workers per task, e.g., "main", "tests", "review") */
  role?: string;
  /** Share worktree with existing worker on same task */
  sharedWorktree?: boolean;
  /** Internal: skip auto-approve blocking loop (used by spawn-parallel) */
  _skipAutoApproveBlock?: boolean;
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

/**
 * Known nested repo patterns for heuristic detection
 * Maps keywords in wish title/description to relative repo paths
 */
const KNOWN_NESTED_REPOS: Record<string, string> = {
  'genie-cli': 'code/genie-cli',
  'genie work': 'code/genie-cli',
  'genie worker': 'code/genie-cli',
};

// ============================================================================
// Env Loading Helpers
// ============================================================================

/**
 * Build a shell prefix that sources .env from the root repo when running in a worktree.
 * Returns empty string when workingDir === repoPath (not in a worktree).
 *
 * Pattern: [ -f '/root/.env' ] && set -a && source '/root/.env' && set +a;
 * - `set -a` causes all subsequently defined variables to be exported
 * - `source` reads the .env file
 * - `set +a` disables auto-export
 */
export function buildEnvSourcePrefix(workingDir: string, repoPath: string): string {
  if (workingDir === repoPath) {
    return '';
  }
  const escapedRepoPath = repoPath.replace(/'/g, "'\\''");
  return `[ -f '${escapedRepoPath}/.env' ] && set -a && source '${escapedRepoPath}/.env' && set +a; `;
}

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
  } catch (error) {
    const shellErr = error as { stdout?: Buffer; exitCode?: number };
    return { stdout: shellErr.stdout?.toString().trim() || '', exitCode: shellErr.exitCode || 1 };
  }
}

/**
 * Validate and sanitize a task ID for safe use in shell commands, git branch names, and file paths.
 * Returns the sanitized ID or null if the input is fundamentally unsafe.
 */
function sanitizeTaskId(raw: string): string | null {
  if (!raw || raw.length > 128) return null;
  // Strip leading/trailing whitespace
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Only allow alphanumeric, hyphens, underscores, dots, and slashes (for bd-style IDs like "genie-8bu")
  // Reject anything that could be shell metacharacters or git-invalid
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._\-/]*$/.test(trimmed)) return null;
  // Reject prototype pollution keys
  if (trimmed === '__proto__' || trimmed === 'constructor' || trimmed === 'prototype') return null;
  // Reject git-invalid patterns (double dots, trailing dots/slashes, lock suffix)
  if (/\.\./.test(trimmed) || /[./]$/.test(trimmed) || /\.lock$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Parse raw beads issue JSON into a BeadsIssue object.
 */
function parseBeadsIssue(data: unknown): BeadsIssue | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  return {
    id: d.id as string,
    title: (d.title as string) || (d.description as string)?.substring(0, 50) || 'Untitled',
    status: d.status as string,
    description: d.description as string | undefined,
    blockedBy: (d.blockedBy as string[]) || [],
  };
}

/**
 * Get a beads issue by ID.
 */
async function getBeadsIssue(id: string): Promise<BeadsIssue | null> {
  const { stdout, exitCode } = await runBd(['show', id, '--json']);

  if (exitCode === 0 && stdout) {
    try {
      const parsed = JSON.parse(stdout);
      const issue = Array.isArray(parsed) ? parsed[0] : parsed;
      return parseBeadsIssue(issue);
    } catch {
      // JSON parse failed
    }
  }

  return null;
}

/**
 * Parse beads `bd ready --json` output into a BeadsIssue.
 * Falls back to line-based parsing when JSON is invalid.
 */
async function parseBeadsReadyOutput(stdout: string): Promise<BeadsIssue | null> {
  try {
    const issues = JSON.parse(stdout);
    if (!Array.isArray(issues) || issues.length === 0) return null;
    const issue = issues[0];
    return {
      id: issue.id,
      title: issue.title || issue.description?.substring(0, 50) || 'Untitled',
      status: issue.status,
      description: issue.description,
      blockedBy: issue.blockedBy || [],
    };
  } catch {
    // JSON parse failed — try line-based fallback
    const lines = stdout.split('\n').filter((l) => l.trim());
    if (lines.length === 0) return null;
    const match = lines[0].match(/^(bd-\d+)/);
    return match ? getBeadsIssue(match[1]) : null;
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
  return parseBeadsReadyOutput(stdout);
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
  const fs = await import('node:fs/promises');
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
    for (const line of lines.slice(0, 20)) {
      // Only check first 20 lines
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
      }
    }

    // Get description from Summary section if present
    const summaryIndex = content.indexOf('## Summary');
    if (summaryIndex !== -1) {
      const afterSummary = content.slice(summaryIndex + 10);
      const nextSection = afterSummary.indexOf('\n## ');
      const summaryContent = nextSection !== -1 ? afterSummary.slice(0, nextSection) : afterSummary.slice(0, 500);
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
  repoPath: string,
): Promise<string | null> {
  const fs = await import('node:fs/promises');
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
  issueDescription?: string,
): Promise<{ targetRepo: string; detectionMethod: string }> {
  // 1. Explicit --repo flag takes priority
  if (explicitRepo) {
    const targetPath = isAbsolute(explicitRepo) ? explicitRepo : resolve(repoPath, explicitRepo);
    return { targetRepo: targetPath, detectionMethod: '--repo flag' };
  }

  // 2. Check wish.md for repo: field
  const wishPath = join(repoPath, '.genie', 'wishes', taskId, 'wish.md');
  const metadata = await parseWishMetadata(wishPath);

  if (metadata.repo) {
    const targetPath = isAbsolute(metadata.repo) ? metadata.repo : resolve(repoPath, metadata.repo);
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
 * Get or create a tmux session.
 * If already in a tmux session, returns the current session name.
 * Otherwise, auto-creates a new detached session using the configured name.
 */
async function getOrCreateSession(sessionOption?: string): Promise<string> {
  // If session was explicitly provided via --session, use that
  if (sessionOption) return sessionOption;

  // Try to get the current session (works when inside tmux)
  const current = await getCurrentSession();
  if (current) return current;

  // Not inside tmux — auto-create a detached session
  const configName = getSessionName(); // defaults to "genie"
  const sessionName = configName || 'genie-workers';

  // Check if a session with this name already exists
  const existing = await tmux.findSessionByName(sessionName);
  if (existing) {
    console.log(`📺 Found existing tmux session '${sessionName}'. Attach with: tmux attach -t ${sessionName}`);
    return sessionName;
  }

  // Create a new detached session
  const created = await tmux.createSession(sessionName);
  if (!created) {
    console.error('❌ Failed to create tmux session. Is tmux installed?');
    process.exit(1);
  }

  console.log(`📺 Created tmux session '${sessionName}'. Attach with: tmux attach -t ${sessionName}`);
  return sessionName;
}

/**
 * Create worktree for worker using WorktreeManager
 * Creates worktree in .genie/worktrees/<taskId> with branch work/<taskId>
 */
async function createWorktreeForTask(taskId: string, repoPath: string): Promise<string | null> {
  try {
    const manager = await getWorktreeManager(repoPath);
    const info = await manager.create(taskId, repoPath);
    return info.path;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`⚠️  Failed to create worktree: ${message}`);
    return null;
  }
}

/**
 * Search .wishes/ directory recursively for a *-wish.md file
 * whose content references the given taskId in a Beads field.
 * Returns the file path if found, undefined otherwise.
 */
export async function findWishInDotWishes(taskId: string, repoPath: string): Promise<string | undefined> {
  const fs = await import('node:fs/promises');
  const wishesDir = join(repoPath, '.wishes');
  try {
    await fs.access(wishesDir);
  } catch {
    return undefined;
  }

  // Recursively find all *-wish.md files
  async function findWishFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return results;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await findWishFiles(fullPath)));
      } else if (entry.isFile() && entry.name.endsWith('-wish.md')) {
        results.push(fullPath);
      }
    }
    return results;
  }

  const wishFiles = await findWishFiles(wishesDir);
  // Patterns to match: **Beads:** <taskId> or Beads: <taskId>
  const patterns = [
    new RegExp(`\\*\\*Beads:\\*\\*\\s*${escapeRegExp(taskId)}`),
    new RegExp(`^Beads:\\s*${escapeRegExp(taskId)}`, 'm'),
  ];

  for (const filePath of wishFiles) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      for (const pattern of patterns) {
        if (pattern.test(content)) {
          return filePath;
        }
      }
    } catch {
      // Skip unreadable files
    }
  }
  return undefined;
}

/**
 * Escape special regex characters in a string
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check if a wish.md file exists for the given task.
 * First checks .genie/wishes/<taskId>/wish.md (fast path),
 * then searches .wishes/ directory for *-wish.md files referencing the taskId.
 */
export async function wishFileExists(taskId: string, repoPath: string): Promise<boolean> {
  const fs = await import('node:fs/promises');
  // Fast path: check .genie/wishes/<taskId>/wish.md
  const wishPath = join(repoPath, '.genie', 'wishes', taskId, 'wish.md');
  try {
    await fs.access(wishPath);
    return true;
  } catch {
    // Not found in primary location, search .wishes/ directory
  }

  // Fallback: search .wishes/ directory
  const found = await findWishInDotWishes(taskId, repoPath);
  return found !== undefined;
}

/**
 * Load wish.md content for auto-approve overrides.
 * First checks .genie/wishes/<taskId>/wish.md (fast path),
 * then searches .wishes/ directory for *-wish.md files referencing the taskId.
 */
export async function loadWishContent(taskId: string, repoPath: string): Promise<string | undefined> {
  const fs = await import('node:fs/promises');
  // Fast path: check .genie/wishes/<taskId>/wish.md
  const wishPath = join(repoPath, '.genie', 'wishes', taskId, 'wish.md');
  try {
    return await fs.readFile(wishPath, 'utf-8');
  } catch {
    // Not found in primary location, search .wishes/ directory
  }

  // Fallback: search .wishes/ directory
  const foundPath = await findWishInDotWishes(taskId, repoPath);
  if (foundPath) {
    try {
      return await fs.readFile(foundPath, 'utf-8');
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Create and start an auto-approve engine for a task.
 * Loads config hierarchy: global → repo → wish-level overrides.
 */
async function createEngineForTask(
  taskId: string,
  repoPath: string,
  targetRepo: string,
): Promise<AutoApproveEngine | undefined> {
  try {
    const wishContent = await loadWishContent(taskId, repoPath);
    const config = await loadFullAutoApproveConfig(targetRepo, wishContent);
    const engine = createAutoApproveEngine({
      config,
      auditDir: repoPath,
      sendApproval: sendApprovalViaTmux,
    });
    engine.start();
    return engine;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`⚠️  Auto-approve setup failed: ${message} (non-fatal)`);
    return undefined;
  }
}

/**
 * Block the process to keep auto-approve monitoring alive.
 * Resolves on SIGINT (Ctrl+C).
 */
async function blockForAutoApprove(engine: AutoApproveEngine): Promise<void> {
  console.log('\n🔒 Auto-approve active. Press Ctrl+C to detach.');

  return new Promise<void>((resolve) => {
    const cleanup = () => {
      engine.stop();
      const stats = engine.getStats();
      console.log(
        `\n🔒 Auto-approve stopped. (${stats.approved} approved, ${stats.denied} denied, ${stats.escalated} escalated)`,
      );
      resolve();
    };

    process.on('SIGINT', () => {
      cleanup();
      process.exit(0);
    });
  });
}

/**
 * Wait for Claude CLI to be ready to accept input
 * Polls pane content looking for Claude's input prompt indicator
 */
async function waitForClaudeReady(paneId: string, timeoutMs = 30000, pollIntervalMs = 500): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const content = await tmux.capturePaneContent(paneId, 50);

      // Claude CLI shows ">" prompt when ready for input
      // Also check for the input area indicator
      // The prompt appears at the end of output when Claude is waiting for input
      const lines = content.split('\n').filter((l) => l.trim());
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

    await new Promise((r) => setTimeout(r, pollIntervalMs));
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
  workingDir: string,
): Promise<{ paneId: string; windowId: string; windowCreated: boolean } | null> {
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
      return { paneId: panes[0].id, windowId: existingWindow.id, windowCreated: false };
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

    return { paneId: panes[0].id, windowId: newWindow.id, windowCreated: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ Error ensuring worker window: ${message}`);
    return null;
  }
}

/**
 * Resolve tool name and input from raw permission output.
 */
function resolveToolFromPermission(
  rawOutput: string,
  details: ReturnType<typeof extractPermissionDetails>,
): { toolName: string; toolInput: Record<string, unknown> | undefined } {
  if (!details) return { toolName: 'unknown', toolInput: undefined };

  switch (details.type) {
    case 'bash':
      return {
        toolName: 'Bash',
        toolInput: details.command ? { command: details.command } : undefined,
      };
    case 'file': {
      let toolName = 'Write'; // conservative default
      if (/Allow.*Edit/i.test(rawOutput)) toolName = 'Edit';
      else if (/Allow.*Write/i.test(rawOutput)) toolName = 'Write';
      else if (/Allow.*Read/i.test(rawOutput)) toolName = 'Read';
      return {
        toolName,
        toolInput: details.file ? { file_path: details.file } : undefined,
      };
    }
    default:
      return { toolName: details.type, toolInput: undefined };
  }
}

/**
 * Start monitoring worker state and update registry
 * Updates both beads and JSON registry during transition
 */
function startWorkerMonitoring(workerId: string, session: string, paneId: string, engine?: AutoApproveEngine): void {
  const monitor = new EventMonitor(session, {
    pollIntervalMs: 1000,
    paneId,
  });

  // Auto-approve: evaluate permission requests via the engine
  if (engine) {
    let lastApprovalTime = 0;

    monitor.on('permission', async (event) => {
      // Debounce: skip if we just approved within 2s
      const now = Date.now();
      if (now - lastApprovalTime < 2000) return;

      const rawOutput = event.state?.rawOutput || '';
      const details = extractPermissionDetails(rawOutput);
      const { toolName, toolInput } = resolveToolFromPermission(rawOutput, details);

      const request: PermissionRequest = {
        id: `auto-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        toolName,
        toolInput,
        paneId,
        wishId: workerId,
        sessionId: '',
        cwd: '',
        timestamp: new Date().toISOString(),
      };

      const decision = await engine.processRequest(request);
      if (decision.action === 'approve') {
        lastApprovalTime = now;
        console.log(
          `   ✅ Auto-approved: ${toolName}${details?.command ? ` (${details.command.substring(0, 50)})` : ''}`,
        );
      } else if (decision.action === 'deny') {
        console.log(`   ❌ Auto-denied: ${toolName} - ${decision.reason}`);
      }
      // escalate = do nothing, human must decide
    });
  }

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
// workCommand helpers
// ============================================================================

/**
 * Ensure beads daemon is running for auto-sync.
 */
async function ensureBeadsDaemon(): Promise<void> {
  if (!useBeads) return;
  const daemonStatus = await beadsRegistry.checkDaemonStatus();
  if (daemonStatus.running) return;
  console.log('🔄 Starting beads daemon for auto-sync...');
  const started = await beadsRegistry.startDaemon({ autoCommit: true });
  console.log(started ? '   ✅ Daemon started' : '   ⚠️  Daemon failed to start (non-fatal)');
}

/**
 * Load and validate worker profile from config.
 */
async function resolveWorkerProfile(profileName?: string): Promise<WorkerProfile | undefined> {
  const config = await loadGenieConfig();
  if (!profileName) return getDefaultWorkerProfile(config);

  const profile = getWorkerProfile(config, profileName);
  if (profile) return profile;

  const available = Object.keys(config.workerProfiles || {});
  console.error(`Profile '${profileName}' not found.`);
  console.log(
    available.length > 0
      ? `Available profiles: ${available.join(', ')}`
      : 'No profiles configured in ~/.genie/config.json',
  );
  process.exit(1);
}

/**
 * Resolve a specific task ID target to a BeadsIssue.
 * Checks local backend first, then falls back to beads.
 */
async function resolveSpecificTarget(target: string, repoPath: string): Promise<BeadsIssue> {
  const sanitized = sanitizeTaskId(target);
  if (!sanitized) {
    console.error(`❌ Invalid task ID: "${target}"`);
    console.error('   Task IDs must be alphanumeric with hyphens/underscores (e.g., "bd-123", "wish-1").');
    console.error('   Got characters that are unsafe for git branches or shell commands.');
    process.exit(1);
  }

  // Check local backend first
  const backend = getBackend(repoPath);
  if (backend.kind === 'local') {
    const localTask = await backend.get(sanitized);
    if (localTask) {
      return {
        id: localTask.id,
        title: localTask.title,
        status: localTask.status,
        description: localTask.description,
        blockedBy: localTask.blockedBy || [],
      };
    }
  }

  // Fall back to beads
  const issue = await getBeadsIssue(sanitized);
  if (issue) return issue;

  // Not found — print backend-specific error
  printTargetNotFoundError(sanitized, repoPath);
  process.exit(1);
}

/**
 * Print error message when a target task is not found.
 */
async function printTargetNotFoundError(taskTarget: string, repoPath: string): Promise<void> {
  const backend = getBackend(repoPath);
  if (backend.kind !== 'local') {
    console.error(`❌ Issue "${taskTarget}" not found. Run \`bd list\` to see issues.`);
    return;
  }
  console.error(`❌ Issue "${taskTarget}" not found in local task registry.`);
  console.error(`   File: ${join(repoPath, '.genie', 'tasks.json')}`);
  const fs = await import('node:fs');
  if (!fs.existsSync(join(repoPath, '.genie', 'tasks.json'))) {
    console.error('   ⚠️  tasks.json does not exist. This is likely a fresh repo.');
    console.error('   Fix: Run `genie task create "Your task title"` to create the first task,');
    console.error('         or `bd sync` if using beads.');
  } else {
    console.error(`   Task "${taskTarget}" is not in tasks.json. Run \`bd list\` to see available tasks.`);
  }
}

/**
 * Resolve work target to a BeadsIssue.
 * Handles 'next', 'wish', and specific task ID targets.
 * Returns null only for 'next' with no ready issues (caller should return early).
 */
async function resolveTarget(target: string, repoPath: string): Promise<BeadsIssue | null> {
  if (target === 'next') {
    console.log('🔍 Finding next ready issue...');
    const issue = await getNextReadyIssue(repoPath);
    if (!issue) {
      console.log('ℹ️  No ready issues. Run `bd ready` to see the queue.');
      return null;
    }
    console.log(`📋 Found: ${issue.id} - "${issue.title}"`);
    return issue;
  }

  if (target === 'wish') {
    console.error('❌ `genie work wish` is not yet implemented.');
    process.exit(1);
  }

  return resolveSpecificTarget(target, repoPath);
}

/**
 * Resume an existing worker session.
 * Returns true if resumed successfully (caller should return), false if not resumable.
 */
async function resumeExistingWorker(
  existingWorker: registry.Worker,
  taskId: string,
  options: WorkOptions,
  workerProfile: WorkerProfile | undefined,
): Promise<boolean> {
  if (!existingWorker.claudeSessionId || options.resume === false) return false;

  console.log(`📋 Found existing worker for ${taskId} with resumable session`);
  console.log(`   Session ID: ${existingWorker.claudeSessionId}`);
  console.log('   Resuming previous Claude session...');

  const session = await getOrCreateSession(options.session);
  const workingDir = existingWorker.worktree || existingWorker.repoPath;

  console.log('🚀 Ensuring worker window...');
  const paneResult = await ensureWorkerWindow(session, taskId, workingDir);
  if (!paneResult) process.exit(1);

  const { paneId, windowId } = paneResult;

  // Update registry with new pane/window info
  await registry.update(existingWorker.id, {
    paneId,
    session,
    windowName: taskId,
    windowId,
    state: 'spawning',
    lastStateChange: new Date().toISOString(),
  });
  if (useBeads) {
    await beadsRegistry.setAgentState(existingWorker.id, 'spawning').catch(() => {});
  }

  // Launch Claude in the pane
  const beadsDir = join(existingWorker.repoPath, '.genie');
  const escapedWorkingDir = workingDir.replace(/'/g, "'\\''");
  const resumeCmd = buildSpawnCommand(workerProfile, {
    resume: existingWorker.claudeSessionId,
    beadsDir,
  });
  const resumeEnvPrefix = buildEnvSourcePrefix(workingDir, existingWorker.repoPath);
  await tmux.executeCommand(paneId, `cd '${escapedWorkingDir}' && ${resumeEnvPrefix}${resumeCmd}`, true, false);

  // Update state to working
  if (useBeads) {
    await beadsRegistry.setAgentState(existingWorker.id, 'working').catch(() => {});
  }
  await registry.updateState(existingWorker.id, 'working');

  // Auto-approve + monitoring
  let resumeEngine: AutoApproveEngine | undefined;
  if (!options.noAutoApprove) {
    resumeEngine = await createEngineForTask(taskId, existingWorker.repoPath, existingWorker.repoPath);
    if (resumeEngine) console.log('🔒 Auto-approve engine started');
  }
  startWorkerMonitoring(existingWorker.id, session, paneId, resumeEngine);

  if (options.focus === true) {
    await tmux.executeTmux(`select-window -t '${session}:${taskId}'`);
  }

  printWorkerStatus('Resumed', taskId, paneId, session, existingWorker.claudeSessionId);

  if (resumeEngine && !options._skipAutoApproveBlock) {
    await blockForAutoApprove(resumeEngine);
  }
  return true;
}

/**
 * Claim a task via the appropriate backend, exiting on failure.
 */
async function claimTaskOrExit(taskId: string, repoPath: string): Promise<void> {
  console.log(`📝 Claiming ${taskId}...`);
  const backend = getBackend(repoPath);
  let claimed = false;
  let claimError: string | undefined;

  try {
    claimed = await (backend.kind === 'local' ? backend.claim(taskId) : claimIssue(taskId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    claimError = message || String(err);
  }

  if (claimed) return;

  if (backend.kind === 'beads') {
    console.error(`❌ Failed to claim ${taskId}.${claimError ? ` Reason: ${claimError}` : ''}`);
    console.error('   The issue may not exist or is already claimed.');
    console.error(`   Run \`bd show ${taskId}\` to check status.`);
    process.exit(1);
  }

  // Local backend
  const task = await backend.get(taskId);
  if (!task) {
    console.error(`❌ Task "${taskId}" not found in .genie/tasks.json.`);
    console.error(`   Available tasks: run \`cat .genie/tasks.json | jq '.order'\``);
    console.error(`   Or create one: \`term create "${taskId} title"\``);
  } else {
    console.error(`❌ Failed to claim ${taskId} (status: ${task.status}).`);
    console.error('   Task may already be in_progress or done.');
  }
  process.exit(1);
}

/**
 * Register worker in beads registry (non-fatal on error).
 */
async function registerInBeads(
  taskId: string,
  opts: {
    paneId: string;
    session: string;
    worktree: string | null;
    repoPath: string;
    taskTitle: string;
    claudeSessionId: string;
  },
): Promise<void> {
  if (!useBeads) return;
  try {
    await beadsRegistry.ensureAgent(taskId, {
      paneId: opts.paneId,
      session: opts.session,
      worktree: opts.worktree,
      repoPath: opts.repoPath,
      taskId,
      taskTitle: opts.taskTitle,
      claudeSessionId: opts.claudeSessionId,
    });
    await beadsRegistry.bindWork(taskId, taskId);
    await beadsRegistry.setAgentState(taskId, 'spawning');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`⚠️  Beads registration failed: ${message} (non-fatal)`);
  }
}

/**
 * Build the worker prompt based on skill detection and options.
 */
async function buildWorkerPrompt(
  taskId: string,
  issue: BeadsIssue,
  options: WorkOptions,
  repoPath: string,
): Promise<string> {
  let skill = options.skill;
  if (!skill && !options.prompt) {
    const hasWish = await wishFileExists(taskId, repoPath);
    if (hasWish) {
      skill = 'forge';
      console.log('📋 Found wish.md - using /forge skill');
    }
  }

  if (skill) return `/${skill}`;

  return (
    options.prompt ||
    `Work on beads issue ${taskId}: "${issue.title}"

## Description
${issue.description || 'No description provided.'}

When you're done, commit your changes and let me know.`
  );
}

/**
 * Print worker status and help commands.
 */
function printWorkerStatus(
  verb: string,
  taskId: string,
  paneId: string,
  session: string,
  claudeSessionId?: string,
  extra?: { worktreePath?: string | null; targetRepo?: string; repoPath?: string },
): void {
  console.log(`\n✅ ${verb} worker for ${taskId}`);
  console.log(`   Window: ${taskId}`);
  console.log(`   Pane: ${paneId}`);
  console.log(`   Session: ${session}`);
  if (claudeSessionId) console.log(`   Claude Session: ${claudeSessionId}`);
  if (extra?.worktreePath) {
    console.log(`   Worktree: ${extra.worktreePath}`);
    console.log(`   Branch: work/${taskId}`);
  }
  if (extra?.targetRepo && extra?.repoPath && extra.targetRepo !== extra.repoPath) {
    console.log(`   Target repo: ${extra.targetRepo}`);
  }
  console.log('\nCommands:');
  console.log('   genie worker list        - Check worker status');
  console.log('   genie worker approve     - Approve permissions');
  console.log(`   genie worker close ${taskId}  - Close issue when done`);
  console.log(`   genie worker kill ${taskId}   - Force kill worker`);
}

/**
 * Create worktree for task if enabled, returning the working directory and worktree path.
 */
async function setupWorktree(
  taskId: string,
  targetRepo: string,
  noWorktree?: boolean,
): Promise<{ workingDir: string; worktreePath: string | null }> {
  if (noWorktree) return { workingDir: targetRepo, worktreePath: null };

  console.log(`🌳 Creating worktree for ${taskId} in ${targetRepo}...`);
  const worktreePath = await createWorktreeForTask(taskId, targetRepo);
  if (!worktreePath) {
    console.log('⚠️  Worktree creation failed. Using shared repo.');
    return { workingDir: targetRepo, worktreePath: null };
  }
  console.log(`   Created: ${worktreePath}`);
  console.log(`   Branch: work/${taskId}`);
  return { workingDir: worktreePath, worktreePath };
}

/**
 * Spawn Claude in a pane, wait for ready, then send the prompt.
 */
async function spawnAndSendPrompt(
  paneId: string,
  workingDir: string,
  repoPath: string,
  claudeSessionId: string,
  prompt: string,
  workerProfile: WorkerProfile | undefined,
): Promise<void> {
  const escapedPrompt = prompt.replace(/'/g, "'\\''");
  const beadsDir = join(repoPath, '.genie');
  const escapedWorkingDir = workingDir.replace(/'/g, "'\\''");
  const spawnCmd = buildSpawnCommand(workerProfile, { sessionId: claudeSessionId, beadsDir });
  const spawnEnvPrefix = buildEnvSourcePrefix(workingDir, repoPath);
  await tmux.executeCommand(paneId, `cd '${escapedWorkingDir}' && ${spawnEnvPrefix}${spawnCmd}`, true, false);
  console.log(`   Session ID: ${claudeSessionId}`);

  const ready = await waitForClaudeReady(paneId);
  if (!ready) console.log('   (Claude startup timed out, sending prompt anyway)');
  await tmux.executeTmux(`send-keys -t '${paneId}' '${escapedPrompt}' Enter`);
}

/**
 * Find an existing worker for a task across registries.
 */
async function findExistingWorker(taskId: string): Promise<registry.Worker | null> {
  const beadsWorker = useBeads ? await beadsRegistry.findByTask(taskId) : null;
  return beadsWorker || (await registry.findByTask(taskId));
}

/**
 * Start auto-approve engine and monitoring for a worker.
 */
async function setupAutoApproveAndMonitoring(
  workerId: string,
  taskId: string,
  session: string,
  paneId: string,
  repoPath: string,
  targetRepo: string,
  options: WorkOptions,
): Promise<AutoApproveEngine | undefined> {
  let engine: AutoApproveEngine | undefined;
  if (!options.noAutoApprove) {
    engine = await createEngineForTask(taskId, repoPath, targetRepo);
    if (engine) console.log('🔒 Auto-approve engine started');
  }
  startWorkerMonitoring(workerId, session, paneId, engine);
  return engine;
}

// ============================================================================
// Main Command
// ============================================================================

export async function workCommand(target: string, options: WorkOptions = {}): Promise<void> {
  try {
    const repoPath = process.cwd();

    await ensureBeadsDaemon();
    const workerProfile = await resolveWorkerProfile(options.profile);

    // 1. Resolve target
    const issue = await resolveTarget(target, repoPath);
    if (!issue) return; // 'next' with no ready issues

    const taskId = issue.id;

    // 2. Check not already assigned
    const existingWorker = await findExistingWorker(taskId);
    if (existingWorker) {
      const resumed = await resumeExistingWorker(existingWorker, taskId, options, workerProfile);
      if (resumed) return;
      console.error(`❌ ${taskId} already has a worker (pane ${existingWorker.paneId})`);
      console.log(`   Run \`genie worker kill ${existingWorker.id}\` first, or work on a different issue.`);
      process.exit(1);
    }

    // 3. Get session + claim task
    const session = await getOrCreateSession(options.session);
    await claimTaskOrExit(taskId, repoPath);

    // 4. Detect target repo
    const { targetRepo, detectionMethod } = await detectTargetRepo(
      taskId,
      repoPath,
      options.repo,
      issue.title,
      issue.description,
    );
    if (targetRepo !== repoPath) {
      console.log(`🎯 Detected nested repo: ${targetRepo}`);
      console.log(`   Detection: ${detectionMethod}`);
    }

    // 5. Create worktree
    const { workingDir, worktreePath } = await setupWorktree(taskId, targetRepo, options.noWorktree);

    // 6. Ensure dedicated window
    console.log(`🚀 Creating worker window "${taskId}"...`);
    const paneResult = await ensureWorkerWindow(session, taskId, workingDir);
    if (!paneResult) process.exit(1);
    const { paneId, windowId } = paneResult;

    // 7. Generate IDs + register
    const claudeSessionId = randomUUID();
    const workerId = await registry.generateWorkerId(taskId, options.name);
    const worker: registry.Worker = {
      id: workerId,
      paneId,
      session,
      worktree: worktreePath,
      taskId,
      taskTitle: issue.title,
      startedAt: new Date().toISOString(),
      state: 'spawning',
      lastStateChange: new Date().toISOString(),
      repoPath: targetRepo,
      claudeSessionId,
      windowName: taskId,
      windowId,
      role: options.role,
      customName: options.name,
    };
    await registerInBeads(taskId, {
      paneId,
      session,
      worktree: worktreePath,
      repoPath: targetRepo,
      taskTitle: issue.title,
      claudeSessionId,
    });
    await registry.register(worker);

    // 8. Spawn Claude + send prompt
    const prompt = await buildWorkerPrompt(taskId, issue, options, repoPath);
    await spawnAndSendPrompt(paneId, workingDir, repoPath, claudeSessionId, prompt, workerProfile);

    // 9. Update state to working
    if (useBeads) await beadsRegistry.setAgentState(taskId, 'working').catch(() => {});
    await registry.updateState(taskId, 'working');

    // 10. Auto-approve + monitoring
    const engine = await setupAutoApproveAndMonitoring(
      workerId,
      taskId,
      session,
      paneId,
      repoPath,
      targetRepo,
      options,
    );

    if (options.focus === true) await tmux.executeTmux(`select-window -t '${session}:${taskId}'`);

    printWorkerStatus('Started', taskId, paneId, session, undefined, { worktreePath, targetRepo, repoPath });

    if (engine && !options._skipAutoApproveBlock) await blockForAutoApprove(engine);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ Error: ${message}`);
    process.exit(1);
  }
}
