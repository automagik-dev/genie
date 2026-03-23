/**
 * Agent Directory — Persistent agent registry with CRUD operations.
 *
 * Stores agent identity entries at two levels:
 *   - Project: `<repo-root>/.genie/agents.json` (default)
 *   - Global:  `~/.genie/agent-directory.json`
 *
 * Resolution order: project → global → built-in roles → built-in council.
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
  /** Omni agent UUID — set when agent is registered in Omni. */
  omniAgentId?: string;
  /** ISO timestamp of registration. */
  registeredAt: string;
}

export type DirectoryScope = 'project' | 'global' | 'built-in';

export interface ScopedDirectoryEntry extends DirectoryEntry {
  scope: DirectoryScope;
}

export interface ScopeOptions {
  global?: boolean;
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
}

// ============================================================================
// Configuration
// ============================================================================

function getGlobalDir(): string {
  return process.env.GENIE_HOME ?? join(homedir(), '.genie');
}

function getGlobalDirectoryPath(): string {
  return join(getGlobalDir(), 'agent-directory.json');
}

/**
 * Detect the project root via git. Falls back to process.cwd().
 * Respects GENIE_PROJECT_ROOT env var for testing.
 */
export function getProjectRoot(): string {
  if (process.env.GENIE_PROJECT_ROOT) return process.env.GENIE_PROJECT_ROOT;
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return process.cwd();
  }
}

/**
 * Detect the main repository root when inside a git worktree.
 * Worktrees have their own toplevel but share .git with the main repo.
 * Returns null if not inside a worktree (i.e., already in the main repo).
 */
function getMainRepoRoot(): string | null {
  try {
    const commonDir = execSync('git rev-parse --git-common-dir', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const toplevel = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    // --git-common-dir returns the shared .git dir (absolute or relative).
    // For worktrees it points to the main repo's .git, for the main repo it's just ".git".
    const { resolve: resolvePath } = require('node:path');
    const absCommon = resolvePath(commonDir);
    const mainRoot = dirname(absCommon);
    // If mainRoot equals toplevel, we're in the main repo — no fallback needed.
    if (mainRoot === toplevel) return null;
    return mainRoot;
  } catch {
    return null;
  }
}

function getProjectDirectoryPath(): string {
  return join(getProjectRoot(), '.genie', 'agents.json');
}

/** Return the file path for the target scope. */
function getTargetPath(global?: boolean): string {
  return global ? getGlobalDirectoryPath() : getProjectDirectoryPath();
}

// ============================================================================
// Internal
// ============================================================================

async function loadDirectoryFrom(filePath: string): Promise<AgentDirectoryData> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return { entries: {}, lastUpdated: new Date().toISOString() };
  }
}

async function saveDirectoryTo(data: AgentDirectoryData, filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  data.lastUpdated = new Date().toISOString();
  await writeFile(filePath, JSON.stringify(data, null, 2));
}

async function withDirectoryAt<T>(filePath: string, fn: (data: AgentDirectoryData) => T | Promise<T>): Promise<T> {
  await mkdir(dirname(filePath), { recursive: true });
  const release = await acquireLock(filePath);
  try {
    const data = await loadDirectoryFrom(filePath);
    const result = await fn(data);
    await saveDirectoryTo(data, filePath);
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

  const filePath = getTargetPath(options?.global);
  await withDirectoryAt(filePath, (data) => {
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
  const filePath = getTargetPath(options?.global);
  await withDirectoryAt(filePath, (data) => {
    if (data.entries[name]) {
      delete data.entries[name];
      removed = true;
    }
  });
  return removed;
}

/**
 * Resolve an agent by name.
 * Resolution order: project → global → built-in roles → built-in council.
 */
export async function resolve(name: string): Promise<ResolvedAgent | null> {
  // 1. Check project directory (worktree or main repo)
  const projectData = await loadDirectoryFrom(getProjectDirectoryPath());
  const projectEntry = projectData.entries[name];
  if (projectEntry) {
    return { entry: projectEntry, builtin: false };
  }

  // 1b. If inside a worktree, also check the main repo's agents.json
  const mainRoot = getMainRepoRoot();
  if (mainRoot) {
    const mainDirPath = join(mainRoot, '.genie', 'agents.json');
    const mainData = await loadDirectoryFrom(mainDirPath);
    const mainEntry = mainData.entries[name];
    if (mainEntry) {
      return { entry: mainEntry, builtin: false };
    }
  }

  // 2. Check global directory
  const globalData = await loadDirectoryFrom(getGlobalDirectoryPath());
  const globalEntry = globalData.entries[name];
  if (globalEntry) {
    return { entry: globalEntry, builtin: false };
  }

  // 3. Check built-in roles
  const builtinRole = BUILTIN_ROLES.find((r: BuiltinAgent) => r.name === name);
  if (builtinRole) {
    return { entry: builtinToEntry(builtinRole), builtin: true };
  }

  // 4. Check built-in council members
  const councilMember = BUILTIN_COUNCIL_MEMBERS.find((m: BuiltinAgent) => m.name === name);
  if (councilMember) {
    return { entry: builtinToEntry(councilMember), builtin: true };
  }

  return null;
}

/**
 * List agents from all scopes with scope labels.
 * Returns project + global + (optionally built-in) entries.
 * Project entries shadow global entries of the same name.
 */
export async function ls(): Promise<ScopedDirectoryEntry[]> {
  const result: ScopedDirectoryEntry[] = [];
  const seen = new Set<string>();

  // Project entries (worktree or main repo)
  const projectData = await loadDirectoryFrom(getProjectDirectoryPath());
  for (const entry of Object.values(projectData.entries)) {
    result.push({ ...entry, scope: 'project' });
    seen.add(entry.name);
  }

  // Main repo entries (when inside a worktree, check the parent repo too)
  const mainRoot = getMainRepoRoot();
  if (mainRoot) {
    const mainDirPath = join(mainRoot, '.genie', 'agents.json');
    const mainData = await loadDirectoryFrom(mainDirPath);
    for (const entry of Object.values(mainData.entries)) {
      if (!seen.has(entry.name)) {
        result.push({ ...entry, scope: 'project' });
        seen.add(entry.name);
      }
    }
  }

  // Global entries (skip names already in project)
  const globalData = await loadDirectoryFrom(getGlobalDirectoryPath());
  for (const entry of Object.values(globalData.entries)) {
    if (!seen.has(entry.name)) {
      result.push({ ...entry, scope: 'global' });
      seen.add(entry.name);
    }
  }

  return result;
}

/**
 * Get a single entry by name from a specific scope.
 * Defaults to project scope; pass { global: true } for global.
 */
export async function get(name: string, options?: ScopeOptions): Promise<DirectoryEntry | null> {
  const filePath = getTargetPath(options?.global);
  const data = await loadDirectoryFrom(filePath);
  return data.entries[name] ?? null;
}

/**
 * Edit an existing agent entry.
 * Only provided fields are updated.
 * Defaults to project scope; pass { global: true } for global.
 */
export async function edit(
  name: string,
  updates: Partial<Pick<DirectoryEntry, 'dir' | 'repo' | 'promptMode' | 'model' | 'roles' | 'omniAgentId'>>,
  options?: ScopeOptions,
): Promise<DirectoryEntry> {
  let updated: DirectoryEntry | null = null;

  const filePath = getTargetPath(options?.global);
  await withDirectoryAt(filePath, (data) => {
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
