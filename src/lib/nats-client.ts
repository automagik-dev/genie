/**
 * NATS Client — Lazy singleton with graceful degradation.
 *
 * Connects to NATS on first publish/subscribe. If NATS is unavailable,
 * all methods no-op silently (logs a warning once). Connection is reused
 * across calls (singleton pattern).
 *
 * Uses dynamic import so `nats` is an optional peer dependency —
 * if the package isn't installed, operations degrade gracefully.
 */

// ============================================================================
// Types
// ============================================================================

/** Callback for NATS message subscription */
export type NatsMessageCallback = (subject: string, data: unknown) => void;

/** Subscription handle returned by subscribe() */
export interface NatsSubscription {
  unsubscribe: () => void;
}

/** Internal NATS connection state */
interface NatsState {
  connection: NatsConnection | null;
  codec: NatsCodec | null;
  connecting: Promise<boolean> | null;
  warnedUnavailable: boolean;
  warnedMissingPackage: boolean;
  closed: boolean;
}

// Minimal type aliases for the nats package (avoid hard dependency on @types)
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

const state: NatsState = {
  connection: null,
  codec: null,
  connecting: null,
  warnedUnavailable: false,
  warnedMissingPackage: false,
  closed: false,
};

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

/**
 * Dynamically import the nats package. Returns null if not installed.
 */
async function importNats(): Promise<{
  connect: (opts: Record<string, unknown>) => Promise<NatsConnection>;
  JSONCodec: () => NatsCodec;
} | null> {
  try {
    // Use variable to prevent TypeScript from resolving the module at compile time
    const pkg = 'nats';
    return await import(/* webpackIgnore: true */ pkg);
  } catch {
    warnOnce('warnedMissingPackage', 'nats package not installed — real-time features disabled');
    return null;
  }
}

/**
 * Ensure a NATS connection exists. Returns true if connected, false if unavailable.
 * Uses a connecting promise to deduplicate concurrent connection attempts.
 */
async function ensureConnection(): Promise<boolean> {
  if (state.closed) return false;
  if (state.connection && !state.connection.isClosed()) return true;

  // Deduplicate concurrent connection attempts
  if (state.connecting) return state.connecting;

  state.connecting = (async () => {
    try {
      const natsModule = await importNats();
      if (!natsModule) return false;

      const url = getNatsUrl();
      state.connection = await natsModule.connect({
        servers: url,
        maxReconnectAttempts: 3,
        reconnectTimeWait: 1000,
      });
      state.codec = natsModule.JSONCodec();

      // Reset warning so reconnections are silent
      state.warnedUnavailable = false;
      return true;
    } catch {
      state.connection = null;
      state.codec = null;
      warnOnce('warnedUnavailable', `NATS not available at ${getNatsUrl()} — operating without real-time events`);
      return false;
    } finally {
      state.connecting = null;
    }
  })();

  return state.connecting;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Publish a message to a NATS subject. Fire-and-forget.
 * No-ops silently if NATS is unavailable.
 */
export async function publish(subject: string, data: unknown): Promise<void> {
  const connected = await ensureConnection();
  if (!connected || !state.connection || !state.codec) return;

  try {
    const payload = state.codec.encode(data);
    state.connection.publish(subject, payload);
  } catch {
    // Fire-and-forget — swallow publish errors
  }
}

/**
 * Subscribe to a NATS subject. The callback receives decoded JSON messages.
 * Returns a subscription handle with unsubscribe(). No-ops if NATS unavailable.
 */
export async function subscribe(subject: string, callback: NatsMessageCallback): Promise<NatsSubscription> {
  const noop: NatsSubscription = { unsubscribe: () => {} };

  const connected = await ensureConnection();
  if (!connected || !state.connection || !state.codec) return noop;

  try {
    const sub = state.connection.subscribe(subject);
    const codec = state.codec;

    // Process messages in background
    const processMessages = async () => {
      try {
        for await (const msg of sub) {
          try {
            const decoded = codec.decode(msg.data);
            callback(msg.subject, decoded);
          } catch {
            // Skip malformed messages
          }
        }
      } catch {
        // Iterator ends on connection close — expected
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
      },
    };
  } catch {
    return noop;
  }
}

/**
 * Check if NATS is currently reachable.
 * Attempts a connection if not already connected.
 */
export async function isAvailable(): Promise<boolean> {
  return ensureConnection();
}

/**
 * Gracefully close the NATS connection.
 * Safe to call multiple times.
 */
export async function close(): Promise<void> {
  state.closed = true;
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

/**
 * Reset internal state. Intended for testing only.
 */
export function _resetForTesting(): void {
  state.connection = null;
  state.codec = null;
  state.connecting = null;
  state.warnedUnavailable = false;
  state.warnedMissingPackage = false;
  state.closed = false;
}
