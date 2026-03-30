/**
 * Agent Sync — Auto-discover and register agents from workspace agents/ directory.
 *
 * Scans {workspace}/agents/ for directories containing AGENTS.md (the discovery marker).
 * For each found agent, reads the git remote to derive repo_path, then registers or
 * updates the entry in the app_store.
 *
 * Handles lifecycle:
 *   - New agent dir → register in app_store + agents table
 *   - Existing agent with stale data → update
 *   - Archived agent reappearing → reactivate with full backfill
 *   - Missing agent dir → archive (never delete — preserves history)
 *
 * Used by:
 *   - `genie serve` (startup sync + file watcher)
 *   - `genie init` (post-scan registration)
 *   - `genie dir sync` (manual trigger)
 */

import { execSync } from 'node:child_process';
import { existsSync, watch as fsWatch, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  getItemFromStore,
  listItemsFromStore,
  regenerateAgentCache,
  registerItemInStore,
  updateItemInStore,
} from './agent-cache.js';

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
      if (!existsSync(join(agentDir, 'AGENTS.md'))) continue;

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
  if (!existsSync(join(agentDir, 'AGENTS.md'))) return null;

  return {
    name: agentName,
    dir: agentDir,
    repoUrl: getGitRemoteUrl(agentDir),
    productRepo: getRepoPathForAgent(agentDir),
  };
}

// ============================================================================
// Archive / Reactivation helpers
// ============================================================================

/** Archive an agent in both agents table and app_store. Never deletes rows. */
async function archiveAgent(name: string): Promise<boolean> {
  let archived = false;
  try {
    const { getConnection } = await import('./db.js');
    const sql = await getConnection();
    // Archive in agents table (set state='archived')
    const result = await sql`
      UPDATE agents SET state = 'archived', updated_at = now()
      WHERE (custom_name = ${name} OR role = ${name})
        AND (state IS NULL OR state != 'archived')
    `;
    if (result.count > 0) archived = true;
  } catch {
    // DB may not be available
  }

  // Archive in app_store (set approval_status='archived')
  try {
    const existing = await getItemFromStore(name).catch(() => null);
    if (existing && existing.approval_status !== 'archived') {
      await updateItemInStore(name, {
        manifest: {
          ...(existing.manifest as Record<string, unknown>),
          archived: true,
          archivedAt: new Date().toISOString(),
        },
      });
      archived = true;
    }
  } catch {
    // Best-effort
  }

  return archived;
}

/** Reactivate an archived agent with full backfill. */
async function reactivateAgent(agent: AgentInfo): Promise<void> {
  const orgRepo = agent.repoUrl ? extractOrgRepo(agent.repoUrl) : null;
  const repoPath = orgRepo ?? agent.repoUrl ?? agent.dir;

  // Update app_store entry — clear archived flag, refresh paths
  const existing = await getItemFromStore(agent.name).catch(() => null);
  if (existing) {
    const manifest = { ...(existing.manifest as Record<string, unknown>) };
    manifest.archived = undefined;
    manifest.archivedAt = undefined;
    manifest.repo = repoPath;
    manifest.productRepo = agent.productRepo;
    manifest.source = 'auto-sync';
    await updateItemInStore(agent.name, {
      installPath: agent.dir,
      gitUrl: agent.repoUrl ?? undefined,
      manifest,
    });
  }

  // Reactivate in agents table
  try {
    const { getConnection } = await import('./db.js');
    const sql = await getConnection();
    await sql`
      UPDATE agents SET state = 'idle', repo_path = ${repoPath}, updated_at = now()
      WHERE (custom_name = ${agent.name} OR role = ${agent.name})
        AND state = 'archived'
    `;
  } catch {
    // DB may not be available
  }

  // Trigger session backfill for conversation history recovery
  await triggerSessionBackfill(agent).catch(() => {});
}

/** Trigger session backfill for a reactivated agent. */
async function triggerSessionBackfill(_agent: AgentInfo): Promise<void> {
  try {
    const { getConnection, isAvailable } = await import('./db.js');
    if (!(await isAvailable())) return;
    const sql = await getConnection();
    const { startBackfill } = await import('./session-backfill.js');
    await startBackfill(sql);
  } catch {
    // Best-effort — backfill may not be ready
  }
}

// ============================================================================
// Sync
// ============================================================================

/**
 * Sync all agents from {workspaceRoot}/agents/ into the directory.
 * - New agents → registered
 * - Existing agents with stale repo_path → updated
 * - Archived agents reappearing → reactivated with backfill
 * - Agents in store whose dirs are gone → archived
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

  // Archive agents in store whose dirs no longer exist
  await archiveMissingAgents(workspaceRoot, discoveredNames, result);

  // Regenerate cache after mutations
  const hasMutations =
    result.registered.length + result.updated.length + result.archived.length + result.reactivated.length;
  if (hasMutations > 0) {
    await regenerateAgentCache().catch(() => {});
  }

  return result;
}

/** Archive app_store agents whose directories no longer exist on disk. */
async function archiveMissingAgents(
  workspaceRoot: string,
  discoveredNames: Set<string>,
  result: SyncResult,
): Promise<void> {
  try {
    const storeItems = await listItemsFromStore('agent');
    const agentsDir = join(workspaceRoot, 'agents');

    for (const item of storeItems) {
      if (discoveredNames.has(item.name)) continue;
      const manifest = (item.manifest ?? {}) as Record<string, unknown>;
      if (manifest.archived) continue; // already archived
      if (manifest.source !== 'auto-sync') continue; // only archive auto-synced agents

      // Verify the agent was from this workspace
      if (item.install_path && !item.install_path.startsWith(agentsDir)) continue;

      const archived = await archiveAgent(item.name);
      if (archived) result.archived.push(item.name);
    }
  } catch {
    // Best-effort — don't block sync on archive failures
  }
}

/** Sync a single agent by name from the workspace (used by file watcher). */
async function syncSingleAgentByName(workspaceRoot: string, agentName: string): Promise<string> {
  const agent = discoverSingleAgent(workspaceRoot, agentName);
  if (!agent) return 'not-found';

  const result: SyncResult = { registered: [], updated: [], unchanged: [], archived: [], reactivated: [], errors: [] };
  await syncSingleAgent(agent, result);

  if (result.registered.length > 0 || result.updated.length > 0 || result.reactivated.length > 0) {
    await regenerateAgentCache().catch(() => {});
  }

  if (result.reactivated.length > 0) return 'reactivated';
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
    await registerItemInStore({
      name: agent.name,
      itemType: 'agent',
      installPath: agent.dir,
      gitUrl: agent.repoUrl ?? undefined,
      manifest: { promptMode: 'append', repo: repoPath, productRepo: agent.productRepo, source: 'auto-sync' },
    });
    result.registered.push(agent.name);
    return;
  }

  // Check if this is a reactivation (was archived)
  const manifest = (existing.manifest ?? {}) as Record<string, unknown>;
  if (manifest.archived) {
    await reactivateAgent(agent);
    result.reactivated.push(agent.name);
    return;
  }

  // Check if update needed
  const needsUpdate =
    (manifest.repo as string) !== repoPath ||
    existing.install_path !== agent.dir ||
    (agent.productRepo && manifest.productRepo !== agent.productRepo);

  if (needsUpdate) {
    await updateItemInStore(agent.name, {
      installPath: agent.dir,
      gitUrl: agent.repoUrl ?? undefined,
      manifest: { ...manifest, repo: repoPath, productRepo: agent.productRepo, source: 'auto-sync' },
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

/** Process a single watched agent change — register, update, archive, or reactivate. */
async function processWatchedAgent(workspaceRoot: string, agentsDir: string, name: string): Promise<string | null> {
  const agentDir = join(agentsDir, name);
  if (existsSync(agentDir) && existsSync(join(agentDir, 'AGENTS.md'))) {
    const action = await syncSingleAgentByName(workspaceRoot, name);
    return action !== 'unchanged' && action !== 'not-found' ? action : null;
  }
  if (!existsSync(agentDir)) {
    const archived = await archiveAgent(name);
    if (archived) {
      await regenerateAgentCache().catch(() => {});
      return 'archived';
    }
  }
  return null;
}

/**
 * Watch {workspaceRoot}/agents/ for new/removed agent directories.
 * Debounces changes with a 2s window.
 *
 * - New directory with AGENTS.md → auto-register
 * - Archived agent reappearing → reactivate with backfill
 * - Removed directory → archive (never delete)
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
