/**
 * Team Manager — CRUD for team lifecycle with git clone --shared isolation.
 *
 * Teams are stored in PostgreSQL `teams` table (via embedded pgserve).
 * Each team owns a shared clone at `<worktreeBase>/<team-name>`.
 * Team name IS the branch name (conventional prefixes: feat/, fix/, chore/, etc.).
 *
 * Uses `git clone --shared` instead of `git worktree` to avoid the worktree bug
 * where CC workers can flip `core.bare=true` on the parent repo via shared `.git`
 * metadata, silently corrupting it.
 */

import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path, { join } from 'node:path';
import { $ } from 'bun';
import * as registry from './agent-registry.js';
import { getActor, recordAuditEvent } from './audit.js';
import { BUILTIN_COUNCIL_MEMBERS } from './builtin-agents.js';
import * as nativeTeamsManager from './claude-native-teams.js';
import { getConnection } from './db.js';
import * as executorRegistry from './executor-registry.js';
import { loadGenieConfigSync } from './genie-config.js';
import * as tmux from './tmux.js';

// ============================================================================
// Types
// ============================================================================

/** Team lifecycle status. */
export type TeamStatus = 'in_progress' | 'done' | 'blocked';

/** Event subscription preset — controls which events get routed to team members. */
export type EventSubscriptionPreset = 'actionable' | 'verbose' | 'silent';

/** Per-team event subscription configuration. */
export interface EventSubscriptionConfig {
  preset: EventSubscriptionPreset;
  overrides?: Record<string, boolean>;
}

/** Event types included in each preset. */
const EVENT_PRESETS: Record<EventSubscriptionPreset, string[]> = {
  actionable: [
    'task.comment',
    'task.blocked',
    'task.stage_change',
    'executor.error',
    'executor.permission',
    'request.created',
  ],
  verbose: [
    'task.comment',
    'task.blocked',
    'task.stage_change',
    'executor.error',
    'executor.permission',
    'request.created',
    'executor.state_change',
    'assignment.started',
    'assignment.completed',
    'task.assigned',
  ],
  silent: [],
};

/** Check if an event type should be routed for a given subscription config. */
export function shouldRouteEvent(config: EventSubscriptionConfig, eventType: string): boolean {
  // Overrides take priority
  if (config.overrides?.[eventType] !== undefined) {
    return config.overrides[eventType];
  }
  // Fall back to preset
  return EVENT_PRESETS[config.preset].includes(eventType);
}

/** Persisted team configuration. */
export interface TeamConfig {
  /** Team name — also the git branch name (e.g., "feat/auth-bug"). */
  name: string;
  /** Absolute path to the repository this team works in. */
  repo: string;
  /** Branch this team was created from (e.g., "dev"). */
  baseBranch: string;
  /** Absolute path to the git worktree directory. */
  worktreePath: string;
  /** Agent name of the team leader (if assigned). */
  leader?: string;
  /** Array of agent names that are members of this team. */
  members: string[];
  /** Team lifecycle status. */
  status: TeamStatus;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** Parent session UUID for Claude Code native team IPC. */
  nativeTeamParentSessionId?: string;
  /** Whether this team uses Claude Code native teams. */
  nativeTeamsEnabled?: boolean;
  /** Tmux session name used by this team — single source of truth for all workers. */
  tmuxSessionName?: string;
  /** Wish slug this team is working on (set via --wish). */
  wishSlug?: string;
  /** Event subscription config — controls which events get routed to team members. */
  eventSubscriptions?: EventSubscriptionConfig;
}

// ============================================================================
// PG Row Mapping
// ============================================================================

/** Parse JSONB event_subscriptions — handles parsed objects and string-encoded JSON. */
function parseEventSubscriptions(raw: unknown): EventSubscriptionConfig {
  const defaultConfig: EventSubscriptionConfig = { preset: 'actionable' };
  if (!raw) return defaultConfig;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed?.preset) return parsed as EventSubscriptionConfig;
      return defaultConfig;
    } catch {
      return defaultConfig;
    }
  }
  if (typeof raw === 'object' && (raw as Record<string, unknown>)?.preset) {
    return raw as EventSubscriptionConfig;
  }
  return defaultConfig;
}

/** Parse JSONB members — handles both parsed arrays and string-encoded JSON. */
function parseMembers(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

interface TeamConfigRow {
  name: string;
  repo: string;
  base_branch: string;
  worktree_path: string;
  members: unknown;
  status: TeamStatus;
  created_at: Date | string;
  leader?: string;
  native_team_parent_session_id?: string;
  native_teams_enabled?: boolean;
  tmux_session_name?: string;
  wish_slug?: string;
  event_subscriptions?: unknown;
}

/** Map a PG row to a TeamConfig object. */
function rowToTeamConfig(row: TeamConfigRow): TeamConfig {
  const config: TeamConfig = {
    name: row.name,
    repo: row.repo,
    baseBranch: row.base_branch,
    worktreePath: row.worktree_path,
    members: parseMembers(row.members),
    status: row.status,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
  if (row.leader) config.leader = row.leader;
  if (row.native_team_parent_session_id) config.nativeTeamParentSessionId = row.native_team_parent_session_id;
  if (row.native_teams_enabled) config.nativeTeamsEnabled = row.native_teams_enabled;
  if (row.tmux_session_name) config.tmuxSessionName = row.tmux_session_name;
  if (row.wish_slug) config.wishSlug = row.wish_slug;
  if (row.event_subscriptions) {
    config.eventSubscriptions = parseEventSubscriptions(row.event_subscriptions);
  }
  return config;
}

// ============================================================================
// Paths — worktree resolution (still needed for git operations)
// ============================================================================

function getGenieDir(): string {
  return process.env.GENIE_HOME ?? join(homedir(), '.genie');
}

/** Resolve the worktree base directory from config. */
function getWorktreeBase(repoPath: string): string {
  const config = loadGenieConfigSync();
  const base = config.terminal?.worktreeBase;
  // Explicit config: respect absolute or resolve relative against repo
  // Ignore '.worktrees' — legacy default from older versions that put worktrees inside the repo
  if (base && base !== '.worktrees') {
    if (path.isAbsolute(base)) return base;
    return join(repoPath, base);
  }
  // Default: ~/.genie/worktrees/<project-name>/
  const projectName = path.basename(repoPath);
  return join(getGenieDir(), 'worktrees', projectName);
}

// ============================================================================
// Branch Name Validation
// ============================================================================

/**
 * Validate that a team name is a valid git branch name.
 * Follows `git check-ref-format` rules for refs/heads/<name>.
 */
export function validateBranchName(name: string): void {
  const errors: string[] = [];

  if (/\s/.test(name)) errors.push('contains spaces');
  if (name.includes('..')) errors.push('contains ".."');
  if (name.includes('~')) errors.push('contains "~"');
  if (name.includes('^')) errors.push('contains "^"');
  if (name.includes(':')) errors.push('contains ":"');
  if (name.includes('?')) errors.push('contains "?"');
  if (name.includes('*')) errors.push('contains "*"');
  if (name.includes('[')) errors.push('contains "["');
  if (name.includes('\\')) errors.push('contains "\\"');
  // biome-ignore lint/suspicious/noControlCharactersInRegex: validating git ref format
  if (/[\x00-\x1f\x7f]/.test(name)) errors.push('contains control characters');
  if (name.endsWith('.lock')) errors.push('ends with ".lock"');
  if (name.endsWith('/')) errors.push('ends with "/"');
  if (name.endsWith('.')) errors.push('ends with "."');
  if (name.startsWith('-')) errors.push('starts with "-"');

  if (errors.length > 0) {
    throw new Error(`Invalid team name '${name}': must be a valid git branch name (${errors.join(', ')})`);
  }
}

// ============================================================================
// Agent Kill Helper
// ============================================================================

/** Best-effort kill all running workers matching a given agent name, scoped to a team. */
async function killWorkersByName(agentName: string, teamName?: string): Promise<void> {
  const workers = await registry.list();
  const matches = workers.filter(
    (w) => (w.role === agentName || w.id === agentName) && (!teamName || w.team === teamName),
  );
  for (const w of matches) {
    // Terminate executor first (if linked)
    if (w.currentExecutorId) {
      try {
        await executorRegistry.terminateExecutor(w.currentExecutorId);
        await registry.setCurrentExecutor(w.id, null);
      } catch {
        // Best-effort
      }
    }
    // Kill tmux pane via executor pane ID or legacy agent pane ID
    try {
      if (w.paneId && w.paneId !== 'inline') {
        const { execSync } = require('node:child_process');
        execSync(`tmux kill-pane -t ${w.paneId}`, { stdio: 'ignore' });
      }
    } catch {
      // Pane may already be gone
    }
    await registry.unregister(w.id);
  }
}

// ============================================================================
// API
// ============================================================================

/** Ensure a shared clone exists for the given branch. */
async function ensureWorktree(
  repoPath: string,
  branchName: string,
  worktreePath: string,
  baseBranch: string,
): Promise<void> {
  // Pull latest on base branch (best-effort)
  try {
    await $`git -C ${repoPath} fetch origin ${baseBranch}`.quiet();
  } catch {
    // Fetch may fail if remote doesn't exist or no network — continue
  }

  await mkdir(path.dirname(worktreePath), { recursive: true });

  // Skip if clone already exists on disk
  if (existsSync(worktreePath)) return;

  // Check if branch already exists
  let branchExists = false;
  try {
    await $`git -C ${repoPath} rev-parse --verify ${branchName}`.quiet();
    branchExists = true;
  } catch {
    // Branch doesn't exist yet — create it from baseBranch
    if (!branchExists) {
      try {
        await $`git -C ${repoPath} branch ${branchName} origin/${baseBranch}`.quiet();
      } catch {
        try {
          await $`git -C ${repoPath} branch ${branchName} ${baseBranch}`.quiet();
        } catch {
          await $`git -C ${repoPath} branch ${branchName}`.quiet();
        }
      }
    }
  }

  // Clone with --shared to reuse object store (fast, no disk duplication)
  // but with a separate .git config — avoids the core.bare corruption bug
  await $`git clone --shared --branch ${branchName} ${repoPath} ${worktreePath}`.quiet();

  // Inherit git user config from parent repo (shared clone has separate .git)
  try {
    const userName = (await $`git -C ${repoPath} config user.name`.quiet()).text().trim();
    const userEmail = (await $`git -C ${repoPath} config user.email`.quiet()).text().trim();
    if (userName) await $`git -C ${worktreePath} config user.name ${userName}`.quiet();
    if (userEmail) await $`git -C ${worktreePath} config user.email ${userEmail}`.quiet();
  } catch {
    // Best-effort — global config may suffice
  }
}

/**
 * Create a new team with a shared clone.
 *
 * Idempotent — if the team already exists, returns existing config.
 * Steps: validate name → git pull on baseBranch → git clone --shared → persist to PG.
 */
export async function createTeam(name: string, repo: string, baseBranch = 'dev'): Promise<TeamConfig> {
  validateBranchName(name);

  const repoPath = path.resolve(repo);

  // Idempotent: return existing team if it already exists in PG
  const existing = await getTeam(name);
  if (existing) return existing;

  const worktreeBase = getWorktreeBase(repoPath);
  const worktreePath = join(worktreeBase, name);

  await ensureWorktree(repoPath, name, worktreePath, baseBranch);

  const now = new Date().toISOString();
  const config: TeamConfig = {
    name,
    repo: repoPath,
    baseBranch,
    worktreePath,
    members: [],
    status: 'in_progress',
    createdAt: now,
  };

  // Auto-enable native teams when running inside Claude Code
  if (nativeTeamsManager.isInsideClaudeCode()) {
    config.nativeTeamsEnabled = true;
    try {
      const result = await nativeTeamsManager.registerAsTeamLead(name);
      config.nativeTeamParentSessionId = result.sessionId;
    } catch {
      // Best-effort — native team setup failure shouldn't block team creation
    }
  }

  const sql = await getConnection();
  await sql`
    INSERT INTO teams (
      name, repo, base_branch, worktree_path, leader,
      members, status, native_team_parent_session_id,
      native_teams_enabled, tmux_session_name, wish_slug, created_at
    ) VALUES (
      ${config.name}, ${config.repo}, ${config.baseBranch},
      ${config.worktreePath}, ${config.leader ?? null},
      ${JSON.stringify(config.members)}, ${config.status},
      ${config.nativeTeamParentSessionId ?? null},
      ${config.nativeTeamsEnabled ?? false},
      ${config.tmuxSessionName ?? null}, ${config.wishSlug ?? null},
      ${config.createdAt}
    ) ON CONFLICT (name) DO NOTHING
  `;

  recordAuditEvent('team', name, 'created', getActor(), { repo: repoPath, baseBranch }).catch(() => {});

  return config;
}

/**
 * Add an agent to a team's members list.
 *
 * Special case: if agentName is "council", hires all 10 built-in council members.
 */
export async function hireAgent(teamName: string, agentName: string): Promise<string[]> {
  const config = await getTeam(teamName);
  if (!config) {
    throw new Error(`Team "${teamName}" not found.`);
  }

  let added: string[];

  if (agentName === 'council') {
    // Hire all 10 council members
    const councilNames = BUILTIN_COUNCIL_MEMBERS.map((m) => m.name);
    added = councilNames.filter((n) => !config.members.includes(n));
    config.members.push(...added);
  } else {
    if (config.members.includes(agentName)) {
      return []; // Already a member
    }
    config.members.push(agentName);
    added = [agentName];
  }

  const sql = await getConnection();
  await sql`
    UPDATE teams SET members = ${JSON.stringify(config.members)}
    WHERE name = ${teamName}
  `;
  return added;
}

/**
 * Remove an agent from a team's members list.
 * Returns true if the agent was removed, false if not found.
 */
export async function fireAgent(teamName: string, agentName: string): Promise<boolean> {
  const config = await getTeam(teamName);
  if (!config) {
    throw new Error(`Team "${teamName}" not found.`);
  }

  const idx = config.members.indexOf(agentName);
  if (idx === -1) return false;

  config.members.splice(idx, 1);
  const sql = await getConnection();
  await sql`
    UPDATE teams SET members = ${JSON.stringify(config.members)}
    WHERE name = ${teamName}
  `;

  // Best-effort kill running agent
  try {
    await killWorkersByName(agentName);
  } catch {
    // Agent may not be running — ignore
  }

  return true;
}

/**
 * Disband a team: remove shared clone and delete team config from PG.
 * Returns true if the team was found and disbanded.
 */
export async function disbandTeam(teamName: string): Promise<boolean> {
  const config = await getTeam(teamName);
  if (!config) return false;

  // Clean up ~/.claude/teams/<name>/ (config.json, settings.json, inboxes)
  // Always attempt — hook injection writes settings.json regardless of nativeTeamsEnabled
  try {
    await nativeTeamsManager.deleteNativeTeam(teamName);
  } catch {
    // Best-effort
  }

  // Kill all running team members (scoped to this team only)
  for (const member of config.members) {
    try {
      await killWorkersByName(member, teamName);
    } catch {
      // Best-effort — continue with other members
    }
  }

  // Reset in-progress wish groups so re-dispatch works cleanly
  if (config.wishSlug) {
    try {
      const wishState = await import('./wish-state.js');
      const resetCount = await wishState.resetInProgressGroups(config.wishSlug, config.repo);
      if (resetCount > 0) {
        console.log(`   Reset ${resetCount} in-progress group(s) for wish "${config.wishSlug}"`);
      }
    } catch {
      // Best-effort — DB may be unavailable
    }
  }

  // Remove shared clone directory
  if (config.worktreePath && existsSync(config.worktreePath)) {
    try {
      await rm(config.worktreePath, { recursive: true, force: true });
    } catch {
      // Best-effort
    }
  }

  // Clean up tmux container for the team.
  // Dedicated team sessions (common in QA) should be fully killed.
  // Shared sessions should only lose the team's window.
  const tmuxSessionName = config.tmuxSessionName ?? teamName;
  if (tmuxSessionName) {
    try {
      const session = await tmux.findSessionByName(tmuxSessionName);
      if (session) {
        const windows = await tmux.listWindows(tmuxSessionName);
        const teamWindow = await tmux.findWindowByName(tmuxSessionName, teamName);
        const dedicatedSession =
          tmuxSessionName === teamName || (windows.length === 1 && windows[0]?.name === teamName);

        if (dedicatedSession) {
          await tmux.killSession(tmuxSessionName);
        } else if (teamWindow) {
          await tmux.executeTmux(`kill-window -t '${teamWindow.id}'`);
        }
      }
    } catch {
      // Best-effort
    }
  }

  // Delete team config from PG
  const sql = await getConnection();
  const result = await sql`DELETE FROM teams WHERE name = ${teamName}`;
  if (result.count === 0) return false;

  recordAuditEvent('team', teamName, 'disbanded', getActor(), { repo: config.repo }).catch(() => {});

  // Prune stale configs (remove team configs whose clone directories are gone)
  await pruneStaleWorktrees(config.repo);

  return true;
}

/**
 * Prune stale team configs.
 *
 * Scans all team configs in PG — if a team's worktreePath (clone directory) no longer
 * exists on disk, deletes that team's row and its ~/.claude/teams/ dir.
 */
async function pruneStaleWorktrees(_repoPath: string): Promise<void> {
  const sql = await getConnection();
  const rows = await sql`SELECT name, worktree_path FROM teams`;

  for (const row of rows) {
    if (row.worktree_path && !existsSync(row.worktree_path)) {
      // Clean up orphaned ~/.claude/teams/<name>/ (settings.json, hooks)
      try {
        await nativeTeamsManager.deleteNativeTeam(row.name);
      } catch {
        // Best-effort
      }
      await sql`DELETE FROM teams WHERE name = ${row.name}`;
    }
  }
}

/** Update team config in PG (full overwrite). */
export async function updateTeamConfig(name: string, config: TeamConfig): Promise<void> {
  const sql = await getConnection();
  await sql`
    UPDATE teams SET
      repo = ${config.repo},
      base_branch = ${config.baseBranch},
      worktree_path = ${config.worktreePath},
      leader = ${config.leader ?? null},
      members = ${JSON.stringify(config.members)},
      status = ${config.status},
      native_team_parent_session_id = ${config.nativeTeamParentSessionId ?? null},
      native_teams_enabled = ${config.nativeTeamsEnabled ?? false},
      tmux_session_name = ${config.tmuxSessionName ?? null},
      wish_slug = ${config.wishSlug ?? null}
    WHERE name = ${name}
  `;
}

/** Get a team by name. Returns null if not found. */
export async function getTeam(name: string): Promise<TeamConfig | null> {
  try {
    const sql = await getConnection();
    const rows = await sql`SELECT * FROM teams WHERE name = ${name}`;
    if (rows.length === 0) return null;
    return rowToTeamConfig(rows[0]);
  } catch {
    return null;
  }
}

/** List all teams globally. */
export async function listTeams(): Promise<TeamConfig[]> {
  try {
    const sql = await getConnection();
    const rows = await sql`SELECT * FROM teams ORDER BY created_at DESC`;
    return rows.map(rowToTeamConfig);
  } catch {
    return [];
  }
}

/** Get the event subscription config for a team. Falls back to 'actionable' preset. */
export async function getEventSubscriptions(teamName: string): Promise<EventSubscriptionConfig> {
  const team = await getTeam(teamName);
  return team?.eventSubscriptions ?? { preset: 'actionable' };
}

/** Update the event subscription config for a team. */
export async function updateEventSubscriptions(teamName: string, config: EventSubscriptionConfig): Promise<void> {
  const sql = await getConnection();
  await sql`
    UPDATE teams
    SET event_subscriptions = ${sql.json(config)},
        updated_at = now()
    WHERE name = ${teamName}
  `;
}

/** List members of a team. Returns null if team not found. */
export async function listMembers(teamName: string): Promise<string[] | null> {
  const config = await getTeam(teamName);
  if (!config) return null;
  return config.members;
}

/** Kill all running workers for a team's members. Scoped to the team — won't kill other teams' workers. */
export async function killTeamMembers(teamName: string): Promise<void> {
  const config = await getTeam(teamName);
  if (!config) return;

  for (const member of config.members) {
    try {
      await killWorkersByName(member, teamName);
    } catch {
      // Best-effort — continue with other members
    }
  }
}

/** Set team lifecycle status. */
export async function setTeamStatus(teamName: string, status: TeamStatus): Promise<void> {
  const sql = await getConnection();
  const result = await sql`
    UPDATE teams SET status = ${status}
    WHERE name = ${teamName}
  `;
  if (result.count === 0) {
    throw new Error(`Team "${teamName}" not found.`);
  }
}
