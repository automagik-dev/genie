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

export async function autoSpawn(payload: HookPayload): Promise<HandlerResult> {
  // Skip in test environment — PG/tmux queries cause timeouts under full suite load
  if (process.env.NODE_ENV === 'test' || process.env.BUN_ENV === 'test') return;

  const input = payload.tool_input;
  if (!input || input.type !== 'message') return;

  const recipient = input.recipient as string | undefined;
  if (!recipient) return;

  const teamName = process.env.GENIE_TEAM ?? payload.team_name;
  if (!teamName) return;

  // Skip auto-spawn for the team's leader (resolved dynamically, never hardcoded)
  if (await isRecipientLeader(recipient, teamName)) return;

  try {
    const registryMod = await import('../../lib/agent-registry.js');
    const tmuxMod = await import('../../lib/tmux.js');
    const directoryMod = await import('../../lib/agent-directory.js');

    const agents = await registryMod.list();
    const existing = agents.find((a) => (a.role === recipient || a.id === recipient) && a.team === teamName);
    if (existing && (await tmuxMod.isPaneAlive(existing.paneId))) return;

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
