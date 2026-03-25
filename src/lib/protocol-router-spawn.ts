/**
 * Protocol Router Spawn Helper — extracted to avoid circular imports.
 *
 * Spawns a worker from a template, used by the protocol router for
 * auto-spawn on message delivery to dead/suspended workers.
 *
 * On respawn, injects resume context (wish state, group info, git log)
 * so agents can pick up where they left off without conversation history.
 */

import { exec } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as registry from './agent-registry.js';
import type { WorkerTemplate } from './agent-registry.js';
import * as nativeTeams from './claude-native-teams.js';
import * as mailbox from './mailbox.js';
import { buildLayoutCommand, resolveLayoutMode } from './mosaic-layout.js';
import {
  type ClaudeTeamColor,
  type SpawnParams,
  buildLaunchCommand,
  validateSpawnParams,
} from './provider-adapters.js';
import * as teamManager from './team-manager.js';
import { applyPaneColor, ensureTeamWindow, getCurrentSessionName, listWindows } from './tmux.js';
import * as wishState from './wish-state.js';

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
  resumeSessionId?: string,
): SpawnParams {
  const isClaude = template.provider === 'claude';
  const sessionName = template.role ? `${template.team}-${template.role}` : undefined;
  // Generate a new session ID for fresh spawns, or use stored ID for resume
  const newSessionId = isClaude && !resumeSessionId ? crypto.randomUUID() : undefined;
  const params: SpawnParams = {
    provider: template.provider,
    team: template.team,
    role: template.role,
    skill: template.skill,
    extraArgs: template.extraArgs,
    sessionId: newSessionId,
    resume: isClaude ? resumeSessionId : undefined,
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

/** Resolve target window and spawn a pane, returning pane ID and window info. */
async function spawnPaneInSession(
  session: string,
  team: string,
  repoPath: string,
  fullCommand: string,
): Promise<{ paneId: string; teamWindow: { windowId: string; windowName: string } | null }> {
  let teamWindow: { windowId: string; windowName: string } | null = null;
  try {
    teamWindow = await ensureTeamWindow(session, team, repoPath);
  } catch {
    /* best-effort — falls back to current pane */
  }

  const splitTarget = teamWindow ? `-t '${teamWindow.windowId}'` : '';
  // Wrap fullCommand in shell quotes so it survives the outer-shell → tmux → inner-shell pipeline.
  const escapedCmd = fullCommand.replace(/'/g, "'\\''");
  const { stdout } = await execAsync(`tmux split-window -d ${splitTarget} -P -F '#{pane_id}' '${escapedCmd}'`);
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

  return { paneId, teamWindow };
}

export async function spawnWorkerFromTemplate(
  template: WorkerTemplate,
  resumeSessionId?: string,
): Promise<{ worker: registry.Agent; paneId: string; workerId: string }> {
  const repoPath = template.cwd ?? process.cwd();
  const team = template.team;

  const parentSessionId = await resolveParentSession(repoPath, team);
  await nativeTeams.ensureNativeTeam(team, `Genie team: ${team}`, parentSessionId);

  const spawnColor = await nativeTeams.assignColor(team);
  const params = buildSpawnParams(template, parentSessionId, spawnColor, resumeSessionId);
  const launch = buildLaunchCommand(validateSpawnParams(params));
  const fullCommand = buildFullCommand(launch);
  const workerId = await generateWorkerId(team, template.role);

  const session = (await getCurrentSessionName()) ?? team;
  const { paneId, teamWindow } = await spawnPaneInSession(session, team, repoPath, fullCommand);

  const now = new Date().toISOString();
  const agentName = template.role ?? 'worker';
  const isClaude = template.provider === 'claude';
  const effectiveSessionId = resumeSessionId ?? params.sessionId;

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
    claudeSessionId: effectiveSessionId,
    nativeTeamEnabled: isClaude,
    nativeAgentId: `${agentName}@${team}`,
    nativeColor: spawnColor,
    parentSessionId,
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
    text: `Worker ${agentName} (${template.provider}) auto-spawned${resumeSessionId ? ' with --resume' : ''}. Ready for tasks.`,
    summary: `${agentName} auto-spawned`,
    timestamp: now,
    color: spawnColor ?? 'blue',
    read: false,
  });

  if (spawnColor) {
    await applyPaneColor(paneId, spawnColor, teamWindow?.windowId);
  }

  // Inject resume context if agent was working on a wish group
  await injectResumeContext(repoPath, workerId, agentName, team);

  return { worker: workerEntry, paneId, workerId };
}

// ============================================================================
// Resume Context Injection
// ============================================================================

/**
 * Extract a group section from WISH.md content by group name.
 * Matches `### Group <name>:` headings, returns content until next group or HR.
 */
function extractGroupSection(content: string, groupName: string): string | null {
  const escaped = groupName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^### Group ${escaped}:`, 'm');
  const match = content.match(pattern);
  if (!match || match.index === undefined) return null;

  const start = match.index;
  const afterHeading = content.slice(start);
  const nextBoundary = afterHeading.slice(1).search(/^### Group \d|^---$/m);
  const end = nextBoundary !== -1 ? start + 1 + nextBoundary : content.length;
  return content.slice(start, end).trim();
}

/**
 * Get last N git commits on the current branch.
 * Best-effort — returns empty string on failure.
 */
async function getRecentGitLog(repoPath: string, count = 3): Promise<string> {
  try {
    const { stdout } = await execAsync(`git -C '${repoPath}' log --oneline -${count} 2>/dev/null`);
    return stdout.trim();
  } catch {
    return '';
  }
}

/**
 * Get uncommitted changes (staged + unstaged) as a short summary.
 * Best-effort — returns empty string on failure.
 */
async function getGitStatus(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`git -C '${repoPath}' status --short 2>/dev/null`);
    return stdout.trim();
  } catch {
    return '';
  }
}

/**
 * Build and deliver resume context to a respawned agent.
 *
 * Queries PG for any in_progress group assigned to this worker's
 * role+team, then builds a context prompt with wish slug, group info,
 * group section from WISH.md, and recent git history.
 *
 * Delivered via mailbox as the FIRST message before any task prompt,
 * so the agent has immediate context even without conversation history.
 */
export async function injectResumeContext(
  repoPath: string,
  workerId: string,
  agentName: string,
  _team: string,
): Promise<void> {
  try {
    // Query PG for any in_progress group assigned to this agent
    const match =
      (await wishState.findAnyGroupByAssignee(workerId, repoPath)) ??
      (await wishState.findAnyGroupByAssignee(agentName, repoPath));
    if (!match) return;

    const { slug, groupName, group } = match;

    // Build resume context
    const wishPath = join(repoPath, '.genie', 'wishes', slug, 'WISH.md');
    let groupSection = '';
    try {
      const wishContent = await readFile(wishPath, 'utf-8');
      groupSection = extractGroupSection(wishContent, groupName) ?? '';
    } catch {
      /* WISH.md may not exist */
    }

    const gitLog = await getRecentGitLog(repoPath);
    const gitStatus = await getGitStatus(repoPath);

    const resumePrompt = [
      `RESUME CONTEXT: You were working on wish "${slug}", group "${groupName}".`,
      `Status: ${group.status}. Started at: ${group.startedAt ?? 'unknown'}.`,
      `Wish file: .genie/wishes/${slug}/WISH.md`,
      '',
      groupSection ? `Group section:\n${groupSection}` : '',
      '',
      gitLog ? `Last git log:\n${gitLog}` : '',
      '',
      gitStatus ? `Uncommitted changes:\n${gitStatus}` : '',
      '',
      'Pick up where you left off. Read the wish file for full context.',
    ]
      .filter(Boolean)
      .join('\n');

    await mailbox.send(repoPath, 'genie', workerId, resumePrompt);
  } catch {
    /* Best-effort — resume context is not critical */
  }
}
