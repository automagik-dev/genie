/**
 * Discovery — Find AGENTS.md files outside the canonical agents/ directory.
 *
 * Uses tree-scanner to walk the workspace, then filters out agents already
 * present in {workspace}/agents/. Returns "external" agents that exist in
 * the broader repo tree (monorepo subprojects, nested repos, etc.).
 *
 * Used by:
 *   - `genie init` (post-workspace-creation discovery scan)
 *   - Pending queue (feeds discovered agents into the pending list)
 */

import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { scanForAgentsAll } from './tree-scanner.js';
import { scanAgents } from './workspace.js';

// ============================================================================
// Types
// ============================================================================

export interface DiscoveredAgent {
  /** Display name derived from directory name. */
  name: string;
  /** Absolute path to the directory containing AGENTS.md. */
  path: string;
  /** Path relative to workspace root (for display). */
  relativePath: string;
  /** Whether this is a sub-agent of another discovered agent. */
  isSubAgent: boolean;
  /** Parent agent name if sub-agent. */
  parentName?: string;
}

export interface ImportResult {
  /** Agents that were successfully imported (symlinked into agents/). */
  imported: string[];
  /** Agents that were skipped (already exist in agents/). */
  skipped: string[];
  /** Agents that failed to import. */
  errors: Array<{ name: string; error: string }>;
}

// ============================================================================
// Discovery
// ============================================================================

/**
 * Discover agents in the workspace tree that are NOT in the canonical agents/ dir.
 *
 * Runs the tree scanner over the workspace root, then subtracts any agents
 * already present in {root}/agents/. Returns only "external" agents.
 */
export async function discoverExternalAgents(workspaceRoot: string): Promise<DiscoveredAgent[]> {
  const allScanned = await scanForAgentsAll(workspaceRoot);
  const canonicalNames = new Set(scanAgents(workspaceRoot));
  const agentsDir = join(workspaceRoot, 'agents');

  const external: DiscoveredAgent[] = [];
  for (const scanned of allScanned) {
    // Skip anything already inside the canonical agents/ directory
    if (scanned.path.startsWith(agentsDir)) continue;

    // Skip if an agent with this name is already registered
    if (canonicalNames.has(scanned.dirName)) continue;

    external.push({
      name: scanned.dirName,
      path: scanned.path,
      relativePath: relative(workspaceRoot, scanned.path),
      isSubAgent: scanned.isSubAgent,
      parentName: scanned.parentName,
    });
  }

  return external;
}

// ============================================================================
// Import
// ============================================================================

/**
 * Import discovered agents into the canonical agents/ directory by moving them.
 *
 * For each agent, physically moves the directory: {agent.path} -> {root}/agents/{name}
 * Preserves all contents including hidden folders (.claude, .genie, .git).
 * If the name collides, appends a suffix derived from the relative path.
 */
export function importAgents(workspaceRoot: string, agents: DiscoveredAgent[]): ImportResult {
  const agentsDir = join(workspaceRoot, 'agents');
  mkdirSync(agentsDir, { recursive: true });

  const result: ImportResult = { imported: [], skipped: [], errors: [] };

  for (const agent of agents) {
    const destName = resolveUniqueName(agentsDir, agent.name);
    const destPath = join(agentsDir, destName);

    if (existsSync(destPath)) {
      result.skipped.push(agent.name);
      continue;
    }

    try {
      moveDirectory(agent.path, destPath);
      result.imported.push(destName);
    } catch (err) {
      result.errors.push({
        name: agent.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

/**
 * Move a directory, trying atomic rename first, falling back to copy+remove
 * for cross-filesystem moves. Preserves all contents including dotfiles.
 */
function moveDirectory(src: string, dest: string): void {
  try {
    renameSync(src, dest);
  } catch {
    // Cross-filesystem — copy then remove
    cpSync(src, dest, { recursive: true });
    rmSync(src, { recursive: true, force: true });
  }
}

/**
 * Resolve a unique agent name within the agents directory.
 * If `name` already exists, appends `-2`, `-3`, etc.
 */
function resolveUniqueName(agentsDir: string, name: string): string {
  if (!existsSync(join(agentsDir, name))) return name;

  let suffix = 2;
  while (existsSync(join(agentsDir, `${name}-${suffix}`))) {
    suffix++;
  }
  return `${name}-${suffix}`;
}
