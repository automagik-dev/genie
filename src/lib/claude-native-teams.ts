/**
 * Claude Native Teams — Manages ~/.claude/teams/<team>/ for
 * Claude Code's native teammate IPC protocol.
 *
 * This module bridges Genie's team/worker system with Claude Code's
 * internal teammate mechanism: filesystem-based inboxes, config.json
 * member registry, and lockfile-based concurrent writes.
 *
 * When native teams are enabled, Claude Code workers auto-poll their
 * inbox and participate in the native IPC protocol (shutdown, plan
 * approval, direct messages) without needing tmux send-keys injection.
 */

import { mkdir, readFile, writeFile, rm, readdir, stat, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ClaudeTeamColor } from './provider-adapters.js';
import { CLAUDE_TEAM_COLORS } from './provider-adapters.js';

// ============================================================================
// Types
// ============================================================================

/** A member entry in the native team config.json. */
export interface NativeTeamMember {
  agentId: string;
  name: string;
  agentType: string;
  joinedAt: number;
  tmuxPaneId?: string;
  cwd?: string;
  backendType: 'tmux' | 'in-process';
  color: string;
  planModeRequired: boolean;
  isActive: boolean;
}

/** The native team config.json root structure. */
export interface NativeTeamConfig {
  name: string;
  description?: string;
  createdAt: number;
  leadAgentId: string;
  leadSessionId: string;
  members: NativeTeamMember[];
}

/** A message in Claude Code's native inbox format. */
export interface NativeInboxMessage {
  from: string;
  text: string;
  summary: string;
  timestamp: string;
  color: string;
  read: boolean;
}

// ============================================================================
// Path Helpers
// ============================================================================

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
}

function teamsBaseDir(): string {
  return join(claudeConfigDir(), 'teams');
}

/** Sanitize a name for filesystem use (Claude Code convention). */
export function sanitizeTeamName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
}

function teamDir(teamName: string): string {
  return join(teamsBaseDir(), sanitizeTeamName(teamName));
}

function configPath(teamName: string): string {
  return join(teamDir(teamName), 'config.json');
}

function inboxesDir(teamName: string): string {
  return join(teamDir(teamName), 'inboxes');
}

function inboxPath(teamName: string, agentName: string): string {
  return join(inboxesDir(teamName), `${sanitizeTeamName(agentName)}.json`);
}

function lockPath(filePath: string): string {
  return `${filePath}.lock`;
}

// ============================================================================
// Lockfile (simple polling lock for concurrent inbox writes)
// ============================================================================

const LOCK_TIMEOUT_MS = 5000;
const LOCK_POLL_MS = 50;

async function acquireLock(path: string): Promise<void> {
  const lock = lockPath(path);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      await writeFile(lock, String(process.pid), { flag: 'wx' });
      return; // acquired
    } catch {
      // Lock exists — wait with jitter and retry
      const jitter = Math.floor(Math.random() * LOCK_POLL_MS);
      await new Promise(r => setTimeout(r, LOCK_POLL_MS + jitter));
    }
  }

  // Timeout — force acquire (likely stale lock)
  console.warn(`[claude-native-teams] Force-acquiring stale lock: ${lock}`);
  await writeFile(lock, String(process.pid));
}

async function releaseLock(path: string): Promise<void> {
  try {
    await unlink(lockPath(path));
  } catch {
    // Already released
  }
}

// ============================================================================
// Config Operations
// ============================================================================

async function loadConfig(teamName: string): Promise<NativeTeamConfig | null> {
  try {
    const content = await readFile(configPath(teamName), 'utf-8');
    return JSON.parse(content);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    console.warn(`[claude-native-teams] Failed to load config for "${teamName}": ${err?.message}`);
    return null;
  }
}

async function saveConfig(teamName: string, config: NativeTeamConfig): Promise<void> {
  await writeFile(configPath(teamName), JSON.stringify(config, null, 2));
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Create the native team directory structure and config.json.
 * Idempotent — safe to call if the team already exists.
 */
export async function ensureNativeTeam(
  teamName: string,
  description: string,
  leadSessionId: string,
): Promise<NativeTeamConfig> {
  const dir = teamDir(teamName);
  const inboxDir = inboxesDir(teamName);

  await mkdir(dir, { recursive: true });
  await mkdir(inboxDir, { recursive: true });

  const existing = await loadConfig(teamName);
  if (existing) return existing;

  const sanitized = sanitizeTeamName(teamName);
  const config: NativeTeamConfig = {
    name: sanitized,
    description,
    createdAt: Date.now(),
    leadAgentId: `team-lead@${sanitized}`,
    leadSessionId,
    members: [],
  };

  await saveConfig(teamName, config);
  return config;
}

/**
 * Register a member in the native team config.json.
 */
export async function registerNativeMember(
  teamName: string,
  member: {
    agentName: string;
    agentType?: string;
    color: string;
    tmuxPaneId?: string;
    cwd?: string;
    planModeRequired?: boolean;
  },
): Promise<void> {
  const config = await loadConfig(teamName);
  if (!config) throw new Error(`Native team "${teamName}" not found`);

  const sanitized = sanitizeTeamName(teamName);
  const agentId = `${sanitizeTeamName(member.agentName)}@${sanitized}`;

  // Remove existing entry with same agentId (re-register)
  config.members = config.members.filter(m => m.agentId !== agentId);

  config.members.push({
    agentId,
    name: sanitizeTeamName(member.agentName),
    agentType: member.agentType ?? 'general-purpose',
    joinedAt: Date.now(),
    tmuxPaneId: member.tmuxPaneId,
    cwd: member.cwd ?? process.cwd(),
    backendType: 'tmux',
    color: member.color,
    planModeRequired: member.planModeRequired ?? false,
    isActive: true,
  });

  await saveConfig(teamName, config);

  // Ensure the member's inbox file exists
  const inbox = inboxPath(teamName, member.agentName);
  if (!existsSync(inbox)) {
    await writeFile(inbox, '[]');
  }
}

/**
 * Unregister a member from the native team config.json.
 * Marks them as inactive rather than removing (preserves history).
 */
export async function unregisterNativeMember(
  teamName: string,
  agentName: string,
): Promise<void> {
  const config = await loadConfig(teamName);
  if (!config) return;

  const sanitized = sanitizeTeamName(teamName);
  const agentId = `${sanitizeTeamName(agentName)}@${sanitized}`;

  const member = config.members.find(m => m.agentId === agentId);
  if (member) {
    member.isActive = false;
  }

  await saveConfig(teamName, config);
}

/**
 * Write a message to a member's native inbox (lockfile-protected).
 */
export async function writeNativeInbox(
  teamName: string,
  agentName: string,
  message: NativeInboxMessage,
): Promise<void> {
  const path = inboxPath(teamName, agentName);

  await mkdir(inboxesDir(teamName), { recursive: true });
  await acquireLock(path);

  try {
    let messages: NativeInboxMessage[] = [];
    try {
      const content = await readFile(path, 'utf-8');
      messages = JSON.parse(content);
    } catch {
      // Empty or missing inbox
    }

    messages.push(message);
    await writeFile(path, JSON.stringify(messages, null, 2));
  } finally {
    await releaseLock(path);
  }
}

/**
 * Read all messages from a member's native inbox.
 */
export async function readNativeInbox(
  teamName: string,
  agentName: string,
): Promise<NativeInboxMessage[]> {
  try {
    const content = await readFile(inboxPath(teamName, agentName), 'utf-8');
    return JSON.parse(content);
  } catch {
    return [];
  }
}

/**
 * Assign the next unused color from the palette for a team.
 */
export async function assignColor(teamName: string): Promise<ClaudeTeamColor> {
  const config = await loadConfig(teamName);
  if (!config) return CLAUDE_TEAM_COLORS[0];

  const usedColors = new Set(config.members.map(m => m.color));

  for (const color of CLAUDE_TEAM_COLORS) {
    if (!usedColors.has(color)) return color;
  }

  // All colors used — cycle based on member count
  return CLAUDE_TEAM_COLORS[config.members.length % CLAUDE_TEAM_COLORS.length];
}

/**
 * Clear all messages from a member's native inbox.
 * Called on worker kill to prevent new workers from inheriting stale messages.
 */
export async function clearNativeInbox(teamName: string, agentName: string): Promise<void> {
  const path = inboxPath(teamName, agentName);
  await acquireLock(path);
  try {
    await writeFile(path, '[]');
  } finally {
    await releaseLock(path);
  }
}

/**
 * Delete the native team directory entirely.
 */
export async function deleteNativeTeam(teamName: string): Promise<boolean> {
  const dir = teamDir(teamName);
  if (!existsSync(dir)) return false;

  await rm(dir, { recursive: true, force: true });
  return true;
}

/**
 * Check if a native team exists.
 */
export function nativeTeamExists(teamName: string): boolean {
  return existsSync(configPath(teamName));
}

/**
 * Get the native team directory path (for external inspection).
 */
export function getNativeTeamDir(teamName: string): string {
  return teamDir(teamName);
}

// ============================================================================
// Session Discovery
// ============================================================================

/**
 * Sanitize a filesystem path the same way Claude Code does.
 * /Users/luis/Dev/project → -Users-luis-Dev-project
 */
function sanitizePath(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Discover the active Claude Code session ID for the given working directory.
 *
 * Strategy:
 *   1. Check CLAUDE_CODE_SESSION_ID env var (set when WE are a teammate)
 *   2. Find the most recently modified .jsonl in ~/.claude/projects/<sanitized-cwd>/
 *      The UUID filename IS the session ID.
 */
export async function discoverClaudeSessionId(cwd?: string): Promise<string | null> {
  // 1. Env var (when running as a teammate, CC sets this)
  const envSessionId = process.env.CLAUDE_CODE_SESSION_ID;
  if (envSessionId) return envSessionId;

  // 2. Find most recently written JSONL in the project directory
  const projectDir = join(claudeConfigDir(), 'projects', sanitizePath(cwd ?? process.cwd()));

  try {
    const entries = await readdir(projectDir);
    const jsonls = entries.filter(e => e.endsWith('.jsonl'));

    if (jsonls.length === 0) return null;

    // Find the most recently modified one
    let newest: { name: string; mtime: number } | null = null;
    for (const name of jsonls) {
      const s = await stat(join(projectDir, name));
      if (!newest || s.mtimeMs > newest.mtime) {
        newest = { name, mtime: s.mtimeMs };
      }
    }

    if (!newest) return null;

    // Filename is <uuid>.jsonl — extract the UUID
    return newest.name.replace('.jsonl', '');
  } catch {
    return null;
  }
}

/**
 * Check if we're running inside Claude Code.
 */
export function isInsideClaudeCode(): boolean {
  return process.env.CLAUDECODE === '1';
}

/**
 * Discover the team name for the current Claude Code session.
 *
 * Strategy:
 *   1. Check GENIE_TEAM env var (set by genie tui)
 *   2. Find session ID, scan team configs to match leadSessionId
 */
export async function discoverTeamName(cwd?: string): Promise<string | null> {
  // 1. Explicit env var
  const envTeam = process.env.GENIE_TEAM;
  if (envTeam) return envTeam;

  // 2. Match session ID against team configs
  const sessionId = await discoverClaudeSessionId(cwd);
  if (!sessionId) return null;

  const base = teamsBaseDir();
  try {
    const teams = await readdir(base);
    for (const name of teams) {
      const cfgPath = join(base, name, 'config.json');
      try {
        const content = await readFile(cfgPath, 'utf-8');
        const config: NativeTeamConfig = JSON.parse(content);
        if (config.leadSessionId === sessionId) return config.name;
      } catch {
        // skip invalid configs
      }
    }
  } catch {
    // no teams dir
  }

  return null;
}

/**
 * Check if native teams feature is enabled.
 */
export function isNativeTeamsEnabled(): boolean {
  return process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === '1';
}

// ============================================================================
// Team Lead Registration
// ============================================================================

/**
 * Register the current Claude Code session as team lead of a native team.
 *
 * Called when Genie TUI starts up and creates/joins a team.
 * This makes the CC leader visible in the native team config, so
 * spawned workers can reference its session ID for the IPC protocol.
 */
export async function registerAsTeamLead(
  teamName: string,
  opts?: {
    cwd?: string;
    tmuxPaneId?: string;
    color?: string;
  },
): Promise<{ sessionId: string; config: NativeTeamConfig }> {
  const sessionId = await discoverClaudeSessionId(opts?.cwd);
  if (!sessionId) {
    throw new Error(
      'Could not discover Claude Code session ID. ' +
      'Are you running inside Claude Code with CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1?'
    );
  }

  // Create or load the native team, using the real CC session ID
  const config = await ensureNativeTeam(
    teamName,
    `Genie team: ${teamName}`,
    sessionId,
  );

  // Update leadSessionId if the team already existed with a stale ID
  if (config.leadSessionId !== sessionId) {
    config.leadSessionId = sessionId;
    await saveConfig(teamName, config);
  }

  // Register the leader as a member (CC expects the lead in the members array)
  const sanitized = sanitizeTeamName(teamName);
  const leadAgentId = `team-lead@${sanitized}`;
  const existingLead = config.members.find(m => m.agentId === leadAgentId);

  if (!existingLead || !existingLead.isActive) {
    await registerNativeMember(teamName, {
      agentName: 'team-lead',
      agentType: 'general-purpose',
      color: opts?.color ?? 'blue',
      tmuxPaneId: opts?.tmuxPaneId ?? process.env.TMUX_PANE,
      cwd: opts?.cwd ?? process.cwd(),
    });
  }

  // Ensure the team-lead inbox exists
  const inbox = inboxPath(teamName, 'team-lead');
  if (!existsSync(inbox)) {
    await writeFile(inbox, '[]');
  }

  // Return the final config
  const finalConfig = await loadConfig(teamName);
  return { sessionId, config: finalConfig! };
}
