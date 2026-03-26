/**
 * NATS Client — Lazy singleton with auto-cleanup.
 *
 * - Connects lazily on first use
 * - Auto-closes after 500ms idle (no pending subscribes)
 * - Long-lived subscribers keep the connection alive
 * - All methods no-op silently if NATS unavailable
 * - Connection is reused across calls (singleton)
 */

// ============================================================================
// Types
// ============================================================================

type NatsMessageCallback = (subject: string, data: unknown) => void;

interface NatsSubscription {
  unsubscribe: () => void;
}

// Minimal type aliases (avoid hard dependency on @types/nats)
interface NatsConnection {
  publish(subject: string, data?: Uint8Array): void;
  subscribe(subject: string): NatsSubscriptionIter;
  drain(): Promise<void>;
  close(): Promise<void>;
  isClosed(): boolean;
}

interface NatsSubscriptionIter {
  unsubscribe(): void;
  [Symbol.asyncIterator](): AsyncIterator<NatsMsg>;
}

interface NatsMsg {
  subject: string;
  data: Uint8Array;
}

interface NatsCodec {
  encode(data: unknown): Uint8Array;
  decode(data: Uint8Array): unknown;
}

// ============================================================================
// Singleton State
// ============================================================================

const state = {
  connection: null as NatsConnection | null,
  codec: null as NatsCodec | null,
  connecting: null as Promise<boolean> | null,
  warnedUnavailable: false,
  warnedMissingPackage: false,
  activeSubscriptions: 0,
  idleTimer: null as ReturnType<typeof setTimeout> | null,
};

const IDLE_TIMEOUT_MS = 500;

// ============================================================================
// Internal Helpers
// ============================================================================

function getNatsUrl(): string {
  return process.env.GENIE_NATS_URL || 'nats://localhost:4222';
}

function warnOnce(key: 'warnedUnavailable' | 'warnedMissingPackage', message: string): void {
  if (!state[key]) {
    state[key] = true;
    console.warn(`[genie:nats] ${message}`);
  }
}

async function importNats(): Promise<{
  connect: (opts: Record<string, unknown>) => Promise<NatsConnection>;
  JSONCodec: () => NatsCodec;
} | null> {
  try {
    const pkg = 'nats';
    return await import(/* webpackIgnore: true */ pkg);
  } catch {
    warnOnce('warnedMissingPackage', 'nats package not installed — real-time features disabled');
    return null;
  }
}

async function ensureConnection(): Promise<boolean> {
  if (state.connection && !state.connection.isClosed()) {
    resetIdleTimer();
    return true;
  }

  if (state.connecting) return state.connecting;

  state.connecting = (async () => {
    try {
      const natsModule = await importNats();
      if (!natsModule) return false;

      state.connection = await natsModule.connect({
        servers: getNatsUrl(),
        maxReconnectAttempts: 2,
        reconnectTimeWait: 500,
        timeout: 2000,
      });
      state.codec = natsModule.JSONCodec();
      state.warnedUnavailable = false;
      resetIdleTimer();
      return true;
    } catch {
      state.connection = null;
      state.codec = null;
      warnOnce('warnedUnavailable', `NATS not available at ${getNatsUrl()}`);
      return false;
    } finally {
      state.connecting = null;
    }
  })();

  return state.connecting;
}

/** Schedule auto-close if no active subscriptions. */
function resetIdleTimer(): void {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  if (state.activeSubscriptions > 0) return; // subscribers keep it alive
  state.idleTimer = setTimeout(() => {
    if (state.activeSubscriptions === 0) {
      close().catch(() => {});
    }
  }, IDLE_TIMEOUT_MS);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Publish a message. Fire-and-forget.
 * Connection auto-closes after idle if no active subscriptions.
 */
export async function publish(subject: string, data: unknown): Promise<void> {
  const connected = await ensureConnection();
  if (!connected || !state.connection || !state.codec) return;

  try {
    state.connection.publish(subject, state.codec.encode(data));
  } catch {
    // Swallow publish errors
  }
  resetIdleTimer();
}

/**
 * Subscribe to a NATS subject.
 * Keeps connection alive until unsubscribed.
 */
export async function subscribe(subject: string, callback: NatsMessageCallback): Promise<NatsSubscription> {
  const noop: NatsSubscription = { unsubscribe: () => {} };

  const connected = await ensureConnection();
  if (!connected || !state.connection || !state.codec) return noop;

  try {
    const sub = state.connection.subscribe(subject);
    const codec = state.codec;
    state.activeSubscriptions++;

    // Clear idle timer — subscriptions keep connection alive
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }

    const processMessages = async () => {
      try {
        for await (const msg of sub) {
          try {
            callback(msg.subject, codec.decode(msg.data));
          } catch {
            // Skip malformed messages
          }
        }
      } catch {
        // Iterator ends on connection close
      }
    };
    processMessages();

    return {
      unsubscribe: () => {
        try {
          sub.unsubscribe();
        } catch {
          // Already unsubscribed
        }
        state.activeSubscriptions = Math.max(0, state.activeSubscriptions - 1);
        resetIdleTimer();
      },
    };
  } catch {
    return noop;
  }
}

/** Check if NATS is reachable. */
export async function isAvailable(): Promise<boolean> {
  return ensureConnection();
}

/** Gracefully close the connection. Safe to call multiple times. */
export async function close(): Promise<void> {
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
  if (state.connection) {
    try {
      await state.connection.drain();
    } catch {
      try {
        await state.connection.close();
      } catch {
        // Already closed
      }
    }
    state.connection = null;
    state.codec = null;
  }
}

/** Reset internal state (testing only). */
export function _resetForTesting(): void {
  state.connection = null;
  state.codec = null;
  state.connecting = null;
  state.warnedUnavailable = false;
  state.warnedMissingPackage = false;
  state.activeSubscriptions = 0;
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = null;
}
