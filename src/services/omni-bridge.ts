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
import { resolveExecutorType } from '../lib/executor-config.js';
import type { IExecutor, OmniMessage, OmniSession } from './executor.js';
import { ClaudeCodeOmniExecutor } from './executors/claude-code.js';
import { ClaudeSdkOmniExecutor } from './executors/claude-sdk.js';
import { TurnTracker } from './omni-turn.js';

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
  /** Which executor backend is in use: tmux or sdk. */
  executorType: 'tmux' | 'sdk';
  /** Executor IDs from PG (omni source, not ended). Empty in degraded mode. */
  executorIds: string[];
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
  private turnTracker = new TurnTracker();

  /**
   * Process-local runtime handles — NOT the source of truth for session identity.
   *
   * This Map holds per-process runtime handles (executor instances, idle timers,
   * message buffers). Session identity and state live in PG via executor-registry.
   * This Map exists because:
   *   - executor instances are in-memory objects that can't be persisted
   *   - idle timers (setTimeout handles) are per-process
   *   - message buffers during spawn are ephemeral
   *
   * The Map does NOT define which sessions exist — PG does. The status() method
   * queries PG for active session count when available, falling back to this
   * Map's size only in degraded (no-PG) mode.
   */
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
  readonly executorType: 'tmux' | 'sdk';

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

    this.executorType = resolveExecutorType(config.executorType);
    if (this.executorType === 'sdk') {
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
    // Group 3 scaffolding; Group 4 consumers (SDK + tmux executors) receive a
    // bound `safePgCall` reference below.
    await this.probePg();

    // Inject the bridge's safePgCall into the executor so its World A registry
    // writes are guarded by the same pgAvailable / connection-loss logic as
    // the rest of the bridge. Both executors expose `setSafePgCall` (Group 4,
    // Decision 2 in WISH Post-Audit).
    this.executor.setSafePgCall(this.safePgCall.bind(this));

    // Subscribe to all omni messages
    this.sub = this.nc.subscribe('omni.message.>');
    this.processSubscription();

    // Turn lifecycle events from Omni
    const turnSubs = ['omni.turn.open.>', 'omni.turn.done.>', 'omni.turn.nudge.>', 'omni.turn.timeout.>'];
    for (const topic of turnSubs) {
      const sub = this.nc.subscribe(topic);
      this.processTurnEvents(sub);
    }

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
   *
   * When PG is available, queries the executors table for the authoritative
   * active session count and executor IDs. Falls back to the local sessions
   * Map size in degraded (no-PG) mode.
   */
  async status(): Promise<BridgeStatus> {
    const now = Date.now();

    // PG-backed active session count + executor IDs when available.
    let activeFromPg: number | null = null;
    let executorIds: string[] = [];

    if (this.pgAvailable && this.sql) {
      const rows = await this.safePgCall(
        'status_active_count',
        async (sql) =>
          sql<{ id: string }[]>`
            SELECT id FROM executors
            WHERE ended_at IS NULL AND metadata->>'source' = 'omni'
          `,
        null,
      );
      if (rows) {
        activeFromPg = rows.length;
        executorIds = rows.map((r) => r.id);
      }
    }

    return {
      connected: this.nc !== null,
      natsUrl: this.natsUrl,
      pgAvailable: this.pgAvailable,
      activeSessions: activeFromPg ?? this.sessions.size,
      maxConcurrent: this.maxConcurrent,
      idleTimeoutMs: this.idleTimeoutMs,
      queueDepth: this.messageQueue.length,
      executorType: this.executorType,
      executorIds,
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
   * Probe PG at startup. Classifies failures into two buckets:
   *
   *   - **Connection-level** (ECONNREFUSED, ETIMEDOUT, connection terminated, …):
   *     degrade gracefully — set `pgAvailable=false`, log warn, let the bridge
   *     keep running. Developers without PG must still be able to run omni.
   *   - **Anything else** (schema mismatch, missing relation, permission denied,
   *     migration not yet applied, …): fail-fast by rethrowing a clear error
   *     that tells the operator which migration command to run. Silent data
   *     corruption is worse than noisy startup failure — this matches the
   *     wish's PG Error Handling Strategy table.
   *
   * On success: caches the client and sets `pgAvailable=true`.
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

      if (isPgConnectionError(err)) {
        // Expected degraded-mode path: PG is simply unreachable.
        console.warn(`[omni-bridge] PG unavailable — session recovery disabled (${msg})`);
        return;
      }

      // Non-connection failure at startup = schema mismatch, missing migration,
      // permission denied, or similar. Fail-fast with an actionable message.
      const hint = 'Run `bun run migrate` (or the equivalent migration command) and retry.';
      throw new Error(`[omni-bridge] PG schema mismatch or setup error: ${msg}. ${hint}`);
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
   * Public by design (Decision 2 in WISH Post-Audit Decisions) — executors
   * hold an `OmniBridge` reference and call `bridge.safePgCall(...)` directly.
   */
  public async safePgCall<T>(
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
   * Process turn lifecycle events from NATS subscriptions.
   * Routes each event to the appropriate handler based on event type.
   */
  private async processTurnEvents(sub: Subscription): Promise<void> {
    for await (const msg of sub) {
      try {
        const payload = JSON.parse(this.sc.decode(msg.data));
        const parts = msg.subject.split('.');
        const eventType = parts[2]; // 'open', 'done', 'nudge', 'timeout'
        const instanceId = parts[3];
        const chatId = parts.slice(4).join('.'); // chatId may contain dots

        const sessionKey = this.findSessionKey(instanceId, chatId);
        if (sessionKey) await this.routeTurnEvent(eventType, sessionKey, payload);
      } catch (err) {
        console.warn('[omni-bridge] Error processing turn event:', err);
      }
    }
  }

  /**
   * Route a single turn event to the appropriate handler.
   * Extracted from processTurnEvents to keep cognitive complexity manageable.
   */
  private async routeTurnEvent(eventType: string, sessionKey: string, payload: Record<string, string>): Promise<void> {
    switch (eventType) {
      case 'open':
        this.turnTracker.open(sessionKey, payload.turnId, payload.messageId);
        break;
      case 'done':
        this.turnTracker.close(sessionKey, payload.action);
        break;
      case 'nudge':
        await this.handleTurnNudge(sessionKey, payload.message);
        break;
      case 'timeout':
        await this.handleTurnTimeout(sessionKey);
        break;
    }
  }

  /**
   * Find a session key by instanceId and chatId.
   * Scans the sessions Map for a matching entry since the Map is keyed by
   * `${agentName}:${chatId}` but we need to match by instanceId+chatId.
   */
  private findSessionKey(instanceId: string, chatId: string): string | undefined {
    for (const [key, entry] of this.sessions) {
      if (entry.instanceId === instanceId && entry.session?.chatId === chatId) {
        return key;
      }
    }
    return undefined;
  }

  /**
   * Handle a turn nudge event — inject the nudge text into the executor.
   */
  private async handleTurnNudge(sessionKey: string, nudgeText: string): Promise<void> {
    const entry = this.sessions.get(sessionKey);
    if (!entry?.session) return;
    try {
      await this.executor.injectNudge(entry.session, nudgeText);
    } catch (err) {
      console.warn(`[omni-bridge] Failed to inject nudge for ${sessionKey}:`, err);
    }
  }

  /**
   * Handle a turn timeout event — evict the session and shut down the executor.
   */
  private async handleTurnTimeout(sessionKey: string): Promise<void> {
    const entry = this.sessions.get(sessionKey);
    if (!entry?.session) return;
    console.warn(`[omni-bridge] Turn timed out for ${sessionKey}, evicting session`);
    this.turnTracker.close(sessionKey, 'timeout');
    try {
      await this.executor.shutdown(entry.session);
    } catch (err) {
      console.warn(`[omni-bridge] Error shutting down timed-out session ${sessionKey}:`, err);
    }
    this.sessions.delete(sessionKey);
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
      // Extract env vars from NATS payload (turn-based dispatcher packs them under payload.env).
      // Falls back to message fields for backwards compat with pre-turn-based dispatchers.
      // biome-ignore lint/suspicious/noExplicitAny: NATS payload may have extra fields
      const raw = message as any;
      const payloadEnv = raw.env as Record<string, string> | undefined;
      const spawnEnv: Record<string, string> = {
        OMNI_API_KEY: payloadEnv?.OMNI_API_KEY ?? process.env.OMNI_API_KEY ?? '',
        OMNI_INSTANCE: payloadEnv?.OMNI_INSTANCE ?? message.instanceId,
        OMNI_CHAT: payloadEnv?.OMNI_CHAT ?? message.chatId,
        OMNI_MESSAGE: payloadEnv?.OMNI_MESSAGE ?? (raw.messageId as string) ?? '',
        OMNI_TURN_ID: payloadEnv?.OMNI_TURN_ID ?? '',
      };

      console.log(`[omni-bridge] Spawning session for ${key}...`);
      const session = await this.executor.spawn(message.agent, message.chatId, spawnEnv);

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
