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
import { mkdir, rm, symlink } from 'node:fs/promises';
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
export type TeamStatus = 'in_progress' | 'done' | 'blocked' | 'archived';

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
  /** Agent name (or 'cli') that created this team — workers report completion here. */
  spawner?: string;
  /** ISO timestamp when the team was archived (null if not archived). */
  archivedAt?: string;
  /**
   * Optional parent team for cross-team reachback.
   * When set, senders inside this team can message members of the parent
   * team (subject to the parent's `allowChildReachback` ALLOWLIST).
   * Max depth 3 to prevent cycles.
   */
  parentTeam?: string;
  /**
   * ALLOWLIST of child-team-name prefixes that are allowed to reach back
   * into this team via the `parentTeam` chain. For example, `["council-"]`
   * lets `council-<timestamp>` ephemeral teams message this team's members.
   * Default behavior: reachback is OFF for unknown prefixes and ON for
   * `council-*` (the canonical ephemeral sub-team use case).
   */
  allowChildReachback?: string[];
}

// ============================================================================
// PG Row Mapping
// ============================================================================

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
  spawner?: string;
  archived_at?: Date | string | null;
  parent_team?: string | null;
  allow_child_reachback?: unknown;
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
  if (row.spawner) config.spawner = row.spawner;
  if (row.archived_at) {
    config.archivedAt = row.archived_at instanceof Date ? row.archived_at.toISOString() : String(row.archived_at);
  }
  if (row.parent_team) config.parentTeam = row.parent_team;
  const allow = parseAllowChildReachback(row.allow_child_reachback);
  if (allow.length > 0) config.allowChildReachback = allow;
  return config;
}

/** Parse JSONB/text[] allow_child_reachback — handles parsed arrays, JSON strings, and nulls. */
function parseAllowChildReachback(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
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
        const { genieTmuxCmd } = require('./tmux-wrapper.js');
        execSync(genieTmuxCmd(`kill-pane -t ${w.paneId}`), { stdio: 'ignore' });
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

/** Post-clone init: symlink node_modules and run .genie/init.sh if present. */
async function postCloneInit(repoPath: string, worktreePath: string): Promise<void> {
  // Symlink node_modules from parent repo so builds work immediately
  const parentNodeModules = join(repoPath, 'node_modules');
  const worktreeNodeModules = join(worktreePath, 'node_modules');
  if (existsSync(parentNodeModules) && !existsSync(worktreeNodeModules)) {
    try {
      await symlink(parentNodeModules, worktreeNodeModules, 'dir');
    } catch {
      // Best-effort — may fail on filesystems that don't support symlinks
    }
  }

  // Run .genie/init.sh if it exists in the repo (post-clone hook convention)
  const initScript = join(repoPath, '.genie', 'init.sh');
  if (existsSync(initScript)) {
    try {
      await $`bash ${initScript}`.cwd(worktreePath).quiet();
    } catch {
      // Best-effort — init script failure shouldn't block team creation
    }
  }
}

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

  await postCloneInit(repoPath, worktreePath);
}

/**
 * Detect the spawner's parent team from the ambient environment.
 *
 * Returns the team name to record as `parentTeam` on a newly-created team,
 * or null when auto-promotion should not apply. Auto-promotion fires when
 * an identified agent (GENIE_AGENT_NAME set, not "cli") is creating a team
 * from inside another existing team (GENIE_TEAM resolvable in PG).
 */
async function detectSpawnerParentTeam(newTeamName: string): Promise<string | null> {
  const envTeam = process.env.GENIE_TEAM;
  const spawnerName = process.env.GENIE_AGENT_NAME;
  if (!envTeam || !spawnerName) return null;
  if (spawnerName === 'cli') return null;
  if (envTeam === newTeamName) return null;
  try {
    const parent = await getTeam(envTeam);
    return parent ? envTeam : null;
  } catch {
    return null;
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

  const promoted = await detectSpawnerParentTeam(name);
  if (promoted) config.parentTeam = promoted;

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
      native_teams_enabled, tmux_session_name, wish_slug, spawner, created_at,
      parent_team, allow_child_reachback
    ) VALUES (
      ${config.name}, ${config.repo}, ${config.baseBranch},
      ${config.worktreePath}, ${config.leader ?? null},
      ${JSON.stringify(config.members)}, ${config.status},
      ${config.nativeTeamParentSessionId ?? null},
      ${config.nativeTeamsEnabled ?? false},
      ${config.tmuxSessionName ?? null}, ${config.wishSlug ?? null},
      ${config.spawner ?? null}, ${config.createdAt},
      ${config.parentTeam ?? null},
      ${config.allowChildReachback ? JSON.stringify(config.allowChildReachback) : null}
    ) ON CONFLICT (name) DO NOTHING
  `;

  recordAuditEvent('team', name, 'created', getActor(), { repo: repoPath, baseBranch }).catch(() => {});

  return config;
}

/**
 * Ensure a PG row exists for a team that was created via the native
 * `~/.claude/teams/<name>/config.json` path (e.g. the implicit team created
 * by {@link ./claude-native-teams#ensureNativeTeam} during a spawn flow).
 *
 * This is the back-fill that rescues the PG registry after a reboot where
 * the pgserve data dir was reset (or any scenario that leaves the native
 * team file in place but the `teams` row absent). Without it,
 * {@link listTeams} returns an empty list even though the team is fully
 * functional on disk.
 *
 * Intentionally lightweight:
 *   - Idempotent via `ON CONFLICT (name) DO NOTHING` — never overwrites an
 *     explicit `createTeam` row.
 *   - Does NOT create a git worktree; `worktreePath` defaults to `repo`.
 *     If the user later runs `genie team create <name>`, that command's
 *     own `getTeam` check returns this bootstrap row and skips worktree
 *     creation — callers who need a real worktree should run `createTeam`
 *     explicitly BEFORE spawning.
 *   - Best-effort: SQL errors are caught and returned as null so a bad
 *     PG session never blocks the native-team code path.
 *
 * @param name         Team name (must pass `validateBranchName`).
 * @param opts.repo    Absolute path to the repo. Defaults to `process.cwd()`.
 * @returns The resulting TeamConfig, or null if the insert failed.
 */
function buildConfigFromNative(
  name: string,
  nativeConfig: nativeTeamsManager.NativeTeamConfig,
  optsRepo: string | undefined,
): TeamConfig {
  const leader = deriveBareLeaderName(nativeConfig.leadAgentId);
  const memberNames = (nativeConfig.members ?? [])
    .map((m) => m.name)
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
  const repoPath = path.resolve(nativeConfig.repo ?? optsRepo ?? process.cwd());
  return {
    name,
    repo: repoPath,
    baseBranch: nativeConfig.baseBranch ?? 'dev',
    worktreePath: nativeConfig.worktreePath ?? repoPath,
    leader: leader ?? undefined,
    members: memberNames,
    status: (nativeConfig.status as TeamStatus | undefined) ?? 'in_progress',
    createdAt: new Date(nativeConfig.createdAt ?? Date.now()).toISOString(),
    nativeTeamsEnabled: nativeConfig.nativeTeamsEnabled ?? true,
    tmuxSessionName: nativeConfig.tmuxSessionName,
    nativeTeamParentSessionId: nativeConfig.nativeTeamParentSessionId,
    wishSlug: nativeConfig.wishSlug,
  };
}

function buildFallbackConfig(name: string, optsRepo: string | undefined): TeamConfig {
  return {
    name,
    repo: path.resolve(optsRepo ?? process.cwd()),
    baseBranch: 'dev',
    worktreePath: path.resolve(optsRepo ?? process.cwd()),
    members: [],
    status: 'in_progress',
    createdAt: new Date().toISOString(),
    nativeTeamsEnabled: true,
  };
}

async function insertTeamRow(config: TeamConfig, source: 'native-config' | 'cwd-fallback'): Promise<TeamConfig | null> {
  try {
    const sql = await getConnection();
    await sql`
      INSERT INTO teams (
        name, repo, base_branch, worktree_path, leader,
        members, status, native_teams_enabled, created_at,
        tmux_session_name, native_team_parent_session_id, wish_slug
      ) VALUES (
        ${config.name}, ${config.repo}, ${config.baseBranch},
        ${config.worktreePath}, ${config.leader ?? null},
        ${sql.json(config.members)}, ${config.status},
        ${config.nativeTeamsEnabled ?? false}, ${config.createdAt},
        ${config.tmuxSessionName ?? null},
        ${config.nativeTeamParentSessionId ?? null},
        ${config.wishSlug ?? null}
      ) ON CONFLICT (name) DO NOTHING
    `;
    recordAuditEvent('team', config.name, 'backfilled', getActor(), {
      repo: config.repo,
      source,
      member_count: config.members.length,
    }).catch(() => {});
    return (await getTeam(config.name)) ?? config;
  } catch {
    return null;
  }
}

export async function ensureTeamRow(
  name: string,
  opts?: { repo?: string; nativeConfig?: nativeTeamsManager.NativeTeamConfig },
): Promise<TeamConfig | null> {
  try {
    validateBranchName(name);
  } catch {
    return null;
  }

  const existing = await getTeam(name);
  if (existing) return existing;

  // Prefer the native Claude-native config as the source of truth — either
  // passed in by the caller (e.g. `backfillTeamRow` after `loadConfig`) or
  // loaded from disk here. Fall back to `process.cwd()` only when no disk
  // config exists (truly-new team). See Bug B in
  // `.genie/wishes/fix-pg-disk-rehydration/WISH.md`.
  const nativeConfig = opts?.nativeConfig ?? (await nativeTeamsManager.loadNativeTeamConfig(name));
  const config = nativeConfig
    ? buildConfigFromNative(name, nativeConfig, opts?.repo)
    : buildFallbackConfig(name, opts?.repo);
  return insertTeamRow(config, nativeConfig ? 'native-config' : 'cwd-fallback');
}

/** Strip `@<team>` suffix from a Claude-native `leadAgentId` → bare leader name. */
function deriveBareLeaderName(leadAgentId: string | undefined): string | null {
  if (!leadAgentId) return null;
  const at = leadAgentId.indexOf('@');
  return at === -1 ? leadAgentId : leadAgentId.slice(0, at);
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
  // `sql.json()` — postgres.js encodes the JS array once into a proper jsonb
  // array. Previously this used `JSON.stringify(config.members)` which
  // produced jsonb-string (Bug D). See migration 045.
  await sql`
    UPDATE teams SET members = ${sql.json(config.members)}
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
  // See Bug D note in `hireAgent` — use `sql.json()` for proper jsonb encoding.
  await sql`
    UPDATE teams SET members = ${sql.json(config.members)}
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

async function removeWorktree(worktreePath: string | undefined): Promise<void> {
  if (!worktreePath || !existsSync(worktreePath)) return;
  try {
    // Use git worktree remove for proper cleanup of object store references
    await $`git worktree remove --force ${worktreePath}`.quiet();
  } catch {
    // Fallback to rm for non-worktree clones (e.g., --shared clones)
    try {
      await rm(worktreePath, { recursive: true, force: true });
    } catch {
      // Best-effort
    }
  }
}

/** Clean up tmux session/window for a disbanded team. */
async function cleanupTeamTmuxSession(tmuxSessionName: string, teamName: string): Promise<void> {
  if (!tmuxSessionName) return;
  try {
    const session = await tmux.findSessionByName(tmuxSessionName);
    if (!session) return;

    const windows = await tmux.listWindows(tmuxSessionName);
    const teamWindow = await tmux.findWindowByName(tmuxSessionName, teamName);
    const dedicatedSession = tmuxSessionName === teamName || (windows.length === 1 && windows[0]?.name === teamName);

    if (dedicatedSession) {
      await tmux.killSession(tmuxSessionName);
    } else if (teamWindow) {
      await tmux.executeTmux(`kill-window -t '${teamWindow.id}'`);
    }
  } catch {
    // Best-effort
  }
}

/**
 * Archive a team: set status='archived', kill members, clean up tmux.
 * Preserves all data (members, wish_slug, metadata).
 */
export async function archiveTeam(teamName: string): Promise<boolean> {
  const config = await getTeam(teamName);
  if (!config) return false;

  // Kill all running team members in parallel — must complete BEFORE DB update
  // to prevent zombie workers writing to an archived team
  const killResults = await Promise.allSettled(config.members.map((member) => killWorkersByName(member, teamName)));
  for (let i = 0; i < killResults.length; i++) {
    if (killResults[i].status === 'rejected') {
      console.error(
        `   Failed to kill member "${config.members[i]}": ${(killResults[i] as PromiseRejectedResult).reason}`,
      );
    }
  }

  await cleanupTeamTmuxSession(config.tmuxSessionName ?? teamName, teamName);

  const sql = await getConnection();
  let archivedAgents = 0;
  let updated = false;
  await sql.begin(async (tx: typeof sql) => {
    const result = await tx`
      UPDATE teams SET status = 'archived', archived_at = now(), updated_at = now()
      WHERE name = ${teamName}
    `;
    if (result.count === 0) return;
    updated = true;

    // Archive agent rows owned by this team so listAgents (and all the
    // dashboards that read it) stop serving orphans. State is preserved for
    // audit; downstream callers pass includeArchived=true when they need
    // history.
    const agentResult = await tx`
      UPDATE agents SET state = 'archived', updated_at = now()
      WHERE team = ${teamName} AND state IS DISTINCT FROM 'archived'
    `;
    archivedAgents = agentResult.count ?? 0;
  });
  if (!updated) return false;

  recordAuditEvent('team', teamName, 'archived', getActor(), { repo: config.repo, archivedAgents }).catch(() => {});
  return true;
}

/**
 * Unarchive a team: restore status to 'done' or 'in_progress'.
 */
export async function unarchiveTeam(teamName: string): Promise<boolean> {
  const config = await getTeam(teamName);
  if (!config) return false;

  const restoredStatus = 'done';
  const sql = await getConnection();
  const result = await sql`
    UPDATE teams SET status = ${restoredStatus}, archived_at = NULL, updated_at = now()
    WHERE name = ${teamName}
  `;
  if (result.count === 0) return false;

  recordAuditEvent('team', teamName, 'unarchived', getActor(), { repo: config.repo, restoredStatus }).catch(() => {});
  return true;
}

/**
 * Disband a team: archives instead of deleting (data-preserving).
 * Kills members, cleans up native team config, resets wish groups, removes worktree.
 * Returns true if the team was found and disbanded.
 *
 * @deprecated Use `archiveTeam` directly. Disband now archives to preserve data.
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

  await removeWorktree(config.worktreePath);
  await cleanupTeamTmuxSession(config.tmuxSessionName ?? teamName, teamName);

  // Atomically reset wish groups + archive team in a single transaction
  // to prevent orphaned wish state if either operation fails
  const sql = await getConnection();
  let disbanded = false;
  await sql.begin(async (tx: typeof sql) => {
    // Reset wish groups inline within the transaction
    if (config.wishSlug) {
      try {
        const wishFile = `.genie/wishes/${config.wishSlug}/WISH.md`;
        const parent = await tx`
          SELECT id FROM tasks
          WHERE wish_file = ${wishFile} AND repo_path = ${config.repo} AND parent_id IS NULL
          LIMIT 1
        `;
        if (parent.length > 0) {
          const parentId = parent[0].id as string;
          const inProgress = await tx`
            SELECT id FROM tasks WHERE parent_id = ${parentId} AND status = 'in_progress'
          `;
          if (inProgress.length > 0) {
            const ids = inProgress.map((r: Record<string, unknown>) => r.id as string);
            await tx`UPDATE tasks SET status = 'ready', started_at = NULL, updated_at = now() WHERE id = ANY(${ids})`;
            await tx`DELETE FROM task_actors WHERE task_id = ANY(${ids}) AND role = 'assignee'`;
            console.log(`   Reset ${ids.length} in-progress group(s) for wish "${config.wishSlug}"`);
          }
        }
      } catch {
        // Best-effort within transaction — don't abort archive on wish state issues
      }
    }

    // Archive instead of delete — preserves all historical data
    const result = await tx`
      UPDATE teams SET status = 'archived', archived_at = now(), updated_at = now()
      WHERE name = ${teamName}
    `;
    disbanded = result.count > 0;

    // Archive agent rows owned by this team in the same transaction. Without
    // this, listAgents serves orphan rows forever (issue #1215). State is
    // preserved for audit — callers pass includeArchived=true for history.
    if (disbanded) {
      await tx`
        UPDATE agents SET state = 'archived', updated_at = now()
        WHERE team = ${teamName} AND state IS DISTINCT FROM 'archived'
      `;
    }
  });

  if (!disbanded) return false;

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
      wish_slug = ${config.wishSlug ?? null},
      spawner = ${config.spawner ?? null},
      parent_team = ${config.parentTeam ?? null},
      allow_child_reachback = ${config.allowChildReachback ? JSON.stringify(config.allowChildReachback) : null}
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

/** List all teams globally, optionally including archived. */
export async function listTeams(includeArchived = false): Promise<TeamConfig[]> {
  try {
    const sql = await getConnection();
    if (includeArchived) {
      const rows = await sql`SELECT * FROM teams ORDER BY created_at DESC`;
      return rows.map(rowToTeamConfig);
    }
    const rows = await sql`SELECT * FROM teams WHERE status != 'archived' ORDER BY created_at DESC`;
    return rows.map(rowToTeamConfig);
  } catch {
    return [];
  }
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

/**
 * Resolve the actual leader name for a team. Never returns 'team-lead'.
 * Resolution order: team config DB → teamName as fallback.
 * If DB is unreachable or team doesn't exist, returns teamName (never 'team-lead').
 */
export async function resolveLeaderName(teamName: string): Promise<string> {
  try {
    const config = await getTeam(teamName);
    if (config?.leader && config.leader !== 'team-lead') return config.leader;
  } catch {
    // DB unreachable — fall through to teamName
  }
  return teamName;
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
