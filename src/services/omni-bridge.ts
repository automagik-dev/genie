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
import type { Sql } from '../lib/db.js';
import type { IExecutor, OmniMessage, OmniSession } from './executor.js';
import { ClaudeCodeOmniExecutor } from './executors/claude-code.js';
import { ClaudeSdkOmniExecutor } from './executors/claude-sdk.js';

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_NATS_URL = 'localhost:4222';
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_MAX_CONCURRENT = 20;
const MAX_BUFFER_PER_CHAT = 50;
const IDLE_CHECK_INTERVAL_MS = 30_000; // Check idle sessions every 30s
const PG_STARTUP_PROBE_TIMEOUT_MS = 5_000;
const PG_RUNTIME_QUERY_TIMEOUT_MS = 2_000;

// ============================================================================
// Types
// ============================================================================

/** Factory that returns a ready-to-use postgres.js tagged-template client. */
export type PgProvider = () => Promise<Sql>;

/** Minimal shape for NATS connect — lets tests inject a fake NATS without touching the network. */
export type NatsConnectFn = typeof connect;

/** Optional context attached to safePgCall log lines. */
export interface SafePgCallContext {
  executorId?: string;
  chatId?: string;
}

interface BridgeConfig {
  natsUrl?: string;
  idleTimeoutMs?: number;
  maxConcurrent?: number;
  executorType?: 'tmux' | 'sdk';
  /** Test/DI hook: override the PG provider. Defaults to `getConnection()` from lib/db.js. */
  pgProvider?: PgProvider;
  /** Test/DI hook: override the NATS connect function. Defaults to the real `connect` from the nats package. */
  natsConnectFn?: NatsConnectFn;
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
  /** True when the startup PG probe succeeded and runtime writes are allowed. */
  pgAvailable: boolean;
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
// PG helpers (Group 3 — scaffolding for degraded-mode PG access)
// ============================================================================

/**
 * Race a promise against a timeout. The timeout timer is `unref`'d so it never
 * holds the event loop open on its own. Used by the bridge's PG probe and
 * safePgCall helper to honor the wish's 2s read / 5s startup budgets.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Classify a thrown value as a PG connection-level error. Used by safePgCall
 * to decide whether to flip `pgAvailable=false` after a failure.
 *
 * We match both by postgres.js error codes (.code) and by common message
 * fragments, because postgres.js surfaces some errors as generic Errors with
 * no code (e.g., "connection terminated unexpectedly").
 */
function isPgConnectionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; message?: string };
  const code = e.code ?? '';
  if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE', 'EHOSTUNREACH'].includes(code)) {
    return true;
  }
  const msg = e.message ?? String(err);
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|connection terminated|connection closed|server closed the connection|the database system is shutting down/i.test(
    msg,
  );
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

  /** Postgres client, set after a successful startup probe. Null in degraded mode. */
  private sql: Sql | null = null;
  /** Flipped by `probePg()` at startup; flipped to false on any connection-level runtime error. */
  private pgAvailable = false;
  private readonly pgProvider: PgProvider;
  private readonly natsConnectFn: NatsConnectFn;

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

    this.pgProvider =
      config.pgProvider ??
      (async () => {
        const { getConnection } = await import('../lib/db.js');
        return (await getConnection()) as Sql;
      });
    this.natsConnectFn = config.natsConnectFn ?? connect;

    const executorType = config.executorType ?? (process.env.GENIE_EXECUTOR_TYPE as 'tmux' | 'sdk') ?? 'tmux';
    if (executorType === 'sdk') {
      this.executor = new ClaudeSdkOmniExecutor();
    } else {
      this.executor = new ClaudeCodeOmniExecutor();
    }
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

    this.nc = await this.natsConnectFn({
      servers: this.natsUrl,
      name: 'genie-omni-bridge',
      reconnect: true,
      maxReconnectAttempts: -1, // Unlimited reconnects
      reconnectTimeWait: 2000,
    });

    console.log('[omni-bridge] Connected to NATS');

    // PG probe: graceful degradation on failure — never block startup.
    // Group 3 scaffolding only; downstream groups wire safePgCall into their call sites.
    await this.probePg();

    // Wire NATS publish into SDK executor for reply routing
    if (this.executor instanceof ClaudeSdkOmniExecutor) {
      const nc = this.nc;
      const sc = this.sc;
      this.executor.setNatsPublish((topic, payload) => {
        nc.publish(topic, sc.encode(payload));
      });
    }

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

    // Shut down all active executor sessions and clear idle timers
    for (const [key, entry] of this.sessions) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      if (!entry.spawning && entry.session) {
        try {
          await this.executor.shutdown(entry.session);
        } catch (err) {
          console.warn(`[omni-bridge] Error shutting down session ${key}:`, err);
        }
      }
    }
    this.sessions.clear();

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

    // Reset PG state — the shared `getConnection()` singleton (lib/db.js) owns
    // the actual client lifecycle, so we only clear our local references.
    this.sql = null;
    this.pgAvailable = false;

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
      pgAvailable: this.pgAvailable,
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
  // PG lifecycle — Group 3 scaffolding
  // ==========================================================================

  /**
   * Probe PG at startup. Sets `pgAvailable=true` and caches the client on success.
   * On any failure (connection refused, timeout, migration mismatch surfaced by
   * the provider, etc.) logs at warn level and degrades to `pgAvailable=false`.
   * Never throws — the bridge must start even without PG.
   */
  private async probePg(): Promise<void> {
    try {
      const sql = await withTimeout(this.pgProvider(), PG_STARTUP_PROBE_TIMEOUT_MS, 'PG provider startup');
      await withTimeout(Promise.resolve(sql`SELECT 1`), PG_STARTUP_PROBE_TIMEOUT_MS, 'PG SELECT 1 probe');
      this.sql = sql;
      this.pgAvailable = true;
      console.log('[omni-bridge] PG reachable — session recovery enabled');
    } catch (err) {
      this.sql = null;
      this.pgAvailable = false;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[omni-bridge] PG unavailable — session recovery disabled (${msg})`);
    }
  }

  /**
   * Single entry point for every runtime PG call made by the bridge and its
   * downstream executors. Guarantees the delivery loop never crashes on a
   * transient PG fault.
   *
   * Semantics (matches the wish's PG Error Handling Strategy table):
   *   - If `pgAvailable` is already false, returns `fallback` without calling `fn`.
   *   - Otherwise calls `fn` once (no retry). Applies a 2s timeout for reads.
   *   - On error: logs at warn with `op`, `executor_id`, and `chat_id` context.
   *   - On connection-level errors (ECONNREFUSED, connection terminated, etc.),
   *     flips `pgAvailable` to false so later calls fast-path to fallback.
   *   - Always returns `fallback` on error — the caller never sees the throw.
   *
   * Downstream groups (4, 5, 6, 7) wire their PG writes through this helper.
   */
  private async safePgCall<T>(
    op: string,
    fn: (sql: Sql) => Promise<T>,
    fallback: T,
    ctx?: SafePgCallContext,
  ): Promise<T> {
    if (!this.pgAvailable || !this.sql) {
      return fallback;
    }
    const sql = this.sql;
    try {
      return await withTimeout(fn(sql), PG_RUNTIME_QUERY_TIMEOUT_MS, `safePgCall(${op})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const execPart = ctx?.executorId ? ` executor_id=${ctx.executorId}` : '';
      const chatPart = ctx?.chatId ? ` chat_id=${ctx.chatId}` : '';
      console.warn(`[omni-bridge] safePgCall(${op}) failed${execPart}${chatPart}: ${msg}`);
      if (isPgConnectionError(err)) {
        this.pgAvailable = false;
        this.sql = null;
        console.warn('[omni-bridge] PG connection lost — switching to degraded mode');
      }
      return fallback;
    }
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
        } else {
          console.warn(
            `[omni-bridge] Buffer full (${MAX_BUFFER_PER_CHAT}) for ${key}, dropping message from ${message.sender}`,
          );
          await this.publishBufferFullReply(message);
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

    // Check concurrency limit (count spawning entries too to prevent oversubscription)
    const activeCount = this.sessions.size;
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
      // Re-queue buffered messages before deleting the placeholder
      const lostMessages = placeholder.buffer;
      if (lostMessages.length > 0) {
        console.warn(
          `[omni-bridge] Re-queuing ${lostMessages.length} buffered message(s) from failed spawn for ${key}`,
        );
        this.messageQueue.push(...lostMessages);
      }
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
      const activeCount = this.sessions.size;
      if (activeCount >= this.maxConcurrent) break;

      const message = this.messageQueue.shift();
      if (message) await this.spawnSession(message);
    }
  }

  /**
   * Publish an auto-reply when the per-chat buffer is full.
   */
  private async publishBufferFullReply(message: OmniMessage): Promise<void> {
    if (!this.nc) return;

    const topic = `omni.reply.${message.instanceId}.${message.chatId}`;
    const reply = {
      content: 'Fila de mensagens cheia, por favor aguarde e tente novamente.',
      agent: message.agent,
      chat_id: message.chatId,
      instance_id: message.instanceId,
      timestamp: new Date().toISOString(),
      auto_reply: true,
    };

    this.nc.publish(topic, this.sc.encode(JSON.stringify(reply)));
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
