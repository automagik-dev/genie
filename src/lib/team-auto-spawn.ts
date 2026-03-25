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

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeWindowName } from '../genie-commands/session.js';
import { ensureNativeTeam, loadConfig, registerNativeMember, sanitizeTeamName } from './claude-native-teams.js';
import { buildTeamLeadCommand, shellQuote } from './team-lead-command.js';
import * as tmux from './tmux.js';

interface EnsureTeamLeadResult {
  /** Whether a new team window was created (false = already existed) */
  created: boolean;
  /** The tmux session name */
  session: string;
  /** The tmux window name */
  window: string;
}

/**
 * Get AGENTS.md file path from the working directory if it exists.
 */
function getSystemPromptFile(workingDir: string): string | null {
  const agentsPath = join(workingDir, 'AGENTS.md');
  if (existsSync(agentsPath)) {
    return agentsPath;
  }
  return null;
}

/**
 * Ensure a tmux session exists for the given team.
 * Uses the current tmux session if inside one, otherwise creates a session named after the team.
 */
async function ensureSession(teamName: string): Promise<string> {
  // If inside tmux, reuse the current session
  const current = await tmux.getCurrentSessionName();
  if (current) return current;

  // Otherwise create/find a session named after the team (folder-based naming)
  const sessionName = sanitizeTeamName(teamName);
  const existing = await tmux.findSessionByName(sessionName);
  if (existing) return sessionName;

  const session = await tmux.createSession(sessionName);
  if (!session) {
    throw new Error(`Failed to create tmux session "${sessionName}"`);
  }
  return sessionName;
}

/**
 * Check if a team already has an active team-lead.
 *
 * A team is considered "active" if:
 * 1. Its native config.json exists, AND
 * 2. A tmux window with the team name exists in any session
 */
export async function isTeamActive(teamName: string): Promise<boolean> {
  const config = await loadConfig(teamName);
  if (!config) return false;

  // Check current session first, then try team name as session
  const sessionName = (await tmux.getCurrentSessionName()) ?? sanitizeTeamName(teamName);
  const session = await tmux.findSessionByName(sessionName);
  if (!session) return false;

  try {
    const windows = await tmux.listWindows(sessionName);
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
  const currentSession = (await tmux.getCurrentSessionName()) ?? sanitizeTeamName(teamName);
  if (await isTeamActive(teamName)) {
    return { created: false, session: currentSession, window: sanitizeWindowName(teamName) };
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
  const session = await ensureSession(teamName);

  // Create team window (sanitize dots — tmux interprets '.' as pane separator)
  const windowName = sanitizeWindowName(teamName);
  const teamWindow = await tmux.ensureTeamWindow(session, windowName, workingDir);

  if (teamWindow.created) {
    // Launch Claude Code in the new window
    const systemPromptFile = getSystemPromptFile(workingDir);
    const target = `${session}:${windowName}`;
    const cdCmd = `cd ${shellQuote(workingDir)}`;
    await tmux.executeTmux(`send-keys -t ${shellQuote(target)} ${shellQuote(cdCmd)} Enter`);
    const cmd = buildTeamLeadCommand(teamName, { systemPromptFile: systemPromptFile ?? undefined });
    await tmux.executeTmux(`send-keys -t ${shellQuote(target)} ${shellQuote(cmd)} Enter`);
  }

  return { created: teamWindow.created, session, window: windowName };
}
