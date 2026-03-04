/**
 * Protocol Router Spawn Helper — extracted to avoid circular imports.
 *
 * Spawns a worker from a template, used by the protocol router for
 * auto-spawn on message delivery to dead/suspended workers.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as nativeTeams from './claude-native-teams.js';
import { buildLayoutCommand, resolveLayoutMode } from './mosaic-layout.js';
import {
  type ClaudeTeamColor,
  type SpawnParams,
  buildLaunchCommand,
  validateSpawnParams,
} from './provider-adapters.js';
import * as teamManager from './team-manager.js';
import * as registry from './worker-registry.js';
import type { WorkerTemplate } from './worker-registry.js';

const execAsync = promisify(exec);

async function resolveParentSession(repoPath: string, team: string): Promise<string> {
  const teamConfig = await teamManager.getTeam(repoPath, team);
  if (teamConfig?.nativeTeamParentSessionId) return teamConfig.nativeTeamParentSessionId;
  return (await nativeTeams.discoverClaudeSessionId()) ?? crypto.randomUUID();
}

function buildSpawnParams(
  template: WorkerTemplate,
  parentSessionId: string,
  spawnColor: ClaudeTeamColor | undefined,
  resumeSessionId?: string,
): SpawnParams {
  const isClaude = template.provider === 'claude';
  const params: SpawnParams = {
    provider: template.provider,
    team: template.team,
    role: template.role,
    skill: template.skill,
    extraArgs: template.extraArgs,
    sessionId: isClaude && !resumeSessionId ? crypto.randomUUID() : undefined,
    resume: isClaude ? resumeSessionId : undefined,
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
  resumeSessionId?: string,
): Promise<{ worker: registry.Worker; paneId: string; workerId: string }> {
  const repoPath = template.cwd ?? process.cwd();
  const team = template.team;

  const parentSessionId = await resolveParentSession(repoPath, team);
  await nativeTeams.ensureNativeTeam(team, `Genie team: ${team}`, parentSessionId);

  const spawnColor = await nativeTeams.assignColor(team);
  const params = buildSpawnParams(template, parentSessionId, spawnColor, resumeSessionId);
  const launch = buildLaunchCommand(validateSpawnParams(params));
  const fullCommand = buildFullCommand(launch);
  const workerId = await generateWorkerId(team, template.role);

  const { stdout } = await execAsync(`tmux split-window -d -P -F '#{pane_id}' ${fullCommand}`);
  const paneId = stdout.trim();

  try {
    await execAsync(`tmux ${buildLayoutCommand('genie:0', resolveLayoutMode())}`);
  } catch {
    /* best-effort */
  }

  const now = new Date().toISOString();
  const agentName = template.role ?? 'worker';
  const isClaude = template.provider === 'claude';

  const workerEntry: registry.Worker = {
    id: workerId,
    paneId,
    session: 'genie',
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
    claudeSessionId: resumeSessionId ?? params.sessionId,
    nativeTeamEnabled: isClaude,
    nativeAgentId: `${agentName}@${team}`,
    nativeColor: spawnColor,
    parentSessionId,
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
    text: `Worker ${agentName} (${template.provider}) auto-spawned${resumeSessionId ? ' with --resume' : ''}. Ready for tasks.`,
    summary: `${agentName} auto-spawned`,
    timestamp: now,
    color: spawnColor ?? 'blue',
    read: false,
  });

  return { worker: workerEntry, paneId, workerId };
}
