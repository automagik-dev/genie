import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  GenieConfig,
  GenieConfigSchema,
  HooksConfig,
  LoggingConfig,
  PresetName,
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
export function ensureGenieDir(): void {
  if (!existsSync(GENIE_DIR)) {
    mkdirSync(GENIE_DIR, { recursive: true });
  }
}

/**
 * Load genie config, returning defaults if not found
 */
export async function loadGenieConfig(): Promise<GenieConfig> {
  if (!existsSync(GENIE_CONFIG_FILE)) {
    // Return default config
    return GenieConfigSchema.parse({});
  }

  try {
    const content = readFileSync(GENIE_CONFIG_FILE, 'utf-8');
    const data = JSON.parse(content);
    return GenieConfigSchema.parse(data);
  } catch (error: any) {
    // If config is invalid, return defaults
    console.warn(`Warning: Invalid genie config, using defaults: ${error.message}`);
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
  } catch (error: any) {
    throw new Error(`Failed to save genie config: ${error.message}`);
  }
}

/**
 * Get the default genie config
 */
export function getDefaultGenieConfig(): GenieConfig {
  return GenieConfigSchema.parse({});
}

/**
 * Check if a hook preset is enabled
 */
export function isPresetEnabled(config: GenieConfig, preset: PresetName): boolean {
  return config.hooks.enabled.includes(preset);
}

/**
 * Enable a hook preset
 */
export async function enablePreset(preset: PresetName): Promise<void> {
  const config = await loadGenieConfig();
  if (!config.hooks.enabled.includes(preset)) {
    config.hooks.enabled.push(preset);
    await saveGenieConfig(config);
  }
}

/**
 * Disable a hook preset
 */
export async function disablePreset(preset: PresetName): Promise<void> {
  const config = await loadGenieConfig();
  config.hooks.enabled = config.hooks.enabled.filter((p) => p !== preset);
  await saveGenieConfig(config);
}

/**
 * Get enabled presets
 */
export async function getEnabledPresets(): Promise<PresetName[]> {
  const config = await loadGenieConfig();
  return config.hooks.enabled;
}

/**
 * Set enabled presets (replaces all)
 */
export async function setEnabledPresets(presets: PresetName[]): Promise<void> {
  const config = await loadGenieConfig();
  config.hooks.enabled = presets;
  await saveGenieConfig(config);
}

/**
 * Update hooks configuration
 */
export async function updateHooksConfig(hooks: Partial<HooksConfig>): Promise<void> {
  const config = await loadGenieConfig();
  config.hooks = { ...config.hooks, ...hooks };
  await saveGenieConfig(config);
}

/**
 * Update logging configuration
 */
export async function updateLoggingConfig(logging: Partial<LoggingConfig>): Promise<void> {
  const config = await loadGenieConfig();
  config.logging = { ...config.logging, ...logging };
  await saveGenieConfig(config);
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
 * Check if tmux debug logging is enabled via environment or config
 */
export function isTmuxDebugEnabled(): boolean {
  if (process.env.GENIE_TMUX_DEBUG === '1') return true;
  if (!genieConfigExists()) return false;
  const config = loadGenieConfigSync();
  return config.logging?.tmuxDebug ?? false;
}

/**
 * Expand ~ to home directory in a path
 */
export function expandPath(path: string): string {
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  if (path === '~') {
    return homedir();
  }
  return path;
}

/**
 * Contract home directory to ~ in a path (for display)
 */
export function contractPath(path: string): string {
  const home = homedir();
  if (path.startsWith(home + '/')) {
    return '~' + path.slice(home.length);
  }
  if (path === home) {
    return '~';
  }
  return path;
}
