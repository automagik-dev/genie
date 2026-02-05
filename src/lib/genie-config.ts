import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  GenieConfig,
  GenieConfigSchema,
  GenieConfigV1Schema,
  LoggingConfig,
  TerminalConfig,
  SessionConfig,
  ShortcutsConfig,
  WorkerProfile,
  CouncilPreset,
} from '../types/genie-config.js';

const GENIE_DIR = join(homedir(), '.genie');
const GENIE_CONFIG_FILE = join(GENIE_DIR, 'config.json');
const CONFIG_VERSION = 2;

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
 * Migrate v1 config to v2 format
 */
export function migrateConfig(oldConfig: unknown): GenieConfig {
  // Try parsing as v1 config
  const v1Result = GenieConfigV1Schema.safeParse(oldConfig);

  if (v1Result.success) {
    const v1 = v1Result.data;
    return GenieConfigSchema.parse({
      version: CONFIG_VERSION,
      session: {
        name: v1.session.name,
        defaultWindow: v1.session.defaultWindow,
        autoCreate: true,
      },
      terminal: {
        execTimeout: 120000,
        readLines: 100,
        worktreeBase: '.worktrees',
      },
      logging: {
        tmuxDebug: v1.logging.tmuxDebug,
        verbose: false,
      },
      shell: {
        preference: 'auto',
      },
      shortcuts: {
        tmuxInstalled: false,
        shellInstalled: false,
      },
      installMethod: v1.installMethod,
      setupComplete: false,
    });
  }

  // If not valid v1, return default config
  return GenieConfigSchema.parse({});
}

/**
 * Load genie config, returning defaults if not found
 * Automatically migrates v1 configs to v2
 */
export async function loadGenieConfig(): Promise<GenieConfig> {
  if (!existsSync(GENIE_CONFIG_FILE)) {
    return GenieConfigSchema.parse({});
  }

  try {
    const content = readFileSync(GENIE_CONFIG_FILE, 'utf-8');
    const data = JSON.parse(content);

    // Check if migration is needed (no version or version < 2)
    if (!data.version || data.version < CONFIG_VERSION) {
      const migrated = migrateConfig(data);
      // Save migrated config
      await saveGenieConfig(migrated);
      return migrated;
    }

    return GenieConfigSchema.parse(data);
  } catch (error: any) {
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

    // Check if migration is needed
    if (!data.version || data.version < CONFIG_VERSION) {
      return migrateConfig(data);
    }

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
 * Update terminal configuration
 */
export async function updateTerminalConfig(partial: Partial<TerminalConfig>): Promise<void> {
  const config = await loadGenieConfig();
  config.terminal = { ...config.terminal, ...partial };
  await saveGenieConfig(config);
}

/**
 * Get session name from config
 */
export function getSessionName(): string {
  const config = loadGenieConfigSync();
  return config.session.name;
}

/**
 * Get session configuration
 */
export function getSessionConfig(): SessionConfig {
  const config = loadGenieConfigSync();
  return config.session;
}

/**
 * Update session configuration
 */
export async function updateSessionConfig(partial: Partial<SessionConfig>): Promise<void> {
  const config = await loadGenieConfig();
  config.session = { ...config.session, ...partial };
  await saveGenieConfig(config);
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
 * Get shortcuts configuration
 */
export function getShortcutsConfig(): ShortcutsConfig {
  const config = loadGenieConfigSync();
  return config.shortcuts;
}

/**
 * Update shortcuts configuration
 */
export async function updateShortcutsConfig(partial: Partial<ShortcutsConfig>): Promise<void> {
  const config = await loadGenieConfig();
  config.shortcuts = { ...config.shortcuts, ...partial };
  await saveGenieConfig(config);
}

/**
 * Check if claudio integration is enabled
 */
export function isClaudioEnabled(): boolean {
  const config = loadGenieConfigSync();
  return config.claudio?.enabled ?? false;
}

/**
 * Update claudio configuration
 */
export async function updateClaudioConfig(enabled: boolean): Promise<void> {
  const config = await loadGenieConfig();
  config.claudio = { enabled };
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

// ============================================================================
// Source path detection helpers
// ============================================================================

const GENIE_PACKAGE_NAME = '@automagik/genie';

/**
 * Check if a directory is the genie-cli source directory
 * by looking for package.json with the correct name
 */
export function isGenieSourceDir(dir: string): boolean {
  try {
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) return false;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.name === GENIE_PACKAGE_NAME;
  } catch {
    return false;
  }
}

/**
 * Find genie-cli source directory by walking up from the given path
 */
export function findSourceInParents(startDir: string): string | null {
  let dir = startDir;
  const root = '/';

  while (dir !== root) {
    if (isGenieSourceDir(dir)) {
      return dir;
    }
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

/**
 * Known locations where genie-cli source might be found
 */
function getKnownSourcePaths(): string[] {
  const home = homedir();
  return [
    // Common workspace patterns
    join(home, 'workspace', 'guga', 'code', 'genie-cli'),
    join(home, 'workspace', 'code', 'genie-cli'),
    join(home, 'code', 'genie-cli'),
    join(home, 'projects', 'genie-cli'),
    join(home, 'dev', 'genie-cli'),
    join(home, 'src', 'genie-cli'),
    // Direct paths
    join(home, 'genie-cli'),
  ];
}

/**
 * Auto-detect genie-cli source directory
 *
 * Priority:
 * 1. Check if cwd is inside genie-cli source
 * 2. Check stored sourcePath in ~/.genie/config.json
 * 3. Check known paths
 *
 * Returns the source path or null if not found
 */
export function detectSourcePath(): string | null {
  // 1. Check if cwd is inside genie-cli source
  const cwd = process.cwd();
  const fromCwd = findSourceInParents(cwd);
  if (fromCwd) {
    return fromCwd;
  }

  // 2. Check stored path in config
  const config = loadGenieConfigSync();
  if (config.sourcePath && existsSync(config.sourcePath)) {
    if (isGenieSourceDir(config.sourcePath)) {
      return config.sourcePath;
    }
  }

  // 3. Check known paths
  for (const knownPath of getKnownSourcePaths()) {
    if (existsSync(knownPath) && isGenieSourceDir(knownPath)) {
      return knownPath;
    }
  }

  return null;
}

/**
 * Get or detect source path, with option to save if detected
 */
export async function getOrDetectSourcePath(saveIfFound: boolean = true): Promise<string | null> {
  const sourcePath = detectSourcePath();

  if (sourcePath && saveIfFound) {
    const config = await loadGenieConfig();
    if (config.sourcePath !== sourcePath) {
      config.sourcePath = sourcePath;
      await saveGenieConfig(config);
    }
  }

  return sourcePath;
}

/**
 * Set the source path in config
 */
export async function setSourcePath(sourcePath: string): Promise<void> {
  const config = await loadGenieConfig();
  config.sourcePath = sourcePath;
  await saveGenieConfig(config);
}

/**
 * Get the stored source path from config (without auto-detection)
 */
export function getStoredSourcePath(): string | null {
  const config = loadGenieConfigSync();
  return config.sourcePath || null;
}
