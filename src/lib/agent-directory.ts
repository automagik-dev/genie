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
import type { SdkDirectoryConfig } from './sdk-directory-types.js';

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
  /**
   * Template-pinned team from the `agent_templates` PG row (authoritative).
   * When present, this is the canonical team for the agent, regardless of
   * which tmux session or workspace the caller is sitting in. Consumed by
   * `resolveTeamName` as tier 2 of the team-resolution precedence.
   */
  team?: string;
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
    deny?: string[];
    bashAllowPatterns?: string[];
  };
  /** Tools the agent is NOT allowed to use (Claude Code --disallowedTools). */
  disallowedTools?: string[];
  /** Omni API scopes the agent is restricted to (e.g., 'say', 'react'). */
  omniScopes?: string[];
  /** Claude Code hooks configuration. */
  hooks?: Record<string, unknown>;
  /** Full SDK Options configuration for claude-sdk provider sessions. */
  sdk?: SdkDirectoryConfig;
  /**
   * Override for the tmux session name the Omni bridge will spawn into.
   * When set, hierarchical or grouped agents can share a parent's session
   * (e.g. `felipe/scout` with `bridgeTmuxSession: felipe` lands next to
   * felipe's windows in the attached TUI). Overridden per-dispatch by the
   * `GENIE_TMUX_SESSION` env var propagated via NATS. When neither is set,
   * the bridge falls back to the agent name (current behavior).
   */
  bridgeTmuxSession?: string;
}

export type DirectoryScope = 'project' | 'global' | 'built-in' | 'archived';

export interface ScopedDirectoryEntry extends DirectoryEntry {
  scope: DirectoryScope;
}

interface ScopeOptions {
  global?: boolean;
}

/**
 * Options for {@link rm}.
 *
 * `force`: when true, also delete non-`dir:` agent rows (spawn/runtime rows
 * with id shapes like `<team>-<role>` or UUID) whose `role` matches `name`.
 * Without this flag, `rm` only removes the `dir:<name>` row and returns a
 * warning message listing the live instance ids if any exist.
 */
interface RmOptions extends ScopeOptions {
  force?: boolean;
}

/**
 * Result of {@link rm}.
 *
 * `message`: human-readable explanation when `removed=false` and live runtime
 * rows exist for the same role (so the caller can print guidance instead of a
 * generic "not found" message).
 */
interface RmResult {
  removed: boolean;
  message?: string;
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

  // Store as a directory agent in PG with metadata.
  // state = NULL: directory records (id prefix `dir:`) are identity rows that
  // track state through their runtime/executor children, not the legacy `state`
  // column. NULL prevents reconcileStaleSpawns() from false-positive sweeping
  // them to 'error' ~60s after every `genie serve` boot (column DEFAULT is
  // 'spawning'). Mirrors the defense in identityCreate() (agent-registry.ts).
  const { getConnection } = await import('./db.js');
  const sql = await getConnection();
  await sql`
    INSERT INTO agents (id, role, custom_name, started_at, state, metadata)
    VALUES (${`dir:${entry.name}`}, ${entry.name}, ${entry.name}, now(), ${null}, ${sql.json(metadata)})
    ON CONFLICT (id) DO UPDATE SET metadata = ${sql.json(metadata)}
  `;

  return full;
}

/**
 * Remove an agent from the directory.
 *
 * Storage symmetry with {@link ls}:
 *   - `ls()` surfaces rows by `role`, regardless of id shape (dir:, team-role, UUID).
 *   - `rm()` first tries the canonical `dir:<name>` row. If that row exists, it is
 *     deleted and we are done.
 *   - If no `dir:` row exists but runtime rows with matching `role` do, we return
 *     `removed: false` plus a `message` naming the live instance ids and pointing
 *     the user at `genie kill <id>` or `--force`. Without this, `rm` used to
 *     report "not found" on agents that `ls` was happily displaying.
 *   - With `force: true`, we additionally wipe every row whose `role = name`,
 *     which is how users can reclaim a name whose directory entry was lost but
 *     whose runtime/spawn rows linger.
 */
export async function rm(name: string, options?: RmOptions): Promise<RmResult> {
  const { getConnection } = await import('./db.js');
  const sql = await getConnection();

  // 1. Canonical directory row: id = 'dir:<name>'
  const dirDelete = await sql`DELETE FROM agents WHERE id = ${`dir:${name}`}`;
  const dirRemoved = dirDelete.count > 0;

  if (options?.force) {
    // --force: also purge any runtime/spawn rows sharing this role.
    const roleDelete = await sql`DELETE FROM agents WHERE role = ${name}`;
    return { removed: dirRemoved || roleDelete.count > 0 };
  }

  if (dirRemoved) return { removed: true };

  // 2. No dir: row — check for runtime rows that `ls()` would surface.
  const instances = await sql`SELECT id FROM agents WHERE role = ${name}`;
  if (instances.length === 0) {
    return { removed: false };
  }

  const idList = instances.map((r: { id: string }) => r.id).join(', ');
  return {
    removed: false,
    message: `No directory entry for "${name}". Active instances: ${idList}. Use 'genie kill <id>' to terminate, or re-run with --force to remove all.`,
  };
}

/**
 * Resolve an agent by name.
 * Resolution order: PG agents (by role) → built-in roles → built-in council.
 */
export async function resolve(name: string): Promise<ResolvedAgent | null> {
  // Template-pinned team from agent_templates (authoritative for canonical spawns).
  // Looked up once and attached to whatever entry we return below.
  const templateTeam = await lookupTemplateTeam(name);

  // 1. Check PG agents table — look for agents with matching role, include metadata
  try {
    const { getConnection } = await import('./db.js');
    const sql = await getConnection();
    const rows = await sql`
      SELECT role, metadata, created_at FROM agents
      WHERE role = ${name}
      ORDER BY (CASE WHEN id LIKE 'dir:%' THEN 0 ELSE 1 END), started_at DESC
      LIMIT 1
    `;
    if (rows.length > 0) {
      const meta = parseMetadata(rows[0].metadata);
      const createdAt =
        rows[0].created_at instanceof Date
          ? rows[0].created_at.toISOString()
          : (rows[0].created_at as string | undefined);
      const entry = roleToEntry(name, undefined, meta, createdAt);
      if (templateTeam) entry.team = templateTeam;
      return { entry, builtin: false };
    }
  } catch {
    /* PG unavailable — fall through to built-ins */
  }

  // 3. Check built-in roles
  const builtinRole = BUILTIN_ROLES.find((r: BuiltinAgent) => r.name === name);
  if (builtinRole) {
    const entry = builtinToEntry(builtinRole);
    if (templateTeam) entry.team = templateTeam;
    return { entry, builtin: true };
  }

  // 4. Check built-in council members
  const councilMember = BUILTIN_COUNCIL_MEMBERS.find((m: BuiltinAgent) => m.name === name);
  if (councilMember) {
    const entry = builtinToEntry(councilMember);
    if (templateTeam) entry.team = templateTeam;
    return { entry, builtin: true };
  }

  return null;
}

/**
 * Look up the template-pinned team for an agent name from `agent_templates`.
 * Returns null when PG is unavailable, the row does not exist, or the team
 * column is empty. This is an authoritative PG lookup — NOT a synthetic
 * tmux/env fallback — and powers tier 2 of the team-resolution precedence.
 */
async function lookupTemplateTeam(name: string): Promise<string | null> {
  try {
    const { getConnection } = await import('./db.js');
    const sql = await getConnection();
    const rows = await sql`SELECT team FROM agent_templates WHERE id = ${name} LIMIT 1`;
    if (rows.length === 0) return null;
    const team = rows[0].team;
    return typeof team === 'string' && team.length > 0 ? team : null;
  } catch (err) {
    // Previously silently swallowed — real PG failures (connection drops,
    // missing table) hid behind a null return and showed up as mysterious
    // "team is undefined" regressions downstream. Log the full error so the
    // failure is visible; still return null so production callers that
    // legitimately run without PG continue to work.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[agent-directory] lookupTemplateTeam(${name}) failed: ${msg}\n`);
    return null;
  }
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
      SELECT DISTINCT ON (a.role) a.role, a.team, a.metadata, a.created_at, e.repo_path, e.provider
      FROM agents a
      LEFT JOIN executors e ON a.current_executor_id = e.id
      WHERE a.role IS NOT NULL
      ORDER BY a.role, (CASE WHEN a.id LIKE 'dir:%' THEN 0 ELSE 1 END), a.started_at DESC
    `;
    for (const row of rows) {
      const name = row.role as string;
      if (!seen.has(name)) {
        const meta = parseMetadata(row.metadata);
        const createdAt =
          row.created_at instanceof Date ? row.created_at.toISOString() : (row.created_at as string | undefined);
        const entry = roleToEntry(name, row.team as string, meta, createdAt);
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
      | 'disallowedTools'
      | 'omniScopes'
      | 'hooks'
      | 'sdk'
      | 'bridgeTmuxSession'
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
 *  (PG entries represent user overrides or directory-synced agents).
 *
 *  `registeredAt` is sourced from the caller-provided `createdAt` (PG
 *  `agents.created_at`) or `metadata.registeredAt` if present — never
 *  fabricated at read time. Two reads of the same row must produce the
 *  same `registeredAt`, otherwise the UI implies a phantom re-registration. */
function roleToEntry(
  role: string,
  team?: string,
  metadata?: Record<string, unknown>,
  createdAt?: string,
): DirectoryEntry {
  const hasMetadata = metadata && Object.keys(metadata).length > 0;

  // Only fall back to built-in when there's no PG metadata to use
  if (!hasMetadata) {
    const builtin = [...BUILTIN_ROLES, ...BUILTIN_COUNCIL_MEMBERS].find((b) => b.name === role);
    if (builtin) return builtinToEntry(builtin);
  }

  const registeredAt =
    (typeof metadata?.registeredAt === 'string' ? (metadata.registeredAt as string) : undefined) ?? createdAt ?? '';

  return {
    name: role,
    dir: (metadata?.dir as string) || '',
    promptMode: (metadata?.promptMode as PromptMode) || 'append',
    model: metadata?.model as string | undefined,
    roles: Array.isArray(metadata?.roles) ? (metadata.roles as string[]) : [],
    registeredAt,
    description: metadata?.description as string | undefined,
    color: metadata?.color as string | undefined,
    provider: metadata?.provider as string | undefined,
    permissions: metadata?.permissions as DirectoryEntry['permissions'],
    disallowedTools: metadata?.disallowedTools as string[] | undefined,
    omniScopes: metadata?.omniScopes as string[] | undefined,
    hooks: metadata?.hooks as Record<string, unknown> | undefined,
    sdk: metadata?.sdk as SdkDirectoryConfig | undefined,
    bridgeTmuxSession: metadata?.bridgeTmuxSession as string | undefined,
    ...(metadata?.repo ? { repo: metadata.repo as string } : team ? { repo: team } : {}),
  };
}

/** Build a metadata JSONB object from a DirectoryEntry's frontmatter fields. */
function buildMetadata(entry: DirectoryEntry): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  const assignTruthy = <K extends keyof DirectoryEntry>(key: K) => {
    if (entry[key]) meta[key as string] = entry[key];
  };
  assignTruthy('dir');
  assignTruthy('repo');
  assignTruthy('model');
  if (entry.promptMode && entry.promptMode !== 'append') meta.promptMode = entry.promptMode;
  assignTruthy('description');
  assignTruthy('color');
  assignTruthy('provider');
  if (entry.roles && entry.roles.length > 0) meta.roles = entry.roles;
  assignTruthy('permissions');
  assignTruthy('disallowedTools');
  assignTruthy('omniScopes');
  assignTruthy('hooks');
  assignTruthy('sdk');
  // Always emit bridgeTmuxSession (as null when unset) so the JSONB merge in
  // edit() can overwrite a stale persisted value.
  meta.bridgeTmuxSession = entry.bridgeTmuxSession ?? null;
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

// `syncFrontmatterToDisk` was removed by wish `dir-sync-frontmatter-refresh`
// Group 4 (PR feat/dir-sync-frontmatter-refresh-group4). Its purpose was to
// mirror DB edits back into AGENTS.md frontmatter, but AGENTS.md is now
// body-only post-migration — the canonical file is `agents/<name>/agent.yaml`,
// written directly by the `dir edit` handler. No replacement is needed.
