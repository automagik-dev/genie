/**
 * Team Lead Command Builder — Single source of truth for team-lead launch commands.
 *
 * Both `tui.ts` and `team-auto-spawn.ts` need to build the same claude CLI
 * command for launching a team-lead. This module prevents drift between the
 * two implementations (which previously caused GENIE_AGENT_NAME regressions).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeTeamName } from './claude-native-teams.js';

/** Shell-quote a string for safe embedding in shell commands. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Read the built-in TEAM_LEAD_PROMPT.md from the genie-cli package root.
 * This prompt teaches team-leads to use genie CLI instead of native CC tools.
 */
function getTeamLeadPrompt(): string | null {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const promptPath = join(thisDir, '..', '..', 'TEAM_LEAD_PROMPT.md');
  if (existsSync(promptPath)) {
    return readFileSync(promptPath, 'utf-8');
  }
  return null;
}

interface BuildTeamLeadCommandOptions {
  systemPrompt?: string;
  resumeSessionId?: string;
}

/**
 * Build the claude launch command for a team-lead.
 *
 * Sets all required env vars (including GENIE_AGENT_NAME) and CLI flags.
 * CC requires --agent-id, --agent-name, and --team-name together.
 * The team lead uses agent-id "team-lead@<team>" by convention.
 */
export function buildTeamLeadCommand(teamName: string, options?: BuildTeamLeadCommandOptions): string {
  const sanitized = sanitizeTeamName(teamName);
  const qTeam = shellQuote(sanitized);
  const parts = [
    'CLAUDECODE=1',
    'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1',
    `GENIE_TEAM=${qTeam}`,
    `GENIE_AGENT_NAME='team-lead'`,
    'claude',
    `--agent-id ${shellQuote(`team-lead@${sanitized}`)}`,
    `--agent-name ${shellQuote('team-lead')}`,
    `--team-name ${qTeam}`,
    '--dangerously-skip-permissions',
  ];

  if (options?.resumeSessionId) {
    parts.push(`--resume ${shellQuote(options.resumeSessionId)}`);
  }

  // Combine AGENTS.md + built-in genie CLI prompt
  const teamLeadPrompt = getTeamLeadPrompt();
  const fullPrompt = [options?.systemPrompt, teamLeadPrompt].filter(Boolean).join('\n\n');
  if (fullPrompt) {
    const flattened = fullPrompt.replace(/\n/g, ' ');
    parts.push(`--system-prompt ${shellQuote(flattened)}`);
  }

  return parts.join(' ');
}
