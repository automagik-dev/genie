/**
 * Claude Settings Manager
 *
 * Manages ~/.claude/settings.json without breaking existing settings.
 * Uses Zod with passthrough() to preserve unknown fields.
 */

import { existsSync, unlinkSync } from 'node:fs';
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
