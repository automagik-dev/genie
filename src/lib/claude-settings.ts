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
 * Ensure `teammateMode` is set to `bypassPermissions` in ~/.claude/settings.json.
 *
 * CC's native team layer has a separate permission gate controlled by this global
 * setting. Without it, tool approvals route to the team lead — which is an AI agent
 * that can't approve, causing a deadlock. The per-session `--permission-mode` flag
 * is not sufficient when `teammateMode` is explicitly set to a restrictive value.
 *
 * Also ensures `skipDangerousModePermissionPrompt` is true so agents spawned with
 * `--dangerously-skip-permissions` don't hit an interactive confirmation prompt.
 *
 * Idempotent — safe to call on every team setup.
 */
export function ensureTeammateBypassPermissions(): void {
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

  let changed = false;
  if (settings.teammateMode !== 'bypassPermissions') {
    settings.teammateMode = 'bypassPermissions';
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
