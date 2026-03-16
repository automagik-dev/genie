/**
 * Agent Directory — Persistent agent registry with CRUD operations.
 *
 * Three-tier resolution: project (.genie/agents.json) > global (~/.genie/agent-directory.json) > built-in.
 *
 * Each entry records the agent's folder (CWD + AGENTS.md source),
 * optional repo, prompt mode, default model, and declared roles.
 *
 * Uses file-lock pattern (same as agent-registry.ts) for concurrent access.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { BUILTIN_COUNCIL_MEMBERS, BUILTIN_ROLES, type BuiltinAgent } from './builtin-agents.js';
import { acquireLock } from './file-lock.js';

// ============================================================================
// Types
// ============================================================================

export type PromptMode = 'system' | 'append';

export type DirectoryScope = 'project' | 'global' | 'built-in';

export interface DirectoryEntry {
  /** Globally unique agent name. */
  name: string;
  /** Agent folder — CWD at spawn, contains AGENTS.md. */
  dir: string;
  /** Optional default git repo (overridden by team). */
  repo?: string;
  /** Prompt injection mode: 'system' replaces CC default, 'append' adds to it. */
  promptMode: PromptMode;
  /** Default model (e.g., 'sonnet', 'opus', 'codex'). */
  model?: string;
  /** Built-in roles this agent can orchestrate. */
  roles?: string[];
  /** ISO timestamp of registration. */
  registeredAt: string;
}

/** Directory entry with scope annotation for ls() results. */
export interface ScopedDirectoryEntry extends DirectoryEntry {
  scope: DirectoryScope;
}

interface AgentDirectoryData {
  entries: Record<string, DirectoryEntry>;
  lastUpdated: string;
}

/** Resolved agent — either a user directory entry or a built-in. */
export interface ResolvedAgent {
  /** The agent entry (user or synthetic built-in). */
  entry: DirectoryEntry;
  /** Whether this came from the built-in registry. */
  builtin: boolean;
  /** Which scope the agent was resolved from. */
  source: DirectoryScope;
}

/** Options for scoped operations. */
export interface ScopeOptions {
  /** Write to global directory instead of project. */
  global?: boolean;
}

// ============================================================================
// Configuration
// ============================================================================

function getGlobalDir(): string {
  return process.env.GENIE_HOME ?? join(homedir(), '.genie');
}

/** Path to the global agent directory file (~/.genie/agent-directory.json). */
export function getGlobalDirectoryPath(): string {
  return join(getGlobalDir(), 'agent-directory.json');
}

/** Path to the project-scoped agent directory file (<repo>/.genie/agents.json). */
export function getProjectDirectoryPath(): string {
  // Allow override for testing
  if (process.env.GENIE_PROJECT_ROOT) {
    return join(process.env.GENIE_PROJECT_ROOT, '.genie', 'agents.json');
  }
  try {
    const root = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return join(root, '.genie', 'agents.json');
  } catch {
    // Not in a git repo — fallback to CWD
    return join(process.cwd(), '.genie', 'agents.json');
  }
}

/** Get directory file path for the given scope. */
function getDirectoryPath(scope: 'project' | 'global'): string {
  return scope === 'project' ? getProjectDirectoryPath() : getGlobalDirectoryPath();
}

// ============================================================================
// Internal
// ============================================================================

async function loadDirectory(scope: 'project' | 'global'): Promise<AgentDirectoryData> {
  try {
    const content = await readFile(getDirectoryPath(scope), 'utf-8');
    return JSON.parse(content);
  } catch {
    return { entries: {}, lastUpdated: new Date().toISOString() };
  }
}

async function saveDirectory(data: AgentDirectoryData, scope: 'project' | 'global'): Promise<void> {
  const filePath = getDirectoryPath(scope);
  await mkdir(dirname(filePath), { recursive: true });
  data.lastUpdated = new Date().toISOString();
  await writeFile(filePath, JSON.stringify(data, null, 2));
}

async function withDirectory<T>(
  scope: 'project' | 'global',
  fn: (data: AgentDirectoryData) => T | Promise<T>,
): Promise<T> {
  const release = await acquireLock(getDirectoryPath(scope));
  try {
    const data = await loadDirectory(scope);
    const result = await fn(data);
    await saveDirectory(data, scope);
    return result;
  } finally {
    await release();
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Add an agent to the directory.
 * Validates that dir exists and contains AGENTS.md.
 * Defaults to project scope; pass { global: true } for global.
 */
export async function add(
  entry: Omit<DirectoryEntry, 'registeredAt'>,
  options?: ScopeOptions,
): Promise<DirectoryEntry> {
  if (!entry.name || entry.name.trim() === '') {
    throw new Error('Agent name is required.');
  }

  if (!entry.dir || entry.dir.trim() === '') {
    throw new Error('Agent directory (--dir) is required.');
  }

  if (!existsSync(entry.dir)) {
    throw new Error(`Directory does not exist: ${entry.dir}`);
  }

  const agentsPath = join(entry.dir, 'AGENTS.md');
  if (!existsSync(agentsPath)) {
    throw new Error(`AGENTS.md not found in ${entry.dir}. Each agent directory must contain an AGENTS.md file.`);
  }

  const full: DirectoryEntry = {
    ...entry,
    promptMode: entry.promptMode ?? 'append',
    registeredAt: new Date().toISOString(),
  };

  const scope = options?.global ? 'global' : 'project';
  await withDirectory(scope, (data) => {
    if (data.entries[entry.name]) {
      throw new Error(`Agent "${entry.name}" already exists. Use "genie dir edit" to update or "genie dir rm" first.`);
    }
    data.entries[entry.name] = full;
  });

  return full;
}

/**
 * Remove an agent from the directory.
 * Defaults to project scope; pass { global: true } for global.
 */
export async function rm(name: string, options?: ScopeOptions): Promise<boolean> {
  let removed = false;
  const scope = options?.global ? 'global' : 'project';
  await withDirectory(scope, (data) => {
    if (data.entries[name]) {
      delete data.entries[name];
      removed = true;
    }
  });
  return removed;
}

/**
 * Resolve an agent by name.
 * Resolution order: project directory > global directory > built-in roles > built-in council members.
 */
export async function resolve(name: string): Promise<ResolvedAgent | null> {
  // 1. Check project directory
  const projectData = await loadDirectory('project');
  const projectEntry = projectData.entries[name];
  if (projectEntry) {
    return { entry: projectEntry, builtin: false, source: 'project' };
  }

  // 2. Check global directory
  const globalData = await loadDirectory('global');
  const globalEntry = globalData.entries[name];
  if (globalEntry) {
    return { entry: globalEntry, builtin: false, source: 'global' };
  }

  // 3. Check built-in roles
  const builtinRole = BUILTIN_ROLES.find((r: BuiltinAgent) => r.name === name);
  if (builtinRole) {
    return { entry: builtinToEntry(builtinRole), builtin: true, source: 'built-in' };
  }

  // 4. Check built-in council members
  const councilMember = BUILTIN_COUNCIL_MEMBERS.find((m: BuiltinAgent) => m.name === name);
  if (councilMember) {
    return { entry: builtinToEntry(councilMember), builtin: true, source: 'built-in' };
  }

  return null;
}

/**
 * List agents from all scopes with scope annotation.
 */
export async function ls(): Promise<ScopedDirectoryEntry[]> {
  const results: ScopedDirectoryEntry[] = [];

  // Project entries
  const projectData = await loadDirectory('project');
  for (const entry of Object.values(projectData.entries)) {
    results.push({ ...entry, scope: 'project' });
  }

  // Global entries (skip if name already present from project)
  const globalData = await loadDirectory('global');
  const projectNames = new Set(results.map((e) => e.name));
  for (const entry of Object.values(globalData.entries)) {
    if (!projectNames.has(entry.name)) {
      results.push({ ...entry, scope: 'global' });
    }
  }

  return results;
}

/**
 * Get a single entry by name (user directory only — checks project then global).
 */
export async function get(name: string): Promise<DirectoryEntry | null> {
  const projectData = await loadDirectory('project');
  if (projectData.entries[name]) return projectData.entries[name];

  const globalData = await loadDirectory('global');
  return globalData.entries[name] ?? null;
}

/**
 * Edit an existing agent entry.
 * Only provided fields are updated.
 * Defaults to project scope; pass { global: true } for global.
 */
export async function edit(
  name: string,
  updates: Partial<Pick<DirectoryEntry, 'dir' | 'repo' | 'promptMode' | 'model' | 'roles'>>,
  options?: ScopeOptions,
): Promise<DirectoryEntry> {
  let updated: DirectoryEntry | null = null;

  const scope = options?.global ? 'global' : 'project';
  await withDirectory(scope, (data) => {
    const existing = data.entries[name];
    if (!existing) {
      throw new Error(`Agent "${name}" not found in directory.`);
    }

    // Validate new dir if provided
    if (updates.dir) {
      if (!existsSync(updates.dir)) {
        throw new Error(`Directory does not exist: ${updates.dir}`);
      }
      const agentsPath = join(updates.dir, 'AGENTS.md');
      if (!existsSync(agentsPath)) {
        throw new Error(`AGENTS.md not found in ${updates.dir}.`);
      }
    }

    Object.assign(existing, updates);
    updated = existing;
  });

  if (!updated) {
    throw new Error(`Agent "${name}" not found in directory.`);
  }
  return updated;
}

/**
 * Load the AGENTS.md identity file for an agent.
 * Returns the file path (not content) for use with --system-prompt-file.
 * Returns null if the file doesn't exist.
 */
export function loadIdentity(entry: DirectoryEntry): string | null {
  const agentsPath = join(entry.dir, 'AGENTS.md');
  if (existsSync(agentsPath)) {
    return agentsPath;
  }
  return null;
}

// ============================================================================
// Helpers
// ============================================================================

/** Convert a built-in agent definition to a synthetic DirectoryEntry. */
function builtinToEntry(agent: BuiltinAgent): DirectoryEntry {
  return {
    name: agent.name,
    dir: '', // built-ins don't have a home directory
    promptMode: agent.promptMode ?? 'append',
    model: agent.model,
    roles: [],
    registeredAt: '(built-in)',
  };
}
