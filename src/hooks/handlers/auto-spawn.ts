/**
 * Auto-Spawn Handler — PreToolUse:SendMessage
 *
 * When an agent sends a message to a recipient that doesn't have a live
 * tmux pane, this handler attempts to respawn them from their saved
 * template (created during the original `genie agent spawn`).
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

    // Check if recipient has a live pane
    const agents = await registryMod.list();
    const existing = agents.find((a) => (a.role === recipient || a.id === recipient) && a.team === teamName);

    if (existing && (await tmuxMod.isPaneAlive(existing.paneId))) {
      // Agent is alive — nothing to do
      return;
    }

    // Check for a saved template to respawn from
    const templates = await registryMod.listTemplates();
    const template = templates.find((t) => (t.role === recipient || t.id === recipient) && t.team === teamName);

    if (!template) {
      // No template — can't auto-spawn, let the message go through anyway
      // (CC will show "recipient not found" natively)
      return;
    }

    // Respawn via genie agent spawn (non-blocking fork)
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const args = ['agent', 'spawn', '--provider', template.provider, '--team', template.team];
    if (template.role) args.push('--role', template.role);
    if (template.skill) args.push('--skill', template.skill);
    if (template.cwd) args.push('--cwd', template.cwd);
    if (template.lastSessionId) args.push('--resume', template.lastSessionId);

    // Run synchronously with short timeout — we need the pane up before
    // CC delivers the message
    execFileSync('genie', args, {
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
