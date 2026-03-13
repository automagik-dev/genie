/**
 * Team Lead Command Builder — Single source of truth for team-lead launch commands.
 *
 * Both `session.ts` and `team-auto-spawn.ts` need to build the same claude CLI
 * command for launching a team-lead. This module prevents drift between the
 * two implementations (which previously caused GENIE_AGENT_NAME regressions).
 *
 * System prompt is written to ~/.genie/prompts/<team>.md and referenced via
 * --append-system-prompt-file (or --system-prompt-file) to keep the command short.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sanitizeTeamName } from './claude-native-teams.js';
import { loadGenieConfigSync } from './genie-config.js';

const PROMPTS_DIR = join(homedir(), '.genie', 'prompts');

/** Shell-quote a string for safe embedding in shell commands. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

interface BuildTeamLeadCommandOptions {
  systemPrompt?: string;
  resumeSessionId?: string;
  /** Override promptMode instead of reading from config (useful for testing) */
  promptMode?: 'append' | 'system';
}

/**
 * Build the claude launch command for a team-lead.
 *
 * Sets all required env vars (including GENIE_AGENT_NAME) and CLI flags.
 * CC requires --agent-id, --agent-name, and --team-name together.
 * The team lead uses agent-id "team-lead@<team>" by convention.
 *
 * System prompt is written to file and loaded via --append-system-prompt-file
 * (or --system-prompt-file) to keep the command short.
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

  // Write prompt to file, reference via --*-system-prompt-file
  if (options?.systemPrompt) {
    mkdirSync(PROMPTS_DIR, { recursive: true });
    const promptPath = join(PROMPTS_DIR, `${sanitized}.md`);
    writeFileSync(promptPath, options.systemPrompt, 'utf-8');

    const resolvedPromptMode = options?.promptMode ?? loadGenieConfigSync().promptMode;
    const promptFlag = resolvedPromptMode === 'system' ? '--system-prompt-file' : '--append-system-prompt-file';
    parts.push(`${promptFlag} ${shellQuote(promptPath)}`);
  }

  return parts.join(' ');
}
