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
 * Tools that genie always whitelists in `~/.claude/settings.json` and in
 * spawned-agent inline `--settings`. AskUserQuestion is the only baseline today —
 * without it, Claude Code routes the user-prompt UI through the team-lead
 * approval queue, breaking the tool's reason for existing (closes #1688).
 */
export const GENIE_BASELINE_ALLOWED_TOOLS: readonly string[] = ['AskUserQuestion'];

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
 * - Seed: ensure every tool in GENIE_BASELINE_ALLOWED_TOOLS is present in
 *   `settings.permissions.allow`. Existing entries (and any unrelated permission
 *   keys like `deny` / `defaultMode`) are preserved verbatim.
 * - Write back only if something changed.
 *
 * Idempotent — safe to call on every team setup.
 */
export function ensureClaudeSettingsSafe(): void {
  // Resolve paths at call time so tests (and any caller that pivots HOME) see
  // the right ~/.claude/settings.json. Bun's os.homedir() caches at process
  // start and ignores subsequent process.env.HOME changes, so we read HOME
  // directly with homedir() as the production fallback (matches the existing
  // pattern in sessionExists()).
  const home = process.env.HOME ?? homedir();
  const dir = join(home, '.claude');
  const settingsFile = join(dir, 'settings.json');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsFile)) {
    try {
      settings = JSON.parse(readFileSync(settingsFile, 'utf-8'));
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

  if (ensureBaselineAllowedTools(settings)) {
    changed = true;
  }

  if (changed) {
    writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8');
  }
}

/**
 * Mutate `settings.permissions.allow` so every baseline tool is present.
 * Returns true when the object was modified, false otherwise.
 */
function ensureBaselineAllowedTools(settings: Record<string, unknown>): boolean {
  const permissions = (settings.permissions ?? {}) as Record<string, unknown>;
  const existingAllow = Array.isArray(permissions.allow) ? (permissions.allow as unknown[]) : [];
  const allowStrings = existingAllow.filter((entry): entry is string => typeof entry === 'string');
  const missing = GENIE_BASELINE_ALLOWED_TOOLS.filter((tool) => !allowStrings.includes(tool));
  if (missing.length === 0) return false;

  permissions.allow = [...allowStrings, ...missing];
  settings.permissions = permissions;
  return true;
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
