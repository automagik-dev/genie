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
import * as registry from './agent-registry.js';
import {
  ensureNativeTeamWithSessionId,
  loadConfig,
  registerNativeMember,
  resolveOrMintLeadSessionId,
  sanitizeTeamName,
} from './claude-native-teams.js';
import * as executorRegistry from './executor-registry.js';
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
 *
 * Resolution order:
 *   1. Current tmux session (caller is inside tmux)
 *   2. Team config `tmuxSessionName` (stored during team create)
 *   3. Create/find session named after team (last resort)
 */
async function ensureSession(teamName: string): Promise<string> {
  // If inside tmux, reuse the current session
  const current = await tmux.getCurrentSessionName();
  if (current) return current;

  // Check team config for stored session name
  const { getTeam } = await import('./team-manager.js');
  const teamConfig = await getTeam(teamName);
  if (teamConfig?.tmuxSessionName) {
    const existing = await tmux.findSessionByName(teamConfig.tmuxSessionName);
    if (existing) return teamConfig.tmuxSessionName;
  }

  // Fallback: atomically create session named after the team.
  // Uses new-session directly and catches "duplicate session" to eliminate TOCTOU race.
  const sessionName = sanitizeTeamName(teamName);
  try {
    await tmux.createSession(sessionName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // "duplicate session" means another process created it first — that's fine
    if (!message.includes('duplicate session')) {
      throw error;
    }
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
 * Check if a specific agent is alive (transport-aware).
 *
 * Used by inbox-watcher for per-recipient liveness checks. For tmux agents
 * we ask tmux directly; for SDK/omni/inline agents (synthetic paneId), we
 * consult `executors.state`. A plain `isPaneAlive` check misreports live
 * SDK recipients as dead — causing the watcher to misroute messages.
 *
 * @param agentName - Agent name or ID to look up in the registry
 * @returns true if the agent has a live pane or a live executor
 */
export async function isAgentAlive(agentName: string): Promise<boolean> {
  try {
    const { list } = await import('./agent-registry.js');
    const agents = await list();
    const match = agents.find((a) => a.id === agentName || a.role === agentName);
    if (!match?.paneId) return false;
    return executorRegistry.resolveWorkerLivenessByTransport(match);
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

  // Resolve the actual leader name from team config (never returns 'team-lead')
  const { resolveLeaderName } = await import('./team-manager.js');
  const leaderName = await resolveLeaderName(teamName);

  // Resolve a REAL Claude Code session UUID before we write the team config.
  //
  // If a prior JSONL for this team exists, we reuse its UUID and launch CC
  // via `--resume`. Otherwise we mint a fresh UUID and launch CC via
  // `--session-id` so the config and the CC process agree from the start.
  //
  // Fixes the ghost-approval deadlock (wish: fix-ghost-approval-p0).
  const { sessionId, shouldResume } = await resolveOrMintLeadSessionId(teamName, workingDir);

  // Create or heal native team structure. Upserts stale leadSessionId
  // (e.g. legacy "pending" literal) in place — no migration script needed.
  await ensureNativeTeamWithSessionId(teamName, `Genie team: ${teamName}`, sessionId, leaderName);
  await registerNativeMember(teamName, {
    agentName: leaderName,
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
    // Launch Claude Code in the new window.
    //
    // Always pass the resolved UUID. When `shouldResume` is true we emit
    // `--resume <uuid>` (NOT `--resume <teamName>`), which prevents CC from
    // re-running its own fuzzy JSONL title match and picking an unrelated
    // session. Gap B from trace-stale-resume (task #6).
    const systemPromptFile = getSystemPromptFile(workingDir);
    const target = `${session}:${windowName}`;
    const cdCmd = `cd ${shellQuote(workingDir)}`;
    await tmux.executeTmux(`send-keys -t ${shellQuote(target)} ${shellQuote(cdCmd)} Enter`);
    const cmd = buildTeamLeadCommand(teamName, {
      systemPromptFile: systemPromptFile ?? undefined,
      leaderName,
      sessionId,
      resume: shouldResume,
    });
    await tmux.executeTmux(`send-keys -t ${shellQuote(target)} ${shellQuote(cmd)} Enter`);

    // Create an executor row so downstream tooling (resume, session-sync,
    // observability) can track this team-lead the same way it tracks spawned
    // workers. Best-effort — lifecycle should not break if PG is unavailable.
    await recordTeamLeadExecutor({
      teamName,
      leaderName,
      session,
      windowName,
      windowId: teamWindow.windowId,
      paneId: teamWindow.paneId,
      sessionId,
      workingDir,
    }).catch(() => {
      /* best-effort */
    });
  }

  return { created: teamWindow.created, session, window: windowName };
}

/**
 * Create (or replace) the executor row tracking this team-lead.
 *
 * Terminates any prior active executor for the same agent identity first to
 * prevent stale rows from accumulating on repeated ensure calls.
 */
async function recordTeamLeadExecutor(opts: {
  teamName: string;
  leaderName: string;
  session: string;
  windowName: string;
  windowId?: string;
  paneId: string;
  sessionId: string;
  workingDir: string;
}): Promise<void> {
  const sanitizedTeam = sanitizeTeamName(opts.teamName);
  const agentIdentity = await registry.findOrCreateAgent(opts.leaderName, sanitizedTeam, opts.leaderName);
  await executorRegistry.terminateActiveExecutor(agentIdentity.id);

  let pid: number | null = null;
  try {
    const target = `${opts.session}:${opts.windowName}`;
    const pidStr = (await tmux.executeTmux(`display -t ${shellQuote(target)} -p '#{pane_pid}'`)).trim();
    const parsed = Number.parseInt(pidStr, 10);
    if (parsed > 0) pid = parsed;
  } catch {
    /* best-effort */
  }

  await executorRegistry.createAndLinkExecutor(agentIdentity.id, 'claude', 'tmux', {
    pid,
    tmuxSession: opts.session,
    tmuxPaneId: opts.paneId,
    tmuxWindow: opts.windowName,
    tmuxWindowId: opts.windowId ?? null,
    claudeSessionId: opts.sessionId,
    state: 'spawning',
    repoPath: opts.workingDir,
  });
}
