import type { Query } from '@anthropic-ai/claude-agent-sdk';
import * as directory from '../../lib/agent-directory.js';
import * as agents from '../../lib/agent-registry.js';
import { recordAuditEvent } from '../../lib/audit-events.js';
import * as registry from '../../lib/executor-registry.js';
import { resolvePermissionConfig } from '../../lib/providers/claude-sdk-permissions.js';
import { ClaudeSdkProvider } from '../../lib/providers/claude-sdk.js';
import type { IExecutor, OmniMessage, OmniSession, SafePgCallFn } from '../executor.js';
import { endSession, recordTurn, startSession, updateTurnCount } from './sdk-session-capture.js';

// ============================================================================
// Types
// ============================================================================

interface SdkSessionState {
  abortController: AbortController;
  running: boolean;
  provider: ClaudeSdkProvider;
  /** Claude session ID for resume (set after first query completes). */
  claudeSessionId?: string;
  /**
   * World A executor row ID. Set after successful `createAndLinkExecutor` in
   * spawn(). Null when PG was unavailable (degraded mode) — downstream state
   * updates short-circuit via `bridge.safePgCall` in that case.
   */
  executorId: string | null;
  /** PG sessions row ID for session_content capture (Group 5). Null in degraded mode. */
  dbSessionId: string | null;
  /** Running turn counter for session_content rows. */
  turnIndex: number;
}

// ============================================================================
// Helpers
// ============================================================================

/** Load system prompt from AGENTS.md if available. */
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

/** Result from consuming an SDK query stream. */
interface QueryResult {
  text: string;
  sessionId?: string;
}

/** Extract text blocks from an assistant message. */
function extractTextFromAssistant(msg: { message?: { content: Array<{ type: string; text?: string }> } }): string[] {
  if (!msg.message) return [];
  return msg.message.content.filter((b) => b.type === 'text' && b.text).map((b) => b.text as string);
}

/** Collect assistant text and session ID from an SDK query message stream. */
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
// Implementation
// ============================================================================

export class ClaudeSdkOmniExecutor implements IExecutor {
  private sessions = new Map<string, SdkSessionState>();
  private natsPublish: ((topic: string, payload: string) => void) | null = null;
  /**
   * Bridge-provided `safePgCall`. Null until the bridge wires it via
   * `setSafePgCall()`. When null (no bridge attached, e.g. standalone tests),
   * registry calls are skipped entirely — the executor falls through to the
   * pre-World-A behavior.
   */
  private safePgCall: SafePgCallFn | null = null;

  /**
   * Per-session delivery queues. Each session chains its deliveries so messages
   * within a single session are processed in order, but different sessions
   * proceed independently and concurrently.
   */
  private deliveryQueues = new Map<string, Promise<void>>();

  /**
   * Set the NATS publish function for reply routing.
   * Called by the bridge after construction.
   */
  setNatsPublish(fn: (topic: string, payload: string) => void): void {
    this.natsPublish = fn;
  }

  /**
   * Inject the bridge's `safePgCall` helper so World A registry writes are
   * guarded by the same pgAvailable / connection-loss logic as the rest of
   * the bridge. Mirrors {@link setNatsPublish}.
   */
  setSafePgCall(fn: SafePgCallFn): void {
    this.safePgCall = fn;
  }

  /**
   * Spawn an SDK-backed agent session for a chat.
   *
   * - Resolves the agent from the genie directory.
   * - Registers the agent identity in World A via `findOrCreateAgent`.
   * - Creates an `executors` row with `transport='api'` and omni metadata.
   * - All PG writes go through `bridge.safePgCall` — degraded mode keeps
   *   `executorId=null` and the session still works without persistence.
   */
  async spawn(agentName: string, chatId: string, env: Record<string, string>): Promise<OmniSession> {
    const resolved = await directory.resolve(agentName);
    if (!resolved) {
      throw new Error(`Agent "${agentName}" not found in genie directory`);
    }

    const provider = new ClaudeSdkProvider();
    const abortController = new AbortController();
    const sessionId = `${agentName}:${chatId}`;

    // World A registration (Group 4 + Group 7 lazy resume).
    // Returns null when PG is in degraded mode; downstream state transitions
    // short-circuit via safePgCall's pgAvailable fast-path.
    // When an existing executor is found (bridge restart), returns its
    // claudeSessionId so the next query can resume the Claude session.
    const registration = await this.registerInWorldA(agentName, chatId, env.OMNI_INSTANCE_ID ?? '');

    this.sessions.set(sessionId, {
      abortController,
      running: true,
      provider,
      executorId: registration?.executorId ?? null,
      claudeSessionId: registration?.claudeSessionId,
      dbSessionId: null,
      turnIndex: 0,
    });

    // Transition spawning → running once the session is in the local map.
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

  /**
   * Register agent + executor in World A (Decision 1 from WISH Post-Audit).
   * Returns the executor ID + optional Claude session ID on success, or null
   * when PG is unavailable. All writes go through `bridge.safePgCall`.
   *
   * Group 7 — Lazy resume: before creating a fresh executor, look for an
   * existing live executor for this agent + chat. If found, reuse it and
   * recover the Claude session ID so the next query can resume.
   */
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

    // Lazy resume: look for an existing live executor for this chat.
    const existing = await this.safePgCall(
      'sdk-find-existing-executor',
      () => registry.findLatestByMetadata({ agentId: agent.id, source: 'omni', chatId }),
      null,
      { chatId },
    );

    if (existing) {
      // Reuse existing executor — relink to agent and recover session.
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

    // Fresh: create new executor and link to agent.
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

  /** Update executor state through safePgCall. No-op when PG is degraded. */
  private async updateState(executorId: string, state: 'running' | 'working' | 'idle', chatId: string): Promise<void> {
    if (!this.safePgCall) return;
    await this.safePgCall(
      'sdk-update-executor-state',
      () => registry.updateExecutorState(executorId, state),
      undefined,
      { executorId, chatId },
    );
  }

  /**
   * Deliver a message by enqueuing an async SDK query.
   *
   * Returns immediately after enqueuing. Within a session, deliveries are
   * chained so ordering is preserved. Across sessions, deliveries run
   * concurrently so one slow chat does not block others.
   */
  async deliver(session: OmniSession, message: OmniMessage): Promise<void> {
    const state = this.sessions.get(session.id);
    if (!state) {
      throw new Error(`No SDK session found for ${session.id}`);
    }

    // Chain onto the existing queue for this session (or start fresh)
    const previous = this.deliveryQueues.get(session.id) ?? Promise.resolve();
    const current = previous.then(() => this._processDelivery(session, state, message));

    // Swallow errors at the queue level so one failure doesn't break the chain
    this.deliveryQueues.set(
      session.id,
      current.catch(() => {}),
    );
  }

  /**
   * Internal: run the SDK query for a single delivery.
   * Called from the per-session queue — never directly from deliver().
   */
  private async _processDelivery(session: OmniSession, state: SdkSessionState, message: OmniMessage): Promise<void> {
    const resolved = await directory.resolve(session.agentName);
    if (!resolved) {
      throw new Error(`Agent "${session.agentName}" not found in genie directory`);
    }

    const entry = resolved.entry;
    const permissionConfig = resolvePermissionConfig(entry.permissions);
    const systemPrompt = await loadSystemPrompt(entry);

    // State: working (query in flight) — before the blocking operation starts.
    if (state.executorId) await this.updateState(state.executorId, 'working', session.chatId);

    // Audit: deliver.start
    if (this.safePgCall) {
      await recordAuditEvent(this.safePgCall, 'deliver.start', {
        executor_id: state.executorId ?? session.id,
        agent_id: session.agentName,
        chat_id: message.chatId,
        instance_id: message.instanceId,
      });
    }

    // Resume existing session or start fresh
    const extraOptions: Record<string, unknown> = { abortController: state.abortController };
    if (state.claudeSessionId) {
      extraOptions.resume = state.claudeSessionId;
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
      message.content,
      permissionConfig,
      extraOptions,
      entry.sdk,
    );

    // Record user turn (lazily creates PG session row on first delivery).
    await this.captureUserTurn(state, session.agentName, session.id, message.content);

    const result = await collectQueryResult(queryMessages);
    if (result.sessionId) {
      await this.reconcileSessionId(state, session, result.sessionId);
    }
    const replyText = result.text;

    // Record assistant turn and update turn count.
    await this.captureAssistantTurn(state, session.id, result.sessionId, session.agentName, replyText);

    if (replyText && this.natsPublish) {
      const topic = `omni.reply.${message.instanceId}.${message.chatId}`;
      const payload = JSON.stringify({
        content: replyText,
        agent: session.agentName,
        chat_id: message.chatId,
        instance_id: message.instanceId,
        timestamp: new Date().toISOString(),
      });
      this.natsPublish(topic, payload);
    }

    session.lastActivityAt = Date.now();

    // Audit: deliver.end
    if (this.safePgCall) {
      await recordAuditEvent(this.safePgCall, 'deliver.end', {
        executor_id: state.executorId ?? session.id,
        agent_id: session.agentName,
        chat_id: message.chatId,
        instance_id: message.instanceId,
        turn_count: state.turnIndex,
      });
    }

    // State: idle (query finished, waiting for next message).
    if (state.executorId) await this.updateState(state.executorId, 'idle', session.chatId);
  }

  /**
   * Group 7 — Reconcile the Claude session ID after a query completes.
   * Detects resume rejection (SDK returned a different session), persists
   * new/changed session IDs to the registry, and updates local state.
   */
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

    // Persist session ID to registry if it changed (first query or resume rejection).
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

  /** Lazily create PG session row and record the user turn. */
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

  /** Record the assistant turn, re-key session ID if needed, bump turn count. */
  private async captureAssistantTurn(
    state: SdkSessionState,
    sessionKey: string,
    claudeSessionId: string | undefined,
    agentName: string,
    replyText: string,
  ): Promise<void> {
    if (!this.safePgCall) return;
    // Re-key the PG session row with the real Claude session ID once available.
    if (claudeSessionId && state.dbSessionId?.startsWith('sdk-')) {
      const newId = await startSession(this.safePgCall, state.executorId ?? sessionKey, claudeSessionId, agentName);
      if (newId) state.dbSessionId = newId;
    }
    if (state.dbSessionId && replyText) {
      await recordTurn(this.safePgCall, state.dbSessionId, state.turnIndex++, 'assistant', replyText);
      await updateTurnCount(this.safePgCall, state.dbSessionId, state.turnIndex);
    }
  }

  /**
   * Wait for all pending deliveries for a session (or all sessions) to complete.
   * Useful for tests and graceful shutdown.
   */
  async waitForDeliveries(sessionId?: string): Promise<void> {
    if (sessionId) {
      await this.deliveryQueues.get(sessionId);
    } else {
      await Promise.all([...this.deliveryQueues.values()]);
    }
  }

  /**
   * Shut down a session by aborting any active query and terminating its
   * World A executor row (if one was created).
   */
  async shutdown(session: OmniSession): Promise<void> {
    const state = this.sessions.get(session.id);
    if (!state) return;

    state.abortController.abort();
    state.running = false;

    // End the PG session row (Group 5) before terminating the executor.
    if (state.dbSessionId && this.safePgCall) {
      await endSession(this.safePgCall, state.dbSessionId, 'completed');
    }

    // Terminate World A executor row — safePgCall short-circuits in degraded mode.
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

  /**
   * Check if a session is still alive (not aborted, not removed).
   */
  async isAlive(session: OmniSession): Promise<boolean> {
    const state = this.sessions.get(session.id);
    if (!state) return false;
    return state.running && !state.abortController.signal.aborted;
  }
}
