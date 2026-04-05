/**
 * Omni Bridge — PG degraded mode tests (Group 3).
 *
 * Covers every row of the wish's PG Error Handling Strategy table:
 *   - Startup connection failure → degrade gracefully, pgAvailable=false
 *   - Startup schema mismatch    → fail-fast with actionable error
 *   - Mid-run connection loss    → safePgCall returns fallback + flips pgAvailable=false
 *   - Runtime non-connection err → safePgCall returns fallback, pgAvailable stays true
 *   - Slow query > 2s timeout    → safePgCall returns fallback, pgAvailable stays true
 *   - Happy path                 → safePgCall forwards the fn result
 *
 * All tests inject fake NATS + PG so the suite stays hermetic — no real
 * nats-server or postgres required (bun:test preload already boots a test
 * pgserve, but this file deliberately avoids it to exercise the error paths).
 */

import { describe, expect, it } from 'bun:test';
import type { NatsConnection, Subscription } from 'nats';

import { OmniBridge } from '../omni-bridge.js';

// ----------------------------------------------------------------------------
// Fakes
// ----------------------------------------------------------------------------

/** Build a minimal NatsConnection stub — no real socket. */
function makeFakeNats(): NatsConnection {
  const fakeSub: Partial<Subscription> & AsyncIterable<never> = {
    unsubscribe: () => {
      /* no-op */
    },
    // Empty async iterator — `for await ... of` exits immediately,
    // so processSubscription() returns without blocking.
    [Symbol.asyncIterator]: async function* () {
      // yields nothing
    },
  };

  const fake: Partial<NatsConnection> = {
    info: undefined,
    closed: async () => undefined,
    close: async () => undefined,
    drain: async () => undefined,
    publish: () => {
      /* no-op */
    },
    subscribe: () => fakeSub as Subscription,
  };

  return fake as NatsConnection;
}

/** Make a minimal postgres.js tagged-template client that returns a stock row. */
function makeFakeSql(result: unknown = [{ one: 1 }]): any {
  // postgres.js's Sql type is a tagged-template function. A plain function
  // with the same call signature is assignment-compatible via `any`.
  return (_strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve(result);
}

/** Inject fakes into the bridge constructor. */
function makeBridge(overrides: { pgProvider: () => Promise<any>; natsConnectFn?: any }) {
  return new OmniBridge({
    natsUrl: 'test://fake-nats',
    pgProvider: overrides.pgProvider,
    natsConnectFn: overrides.natsConnectFn ?? ((async () => makeFakeNats()) as any),
  });
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('OmniBridge — PG degraded mode', () => {
  it('Test A: start() succeeds and status().pgAvailable=false when PG provider throws', async () => {
    const bridge = makeBridge({
      pgProvider: async () => {
        // Simulates a broken PG connection string — provider cannot build a client.
        const err = new Error('connect ECONNREFUSED 127.0.0.1:1');
        (err as any).code = 'ECONNREFUSED';
        throw err;
      },
    });

    await bridge.start();
    try {
      const s = bridge.status();
      expect(s.connected).toBe(true); // NATS connected via fake
      expect(s.pgAvailable).toBe(false); // PG degraded
      expect(s.natsUrl).toBe('test://fake-nats');
    } finally {
      await bridge.stop();
    }
  });

  it('Test A (variant): degrades when SELECT 1 probe itself throws a connection error', async () => {
    const bridge = makeBridge({
      pgProvider: async () => {
        // Provider returns a client, but SELECT 1 fails with a connection-level error.
        return ((_s: TemplateStringsArray, ..._v: unknown[]) =>
          Promise.reject(new Error('connection terminated unexpectedly'))) as any;
      },
    });

    await bridge.start();
    try {
      expect(bridge.status().pgAvailable).toBe(false);
      expect(bridge.status().connected).toBe(true);
    } finally {
      await bridge.stop();
    }
  });

  it('Test A (fail-fast): throws when probePg hits a schema mismatch (non-connection error)', async () => {
    const bridge = makeBridge({
      pgProvider: async () => {
        // Provider returns a client, but SELECT 1 fails with a schema-level error.
        // This is the "migration missing / schema mismatch" row from the wish's
        // PG Error Handling Strategy table — must fail-fast, not degrade.
        return ((_s: TemplateStringsArray, ..._v: unknown[]) =>
          Promise.reject(new Error('relation "sessions" does not exist'))) as any;
      },
    });

    // start() should propagate the error with a migration hint.
    let caught: unknown;
    try {
      await bridge.start();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain('PG schema mismatch');
    expect(msg).toContain('relation "sessions" does not exist');
    expect(msg.toLowerCase()).toContain('migrate');
  });

  it('Test A (fail-fast variant): throws when the provider itself throws a non-connection error', async () => {
    const bridge = makeBridge({
      pgProvider: async () => {
        const err = new Error('permission denied for table executors');
        (err as any).code = '42501'; // postgres.js error code, not a network code
        throw err;
      },
    });

    let caught: unknown;
    try {
      await bridge.start();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('PG schema mismatch');
    expect((caught as Error).message).toContain('permission denied');
  });

  it('Test B: safePgCall returns fallback and flips pgAvailable on mid-run connection loss', async () => {
    const bridge = makeBridge({ pgProvider: async () => makeFakeSql() });
    await bridge.start();

    try {
      // Startup probe succeeded — we begin in the healthy state.
      expect(bridge.status().pgAvailable).toBe(true);

      // Simulate a mid-run connection loss. safePgCall must:
      //   (a) return the fallback value
      //   (b) flip pgAvailable to false
      //   (c) NOT throw (delivery loop must stay alive)
      const fallback = { recovered: false, id: null as string | null };
      const result = await bridge.safePgCall(
        'executor_state_update',
        async () => {
          throw new Error('connection terminated unexpectedly');
        },
        fallback,
        { executorId: 'exec-abc', chatId: 'chat-xyz' },
      );

      expect(result).toBe(fallback);
      expect(bridge.status().pgAvailable).toBe(false);

      // Delivery loop continuity proxy: further safePgCall invocations are
      // fast-pathed to fallback without invoking fn.
      let secondInvoked = false;
      const second = await bridge.safePgCall(
        'audit_event_insert',
        async () => {
          secondInvoked = true;
          return 'should-not-be-returned';
        },
        'FALLBACK_2' as const,
      );
      expect(second).toBe('FALLBACK_2');
      expect(secondInvoked).toBe(false);
    } finally {
      await bridge.stop();
    }
  });

  it('Test B (variant): non-connection PG errors keep pgAvailable=true', async () => {
    const bridge = makeBridge({ pgProvider: async () => makeFakeSql() });
    await bridge.start();

    try {
      expect(bridge.status().pgAvailable).toBe(true);

      // A SQL-level error (e.g., constraint violation) must NOT degrade the bridge.
      const result = await bridge.safePgCall(
        'session_content_insert',
        async () => {
          throw new Error('duplicate key value violates unique constraint');
        },
        null,
      );
      expect(result).toBeNull();
      // Still healthy — only connection-level errors flip the flag.
      expect(bridge.status().pgAvailable).toBe(true);
    } finally {
      await bridge.stop();
    }
  });

  it('safePgCall returns fn result when PG is healthy', async () => {
    const bridge = makeBridge({ pgProvider: async () => makeFakeSql() });
    await bridge.start();

    try {
      const result = await bridge.safePgCall('ping', async () => ({ value: 42 }), { value: -1 });
      expect(result).toEqual({ value: 42 });
      expect(bridge.status().pgAvailable).toBe(true);
    } finally {
      await bridge.stop();
    }
  });

  it('safePgCall short-circuits to fallback when pgAvailable=false from startup', async () => {
    const bridge = makeBridge({
      pgProvider: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await bridge.start();

    try {
      expect(bridge.status().pgAvailable).toBe(false);

      let invoked = false;
      const result = await bridge.safePgCall(
        'lazy_resume_lookup',
        async () => {
          invoked = true;
          return 'never';
        },
        'degraded',
      );
      expect(result).toBe('degraded');
      expect(invoked).toBe(false);
    } finally {
      await bridge.stop();
    }
  });

  it('slow-query: safePgCall returns fallback when fn exceeds PG_RUNTIME_QUERY_TIMEOUT_MS, pgAvailable stays true', async () => {
    // The wish mandates a 2s read budget. Inject a fn that delays beyond that.
    // A slow query is NOT a connection-level error, so pgAvailable must stay
    // truthy — the next call gets a fresh attempt.
    const bridge = makeBridge({ pgProvider: async () => makeFakeSql() });
    await bridge.start();

    try {
      expect(bridge.status().pgAvailable).toBe(true);

      const started = Date.now();
      const result = await bridge.safePgCall(
        'lazy_resume_lookup',
        () =>
          new Promise<string>((resolve) => {
            // 2500ms > 2000ms runtime budget → withTimeout rejects first
            const t = setTimeout(() => resolve('too-late'), 2500);
            t.unref?.();
          }),
        'fallback-on-timeout',
        { chatId: 'chat-slow' },
      );
      const elapsed = Date.now() - started;

      expect(result).toBe('fallback-on-timeout');
      // Should resolve close to the 2s budget, not wait the full 2.5s.
      expect(elapsed).toBeGreaterThanOrEqual(1900);
      expect(elapsed).toBeLessThan(2400);
      // Critical: timeout != connection loss. Next call should still try fn.
      expect(bridge.status().pgAvailable).toBe(true);

      // Proves the flag really held: a fast follow-up call succeeds.
      const follow = await bridge.safePgCall('ping', async () => 'ok', 'fallback');
      expect(follow).toBe('ok');
    } finally {
      await bridge.stop();
    }
  });
});
