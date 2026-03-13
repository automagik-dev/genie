import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type CouncilPreset,
  type GenieConfig,
  GenieConfigSchema,
  type ShortcutsConfig,
  type TerminalConfig,
  type WorkerProfile,
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
function loadGenieConfigSync(): GenieConfig {
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
 * Get session name from config
 */
export function getSessionName(): string {
  const config = loadGenieConfigSync();
  return config.session.name;
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

/**
 * Get a worker profile by name
 * @param config - The genie config object
 * @param profileName - Name of the profile to get
 * @returns The WorkerProfile if found, undefined otherwise
 */
export function getWorkerProfile(config: GenieConfig, profileName: string): WorkerProfile | undefined {
  return config.workerProfiles?.[profileName];
}

/**
 * Get the default worker profile
 * @param config - The genie config object
 * @returns The default WorkerProfile if configured, undefined otherwise
 */
export function getDefaultWorkerProfile(config: GenieConfig): WorkerProfile | undefined {
  if (!config.defaultWorkerProfile) {
    return undefined;
  }
  return getWorkerProfile(config, config.defaultWorkerProfile);
}

// ============================================================================
// Council preset helpers
// ============================================================================

/**
 * Get a council preset by name
 * @param config - The genie config object
 * @param presetName - The preset name to look up
 * @returns The CouncilPreset if found, undefined otherwise
 */
export function getCouncilPreset(config: GenieConfig, presetName: string): CouncilPreset | undefined {
  return config.councilPresets?.[presetName];
}

/**
 * Get the default council preset
 * @param config - The genie config object
 * @returns The default CouncilPreset if configured, undefined otherwise
 */
export function getDefaultCouncilPreset(config: GenieConfig): CouncilPreset | undefined {
  if (!config.defaultCouncilPreset) {
    return undefined;
  }
  return getCouncilPreset(config, config.defaultCouncilPreset);
}

/**
 * Get the fallback council preset when none is configured
 * Uses existing worker profiles with sensible defaults
 */
export function getFallbackCouncilPreset(config: GenieConfig): CouncilPreset {
  // Use default worker profile for both if available, otherwise 'coding-fast'
  const defaultProfile = config.defaultWorkerProfile || 'coding-fast';
  return {
    left: defaultProfile,
    right: defaultProfile,
    skill: 'council',
  };
}
