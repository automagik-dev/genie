/**
 * Team Auto-Spawn — ensures a Claude Code team-lead exists for a given team.
 *
 * Used by `genie team ensure <name>` and can be triggered by external systems
 * (e.g., Omni's genie provider) when messages are delivered to a team that
 * doesn't have an active team-lead process.
 *
 * Idempotent: safe to call repeatedly. If the team already has an active
 * tmux window, this is a no-op.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureNativeTeam, loadConfig, registerNativeMember, sanitizeTeamName } from './claude-native-teams.js';
import * as tmux from './tmux.js';

const DEFAULT_SESSION = 'genie';

/** Shell-quote a string for safe embedding in shell commands. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export interface EnsureTeamLeadResult {
  /** Whether a new team window was created (false = already existed) */
  created: boolean;
  /** The tmux session name */
  session: string;
  /** The tmux window name */
  window: string;
}

/**
 * Build the claude CLI command for a team-lead.
 * Reuses the same pattern as tui.ts buildClaudeCommand.
 */
/** Read the built-in TEAM_LEAD_PROMPT.md from the genie-cli package root. */
function getTeamLeadPrompt(): string | null {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const promptPath = join(thisDir, '..', '..', 'TEAM_LEAD_PROMPT.md');
  if (existsSync(promptPath)) {
    return readFileSync(promptPath, 'utf-8');
  }
  return null;
}

function buildTeamLeadCommand(teamName: string, systemPrompt?: string): string {
  const sanitized = sanitizeTeamName(teamName);
  const qTeam = shellQuote(sanitized);
  const parts = [
    'CLAUDECODE=1',
    'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1',
    `GENIE_TEAM=${qTeam}`,
    'claude',
    `--agent-id ${shellQuote(`team-lead@${sanitized}`)}`,
    `--agent-name ${shellQuote('team-lead')}`,
    `--team-name ${qTeam}`,
    '--dangerously-skip-permissions',
  ];

  // Combine AGENTS.md + built-in genie CLI prompt
  const teamLeadPrompt = getTeamLeadPrompt();
  const fullPrompt = [systemPrompt, teamLeadPrompt].filter(Boolean).join('\n\n');
  if (fullPrompt) {
    const flattened = fullPrompt.replace(/\n/g, ' ');
    parts.push(`--system-prompt ${shellQuote(flattened)}`);
  }

  return parts.join(' ');
}

/**
 * Read AGENTS.md from the working directory if it exists.
 */
function getSystemPrompt(workingDir: string): string | null {
  const agentsPath = join(workingDir, 'AGENTS.md');
  if (existsSync(agentsPath)) {
    return readFileSync(agentsPath, 'utf-8');
  }
  return null;
}

/**
 * Ensure a tmux session exists for teams.
 * Creates the "genie" session if it doesn't exist.
 */
async function ensureSession(): Promise<string> {
  const existing = await tmux.findSessionByName(DEFAULT_SESSION);
  if (existing) return DEFAULT_SESSION;

  const session = await tmux.createSession(DEFAULT_SESSION);
  if (!session) {
    throw new Error(`Failed to create tmux session "${DEFAULT_SESSION}"`);
  }
  return DEFAULT_SESSION;
}

/**
 * Check if a team already has an active team-lead.
 *
 * A team is considered "active" if:
 * 1. Its native config.json exists, AND
 * 2. A tmux window with the team name exists in the genie session
 */
async function isTeamActive(teamName: string): Promise<boolean> {
  const config = await loadConfig(teamName);
  if (!config) return false;

  const session = await tmux.findSessionByName(DEFAULT_SESSION);
  if (!session) return false;

  try {
    const windows = await tmux.listWindows(DEFAULT_SESSION);
    const sanitized = sanitizeTeamName(teamName);
    return windows.some((w) => w.name === sanitized || w.name === teamName);
  } catch {
    return false;
  }
}

/**
 * Ensure a team has an active Claude Code team-lead.
 *
 * 1. If team is already active (config + tmux window exist), returns immediately.
 * 2. Otherwise, creates native team structure + tmux window + launches Claude Code.
 *
 * @param teamName - The team name (will be sanitized for filesystem use)
 * @param workingDir - Working directory for the Claude Code session
 * @returns Result indicating whether the team was created or already existed
 */
export async function ensureTeamLead(teamName: string, workingDir: string): Promise<EnsureTeamLeadResult> {
  // Fast path: team already active
  if (await isTeamActive(teamName)) {
    return { created: false, session: DEFAULT_SESSION, window: sanitizeTeamName(teamName) };
  }

  // Create native team structure
  await ensureNativeTeam(teamName, `Genie team: ${teamName}`, 'pending');
  await registerNativeMember(teamName, {
    agentName: 'team-lead',
    agentType: 'general-purpose',
    color: 'blue',
    cwd: workingDir,
  });

  // Ensure tmux session exists
  const session = await ensureSession();

  // Create team window
  const teamWindow = await tmux.ensureTeamWindow(session, teamName, workingDir);

  if (teamWindow.created) {
    // Launch Claude Code in the new window
    const systemPrompt = getSystemPrompt(workingDir);
    const target = `${session}:${teamName}`;
    const cdCmd = `cd ${shellQuote(workingDir)}`;
    await tmux.executeTmux(`send-keys -t ${shellQuote(target)} ${shellQuote(cdCmd)} Enter`);
    const cmd = buildTeamLeadCommand(teamName, systemPrompt ?? undefined);
    await tmux.executeTmux(`send-keys -t ${shellQuote(target)} ${shellQuote(cmd)} Enter`);
  }

  return { created: teamWindow.created, session, window: sanitizeTeamName(teamName) };
}
