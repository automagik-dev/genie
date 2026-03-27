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

import { existsSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeTeamColor } from './provider-adapters.js';
import { CLAUDE_TEAM_COLORS } from './provider-adapters.js';

// ============================================================================
// Types
// ============================================================================

/** A member entry in the native team config.json. */
interface NativeTeamMember {
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
interface NativeTeamConfig {
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

/** List all team directories in ~/.claude/teams/. */
export async function listTeams(): Promise<string[]> {
  try {
    const entries = await readdir(teamsBaseDir());
    return entries.filter((e) => !e.startsWith('.'));
  } catch {
    return [];
  }
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
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS + jitter));
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

export async function loadConfig(teamName: string): Promise<NativeTeamConfig | null> {
  try {
    const content = await readFile(configPath(teamName), 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[claude-native-teams] Failed to load config for "${teamName}": ${message}`);
    return null;
  }
}

async function saveConfig(teamName: string, config: NativeTeamConfig): Promise<void> {
  await writeFile(configPath(teamName), JSON.stringify(config, null, 2));
}

async function countLeadSessionRefs(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const teams = await listTeams();

  for (const team of teams) {
    const config = await loadConfig(team);
    const leadSessionId = config?.leadSessionId;
    if (!leadSessionId) continue;
    counts.set(leadSessionId, (counts.get(leadSessionId) ?? 0) + 1);
  }

  return counts;
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
  config.members = config.members.filter((m) => m.agentId !== agentId);

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
export async function unregisterNativeMember(teamName: string, agentName: string): Promise<void> {
  const config = await loadConfig(teamName);
  if (!config) return;

  const sanitized = sanitizeTeamName(teamName);
  const agentId = `${sanitizeTeamName(agentName)}@${sanitized}`;

  const member = config.members.find((m) => m.agentId === agentId);
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
 * Resolve a genie worker ID to the native team member name.
 *
 * Matching strategy:
 *   1. Exact match on member.name
 *   2. Match on agentId prefix (workerId@team)
 *   3. Strip team prefix from workerId and match (e.g., "bugfix-4-engineer" → "engineer")
 *
 * Returns the native member name if found, null otherwise.
 */
export async function resolveNativeMemberName(teamName: string, genieWorkerId: string): Promise<string | null> {
  const config = await loadConfig(teamName);
  if (!config || config.members.length === 0) return null;

  const sanitizedId = sanitizeTeamName(genieWorkerId);
  const sanitizedTeam = sanitizeTeamName(teamName);

  // 1. Exact match on name
  const exactMatch = config.members.find((m) => m.name === sanitizedId && m.isActive);
  if (exactMatch) return exactMatch.name;

  // 2. Match on agentId
  const agentIdMatch = config.members.find((m) => m.agentId === `${sanitizedId}@${sanitizedTeam}` && m.isActive);
  if (agentIdMatch) return agentIdMatch.name;

  // 3. Strip team prefix and match (e.g., "bugfix-4-engineer" → "engineer")
  const teamPrefix = `${sanitizedTeam}-`;
  if (sanitizedId.startsWith(teamPrefix)) {
    const stripped = sanitizedId.slice(teamPrefix.length);
    const prefixMatch = config.members.find((m) => m.name === stripped && m.isActive);
    if (prefixMatch) return prefixMatch.name;
  }

  // 4. Fallback: try inactive members (recently unregistered)
  const inactiveMatch = config.members.find((m) => m.name === sanitizedId);
  if (inactiveMatch) return inactiveMatch.name;

  return null;
}

/**
 * Assign the next unused color from the palette for a team.
 */
export async function assignColor(teamName: string): Promise<ClaudeTeamColor> {
  const config = await loadConfig(teamName);
  if (!config) return CLAUDE_TEAM_COLORS[0];

  const usedColors = new Set(config.members.map((m) => m.color));

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

// ============================================================================
// Inbox Scanning
// ============================================================================

/**
 * List all teams that have unread messages in their team-lead inbox.
 *
 * Scans `~/.claude/teams/` for teams where `inboxes/team-lead.json`
 * contains messages with `read: false`. Returns the team name, unread
 * count, and working directory (from config.json → members → team-lead → cwd).
 */
export async function listTeamsWithUnreadInbox(): Promise<
  Array<{ teamName: string; unreadCount: number; workingDir: string | null; firstUnreadText: string | null }>
> {
  const base = teamsBaseDir();
  let teamDirs: string[];
  try {
    teamDirs = await readdir(base);
  } catch {
    return []; // No teams directory
  }

  const results: Array<{
    teamName: string;
    unreadCount: number;
    workingDir: string | null;
    firstUnreadText: string | null;
  }> = [];

  for (const name of teamDirs) {
    // Read inbox messages
    const inboxFile = join(base, name, 'inboxes', 'team-lead.json');
    let messages: NativeInboxMessage[];
    try {
      const content = await readFile(inboxFile, 'utf-8');
      messages = JSON.parse(content);
    } catch {
      continue; // No inbox or invalid JSON
    }

    if (!Array.isArray(messages)) continue;

    const unread = messages.filter((m) => m.read === false);
    if (unread.length === 0) continue;

    // Get workingDir from config.json → members → team-lead → cwd
    let workingDir: string | null = null;
    try {
      const cfgContent = await readFile(join(base, name, 'config.json'), 'utf-8');
      const config: NativeTeamConfig = JSON.parse(cfgContent);
      const leadMember = config.members.find((m) => m.name === 'team-lead' || m.agentId.startsWith('team-lead@'));
      if (leadMember?.cwd) {
        workingDir = leadMember.cwd;
      }
    } catch {
      // Config missing or malformed — workingDir stays null
    }

    results.push({
      teamName: name,
      unreadCount: unread.length,
      workingDir,
      firstUnreadText: unread[0]?.text ?? null,
    });
  }

  return results;
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
async function discoverClaudeSessionId(cwd?: string): Promise<string | null> {
  // 1. Env var (when running as a teammate, CC sets this)
  const envSessionId = process.env.CLAUDE_CODE_SESSION_ID;
  if (envSessionId) return envSessionId;

  // 2. Find most recently written JSONL in the project directory
  const projectDir = join(claudeConfigDir(), 'projects', sanitizePath(cwd ?? process.cwd()));

  try {
    const entries = await readdir(projectDir);
    const jsonls = entries.filter((e) => e.endsWith('.jsonl'));

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

interface SessionMetadata {
  teamName?: string;
  agentName?: string;
}

async function readSessionMetadata(filePath: string): Promise<SessionMetadata> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(filePath, 'r');
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.toString('utf-8', 0, bytesRead);

    for (const line of head.split('\n').slice(0, 20)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as { teamName?: unknown; agentName?: unknown };
        const teamName = typeof entry.teamName === 'string' ? entry.teamName : undefined;
        const agentName = typeof entry.agentName === 'string' ? entry.agentName : undefined;
        if (teamName || agentName) return { teamName, agentName };
      } catch {
        // Ignore malformed lines and keep scanning the JSONL head.
      }
    }
  } catch {
    return {};
  } finally {
    await handle?.close().catch(() => {});
  }

  return {};
}

/**
 * Discover an eligible parent session ID for spawning native teammates.
 *
 * Outside Claude Code we want a root/leader session, not the most recent worker
 * session in the repo. Prefer:
 *   1. Current env session (when already inside Claude Code)
 *   2. Newest root session in the repo (no teamName/agentName)
 *   3. Newest team-lead session in the repo
 *   4. Newest session as a last resort
 */
export async function discoverClaudeParentSessionId(cwd?: string): Promise<string | null> {
  const envSessionId = process.env.CLAUDE_CODE_SESSION_ID;
  if (envSessionId) return envSessionId;

  const projectDir = join(claudeConfigDir(), 'projects', sanitizePath(cwd ?? process.cwd()));

  try {
    const entries = await readdir(projectDir);
    const jsonls = entries.filter((e) => e.endsWith('.jsonl'));
    if (jsonls.length === 0) return null;

    const ranked = await Promise.all(
      jsonls.map(async (name) => {
        const filePath = join(projectDir, name);
        const s = await stat(filePath);
        const metadata = await readSessionMetadata(filePath);
        return {
          name,
          mtime: s.mtimeMs,
          metadata,
        };
      }),
    );
    const leadRefs = await countLeadSessionRefs();

    ranked.sort((a, b) => {
      const aId = a.name.replace('.jsonl', '');
      const bId = b.name.replace('.jsonl', '');
      const aLeadRefs = leadRefs.get(aId) ?? 0;
      const bLeadRefs = leadRefs.get(bId) ?? 0;
      if (aLeadRefs !== bLeadRefs) return bLeadRefs - aLeadRefs;

      const aRootScore =
        !a.metadata.teamName && !a.metadata.agentName ? 2 : a.metadata.agentName === 'team-lead' ? 1 : 0;
      const bRootScore =
        !b.metadata.teamName && !b.metadata.agentName ? 2 : b.metadata.agentName === 'team-lead' ? 1 : 0;
      if (aRootScore !== bRootScore) return bRootScore - aRootScore;

      return b.mtime - a.mtime;
    });

    return ranked[0]?.name.replace('.jsonl', '') ?? null;
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
 *   1. Check GENIE_TEAM env var (set by genie session)
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
        'Are you running inside Claude Code with CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1?',
    );
  }

  // Create or load the native team, using the real CC session ID
  const config = await ensureNativeTeam(teamName, `Genie team: ${teamName}`, sessionId);

  // Update leadSessionId if the team already existed with a stale ID
  if (config.leadSessionId !== sessionId) {
    config.leadSessionId = sessionId;
    await saveConfig(teamName, config);
  }

  // Register the leader as a member (CC expects the lead in the members array)
  const sanitized = sanitizeTeamName(teamName);
  const leadAgentId = `team-lead@${sanitized}`;
  const existingLead = config.members.find((m) => m.agentId === leadAgentId);

  const resolvedPaneId = opts?.tmuxPaneId ?? process.env.TMUX_PANE;
  if (!existingLead || !existingLead.isActive) {
    await registerNativeMember(teamName, {
      agentName: 'team-lead',
      agentType: 'general-purpose',
      color: opts?.color ?? 'blue',
      tmuxPaneId: resolvedPaneId,
      cwd: opts?.cwd ?? process.cwd(),
    });
  } else if (resolvedPaneId && existingLead.tmuxPaneId !== resolvedPaneId) {
    // Update stale pane ID on existing active lead
    existingLead.tmuxPaneId = resolvedPaneId;
    await saveConfig(teamName, config);
  }

  // Ensure the team-lead inbox exists
  const inbox = inboxPath(teamName, 'team-lead');
  if (!existsSync(inbox)) {
    await writeFile(inbox, '[]');
  }

  // Return the final config
  const finalConfig = await loadConfig(teamName);
  if (!finalConfig) {
    throw new Error(`Failed to load config for team "${teamName}" after creation`);
  }
  return { sessionId, config: finalConfig };
}
