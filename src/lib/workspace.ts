/**
 * Workspace detection — walk-up algorithm for .genie/workspace.json.
 *
 * A "workspace" is a directory containing `.genie/workspace.json`.
 * If the cwd passes through `agents/<name>/`, the agent name is extracted.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WorkspaceConfig {
  name: string;
  pgUrl?: string;
  daemonPid?: number;
  tmuxSocket?: string;
}

interface WorkspaceInfo {
  /** Absolute path to the workspace root (parent of .genie/) */
  root: string;
  /** Agent name if cwd is inside agents/<name>/ */
  agent?: string;
}

// ─── Walk-up Detection ────────────────────────────────────────────────────────

const WORKSPACE_MARKER = '.genie/workspace.json';

/**
 * Walk up from `cwd` looking for `.genie/workspace.json`.
 * Returns workspace root + optional agent name, or null if not in a workspace.
 */
export function findWorkspace(cwd?: string): WorkspaceInfo | null {
  const startDir = resolve(cwd ?? process.cwd());
  let current = startDir;

  while (true) {
    const candidate = join(current, WORKSPACE_MARKER);
    if (existsSync(candidate)) {
      const agent = detectAgent(startDir, current);
      return { root: current, agent: agent ?? undefined };
    }
    const parent = dirname(current);
    if (parent === current) break; // reached filesystem root
    current = parent;
  }

  return null;
}

/**
 * Detect agent name from path.
 * If startDir passes through `<root>/agents/<name>/`, extract `<name>`.
 */
function detectAgent(startDir: string, workspaceRoot: string): string | null {
  const agentsDir = join(workspaceRoot, 'agents');
  // startDir must be inside or equal to agentsDir
  const relative = startDir.slice(agentsDir.length);
  if (!startDir.startsWith(agentsDir) || (relative.length > 0 && relative[0] !== sep)) {
    return null;
  }

  // relative is like /sofia/repos/... or /sofia
  const parts = relative.split(sep).filter(Boolean);
  if (parts.length === 0) return null;

  const agentName = parts[0];
  // Verify this agent has an AGENTS.md
  const agentsMd = join(agentsDir, agentName, 'AGENTS.md');
  if (existsSync(agentsMd)) return agentName;

  return null;
}

// ─── Config Reading ───────────────────────────────────────────────────────────

/** Read and parse workspace.json from a workspace root. */
export function getWorkspaceConfig(root: string): WorkspaceConfig {
  const configPath = join(root, WORKSPACE_MARKER);
  const raw = readFileSync(configPath, 'utf-8');
  return JSON.parse(raw) as WorkspaceConfig;
}

// ─── Agent Scanning ───────────────────────────────────────────────────────────

/** List all agent names found under {root}/agents/{name}/AGENTS.md */
export function scanAgents(root: string): string[] {
  const agentsDir = join(root, 'agents');
  if (!existsSync(agentsDir)) return [];

  try {
    return readdirSync(agentsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(agentsDir, d.name, 'AGENTS.md')))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}
