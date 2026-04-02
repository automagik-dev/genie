/**
 * Workspace Manager — Multi-workspace registry with filesystem sandboxing.
 *
 * Registry file: ~/.genie-app/workspaces.json
 * Per-workspace: <root>/.genie/workspace.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ============================================================================
// Types
// ============================================================================

export interface Workspace {
  path: string;
  name: string;
  pgUrl: string | null;
  created: string;
  lastOpened: string;
}

// ============================================================================
// Paths
// ============================================================================

const APP_HOME = join(homedir(), '.genie-app');
const REGISTRY_PATH = join(APP_HOME, 'workspaces.json');

function ensureAppHome(): void {
  if (!existsSync(APP_HOME)) {
    mkdirSync(APP_HOME, { recursive: true });
  }
}

// ============================================================================
// Registry I/O
// ============================================================================

function readRegistry(): Workspace[] {
  ensureAppHome();
  if (!existsSync(REGISTRY_PATH)) return [];
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8')) as Workspace[];
  } catch {
    return [];
  }
}

function writeRegistry(workspaces: Workspace[]): void {
  ensureAppHome();
  writeFileSync(REGISTRY_PATH, JSON.stringify(workspaces, null, 2));
}

// ============================================================================
// Public API
// ============================================================================

export async function listWorkspaces(): Promise<Workspace[]> {
  return readRegistry();
}

export async function initWorkspace(basePath: string, name?: string, pgUrl?: string): Promise<Workspace> {
  const resolvedName = name ?? basePath.split('/').pop() ?? 'workspace';
  const now = new Date().toISOString();

  // Create .genie/workspace.json at root
  const genieDir = join(basePath, '.genie');
  if (!existsSync(genieDir)) {
    mkdirSync(genieDir, { recursive: true });
  }

  const wsConfig = { name: resolvedName, pgUrl: pgUrl ?? null, created: now };
  writeFileSync(join(genieDir, 'workspace.json'), JSON.stringify(wsConfig, null, 2));

  // Add to global registry (or update if path already exists)
  const registry = readRegistry();
  const existing = registry.findIndex((w) => w.path === basePath);

  const entry: Workspace = {
    path: basePath,
    name: resolvedName,
    pgUrl: pgUrl ?? null,
    created: now,
    lastOpened: now,
  };

  if (existing >= 0) {
    registry[existing] = entry;
  } else {
    registry.push(entry);
  }

  writeRegistry(registry);
  return entry;
}

export async function openWorkspace(path: string): Promise<Workspace> {
  const registry = readRegistry();
  const idx = registry.findIndex((w) => w.path === path);

  if (idx < 0) {
    throw new Error(`Workspace not found in registry: ${path}`);
  }

  // Validate .genie/workspace.json exists
  const wsConfigPath = join(path, '.genie', 'workspace.json');
  if (!existsSync(wsConfigPath)) {
    throw new Error(`Workspace config missing at ${wsConfigPath}`);
  }

  registry[idx].lastOpened = new Date().toISOString();
  writeRegistry(registry);
  return registry[idx];
}

export async function removeWorkspace(path: string): Promise<boolean> {
  const registry = readRegistry();
  const filtered = registry.filter((w) => w.path !== path);
  if (filtered.length === registry.length) return false;
  writeRegistry(filtered);
  return true;
}
