/**
 * Agent Heartbeat Publisher — publishes `omni.agent.heartbeat.{instanceId}.{chatId}`
 * on a configurable cadence while a Claude Code session is busy. Stops within
 * one tick of `stop()` and never outlives the session.
 *
 * Why this exists: omni's turn monitor decides "idle" by counting authenticated
 * API calls from the scoped key. Real Claude Code work — tool calls, file edits,
 * internal SDK loops — does not call back to omni, so 120s of genuine work
 * looked like 120s of idleness and the agent got a `Turn idle for Ns. Are you
 * still working?` nudge mid-task. Heartbeats give omni a measurable busy
 * signal: while one is arriving, `lastActivityAt` keeps advancing and the
 * 120s nudge timer never trips.
 *
 * Wish: omni-activity-heartbeat
 */

import { type NatsConnection, StringCodec } from 'nats';

const DEFAULT_INTERVAL_MS = 30_000;
const MIN_INTERVAL_MS = 5_000;
const MAX_INTERVAL_MS = 60_000;

/** Wire-format payload for `omni.agent.heartbeat.{instanceId}.{chatId}`. */
export interface AgentHeartbeatEvent {
  turnId: string;
  instanceId: string;
  chatId: string;
  /** ISO-8601 timestamp at which the heartbeat was emitted. */
  timestamp: string;
}

/**
 * Per-session state passed to `start()`. The publisher reads `isBusy()`
 * synchronously on each tick — return `false` to suppress the publish for
 * that tick (no NATS traffic emitted).
 */
export interface HeartbeatSessionContext {
  instanceId: string;
  chatId: string;
  turnId: string;
  /**
   * Busy predicate. Called once per tick. When it resolves to `false`, the
   * tick is skipped (no publish). When `true`, the heartbeat is emitted.
   * Async because the tmux executor samples its pane via a shell call.
   * Implementations MUST swallow their own errors and return `false` rather
   * than throwing, so the publisher loop can never crash on a transient failure.
   */
  isBusy: () => boolean | Promise<boolean>;
}

/** Function the publisher calls to push a payload to NATS. */
export type HeartbeatPublishFn = (subject: string, payload: string) => void;

export interface HeartbeatPublisherOptions {
  /**
   * Interval in ms between ticks while a session is registered. Defaults to
   * `OMNI_HEARTBEAT_INTERVAL_MS` env var, then 30000. Always clamped to
   * [5000, 60000] to keep cadence comfortably under omni's 120s nudge
   * threshold.
   */
  intervalMs?: number;
  /**
   * Direct NATS connection — optional when `publish` is supplied. The
   * publisher encodes payloads with a default `StringCodec`.
   */
  natsConnection?: NatsConnection;
  /**
   * Override the publish callback. Tests inject a spy here; production wires
   * a closure over the bridge's NATS connection.
   */
  publish?: HeartbeatPublishFn;
  /** Override `Date.now()` for deterministic tests. */
  now?: () => number;
  /** Override `setInterval` for deterministic tests (fake clocks). */
  setInterval?: typeof globalThis.setInterval;
  /** Override `clearInterval` for deterministic tests. */
  clearInterval?: typeof globalThis.clearInterval;
}

/**
 * Resolve the effective interval: explicit option → env var → default,
 * always clamped to [MIN, MAX]. NaN/negative values fall through to default.
 */
export function resolveHeartbeatIntervalMs(explicit?: number): number {
  const envRaw = process.env.OMNI_HEARTBEAT_INTERVAL_MS;
  const envParsed = envRaw !== undefined ? Number(envRaw) : Number.NaN;
  const candidate = explicit ?? (Number.isFinite(envParsed) && envParsed > 0 ? envParsed : DEFAULT_INTERVAL_MS);
  if (!Number.isFinite(candidate) || candidate <= 0) return DEFAULT_INTERVAL_MS;
  return Math.min(Math.max(candidate, MIN_INTERVAL_MS), MAX_INTERVAL_MS);
}

/** Build the NATS subject for a heartbeat. */
export function heartbeatSubject(instanceId: string, chatId: string): string {
  return `omni.agent.heartbeat.${instanceId}.${chatId}`;
}

/**
 * Manages one `setInterval` per active session. `start(sessionKey, ctx)`
 * begins ticking; `stop(sessionKey)` cancels. `stopAll()` drains every
 * registered session — used on bridge shutdown so heartbeats can never
 * outlive the executor.
 */
export class HeartbeatPublisher {
  private readonly intervalMs: number;
  private readonly publishFn: HeartbeatPublishFn;
  private readonly setIntervalFn: typeof globalThis.setInterval;
  private readonly clearIntervalFn: typeof globalThis.clearInterval;
  private readonly nowFn: () => number;
  private readonly active = new Map<
    string,
    { handle: ReturnType<typeof globalThis.setInterval>; ctx: HeartbeatSessionContext }
  >();

  constructor(options: HeartbeatPublisherOptions = {}) {
    this.intervalMs = resolveHeartbeatIntervalMs(options.intervalMs);
    this.nowFn = options.now ?? Date.now;
    this.setIntervalFn = options.setInterval ?? globalThis.setInterval;
    this.clearIntervalFn = options.clearInterval ?? globalThis.clearInterval;

    if (options.publish) {
      this.publishFn = options.publish;
    } else if (options.natsConnection) {
      const sc = StringCodec();
      const nc = options.natsConnection;
      this.publishFn = (subject, payload) => nc.publish(subject, sc.encode(payload));
    } else {
      this.publishFn = () => {
        /* no-op when neither publish nor natsConnection is supplied */
      };
    }
  }

  /** Effective interval, after clamping. Exposed for tests + observability. */
  getIntervalMs(): number {
    return this.intervalMs;
  }

  /** Number of currently-registered sessions. Exposed for tests. */
  size(): number {
    return this.active.size;
  }

  /**
   * Begin emitting heartbeats for `sessionKey` on `ctx`. Replacing an existing
   * registration is safe — the previous interval is cleared first so we never
   * leak a handle.
   */
  start(sessionKey: string, ctx: HeartbeatSessionContext): void {
    const existing = this.active.get(sessionKey);
    if (existing) {
      this.clearIntervalFn(existing.handle);
    }

    const handle = this.setIntervalFn(() => {
      void this.tick(sessionKey);
    }, this.intervalMs);

    if (typeof (handle as { unref?: () => void }).unref === 'function') {
      (handle as { unref?: () => void }).unref?.();
    }

    this.active.set(sessionKey, { handle, ctx });
  }

  /** Stop heartbeats for `sessionKey`. Idempotent — unknown keys no-op. */
  stop(sessionKey: string): void {
    const entry = this.active.get(sessionKey);
    if (!entry) return;
    this.clearIntervalFn(entry.handle);
    this.active.delete(sessionKey);
  }

  /** Cancel every registered session. Used on bridge shutdown. */
  stopAll(): void {
    for (const [, entry] of this.active) {
      this.clearIntervalFn(entry.handle);
    }
    this.active.clear();
  }

  /**
   * Single tick — checks `isBusy()`, builds the payload, calls publish.
   * Public so tests can advance one tick without juggling fake intervals.
   * Returns the resolved promise so tests can `await publisher.tick(key)`.
   */
  async tick(sessionKey: string): Promise<void> {
    const entry = this.active.get(sessionKey);
    if (!entry) return;

    const { ctx } = entry;
    let busy: boolean;
    try {
      busy = await ctx.isBusy();
    } catch (err) {
      console.warn(
        `[agent-heartbeat] isBusy threw for ${sessionKey} — treating as idle (skip): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    if (!busy) return;

    // Re-check that the session was not stopped while isBusy() was awaited.
    if (!this.active.has(sessionKey)) return;

    const event: AgentHeartbeatEvent = {
      turnId: ctx.turnId,
      instanceId: ctx.instanceId,
      chatId: ctx.chatId,
      timestamp: new Date(this.nowFn()).toISOString(),
    };

    try {
      this.publishFn(heartbeatSubject(ctx.instanceId, ctx.chatId), JSON.stringify(event));
    } catch (err) {
      // NATS publish should never throw under normal conditions, but the
      // delivery loop must survive transient failures.
      console.warn(
        `[agent-heartbeat] publish failed for ${sessionKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
