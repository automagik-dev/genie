import type { Query } from '@anthropic-ai/claude-agent-sdk';
import * as directory from '../../lib/agent-directory.js';
import { resolvePermissionConfig } from '../../lib/providers/claude-sdk-permissions.js';
import { ClaudeSdkProvider } from '../../lib/providers/claude-sdk.js';
import type { IExecutor, OmniMessage, OmniSession } from '../executor.js';

// ============================================================================
// Types
// ============================================================================

interface SdkSessionState {
  abortController: AbortController;
  running: boolean;
  provider: ClaudeSdkProvider;
  /** Claude session ID for resume (set after first query completes). */
  claudeSessionId?: string;
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
   * Spawn an SDK-backed agent session for a chat.
   *
   * Resolves the agent from the genie directory, creates a ClaudeSdkProvider
   * instance, and stores an AbortController for shutdown.
   */
  async spawn(agentName: string, chatId: string, _env: Record<string, string>): Promise<OmniSession> {
    const resolved = await directory.resolve(agentName);
    if (!resolved) {
      throw new Error(`Agent "${agentName}" not found in genie directory`);
    }

    const provider = new ClaudeSdkProvider();
    const abortController = new AbortController();

    const sessionId = `${agentName}:${chatId}`;
    this.sessions.set(sessionId, {
      abortController,
      running: true,
      provider,
    });

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
    );

    const result = await collectQueryResult(queryMessages);
    if (result.sessionId) {
      state.claudeSessionId = result.sessionId;
    }
    const replyText = result.text;
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
   * Shut down a session by aborting any active query.
   */
  async shutdown(session: OmniSession): Promise<void> {
    const state = this.sessions.get(session.id);
    if (state) {
      state.abortController.abort();
      state.running = false;
      this.sessions.delete(session.id);
      this.deliveryQueues.delete(session.id);
    }
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
