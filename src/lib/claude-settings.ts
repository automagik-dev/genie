/**
 * Claude Settings Manager
 *
 * Manages ~/.claude/settings.json without breaking existing settings.
 * Uses Zod with passthrough() to preserve unknown fields.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { z } from 'zod';

// Claude directory and settings file paths
const CLAUDE_DIR = join(homedir(), '.claude');
const CLAUDE_HOOKS_DIR = join(CLAUDE_DIR, 'hooks');
const CLAUDE_SETTINGS_FILE = join(CLAUDE_DIR, 'settings.json');

// Hook entry schema for a single hook command
const HookCommandSchema = z.object({
  type: z.literal('command'),
  command: z.string(),
  timeout: z.number().optional(),
}).passthrough();

// Matcher hooks schema (array of hook commands for a specific matcher)
const MatcherHooksSchema = z.object({
  matcher: z.string(),
  hooks: z.array(HookCommandSchema),
}).passthrough();

// Hooks configuration schema
const HooksConfigSchema = z.object({
  PreToolUse: z.array(MatcherHooksSchema).optional(),
  PostToolUse: z.array(MatcherHooksSchema).optional(),
}).passthrough();

// Full settings schema with passthrough to preserve unknown fields
const ClaudeSettingsSchema = z.object({
  model: z.string().optional(),
  enabledPlugins: z.record(z.unknown()).optional(),
  hooks: HooksConfigSchema.optional(),
}).passthrough();

export type ClaudeSettings = z.infer<typeof ClaudeSettingsSchema>;

// Constants for the genie hook script (used for cleanup)
export const GENIE_HOOK_SCRIPT_NAME = 'genie-bash-hook.sh';

/**
 * Get the path to the Claude directory (~/.claude)
 */
export function getClaudeDir(): string {
  return CLAUDE_DIR;
}

/**
 * Get the path to the Claude hooks directory (~/.claude/hooks)
 */
export function getClaudeHooksDir(): string {
  return CLAUDE_HOOKS_DIR;
}

/**
 * Get the path to the Claude settings file (~/.claude/settings.json)
 */
export function getClaudeSettingsPath(): string {
  return CLAUDE_SETTINGS_FILE;
}

/**
 * Get the path to the genie hook script (for cleanup)
 */
export function getGenieHookScriptPath(): string {
  return join(CLAUDE_HOOKS_DIR, GENIE_HOOK_SCRIPT_NAME);
}

/**
 * Check if Claude settings file exists
 */
export function claudeSettingsExists(): boolean {
  return existsSync(CLAUDE_SETTINGS_FILE);
}

/**
 * Ensure the Claude directory exists
 */
export function ensureClaudeDir(): void {
  if (!existsSync(CLAUDE_DIR)) {
    mkdirSync(CLAUDE_DIR, { recursive: true });
  }
}

/**
 * Load Claude settings, returning defaults if not found
 */
export async function loadClaudeSettings(): Promise<ClaudeSettings> {
  if (!existsSync(CLAUDE_SETTINGS_FILE)) {
    return ClaudeSettingsSchema.parse({});
  }

  try {
    const content = readFileSync(CLAUDE_SETTINGS_FILE, 'utf-8');
    const data = JSON.parse(content);
    return ClaudeSettingsSchema.parse(data);
  } catch (error: any) {
    // If settings are invalid, return defaults but warn
    console.warn(`Warning: Invalid Claude settings, using defaults: ${error.message}`);
    return ClaudeSettingsSchema.parse({});
  }
}

/**
 * Save Claude settings to disk
 */
export async function saveClaudeSettings(settings: ClaudeSettings): Promise<void> {
  ensureClaudeDir();

  try {
    const validated = ClaudeSettingsSchema.parse(settings);
    const content = JSON.stringify(validated, null, 2);
    writeFileSync(CLAUDE_SETTINGS_FILE, content, 'utf-8');
  } catch (error: any) {
    throw new Error(`Failed to save Claude settings: ${error.message}`);
  }
}

/**
 * Check if hook script exists (for cleanup)
 */
export function hookScriptExists(): boolean {
  return existsSync(getGenieHookScriptPath());
}

/**
 * Remove the hook script file (for cleanup)
 */
export function removeHookScript(): void {
  const scriptPath = getGenieHookScriptPath();
  if (existsSync(scriptPath)) {
    unlinkSync(scriptPath);
  }
}

/**
 * Contract home directory to ~ in a path (for display)
 */
export function contractClaudePath(path: string): string {
  const home = homedir();
  if (path.startsWith(home + '/')) {
    return '~' + path.slice(home.length);
  }
  if (path === home) {
    return '~';
  }
  return path;
}
