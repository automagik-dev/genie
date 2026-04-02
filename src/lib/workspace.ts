/**
 * Workspace detection — walk-up algorithm for .genie/workspace.json.
 *
 * A "workspace" is a directory containing `.genie/workspace.json`.
 * If the cwd passes through `agents/<name>/`, the agent name is extracted.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
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
 * Falls back to the registered workspace root from ~/.genie/config.json.
 * Returns workspace root + optional agent name, or null if not in a workspace.
 */
export function findWorkspace(cwd?: string): WorkspaceInfo | null {
  const startDir = resolve(cwd ?? process.cwd());
  let current = startDir;

  // 1. Walk-up from cwd
  while (true) {
    const candidate = join(current, WORKSPACE_MARKER);
    if (existsSync(candidate)) {
      // Persist workspace root for global access
      saveWorkspaceRoot(current);
      const agent = detectAgent(startDir, current);
      return { root: current, agent: agent ?? undefined };
    }
    const parent = dirname(current);
    if (parent === current) break; // reached filesystem root
    current = parent;
  }

  // 2. Fall back to registered workspace root
  const savedRoot = loadWorkspaceRoot();
  if (savedRoot && existsSync(join(savedRoot, WORKSPACE_MARKER))) {
    const agent = detectAgent(startDir, savedRoot);
    return { root: savedRoot, agent: agent ?? undefined };
  }

  return null;
}

const GENIE_HOME = process.env.GENIE_HOME ?? join(homedir(), '.genie');

function saveWorkspaceRoot(root: string): void {
  try {
    const configPath = join(GENIE_HOME, 'config.json');
    const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')) : {};
    if (config.workspaceRoot === root) return;
    config.workspaceRoot = root;
    mkdirSync(GENIE_HOME, { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  } catch {
    /* best-effort */
  }
}

function loadWorkspaceRoot(): string | null {
  try {
    const configPath = join(GENIE_HOME, 'config.json');
    if (!existsSync(configPath)) return null;
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    return typeof config.workspaceRoot === 'string' ? config.workspaceRoot : null;
  } catch {
    return null;
  }
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

/** List all agent names found under {root}/agents/{name}/AGENTS.md,
 *  including sub-agents in {name}/.genie/agents/{sub}/AGENTS.md (scoped as name/sub). */
export function scanAgents(root: string): string[] {
  const agentsDir = join(root, 'agents');
  if (!existsSync(agentsDir)) return [];

  try {
    const entries = readdirSync(agentsDir, { withFileTypes: true });
    const names: string[] = [];
    for (const d of entries) {
      if (!d.isDirectory() || !existsSync(join(agentsDir, d.name, 'AGENTS.md'))) continue;
      names.push(d.name);
      scanSubAgents(join(agentsDir, d.name), d.name, names);
    }
    return names.sort();
  } catch {
    return [];
  }
}

/** Scan sub-agents in {parentDir}/.genie/agents/ */
function scanSubAgents(parentDir: string, parentName: string, out: string[]): void {
  const subDir = join(parentDir, '.genie', 'agents');
  if (!existsSync(subDir)) return;
  try {
    for (const sub of readdirSync(subDir, { withFileTypes: true })) {
      if (sub.isDirectory() && existsSync(join(subDir, sub.name, 'AGENTS.md'))) {
        out.push(`${parentName}/${sub.name}`);
      }
    }
  } catch {
    /* sub-agents dir may not be readable */
  }
}
