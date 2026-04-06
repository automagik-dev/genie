import type { Query } from '@anthropic-ai/claude-agent-sdk';

import { z } from 'zod';
import * as directory from '../../lib/agent-directory.js';
import * as agents from '../../lib/agent-registry.js';
import { recordAuditEvent } from '../../lib/audit-events.js';
import * as registry from '../../lib/executor-registry.js';
import { resolvePermissionConfig } from '../../lib/providers/claude-sdk-permissions.js';
import { ClaudeSdkProvider } from '../../lib/providers/claude-sdk.js';
import type { IExecutor, NatsPublishFn, OmniMessage, OmniSession, SafePgCallFn } from '../executor.js';
import { endSession, recordTurn, startSession, updateTurnCount } from './sdk-session-capture.js';

// ============================================================================
// Types
// ============================================================================

interface SdkSessionState {
  abortController: AbortController;
  running: boolean;
  provider: ClaudeSdkProvider;
  claudeSessionId?: string;
  executorId: string | null;
  dbSessionId: string | null;
  turnIndex: number;
  env: Record<string, string>;
}

// ============================================================================
// Helpers
// ============================================================================

async function loadSystemPrompt(entry: directory.DirectoryEntry): Promise<string | undefined> {
  const identityPath = directory.loadIdentity(entry);
  if (!identityPath) return undefined;
  const { readFileSync } = await import('node:fs');
  try {
    return readFileSync(identityPath, 'utf-8');
  } catch {
    return undefined;
  }
}

interface QueryResult {
  text: string;
  sessionId?: string;
}

function extractTextFromAssistant(msg: { message?: { content: Array<{ type: string; text?: string }> } }): string[] {
  if (!msg.message) return [];
  return msg.message.content.filter((b) => b.type === 'text' && b.text).map((b) => b.text as string);
}

async function collectQueryResult(queryMessages: Query): Promise<QueryResult> {
  const textParts: string[] = [];
  let sessionId: string | undefined;
  try {
    for await (const msg of queryMessages) {
      if (msg.type === 'assistant') {
        textParts.push(...extractTextFromAssistant(msg));
      }
      if (msg.type === 'result' && msg.subtype === 'success') {
        sessionId = msg.session_id;
      }
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') return { text: '' };
    throw err;
  }
  return { text: textParts.join('\n').trim(), sessionId };
}

// ============================================================================
// Done tool — NATS reply (in-process, no subprocess fork)
// ============================================================================

function buildReplyPayload(agent: string, chatId: string, instanceId: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    content: '',
    agent,
    chat_id: chatId,
    instance_id: instanceId,
    timestamp: new Date().toISOString(),
    ...extra,
  });
}

function resolveAction(
  params: Record<string, unknown>,
  env: Record<string, string>,
): { type: 'skip' | 'react' | 'media' | 'text'; extra: Record<string, unknown>; label: string } {
  if (params.skip) return { type: 'skip', extra: { reason: params.reason }, label: 'Turn closed (skip).' };
  if (params.react)
    return {
      type: 'react',
      extra: { react: String(params.react), message_id: env.OMNI_MESSAGE ?? '' },
      label: `Reacted ${params.react} + turn closed.`,
    };
  if (params.media) {
    const text = params.caption ? String(params.caption) : params.text ? String(params.text) : '';
    return { type: 'media', extra: { content: text, media: String(params.media) }, label: 'Media sent + turn closed.' };
  }
  if (params.text)
    return { type: 'text', extra: { content: String(params.text) }, label: 'Turn closed. Message delivered.' };
  return { type: 'skip', extra: {}, label: 'Turn closed (skip).' };
}

export function handleDoneTool(
  params: Record<string, unknown>,
  env: Record<string, string>,
  natsPublish: NatsPublishFn | null,
): string {
  const instanceId = env.OMNI_INSTANCE ?? '';
  const chatId = env.OMNI_CHAT ?? '';
  const agent = env.OMNI_AGENT ?? '';
  const action = resolveAction(params, env);

  if (action.type === 'skip') {
    if (natsPublish && instanceId && chatId) {
      natsPublish(`omni.turn.done.${instanceId}.${chatId}`, JSON.stringify({ action: 'skip', ...action.extra }));
    }
    return action.label;
  }

  if (!natsPublish || !instanceId || !chatId) {
    console.warn('[claude-sdk] No NATS publish available — reply dropped');
    return 'Turn close attempted but NATS publish not available.';
  }

  natsPublish(`omni.reply.${instanceId}.${chatId}`, buildReplyPayload(agent, chatId, instanceId, action.extra));
  return action.label;
}

async function createDoneMcpServer(env: Record<string, string>, natsPublish: NatsPublishFn | null) {
  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');
  return createSdkMcpServer({
    name: 'genie-omni-tools',
    tools: [
      tool(
        'done',
        'Close this turn. REQUIRED after processing the user message. Sends a final response, reacts, or skips. Call exactly once per turn.',
        {
          text: z.string().optional().describe('Final message to the user'),
          media: z.string().optional().describe('File path for media attachment'),
          caption: z.string().optional().describe('Caption for media'),
          react: z.string().optional().describe('Emoji reaction (instead of text)'),
          skip: z.boolean().optional().describe('Close turn without sending anything'),
          reason: z.string().optional().describe('Internal reason for skipping'),
        },
        async (args) => {
          const result = handleDoneTool(args as Record<string, unknown>, env, natsPublish);
          return { content: [{ type: 'text' as const, text: result }] };
        },
      ),
    ],
  });
}

// ============================================================================
// Implementation
// ============================================================================

export class ClaudeSdkOmniExecutor implements IExecutor {
  private sessions = new Map<string, SdkSessionState>();
  private safePgCall: SafePgCallFn | null = null;
  private natsPublish: NatsPublishFn | null = null;
  private deliveryQueues = new Map<string, Promise<void>>();
  private pendingNudges = new Map<string, string>();

  setSafePgCall(fn: SafePgCallFn): void {
    this.safePgCall = fn;
  }

  setNatsPublish(fn: NatsPublishFn): void {
    this.natsPublish = fn;
  }

  async injectNudge(session: OmniSession, text: string): Promise<void> {
    if (!this.sessions.has(session.id)) return;
    this.pendingNudges.set(session.id, text);
  }

  async spawn(agentName: string, chatId: string, env: Record<string, string>): Promise<OmniSession> {
    const resolved = await directory.resolve(agentName);
    if (!resolved) {
      throw new Error(`Agent "${agentName}" not found in genie directory`);
    }

    const provider = new ClaudeSdkProvider();
    const abortController = new AbortController();
    const sessionId = `${agentName}:${chatId}`;

    const registration = await this.registerInWorldA(agentName, chatId, env.OMNI_INSTANCE ?? '');

    this.sessions.set(sessionId, {
      abortController,
      running: true,
      provider,
      executorId: registration?.executorId ?? null,
      claudeSessionId: registration?.claudeSessionId,
      dbSessionId: null,
      turnIndex: 0,
      env,
    });

    if (registration?.executorId) {
      await this.updateState(registration.executorId, 'running', chatId);
    }

    const now = Date.now();
    return {
      id: sessionId,
      agentName,
      chatId,
      tmuxSession: '',
      tmuxWindow: '',
      paneId: `sdk-${chatId}`,
      createdAt: now,
      lastActivityAt: now,
    };
  }

  private async registerInWorldA(
    agentName: string,
    chatId: string,
    instanceId: string,
  ): Promise<{ executorId: string; claudeSessionId?: string } | null> {
    if (!this.safePgCall) return null;

    const agent = await this.safePgCall(
      'sdk-find-or-create-agent',
      () => agents.findOrCreateAgent(agentName, 'omni', 'omni'),
      null,
      { chatId },
    );
    if (!agent) return null;

    const existing = await this.safePgCall(
      'sdk-find-existing-executor',
      () => registry.findLatestByMetadata({ agentId: agent.id, source: 'omni', chatId }),
      null,
      { chatId },
    );

    if (existing) {
      await this.safePgCall(
        'sdk-relink-executor',
        () => registry.relinkExecutorToAgent(existing.id, agent.id),
        undefined,
        { executorId: existing.id, chatId },
      );
      await recordAuditEvent(this.safePgCall, 'session.resumed', {
        executor_id: existing.id,
        agent_id: agentName,
        chat_id: chatId,
        claude_session_id: existing.claudeSessionId,
      });
      return {
        executorId: existing.id,
        claudeSessionId: existing.claudeSessionId ?? undefined,
      };
    }

    const executor = await this.safePgCall(
      'sdk-create-executor',
      () =>
        registry.createAndLinkExecutor(agent.id, 'claude', 'api', {
          claudeSessionId: undefined,
          metadata: { source: 'omni', chat_id: chatId, instance_id: instanceId },
        }),
      null,
      { chatId },
    );
    if (executor) {
      await recordAuditEvent(this.safePgCall, 'session.created_fresh', {
        executor_id: executor.id,
        agent_id: agentName,
        chat_id: chatId,
      });
    }
    return executor ? { executorId: executor.id } : null;
  }

  private async updateState(executorId: string, state: 'running' | 'working' | 'idle', chatId: string): Promise<void> {
    if (!this.safePgCall) return;
    await this.safePgCall(
      'sdk-update-executor-state',
      () => registry.updateExecutorState(executorId, state),
      undefined,
      { executorId, chatId },
    );
  }

  async deliver(session: OmniSession, message: OmniMessage): Promise<void> {
    const state = this.sessions.get(session.id);
    if (!state) {
      throw new Error(`No SDK session found for ${session.id}`);
    }

    const previous = this.deliveryQueues.get(session.id) ?? Promise.resolve();
    const current = previous.then(() => this._processDelivery(session, state, message));

    this.deliveryQueues.set(
      session.id,
      current.catch(() => {}),
    );
  }

  private async _processDelivery(session: OmniSession, state: SdkSessionState, message: OmniMessage): Promise<void> {
    const resolved = await directory.resolve(session.agentName);
    if (!resolved) {
      throw new Error(`Agent "${session.agentName}" not found in genie directory`);
    }

    const entry = resolved.entry;
    const permissionConfig = resolvePermissionConfig(entry.permissions);
    const systemPrompt = await loadSystemPrompt(entry);

    if (state.executorId) await this.updateState(state.executorId, 'working', session.chatId);

    if (this.safePgCall) {
      await recordAuditEvent(this.safePgCall, 'deliver.start', {
        executor_id: state.executorId ?? session.id,
        agent_id: session.agentName,
        chat_id: message.chatId,
        instance_id: message.instanceId,
      });
    }

    const doneMcp = await createDoneMcpServer(state.env, this.natsPublish);
    const extraOptions: Record<string, unknown> = {
      abortController: state.abortController,
      mcpServers: { 'genie-omni-tools': doneMcp },
    };
    if (state.claudeSessionId) {
      extraOptions.resume = state.claudeSessionId;
    }

    let queryContent = message.content;
    const pendingNudge = this.pendingNudges.get(session.id);
    if (pendingNudge) {
      queryContent = `[system] ${pendingNudge}\n\n${message.content}`;
      this.pendingNudges.delete(session.id);
    }

    const { messages: queryMessages } = state.provider.runQuery(
      {
        agentId: session.agentName,
        executorId: session.id,
        team: '',
        role: session.agentName,
        cwd: entry.dir || process.cwd(),
        model: entry.model,
        systemPrompt: state.claudeSessionId ? undefined : systemPrompt,
      },
      queryContent,
      permissionConfig,
      extraOptions,
      entry.sdk,
    );

    await this.captureUserTurn(state, session.agentName, session.id, message.content);

    const result = await collectQueryResult(queryMessages);
    if (result.sessionId) {
      await this.reconcileSessionId(state, session, result.sessionId);
    }

    await this.captureAssistantTurn(state, session.id, result.sessionId, session.agentName, result.text);

    session.lastActivityAt = Date.now();

    if (this.safePgCall) {
      await recordAuditEvent(this.safePgCall, 'deliver.end', {
        executor_id: state.executorId ?? session.id,
        agent_id: session.agentName,
        chat_id: message.chatId,
        instance_id: message.instanceId,
        turn_count: state.turnIndex,
      });
    }

    if (state.executorId) await this.updateState(state.executorId, 'idle', session.chatId);
  }

  private async reconcileSessionId(
    state: SdkSessionState,
    session: OmniSession,
    returnedSessionId: string,
  ): Promise<void> {
    const isResumeRejected = state.claudeSessionId && returnedSessionId !== state.claudeSessionId;
    if (isResumeRejected && this.safePgCall) {
      await recordAuditEvent(this.safePgCall, 'session.resume_rejected', {
        executor_id: state.executorId ?? session.id,
        agent_id: session.agentName,
        chat_id: session.chatId,
        old_session_id: state.claudeSessionId,
        new_session_id: returnedSessionId,
      });
    }

    const execId = state.executorId;
    if (execId && this.safePgCall && returnedSessionId !== state.claudeSessionId) {
      await this.safePgCall(
        'sdk-update-claude-session',
        () => registry.updateClaudeSessionId(execId, returnedSessionId),
        undefined,
        { executorId: execId, chatId: session.chatId },
      );
    }

    state.claudeSessionId = returnedSessionId;
  }

  private async captureUserTurn(
    state: SdkSessionState,
    agentName: string,
    _sessionKey: string,
    content: string,
  ): Promise<void> {
    if (!this.safePgCall) return;
    if (!state.dbSessionId && state.executorId) {
      state.dbSessionId = await startSession(this.safePgCall, state.executorId, state.claudeSessionId, agentName);
    }
    if (state.dbSessionId) {
      await recordTurn(this.safePgCall, state.dbSessionId, state.turnIndex++, 'user', content);
    }
  }

  private async captureAssistantTurn(
    state: SdkSessionState,
    sessionKey: string,
    claudeSessionId: string | undefined,
    agentName: string,
    replyText: string,
  ): Promise<void> {
    if (!this.safePgCall) return;
    if (claudeSessionId && state.dbSessionId?.startsWith('sdk-')) {
      const newId = await startSession(this.safePgCall, state.executorId ?? sessionKey, claudeSessionId, agentName);
      if (newId) state.dbSessionId = newId;
    }
    if (state.dbSessionId && replyText) {
      await recordTurn(this.safePgCall, state.dbSessionId, state.turnIndex++, 'assistant', replyText);
      await updateTurnCount(this.safePgCall, state.dbSessionId, state.turnIndex);
    }
  }

  async waitForDeliveries(sessionId?: string): Promise<void> {
    if (sessionId) {
      await this.deliveryQueues.get(sessionId);
    } else {
      await Promise.all([...this.deliveryQueues.values()]);
    }
  }

  async shutdown(session: OmniSession): Promise<void> {
    const state = this.sessions.get(session.id);
    if (!state) return;

    state.abortController.abort();
    state.running = false;

    if (state.dbSessionId && this.safePgCall) {
      await endSession(this.safePgCall, state.dbSessionId, 'completed');
    }

    if (state.executorId && this.safePgCall) {
      await this.safePgCall(
        'sdk-terminate-executor',
        () => registry.terminateExecutor(state.executorId as string),
        undefined,
        { executorId: state.executorId, chatId: session.chatId },
      );
    }

    this.sessions.delete(session.id);
    this.deliveryQueues.delete(session.id);
  }

  async isAlive(session: OmniSession): Promise<boolean> {
    const state = this.sessions.get(session.id);
    if (!state) return false;
    return state.running && !state.abortController.signal.aborted;
  }
}
