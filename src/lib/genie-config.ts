import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type GenieConfig, GenieConfigSchema } from '../types/genie-config.js';
import { genieHome } from './workspace.js';

/**
 * Get the path to the genie config directory.
 * Honors GENIE_HOME (which relocates ALL global state) and resolves lazily so
 * env overrides in tests and spawned subprocesses take effect.
 */
export function getGenieDir(): string {
  return genieHome();
}

/**
 * Get the path to the genie config file
 */
export function getGenieConfigPath(): string {
  return join(genieHome(), 'config.json');
}

/**
 * Check if genie config exists
 */
export function genieConfigExists(): boolean {
  return existsSync(getGenieConfigPath());
}

/**
 * Ensure the genie config directory exists
 */
function ensureGenieDir(): void {
  const dir = getGenieDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Load genie config, returning defaults if not found
 */
export async function loadGenieConfig(): Promise<GenieConfig> {
  const configPath = getGenieConfigPath();
  if (!existsSync(configPath)) {
    return GenieConfigSchema.parse({});
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const data = JSON.parse(content) as Record<string, unknown>;
    // Configs written before runtime selection launched Claude implicitly.
    if (data.runtime === undefined) data.runtime = { defaultAgent: 'claude' };
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
    writeFileSync(getGenieConfigPath(), content, 'utf-8');
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

// ============================================================================
// Worker Profile helpers
// ============================================================================

// ============================================================================
// Council preset helpers
// ============================================================================
