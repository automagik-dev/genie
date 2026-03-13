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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeTeamName } from './claude-native-teams.js';
import { loadGenieConfigSync } from './genie-config.js';

const PROMPTS_DIR = join(homedir(), '.genie', 'prompts');

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

/**
 * Write the combined system prompt to ~/.genie/prompts/<team>.md.
 * Returns the file path, or null if there's no prompt to write.
 */
function persistSystemPrompt(teamName: string, systemPrompt?: string): string | null {
  const teamLeadPrompt = getTeamLeadPrompt();
  const fullPrompt = [systemPrompt, teamLeadPrompt].filter(Boolean).join('\n\n');
  if (!fullPrompt) return null;

  mkdirSync(PROMPTS_DIR, { recursive: true });
  const promptPath = join(PROMPTS_DIR, `${sanitizeTeamName(teamName)}.md`);
  writeFileSync(promptPath, fullPrompt, 'utf-8');
  return promptPath;
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
    const resolvedPromptMode = options?.promptMode ?? loadGenieConfigSync().promptMode;
    const promptFlag = resolvedPromptMode === 'system' ? '--system-prompt' : '--append-system-prompt';
    parts.push(`${promptFlag} "$(cat ${shellQuote(promptPath)})"`);
  }

  return parts.join(' ');
}
