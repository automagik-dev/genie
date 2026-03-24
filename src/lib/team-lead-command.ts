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

import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { sanitizeTeamName } from './claude-native-teams.js';
import { loadGenieConfigSync } from './genie-config.js';

/** Shell-quote a string for safe embedding in shell commands. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

interface BuildTeamLeadCommandOptions {
  /** Path to AGENTS.md or system prompt file (passed directly, no copy). */
  systemPromptFile?: string;
  /** Session ID to resume (emits --resume). Mutually exclusive with sessionId. */
  continueName?: string;
  /** Set session ID for a new session (mutually exclusive with continueName) */
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
    'GENIE_WORKER=1',
    'CLAUDECODE=1',
    'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1',
    `GENIE_TEAM=${qTeam}`,
    `GENIE_AGENT_NAME=${shellQuote(folderName)}`,
    'claude',
    `--agent-id ${shellQuote(`team-lead@${sanitized}`)}`,
    '--agent-name team-lead',
    `--team-name ${qTeam}`,
    '--agent-type team-lead',
    '--dangerously-skip-permissions',
  ];

  // Session name for CC's /resume and terminal title
  parts.push(`--name ${shellQuote(sanitized)}`);

  if (options?.continueName) {
    parts.push(`--resume ${shellQuote(options.continueName)}`);
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

/**
 * Convert a directory path to CC's project directory name.
 *
 * CC stores sessions in `~/.claude/projects/<encoded-path>/`.
 * The encoded path replaces `/` with `-` (the leading slash becomes a leading `-`).
 */
export function ccProjectDirName(dir: string): string {
  return dir.replace(/\//g, '-');
}

/** Check if a single JSONL file has a custom-title matching the needle (lowercase). */
function fileHasSessionName(filePath: string, needle: string): boolean {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').slice(0, 10);
    for (const line of lines) {
      if (!line.includes('custom-title')) continue;
      const entry = JSON.parse(line);
      if (entry.type === 'custom-title' && entry.customTitle?.toLowerCase() === needle) {
        return true;
      }
    }
  } catch {
    // Malformed JSON or unreadable file
  }
  return false;
}

/**
 * Check if a Claude Code session with the given name already exists.
 *
 * Scans CC's JSONL session files for a `custom-title` entry whose
 * `customTitle` matches the given name (case-insensitive). This is the
 * same value set by `--name` when launching CC.
 *
 * Returns `true` if at least one prior session with that name exists,
 * `false` otherwise. Never throws — returns `false` on any error.
 */
export function sessionExists(name: string, cwd?: string): boolean {
  try {
    const home = process.env.HOME ?? '/root';
    const projectDir = ccProjectDirName(cwd ?? process.cwd());
    const projectPath = join(home, '.claude', 'projects', projectDir);

    let files: string[];
    try {
      files = readdirSync(projectPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return false;
    }

    const needle = name.toLowerCase();
    return files.some((file) => fileHasSessionName(join(projectPath, file), needle));
  } catch {
    return false;
  }
}
