/**
 * Agent Directory — Persistent agent registry with CRUD operations.
 *
 * Stores agent identity entries at `~/.genie/agent-directory.json`.
 * Each entry records the agent's folder (CWD + AGENTS.md source),
 * optional repo, prompt mode, default model, and declared roles.
 *
 * Resolution order: user directory > built-in registry.
 * Uses file-lock pattern (same as agent-registry.ts) for concurrent access.
 */

import { existsSync } from 'node:fs';
import { mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { BUILTIN_COUNCIL_MEMBERS, BUILTIN_ROLES, type BuiltinAgent } from './builtin-agents.js';

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
  /** ISO timestamp of registration. */
  registeredAt: string;
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

function getDirectoryFilePath(): string {
  return join(getGlobalDir(), 'agent-directory.json');
}

// ============================================================================
// File Locking — prevents concurrent load/modify/save races
// ============================================================================

const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 50;
const LOCK_STALE_MS = 10000;

async function tryCleanStaleLock(lockPath: string): Promise<boolean> {
  try {
    const lockStat = await stat(lockPath);
    if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
      try {
        await unlink(lockPath);
      } catch {
        /* race with other cleanup */
      }
      return true;
    }
  } catch {
    return true; // lock gone, retry
  }
  return false;
}

async function tryCreateLock(lockPath: string): Promise<(() => Promise<void>) | null> {
  try {
    const handle = await open(lockPath, 'wx');
    await handle.writeFile(String(process.pid));
    await handle.close();
    return async () => {
      try {
        await unlink(lockPath);
      } catch {
        /* already removed */
      }
    };
  } catch (err) {
    const errCode = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (errCode !== 'EEXIST') throw err;
    return null;
  }
}

async function acquireLock(): Promise<() => Promise<void>> {
  const lockPath = `${getDirectoryFilePath()}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    const release = await tryCreateLock(lockPath);
    if (release) return release;

    const cleaned = await tryCleanStaleLock(lockPath);
    if (cleaned) continue;

    if (Date.now() > deadline) {
      try {
        await unlink(lockPath);
      } catch {
        throw new Error(`Directory lock timeout: could not remove stale lock at ${lockPath}`);
      }
      continue;
    }
    await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
  }
}

// ============================================================================
// Internal
// ============================================================================

async function loadDirectory(): Promise<AgentDirectoryData> {
  try {
    const content = await readFile(getDirectoryFilePath(), 'utf-8');
    return JSON.parse(content);
  } catch {
    return { entries: {}, lastUpdated: new Date().toISOString() };
  }
}

async function saveDirectory(data: AgentDirectoryData): Promise<void> {
  const filePath = getDirectoryFilePath();
  await mkdir(dirname(filePath), { recursive: true });
  data.lastUpdated = new Date().toISOString();
  await writeFile(filePath, JSON.stringify(data, null, 2));
}

async function withDirectory<T>(fn: (data: AgentDirectoryData) => T | Promise<T>): Promise<T> {
  const release = await acquireLock();
  try {
    const data = await loadDirectory();
    const result = await fn(data);
    await saveDirectory(data);
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
 */
export async function add(entry: Omit<DirectoryEntry, 'registeredAt'>): Promise<DirectoryEntry> {
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

  await withDirectory((data) => {
    if (data.entries[entry.name]) {
      throw new Error(`Agent "${entry.name}" already exists. Use "genie dir edit" to update or "genie dir rm" first.`);
    }
    data.entries[entry.name] = full;
  });

  return full;
}

/**
 * Remove an agent from the directory.
 */
export async function rm(name: string): Promise<boolean> {
  let removed = false;
  await withDirectory((data) => {
    if (data.entries[name]) {
      delete data.entries[name];
      removed = true;
    }
  });
  return removed;
}

/**
 * Resolve an agent by name.
 * Resolution order: user directory > built-in roles > built-in council members.
 */
export async function resolve(name: string): Promise<ResolvedAgent | null> {
  // 1. Check user directory
  const data = await loadDirectory();
  const userEntry = data.entries[name];
  if (userEntry) {
    return { entry: userEntry, builtin: false };
  }

  // 2. Check built-in roles
  const builtinRole = BUILTIN_ROLES.find((r: BuiltinAgent) => r.name === name);
  if (builtinRole) {
    return { entry: builtinToEntry(builtinRole), builtin: true };
  }

  // 3. Check built-in council members
  const councilMember = BUILTIN_COUNCIL_MEMBERS.find((m: BuiltinAgent) => m.name === name);
  if (councilMember) {
    return { entry: builtinToEntry(councilMember), builtin: true };
  }

  return null;
}

/**
 * List all user-registered agents.
 */
export async function ls(): Promise<DirectoryEntry[]> {
  const data = await loadDirectory();
  return Object.values(data.entries);
}

/**
 * Get a single entry by name (user directory only).
 */
export async function get(name: string): Promise<DirectoryEntry | null> {
  const data = await loadDirectory();
  return data.entries[name] ?? null;
}

/**
 * Edit an existing agent entry.
 * Only provided fields are updated.
 */
export async function edit(
  name: string,
  updates: Partial<Pick<DirectoryEntry, 'dir' | 'repo' | 'promptMode' | 'model' | 'roles'>>,
): Promise<DirectoryEntry> {
  let updated: DirectoryEntry | null = null;

  await withDirectory((data) => {
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
