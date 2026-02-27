/**
 * Plugin Registry Helper
 *
 * Helper functions to read/write Claude Code's installed_plugins.json registry.
 * This allows term sync to mark plugins as devMode after syncing.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const PLUGINS_DIR = join(homedir(), '.claude', 'plugins');
const REGISTRY_PATH = join(PLUGINS_DIR, 'installed_plugins.json');

/**
 * A single plugin installation entry
 */
export interface PluginInstallEntry {
  scope: 'user' | 'project';
  projectPath?: string;
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
  gitCommitSha?: string;
  devMode?: boolean;
}

/**
 * The plugin registry structure (version 2)
 */
export interface PluginRegistry {
  version: number;
  plugins: {
    [pluginId: string]: PluginInstallEntry[];
  };
}

/**
 * Get the path to the plugin registry file
 */
export function getRegistryPath(): string {
  return REGISTRY_PATH;
}

/**
 * Load the plugin registry from disk
 * Returns a default empty registry if file doesn't exist
 */
export function loadPluginRegistry(): PluginRegistry {
  if (!existsSync(REGISTRY_PATH)) {
    return {
      version: 2,
      plugins: {},
    };
  }

  try {
    const content = readFileSync(REGISTRY_PATH, 'utf-8');
    const data = JSON.parse(content);
    return data as PluginRegistry;
  } catch (error: any) {
    console.warn(`Warning: Failed to parse plugin registry: ${error.message}`);
    return {
      version: 2,
      plugins: {},
    };
  }
}

/**
 * Save the plugin registry to disk
 */
export function savePluginRegistry(registry: PluginRegistry): void {
  // Ensure plugins directory exists
  mkdirSync(PLUGINS_DIR, { recursive: true });

  try {
    const content = JSON.stringify(registry, null, 2);
    writeFileSync(REGISTRY_PATH, content, 'utf-8');
  } catch (error: any) {
    throw new Error(`Failed to save plugin registry: ${error.message}`);
  }
}

/**
 * Get a plugin's installation entries by ID
 * Plugin ID format: "plugin-name@org" (e.g., "genie@namastexlabs")
 */
export function getPluginEntries(pluginId: string): PluginInstallEntry[] {
  const registry = loadPluginRegistry();
  return registry.plugins[pluginId] || [];
}

/**
 * Find a specific plugin entry by scope
 */
export function findPluginEntry(
  pluginId: string,
  scope: 'user' | 'project',
  projectPath?: string
): PluginInstallEntry | null {
  const entries = getPluginEntries(pluginId);

  for (const entry of entries) {
    if (entry.scope === scope) {
      if (scope === 'project') {
        if (entry.projectPath === projectPath) {
          return entry;
        }
      } else {
        return entry;
      }
    }
  }

  return null;
}

/**
 * Update or create a plugin entry in the registry
 *
 * If an entry with the same scope (and projectPath for project scope) exists,
 * it will be updated. Otherwise, a new entry will be created.
 */
export function upsertPluginEntry(
  pluginId: string,
  entry: PluginInstallEntry
): void {
  const registry = loadPluginRegistry();

  if (!registry.plugins[pluginId]) {
    registry.plugins[pluginId] = [];
  }

  const entries = registry.plugins[pluginId];
  let found = false;

  for (let i = 0; i < entries.length; i++) {
    const existing = entries[i];
    if (existing.scope === entry.scope) {
      if (entry.scope === 'project') {
        if (existing.projectPath === entry.projectPath) {
          entries[i] = entry;
          found = true;
          break;
        }
      } else {
        entries[i] = entry;
        found = true;
        break;
      }
    }
  }

  if (!found) {
    entries.push(entry);
  }

  savePluginRegistry(registry);
}

/**
 * Mark a plugin as dev mode
 *
 * Updates the installPath to the symlink location and sets devMode: true.
 * Preserves existing metadata like installedAt, version, etc.
 */
export function markPluginAsDevMode(
  pluginId: string,
  symlinkPath: string,
  version?: string
): boolean {
  const registry = loadPluginRegistry();

  if (!registry.plugins[pluginId]) {
    // Plugin not in registry, create a new entry
    const now = new Date().toISOString();
    registry.plugins[pluginId] = [
      {
        scope: 'user',
        installPath: symlinkPath,
        version: version || 'dev',
        installedAt: now,
        lastUpdated: now,
        devMode: true,
      },
    ];
    savePluginRegistry(registry);
    return true;
  }

  const entries = registry.plugins[pluginId];
  let updated = false;

  // Find and update user-scope entry
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].scope === 'user') {
      entries[i] = {
        ...entries[i],
        installPath: symlinkPath,
        lastUpdated: new Date().toISOString(),
        devMode: true,
        ...(version && { version }),
      };
      updated = true;
      break;
    }
  }

  if (!updated) {
    // No user entry exists, create one
    const now = new Date().toISOString();
    entries.push({
      scope: 'user',
      installPath: symlinkPath,
      version: version || 'dev',
      installedAt: now,
      lastUpdated: now,
      devMode: true,
    });
  }

  savePluginRegistry(registry);
  return true;
}

/**
 * Check if a plugin is marked as dev mode
 */
export function isPluginDevMode(pluginId: string): boolean {
  const entry = findPluginEntry(pluginId, 'user');
  return entry?.devMode === true;
}

/**
 * Remove dev mode flag from a plugin
 */
export function unmarkPluginDevMode(pluginId: string): boolean {
  const registry = loadPluginRegistry();

  if (!registry.plugins[pluginId]) {
    return false;
  }

  const entries = registry.plugins[pluginId];
  let updated = false;

  for (let i = 0; i < entries.length; i++) {
    if (entries[i].scope === 'user' && entries[i].devMode) {
      delete entries[i].devMode;
      updated = true;
      break;
    }
  }

  if (updated) {
    savePluginRegistry(registry);
  }

  return updated;
}
