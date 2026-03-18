/**
 * Team Manager — CRUD for team lifecycle with git clone --shared isolation.
 *
 * Teams are stored as JSON files in `~/.genie/teams/<safe-name>.json` (global).
 * Each team owns a shared clone at `<worktreeBase>/<team-name>`.
 * Team name IS the branch name (conventional prefixes: feat/, fix/, chore/, etc.).
 *
 * Uses `git clone --shared` instead of `git worktree` to avoid the worktree bug
 * where CC workers can flip `core.bare=true` on the parent repo via shared `.git`
 * metadata, silently corrupting it.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path, { join } from 'node:path';
import { $ } from 'bun';
import * as registry from './agent-registry.js';
import { BUILTIN_COUNCIL_MEMBERS } from './builtin-agents.js';
import * as nativeTeamsManager from './claude-native-teams.js';
import { acquireLock } from './file-lock.js';
import { loadGenieConfigSync } from './genie-config.js';

// ============================================================================
// Types
// ============================================================================

/** Team lifecycle status. */
export type TeamStatus = 'in_progress' | 'done' | 'blocked';

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
}

// ============================================================================
// Paths — global team storage at ~/.genie/teams/
// ============================================================================

function getGenieDir(): string {
  return process.env.GENIE_HOME ?? join(homedir(), '.genie');
}

function teamsDir(): string {
  return join(getGenieDir(), 'teams');
}

/** Sanitize team name for use as a filename (slashes become dashes). */
function safeFileName(name: string): string {
  return name.replace(/\//g, '--');
}

function teamFilePath(name: string): string {
  const safeName = safeFileName(path.basename(name) === name ? name : name);
  return join(teamsDir(), `${safeName}.json`);
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
}

/**
 * Create a new team with a shared clone.
 *
 * Idempotent — if the team already exists, returns existing config.
 * Steps: validate name → git pull on baseBranch → git clone --shared → persist config.
 */
export async function createTeam(name: string, repo: string, baseBranch = 'dev'): Promise<TeamConfig> {
  validateBranchName(name);

  const repoPath = path.resolve(repo);
  const dir = teamsDir();
  await mkdir(dir, { recursive: true });

  // Idempotent: return existing team if it already exists
  const filePath = teamFilePath(name);
  if (existsSync(filePath)) {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content);
  }

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

  await writeFile(filePath, JSON.stringify(config, null, 2));
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

  const filePath = teamFilePath(teamName);
  await writeFile(filePath, JSON.stringify(config, null, 2));
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
  const filePath = teamFilePath(teamName);
  await writeFile(filePath, JSON.stringify(config, null, 2));

  // Best-effort kill running agent
  try {
    await killWorkersByName(agentName);
  } catch {
    // Agent may not be running — ignore
  }

  return true;
}

/**
 * Disband a team: remove shared clone and delete team config.
 * Returns true if the team was found and disbanded.
 */
export async function disbandTeam(teamName: string): Promise<boolean> {
  const config = await getTeam(teamName);
  if (!config) return false;

  // Clean up native teams if enabled
  if (config.nativeTeamsEnabled) {
    try {
      await nativeTeamsManager.deleteNativeTeam(teamName);
    } catch {
      // Best-effort
    }
  }

  // Kill all running team members (scoped to this team only)
  for (const member of config.members) {
    try {
      await killWorkersByName(member, teamName);
    } catch {
      // Best-effort — continue with other members
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

  // Delete team config file
  const filePath = teamFilePath(teamName);
  try {
    await unlink(filePath);
  } catch {
    return false;
  }

  // Prune stale configs (remove team configs whose clone directories are gone)
  await pruneStaleWorktrees(config.repo);

  return true;
}

/**
 * Prune stale team configs.
 *
 * Scans all team configs — if a team's worktreePath (clone directory) no longer
 * exists on disk, deletes that team's config file.
 */
export async function pruneStaleWorktrees(_repoPath: string): Promise<void> {
  const dir = teamsDir();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return; // No teams dir — nothing to prune
  }

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const content = await readFile(join(dir, file), 'utf-8');
      const config: TeamConfig = JSON.parse(content);
      if (config.worktreePath && !existsSync(config.worktreePath)) {
        await unlink(join(dir, file));
      }
    } catch {
      // Skip corrupted files
    }
  }
}

/** Get a team by name. Returns null if not found. */
export async function getTeam(name: string): Promise<TeamConfig | null> {
  try {
    const content = await readFile(teamFilePath(name), 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/** List all teams globally. */
export async function listTeams(): Promise<TeamConfig[]> {
  const dir = teamsDir();
  try {
    const files = await readdir(dir);
    const teams: TeamConfig[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const content = await readFile(join(dir, file), 'utf-8');
        teams.push(JSON.parse(content));
      } catch {
        // skip corrupted files
      }
    }
    return teams;
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

/** Set team lifecycle status. */
export async function setTeamStatus(teamName: string, status: TeamStatus): Promise<void> {
  const filePath = teamFilePath(teamName);
  const release = await acquireLock(filePath);
  try {
    const config = await getTeam(teamName);
    if (!config) {
      throw new Error(`Team "${teamName}" not found.`);
    }
    config.status = status;
    await writeFile(filePath, JSON.stringify(config, null, 2));
  } finally {
    await release();
  }
}
