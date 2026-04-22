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

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { type NatsConnection, StringCodec, type Subscription, connect } from 'nats';
import { BRIDGE_PING_SUBJECT, type BridgePong, getBridgePidfilePath } from '../lib/bridge-status.js';
import type { Sql } from '../lib/db.js';
import { resolveExecutorType } from '../lib/executor-config.js';
import { BridgeSessionStore } from './bridge-session-store.js';
import type { ExecutorSession, IExecutor, OmniMessage } from './executor.js';
import { ClaudeCodeOmniExecutor } from './executors/claude-code.js';
import { ClaudeSdkOmniExecutor } from './executors/claude-sdk.js';
import { OmniQueue, type QueueConfig, type QueueStats } from './omni-queue.js';
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
  /** Queue config for SDK executor. Only used when executorType is 'sdk' and PG is available. */
  queue?: QueueConfig;
}

interface SessionEntry {
  session: ExecutorSession;
  instanceId: string;
  spawning: boolean;
  buffer: OmniMessage[];
  idleTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Set when a reset arrives while the entry is still in the spawning state.
   * `spawnSession` checks this flag after `executor.spawn` resolves and tears
   * down the freshly-created session instead of putting it into rotation.
   */
  cancelled?: boolean;
  /** PG bridge session row ID, set after store.create() succeeds. */
  pgBridgeSessionId?: string;
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
  /** PG-backed queue stats (SDK executor only). Null when queue is not active. */
  pgQueue: QueueStats | null;
  sessions: Array<{
    id: string;
    agentName: string;
    chatId: string;
    instanceId: string;
    executorType: 'tmux' | 'sdk';
    spawning: boolean;
    idleMs: number;
    bufferSize: number;
  }>;
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
  /** Dedup cache: messageId → receive timestamp. Prevents JetStream redelivery duplicates. */
  private recentMessageIds = new Map<string, number>();
  private idleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private sc = StringCodec();

  /** Postgres client, set after a successful startup probe. Null in degraded mode. */
  private sql: Sql | null = null;
  /** Flipped by `probePg()` at startup; flipped to false on any connection-level runtime error. */
  private pgAvailable = false;
  private readonly pgProvider: PgProvider;
  private readonly natsConnectFn: NatsConnectFn;
  private readonly queueConfig: QueueConfig;

  /** PG-backed request queue for SDK executor. Null when PG unavailable or executor is tmux. */
  private queue: OmniQueue | null = null;
  /** PG-backed session persistence. Null when PG unavailable. */
  private sessionStore: BridgeSessionStore | null = null;

  readonly natsUrl: string;
  readonly idleTimeoutMs: number;
  readonly maxConcurrent: number;
  readonly executorType: 'tmux' | 'sdk';

  /** Pidfile path (set once start() succeeds; cleared on stop()). */
  private pidfilePath: string | null = null;
  /** Wall-clock start time (ms since epoch) — reported in ping replies. */
  private startedAtMs = 0;
  /** Subscription handle for the omni.bridge.ping IPC channel. */
  private pingSub: Subscription | null = null;
  /** Signal handlers registered on start(), removed on stop() so tests don't leak. */
  private signalCleanup: (() => void) | null = null;

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
    this.queueConfig = config.queue ?? {};

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
      maxReconnectAttempts: -1,
      reconnectTimeWait: 2000,
    });
    console.log('[omni-bridge] Connected to NATS');

    await this.setupPg();
    this.wireExecutorHooks();
    this.subscribeOmniChannels();

    this.startedAtMs = Date.now();
    this.subscribePingChannel();

    await this.claimPidfile();
    this.armSignalCleanup();

    // Arm the idle session checker LAST — after the pidfile write has
    // succeeded and all prior rollback paths are past. See issue #1137.
    this.idleCheckTimer = setInterval(() => this.checkIdleSessions(), IDLE_CHECK_INTERVAL_MS);

    console.log(
      `[omni-bridge] Listening on omni.message.> (max_concurrent=${this.maxConcurrent}, idle_timeout=${this.idleTimeoutMs}ms)`,
    );
  }

  /** PG probe + session store + queue initialization. */
  private async setupPg(): Promise<void> {
    await this.probePg();
    if (this.pgAvailable && this.sql) {
      this.sessionStore = new BridgeSessionStore(this.sql);
      await this.recoverSessions();
    }
    if (this.executorType === 'sdk' && this.pgAvailable && this.sql) {
      this.queue = new OmniQueue(this.sql, (_req, msg) => this.routeMessage(msg), this.queueConfig);
      await this.queue.recoverStale();
      this.queue.start();
    }
  }

  /** Inject safePgCall + NATS publish into the executor. */
  private wireExecutorHooks(): void {
    this.executor.setSafePgCall(this.safePgCall.bind(this));
    const sc = this.sc;
    const nc = this.nc;
    if (!nc) return;
    this.executor.setNatsPublish((topic: string, payload: string) => {
      nc.publish(topic, sc.encode(payload));
    });
  }

  /** Subscribe to omni.message.>, omni.turn.*.>, omni.session.reset.>. */
  private subscribeOmniChannels(): void {
    if (!this.nc) return;
    this.sub = this.nc.subscribe('omni.message.>', { queue: 'genie-bridge' });
    this.processSubscription();

    const turnSubs = ['omni.turn.open.>', 'omni.turn.done.>', 'omni.turn.nudge.>', 'omni.turn.timeout.>'];
    for (const topic of turnSubs) {
      const sub = this.nc.subscribe(topic, { queue: 'genie-bridge' });
      this.processTurnEvents(sub);
    }

    const sessionResetSub = this.nc.subscribe('omni.session.reset.>', { queue: 'genie-bridge' });
    this.processSessionResetEvents(sessionResetSub);
  }

  /** Subscribe to the omni.bridge.ping IPC channel and start the responder loop. */
  private subscribePingChannel(): void {
    if (!this.nc) return;
    this.pingSub = this.nc.subscribe(BRIDGE_PING_SUBJECT);
    const pingSub = this.pingSub;
    const pingSc = this.sc;
    const pingStart = this.startedAtMs;
    (async () => {
      for await (const m of pingSub) {
        const pong: BridgePong = {
          ok: true,
          pid: process.pid,
          uptimeMs: Date.now() - pingStart,
          subjects: ['omni.message.>', 'omni.turn.open.>', 'omni.session.reset.>', BRIDGE_PING_SUBJECT],
        };
        try {
          m.respond(pingSc.encode(JSON.stringify(pong)));
        } catch {
          // Request may have expired — drop.
        }
      }
    })().catch(() => {
      // subscription closed on shutdown — fine
    });
  }

  /** Write the pidfile, rolling back NATS on collision. Uses O_EXCL to arbitrate races. */
  private async claimPidfile(): Promise<void> {
    this.pidfilePath = getBridgePidfilePath();
    try {
      mkdirSync(dirname(this.pidfilePath), { recursive: true });
      this.evictStalePidfile(this.pidfilePath);
      const fd = openSync(this.pidfilePath, 'wx');
      const payload = JSON.stringify({
        pid: process.pid,
        startedAt: this.startedAtMs,
        subjects: ['omni.message.>', 'omni.turn.open.>', 'omni.session.reset.>', BRIDGE_PING_SUBJECT],
        natsUrl: this.natsUrl,
      });
      writeSync(fd, payload);
      closeSync(fd);
    } catch (err) {
      await this.rollbackStartOnPidfileError(err);
    }
  }

  /**
   * Stale-pidfile recovery: if a pidfile exists whose owning process is
   * gone, the previous holder crashed. Unlink it and retake. If the PID
   * is alive, fail fast — another bridge is legitimately holding the lock.
   */
  private evictStalePidfile(path: string): void {
    if (!existsSync(path)) return;
    let stalePid: number | null = null;
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as { pid?: unknown };
      if (typeof parsed.pid === 'number' && Number.isFinite(parsed.pid)) {
        stalePid = parsed.pid;
      }
    } catch {
      // Unreadable/corrupt pidfile — treat as stale and unlink below.
    }
    if (stalePid !== null && this.isPidAlive(stalePid)) {
      throw new Error(`pidfile locked by PID ${stalePid}`);
    }
    try {
      unlinkSync(path);
    } catch {
      // Another process may have cleaned it up already — openSync wx will still arbitrate atomically.
    }
  }

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (probeErr) {
      // ESRCH = no such process → stale. Any other errno (e.g. EPERM)
      // means the process exists and we must not steal the lock.
      return (probeErr as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  }

  private async rollbackStartOnPidfileError(err: unknown): Promise<never> {
    this.pidfilePath = null;
    const detail = err instanceof Error ? err.message : String(err);
    try {
      if (this.pingSub) this.pingSub.unsubscribe();
    } catch {
      // ignore
    }
    this.pingSub = null;
    try {
      await this.nc?.drain();
    } catch {
      // ignore
    }
    this.nc = null;
    throw new Error(`[omni-bridge] pidfile locked at ${getBridgePidfilePath()}: ${detail}`);
  }

  /**
   * Best-effort pidfile cleanup on fatal signals. stop() removes it on
   * graceful shutdown; these handlers cover SIGTERM/SIGINT paths where
   * stop() may race the process exit.
   */
  private armSignalCleanup(): void {
    const onSignal = () => {
      if (this.pidfilePath) {
        try {
          unlinkSync(this.pidfilePath);
        } catch {
          // already gone
        }
        this.pidfilePath = null;
      }
    };
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
    this.signalCleanup = () => {
      process.removeListener('SIGTERM', onSignal);
      process.removeListener('SIGINT', onSignal);
    };
  }

  /**
   * Stop the bridge: unsubscribe, drain, and disconnect.
   *
   * Tmux sessions are left running (graceful detach) so they survive a bridge
   * restart. On next start(), recoverSessions() re-attaches to live panes.
   * SDK sessions are shut down normally since they can't outlive the process.
   */
  async stop(): Promise<void> {
    if (!this.nc) {
      console.log('[omni-bridge] Not running');
      return;
    }

    console.log('[omni-bridge] Shutting down...');

    if (this.queue) {
      this.queue.stop();
      this.queue = null;
    }
    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }

    await this.shutdownActiveSessions();
    this.unsubscribeChannels();
    this.clearPidfileOnStop();
    if (this.signalCleanup) {
      this.signalCleanup();
      this.signalCleanup = null;
    }

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
    this.sessionStore = null;

    console.log('[omni-bridge] Stopped');
  }

  /**
   * Clear idle timers and shut down non-tmux sessions.
   * Tmux sessions are left running — their PG rows stay 'active' so
   * recoverSessions() can re-attach after restart.
   */
  private async shutdownActiveSessions(): Promise<void> {
    for (const [key, entry] of this.sessions) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      if (entry.spawning || !entry.session) continue;
      if (entry.session.executorType === 'tmux') {
        console.log(`[omni-bridge] Detaching from tmux session ${key} (pane stays alive)`);
        continue;
      }
      try {
        await this.executor.shutdown(entry.session);
      } catch (err) {
        console.warn(`[omni-bridge] Error shutting down session ${key}:`, err);
      }
      const closeId = entry.pgBridgeSessionId;
      if (closeId && this.sessionStore) {
        await this.safePgCall('session_close_sdk', (sql) => new BridgeSessionStore(sql).close(closeId), undefined);
      }
    }
    this.sessions.clear();
  }

  private unsubscribeChannels(): void {
    if (this.sub) {
      this.sub.unsubscribe();
      this.sub = null;
    }
    if (this.pingSub) {
      try {
        this.pingSub.unsubscribe();
      } catch {
        // ignore
      }
      this.pingSub = null;
    }
  }

  private clearPidfileOnStop(): void {
    if (!this.pidfilePath) return;
    try {
      unlinkSync(this.pidfilePath);
    } catch {
      // already gone — fine
    }
    this.pidfilePath = null;
  }

  /**
   * Get current bridge status (in-process snapshot).
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

    // PG queue stats when available.
    let pgQueue: QueueStats | null = null;
    if (this.queue) {
      pgQueue = await this.safePgCall(
        'status_queue_stats',
        (_sql) => this.queue?.stats() ?? Promise.resolve(null),
        null,
      );
    }

    return {
      connected: this.nc !== null,
      natsUrl: this.natsUrl,
      pgAvailable: this.pgAvailable,
      activeSessions: activeFromPg ?? this.sessions.size,
      maxConcurrent: this.maxConcurrent,
      idleTimeoutMs: this.idleTimeoutMs,
      queueDepth: pgQueue ? pgQueue.pending + pgQueue.processing : this.messageQueue.length,
      executorType: this.executorType,
      executorIds,
      pgQueue,
      sessions: Array.from(this.sessions.entries()).map(([key, entry]) => ({
        id: key,
        agentName: entry.session.agentName,
        chatId: entry.session.chatId,
        instanceId: entry.instanceId,
        executorType: entry.session.executorType,
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
   * Clean up stale sessions from previous bridge runs.
   *
   * Orphans ALL active sessions on startup. Live panes will be re-created
   * on demand when the next message arrives. This prevents duplicate key
   * errors and misrouting from stale session state.
   */
  private async recoverSessions(): Promise<void> {
    if (!this.sessionStore) return;

    const orphanedCount = await this.safePgCall(
      'recover_orphan_all',
      (sql) => new BridgeSessionStore(sql).markAllOrphaned(),
      0,
    );

    if (orphanedCount > 0) {
      console.log(`[omni-bridge] Startup cleanup: orphaned ${orphanedCount} stale session(s) from previous run`);
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

  /** Fill instanceId/chatId from the NATS subject when the payload omits them. */
  private fillSubjectMetadata(parsed: OmniMessage, subject: string): void {
    const parts = subject.split('.');
    if (parts.length < 4) return;
    parsed.instanceId = parsed.instanceId || (parts[2] as string);
    parsed.chatId = parsed.chatId || (parts[3] as string);
  }

  /** Track a recently-seen message id, returning true if it is a duplicate. */
  private isDuplicateMessage(messageId: string | undefined): boolean {
    if (!messageId) return false;
    if (this.recentMessageIds.has(messageId)) return true;
    this.recentMessageIds.set(messageId, Date.now());
    // Prune stale entries when cache grows large (TTL 60s)
    if (this.recentMessageIds.size > 1000) {
      const cutoff = Date.now() - 60_000;
      for (const [id, ts] of this.recentMessageIds) {
        if (ts < cutoff) this.recentMessageIds.delete(id);
      }
    }
    return false;
  }

  /**
   * SDK executor with PG queue: persist to queue for durable processing.
   * Tmux executor or degraded mode: route directly (fire-and-forget).
   */
  private async dispatchMessage(parsed: OmniMessage): Promise<void> {
    if (this.queue) {
      // biome-ignore lint/suspicious/noExplicitAny: NATS payload may have extra fields
      const raw = parsed as any;
      const env = (raw.env as Record<string, string>) ?? {};
      await this.queue.enqueue(parsed, env);
      return;
    }
    const key = `${parsed.agent}:${parsed.chatId}`;
    const hasSession = this.sessions.has(key);
    console.log(`[omni-bridge] Routing message for ${key} (hasSession=${hasSession}, queue=${!!this.queue})`);
    await this.routeMessage(parsed);
    console.log(`[omni-bridge] routeMessage done for ${key}`);
  }

  /**
   * Process incoming NATS messages from the subscription.
   */
  private async processSubscription(): Promise<void> {
    if (!this.sub) return;

    for await (const msg of this.sub) {
      try {
        const data = this.sc.decode(msg.data);
        const parsed: OmniMessage = JSON.parse(data);
        this.fillSubjectMetadata(parsed, msg.subject);

        console.log(`[omni-bridge] NATS message received: ${msg.subject} agent=${parsed.agent} chat=${parsed.chatId}`);

        // biome-ignore lint/suspicious/noExplicitAny: NATS payload has extra fields beyond OmniMessage
        const messageId = (parsed as any).messageId as string | undefined;
        if (this.isDuplicateMessage(messageId)) {
          console.log(`[omni-bridge] Dedup: skipping duplicate messageId=${messageId}`);
          continue;
        }

        if (!parsed.chatId || !parsed.agent) {
          console.warn('[omni-bridge] Dropping message: missing chatId or agent', msg.subject);
          continue;
        }

        await this.dispatchMessage(parsed);
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

        console.log(`[omni-bridge] Turn event: ${eventType} instance=${instanceId} chat=${chatId}`);
        let sessionKey = this.findSessionKey(instanceId, chatId);

        // Fallback: if chatId didn't match (e.g. LID vs phone mismatch),
        // try finding the session by turnId from the payload.
        if (!sessionKey && payload.turnId) {
          sessionKey = this.findSessionKeyByTurnId(payload.turnId);
          if (sessionKey) {
            console.log(`[omni-bridge] Matched session via turnId fallback: ${sessionKey}`);
          }
        }

        if (sessionKey) {
          await this.routeTurnEvent(eventType, sessionKey, payload);
        } else {
          console.log(`[omni-bridge] No session found for turn.${eventType} (instance=${instanceId}, chat=${chatId})`);
        }
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
        await this.handleTurnDone(sessionKey);
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
  private findSessionKeyByTurnId(turnId: string): string | undefined {
    for (const [key] of this.sessions) {
      if (this.turnTracker.getTurnId(key) === turnId) return key;
    }
    return undefined;
  }

  /** Map internal chat UUID → external chatId, populated on turn.open events. */
  private chatIdMap = new Map<string, string>();

  private findSessionKey(instanceId: string, chatId: string): string | undefined {
    // If chatId is an internal UUID, try resolving to external via the map
    const resolvedChatId = this.chatIdMap.get(chatId);

    for (const [key, entry] of this.sessions) {
      if (entry.instanceId !== instanceId) continue;
      // Live entry — match against the spawned session's chatId.
      if (entry.session?.chatId === chatId) return key;
      if (resolvedChatId && entry.session?.chatId === resolvedChatId) return key;
      // Spawning entry — session is null, so match against the map key suffix
      // (`${agent}:${chatId}`). Without this fallback, a reset arriving in the
      // narrow window between placeholder insertion and spawn completion would
      // be misclassified as a cold chat and ignored.
      if (entry.spawning && key.endsWith(`:${chatId}`)) return key;
      if (resolvedChatId && entry.spawning && key.endsWith(`:${resolvedChatId}`)) return key;
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
   * Process incoming session reset events from NATS.
   *
   * Subject shape: `omni.session.reset.{instanceId}.{chatId}` — chatId may
   * contain dots (WhatsApp ids look like `+5511...@s.whatsapp.net`), so we
   * splice from index 4 onward.
   *
   * Payload is best-effort: malformed JSON is tolerated and treated as `{}`,
   * because the routing decision lives in the subject, not the body. The
   * `action` field is read for observability only — the only behavior today
   * is "kill the session".
   */
  private async processSessionResetEvents(sub: Subscription): Promise<void> {
    for await (const msg of sub) {
      try {
        const parts = msg.subject.split('.');
        if (parts.length < 5) {
          console.warn(`[omni-bridge] Malformed session-reset subject: ${msg.subject}`);
          continue;
        }
        const instanceId = parts[3];
        const chatId = parts.slice(4).join('.');

        let action: string | undefined;
        try {
          const payload = JSON.parse(this.sc.decode(msg.data)) as { action?: string };
          action = payload.action;
        } catch {
          // Malformed/empty payload — proceed with subject-only routing.
        }

        await this.handleSessionReset(instanceId, chatId, action);
      } catch (err) {
        console.warn('[omni-bridge] Error processing session reset event:', err);
      }
    }
  }

  /**
   * Handle a session reset request — evict the session and shut down the executor.
   *
   * Defensive: no-op when the session is unknown (cold chat), so a user can
   * tap reset on a chat that has no live agent without producing an error.
   *
   * Mirrors `handleTurnTimeout`'s cleanup so the session map, idle timer, and
   * executor stay coherent.
   */
  private async handleSessionReset(instanceId: string, chatId: string, action?: string): Promise<void> {
    const sessionKey = this.findSessionKey(instanceId, chatId);
    if (!sessionKey) {
      // Cold chat — nothing to reset, but acknowledge in logs for traceability.
      console.log(`[omni-bridge] Session reset for cold chat ${instanceId}/${chatId} — no-op`);
      return;
    }

    const entry = this.sessions.get(sessionKey);
    if (!entry) return;

    const actionTag = action ? ` (action=${action})` : '';

    // Spawning sessions: we cannot interrupt the in-flight executor.spawn call,
    // but we can flag the entry so spawnSession tears down the freshly-created
    // session as soon as the await resolves. The placeholder is removed from
    // the map immediately so subsequent messages spawn a fresh session.
    if (entry.spawning) {
      console.log(`[omni-bridge] Session reset for spawning ${sessionKey}${actionTag}, marking cancelled`);
      entry.cancelled = true;
      entry.buffer = []; // Drop buffered messages — user explicitly reset.
      this.turnTracker.close(sessionKey, 'reset');
      await this.removeSession(sessionKey);
      await this.drainQueue();
      return;
    }

    if (!entry.session) return;

    console.log(`[omni-bridge] Session reset for ${sessionKey}${actionTag}, evicting`);
    this.turnTracker.close(sessionKey, 'reset');
    try {
      await this.executor.shutdown(entry.session);
    } catch (err) {
      console.warn(`[omni-bridge] Error shutting down reset session ${sessionKey}:`, err);
    }
    await this.removeSession(sessionKey);
    await this.drainQueue();
  }

  /**
   * Handle a turn.done event — the agent called `omni done`.
   * The turn is closed but the SESSION stays alive. The next inbound message
   * will be delivered to the same session (same tmux pane / SDK conversation).
   * Session teardown only happens on idle timeout or explicit reset.
   */
  private async handleTurnDone(sessionKey: string): Promise<void> {
    const entry = this.sessions.get(sessionKey);
    if (!entry?.session) return;
    console.log(`[omni-bridge] Turn done for ${sessionKey}, session stays alive for next message`);
    // Reset the idle timer — the session is idle until the next message arrives
    this.resetIdleTimer(sessionKey);
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
        // Update last_activity_at in PG
        const bsId = entry.pgBridgeSessionId;
        if (bsId && this.sessionStore) {
          this.safePgCall('session_activity', (sql) => new BridgeSessionStore(sql).recordActivity(bsId), undefined, {
            chatId: message.chatId,
          });
        }
        return;
      }

      // Session dead — remove and respawn
      await this.removeSession(key);
    }

    // Need to spawn a new session
    await this.spawnSession(message);
  }

  /**
   * Spawn a new agent session for a chat.
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: spawn orchestration with concurrent guard, env resolution, and error recovery
  private async spawnSession(message: OmniMessage): Promise<void> {
    const key = `${message.agent}:${message.chatId}`;

    // Guard: if a session or spawning placeholder already exists, buffer instead of double-spawning.
    // This prevents the race where two concurrent messages for the same chatId both call spawnSession.
    const existing = this.sessions.get(key);
    if (existing) {
      if (existing.buffer.length < MAX_BUFFER_PER_CHAT) {
        existing.buffer.push(message);
        console.log(`[omni-bridge] Buffered message for existing session ${key} (buffer=${existing.buffer.length})`);
      }
      return;
    }

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
      session: null as unknown as ExecutorSession, // Will be set after spawn
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
        OMNI_TURN_ID: payloadEnv?.OMNI_TURN_ID || '',
        OMNI_SENDER_NAME: payloadEnv?.OMNI_SENDER_NAME ?? message.sender ?? '',
      };

      console.log(`[omni-bridge] Spawning session for ${key}...`);
      const session = await this.executor.spawn(message.agent, message.chatId, spawnEnv, message.content);

      // Reset arrived while spawn was in flight — tear down the freshly-created
      // session and bail. The placeholder was already removed from the map by
      // handleSessionReset, so we don't need to clean it up here.
      if (placeholder.cancelled) {
        console.log(`[omni-bridge] Spawn for ${key} completed but was cancelled by reset, shutting down`);
        try {
          await this.executor.shutdown(session);
        } catch (err) {
          console.warn(`[omni-bridge] Error shutting down cancelled spawn for ${key}:`, err);
        }
        return;
      }

      placeholder.session = session;
      placeholder.spawning = false;

      // Record session in PG for crash recovery
      if (this.sessionStore) {
        const pgId = await this.safePgCall(
          'session_create',
          (sql) =>
            new BridgeSessionStore(sql).create({
              instanceId: message.instanceId,
              chatId: message.chatId,
              agentName: message.agent,
              executorId: session.sdk?.executorId,
              tmuxPaneId: session.tmux?.paneId,
              claudeSessionId: session.sdk?.claudeSessionId,
            }),
          undefined,
          { chatId: message.chatId },
        );
        if (pgId) placeholder.pgBridgeSessionId = pgId;
      }

      // Deliver buffered messages
      for (const buffered of placeholder.buffer) {
        await this.executor.deliver(session, buffered);
      }
      placeholder.buffer = [];

      // Start idle timer
      this.resetIdleTimer(key);

      const sessionTag = session.executorType === 'tmux' ? `(tmux pane=${session.tmux?.paneId})` : '(executor=sdk)';
      console.log(`[omni-bridge] Session active: ${key} ${sessionTag}`);
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
      await this.removeSession(key);

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
        await this.removeSession(key);
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
        await this.removeSession(key);
      }
    }
  }

  /**
   * Remove a session and clean up its idle timer.
   * Awaits PG close before deleting the in-memory entry to prevent
   * a replacement session from being created while the old row is still active.
   */
  private async removeSession(key: string): Promise<void> {
    const entry = this.sessions.get(key);
    if (entry?.idleTimer) clearTimeout(entry.idleTimer);
    // Close session in PG — await to prevent duplicate active rows
    const closeId = entry?.pgBridgeSessionId;
    if (closeId && this.sessionStore) {
      await this.safePgCall('session_close', (sql) => new BridgeSessionStore(sql).close(closeId), undefined);
    }
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
