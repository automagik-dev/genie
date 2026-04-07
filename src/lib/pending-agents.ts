/**
 * Pending Agents — Persistent queue for discovered-but-unimported agents.
 *
 * When the tree scanner finds AGENTS.md files outside the canonical agents/
 * directory, they are stored here as "pending" until the user accepts (imports)
 * or dismisses them.
 *
 * Storage: {workspace}/.genie/pending-agents.json
 *
 * Used by:
 *   - `genie init` (populate after discovery scan)
 *   - Future: `genie agents pending` command
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DiscoveredAgent } from './discovery.js';

// ============================================================================
// Types
// ============================================================================

export interface PendingAgent {
  /** Display name. */
  name: string;
  /** Absolute path to agent directory. */
  path: string;
  /** Path relative to workspace root. */
  relativePath: string;
  /** Whether this is a sub-agent. */
  isSubAgent: boolean;
  /** Parent agent name if sub-agent. */
  parentName?: string;
  /** ISO timestamp when this agent was discovered. */
  discoveredAt: string;
  /** Whether the user has dismissed this agent (won't show again). */
  dismissed: boolean;
}

interface PendingStore {
  agents: PendingAgent[];
}

// ============================================================================
// Storage
// ============================================================================

function pendingPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.genie', 'pending-agents.json');
}

/** Load the pending agents store. Returns empty store if file doesn't exist. */
export function loadPending(workspaceRoot: string): PendingStore {
  const filePath = pendingPath(workspaceRoot);
  if (!existsSync(filePath)) return { agents: [] };

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as PendingStore;
    return { agents: Array.isArray(parsed.agents) ? parsed.agents : [] };
  } catch {
    return { agents: [] };
  }
}

/** Save the pending agents store to disk. */
export function savePending(workspaceRoot: string, store: PendingStore): void {
  const filePath = pendingPath(workspaceRoot);
  mkdirSync(join(workspaceRoot, '.genie'), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, 'utf-8');
}

// ============================================================================
// Operations
// ============================================================================

/**
 * Refresh the pending queue from a new discovery scan.
 *
 * - New agents are added with dismissed=false
 * - Existing agents are updated (path may have changed)
 * - Agents no longer discovered are removed (directory was deleted)
 * - Dismissed state is preserved for agents that still exist
 */
export function refreshPending(workspaceRoot: string, discovered: DiscoveredAgent[]): PendingStore {
  const existing = loadPending(workspaceRoot);
  const dismissedSet = new Set(existing.agents.filter((a) => a.dismissed).map((a) => a.path));

  const now = new Date().toISOString();
  const agents: PendingAgent[] = discovered.map((d) => ({
    name: d.name,
    path: d.path,
    relativePath: d.relativePath,
    isSubAgent: d.isSubAgent,
    parentName: d.parentName,
    discoveredAt: existing.agents.find((a) => a.path === d.path)?.discoveredAt ?? now,
    dismissed: dismissedSet.has(d.path),
  }));

  const store: PendingStore = { agents };
  savePending(workspaceRoot, store);
  return store;
}

/** List pending agents that haven't been dismissed. */
export function listPending(workspaceRoot: string): PendingAgent[] {
  const store = loadPending(workspaceRoot);
  return store.agents.filter((a) => !a.dismissed);
}

/** List all pending agents including dismissed ones. */
export function listAllPending(workspaceRoot: string): PendingAgent[] {
  return loadPending(workspaceRoot).agents;
}

/** Dismiss a pending agent by path (won't show again until re-discovered after removal). */
export function dismissPending(workspaceRoot: string, agentPath: string): boolean {
  const store = loadPending(workspaceRoot);
  const agent = store.agents.find((a) => a.path === agentPath);
  if (!agent) return false;

  agent.dismissed = true;
  savePending(workspaceRoot, store);
  return true;
}

/** Remove a pending agent from the queue entirely (after successful import). */
export function removePending(workspaceRoot: string, agentPath: string): boolean {
  const store = loadPending(workspaceRoot);
  const idx = store.agents.findIndex((a) => a.path === agentPath);
  if (idx === -1) return false;

  store.agents.splice(idx, 1);
  savePending(workspaceRoot, store);
  return true;
}

/** Clear all pending agents. */
export function clearPending(workspaceRoot: string): void {
  savePending(workspaceRoot, { agents: [] });
}
