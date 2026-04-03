/**
 * Omni Bridge — NATS subscriber + router + session manager.
 *
 * Subscribes to `omni.message.>` and routes inbound WhatsApp messages
 * to agent sessions via the IExecutor interface. Manages:
 *   - Per-chat session lifecycle (spawn/deliver/shutdown)
 *   - Idle timeout (15min default, configurable)
 *   - Max concurrency (20 default, configurable)
 *   - Message buffering during spawn
 *   - Auto-respawn on window death
 */

import { type NatsConnection, StringCodec, type Subscription, connect } from 'nats';
import type { IExecutor, OmniMessage, OmniSession } from './executor.js';
import { ClaudeCodeOmniExecutor } from './executors/claude-code.js';

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_NATS_URL = 'localhost:4222';
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_MAX_CONCURRENT = 20;
const MAX_BUFFER_PER_CHAT = 50;
const IDLE_CHECK_INTERVAL_MS = 30_000; // Check idle sessions every 30s

// ============================================================================
// Types
// ============================================================================

interface BridgeConfig {
  natsUrl?: string;
  idleTimeoutMs?: number;
  maxConcurrent?: number;
}

interface SessionEntry {
  session: OmniSession;
  instanceId: string;
  spawning: boolean;
  buffer: OmniMessage[];
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export interface BridgeStatus {
  connected: boolean;
  natsUrl: string;
  activeSessions: number;
  maxConcurrent: number;
  idleTimeoutMs: number;
  queueDepth: number;
  sessions: Array<{
    id: string;
    agentName: string;
    chatId: string;
    instanceId: string;
    paneId: string;
    spawning: boolean;
    idleMs: number;
    bufferSize: number;
  }>;
}

// ============================================================================
// Singleton Bridge
// ============================================================================

let bridgeInstance: OmniBridge | null = null;

export function getBridge(): OmniBridge | null {
  return bridgeInstance;
}

// ============================================================================
// Bridge
// ============================================================================

export class OmniBridge {
  private nc: NatsConnection | null = null;
  private sub: Subscription | null = null;
  private executor: IExecutor;
  private sessions = new Map<string, SessionEntry>();
  private messageQueue: OmniMessage[] = [];
  private idleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private sc = StringCodec();

  readonly natsUrl: string;
  readonly idleTimeoutMs: number;
  readonly maxConcurrent: number;

  constructor(config: BridgeConfig = {}) {
    this.natsUrl = config.natsUrl ?? process.env.GENIE_NATS_URL ?? DEFAULT_NATS_URL;
    this.idleTimeoutMs =
      config.idleTimeoutMs ??
      (process.env.GENIE_IDLE_TIMEOUT_MS ? Number(process.env.GENIE_IDLE_TIMEOUT_MS) : DEFAULT_IDLE_TIMEOUT_MS);
    this.maxConcurrent =
      config.maxConcurrent ??
      (process.env.GENIE_MAX_CONCURRENT ? Number(process.env.GENIE_MAX_CONCURRENT) : DEFAULT_MAX_CONCURRENT);
    this.executor = new ClaudeCodeOmniExecutor();
  }

  /**
   * Start the bridge: connect to NATS and subscribe to omni.message.>
   */
  async start(): Promise<void> {
    if (this.nc) {
      console.log('[omni-bridge] Already running');
      return;
    }

    console.log(`[omni-bridge] Connecting to NATS at ${this.natsUrl}...`);

    this.nc = await connect({
      servers: this.natsUrl,
      name: 'genie-omni-bridge',
      reconnect: true,
      maxReconnectAttempts: -1, // Unlimited reconnects
      reconnectTimeWait: 2000,
    });

    console.log('[omni-bridge] Connected to NATS');

    // Subscribe to all omni messages
    this.sub = this.nc.subscribe('omni.message.>');
    this.processSubscription();

    // Start idle session checker
    this.idleCheckTimer = setInterval(() => this.checkIdleSessions(), IDLE_CHECK_INTERVAL_MS);

    // Register singleton
    bridgeInstance = this;

    console.log(
      `[omni-bridge] Listening on omni.message.> (max_concurrent=${this.maxConcurrent}, idle_timeout=${this.idleTimeoutMs}ms)`,
    );
  }

  /**
   * Stop the bridge: unsubscribe, drain, and disconnect.
   */
  async stop(): Promise<void> {
    if (!this.nc) {
      console.log('[omni-bridge] Not running');
      return;
    }

    console.log('[omni-bridge] Shutting down...');

    // Stop idle checker
    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }

    // Clear all idle timers
    for (const entry of this.sessions.values()) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
    }

    // Unsubscribe
    if (this.sub) {
      this.sub.unsubscribe();
      this.sub = null;
    }

    // Drain and close
    try {
      await this.nc.drain();
    } catch {
      // Connection may already be closed
    }
    this.nc = null;
    bridgeInstance = null;

    console.log('[omni-bridge] Stopped');
  }

  /**
   * Get current bridge status for `genie omni status`.
   */
  status(): BridgeStatus {
    const now = Date.now();
    return {
      connected: this.nc !== null,
      natsUrl: this.natsUrl,
      activeSessions: this.sessions.size,
      maxConcurrent: this.maxConcurrent,
      idleTimeoutMs: this.idleTimeoutMs,
      queueDepth: this.messageQueue.length,
      sessions: Array.from(this.sessions.entries()).map(([key, entry]) => ({
        id: key,
        agentName: entry.session.agentName,
        chatId: entry.session.chatId,
        instanceId: entry.instanceId,
        paneId: entry.session.paneId,
        spawning: entry.spawning,
        idleMs: now - entry.session.lastActivityAt,
        bufferSize: entry.buffer.length,
      })),
    };
  }

  // ==========================================================================
  // Internal
  // ==========================================================================

  /**
   * Process incoming NATS messages from the subscription.
   */
  private async processSubscription(): Promise<void> {
    if (!this.sub) return;

    for await (const msg of this.sub) {
      try {
        const data = this.sc.decode(msg.data);
        const parsed: OmniMessage = JSON.parse(data);

        // Extract instance_id and chat_id from subject: omni.message.{instance}.{chat_id}
        const parts = msg.subject.split('.');
        if (parts.length >= 4) {
          parsed.instanceId = parsed.instanceId || parts[2];
          parsed.chatId = parsed.chatId || parts[3];
        }

        if (!parsed.chatId || !parsed.agent) {
          console.warn('[omni-bridge] Dropping message: missing chatId or agent', msg.subject);
          continue;
        }

        await this.routeMessage(parsed);
      } catch (err) {
        console.error('[omni-bridge] Error processing message:', err);
      }
    }
  }

  /**
   * Route a message to the appropriate session.
   */
  private async routeMessage(message: OmniMessage): Promise<void> {
    const key = `${message.agent}:${message.chatId}`;
    const entry = this.sessions.get(key);

    if (entry) {
      // Session exists — check if still alive
      if (entry.spawning) {
        // Still spawning — buffer the message
        if (entry.buffer.length < MAX_BUFFER_PER_CHAT) {
          entry.buffer.push(message);
        }
        return;
      }

      const alive = await this.executor.isAlive(entry.session);
      if (alive) {
        // Deliver to running session
        await this.executor.deliver(entry.session, message);
        this.resetIdleTimer(key);
        return;
      }

      // Session dead — remove and respawn
      this.removeSession(key);
    }

    // Need to spawn a new session
    await this.spawnSession(message);
  }

  /**
   * Spawn a new agent session for a chat.
   */
  private async spawnSession(message: OmniMessage): Promise<void> {
    const key = `${message.agent}:${message.chatId}`;

    // Check concurrency limit
    const activeCount = Array.from(this.sessions.values()).filter((e) => !e.spawning).length;
    if (activeCount >= this.maxConcurrent) {
      // Queue the message and send auto-reply
      this.messageQueue.push(message);
      await this.publishAutoReply(message);
      console.log(`[omni-bridge] Max concurrent (${this.maxConcurrent}) reached, queued message for ${key}`);
      return;
    }

    // Create placeholder entry (spawning state)
    const placeholder: SessionEntry = {
      session: null as unknown as OmniSession, // Will be set after spawn
      instanceId: message.instanceId,
      spawning: true,
      buffer: [message], // Buffer the triggering message too
      idleTimer: null,
    };
    this.sessions.set(key, placeholder);

    try {
      const env: Record<string, string> = {
        OMNI_REPLY_TOPIC: `omni.reply.${message.instanceId}.${message.chatId}`,
        OMNI_NATS_URL: this.natsUrl,
        OMNI_INSTANCE_ID: message.instanceId,
        OMNI_CHAT_ID: message.chatId,
      };

      console.log(`[omni-bridge] Spawning session for ${key}...`);
      const session = await this.executor.spawn(message.agent, message.chatId, env);

      placeholder.session = session;
      placeholder.spawning = false;

      // Deliver buffered messages
      for (const buffered of placeholder.buffer) {
        await this.executor.deliver(session, buffered);
      }
      placeholder.buffer = [];

      // Start idle timer
      this.resetIdleTimer(key);

      console.log(`[omni-bridge] Session active: ${key} (pane=${session.paneId})`);
    } catch (err) {
      console.error(`[omni-bridge] Failed to spawn session for ${key}:`, err);
      this.sessions.delete(key);
    }
  }

  /**
   * Reset the idle timer for a session.
   */
  private resetIdleTimer(key: string): void {
    const entry = this.sessions.get(key);
    if (!entry) return;

    if (entry.idleTimer) clearTimeout(entry.idleTimer);

    entry.idleTimer = setTimeout(async () => {
      console.log(`[omni-bridge] Idle timeout for ${key}, shutting down...`);
      try {
        await this.executor.shutdown(entry.session);
      } catch {
        // Already dead — that's fine
      }
      this.removeSession(key);

      // Process queued messages now that a slot is free
      await this.drainQueue();
    }, this.idleTimeoutMs);
  }

  /**
   * Check for idle sessions and terminate them.
   */
  private async checkIdleSessions(): Promise<void> {
    const now = Date.now();
    for (const [key, entry] of this.sessions) {
      if (entry.spawning) continue;

      // Check if session pane died
      const alive = await this.executor.isAlive(entry.session);
      if (!alive) {
        console.log(`[omni-bridge] Dead session detected: ${key}`);
        this.removeSession(key);
        continue;
      }

      // Check idle time (belt-and-suspenders — main timeout is via resetIdleTimer)
      const idleMs = now - entry.session.lastActivityAt;
      if (idleMs > this.idleTimeoutMs) {
        console.log(`[omni-bridge] Forcing idle shutdown: ${key} (idle ${Math.round(idleMs / 1000)}s)`);
        try {
          await this.executor.shutdown(entry.session);
        } catch {
          /* already dead */
        }
        this.removeSession(key);
      }
    }
  }

  /**
   * Remove a session and clean up its idle timer.
   */
  private removeSession(key: string): void {
    const entry = this.sessions.get(key);
    if (entry?.idleTimer) clearTimeout(entry.idleTimer);
    this.sessions.delete(key);
  }

  /**
   * Drain the message queue — process queued messages when a slot opens.
   */
  private async drainQueue(): Promise<void> {
    while (this.messageQueue.length > 0) {
      const activeCount = Array.from(this.sessions.values()).filter((e) => !e.spawning).length;
      if (activeCount >= this.maxConcurrent) break;

      const message = this.messageQueue.shift();
      if (message) await this.spawnSession(message);
    }
  }

  /**
   * Publish an auto-reply when max concurrent is reached.
   */
  private async publishAutoReply(message: OmniMessage): Promise<void> {
    if (!this.nc) return;

    const topic = `omni.reply.${message.instanceId}.${message.chatId}`;
    const reply = {
      content: 'Aguarde um momento, estou atendendo outros clientes.',
      agent: message.agent,
      chat_id: message.chatId,
      instance_id: message.instanceId,
      timestamp: new Date().toISOString(),
      auto_reply: true,
    };

    this.nc.publish(topic, this.sc.encode(JSON.stringify(reply)));
  }
}
