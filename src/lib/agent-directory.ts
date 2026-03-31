/**
 * Agent Directory — Derived from PG agents table + built-in definitions.
 *
 * Resolution order: PG agents (by role) → built-in roles → built-in council.
 * No JSON files — agent-directory.json and agents.json are eliminated.
 * Built-in agent definitions remain in code (builtin-agents.ts).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
  /** Omni agent UUID — set when agent is registered in Omni. */
  omniAgentId?: string;
  /** ISO timestamp of registration. */
  registeredAt: string;
}

export type DirectoryScope = 'project' | 'global' | 'built-in' | 'archived';

export interface ScopedDirectoryEntry extends DirectoryEntry {
  scope: DirectoryScope;
}

interface ScopeOptions {
  global?: boolean;
}

interface StoreRow {
  name: string;
  item_type: string;
  install_path: string | null;
  manifest: Record<string, unknown> | null;
  installed_at: string;
}

/** Resolved agent — either a user directory entry or a built-in. */
interface ResolvedAgent {
  /** The agent entry (user or synthetic built-in). */
  entry: DirectoryEntry;
  /** Whether this came from the built-in registry. */
  builtin: boolean;
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Detect the project root via git. Falls back to process.cwd().
 * Respects GENIE_PROJECT_ROOT env var for testing.
 */
export function getProjectRoot(): string {
  if (process.env.GENIE_PROJECT_ROOT) return process.env.GENIE_PROJECT_ROOT;
  try {
    const { execSync } = require('node:child_process');
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return process.cwd();
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Add an agent to the directory.
 * Validates that dir exists and contains AGENTS.md.
 * Stores as a record in PG agents table.
 */
export async function add(
  entry: Omit<DirectoryEntry, 'registeredAt'>,
  _options?: ScopeOptions,
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

  // Check if already exists as a non-builtin
  const existing = await resolve(entry.name);
  if (existing && !existing.builtin) {
    throw new Error(`Agent "${entry.name}" already exists. Use "genie dir edit" to update or "genie dir rm" first.`);
  }

  // Store as a directory agent in PG (identity columns only)
  const { getConnection } = await import('./db.js');
  const sql = await getConnection();
  await sql`
    INSERT INTO agents (id, role, custom_name, started_at)
    VALUES (${`dir:${entry.name}`}, ${entry.name}, ${entry.name}, now())
    ON CONFLICT (id) DO NOTHING
  `;

  return full;
}

/**
 * Remove an agent from the directory.
 */
export async function rm(name: string, _options?: ScopeOptions): Promise<boolean> {
  const { getConnection } = await import('./db.js');
  const sql = await getConnection();
  const result = await sql`DELETE FROM agents WHERE id = ${`dir:${name}`}`;
  return result.count > 0;
}

/**
 * Resolve an agent by name.
 * Resolution order: PG agents (by role) → built-in roles → built-in council.
 */
export async function resolve(name: string): Promise<ResolvedAgent | null> {
  // 1. Check app_store — source of truth for synced/scaffolded agents
  try {
    const item = await getItemFromStore(name);
    if (item && item.item_type === 'agent') {
      const manifest = (item.manifest ?? {}) as Record<string, unknown>;
      if (!manifest.archived) {
        return { entry: storeRowToEntry(item), builtin: false };
      }
    }
  } catch {
    /* app_store unavailable — fall through */
  }

  // 2. Check PG agents table — look for agents with matching role
  try {
    const { getConnection } = await import('./db.js');
    const sql = await getConnection();
    const rows = await sql`SELECT DISTINCT role FROM agents WHERE role = ${name} LIMIT 1`;
    if (rows.length > 0) {
      return { entry: roleToEntry(name), builtin: false };
    }
  } catch {
    /* PG unavailable — fall through to built-ins */
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
 * Find the tmux session name for the agent that owns a given repo path.
 * Queries PG agents table for an active agent whose repo_path matches.
 * Returns null if no match or PG is unavailable.
 */
export async function findSessionByRepo(repoPath: string): Promise<string | null> {
  try {
    const { getConnection } = await import('./db.js');
    const sql = await getConnection();
    const rows = await sql`
      SELECT session FROM agents
      WHERE repo_path = ${repoPath}
        AND session IS NOT NULL
        AND session != ''
        AND state IN ('working', 'idle', 'permission', 'question')
      ORDER BY started_at DESC
      LIMIT 1
    `;
    return rows.length > 0 ? (rows[0].session as string) : null;
  } catch {
    return null;
  }
}

/**
 * List agents from all scopes with scope labels.
 * Returns PG-derived entries + built-in entries.
 */
export async function ls(): Promise<ScopedDirectoryEntry[]> {
  const result: ScopedDirectoryEntry[] = [];
  const seen = new Set<string>();

  // PG agents — distinct roles with directory metadata
  try {
    const { getConnection } = await import('./db.js');
    const sql = await getConnection();
    const rows = await sql`
      SELECT DISTINCT ON (a.role) a.role, a.team, e.repo_path, e.provider
      FROM agents a
      LEFT JOIN executors e ON a.current_executor_id = e.id
      WHERE a.role IS NOT NULL
      ORDER BY a.role, a.started_at DESC
    `;
    for (const row of rows) {
      const name = row.role as string;
      if (!seen.has(name)) {
        const entry = roleToEntry(name, row.team as string);
        const repoPath = row.repo_path as string;
        if (repoPath) {
          entry.dir = repoPath;
          entry.repo = repoPath;
        }
        result.push({ ...entry, scope: 'global' });
        seen.add(name);
      }
    }
  } catch {
    /* PG unavailable — show built-ins only */
  }

  return result;
}

/**
 * Get a single entry by name.
 */
export async function get(name: string, _options?: ScopeOptions): Promise<DirectoryEntry | null> {
  const resolved = await resolve(name);
  return resolved?.entry ?? null;
}

/**
 * Edit an existing agent entry.
 * Only provided fields are updated.
 */
export async function edit(
  name: string,
  updates: Partial<Pick<DirectoryEntry, 'dir' | 'repo' | 'promptMode' | 'model' | 'roles' | 'omniAgentId'>>,
  _options?: ScopeOptions,
): Promise<DirectoryEntry> {
  if (updates.dir) {
    if (!existsSync(updates.dir)) {
      throw new Error(`Directory does not exist: ${updates.dir}`);
    }
    const agentsPath = join(updates.dir, 'AGENTS.md');
    if (!existsSync(agentsPath)) {
      throw new Error(`AGENTS.md not found in ${updates.dir}.`);
    }
  }

  const existing = await get(name);
  if (!existing) {
    throw new Error(`Agent "${name}" not found in directory.`);
  }

  return Object.assign(existing, updates);
}

/**
 * Load the AGENTS.md identity file for an agent.
 * Returns the file path (not content) for use with --system-prompt-file.
 * Returns null if the file doesn't exist.
 */
export function loadIdentity(entry: DirectoryEntry): string | null {
  if (!entry.dir) return null;
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
    dir: '',
    promptMode: agent.promptMode ?? 'append',
    model: agent.model,
    roles: [],
    registeredAt: '(built-in)',
  };
}

async function getItemFromStore(name: string): Promise<StoreRow | null> {
  const { getConnection } = await import('./db.js');
  const sql = await getConnection();
  const rows = await sql`
    SELECT name, item_type, install_path, manifest, installed_at
    FROM app_store
    WHERE name = ${name}
    LIMIT 1
  `;
  return (rows[0] as StoreRow | undefined) ?? null;
}

function storeRowToEntry(item: StoreRow): DirectoryEntry {
  const manifest = (item.manifest ?? {}) as Record<string, unknown>;
  return {
    name: item.name,
    dir: (item.install_path as string) ?? '',
    repo: (manifest.repo as string) ?? undefined,
    promptMode: ((manifest.promptMode as string) ?? 'append') as PromptMode,
    model: manifest.model as string | undefined,
    roles: Array.isArray(manifest.roles) ? (manifest.roles as string[]) : [],
    registeredAt: item.installed_at,
  };
}

/** Convert a PG agent role to a synthetic DirectoryEntry. */
function roleToEntry(role: string, team?: string): DirectoryEntry {
  const builtin = [...BUILTIN_ROLES, ...BUILTIN_COUNCIL_MEMBERS].find((b) => b.name === role);
  if (builtin) return builtinToEntry(builtin);

  return {
    name: role,
    dir: '',
    promptMode: 'append',
    roles: [],
    registeredAt: new Date().toISOString(),
    ...(team ? { repo: team } : {}),
  };
}
