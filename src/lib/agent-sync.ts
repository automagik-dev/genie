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
import { existsSync, watch as fsWatch, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as directory from './agent-directory.js';
import { migrateAgentToYaml } from './agent-migrate.js';
import { type AgentConfig, extractFrontmatterFromAgentsMd, parseAgentYaml } from './agent-yaml.js';
import { BUILTIN_DEFAULTS, type DefaultField, type ResolveContext, resolveFieldWithSource } from './defaults.js';
import { parseFrontmatter } from './frontmatter.js';
import { getWorkspaceConfig } from './workspace.js';

// ============================================================================
// Types
// ============================================================================

interface SyncResult {
  registered: string[];
  /**
   * Agents reached during sync whose directory row was upserted. Since the
   * `dir-sync-frontmatter-refresh` wish eliminated the "Unchanged" skip,
   * every existing agent that survives sync lands here — `updated` is now
   * an "at-least-touched" counter, not a "something-diverged" counter.
   */
  updated: string[];
  /** Agents that were migrated from AGENTS.md frontmatter to agent.yaml during this sync. */
  migrated: string[];
  archived: string[];
  reactivated: string[];
  healed: Array<{ agent: string; field: string; value: string }>;
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
// Heal — auto-fix invalid frontmatter literals
// ============================================================================

/** Invalid literals to scan for and delete. Additive — future additions need only extend this list. */
const INVALID_LITERALS: Array<{ field: string; value: string }> = [{ field: 'model', value: 'inherit' }];

export interface HealResult {
  healed: Array<{ agent: string; field: string; value: string }>;
}

/**
 * Scan an AGENTS.md file for invalid frontmatter literals and remove them.
 * Uses atomic write-rename to prevent partial writes.
 * Returns true if the file was modified.
 */
export function healAgentFile(agentsMdPath: string, agentName: string, healResult: HealResult): boolean {
  const content = readFileSync(agentsMdPath, 'utf-8');

  // Only process frontmatter block (between --- delimiters)
  const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!fmMatch) return false;

  const prefix = fmMatch[1];
  const fmBlock = fmMatch[2];
  const suffix = fmMatch[3];
  const rest = content.slice(fmMatch[0].length);

  let modified = false;
  let healedBlock = fmBlock;

  for (const { field, value } of INVALID_LITERALS) {
    // Match the exact line: `field: value` (with optional whitespace)
    const lineRegex = new RegExp(`^${field}:\\s*${value}\\s*$`, 'm');
    if (lineRegex.test(healedBlock)) {
      // Remove the entire line (including the trailing newline)
      healedBlock = healedBlock.replace(new RegExp(`${field}:\\s*${value}\\s*\\n?`, 'm'), '');
      healResult.healed.push({ agent: agentName, field, value });
      modified = true;
    }
  }

  if (!modified) return false;

  // Atomic write: temp file + rename
  const newContent = prefix + healedBlock + suffix + rest;
  const tmpPath = `${agentsMdPath}.tmp.${Date.now()}`;
  writeFileSync(tmpPath, newContent, 'utf-8');
  const { renameSync } = require('node:fs') as typeof import('node:fs');
  renameSync(tmpPath, agentsMdPath);

  return true;
}

// ============================================================================
// Resolved metadata helpers
// ============================================================================

/**
 * Build a ResolveContext for an agent, reading workspace defaults and optionally parent fields.
 */
function buildResolveContext(workspaceRoot: string, agentName: string): ResolveContext {
  let workspaceDefaults: ResolveContext['workspaceDefaults'];
  try {
    const wsConfig = getWorkspaceConfig(workspaceRoot);
    workspaceDefaults = wsConfig.agents?.defaults as ResolveContext['workspaceDefaults'];
  } catch {
    // workspace.json may be unreadable
  }

  // Detect parent for sub-agents (name contains '/')
  let parent: ResolveContext['parent'];
  if (agentName.includes('/')) {
    const parentName = agentName.split('/')[0];
    const parentAgentsMd = join(workspaceRoot, 'agents', parentName, 'AGENTS.md');
    if (existsSync(parentAgentsMd)) {
      const parentContent = readFileSync(parentAgentsMd, 'utf-8');
      const parentFm = parseFrontmatter(parentContent);
      parent = { name: parentName, fields: parentFm as Record<string, unknown> };
    }
  }

  return { workspaceDefaults, parent };
}

/**
 * Compute declared + resolved metadata for an agent's default fields.
 * Returns { declared: {...}, resolved: {...} } sub-objects for PG metadata.
 */
function computeResolvedMetadata(
  fm: Record<string, unknown>,
  ctx: ResolveContext,
): { declared: Record<string, unknown>; resolved: Record<string, unknown> } {
  const declared: Record<string, unknown> = {};
  const resolved: Record<string, unknown> = {};

  for (const field of Object.keys(BUILTIN_DEFAULTS) as DefaultField[]) {
    const fmValue = fm[field];
    if (fmValue !== undefined && fmValue !== null && fmValue !== '' && fmValue !== 'inherit') {
      declared[field] = fmValue;
    }
    const result = resolveFieldWithSource(fm, field, ctx);
    resolved[field] = { value: result.value, source: result.source };
  }

  return { declared, resolved };
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
  const result: SyncResult = {
    registered: [],
    updated: [],
    migrated: [],
    archived: [],
    reactivated: [],
    healed: [],
    errors: [],
  };
  const agents = discoverAgents(workspaceRoot);
  const discoveredNames = new Set(agents.map((a) => a.name));

  // Phase 1: Heal invalid frontmatter literals before sync
  const healResult: HealResult = { healed: [] };
  for (const agent of agents) {
    const agentsMdPath = join(agent.dir, 'AGENTS.md');
    try {
      healAgentFile(agentsMdPath, agent.name, healResult);
    } catch {
      // Heal is best-effort — don't block sync
    }
  }
  result.healed = healResult.healed;
  for (const h of healResult.healed) {
    console.log(`[sync] healed ${h.agent}/AGENTS.md: removed invalid '${h.field}: ${h.value}' line`);
  }

  // Phase 2: Sync agents with resolved metadata
  for (const agent of agents) {
    try {
      await syncSingleAgent(agent, result, workspaceRoot);
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
  if (result.healed.length > 0) console.log(`  Healed: ${result.healed.length} invalid literal(s) removed`);
  if (result.migrated.length > 0)
    console.log(`  Migrated: ${result.migrated.join(', ')} (AGENTS.md frontmatter → agent.yaml)`);
  if (result.registered.length > 0) console.log(`  Registered: ${result.registered.join(', ')}`);
  if (result.updated.length > 0) console.log(`  Updated: ${result.updated.join(', ')}`);
  if (result.reactivated.length > 0) console.log(`  Reactivated: ${result.reactivated.join(', ')}`);
  if (result.archived.length > 0) console.log(`  Removed: ${result.archived.join(', ')}`);
  for (const err of result.errors) {
    console.error(`  Error (${err.name}): ${err.error}`);
  }
  const total = result.registered.length + result.updated.length + result.reactivated.length;
  console.log(`\nSynced: ${total} agent(s), ${result.archived.length} removed.`);
}

/** Remove directory entries whose agent dirs no longer exist on disk. */
async function removeMissingAgents(discoveredNames: Set<string>, result: SyncResult): Promise<void> {
  try {
    const entries = await directory.ls();
    for (const entry of entries) {
      if (discoveredNames.has(entry.name)) continue;
      if (entry.scope === 'built-in') continue;
      if (!entry.dir || !entry.dir.includes('/agents/')) continue; // only remove auto-synced

      const { removed } = await directory.rm(entry.name);
      if (removed) result.archived.push(entry.name);
    }
  } catch {
    // Best-effort
  }
}

/** Core sync logic for a single agent.
 *
 * Always re-parses the source of truth and upserts — no "skip if unchanged"
 * short-circuit. The behavior documented by the `dir-sync-frontmatter-refresh`
 * wish: files on disk are authoritative, so sync must mirror them into the
 * DB on every run. Per-sync writes are cheap; lost edits are expensive.
 *
 * Resolution order for the source config:
 *   1. `agent.yaml` if present (post-migration canonical source)
 *   2. Otherwise, trigger `migrateAgentToYaml` when `AGENTS.md` has
 *      frontmatter — next read picks up the freshly minted yaml.
 *   3. Fall back to legacy `parseFrontmatter(AGENTS.md)` for agents that
 *      have neither yaml nor frontmatter (no config — registered with
 *      defaults only).
 */
async function syncSingleAgent(agent: AgentInfo, result: SyncResult, workspaceRoot?: string): Promise<void> {
  const orgRepo = agent.repoUrl ? extractOrgRepo(agent.repoUrl) : null;
  const repoPath = orgRepo ?? agent.repoUrl ?? agent.dir;

  const yamlPath = join(agent.dir, 'agent.yaml');
  const agentsMdPath = join(agent.dir, 'AGENTS.md');

  // Phase 0: trigger migration if the yaml doesn't exist yet and AGENTS.md
  // carries frontmatter. Migration writes agent.yaml, saves AGENTS.md.bak, and
  // strips the frontmatter off AGENTS.md — so by the end, phase 1 below can
  // just read the yaml.
  if (!existsSync(yamlPath) && existsSync(agentsMdPath)) {
    const agentsMdContent = readFileSync(agentsMdPath, 'utf-8');
    const { frontmatter } = extractFrontmatterFromAgentsMd(agentsMdContent);
    if (frontmatter !== null) {
      const existingEntry = await directory.resolve(agent.name);
      const dbRow = existingEntry && !existingEntry.builtin ? dbRowFromEntry(existingEntry.entry) : undefined;
      const migrationResult = await migrateAgentToYaml(agent.dir, dbRow);
      if (migrationResult.migrated) {
        result.migrated.push(agent.name);
      }
    }
  }

  // Phase 1: derive the config. Prefer yaml; fall back to frontmatter for
  // agents that still have neither (e.g. new agents missing a config file).
  const configFields = existsSync(yamlPath)
    ? await readYamlAsConfigFields(yamlPath)
    : readFrontmatterAsConfigFields(agentsMdPath);

  // Compute resolved metadata if workspace root is available (kept for
  // compatibility; the declared/resolved diff feeds into defaults.ts).
  if (workspaceRoot) {
    const ctx = buildResolveContext(workspaceRoot, agent.name);
    computeResolvedMetadata(configFields.rawForResolution, ctx);
  }

  // Use resolve() to distinguish PG entries from built-ins.
  // get() returns built-in entries too, which would skip the add() path
  // and silently fail the edit() (no dir: row in PG for built-in names).
  const resolved = await directory.resolve(agent.name);
  const existing = resolved && !resolved.builtin ? resolved.entry : null;

  if (!existing) {
    await directory.add({
      name: agent.name,
      dir: agent.dir,
      repo: repoPath,
      promptMode: configFields.promptMode,
      model: configFields.model,
      description: configFields.description,
      color: configFields.color,
      provider: configFields.provider,
      roles: configFields.roles,
      permissions: configFields.permissions,
      disallowedTools: configFields.disallowedTools,
      omniScopes: configFields.omniScopes,
      hooks: configFields.hooks,
      sdk: configFields.sdk,
      bridgeTmuxSession: configFields.bridgeTmuxSession,
    });
    result.registered.push(agent.name);
    return;
  }

  // Always upsert — the "Unchanged" skip path was eliminated by
  // dir-sync-frontmatter-refresh so file-side edits never get dropped.
  await directory.edit(agent.name, {
    dir: agent.dir,
    repo: repoPath,
    promptMode: configFields.promptMode,
    model: configFields.model,
    description: configFields.description,
    color: configFields.color,
    provider: configFields.provider,
    roles: configFields.roles,
    permissions: configFields.permissions,
    disallowedTools: configFields.disallowedTools,
    omniScopes: configFields.omniScopes,
    hooks: configFields.hooks,
    sdk: configFields.sdk,
    bridgeTmuxSession: configFields.bridgeTmuxSession,
  });
  result.updated.push(agent.name);
}

/** Shape of the DirectoryEntry fields the sync path feeds into add/edit. */
interface ConfigFields {
  promptMode: 'system' | 'append';
  model?: string;
  description?: string;
  color?: string;
  provider?: string;
  roles?: string[];
  permissions?: { allow?: string[]; deny?: string[]; preset?: string; bashAllowPatterns?: string[] };
  disallowedTools?: string[];
  omniScopes?: string[];
  hooks?: Record<string, unknown>;
  sdk?: Record<string, unknown>;
  bridgeTmuxSession?: string;
  /** Original record for defaults/resolution callers that still expect the raw shape. */
  rawForResolution: Record<string, unknown>;
}

/** Load config fields from a parsed agent.yaml. */
async function readYamlAsConfigFields(yamlPath: string): Promise<ConfigFields> {
  const cfg: AgentConfig = await parseAgentYaml(yamlPath);
  return {
    promptMode: cfg.promptMode ?? 'append',
    model: cfg.model,
    description: cfg.description,
    color: cfg.color,
    provider: cfg.provider,
    roles: cfg.roles,
    permissions: cfg.permissions,
    disallowedTools: cfg.disallowedTools,
    omniScopes: cfg.omniScopes,
    hooks: cfg.hooks,
    sdk: cfg.sdk as Record<string, unknown> | undefined,
    bridgeTmuxSession: cfg.bridgeTmuxSession,
    rawForResolution: cfg as unknown as Record<string, unknown>,
  };
}

/** Legacy fallback for agents without agent.yaml AND without frontmatter. */
function readFrontmatterAsConfigFields(agentsMdPath: string): ConfigFields {
  const content = existsSync(agentsMdPath) ? readFileSync(agentsMdPath, 'utf-8') : '';
  const fm = parseFrontmatter(content);
  return {
    promptMode: (fm.promptMode as 'system' | 'append' | undefined) ?? 'append',
    model: fm.model as string | undefined,
    description: fm.description as string | undefined,
    color: fm.color as string | undefined,
    provider: fm.provider as string | undefined,
    roles: (fm as Record<string, unknown>).roles as string[] | undefined,
    permissions: fm.permissions as ConfigFields['permissions'],
    disallowedTools: fm.disallowedTools as string[] | undefined,
    omniScopes: fm.omniScopes as string[] | undefined,
    hooks: fm.hooks as Record<string, unknown> | undefined,
    sdk: fm.sdk as Record<string, unknown> | undefined,
    bridgeTmuxSession: fm.bridgeTmuxSession as string | undefined,
    rawForResolution: fm as Record<string, unknown>,
  };
}

/** Extract the fields that `migrateAgentToYaml`'s dbRow shape accepts from an existing directory entry. */
function dbRowFromEntry(entry: directory.DirectoryEntry): Parameters<typeof migrateAgentToYaml>[1] {
  return {
    team: entry.team,
    model: entry.model,
    description: entry.description,
    color: entry.color,
    provider: entry.provider,
    promptMode: entry.promptMode,
    permissions: entry.permissions,
    disallowedTools: entry.disallowedTools,
    omniScopes: entry.omniScopes,
    hooks: entry.hooks,
    sdk: entry.sdk as unknown as AgentConfig['sdk'],
    bridgeTmuxSession: entry.bridgeTmuxSession,
  };
}

// ============================================================================
// Watcher (used by serve.ts)
// ============================================================================

interface AgentWatcher {
  close: () => void;
}

/**
 * Sync a single agent by name from the workspace (used by file watcher and
 * the `dir-sync-frontmatter-refresh` wish's Group 4 edit flow).
 *
 * Returns the action label: `registered` | `migrated` | `updated` | `synced`
 * | `not-found`.
 */
export async function syncSingleAgentByName(workspaceRoot: string, agentName: string): Promise<string> {
  const agent = discoverSingleAgent(workspaceRoot, agentName);
  if (!agent) return 'not-found';

  const result: SyncResult = {
    registered: [],
    updated: [],
    migrated: [],
    archived: [],
    reactivated: [],
    healed: [],
    errors: [],
  };
  await syncSingleAgent(agent, result, workspaceRoot);

  if (result.registered.length > 0) return 'registered';
  if (result.migrated.length > 0) return 'migrated';
  if (result.updated.length > 0) return 'updated';
  return 'synced';
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
    return action !== 'synced' && action !== 'not-found' ? action : null;
  }
  if (!existsSync(agentDir)) {
    const { removed } = await directory.rm(name);
    if (removed) return 'removed';
  }
  return null;
}
