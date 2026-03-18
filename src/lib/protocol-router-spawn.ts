/**
 * Protocol Router Spawn Helper — extracted to avoid circular imports.
 *
 * Spawns a worker from a template, used by the protocol router for
 * auto-spawn on message delivery to dead/suspended workers.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as registry from './agent-registry.js';
import type { WorkerTemplate } from './agent-registry.js';
import * as nativeTeams from './claude-native-teams.js';
import { buildLayoutCommand, resolveLayoutMode } from './mosaic-layout.js';
import {
  type ClaudeTeamColor,
  type SpawnParams,
  buildLaunchCommand,
  validateSpawnParams,
} from './provider-adapters.js';
import * as teamManager from './team-manager.js';
import { applyPaneColor, ensureTeamWindow, getCurrentSessionName, listWindows } from './tmux.js';

const execAsync = promisify(exec);

async function resolveParentSession(_repoPath: string, team: string): Promise<string> {
  const teamConfig = await teamManager.getTeam(team);
  if (teamConfig?.nativeTeamParentSessionId) return teamConfig.nativeTeamParentSessionId;
  return (await nativeTeams.discoverClaudeSessionId()) ?? `genie-${team}`;
}

function buildSpawnParams(
  template: WorkerTemplate,
  parentSessionId: string,
  spawnColor: ClaudeTeamColor | undefined,
  continueName?: string,
): SpawnParams {
  const isClaude = template.provider === 'claude';
  const sessionName = template.role ? `${template.team}-${template.role}` : undefined;
  const params: SpawnParams = {
    provider: template.provider,
    team: template.team,
    role: template.role,
    skill: template.skill,
    extraArgs: template.extraArgs,
    sessionId: undefined,
    resume: isClaude ? continueName : undefined,
    name: sessionName,
  };
  if (isClaude) {
    params.nativeTeam = {
      enabled: true,
      parentSessionId,
      color: spawnColor,
      agentType: template.role ?? 'general-purpose',
      agentName: template.role,
    };
  }
  return params;
}

function buildFullCommand(launch: { command: string; env?: Record<string, string> }): string {
  if (launch.env && Object.keys(launch.env).length > 0) {
    const envArgs = Object.entries(launch.env)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    return `env ${envArgs} ${launch.command}`;
  }
  return launch.command;
}

async function generateWorkerId(team: string, role?: string): Promise<string> {
  const base = role ? `${team}-${role}` : team;
  const existing = await registry.list();
  return existing.some((w) => w.id === base) ? `${base}-${crypto.randomUUID().slice(0, 8)}` : base;
}

export async function spawnWorkerFromTemplate(
  template: WorkerTemplate,
  continueName?: string,
): Promise<{ worker: registry.Agent; paneId: string; workerId: string }> {
  const repoPath = template.cwd ?? process.cwd();
  const team = template.team;

  const parentSessionId = await resolveParentSession(repoPath, team);
  await nativeTeams.ensureNativeTeam(team, `Genie team: ${team}`, parentSessionId);

  const spawnColor = await nativeTeams.assignColor(team);
  const params = buildSpawnParams(template, parentSessionId, spawnColor, continueName);
  const launch = buildLaunchCommand(validateSpawnParams(params));
  const fullCommand = buildFullCommand(launch);
  const workerId = await generateWorkerId(team, template.role);

  // Resolve target window: if team is set, ensure a dedicated team window
  const session = (await getCurrentSessionName()) ?? team;
  let teamWindow: { windowId: string; windowName: string } | null = null;
  try {
    teamWindow = await ensureTeamWindow(session, team, repoPath);
  } catch {
    /* best-effort — falls back to current pane */
  }

  const splitTarget = teamWindow ? `-t '${teamWindow.windowId}'` : '';
  const { stdout } = await execAsync(`tmux split-window -d ${splitTarget} -P -F '#{pane_id}' ${fullCommand}`);
  const paneId = stdout.trim();

  let layoutTarget = `${session}:${teamWindow?.windowName ?? ''}`;
  if (!teamWindow) {
    const wins = await listWindows(session);
    layoutTarget = wins[0] ? wins[0].id : `${session}:`;
  }
  try {
    await execAsync(`tmux ${buildLayoutCommand(layoutTarget, resolveLayoutMode())}`);
  } catch {
    /* best-effort */
  }

  const now = new Date().toISOString();
  const agentName = template.role ?? 'worker';
  const isClaude = template.provider === 'claude';

  const workerEntry: registry.Agent = {
    id: workerId,
    paneId,
    session,
    provider: template.provider,
    transport: 'tmux',
    role: template.role,
    skill: template.skill,
    team,
    worktree: null,
    startedAt: now,
    state: 'spawning',
    lastStateChange: now,
    repoPath,
    claudeSessionId: params.sessionId,
    nativeTeamEnabled: isClaude,
    nativeAgentId: `${agentName}@${team}`,
    nativeColor: spawnColor,
    parentSessionId,
    // Team window tracking
    window: teamWindow?.windowName,
    windowName: teamWindow?.windowName,
    windowId: teamWindow?.windowId,
  };

  await registry.register(workerEntry);
  await nativeTeams.registerNativeMember(team, {
    agentName,
    agentType: template.role ?? 'general-purpose',
    color: spawnColor ?? 'blue',
    tmuxPaneId: paneId,
    cwd: repoPath,
  });
  await nativeTeams.writeNativeInbox(team, 'team-lead', {
    from: agentName,
    text: `Worker ${agentName} (${template.provider}) auto-spawned${continueName ? ' with --continue' : ''}. Ready for tasks.`,
    summary: `${agentName} auto-spawned`,
    timestamp: now,
    color: spawnColor ?? 'blue',
    read: false,
  });

  // Apply agent color to tmux pane border (focus-driven)
  if (spawnColor) {
    await applyPaneColor(paneId, spawnColor, teamWindow?.windowId);
  }

  return { worker: workerEntry, paneId, workerId };
}
