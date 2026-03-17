/**
 * Team Auto-Spawn — ensures a Claude Code team-lead exists for a given team.
 *
 * Used by `genie team ensure <name>` and can be triggered by external systems
 * (e.g., Omni's genie provider) when messages are delivered to a team that
 * doesn't have an active team-lead process.
 *
 * Idempotent: safe to call repeatedly. If the team already has an active
 * tmux window with a live Claude Code process, this is a no-op.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveSessionName, sanitizeWindowName } from '../genie-commands/session.js';
import * as registry from './agent-registry.js';
import { ensureNativeTeam, loadConfig, registerNativeMember, sanitizeTeamName } from './claude-native-teams.js';
import { buildTeamLeadCommand, shellQuote } from './team-lead-command.js';
import * as tmux from './tmux.js';

/** Grace period (ms) after spawn before liveness checks kick in. */
const LIVENESS_GRACE_MS = 30_000;

interface EnsureTeamLeadResult {
  /** Whether a new team window was created (false = already existed) */
  created: boolean;
  /** The tmux session name */
  session: string;
  /** The tmux window name */
  window: string;
}

// ============================================================================
// Dependency injection (testability without mock.module)
// ============================================================================

/** Dependencies used by team-auto-spawn functions. */
export interface TeamAutoSpawnDeps {
  loadConfig: typeof loadConfig;
  findSessionByName: typeof tmux.findSessionByName;
  listWindows: typeof tmux.listWindows;
  listPanes: typeof tmux.listPanes;
  isPaneAlive: typeof tmux.isPaneAlive;
  resolveSessionName: typeof resolveSessionName;
  getTeamLeadEntry: typeof registry.getTeamLeadEntry;
  saveTeamLeadEntry: typeof registry.saveTeamLeadEntry;
  ensureNativeTeam: typeof ensureNativeTeam;
  registerNativeMember: typeof registerNativeMember;
  createSession: typeof tmux.createSession;
  ensureTeamWindow: typeof tmux.ensureTeamWindow;
  executeTmux: typeof tmux.executeTmux;
  existsSync: typeof existsSync;
  buildTeamLeadCommand: typeof buildTeamLeadCommand;
  now: () => number;
}

/** Default production dependencies. */
const defaultDeps: TeamAutoSpawnDeps = {
  loadConfig,
  findSessionByName: tmux.findSessionByName,
  listWindows: tmux.listWindows,
  listPanes: tmux.listPanes,
  isPaneAlive: tmux.isPaneAlive,
  resolveSessionName,
  getTeamLeadEntry: registry.getTeamLeadEntry,
  saveTeamLeadEntry: registry.saveTeamLeadEntry,
  ensureNativeTeam,
  registerNativeMember,
  createSession: tmux.createSession,
  ensureTeamWindow: tmux.ensureTeamWindow,
  executeTmux: tmux.executeTmux,
  existsSync,
  buildTeamLeadCommand,
  now: Date.now,
};

/**
 * Get AGENTS.md file path from the working directory if it exists.
 */
function getSystemPromptFile(workingDir: string, deps: TeamAutoSpawnDeps): string | null {
  const agentsPath = join(workingDir, 'AGENTS.md');
  if (deps.existsSync(agentsPath)) {
    return agentsPath;
  }
  return null;
}

/**
 * Resolve the tmux session name for a team.
 *
 * Resolution order:
 *   1. GENIE_SESSION env var (explicit override)
 *   2. Derive from workingDir via resolveSessionName()
 *   3. Team-lead registry session (only when it matches this project session)
 */
async function resolveSession(teamName: string, workingDir: string, deps: TeamAutoSpawnDeps): Promise<string> {
  if (process.env.GENIE_SESSION) return process.env.GENIE_SESSION;

  const derivedSession = await deps.resolveSessionName(workingDir);
  const entry = await deps.getTeamLeadEntry(teamName, derivedSession, workingDir);
  if (entry?.session && entry.session === derivedSession) return entry.session;
  return derivedSession;
}

/**
 * Ensure a tmux session exists for teams.
 * Creates the session if it doesn't exist.
 */
async function ensureSession(sessionName: string, deps: TeamAutoSpawnDeps): Promise<string> {
  const existing = await deps.findSessionByName(sessionName);
  if (existing) return sessionName;

  const session = await deps.createSession(sessionName);
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
 * 2. A tmux window with the team name exists in the project session, AND
 * 3. The window's pane has a live process (or is within the 30s grace period)
 */
export async function isTeamActive(
  teamName: string,
  sessionName: string,
  deps: TeamAutoSpawnDeps = defaultDeps,
): Promise<boolean> {
  const config = await deps.loadConfig(teamName);
  if (!config) return false;

  const session = await deps.findSessionByName(sessionName);
  if (!session) return false;

  try {
    const windows = await deps.listWindows(sessionName);
    const sanitized = sanitizeTeamName(teamName);
    const matchingWindow = windows.find((w) => w.name === sanitized || w.name === teamName);
    if (!matchingWindow) return false;

    // Get the window's panes and check liveness
    const panes = await deps.listPanes(matchingWindow.id);
    if (panes.length === 0) return false;

    const paneId = panes[0].id;

    // Grace period: skip liveness check if team-lead was spawned < 30s ago
    const entry = await deps.getTeamLeadEntry(teamName, sessionName);
    if (entry?.startedAt) {
      const elapsed = deps.now() - new Date(entry.startedAt).getTime();
      if (elapsed < LIVENESS_GRACE_MS) return true;
    }

    // Check if the process in the pane is still alive
    return await deps.isPaneAlive(paneId);
  } catch {
    return false;
  }
}

/**
 * Ensure a team has an active Claude Code team-lead.
 *
 * 1. If team is already active (config + tmux window + live pane), returns immediately.
 * 2. If stale window exists (window present but pane dead), kills it and re-creates.
 * 3. Otherwise, creates native team structure + tmux window + launches Claude Code.
 *
 * @param teamName - The team name (will be sanitized for filesystem use)
 * @param workingDir - Working directory for the Claude Code session
 * @returns Result indicating whether the team was created or already existed
 */
export async function ensureTeamLead(
  teamName: string,
  workingDir: string,
  deps: TeamAutoSpawnDeps = defaultDeps,
): Promise<EnsureTeamLeadResult> {
  // Resolve session name: env override → workingDir-derived session → matching registry
  const sessionName = await resolveSession(teamName, workingDir, deps);

  // Fast path: team already active
  if (await isTeamActive(teamName, sessionName, deps)) {
    return { created: false, session: sessionName, window: sanitizeWindowName(teamName) };
  }

  // Check for stale window (window exists but pane is dead) and clean up
  const windowName = sanitizeWindowName(teamName);
  const existingSession = await deps.findSessionByName(sessionName);
  if (existingSession) {
    const windows = await deps.listWindows(sessionName);
    const sanitized = sanitizeTeamName(teamName);
    const staleWindow = windows.find((w) => w.name === sanitized || w.name === teamName || w.name === windowName);
    if (staleWindow) {
      try {
        await deps.executeTmux(`kill-window -t ${shellQuote(`${sessionName}:${staleWindow.name}`)}`);
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  // Create native team structure
  await deps.ensureNativeTeam(teamName, `Genie team: ${teamName}`, 'pending');
  await deps.registerNativeMember(teamName, {
    agentName: 'team-lead',
    agentType: 'general-purpose',
    color: 'blue',
    cwd: workingDir,
  });

  // Ensure tmux session exists
  const session = await ensureSession(sessionName, deps);

  // Create team window (sanitize dots — tmux interprets '.' as pane separator)
  const teamWindow = await deps.ensureTeamWindow(session, windowName, workingDir);

  // Save team-lead pane ID to agent registry
  await deps.saveTeamLeadEntry(teamName, teamWindow.paneId, session, windowName, workingDir);

  if (teamWindow.created) {
    // Launch Claude Code in the new window
    const systemPromptFile = getSystemPromptFile(workingDir, deps);
    const target = `${session}:${windowName}`;
    const cdCmd = `cd ${shellQuote(workingDir)}`;
    await deps.executeTmux(`send-keys -t ${shellQuote(target)} ${shellQuote(cdCmd)} Enter`);
    const cmd = deps.buildTeamLeadCommand(teamName, { systemPromptFile: systemPromptFile ?? undefined });
    await deps.executeTmux(`send-keys -t ${shellQuote(target)} ${shellQuote(cmd)} Enter`);
  }

  return { created: teamWindow.created, session, window: windowName };
}
