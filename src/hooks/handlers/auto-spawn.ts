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

export async function autoSpawn(payload: HookPayload): Promise<HandlerResult> {
  const input = payload.tool_input;
  if (!input) return;

  // Only handle direct messages (not broadcasts, shutdown, etc.)
  if (input.type !== 'message') return;

  const recipient = input.recipient as string | undefined;
  if (!recipient) return;

  // Don't auto-spawn team-lead (it's the orchestrator, always running)
  if (recipient === 'team-lead') return;

  const teamName = process.env.GENIE_TEAM ?? payload.team_name;
  if (!teamName) return;

  try {
    // Lazy-import to avoid pulling heavy deps at dispatch startup
    const registryMod = await import('../../lib/agent-registry.js');
    const tmuxMod = await import('../../lib/tmux.js');
    const directoryMod = await import('../../lib/agent-directory.js');

    // Check if recipient has a live pane
    const agents = await registryMod.list();
    const existing = agents.find((a) => (a.role === recipient || a.id === recipient) && a.team === teamName);

    if (existing && (await tmuxMod.isPaneAlive(existing.paneId))) {
      // Agent is alive — nothing to do
      return;
    }

    // Check agent directory for recipient identity (directory-first)
    const dirEntry = await directoryMod.resolve(recipient);

    // Check for a saved template to respawn from
    const templates = await registryMod.listTemplates();

    // Build search candidates: recipient name + directory entry info
    const searchNames = new Set([recipient]);
    if (dirEntry) {
      searchNames.add(dirEntry.entry.name);
      if (dirEntry.entry.roles) {
        for (const role of dirEntry.entry.roles) searchNames.add(role);
      }
    }

    const template = templates.find((t) => {
      if (t.team !== teamName) return false;
      return [...searchNames].some((q) => t.id === q || t.role === q);
    });

    if (!template) {
      if (dirEntry) {
        // Agent is known but has no spawn template — log for debugging
        console.error(
          `[genie-hook] Agent "${recipient}" is registered in directory but has no spawn template in team "${teamName}".`,
        );
      }
      // No template — can't auto-spawn, let the message go through anyway
      // (CC will show "recipient not found" natively)
      return;
    }

    // Respawn via genie spawn (non-blocking fork)
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const args = ['spawn', '--provider', template.provider, '--team', template.team];
    if (template.role) args.push('--role', template.role);
    if (template.skill) args.push('--skill', template.skill);
    if (template.cwd) args.push('--cwd', template.cwd);
    if (template.lastSessionId) args.push('--resume', template.lastSessionId);
    if (template.extraArgs) args.push(...template.extraArgs);

    // Run synchronously with short timeout — we need the pane up before
    // CC delivers the message. Uses spawnSync with argv array (no shell)
    // to prevent command injection.
    spawnSync('genie', args, {
      timeout: 10_000,
      stdio: 'ignore',
      env: { ...process.env, GENIE_TEAM: teamName },
    });

    console.error(`[genie-hook] Auto-spawned "${recipient}" in team "${teamName}"`);
  } catch (err) {
    // Don't block the message on spawn failure — log and allow
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[genie-hook] Auto-spawn failed for "${recipient}": ${msg}`);
  }

  // Always allow the message through
  return;
}
