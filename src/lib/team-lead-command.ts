/**
 * Team Lead Command Builder — Single source of truth for team-lead launch commands.
 *
 * Both `tui.ts` and `team-auto-spawn.ts` need to build the same claude CLI
 * command for launching a team-lead. This module prevents drift between the
 * two implementations (which previously caused GENIE_AGENT_NAME regressions).
 *
 * System prompt is written to ~/.genie/prompts/<team>.md and loaded via
 * $(cat path) to avoid "argument list too long" errors in tmux send-keys.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sanitizeTeamName } from './claude-native-teams.js';

const PROMPTS_DIR = join(homedir(), '.genie', 'prompts');

/** Shell-quote a string for safe embedding in shell commands. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Write the system prompt (AGENTS.md content) to ~/.genie/prompts/<team>.md.
 * Returns the file path, or null if there's no prompt to write.
 *
 * Note: The team-lead orchestration prompt is now injected into
 * ~/.claude/rules/genie-orchestration.md by install.sh at install time,
 * so Claude Code auto-loads it every session without runtime path resolution.
 */
function persistSystemPrompt(teamName: string, systemPrompt?: string): string | null {
  if (!systemPrompt) return null;

  mkdirSync(PROMPTS_DIR, { recursive: true });
  const promptPath = join(PROMPTS_DIR, `${sanitizeTeamName(teamName)}.md`);
  writeFileSync(promptPath, systemPrompt, 'utf-8');
  return promptPath;
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
 *
 * System prompt is loaded from file via $(cat) to keep the command short.
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

  // Write prompt to file, reference via $(cat) to avoid arg-list-too-long
  const promptPath = persistSystemPrompt(sanitized, options?.systemPrompt);
  if (promptPath) {
    parts.push(`--system-prompt "$(cat ${shellQuote(promptPath)})"`);
  }

  return parts.join(' ');
}
