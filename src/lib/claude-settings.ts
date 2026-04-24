/**
 * Claude Settings Manager
 *
 * Manages ~/.claude/settings.json without breaking existing settings.
 * Uses Zod with passthrough() to preserve unknown fields.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
// Claude directory and settings file paths
const CLAUDE_DIR = join(homedir(), '.claude');
const CLAUDE_HOOKS_DIR = join(CLAUDE_DIR, 'hooks');
const CLAUDE_SETTINGS_FILE = join(CLAUDE_DIR, 'settings.json');

// Constants for the genie hook script (used for cleanup)
const GENIE_HOOK_SCRIPT_NAME = 'genie-bash-hook.sh';

/**
 * Get the path to the Claude settings file (~/.claude/settings.json)
 */
export function getClaudeSettingsPath(): string {
  return CLAUDE_SETTINGS_FILE;
}

/**
 * Get the path to the genie hook script (for cleanup)
 */
function getGenieHookScriptPath(): string {
  return join(CLAUDE_HOOKS_DIR, GENIE_HOOK_SCRIPT_NAME);
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
 * Ensure ~/.claude/settings.json is in a safe, valid state for genie operation.
 *
 * Prior bug: the old `ensureTeammateBypassPermissions()` helper wrote
 * `teammateMode: "bypassPermissions"` into settings.json, but `teammateMode` is
 * CC's topology selector with valid values {auto, tmux, in-process}. Newer CC
 * versions hard-reject the entire settings file when they encounter an invalid
 * `teammateMode`, silently wiping the user's permissions, hooks, and plugins
 * config. This function repairs any such stale value on existing installs.
 *
 * What this function does:
 * - Repair: if `settings.teammateMode` is present and not a valid topology value
 *   (auto | tmux | in-process), delete it so CC accepts the file again.
 * - Keep: ensure `settings.skipDangerousModePermissionPrompt === true` so that
 *   agents spawned with `--dangerously-skip-permissions` (manual/legacy path)
 *   don't hit an interactive confirmation prompt.
 * - Write back only if something changed.
 *
 * Idempotent — safe to call on every team setup.
 */
export function ensureClaudeSettingsSafe(): void {
  const dir = join(homedir(), '.claude');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let settings: Record<string, unknown> = {};
  if (existsSync(CLAUDE_SETTINGS_FILE)) {
    try {
      settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_FILE, 'utf-8'));
    } catch {
      // Corrupted file — overwrite with safe defaults
    }
  }

  const validTopologyValues = new Set(['auto', 'tmux', 'in-process']);

  let changed = false;
  // Repair: remove any invalid legacy teammateMode value written by older genie versions.
  // We rebuild the object without the key so JSON.stringify won't emit it.
  if ('teammateMode' in settings && !validTopologyValues.has(settings.teammateMode as string)) {
    const { teammateMode: _removed, ...rest } = settings;
    settings = rest;
    changed = true;
  }
  if (settings.skipDangerousModePermissionPrompt !== true) {
    settings.skipDangerousModePermissionPrompt = true;
    changed = true;
  }

  if (changed) {
    writeFileSync(CLAUDE_SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8');
  }
}

/**
 * Contract home directory to ~ in a path (for display)
 */
export function contractClaudePath(path: string): string {
  const home = homedir();
  if (path.startsWith(`${home}/`)) {
    return `~${path.slice(home.length)}`;
  }
  if (path === home) {
    return '~';
  }
  return path;
}
