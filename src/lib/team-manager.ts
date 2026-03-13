/**
 * Team Manager — CRUD for team lifecycle.
 *
 * Teams are stored as JSON files in `.genie/teams/<name>.json`.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path, { join } from 'node:path';
import * as nativeTeamsManager from './claude-native-teams.js';

// ============================================================================
// Types
// ============================================================================

/** Persisted team configuration. */
interface TeamConfig {
  /** Team name (unique identifier). */
  name: string;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp of last update. */
  updatedAt: string;
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

function teamFilePath(repoPath: string, name: string): string {
  const safeName = path.basename(name);
  return join(teamsDir(repoPath), `${safeName}.json`);
}

// ============================================================================
// API
// ============================================================================

/** Create a new team. Auto-enables native teams when inside CC. */
export async function createTeam(repoPath: string, name: string): Promise<TeamConfig> {
  const dir = teamsDir(repoPath);
  await mkdir(dir, { recursive: true });

  const filePath = teamFilePath(repoPath, name);
  if (existsSync(filePath)) {
    throw new Error(`Team "${name}" already exists. Delete it first or choose a different name.`);
  }

  const now = new Date().toISOString();
  const config: TeamConfig = {
    name,
    createdAt: now,
    updatedAt: now,
  };

  // Auto-enable native teams when running inside Claude Code
  if (nativeTeamsManager.isInsideClaudeCode()) {
    config.nativeTeamsEnabled = true;

    const result = await nativeTeamsManager.registerAsTeamLead(name);
    config.nativeTeamParentSessionId = result.sessionId;
  }

  await writeFile(filePath, JSON.stringify(config, null, 2));
  return config;
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

/** List all teams. */
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

/** Delete a team. Returns true if deleted, false if not found. */
export async function deleteTeam(repoPath: string, name: string): Promise<boolean> {
  const filePath = teamFilePath(repoPath, name);

  // Check if native teams were enabled and clean up
  const config = await getTeam(repoPath, name);
  if (config?.nativeTeamsEnabled) {
    try {
      await nativeTeamsManager.deleteNativeTeam(name);
    } catch {
      // Best-effort — native team cleanup failure shouldn't block local deletion
    }
  }

  try {
    await unlink(filePath);
    return true;
  } catch {
    return false;
  }
}
