/**
 * Agent Sync — Auto-discover and register agents from workspace agents/ directory.
 *
 * Scans {workspace}/agents/ for directories containing AGENTS.md (the discovery marker).
 * For each found agent, reads the git remote to derive repo_path, then registers or
 * updates the entry in the app_store.
 *
 * Used by:
 *   - `genie serve` (startup sync + file watcher)
 *   - `genie init` (post-scan registration)
 *   - `genie dir sync` (manual trigger)
 */

import { execSync } from 'node:child_process';
import { existsSync, watch as fsWatch, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { getItemFromStore, regenerateAgentCache, registerItemInStore, updateItemInStore } from './agent-cache.js';

// ============================================================================
// Types
// ============================================================================

interface SyncResult {
  registered: string[];
  updated: string[];
  unchanged: string[];
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

/**
 * Read the git remote origin URL for a directory.
 * Returns null if the directory is not a git repo or has no remote.
 */
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

/**
 * Extract org/repo from a git remote URL.
 * Handles HTTPS (github.com/org/repo.git) and SSH (git@github.com:org/repo.git) formats.
 */
function extractOrgRepo(remoteUrl: string): string | null {
  // SSH: git@github.com:org/repo.git
  const sshMatch = remoteUrl.match(/[^/:]+\/[^/]+?(?:\.git)?$/);
  if (sshMatch) {
    return sshMatch[0].replace(/\.git$/, '');
  }
  return null;
}

/**
 * Resolve the product repo path for an agent.
 * If {agentDir}/repos is a symlink, resolve it and detect its git remote.
 */
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

/** Discover all agents in {workspaceRoot}/agents/ that have AGENTS.md. */
function discoverAgents(workspaceRoot: string): AgentInfo[] {
  const agentsDir = join(workspaceRoot, 'agents');
  if (!existsSync(agentsDir)) return [];

  const agents: AgentInfo[] = [];
  try {
    const entries = readdirSync(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const agentDir = join(agentsDir, entry.name);
      const marker = join(agentDir, 'AGENTS.md');
      if (!existsSync(marker)) continue;

      agents.push({
        name: entry.name,
        dir: agentDir,
        repoUrl: getGitRemoteUrl(agentDir),
        productRepo: getRepoPathForAgent(agentDir),
      });
    }
  } catch {
    // agents/ dir may not be readable
  }
  return agents;
}

/** Discover a single agent by name. */
function discoverSingleAgent(workspaceRoot: string, agentName: string): AgentInfo | null {
  const agentDir = join(workspaceRoot, 'agents', agentName);
  const marker = join(agentDir, 'AGENTS.md');
  if (!existsSync(marker)) return null;

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
 * - Existing agents with stale repo_path → updated
 * - Existing agents with correct data → unchanged
 *
 * Idempotent — safe to run repeatedly.
 */
export async function syncAgentDirectory(workspaceRoot: string): Promise<SyncResult> {
  const result: SyncResult = { registered: [], updated: [], unchanged: [], errors: [] };
  const agents = discoverAgents(workspaceRoot);

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

  // Regenerate cache after all mutations
  if (result.registered.length > 0 || result.updated.length > 0) {
    await regenerateAgentCache().catch(() => {});
  }

  return result;
}

/**
 * Sync a single agent by name from the workspace.
 * Used by the file watcher for targeted registration.
 */
async function syncSingleAgentByName(
  workspaceRoot: string,
  agentName: string,
): Promise<'registered' | 'updated' | 'unchanged' | 'not-found'> {
  const agent = discoverSingleAgent(workspaceRoot, agentName);
  if (!agent) return 'not-found';

  const result: SyncResult = { registered: [], updated: [], unchanged: [], errors: [] };
  await syncSingleAgent(agent, result);

  if (result.registered.length > 0 || result.updated.length > 0) {
    await regenerateAgentCache().catch(() => {});
  }

  if (result.registered.length > 0) return 'registered';
  if (result.updated.length > 0) return 'updated';
  return 'unchanged';
}

/** Core sync logic for a single agent. */
async function syncSingleAgent(agent: AgentInfo, result: SyncResult): Promise<void> {
  const orgRepo = agent.repoUrl ? extractOrgRepo(agent.repoUrl) : null;
  const repoPath = orgRepo ?? agent.repoUrl ?? agent.dir;

  const existing = await getItemFromStore(agent.name).catch(() => null);

  if (!existing) {
    // Register new agent
    await registerItemInStore({
      name: agent.name,
      itemType: 'agent',
      installPath: agent.dir,
      gitUrl: agent.repoUrl ?? undefined,
      manifest: {
        promptMode: 'append',
        repo: repoPath,
        productRepo: agent.productRepo,
        source: 'auto-sync',
      },
    });
    result.registered.push(agent.name);
    return;
  }

  // Check if update needed
  const manifest = (existing.manifest ?? {}) as Record<string, unknown>;
  const currentRepo = manifest.repo as string | undefined;
  const currentInstallPath = existing.install_path;
  const needsUpdate =
    currentRepo !== repoPath ||
    currentInstallPath !== agent.dir ||
    (agent.productRepo && manifest.productRepo !== agent.productRepo);

  if (needsUpdate) {
    await updateItemInStore(agent.name, {
      installPath: agent.dir,
      gitUrl: agent.repoUrl ?? undefined,
      manifest: {
        ...manifest,
        repo: repoPath,
        productRepo: agent.productRepo,
        source: 'auto-sync',
      },
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

/** Process a single watched agent change — register, update, or remove. */
async function processWatchedAgent(workspaceRoot: string, agentsDir: string, name: string): Promise<string | null> {
  const agentDir = join(agentsDir, name);
  if (existsSync(agentDir) && existsSync(join(agentDir, 'AGENTS.md'))) {
    const action = await syncSingleAgentByName(workspaceRoot, name);
    return action === 'registered' || action === 'updated' ? action : null;
  }
  if (!existsSync(agentDir)) {
    const { removeItemFromStore } = await import('./agent-cache.js');
    const removed = await removeItemFromStore(name).catch(() => false);
    if (removed) {
      await regenerateAgentCache().catch(() => {});
      return 'removed';
    }
  }
  return null;
}

/**
 * Watch {workspaceRoot}/agents/ for new/removed agent directories.
 * Debounces changes with a 2s window.
 *
 * - New directory with AGENTS.md → auto-register
 * - Removed directory → mark inactive (remove from store)
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
