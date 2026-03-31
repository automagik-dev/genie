/**
 * Agent Sync — Auto-discover and register agents from workspace agents/ directory.
 *
 * Scans {workspace}/agents/ for directories containing AGENTS.md (the discovery marker).
 * For each found agent, reads the git remote to derive repo_path, then registers or
 * updates the entry in the agent directory.
 *
 * Handles lifecycle:
 *   - New agent dir → register in agent directory
 *   - Existing agent with stale data → update
 *   - Missing agent dir → remove
 *
 * Used by:
 *   - `genie serve` (startup sync + file watcher)
 *   - `genie init` (post-scan registration)
 *   - `genie dir sync` (manual trigger)
 */

import { execSync } from 'node:child_process';
import { existsSync, watch as fsWatch, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import * as directory from './agent-directory.js';

// ============================================================================
// Types
// ============================================================================

interface SyncResult {
  registered: string[];
  updated: string[];
  unchanged: string[];
  archived: string[];
  reactivated: string[];
  errors: Array<{ name: string; error: string }>;
}

interface AgentInfo {
  name: string;
  dir: string;
  repoUrl: string | null;
  productRepo: string | null;
}

// ============================================================================
// Git helpers
// ============================================================================

/** Read the git remote origin URL for a directory. */
function getGitRemoteUrl(dir: string): string | null {
  try {
    const url = execSync(`git -C "${dir}" config --get remote.origin.url`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return url || null;
  } catch {
    return null;
  }
}

/** Extract org/repo from a git remote URL (HTTPS or SSH). */
function extractOrgRepo(remoteUrl: string): string | null {
  const sshMatch = remoteUrl.match(/[^/:]+\/[^/]+?(?:\.git)?$/);
  if (sshMatch) return sshMatch[0].replace(/\.git$/, '');
  return null;
}

/** Resolve the product repo path from {agentDir}/repos symlink. */
function getRepoPathForAgent(agentDir: string): string | null {
  const reposLink = join(agentDir, 'repos');
  try {
    if (!existsSync(reposLink)) return null;
    const target = realpathSync(reposLink);
    if (!existsSync(target)) return null;
    return target;
  } catch {
    return null;
  }
}

// ============================================================================
// Discovery
// ============================================================================

/** Discover all agents in {workspaceRoot}/agents/ that have AGENTS.md.
 *  Also recursively discovers sub-agents in {agent}/.genie/agents/. */
function discoverAgents(workspaceRoot: string): AgentInfo[] {
  const agentsDir = join(workspaceRoot, 'agents');
  if (!existsSync(agentsDir)) return [];

  const agents: AgentInfo[] = [];
  try {
    const entries = readdirSync(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const agentDir = join(agentsDir, entry.name);
      if (!existsSync(join(agentDir, 'AGENTS.md'))) continue;

      agents.push({
        name: entry.name,
        dir: agentDir,
        repoUrl: getGitRemoteUrl(agentDir),
        productRepo: getRepoPathForAgent(agentDir),
      });

      // Discover sub-agents in .genie/agents/
      discoverSubAgents(agentDir, entry.name, agents);
    }
  } catch {
    // agents/ dir may not be readable
  }
  return agents;
}

/** Discover sub-agents inside {parentDir}/.genie/agents/.
 *  Names are scoped as {parentName}/{subName} to avoid collisions
 *  (e.g. genie/qa vs totvs/qa). */
function discoverSubAgents(parentDir: string, parentName: string, agents: AgentInfo[]): void {
  const subAgentsDir = join(parentDir, '.genie', 'agents');
  if (!existsSync(subAgentsDir)) return;

  try {
    const entries = readdirSync(subAgentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subDir = join(subAgentsDir, entry.name);
      if (!existsSync(join(subDir, 'AGENTS.md'))) continue;

      agents.push({
        name: `${parentName}/${entry.name}`,
        dir: subDir,
        repoUrl: getGitRemoteUrl(parentDir),
        productRepo: getRepoPathForAgent(parentDir),
      });
    }
  } catch {
    // sub-agents dir may not be readable
  }
}

/** Discover a single agent by name. */
function discoverSingleAgent(workspaceRoot: string, agentName: string): AgentInfo | null {
  const agentDir = join(workspaceRoot, 'agents', agentName);
  if (!existsSync(join(agentDir, 'AGENTS.md'))) return null;

  return {
    name: agentName,
    dir: agentDir,
    repoUrl: getGitRemoteUrl(agentDir),
    productRepo: getRepoPathForAgent(agentDir),
  };
}

// ============================================================================
// Sync
// ============================================================================

/**
 * Sync all agents from {workspaceRoot}/agents/ into the directory.
 * - New agents → registered
 * - Existing agents with stale data → updated
 * - Agents whose dirs are gone → removed
 *
 * Idempotent — safe to run repeatedly.
 */
export async function syncAgentDirectory(workspaceRoot: string): Promise<SyncResult> {
  const result: SyncResult = { registered: [], updated: [], unchanged: [], archived: [], reactivated: [], errors: [] };
  const agents = discoverAgents(workspaceRoot);
  const discoveredNames = new Set(agents.map((a) => a.name));

  for (const agent of agents) {
    try {
      await syncSingleAgent(agent, result);
    } catch (err) {
      result.errors.push({
        name: agent.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Remove agents whose dirs no longer exist
  await removeMissingAgents(discoveredNames, result);

  return result;
}

/** Print sync result summary to console. Shared by dir sync and agent dir sync. */
export function printSyncResult(result: SyncResult): void {
  if (result.registered.length > 0) console.log(`  Registered: ${result.registered.join(', ')}`);
  if (result.updated.length > 0) console.log(`  Updated: ${result.updated.join(', ')}`);
  if (result.reactivated.length > 0) console.log(`  Reactivated: ${result.reactivated.join(', ')}`);
  if (result.archived.length > 0) console.log(`  Removed: ${result.archived.join(', ')}`);
  if (result.unchanged.length > 0) console.log(`  Unchanged: ${result.unchanged.join(', ')}`);
  for (const err of result.errors) {
    console.error(`  Error (${err.name}): ${err.error}`);
  }
  const total = result.registered.length + result.updated.length + result.unchanged.length + result.reactivated.length;
  console.log(`\nSync complete: ${total} active agent(s), ${result.archived.length} removed.`);
}

/** Remove directory entries whose agent dirs no longer exist on disk. */
async function removeMissingAgents(discoveredNames: Set<string>, result: SyncResult): Promise<void> {
  try {
    const entries = await directory.ls();
    for (const entry of entries) {
      if (discoveredNames.has(entry.name)) continue;
      if (entry.scope === 'built-in') continue;
      if (!entry.dir || !entry.dir.includes('/agents/')) continue; // only remove auto-synced

      const removed = await directory.rm(entry.name);
      if (removed) result.archived.push(entry.name);
    }
  } catch {
    // Best-effort
  }
}

/** Core sync logic for a single agent. */
async function syncSingleAgent(agent: AgentInfo, result: SyncResult): Promise<void> {
  const orgRepo = agent.repoUrl ? extractOrgRepo(agent.repoUrl) : null;
  const repoPath = orgRepo ?? agent.repoUrl ?? agent.dir;

  const existing = await directory.get(agent.name);

  if (!existing) {
    await directory.add({
      name: agent.name,
      dir: agent.dir,
      repo: repoPath,
      promptMode: 'append',
    });
    result.registered.push(agent.name);
    return;
  }

  // Check if update needed
  const needsUpdate = existing.repo !== repoPath || existing.dir !== agent.dir;

  if (needsUpdate) {
    await directory.edit(agent.name, {
      dir: agent.dir,
      repo: repoPath,
    });
    result.updated.push(agent.name);
  } else {
    result.unchanged.push(agent.name);
  }
}

// ============================================================================
// Watcher (used by serve.ts)
// ============================================================================

interface AgentWatcher {
  close: () => void;
}

/** Sync a single agent by name from the workspace (used by file watcher). */
async function syncSingleAgentByName(workspaceRoot: string, agentName: string): Promise<string> {
  const agent = discoverSingleAgent(workspaceRoot, agentName);
  if (!agent) return 'not-found';

  const result: SyncResult = { registered: [], updated: [], unchanged: [], archived: [], reactivated: [], errors: [] };
  await syncSingleAgent(agent, result);

  if (result.registered.length > 0) return 'registered';
  if (result.updated.length > 0) return 'updated';
  return 'unchanged';
}

/**
 * Watch {workspaceRoot}/agents/ for new/removed agent directories.
 * Debounces changes with a 2s window.
 *
 * - New directory with AGENTS.md → auto-register
 * - Removed directory → remove from directory
 */
export function watchAgentDirectory(
  workspaceRoot: string,
  options?: { onSync?: (name: string, action: string) => void },
): AgentWatcher | null {
  const agentsDir = join(workspaceRoot, 'agents');
  if (!existsSync(agentsDir)) return null;

  let debounceTimer: Timer | null = null;
  const pendingChanges = new Set<string>();

  const processChanges = async () => {
    const names = [...pendingChanges];
    pendingChanges.clear();

    for (const name of names) {
      try {
        const action = await processWatchedAgent(workspaceRoot, agentsDir, name);
        if (action) options?.onSync?.(name, action);
      } catch {
        // Best-effort — don't crash the watcher
      }
    }
  };

  const watcher = fsWatch(agentsDir, { persistent: false }, (_event, filename) => {
    if (!filename) return;
    const name = filename.split('/')[0];
    if (!name || name.startsWith('.')) return;

    pendingChanges.add(name);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(processChanges, 2000);
  });

  return {
    close: () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      watcher.close();
    },
  };
}

/** Process a single watched agent change. */
async function processWatchedAgent(workspaceRoot: string, agentsDir: string, name: string): Promise<string | null> {
  const agentDir = join(agentsDir, name);
  if (existsSync(agentDir) && existsSync(join(agentDir, 'AGENTS.md'))) {
    const action = await syncSingleAgentByName(workspaceRoot, name);
    return action !== 'unchanged' && action !== 'not-found' ? action : null;
  }
  if (!existsSync(agentDir)) {
    const removed = await directory.rm(name);
    if (removed) return 'removed';
  }
  return null;
}
