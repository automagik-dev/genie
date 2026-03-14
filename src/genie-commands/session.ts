/**
 * Genie Session Helpers
 *
 * Exports used by other modules:
 *   - getAgentsSystemPrompt() — reads AGENTS.md from cwd
 *   - buildClaudeCommand()    — builds claude CLI launch command
 *   - sanitizeWindowName()    — sanitizes tmux window names
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTeamLeadCommand } from '../lib/team-lead-command.js';

/**
 * Get the AGENTS.md system prompt if it exists in the current directory.
 * Returns the file contents as a string, or null if not found.
 */
export function getAgentsSystemPrompt(): string | null {
  const agentsPath = join(process.cwd(), 'AGENTS.md');
  if (existsSync(agentsPath)) {
    return readFileSync(agentsPath, 'utf-8');
  }
  return null;
}

/**
 * Build the claude launch command with native team flags.
 * Delegates to the shared buildTeamLeadCommand (single source of truth).
 */
export function buildClaudeCommand(teamName: string, systemPrompt?: string, resumeSessionId?: string): string {
  return buildTeamLeadCommand(teamName, { systemPrompt, resumeSessionId });
}

/**
 * Sanitize a window name for tmux targeting.
 * tmux uses '.' as a pane separator in targets (session:window.pane),
 * so dots in window names cause "can't find pane" errors.
 */
export function sanitizeWindowName(name: string): string {
  return name.replace(/\./g, '-');
}
