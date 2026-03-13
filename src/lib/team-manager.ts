/**
 * Team Manager — CRUD for team lifecycle with git worktree integration.
 *
 * Teams are stored as JSON files in `.genie/teams/<safe-name>.json`.
 * Each team owns a git worktree at `<worktreeBase>/<team-name>`.
 * Team name IS the branch name (conventional prefixes: feat/, fix/, chore/, etc.).
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import path, { join } from 'node:path';
import { $ } from 'bun';
import { BUILTIN_COUNCIL_MEMBERS } from './builtin-agents.js';
import * as nativeTeamsManager from './claude-native-teams.js';
import { loadGenieConfigSync } from './genie-config.js';

// ============================================================================
// Types
// ============================================================================

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
  /** ISO timestamp of creation. */
  createdAt: string;
  /** Parent session UUID for Claude Code native team IPC. */
  nativeTeamParentSessionId?: string;
  /** Whether this team uses Claude Code native teams. */
  nativeTeamsEnabled?: boolean;
}

// ============================================================================
// Paths
// ============================================================================

function teamsDir(repoPath: string): string {
  return join(repoPath, '.genie', 'teams');
}

/** Sanitize team name for use as a filename (slashes become dashes). */
function safeFileName(name: string): string {
  return name.replace(/\//g, '--');
}

function teamFilePath(repoPath: string, name: string): string {
  const safeName = safeFileName(path.basename(name) === name ? name : name);
  return join(teamsDir(repoPath), `${safeName}.json`);
}

/** Resolve the worktree base directory from config. */
function getWorktreeBase(repoPath: string): string {
  const config = loadGenieConfigSync();
  const base = config.terminal?.worktreeBase ?? '.worktrees';
  // If relative, resolve against repo path
  if (path.isAbsolute(base)) return base;
  return join(repoPath, base);
}

// ============================================================================
// API
// ============================================================================

/** Ensure a git worktree exists for the given branch. */
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

  // Skip if worktree already exists on disk
  if (existsSync(worktreePath)) return;

  // Check if branch already exists
  let branchExists = false;
  try {
    await $`git -C ${repoPath} rev-parse --verify ${branchName}`.quiet();
    branchExists = true;
  } catch {
    // Branch doesn't exist yet
  }

  if (branchExists) {
    await $`git -C ${repoPath} worktree add ${worktreePath} ${branchName}`.quiet();
    return;
  }

  // Create new branch from baseBranch — try origin first, then local, then HEAD
  try {
    await $`git -C ${repoPath} worktree add -b ${branchName} ${worktreePath} origin/${baseBranch}`.quiet();
  } catch {
    try {
      await $`git -C ${repoPath} worktree add -b ${branchName} ${worktreePath} ${baseBranch}`.quiet();
    } catch {
      await $`git -C ${repoPath} worktree add -b ${branchName} ${worktreePath}`.quiet();
    }
  }
}

/**
 * Create a new team with a git worktree.
 *
 * Idempotent — if the team already exists, returns existing config.
 * Steps: git pull on baseBranch → git worktree add → persist config.
 */
export async function createTeam(name: string, repo: string, baseBranch = 'dev'): Promise<TeamConfig> {
  const repoPath = path.resolve(repo);
  const dir = teamsDir(repoPath);
  await mkdir(dir, { recursive: true });

  // Idempotent: return existing team if it already exists
  const filePath = teamFilePath(repoPath, name);
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
export async function hireAgent(teamName: string, agentName: string, repoPath: string): Promise<string[]> {
  const config = await getTeam(repoPath, teamName);
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

  const filePath = teamFilePath(repoPath, teamName);
  await writeFile(filePath, JSON.stringify(config, null, 2));
  return added;
}

/**
 * Remove an agent from a team's members list.
 * Returns true if the agent was removed, false if not found.
 */
export async function fireAgent(teamName: string, agentName: string, repoPath: string): Promise<boolean> {
  const config = await getTeam(repoPath, teamName);
  if (!config) {
    throw new Error(`Team "${teamName}" not found.`);
  }

  const idx = config.members.indexOf(agentName);
  if (idx === -1) return false;

  config.members.splice(idx, 1);
  const filePath = teamFilePath(repoPath, teamName);
  await writeFile(filePath, JSON.stringify(config, null, 2));

  return true;
}

/**
 * Disband a team: remove git worktree and delete team config.
 * Returns true if the team was found and disbanded.
 */
export async function disbandTeam(repoPath: string, teamName: string): Promise<boolean> {
  const config = await getTeam(repoPath, teamName);
  if (!config) return false;

  // Clean up native teams if enabled
  if (config.nativeTeamsEnabled) {
    try {
      await nativeTeamsManager.deleteNativeTeam(teamName);
    } catch {
      // Best-effort
    }
  }

  // Remove git worktree
  if (config.worktreePath && existsSync(config.worktreePath)) {
    try {
      await $`git -C ${repoPath} worktree remove ${config.worktreePath} --force`.quiet();
    } catch {
      // Force-remove directory if git worktree remove fails
      try {
        await rm(config.worktreePath, { recursive: true, force: true });
        await $`git -C ${repoPath} worktree prune`.quiet();
      } catch {
        // Best-effort
      }
    }
  }

  // Delete team config file
  const filePath = teamFilePath(repoPath, teamName);
  try {
    await unlink(filePath);
  } catch {
    return false;
  }

  return true;
}

/** Get a team by name. Returns null if not found. */
export async function getTeam(repoPath: string, name: string): Promise<TeamConfig | null> {
  try {
    const content = await readFile(teamFilePath(repoPath, name), 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/** List all teams in a repo. */
export async function listTeams(repoPath: string): Promise<TeamConfig[]> {
  const dir = teamsDir(repoPath);
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
export async function listMembers(repoPath: string, teamName: string): Promise<string[] | null> {
  const config = await getTeam(repoPath, teamName);
  if (!config) return null;
  return config.members;
}
