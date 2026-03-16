/**
 * Team Lead Command Builder — Single source of truth for team-lead launch commands.
 *
 * Both `session.ts` and `team-auto-spawn.ts` need to build the same claude CLI
 * command for launching a team-lead. This module prevents drift between the
 * two implementations (which previously caused GENIE_AGENT_NAME regressions).
 *
 * System prompt file path is passed directly via --append-system-prompt-file
 * (or --system-prompt-file). No copy to ~/.genie/prompts/.
 */

import { basename } from 'node:path';
import { sanitizeTeamName } from './claude-native-teams.js';
import { loadGenieConfigSync } from './genie-config.js';

/** Shell-quote a string for safe embedding in shell commands. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

interface BuildTeamLeadCommandOptions {
  /** Path to AGENTS.md or system prompt file (passed directly, no copy). */
  systemPromptFile?: string;
  resumeSessionId?: string;
  /** Set session ID for a new session (mutually exclusive with resumeSessionId) */
  sessionId?: string;
  /** Override promptMode instead of reading from config (useful for testing) */
  promptMode?: 'append' | 'system';
}

/**
 * Build the claude launch command for a team-lead.
 *
 * Sets all required env vars (including GENIE_AGENT_NAME) and CLI flags.
 * CC requires --agent-id, --agent-name, and --team-name together.
 * The agent name is derived from basename(cwd) to match the folder name.
 *
 * System prompt file is passed directly via --append-system-prompt-file
 * (or --system-prompt-file) — no intermediate copy step.
 */
export function buildTeamLeadCommand(teamName: string, options?: BuildTeamLeadCommandOptions): string {
  const sanitized = sanitizeTeamName(teamName);
  const qTeam = shellQuote(sanitized);
  const folderName = basename(process.cwd());
  const parts = [
    'CLAUDECODE=1',
    'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1',
    `GENIE_TEAM=${qTeam}`,
    `GENIE_AGENT_NAME=${shellQuote(folderName)}`,
    'claude',
    `--agent-id ${shellQuote(`${folderName}@${sanitized}`)}`,
    `--agent-name ${shellQuote(folderName)}`,
    `--team-name ${qTeam}`,
    '--dangerously-skip-permissions',
  ];

  if (options?.resumeSessionId) {
    parts.push(`--resume ${shellQuote(options.resumeSessionId)}`);
  } else if (options?.sessionId) {
    parts.push(`--session-id ${shellQuote(options.sessionId)}`);
  }

  // Pass file path directly — no copy step
  if (options?.systemPromptFile) {
    const resolvedPromptMode = options?.promptMode ?? loadGenieConfigSync().promptMode;
    const promptFlag = resolvedPromptMode === 'system' ? '--system-prompt-file' : '--append-system-prompt-file';
    parts.push(`${promptFlag} ${shellQuote(options.systemPromptFile)}`);
  }

  return parts.join(' ');
}
