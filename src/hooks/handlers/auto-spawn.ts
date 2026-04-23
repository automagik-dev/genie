/**
 * Auto-Spawn Handler — PreToolUse:SendMessage
 *
 * When an agent sends a message to a recipient that doesn't have a live
 * tmux pane, this handler attempts to respawn them from their saved
 * template (created during the original `genie spawn`).
 *
 * Resolution order (directory-aware):
 *   1. Check worker registry for live pane → skip if alive
 *   2. Check agent directory for recipient identity
 *   3. Check saved templates → spawn from template
 *
 * Priority: 20 (runs after identity-inject)
 */

import type { HandlerResult, HookPayload } from '../types.js';

/** Build search names from recipient + directory entry for template matching. */
function buildSearchNames(
  recipient: string,
  dirEntry: { entry: { name: string; roles?: string[] } } | null,
): Set<string> {
  const names = new Set([recipient]);
  if (dirEntry) {
    names.add(dirEntry.entry.name);
    if (dirEntry.entry.roles) {
      for (const role of dirEntry.entry.roles) names.add(role);
    }
  }
  return names;
}

/** Build genie spawn CLI args from a saved template. */
function buildSpawnArgs(template: {
  provider: string;
  team: string;
  role?: string;
  skill?: string;
  cwd?: string;
  extraArgs?: string[];
}): string[] {
  const args = ['spawn', '--provider', template.provider, '--team', template.team];
  if (template.role) args.push('--role', template.role);
  if (template.skill) args.push('--skill', template.skill);
  if (template.cwd) args.push('--cwd', template.cwd);
  // Session resumption is handled by --resume via the stored session ID,
  // which is set automatically by the spawn command. No explicit flag needed here.
  if (template.extraArgs) args.push(...template.extraArgs);
  return args;
}

/** Check if the recipient is the team's actual leader (dynamic name, not 'team-lead' alias). */
async function isRecipientLeader(recipient: string, teamName: string): Promise<boolean> {
  try {
    const { getTeam } = await import('../../lib/team-manager.js');
    const config = await getTeam(teamName);
    return !!config?.leader && recipient === config.leader;
  } catch {
    return false;
  }
}

/** Extract the message recipient and team name, or null if auto-spawn should be skipped. */
function extractAutoSpawnTarget(payload: HookPayload): { recipient: string; teamName: string } | null {
  if (process.env.NODE_ENV === 'test' || process.env.BUN_ENV === 'test') return null;
  const input = payload.tool_input;
  if (!input || input.type !== 'message') return null;
  const recipient = input.recipient as string | undefined;
  if (!recipient) return null;
  const teamName = process.env.GENIE_TEAM ?? payload.team_name;
  if (!teamName) return null;
  if (recipient === 'team-lead') return null;
  return { recipient, teamName };
}

/** Find and execute a spawn template for the recipient. */
async function executeAutoSpawn(recipient: string, teamName: string): Promise<void> {
  const registryMod = await import('../../lib/agent-registry.js');
  const executorRegistryMod = await import('../../lib/executor-registry.js');
  const directoryMod = await import('../../lib/agent-directory.js');

  const agents = await registryMod.list();
  const existing = agents.find((a) => (a.role === recipient || a.id === recipient) && a.team === teamName);
  // Transport-aware liveness: a plain `isPaneAlive` check treats live SDK/
  // omni/inline recipients (synthetic paneIds like 'sdk', '', 'inline') as
  // dead and triggers a duplicate spawn on every message. Dispatch by
  // paneId shape so non-tmux transports consult `executors.state` instead.
  if (existing && (await executorRegistryMod.resolveWorkerLivenessByTransport(existing))) return;

  const dirEntry = await directoryMod.resolve(recipient);
  const templates = await registryMod.listTemplates();
  const searchNames = buildSearchNames(recipient, dirEntry);

  const template = templates.find((t) => {
    if (t.team !== teamName) return false;
    return [...searchNames].some((q) => t.id === q || t.role === q);
  });

  if (!template) {
    if (dirEntry) {
      console.error(
        `[genie-hook] Agent "${recipient}" is registered in directory but has no spawn template in team "${teamName}".`,
      );
    }
    return;
  }

  const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
  spawnSync('genie', buildSpawnArgs(template), {
    timeout: 10_000,
    stdio: 'ignore',
    env: { ...process.env, GENIE_TEAM: teamName },
  });

  console.error(`[genie-hook] Auto-spawned "${recipient}" in team "${teamName}"`);
}

export async function autoSpawn(payload: HookPayload): Promise<HandlerResult> {
  const target = extractAutoSpawnTarget(payload);
  if (!target) return;

  const { recipient, teamName } = target;
  if (await isRecipientLeader(recipient, teamName)) return;

  try {
    await executeAutoSpawn(recipient, teamName);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[genie-hook] Auto-spawn failed for "${recipient}": ${msg}`);
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: `auto-spawn warning: failed to spawn "${recipient}": ${msg}`,
      },
    };
  }
}
