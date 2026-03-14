import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type GenieConfig,
  GenieConfigSchema,
  type ShortcutsConfig,
  type TerminalConfig,
} from '../types/genie-config.js';

const GENIE_DIR = join(homedir(), '.genie');
const GENIE_CONFIG_FILE = join(GENIE_DIR, 'config.json');

/**
 * Get the path to the genie config directory
 */
export function getGenieDir(): string {
  return GENIE_DIR;
}

/**
 * Get the path to the genie config file
 */
export function getGenieConfigPath(): string {
  return GENIE_CONFIG_FILE;
}

/**
 * Check if genie config exists
 */
export function genieConfigExists(): boolean {
  return existsSync(GENIE_CONFIG_FILE);
}

/**
 * Ensure the genie config directory exists
 */
function ensureGenieDir(): void {
  if (!existsSync(GENIE_DIR)) {
    mkdirSync(GENIE_DIR, { recursive: true });
  }
}

/**
 * Load genie config, returning defaults if not found
 */
export async function loadGenieConfig(): Promise<GenieConfig> {
  if (!existsSync(GENIE_CONFIG_FILE)) {
    return GenieConfigSchema.parse({});
  }

  try {
    const content = readFileSync(GENIE_CONFIG_FILE, 'utf-8');
    const data = JSON.parse(content);
    return GenieConfigSchema.parse(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Warning: Invalid genie config, using defaults: ${message}`);
    return GenieConfigSchema.parse({});
  }
}

/**
 * Save genie config to disk
 */
export async function saveGenieConfig(config: GenieConfig): Promise<void> {
  ensureGenieDir();

  try {
    const validated = GenieConfigSchema.parse(config);
    const content = JSON.stringify(validated, null, 2);
    writeFileSync(GENIE_CONFIG_FILE, content, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to save genie config: ${message}`);
  }
}

/**
 * Get the default genie config
 */
function getDefaultGenieConfig(): GenieConfig {
  return GenieConfigSchema.parse({});
}

/**
 * Load genie config synchronously, returning defaults if not found
 */
export function loadGenieConfigSync(): GenieConfig {
  if (!existsSync(GENIE_CONFIG_FILE)) {
    return GenieConfigSchema.parse({});
  }

  try {
    const content = readFileSync(GENIE_CONFIG_FILE, 'utf-8');
    const data = JSON.parse(content);
    return GenieConfigSchema.parse(data);
  } catch {
    return GenieConfigSchema.parse({});
  }
}

/**
 * Contract home directory to ~ in a path (for display)
 */
export function contractPath(path: string): string {
  const home = homedir();
  if (path.startsWith(`${home}/`)) {
    return `~${path.slice(home.length)}`;
  }
  if (path === home) {
    return '~';
  }
  return path;
}

// ============================================================================
// New helper functions for v2 config
// ============================================================================

/**
 * Get terminal configuration
 */
export function getTerminalConfig(): TerminalConfig {
  const config = loadGenieConfigSync();
  return config.terminal;
}

/**
 * Check if setup has been completed
 */
export function isSetupComplete(): boolean {
  if (!genieConfigExists()) return false;
  const config = loadGenieConfigSync();
  return config.setupComplete ?? false;
}

/**
 * Mark setup as complete
 */
export async function markSetupComplete(): Promise<void> {
  const config = await loadGenieConfig();
  config.setupComplete = true;
  config.lastSetupAt = new Date().toISOString();
  await saveGenieConfig(config);
}

/**
 * Reset config to defaults
 */
export async function resetConfig(): Promise<void> {
  const defaultConfig = getDefaultGenieConfig();
  await saveGenieConfig(defaultConfig);
}

/**
 * Update shortcuts configuration
 */
export async function updateShortcutsConfig(partial: Partial<ShortcutsConfig>): Promise<void> {
  const config = await loadGenieConfig();
  config.shortcuts = { ...config.shortcuts, ...partial };
  await saveGenieConfig(config);
}

// ============================================================================
// Worker Profile helpers
// ============================================================================

// ============================================================================
// Council preset helpers
// ============================================================================
