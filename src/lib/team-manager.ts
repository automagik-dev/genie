/**
 * Team Manager — CRUD for team lifecycle and blueprint defaults.
 *
 * Teams are stored as JSON files in `.genie/teams/<name>.json`.
 * Blueprints provide role descriptors that inform spawn defaults
 * without forcing a team-level provider lock (DEC-2).
 */

import { mkdir, readFile, writeFile, readdir, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import type { ProviderName } from './provider-adapters.js';

// ============================================================================
// Types
// ============================================================================

/** Role descriptor within a team blueprint. */
export interface RoleDescriptor {
  /** Human-readable role name (e.g., "implementor", "tester"). */
  name: string;
  /** Suggested provider for this role (optional — not enforced). */
  suggestedProvider?: ProviderName;
  /** Suggested skill for codex workers in this role. */
  suggestedSkill?: string;
  /** Free-form description of what this role does. */
  description?: string;
}

/** Blueprint schema — provides default role descriptors for a team type. */
export interface Blueprint {
  name: string;
  roles: RoleDescriptor[];
}

/** Persisted team configuration. */
export interface TeamConfig {
  /** Team name (unique identifier). */
  name: string;
  /** Blueprint that was used to create the team (informational). */
  blueprint?: string;
  /** Role descriptors (may be customized from blueprint defaults). */
  roles: RoleDescriptor[];
  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp of last update. */
  updatedAt: string;
}

// ============================================================================
// Built-in Blueprints
// ============================================================================

const BLUEPRINTS: Record<string, Blueprint> = {
  work: {
    name: 'work',
    roles: [
      { name: 'implementor', description: 'Implements features and fixes bugs' },
      { name: 'tester', description: 'Writes and runs tests' },
      { name: 'reviewer', description: 'Reviews code and provides feedback' },
    ],
  },
  dream: {
    name: 'dream',
    roles: [
      { name: 'dreamer', description: 'Generates ideas and explores possibilities' },
      { name: 'critic', description: 'Evaluates and refines ideas' },
    ],
  },
  review: {
    name: 'review',
    roles: [
      { name: 'reviewer', description: 'Deep code review' },
      { name: 'security', description: 'Security-focused review' },
    ],
  },
  fix: {
    name: 'fix',
    roles: [
      { name: 'debugger', description: 'Diagnoses and fixes bugs' },
      { name: 'verifier', description: 'Verifies fixes and writes regression tests' },
    ],
  },
  debug: {
    name: 'debug',
    roles: [
      { name: 'investigator', description: 'Investigates root causes' },
      { name: 'reproducer', description: 'Creates minimal reproductions' },
    ],
  },
};

// ============================================================================
// Paths
// ============================================================================

function teamsDir(repoPath: string): string {
  return join(repoPath, '.genie', 'teams');
}

function teamFilePath(repoPath: string, name: string): string {
  return join(teamsDir(repoPath), `${name}.json`);
}

// ============================================================================
// API
// ============================================================================

/** Get a blueprint by name. Returns null if not found. */
export function getBlueprint(name: string): Blueprint | null {
  return BLUEPRINTS[name] ?? null;
}

/** List all available blueprint names. */
export function listBlueprints(): string[] {
  return Object.keys(BLUEPRINTS);
}

/** Create a new team from a blueprint. */
export async function createTeam(
  repoPath: string,
  name: string,
  blueprintName?: string,
): Promise<TeamConfig> {
  const dir = teamsDir(repoPath);
  await mkdir(dir, { recursive: true });

  const filePath = teamFilePath(repoPath, name);
  if (existsSync(filePath)) {
    throw new Error(`Team "${name}" already exists. Delete it first or choose a different name.`);
  }

  const blueprint = blueprintName ? getBlueprint(blueprintName) : null;
  if (blueprintName && !blueprint) {
    const available = listBlueprints().join(', ');
    throw new Error(`Blueprint "${blueprintName}" not found. Available: ${available}`);
  }

  const now = new Date().toISOString();
  const config: TeamConfig = {
    name,
    blueprint: blueprintName,
    roles: blueprint?.roles ?? [],
    createdAt: now,
    updatedAt: now,
  };

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
  try {
    await unlink(filePath);
    return true;
  } catch {
    return false;
  }
}
