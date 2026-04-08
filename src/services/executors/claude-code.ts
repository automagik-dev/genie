/**
 * ClaudeCodeOmniExecutor -- tmux-based IExecutor implementation.
 *
 * Spawns Claude Code processes in tmux windows (one per chat),
 * delivers messages via Claude Code's native team inbox, and
 * injects env vars so agents can call `omni say/done` directly.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as directory from '../../lib/agent-directory.js';
import type { DirectoryEntry } from '../../lib/agent-directory.js';
import * as agents from '../../lib/agent-registry.js';
import * as registry from '../../lib/executor-registry.js';
import { buildLaunchCommand } from '../../lib/provider-adapters.js';
import type { SpawnParams } from '../../lib/provider-adapters.js';
import { shellQuote } from '../../lib/team-lead-command.js';
import { ensureTeamWindow, executeTmux, isPaneAlive, isPaneProcessRunning, killWindow } from '../../lib/tmux.js';
import type { ExecutorSession, IExecutor, OmniMessage, SafePgCallFn } from '../executor.js';
import { buildTurnBasedPrompt } from './turn-based-prompt.js';

interface TmuxSessionState {
  executorId: string | null;
}

export function sanitizeWindowName(chatId: string): string {
  const hash = createHash('md5').update(chatId).digest('hex').slice(0, 12);
  const prefix = chatId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
  return `${prefix}-${hash}` || 'chat';
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
  const turnPrompt = buildTurnBasedPrompt(senderName, instanceId, chatId);

  return {
    provider: (entry.provider as SpawnParams['provider']) ?? 'claude',
    team: agentName,
    role: agentName,
    sessionId: randomUUID(),
    model: entry.model,
    promptMode: entry.promptMode,
    systemPromptFile: join(entry.dir, 'AGENTS.md'),
    systemPrompt: turnPrompt,
    initialPrompt: initialMessage,
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

  async spawn(agentName: string, chatId: string, env: Record<string, string>): Promise<ExecutorSession> {
    const resolved = await directory.resolve(agentName);
    if (!resolved) throw new Error(`Agent "${agentName}" not found in genie directory`);

    const entry = resolved.entry;
    const tmuxSession = agentName;
    const windowName = sanitizeWindowName(chatId);
    const { paneId, created } = await ensureTeamWindow(tmuxSession, windowName, entry.dir);

    if (created) {
      const omniEnv: Record<string, string> = { ...env, GENIE_OMNI_CHAT_ID: chatId, GENIE_OMNI_AGENT: agentName };
      const params = buildOmniSpawnParams(agentName, chatId, entry, omniEnv);
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
    const executorId = await this.registerInWorldA(
      agentName,
      chatId,
      env.OMNI_INSTANCE ?? '',
      tmuxSession,
      windowName,
      paneId,
    );
    this.sessions.set(sessionKey, { executorId });
    if (executorId) await this.updateState(executorId, 'running', chatId);

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
  ): Promise<string | null> {
    if (!this.safePgCall) return null;
    const agent = await this.safePgCall(
      'tmux-find-or-create-agent',
      () => agents.findOrCreateAgent(agentName, 'omni', 'omni'),
      null,
      { chatId },
    );
    if (!agent) return null;
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
    return executor?.id ?? null;
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
    const tmuxSessionName = session.tmux?.session ?? session.agentName;
    const inboxDir = join(
      process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
      'teams',
      tmuxSessionName,
      'inboxes',
    );
    mkdirSync(inboxDir, { recursive: true });
    const inboxFile = join(inboxDir, `${sanitizeWindowName(session.chatId)}.json`);
    let messages: { from: string; text: string; summary: string; timestamp: string; read: boolean }[] = [];
    try {
      const { readFileSync } = await import('node:fs');
      messages = JSON.parse(readFileSync(inboxFile, 'utf-8'));
    } catch {
      /* start fresh */
    }
    messages.push({
      from: message.sender || 'whatsapp-user',
      text: message.content,
      summary: message.content.slice(0, 120),
      timestamp: message.timestamp || new Date().toISOString(),
      read: false,
    });
    writeFileSync(inboxFile, JSON.stringify(messages, null, 2));
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
