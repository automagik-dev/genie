/**
 * ClaudeCodeOmniExecutor -- tmux-based IExecutor implementation.
 *
 * Spawns Claude Code processes in tmux windows (one per chat),
 * delivers follow-up messages via genie's PG mailbox pipeline
 * (mailbox.send → PG LISTEN/NOTIFY → scheduler → deliverToPane),
 * and injects env vars so agents can call `omni say/done` directly.
 */

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as directory from '../../lib/agent-directory.js';
import type { DirectoryEntry } from '../../lib/agent-directory.js';
import * as agents from '../../lib/agent-registry.js';
import * as registry from '../../lib/executor-registry.js';
import * as mailbox from '../../lib/mailbox.js';
import { buildLaunchCommand } from '../../lib/provider-adapters.js';
import type { SpawnParams } from '../../lib/provider-adapters.js';
import { shellQuote } from '../../lib/team-lead-command.js';
import { ensureTeamWindow, executeTmux, isPaneAlive, isPaneProcessRunning, killWindow } from '../../lib/tmux.js';
import type { ExecutorSession, IExecutor, OmniMessage, SafePgCallFn } from '../executor.js';
import { buildTurnBasedPrompt } from './turn-based-prompt.js';

interface TmuxSessionState {
  executorId: string | null;
  /** Agent ID in genie's agents table (for mailbox delivery). */
  agentId: string | null;
  /** Agent repo/working directory (for mailbox repoPath). */
  repoPath: string | null;
}

/**
 * Sanitize a string for use as tmux window name and inbox filename.
 * Strips unsafe characters, truncates to 30 chars.
 */
function safeName(raw: string, maxLen = 30): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, maxLen) || 'unknown';
}

/**
 * Convert a chat JID into a human-readable, path-safe tmux window name.
 *
 * MUST be deterministic from chatId alone — senderName changes per message
 * in groups, so it cannot be part of the key. The optional chatName is
 * resolved once at spawn time from omni's chat database.
 *
 * Uses `-` separator (not `/`) so the name is safe as both a tmux window
 * name AND a filename component in the Claude Code team inbox path.
 *
 * Formats:
 *   5512982298888@s.whatsapp.net  → wa-5512982298888
 *   120363422699972298@g.us       → grp-NMSTXleadership (if chatName) or grp-120363422699972298
 *   54958418317348@lid            → lid-54958418317348
 *   other                         → chat-<sanitized prefix>
 */
export function sanitizeWindowName(chatId: string, chatName?: string): string {
  // WhatsApp DM: number@s.whatsapp.net — always use phone number
  const whatsappDm = chatId.match(/^(\d+)@s\.whatsapp\.net$/);
  if (whatsappDm) return `wa-${whatsappDm[1]}`;

  // WhatsApp group: id@g.us — use chatName if available
  const whatsappGroup = chatId.match(/^(\d+)@g\.us$/);
  if (whatsappGroup) return `grp-${chatName ? safeName(chatName) : whatsappGroup[1]}`;

  // LID format: id@lid — use chatName (contact name) if available
  const lid = chatId.match(/^(\d+)@lid$/);
  if (lid) return chatName ? `wa-${safeName(chatName)}` : `lid-${lid[1]}`;

  // Fallback: sanitize for tmux and file paths (no special chars)
  return `chat-${safeName(chatId)}`;
}

/**
 * Look up the chat/contact name from omni API for human-readable window naming.
 * Queries GET /api/v2/chats?externalId=<jid> — returns the chat name.
 * Returns null if lookup fails (best-effort, never blocks spawn).
 */
async function lookupChatName(chatId: string, _instanceId: string): Promise<string | null> {
  try {
    const configPath = join(homedir(), '.omni', 'config.json');
    const { readFileSync } = await import('node:fs');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const apiUrl = config.apiUrl || 'http://localhost:8882';
    const apiKey = config.apiKey || '';
    if (!apiKey) return null;

    const url = `${apiUrl}/api/v2/chats?externalId=${encodeURIComponent(chatId)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    // API returns { items: [...] } at root (no data wrapper)
    const body = (await res.json()) as { items?: { name?: string; externalId?: string }[] };
    // Find exact match by externalId since the API may return multiple results
    const match = body.items?.find((c) => c.externalId === chatId) ?? body.items?.[0];
    return match?.name || null;
  } catch {
    return null;
  }
}

/**
 * Build SpawnParams from omni bridge context so we can delegate to buildLaunchCommand().
 */
export function buildOmniSpawnParams(
  agentName: string,
  chatId: string,
  entry: DirectoryEntry,
  env: Record<string, string>,
  initialMessage?: string,
): SpawnParams {
  const instanceId = env.OMNI_INSTANCE ?? '';
  const senderName = env.OMNI_SENDER_NAME ?? 'whatsapp-user';
  const turnContext = buildTurnBasedPrompt(senderName, instanceId, chatId);

  // Turn instructions go in the initial prompt (before the user's message),
  // NOT in the system prompt. System prompt = agent identity (AGENTS.md).
  // Turn context = operational instructions for this specific interaction.
  const fullInitialPrompt = initialMessage ? `${turnContext}\n\n---\n\n${initialMessage}` : turnContext;

  // Pass agent permissions through to Claude Code via --settings so the tmux
  // executor honors AGENTS.md frontmatter permissions. Without this, WhatsApp
  // turn agents run under bypassPermissions with zero Bash-level enforcement,
  // defeating the unified per-agent permission system.
  const permissions =
    entry.permissions?.allow?.length || entry.permissions?.deny?.length
      ? { allow: entry.permissions.allow, deny: entry.permissions.deny }
      : undefined;

  return {
    provider: (entry.provider as SpawnParams['provider']) ?? 'claude',
    team: agentName,
    role: agentName,
    sessionId: randomUUID(),
    model: entry.model,
    promptMode: entry.promptMode,
    systemPromptFile: join(entry.dir, 'AGENTS.md'),
    initialPrompt: fullInitialPrompt,
    skipHooks: true,
    permissions,
    disallowedTools: entry.disallowedTools,
    nativeTeam: {
      enabled: true,
      agentName,
      color: (entry.color as 'blue' | undefined) ?? undefined,
    },
  };
}

export class ClaudeCodeOmniExecutor implements IExecutor {
  private sessions = new Map<string, TmuxSessionState>();
  private safePgCall: SafePgCallFn | null = null;

  setSafePgCall(fn: SafePgCallFn): void {
    this.safePgCall = fn;
  }

  setNatsPublish(_fn: import('../executor.js').NatsPublishFn): void {
    // No-op: tmux executor replies via tmux pane, not NATS
  }

  async injectNudge(session: ExecutorSession, text: string): Promise<void> {
    const paneId = session.tmux?.paneId;
    if (!paneId) return;
    const nudgeText = `[system] ${text}`;
    await executeTmux(`send-keys -t '${paneId}' ${shellQuote(nudgeText)} Enter`);
  }

  async spawn(
    agentName: string,
    chatId: string,
    env: Record<string, string>,
    initialMessage?: string,
  ): Promise<ExecutorSession> {
    const resolved = await directory.resolve(agentName);
    if (!resolved) throw new Error(`Agent "${agentName}" not found in genie directory`);

    const entry = resolved.entry;
    const tmuxSession = agentName;
    const chatName = await lookupChatName(chatId, env.OMNI_INSTANCE ?? '');
    const windowName = sanitizeWindowName(chatId, chatName ?? undefined);
    const { paneId, created } = await ensureTeamWindow(tmuxSession, windowName, entry.dir);

    if (created) {
      const omniEnv: Record<string, string> = { ...env, GENIE_OMNI_CHAT_ID: chatId, GENIE_OMNI_AGENT: agentName };
      const params = buildOmniSpawnParams(agentName, chatId, entry, omniEnv, initialMessage);
      const launch = buildLaunchCommand(params);

      // Merge omni-specific env vars with those produced by buildLaunchCommand
      const allEnv = { ...omniEnv, ...launch.env };
      const envPrefix = Object.entries(allEnv)
        .map(([k, v]) => `${k}=${shellQuote(v)}`)
        .join(' ');
      const cmd = envPrefix ? `${envPrefix} ${launch.command}` : launch.command;
      await executeTmux(`send-keys -t '${paneId}' ${shellQuote(cmd)} Enter`);
    }

    const sessionKey = `${agentName}:${chatId}`;
    const registration = await this.registerInWorldA(
      agentName,
      chatId,
      env.OMNI_INSTANCE ?? '',
      tmuxSession,
      windowName,
      paneId,
      entry.dir,
    );
    this.sessions.set(sessionKey, {
      executorId: registration?.executorId ?? null,
      agentId: registration?.agentId ?? null,
      repoPath: entry.dir,
    });
    if (registration?.executorId) await this.updateState(registration.executorId, 'running', chatId);

    const now = Date.now();
    return {
      id: sessionKey,
      agentName,
      chatId,
      executorType: 'tmux' as const,
      createdAt: now,
      lastActivityAt: now,
      tmux: { session: tmuxSession, window: windowName, paneId },
    };
  }

  private async registerInWorldA(
    agentName: string,
    chatId: string,
    instanceId: string,
    tmuxSession: string,
    tmuxWindow: string,
    tmuxPaneId: string,
    repoPath: string,
  ): Promise<{ executorId: string; agentId: string } | null> {
    if (!this.safePgCall) return null;
    const agent = await this.safePgCall(
      'tmux-find-or-create-agent',
      () => agents.findOrCreateAgent(`${agentName}:${chatId}`, 'omni', 'omni'),
      null,
      { chatId },
    );
    if (!agent) return null;

    // Update agent record with pane_id and repo_path so the scheduler daemon's
    // deliverToPane() (via PG LISTEN/NOTIFY) can resolve this agent for mailbox delivery.
    await this.safePgCall(
      'tmux-update-agent-pane',
      async () => {
        const sql = await import('../../lib/db.js').then((m) => m.getConnection());
        await sql`
          UPDATE agents
          SET pane_id = ${tmuxPaneId},
              session = ${tmuxSession},
              repo_path = ${repoPath},
              window_name = ${tmuxWindow},
              state = 'idle',
              last_state_change = now()
          WHERE id = ${agent.id}
        `;
      },
      undefined,
      { chatId },
    );

    const executor = await this.safePgCall(
      'tmux-create-executor',
      () =>
        registry.createAndLinkExecutor(agent.id, 'claude', 'tmux', {
          tmuxSession,
          tmuxWindow,
          tmuxPaneId,
          tmuxWindowId: null,
          metadata: { source: 'omni', chat_id: chatId, instance_id: instanceId },
        }),
      null,
      { chatId },
    );
    return executor ? { executorId: executor.id, agentId: agent.id } : null;
  }

  private async updateState(executorId: string, state: 'running' | 'working' | 'idle', chatId: string): Promise<void> {
    if (!this.safePgCall) return;
    await this.safePgCall(
      'tmux-update-executor-state',
      () => registry.updateExecutorState(executorId, state),
      undefined,
      { executorId, chatId },
    );
  }

  async deliver(session: ExecutorSession, message: OmniMessage): Promise<void> {
    const state = this.sessions.get(session.id);
    if (state?.executorId) await this.updateState(state.executorId, 'working', session.chatId);

    // Build turn context + user message for the follow-up turn
    const senderName = message.sender || 'whatsapp-user';
    const turnContext = buildTurnBasedPrompt(senderName, message.instanceId, session.chatId);
    const body = `${turnContext}\n\n---\n\n[${senderName}]: ${message.content}`;

    // Deliver via genie's PG mailbox pipeline:
    //   mailbox.send() → PG INSERT + NOTIFY → scheduler daemon → deliverToPane() → tmux send-keys
    // This provides: durability, observability (runtime_events), retry on missed NOTIFY (30s poll),
    // and delivery confirmation (delivered_at timestamp).
    const agentId = state?.agentId;
    const repoPath = state?.repoPath;

    if (agentId && repoPath) {
      try {
        await mailbox.send(repoPath, `omni:${senderName}`, agentId, body);
      } catch (err) {
        console.error(`[claude-code] mailbox.send failed for ${session.id}:`, err instanceof Error ? err.message : err);
      }
    } else {
      console.error(`[claude-code] deliver: no agentId/repoPath for session ${session.id}, message lost`);
    }

    session.lastActivityAt = Date.now();
    if (state?.executorId) await this.updateState(state.executorId, 'idle', session.chatId);
  }

  async shutdown(session: ExecutorSession): Promise<void> {
    const state = this.sessions.get(session.id);
    try {
      if (session.tmux) await killWindow(session.tmux.session, session.tmux.window);
    } finally {
      if (state?.executorId && this.safePgCall) {
        await this.safePgCall(
          'tmux-terminate-executor',
          () => registry.terminateExecutor(state.executorId as string),
          undefined,
          { executorId: state.executorId, chatId: session.chatId },
        );
      }
      // Clean up agent registry so deliverToPane() won't try to deliver to a dead pane
      if (state?.agentId && this.safePgCall) {
        await this.safePgCall('tmux-unregister-agent', () => agents.unregister(state.agentId as string), undefined, {
          chatId: session.chatId,
        });
      }
      this.sessions.delete(session.id);
    }
  }

  async isAlive(session: ExecutorSession): Promise<boolean> {
    const paneId = session.tmux?.paneId;
    if (!paneId) return false;
    try {
      const paneAlive = await isPaneAlive(paneId);
      if (!paneAlive) return false;
      return await isPaneProcessRunning(paneId, 'claude');
    } catch {
      return false;
    }
  }
}
