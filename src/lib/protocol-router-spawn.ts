/**
 * Protocol Router Spawn Helper — extracted to avoid circular imports.
 *
 * Spawns a worker from a template, used by the protocol router for
 * auto-spawn on message delivery to dead/suspended workers.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as nativeTeams from './claude-native-teams.js';
import { resolveLayoutMode, buildLayoutCommand } from './mosaic-layout.js';
import {
  type ProviderName,
  type SpawnParams,
  buildLaunchCommand,
  validateSpawnParams,
} from './provider-adapters.js';
import * as teamManager from './team-manager.js';
import * as registry from './worker-registry.js';
import type { WorkerTemplate } from './worker-registry.js';

const execAsync = promisify(exec);

export async function spawnWorkerFromTemplate(
  template: WorkerTemplate,
  resumeSessionId?: string,
): Promise<{ worker: registry.Worker; paneId: string; workerId: string }> {
  const repoPath = template.cwd ?? process.cwd();
  const team = template.team;

  const teamConfig = await teamManager.getTeam(repoPath, team);
  let parentSessionId = teamConfig?.nativeTeamParentSessionId;
  if (!parentSessionId) {
    parentSessionId = (await nativeTeams.discoverClaudeSessionId()) ?? crypto.randomUUID();
  }

  await nativeTeams.ensureNativeTeam(team, `Genie team: ${team}`, parentSessionId);

  const spawnColor = await nativeTeams.assignColor(team);

  const isClaude = template.provider === 'claude';
  const claudeSessionId = isClaude ? (resumeSessionId ? undefined : crypto.randomUUID()) : undefined;

  const params: SpawnParams = {
    provider: template.provider,
    team,
    role: template.role,
    skill: template.skill,
    extraArgs: template.extraArgs,
    sessionId: claudeSessionId,
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

  const validated = validateSpawnParams(params);
  const launch = buildLaunchCommand(validated);

  let fullCommand = launch.command;
  if (launch.env && Object.keys(launch.env).length > 0) {
    const envArgs = Object.entries(launch.env)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    fullCommand = `env ${envArgs} ${launch.command}`;
  }

  // Generate worker ID
  const base = template.role ? `${team}-${template.role}` : team;
  const existing = await registry.list();
  let workerId = base;
  if (existing.some((w) => w.id === base)) {
    workerId = `${base}-${crypto.randomUUID().slice(0, 8)}`;
  }

  const { stdout } = await execAsync(`tmux split-window -d -P -F '#{pane_id}' ${fullCommand}`);
  const paneId = stdout.trim();

  try {
    const layoutMode = resolveLayoutMode();
    await execAsync(`tmux ${buildLayoutCommand('genie:0', layoutMode)}`);
  } catch {
    /* best-effort */
  }

  const now = new Date().toISOString();
  const agentName = template.role ?? 'worker';

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
    claudeSessionId: resumeSessionId ?? claudeSessionId,
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
