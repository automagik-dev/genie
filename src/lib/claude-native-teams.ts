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

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensureTeammateBypassPermissions } from './claude-settings.js';
import { acquireLock, releaseLock } from './lockfile.js';
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
export interface NativeTeamConfig {
  name: string;
  description?: string;
  createdAt: number;
  leadAgentId: string;
  leadSessionId: string;
  members: NativeTeamMember[];
  // Optional fields populated by `createTeam` but absent on minimal configs.
  repo?: string;
  baseBranch?: string;
  worktreePath?: string;
  status?: string;
  tmuxSessionName?: string;
  nativeTeamParentSessionId?: string;
  nativeTeamsEnabled?: boolean;
  wishSlug?: string;
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

/**
 * Public single-team loader — canonical name for the disk→PG rehydration path.
 * Alias of `loadConfig` with an explicit, self-documenting name. Used by
 * `team-manager.ts#ensureTeamRow` and `term-commands/doctor.ts#repairTeams`.
 *
 * Returns null when the team has no on-disk config.json (e.g. truly-new team)
 * — callers should fall back to their default construction logic in that case.
 */
export async function loadNativeTeamConfig(teamName: string): Promise<NativeTeamConfig | null> {
  return loadConfig(teamName);
}

/**
 * Load every on-disk native team config in one pass.
 *
 * Used by `pg-seed.ts#seedTeams` (boot rehydration) and
 * `term-commands/doctor.ts#repairTeams` (on-demand repair). Teams whose
 * config.json fails to load are silently skipped (same policy as
 * `loadConfig`) — this is a best-effort bulk read for observability and
 * rehydration; individual failures must not block the whole pass.
 *
 * Order is filesystem order (as returned by readdir) — callers that need a
 * stable order should sort.
 */
export async function loadAllNativeTeamConfigs(): Promise<NativeTeamConfig[]> {
  const teamNames = await listTeams();
  const configs: NativeTeamConfig[] = [];
  for (const name of teamNames) {
    const cfg = await loadConfig(name);
    if (cfg) configs.push(cfg);
  }
  return configs;
}

/**
 * Find all teams whose config.json lists the given agent name as a member.
 *
 * Used by the spawn path as a last-resort fallback to resolve `--team` when
 * neither an explicit flag nor `GENIE_TEAM` nor a parent session is available
 * (e.g. detached spawns from the TUI after a DB reset). Returns team names
 * sanitized exactly as they appear on disk.
 */
export async function findTeamsContainingAgent(agentName: string): Promise<string[]> {
  const teams = await listTeams();
  const matches: string[] = [];
  for (const teamName of teams) {
    const config = await loadConfig(teamName);
    if (!config) continue;
    const hit = config.members.some((m) => m.name === agentName || m.agentType === agentName);
    if (hit) matches.push(teamName);
  }
  return matches;
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
  leaderName?: string,
): Promise<NativeTeamConfig> {
  const dir = teamDir(teamName);
  const inboxDir = inboxesDir(teamName);

  await mkdir(dir, { recursive: true });
  await mkdir(inboxDir, { recursive: true });

  // Ensure the global teammateMode is bypassPermissions so the native team
  // permission gate doesn't route tool approvals to the leader (deadlock).
  ensureTeammateBypassPermissions();

  const existing = await loadConfig(teamName);
  if (existing) {
    // Back-fill the PG teams row if it's missing (e.g. after a pgserve reset
    // where the on-disk native team survived but the `teams` row did not).
    // Pass the already-loaded config so the backfill uses disk truth for repo,
    // worktree, leader, and members — not `process.cwd()` defaults (Bug C).
    // Best-effort — never block the native team code path on PG failures.
    await backfillTeamRow(sanitizeTeamName(teamName), existing);
    return existing;
  }

  const sanitized = sanitizeTeamName(teamName);
  const resolvedLeader = sanitizeTeamName(leaderName ?? teamName);
  const config: NativeTeamConfig = {
    name: sanitized,
    description,
    createdAt: Date.now(),
    leadAgentId: `${resolvedLeader}@${sanitized}`,
    leadSessionId,
    members: [],
  };

  await saveConfig(teamName, config);
  // Mirror the newly created native team into the PG `teams` registry so
  // `genie team ls` reflects reality. Pass the freshly-created config through
  // so the PG row is seeded with the same members/leader we just wrote to
  // disk. Idempotent and best-effort.
  await backfillTeamRow(sanitized, config);
  return config;
}

/**
 * Best-effort mirror of a native team into the PG `teams` registry.
 *
 * Loaded via dynamic import to avoid a circular dependency with
 * `./team-manager.ts` (which imports this module). Failures are swallowed:
 * the native team code path must not be blocked by PG issues.
 */
async function backfillTeamRow(name: string, nativeConfig?: NativeTeamConfig): Promise<void> {
  try {
    const { ensureTeamRow } = await import('./team-manager.js');
    await ensureTeamRow(name, { nativeConfig });
  } catch {
    // best-effort — PG unavailable, circular-import edge case, etc.
  }
}

/**
 * A "healthy" leadSessionId looks like a Claude Code session UUID.
 *
 * Anything else — including the legacy `"pending"` placeholder literal, an
 * empty string, or a synthetic fallback like `"genie-<team>"` — is treated
 * as stale and gets upserted on the next spawn.
 *
 * See `.genie/wishes/fix-ghost-approval-p0/WISH.md` for the full story.
 */
function isHealthyLeadSessionId(id: string | undefined): id is string {
  if (typeof id !== 'string' || id.length === 0) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/**
 * Create-or-heal the native team with a real Claude Code session UUID.
 *
 * This is the fix for the ghost-approval deadlock. Until now the team-spawn
 * paths hardcoded `leadSessionId: "pending"` (a literal placeholder that
 * nothing ever reconciled), which caused every teammate's permission request
 * to route to a ghost leader and hang forever.
 *
 * Behavior:
 *   - No existing config → create fresh with `sessionId`.
 *   - Existing config with a healthy UUID → leave alone, return as-is.
 *   - Existing config with a stale value (`"pending"`, `""`, `"genie-<team>"`,
 *     anything non-UUID) → **upsert in place** with the new `sessionId`.
 *
 * The in-place upsert is how machines that already have broken configs on
 * disk get healed on the next spawn — no migration script required.
 */
export async function ensureNativeTeamWithSessionId(
  teamName: string,
  description: string,
  sessionId: string,
  leaderName?: string,
): Promise<NativeTeamConfig> {
  const config = await ensureNativeTeam(teamName, description, sessionId, leaderName);
  if (config.leadSessionId === sessionId) return config;
  if (isHealthyLeadSessionId(config.leadSessionId)) return config;

  // Stale leadSessionId on disk — upsert in place.
  config.leadSessionId = sessionId;
  await saveConfig(teamName, config);
  return config;
}

/**
 * Resolve an existing Claude Code session ID for a given team name, or mint
 * a fresh UUID if no prior session is found.
 *
 * Strategy:
 *   1. Scan `~/.claude/projects/<sanitized-cwd>/*.jsonl` for a file whose
 *      `custom-title` entry matches the sanitized team name.
 *   2. If found → return the UUID from the most recently modified match
 *      with `shouldResume: true`. The caller should launch CC with
 *      `--resume <teamName>` and CC will load that JSONL by name.
 *   3. If not found → return `{ sessionId: crypto.randomUUID(), shouldResume: false }`.
 *      The caller should launch CC with `--session-id <sessionId>` so the new
 *      CC process boots into that exact UUID — keeping the team config and
 *      the CC process in perfect agreement from the first moment.
 *
 * Callers must pass the resulting `sessionId` to both `ensureNativeTeamWithSessionId`
 * and `buildTeamLeadCommand` so the team config and the launched CC process
 * reference the same session ID.
 */
export async function resolveOrMintLeadSessionId(
  teamName: string,
  cwd: string,
): Promise<{ sessionId: string; shouldResume: boolean }> {
  const priorId = await findNewestSessionIdForTeam(teamName, cwd);
  if (priorId) {
    return { sessionId: priorId, shouldResume: true };
  }
  return { sessionId: randomUUID(), shouldResume: false };
}

/**
 * Scan Claude Code's project directory for a JSONL whose `custom-title`
 * matches the sanitized team name. Returns the UUID from the filename of
 * the most recently modified match, or null if none found.
 *
 * Matches the same strategy used by `sessionExists()` in
 * `src/lib/team-lead-command.ts` — both the exact sanitized team name and
 * the CC-stored `{team}-{team}` prefixed form are considered matches.
 */
async function findNewestSessionIdForTeam(teamName: string, cwd: string): Promise<string | null> {
  const projectDir = join(claudeConfigDir(), 'projects', sanitizePath(cwd));
  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return null;
  }
  const jsonls = entries.filter((e) => e.endsWith('.jsonl'));
  if (jsonls.length === 0) return null;

  const needle = sanitizeTeamName(teamName);
  let best: { name: string; mtime: number } | null = null;
  for (const name of jsonls) {
    const full = join(projectDir, name);
    if (!(await jsonlMatchesTitle(full, needle))) continue;
    try {
      const s = await stat(full);
      if (!best || s.mtimeMs > best.mtime) {
        best = { name, mtime: s.mtimeMs };
      }
    } catch {
      /* skip unreadable */
    }
  }
  if (!best) return null;
  return best.name.replace('.jsonl', '');
}

/**
 * Best-effort scan of the first 8KB of a JSONL file for a `custom-title`
 * entry whose value matches the needle (case-insensitive, exact match).
 *
 * Historical note: we used to also accept `{team}-{team}` as a match for
 * legacy CC-prefixed sessions, but that let team "alpha" pick up JSONLs
 * written by team "alpha-alpha" under the same worktree. Gap B from
 * trace-stale-resume (task #6) — strict match only.
 *
 * Any I/O or parse failure returns false.
 */
async function jsonlMatchesTitle(filePath: string, needle: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(filePath, 'r');
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.toString('utf-8', 0, bytesRead);
    for (const line of head.split('\n').slice(0, 10)) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes('custom-title')) continue;
      try {
        const entry = JSON.parse(trimmed) as { type?: string; customTitle?: string };
        if (entry.type !== 'custom-title' || typeof entry.customTitle !== 'string') continue;
        if (entry.customTitle.toLowerCase() === needle) return true;
      } catch {
        /* malformed line — keep scanning */
      }
    }
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
  return false;
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
 *
 * Removes the member entry from the `members` array. The prior implementation
 * marked `isActive: false` "to preserve history", but no call site ever
 * consults inactive members for history — meanwhile two active readers
 * (`resolveNativeMemberName`'s active→inactive fallback and
 * `findTeamsContainingAgent`'s team-resolver tier 5) silently pick up stale
 * entries, routing messages and spawn-team resolution to the wrong worker.
 *
 * The per-member inbox at `~/.claude/teams/<team>/inboxes/<name>.json` is
 * cleared by `clearNativeInbox` (called alongside this function in the kill
 * path), so there's no residual state worth preserving.
 *
 * See automagik-dev/genie#1179.
 */
export async function unregisterNativeMember(teamName: string, agentName: string): Promise<void> {
  const config = await loadConfig(teamName);
  if (!config) return;

  const sanitized = sanitizeTeamName(teamName);
  const agentId = `${sanitizeTeamName(agentName)}@${sanitized}`;

  const before = config.members.length;
  config.members = config.members.filter((m) => m.agentId !== agentId);
  if (config.members.length === before) return; // no-op: no entry matched

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

/** Extract the leader inbox name from a native team config's leadAgentId. */
function extractLeaderInboxName(config: NativeTeamConfig | null, teamName?: string): string {
  if (!config?.leadAgentId) return teamName ?? 'unknown';
  const atIdx = config.leadAgentId.indexOf('@');
  return atIdx > 0 ? config.leadAgentId.slice(0, atIdx) : (teamName ?? 'unknown');
}

/**
 * Resolve the working directory for a team's lead, for inbox-watcher spawn.
 *
 * Fallback order, matching the PG teams mirror in team-manager.ts:
 *   1. leadMember.cwd            — the lead's own cwd when present in members[]
 *   2. config.worktreePath       — team-level worktree when lead isn't a distinct member
 *   3. config.repo               — repo root when no worktree provisioned
 *   4. any member.cwd            — real councils seen with both worktreePath/repo
 *                                  null but workers on the shared council worktree
 *   5. null                      — preserved so the inbox-watcher's rate-limited
 *                                  "no workingDir in config" warning still fires
 *                                  for configs that genuinely have no usable path
 */
function resolveLeadWorkingDir(config: NativeTeamConfig, leaderInboxName: string): string | null {
  const leadMember = config.members.find((m) => m.agentId === config.leadAgentId || m.name === leaderInboxName);
  if (leadMember?.cwd) return leadMember.cwd;
  if (config.worktreePath) return config.worktreePath;
  if (config.repo) return config.repo;
  return config.members.find((m) => m.cwd)?.cwd ?? null;
}

/** Scan a single team directory for unread leader inbox messages. */
async function scanTeamInbox(
  base: string,
  name: string,
): Promise<{
  teamName: string;
  unreadCount: number;
  workingDir: string | null;
  firstUnreadText: string | null;
} | null> {
  let config: NativeTeamConfig | null = null;
  try {
    const cfgContent = await readFile(join(base, name, 'config.json'), 'utf-8');
    config = JSON.parse(cfgContent);
  } catch {
    // Config missing or malformed
  }

  const leaderInboxName = extractLeaderInboxName(config, name);
  const inboxFile = join(base, name, 'inboxes', `${leaderInboxName}.json`);

  let messages: NativeInboxMessage[];
  try {
    const content = await readFile(inboxFile, 'utf-8');
    messages = JSON.parse(content);
  } catch {
    return null;
  }

  if (!Array.isArray(messages)) return null;
  const unread = messages.filter((m) => m.read === false);
  if (unread.length === 0) return null;

  const workingDir = config ? resolveLeadWorkingDir(config, leaderInboxName) : null;

  return { teamName: name, unreadCount: unread.length, workingDir, firstUnreadText: unread[0]?.text ?? null };
}

/**
 * List all teams that have unread messages in their leader's inbox.
 *
 * Scans `~/.claude/teams/` for teams where the leader's inbox
 * contains messages with `read: false`. Returns the team name, unread
 * count, and working directory (from config.json → members → leader → cwd).
 */
export async function listTeamsWithUnreadInbox(): Promise<
  Array<{ teamName: string; unreadCount: number; workingDir: string | null; firstUnreadText: string | null }>
> {
  const base = teamsBaseDir();
  let teamDirs: string[];
  try {
    teamDirs = await readdir(base);
  } catch {
    return [];
  }

  const results: Array<{
    teamName: string;
    unreadCount: number;
    workingDir: string | null;
    firstUnreadText: string | null;
  }> = [];

  for (const name of teamDirs) {
    const entry = await scanTeamInbox(base, name);
    if (entry) results.push(entry);
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
function rootScore(metadata: { teamName?: string; agentName?: string }): number {
  if (!metadata.teamName && !metadata.agentName) return 2;
  // Score leader sessions higher — matches sessions without an explicit agentName (leader sessions)
  if (metadata.teamName && !metadata.agentName) return 1;
  return 0;
}

function compareSessionRanking(
  a: { name: string; mtime: number; metadata: { teamName?: string; agentName?: string } },
  b: { name: string; mtime: number; metadata: { teamName?: string; agentName?: string } },
  leadRefs: Map<string, number>,
): number {
  const aLeadRefs = leadRefs.get(a.name.replace('.jsonl', '')) ?? 0;
  const bLeadRefs = leadRefs.get(b.name.replace('.jsonl', '')) ?? 0;
  if (aLeadRefs !== bLeadRefs) return bLeadRefs - aLeadRefs;

  const aRoot = rootScore(a.metadata);
  const bRoot = rootScore(b.metadata);
  if (aRoot !== bRoot) return bRoot - aRoot;

  return b.mtime - a.mtime;
}

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

    ranked.sort((a, b) => compareSessionRanking(a, b, leadRefs));

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

  const base = teamsBaseDir();

  // 2. Match session ID against team configs
  const sessionId = await discoverClaudeSessionId(cwd);
  if (sessionId) {
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
  }

  // 3. Fallback: if we're inside a tmux session whose name matches an
  // existing team config, trust that mapping. Handles the post-reboot /
  // post-claude-restart case where the stored leadSessionId is stale but
  // the tmux session (and thus team identity) is stable.
  const tmuxSessionName = await currentTmuxSessionName();
  if (tmuxSessionName) {
    const cfgPath = join(base, tmuxSessionName, 'config.json');
    try {
      const content = await readFile(cfgPath, 'utf-8');
      const config: NativeTeamConfig = JSON.parse(content);
      return config.name;
    } catch {
      // no matching team on disk
    }
  }

  return null;
}

/**
 * Read the current tmux session name via `tmux display-message -p '#S'`.
 * Returns null if not inside tmux, if the tmux binary is missing, or if
 * the command fails for any reason. Kept local to this module to avoid a
 * circular import with {@link ./tmux.ts} (which imports this module).
 */
async function currentTmuxSessionName(): Promise<string | null> {
  if (!process.env.TMUX) return null;
  try {
    const { getCurrentSessionName } = await import('./tmux.js');
    return await getCurrentSessionName();
  } catch {
    return null;
  }
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
    leaderName?: string;
  },
): Promise<{ sessionId: string; config: NativeTeamConfig }> {
  const sessionId = await discoverClaudeSessionId(opts?.cwd);
  if (!sessionId) {
    throw new Error(
      'Could not discover Claude Code session ID. ' +
        'Are you running inside Claude Code with CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1?',
    );
  }

  const resolvedLeaderName = opts?.leaderName ?? teamName;

  // Create or load the native team, using the real CC session ID
  const config = await ensureNativeTeam(teamName, `Genie team: ${teamName}`, sessionId, resolvedLeaderName);

  // Update leadSessionId if the team already existed with a stale ID
  if (config.leadSessionId !== sessionId) {
    config.leadSessionId = sessionId;
    await saveConfig(teamName, config);
  }

  // Register the leader as a member (CC expects the lead in the members array)
  const sanitized = sanitizeTeamName(teamName);
  const sanitizedLeader = sanitizeTeamName(resolvedLeaderName);
  const leadAgentId = `${sanitizedLeader}@${sanitized}`;
  const existingLead = config.members.find((m) => m.agentId === leadAgentId);

  const resolvedPaneId = opts?.tmuxPaneId ?? process.env.TMUX_PANE;
  if (!existingLead || !existingLead.isActive) {
    await registerNativeMember(teamName, {
      agentName: resolvedLeaderName,
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

  // Ensure the leader's inbox exists
  const inbox = inboxPath(teamName, resolvedLeaderName);
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
