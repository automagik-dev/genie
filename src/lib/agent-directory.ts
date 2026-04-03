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
  /** Agent description from AGENTS.md frontmatter. */
  description?: string;
  /** Display color for TUI/terminal output. */
  color?: string;
  /** AI provider: 'claude' | 'codex' | 'claude-sdk'. Resolved at spawn time. */
  provider?: string;
  /** Permission config for SDK provider (allowlist-only). */
  permissions?: {
    preset?: string;
    allow?: string[];
    bashAllowPatterns?: string[];
  };
}

export type DirectoryScope = 'project' | 'global' | 'built-in' | 'archived';

export interface ScopedDirectoryEntry extends DirectoryEntry {
  scope: DirectoryScope;
}

interface ScopeOptions {
  global?: boolean;
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

  // Build metadata JSONB from frontmatter fields
  const metadata = buildMetadata(full);

  // Store as a directory agent in PG with metadata
  const { getConnection } = await import('./db.js');
  const sql = await getConnection();
  await sql`
    INSERT INTO agents (id, role, custom_name, started_at, metadata)
    VALUES (${`dir:${entry.name}`}, ${entry.name}, ${entry.name}, now(), ${sql.json(metadata)})
    ON CONFLICT (id) DO UPDATE SET metadata = ${sql.json(metadata)}
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
  // 1. Check PG agents table — look for agents with matching role, include metadata
  try {
    const { getConnection } = await import('./db.js');
    const sql = await getConnection();
    const rows = await sql`SELECT role, metadata FROM agents WHERE role = ${name} LIMIT 1`;
    if (rows.length > 0) {
      const meta = parseMetadata(rows[0].metadata);
      return { entry: roleToEntry(name, undefined, meta), builtin: false };
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
      SELECT DISTINCT ON (a.role) a.role, a.team, a.metadata, e.repo_path, e.provider
      FROM agents a
      LEFT JOIN executors e ON a.current_executor_id = e.id
      WHERE a.role IS NOT NULL
      ORDER BY a.role, a.started_at DESC
    `;
    for (const row of rows) {
      const name = row.role as string;
      if (!seen.has(name)) {
        const meta = parseMetadata(row.metadata);
        const entry = roleToEntry(name, row.team as string, meta);
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
  updates: Partial<
    Pick<
      DirectoryEntry,
      | 'dir'
      | 'repo'
      | 'promptMode'
      | 'model'
      | 'roles'
      | 'omniAgentId'
      | 'description'
      | 'color'
      | 'provider'
      | 'permissions'
    >
  >,
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

  const updated = Object.assign(existing, updates);

  // Build metadata patch from updated entry and persist to PG
  const metadataPatch = buildMetadata(updated);
  try {
    const { getConnection } = await import('./db.js');
    const sql = await getConnection();
    // Try dir: prefix first (directory-managed agents), fall back to role match
    // for runtime-spawned agents that share a name with workspace agents
    const result = await sql`
      UPDATE agents
      SET metadata = metadata || ${sql.json(metadataPatch)}
      WHERE id = ${`dir:${name}`}
    `;
    if (result.count === 0) {
      await sql`
        UPDATE agents
        SET metadata = metadata || ${sql.json(metadataPatch)}
        WHERE role = ${name}
      `;
    }
  } catch {
    /* PG unavailable — in-memory update still applied */
  }

  return updated;
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

/** Convert a PG agent role to a synthetic DirectoryEntry, enriched with metadata.
 *  When metadata is present, it takes priority over built-in defaults
 *  (PG entries represent user overrides or directory-synced agents). */
function roleToEntry(role: string, team?: string, metadata?: Record<string, unknown>): DirectoryEntry {
  const hasMetadata = metadata && Object.keys(metadata).length > 0;

  // Only fall back to built-in when there's no PG metadata to use
  if (!hasMetadata) {
    const builtin = [...BUILTIN_ROLES, ...BUILTIN_COUNCIL_MEMBERS].find((b) => b.name === role);
    if (builtin) return builtinToEntry(builtin);
  }

  return {
    name: role,
    dir: (metadata?.dir as string) || '',
    promptMode: (metadata?.promptMode as PromptMode) || 'append',
    model: metadata?.model as string | undefined,
    roles: [],
    registeredAt: new Date().toISOString(),
    description: metadata?.description as string | undefined,
    color: metadata?.color as string | undefined,
    provider: metadata?.provider as string | undefined,
    permissions: metadata?.permissions as DirectoryEntry['permissions'],
    ...(metadata?.repo ? { repo: metadata.repo as string } : team ? { repo: team } : {}),
  };
}

/** Build a metadata JSONB object from a DirectoryEntry's frontmatter fields. */
function buildMetadata(entry: DirectoryEntry): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (entry.dir) meta.dir = entry.dir;
  if (entry.repo) meta.repo = entry.repo;
  if (entry.model) meta.model = entry.model;
  if (entry.promptMode && entry.promptMode !== 'append') meta.promptMode = entry.promptMode;
  if (entry.description) meta.description = entry.description;
  if (entry.color) meta.color = entry.color;
  if (entry.provider) meta.provider = entry.provider;
  if (entry.permissions) meta.permissions = entry.permissions;
  return meta;
}

/** Parse a JSONB metadata value — handles both parsed objects and string-encoded JSON. */
function parseMetadata(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return {};
}
