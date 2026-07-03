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

// Constants for the genie hook script (used for cleanup)
const GENIE_HOOK_SCRIPT_NAME = 'genie-bash-hook.sh';

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
 * Tools that genie always whitelists in `~/.claude/settings.json` and in
 * spawned-agent inline `--settings`. AskUserQuestion is the only baseline today —
 * without it, Claude Code routes the user-prompt UI through the team-lead
 * approval queue, breaking the tool's reason for existing (closes #1688).
 */
export const GENIE_BASELINE_ALLOWED_TOOLS: readonly string[] = ['AskUserQuestion'];

/**
 * Mutate `settings.permissions.allow` so every baseline tool is present.
 * Returns true when the object was modified, false otherwise.
 */
export function ensureBaselineAllowedTools(settings: Record<string, unknown>): boolean {
  const permissions = (settings.permissions ?? {}) as Record<string, unknown>;
  const existingAllow = Array.isArray(permissions.allow) ? (permissions.allow as unknown[]) : [];
  const allowStrings = existingAllow.filter((entry): entry is string => typeof entry === 'string');
  const missing = GENIE_BASELINE_ALLOWED_TOOLS.filter((tool) => !allowStrings.includes(tool));
  if (missing.length === 0) return false;

  permissions.allow = [...allowStrings, ...missing];
  settings.permissions = permissions;
  return true;
}
