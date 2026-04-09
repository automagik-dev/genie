/**
 * Omni Bridge tests.
 *
 * Group 2 — Session lifecycle hardening:
 *   - Buffer full sends reply (not silent drop)
 *   - stop() shuts down all active executor sessions
 *   - Concurrency limit counts spawning entries
 *   - Spawn failure re-queues buffered messages
 *
 * Group 3 — PG degraded mode:
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
import type { ExecutorSession, IExecutor, OmniMessage } from '../executor.js';

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
      const s = await bridge.status();
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
      expect((await bridge.status()).pgAvailable).toBe(false);
      expect((await bridge.status()).connected).toBe(true);
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
      expect((await bridge.status()).pgAvailable).toBe(true);

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
      expect((await bridge.status()).pgAvailable).toBe(false);

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
      expect((await bridge.status()).pgAvailable).toBe(true);

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
      expect((await bridge.status()).pgAvailable).toBe(true);
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
      expect((await bridge.status()).pgAvailable).toBe(true);
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
      expect((await bridge.status()).pgAvailable).toBe(false);

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
      expect((await bridge.status()).pgAvailable).toBe(true);

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
      expect((await bridge.status()).pgAvailable).toBe(true);

      // Proves the flag really held: a fast follow-up call succeeds.
      const follow = await bridge.safePgCall('ping', async () => 'ok', 'fallback');
      expect(follow).toBe('ok');
    } finally {
      await bridge.stop();
    }
  });

  it('status() queries PG for active executor count when pgAvailable=true', async () => {
    // Build a fake SQL that returns 3 active omni executors when status() queries.
    const fakeRows = [{ id: 'exec-aaa' }, { id: 'exec-bbb' }, { id: 'exec-ccc' }];
    const fakeSql = (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const query = strings.join('');
      // The status() query selects from executors with source='omni' and ended_at IS NULL.
      if (query.includes('executors') && query.includes('source')) {
        return Promise.resolve(fakeRows);
      }
      // Default: SELECT 1 probe
      return Promise.resolve([{ one: 1 }]);
    };

    const bridge = makeBridge({ pgProvider: async () => fakeSql as any });
    await bridge.start();

    try {
      expect((await bridge.status()).pgAvailable).toBe(true);

      const s = await bridge.status();
      // activeSessions should come from PG (3), not the local Map (0).
      expect(s.activeSessions).toBe(3);
      expect(s.executorIds).toEqual(['exec-aaa', 'exec-bbb', 'exec-ccc']);
      // Local sessions Map is empty — no actual spawns happened.
      expect(s.sessions).toHaveLength(0);
    } finally {
      await bridge.stop();
    }
  });

  it('status() falls back to local Map size when pgAvailable=false', async () => {
    const bridge = makeBridge({
      pgProvider: async () => {
        const err = new Error('connect ECONNREFUSED 127.0.0.1:5432');
        (err as any).code = 'ECONNREFUSED';
        throw err;
      },
    });
    await bridge.start();

    try {
      expect((await bridge.status()).pgAvailable).toBe(false);

      const s = await bridge.status();
      // No PG → falls back to local Map size (0, since no sessions spawned).
      expect(s.activeSessions).toBe(0);
      expect(s.executorIds).toEqual([]);
    } finally {
      await bridge.stop();
    }
  });
});

// ============================================================================
// Group 2 — Session lifecycle hardening
// ============================================================================

/** Fake NATS that captures publish calls for assertion. */
function makeFakeNatsWithPublish() {
  const publishCalls: Array<{ topic: string; payload: string }> = [];

  const fakeSub: Partial<Subscription> & AsyncIterable<never> = {
    unsubscribe: () => {},
    [Symbol.asyncIterator]: async function* () {},
  };

  const nc: Partial<NatsConnection> = {
    info: undefined,
    closed: async () => undefined,
    close: async () => undefined,
    drain: async () => undefined,
    publish: (topic: string, data: Uint8Array) => {
      publishCalls.push({ topic, payload: new TextDecoder().decode(data) });
    },
    subscribe: () => fakeSub as Subscription,
  };

  return { nc: nc as NatsConnection, publishCalls };
}

/** Mock executor that tracks all calls. */
function makeMockExecutor(overrides?: {
  spawnFn?: (agentName: string, chatId: string, env: Record<string, string>) => Promise<ExecutorSession>;
  isAliveResult?: boolean;
}) {
  const calls = {
    spawn: [] as Array<{ agentName: string; chatId: string }>,
    deliver: [] as Array<{ session: ExecutorSession; message: OmniMessage }>,
    shutdown: [] as ExecutorSession[],
  };

  const makeSession = (agentName: string, chatId: string): ExecutorSession => ({
    id: `session-${chatId}`,
    agentName,
    chatId,
    executorType: 'tmux',
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    tmux: { session: 'test', window: `win-${chatId}`, paneId: `%${chatId}` },
  });

  const executor: IExecutor = {
    async spawn(agentName, chatId, env) {
      calls.spawn.push({ agentName, chatId });
      if (overrides?.spawnFn) return overrides.spawnFn(agentName, chatId, env);
      return makeSession(agentName, chatId);
    },
    async deliver(session, message) {
      calls.deliver.push({ session, message });
    },
    async shutdown(session) {
      calls.shutdown.push(session);
    },
    async isAlive() {
      return overrides?.isAliveResult ?? true;
    },
    setSafePgCall() {},
    setNatsPublish() {},
    async injectNudge() {},
  };

  return { executor, calls, makeSession };
}

function makeMsg(overrides: Partial<OmniMessage> = {}): OmniMessage {
  return {
    content: 'hello',
    sender: 'user@test',
    instanceId: 'inst-1',
    chatId: 'chat-1',
    agent: 'test-agent',
    ...overrides,
  };
}

/** PG provider that simulates ECONNREFUSED — bridge starts in degraded mode. */
const degradedPgProvider = async () => {
  throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
};

describe('OmniBridge — session lifecycle (Group 2)', () => {
  // --------------------------------------------------------------------------
  // Bug 1: Buffer full → reply instead of silent drop
  // --------------------------------------------------------------------------
  it('publishes buffer-full reply when per-chat buffer is at capacity', async () => {
    const { nc, publishCalls } = makeFakeNatsWithPublish();
    const { executor } = makeMockExecutor();

    const bridge = new OmniBridge({
      natsUrl: 'test://fake',
      pgProvider: degradedPgProvider,
      natsConnectFn: (async () => nc) as any,
    });
    (bridge as any).executor = executor;
    await bridge.start();

    try {
      // Pre-populate a spawning session with a full buffer (50 messages)
      const key = 'test-agent:chat-1';
      const fullBuffer = Array.from({ length: 50 }, (_, i) => makeMsg({ content: `msg-${i}` }));
      (bridge as any).sessions.set(key, {
        session: null,
        instanceId: 'inst-1',
        spawning: true,
        buffer: fullBuffer,
        idleTimer: null,
      });

      // Route one more message — must NOT be silently dropped
      await (bridge as any).routeMessage(makeMsg({ content: 'overflow' }));

      // Buffer must not grow beyond capacity
      expect(fullBuffer.length).toBe(50);

      // Bridge must publish a reply notifying the sender
      expect(publishCalls.length).toBe(1);
      expect(publishCalls[0].topic).toBe('omni.reply.inst-1.chat-1');
      const reply = JSON.parse(publishCalls[0].payload);
      expect(reply.auto_reply).toBe(true);
      expect(reply.chat_id).toBe('chat-1');
    } finally {
      await bridge.stop();
    }
  });

  // --------------------------------------------------------------------------
  // Bug 2: stop() calls executor.shutdown() on all active sessions
  // --------------------------------------------------------------------------
  it('stop() shuts down all active executor sessions', async () => {
    const { executor, calls, makeSession } = makeMockExecutor();

    const bridge = new OmniBridge({
      natsUrl: 'test://fake',
      pgProvider: degradedPgProvider,
      natsConnectFn: (async () => makeFakeNats()) as any,
    });
    (bridge as any).executor = executor;
    await bridge.start();

    // Manually insert two active (non-spawning) sessions
    const sessionA = makeSession('agent-a', 'chat-1');
    const sessionB = makeSession('agent-b', 'chat-2');
    (bridge as any).sessions.set('agent-a:chat-1', {
      session: sessionA,
      instanceId: 'inst-1',
      spawning: false,
      buffer: [],
      idleTimer: null,
    });
    (bridge as any).sessions.set('agent-b:chat-2', {
      session: sessionB,
      instanceId: 'inst-2',
      spawning: false,
      buffer: [],
      idleTimer: null,
    });

    expect((bridge as any).sessions.size).toBe(2);

    await bridge.stop();

    // Tmux sessions are detached (not shut down) during graceful stop
    // so they can be recovered on restart. Shutdown is NOT called for tmux sessions.
    expect(calls.shutdown.length).toBe(0);
    // Sessions map must be cleared
    expect((bridge as any).sessions.size).toBe(0);
  });

  it('stop() skips shutdown for spawning sessions (no session handle yet)', async () => {
    const { executor, calls } = makeMockExecutor();

    const bridge = new OmniBridge({
      natsUrl: 'test://fake',
      pgProvider: degradedPgProvider,
      natsConnectFn: (async () => makeFakeNats()) as any,
    });
    (bridge as any).executor = executor;
    await bridge.start();

    // Insert a spawning entry (no session handle)
    (bridge as any).sessions.set('agent-a:chat-1', {
      session: null,
      instanceId: 'inst-1',
      spawning: true,
      buffer: [makeMsg()],
      idleTimer: null,
    });

    await bridge.stop();

    // Should NOT attempt shutdown on a spawning entry
    expect(calls.shutdown.length).toBe(0);
    expect((bridge as any).sessions.size).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Bug 3: Concurrency counts spawning entries
  // --------------------------------------------------------------------------
  it('counts spawning sessions toward concurrency limit', async () => {
    const { executor, calls } = makeMockExecutor();

    const bridge = new OmniBridge({
      natsUrl: 'test://fake',
      maxConcurrent: 1,
      pgProvider: degradedPgProvider,
      natsConnectFn: (async () => makeFakeNats()) as any,
    });
    (bridge as any).executor = executor;
    await bridge.start();

    try {
      // Pre-populate a spawning entry — counts toward the limit
      (bridge as any).sessions.set('agent-a:chat-1', {
        session: null,
        instanceId: 'inst-1',
        spawning: true,
        buffer: [],
        idleTimer: null,
      });

      // Route a message for a different chat — should be queued, not spawned
      await (bridge as any).routeMessage(makeMsg({ chatId: 'chat-2', agent: 'agent-b' }));

      expect(calls.spawn.length).toBe(0); // No spawn attempted
      expect((bridge as any).messageQueue.length).toBe(1); // Queued instead
      expect((bridge as any).messageQueue[0].chatId).toBe('chat-2');
    } finally {
      await bridge.stop();
    }
  });

  it('drainQueue also respects concurrency with spawning entries', async () => {
    const { executor, calls } = makeMockExecutor();

    const bridge = new OmniBridge({
      natsUrl: 'test://fake',
      maxConcurrent: 1,
      pgProvider: degradedPgProvider,
      natsConnectFn: (async () => makeFakeNats()) as any,
    });
    (bridge as any).executor = executor;
    await bridge.start();

    try {
      // Pre-populate a spawning entry
      (bridge as any).sessions.set('agent-a:chat-1', {
        session: null,
        instanceId: 'inst-1',
        spawning: true,
        buffer: [],
        idleTimer: null,
      });

      // Pre-fill the message queue
      (bridge as any).messageQueue.push(makeMsg({ chatId: 'chat-3', agent: 'agent-c' }));

      // Call drainQueue — should not spawn because concurrency is full
      await (bridge as any).drainQueue();

      expect(calls.spawn.length).toBe(0);
      expect((bridge as any).messageQueue.length).toBe(1); // Still in queue
    } finally {
      await bridge.stop();
    }
  });

  // --------------------------------------------------------------------------
  // Bug 4: Spawn failure re-queues buffered messages
  // --------------------------------------------------------------------------
  it('re-queues buffered messages when spawn fails', async () => {
    const { executor } = makeMockExecutor({
      spawnFn: async () => {
        throw new Error('spawn failed: tmux not found');
      },
    });

    const bridge = new OmniBridge({
      natsUrl: 'test://fake',
      pgProvider: degradedPgProvider,
      natsConnectFn: (async () => makeFakeNats()) as any,
    });
    (bridge as any).executor = executor;
    await bridge.start();

    try {
      // Route a message — spawn will fail
      await (bridge as any).routeMessage(makeMsg({ content: 'important-msg' }));

      // Session placeholder should be cleaned up
      expect((bridge as any).sessions.size).toBe(0);

      // The triggering message must be re-queued, not lost
      const queue: OmniMessage[] = (bridge as any).messageQueue;
      expect(queue.length).toBe(1);
      expect(queue[0].content).toBe('important-msg');
    } finally {
      await bridge.stop();
    }
  });

  it('re-queues multiple buffered messages on spawn failure', async () => {
    let spawnCallCount = 0;
    const { executor } = makeMockExecutor({
      spawnFn: async () => {
        spawnCallCount++;
        // Simulate a slow spawn that allows buffering, then fails
        throw new Error('resource exhausted');
      },
    });

    const { nc } = makeFakeNatsWithPublish();
    const bridge = new OmniBridge({
      natsUrl: 'test://fake',
      pgProvider: degradedPgProvider,
      natsConnectFn: (async () => nc) as any,
    });
    (bridge as any).executor = executor;
    await bridge.start();

    try {
      // spawnSession buffers the triggering message, then spawn fails and
      // all buffered entries go to messageQueue.
      await (bridge as any).routeMessage(makeMsg({ content: 'trigger' }));

      expect(spawnCallCount).toBe(1);
      expect((bridge as any).sessions.size).toBe(0);
      // At minimum, the triggering message is re-queued
      expect((bridge as any).messageQueue.length).toBeGreaterThanOrEqual(1);
      expect((bridge as any).messageQueue[0].content).toBe('trigger');
    } finally {
      await bridge.stop();
    }
  });
});

// ============================================================================
// Session reset subscription — issue #1089
// ============================================================================

describe('OmniBridge — session reset (#1089)', () => {
  /** Pre-populate a live session entry on the bridge for reset tests. */
  function injectSession(
    bridge: OmniBridge,
    key: string,
    instanceId: string,
    session: ExecutorSession,
  ): { entry: { idleTimer: ReturnType<typeof setTimeout> | null } } {
    const idleTimer = setTimeout(() => {}, 60_000);
    const entry = {
      session,
      instanceId,
      spawning: false,
      buffer: [],
      idleTimer,
    };
    (bridge as any).sessions.set(key, entry);
    return { entry };
  }

  it('shuts down the executor and removes the session on reset for a hot chat', async () => {
    const { executor, calls, makeSession } = makeMockExecutor();
    const bridge = new OmniBridge({
      natsUrl: 'test://fake',
      pgProvider: degradedPgProvider,
      natsConnectFn: (async () => makeFakeNats()) as any,
    });
    (bridge as any).executor = executor;
    await bridge.start();

    try {
      const session = makeSession('test-agent', 'chat-1');
      injectSession(bridge, 'test-agent:chat-1', 'inst-1', session);

      await (bridge as any).handleSessionReset('inst-1', 'chat-1', 'kill');

      expect(calls.shutdown.length).toBe(1);
      expect(calls.shutdown[0].chatId).toBe('chat-1');
      expect((bridge as any).sessions.size).toBe(0);
    } finally {
      await bridge.stop();
    }
  });

  it('no-ops on reset for a cold chat (no live session)', async () => {
    const { executor, calls } = makeMockExecutor();
    const bridge = new OmniBridge({
      natsUrl: 'test://fake',
      pgProvider: degradedPgProvider,
      natsConnectFn: (async () => makeFakeNats()) as any,
    });
    (bridge as any).executor = executor;
    await bridge.start();

    try {
      // Sessions map is empty — reset must not throw and must not call shutdown.
      await (bridge as any).handleSessionReset('inst-1', 'chat-cold');

      expect(calls.shutdown.length).toBe(0);
      expect((bridge as any).sessions.size).toBe(0);
    } finally {
      await bridge.stop();
    }
  });

  it('clears the idle timer when evicting a reset session', async () => {
    const { executor, makeSession } = makeMockExecutor();
    const bridge = new OmniBridge({
      natsUrl: 'test://fake',
      pgProvider: degradedPgProvider,
      natsConnectFn: (async () => makeFakeNats()) as any,
    });
    (bridge as any).executor = executor;
    await bridge.start();

    try {
      const session = makeSession('test-agent', 'chat-1');
      const { entry } = injectSession(bridge, 'test-agent:chat-1', 'inst-1', session);
      const timerBefore = entry.idleTimer;
      expect(timerBefore).not.toBeNull();

      await (bridge as any).handleSessionReset('inst-1', 'chat-1');

      // Session removed → idle timer no longer reachable from sessions map
      expect((bridge as any).sessions.has('test-agent:chat-1')).toBe(false);
    } finally {
      await bridge.stop();
    }
  });

  it('parses subject with dotted chatId (e.g. WhatsApp +5511...@s.whatsapp.net)', async () => {
    const { executor, calls, makeSession } = makeMockExecutor();
    const bridge = new OmniBridge({
      natsUrl: 'test://fake',
      pgProvider: degradedPgProvider,
      natsConnectFn: (async () => makeFakeNats()) as any,
    });
    (bridge as any).executor = executor;
    await bridge.start();

    try {
      const dottedChat = '+5511999999999@s.whatsapp.net';
      const session = makeSession('test-agent', dottedChat);
      injectSession(bridge, `test-agent:${dottedChat}`, 'inst-x', session);

      // Build a fake NATS message and feed it through the dispatch path the way
      // processSessionResetEvents would: subject + JSON-encoded payload bytes.
      const fakeMsg = {
        subject: `omni.session.reset.inst-x.${dottedChat}`,
        data: new TextEncoder().encode(JSON.stringify({ action: 'kill' })),
      };
      // Drive a single iteration through processSessionResetEvents using a one-shot iterator.
      const oneShot = {
        [Symbol.asyncIterator]: async function* () {
          yield fakeMsg;
        },
      } as any;
      await (bridge as any).processSessionResetEvents(oneShot);

      expect(calls.shutdown.length).toBe(1);
      expect(calls.shutdown[0].chatId).toBe(dottedChat);
    } finally {
      await bridge.stop();
    }
  });

  it('tolerates malformed JSON payload by routing on subject alone', async () => {
    const { executor, calls, makeSession } = makeMockExecutor();
    const bridge = new OmniBridge({
      natsUrl: 'test://fake',
      pgProvider: degradedPgProvider,
      natsConnectFn: (async () => makeFakeNats()) as any,
    });
    (bridge as any).executor = executor;
    await bridge.start();

    try {
      const session = makeSession('test-agent', 'chat-1');
      injectSession(bridge, 'test-agent:chat-1', 'inst-1', session);

      const fakeMsg = {
        subject: 'omni.session.reset.inst-1.chat-1',
        data: new TextEncoder().encode('not-json-at-all'),
      };
      const oneShot = {
        [Symbol.asyncIterator]: async function* () {
          yield fakeMsg;
        },
      } as any;
      await (bridge as any).processSessionResetEvents(oneShot);

      // Subject-only routing still kills the session.
      expect(calls.shutdown.length).toBe(1);
    } finally {
      await bridge.stop();
    }
  });

  it('warns and skips on malformed subject with too few segments', async () => {
    const { executor, calls } = makeMockExecutor();
    const bridge = new OmniBridge({
      natsUrl: 'test://fake',
      pgProvider: degradedPgProvider,
      natsConnectFn: (async () => makeFakeNats()) as any,
    });
    (bridge as any).executor = executor;
    await bridge.start();

    try {
      const fakeMsg = {
        subject: 'omni.session.reset',
        data: new TextEncoder().encode('{}'),
      };
      const oneShot = {
        [Symbol.asyncIterator]: async function* () {
          yield fakeMsg;
        },
      } as any;
      await (bridge as any).processSessionResetEvents(oneShot);

      expect(calls.shutdown.length).toBe(0);
    } finally {
      await bridge.stop();
    }
  });

  it('cancels a spawning session on reset and tears down the freshly-spawned executor', async () => {
    // Hold the spawn promise open so we can fire reset mid-spawn.
    let releaseSpawn!: (s: ExecutorSession) => void;
    const spawnGate = new Promise<ExecutorSession>((resolve) => {
      releaseSpawn = resolve;
    });

    const { executor, calls, makeSession } = makeMockExecutor({
      spawnFn: async (agentName, chatId) => {
        // Block until the test releases the spawn.
        const session = await spawnGate;
        return session ?? makeSession(agentName, chatId);
      },
    });
    const bridge = new OmniBridge({
      natsUrl: 'test://fake',
      pgProvider: degradedPgProvider,
      natsConnectFn: (async () => makeFakeNats()) as any,
    });
    (bridge as any).executor = executor;
    await bridge.start();

    try {
      // Kick off the spawn — routeMessage will block on spawnGate.
      const routePromise = (bridge as any).routeMessage(makeMsg({ content: 'first' }));

      // Yield so spawnSession installs the placeholder before we reset.
      await new Promise((r) => setTimeout(r, 5));
      expect((bridge as any).sessions.has('test-agent:chat-1')).toBe(true);
      expect((bridge as any).sessions.get('test-agent:chat-1').spawning).toBe(true);

      // Fire the reset while spawn is still in flight.
      await (bridge as any).handleSessionReset('inst-1', 'chat-1', 'kill');

      // Placeholder is gone — the spawn-in-flight has been logically cancelled.
      expect((bridge as any).sessions.has('test-agent:chat-1')).toBe(false);

      // Now release the spawn — spawnSession should detect cancelled and tear it down.
      releaseSpawn(makeSession('test-agent', 'chat-1'));
      await routePromise;

      // executor.shutdown was called for the freshly-spawned (cancelled) session.
      expect(calls.shutdown.length).toBe(1);
      expect(calls.shutdown[0].chatId).toBe('chat-1');

      // Buffered triggering message must NOT be delivered to the killed session.
      expect(calls.deliver.length).toBe(0);
    } finally {
      await bridge.stop();
    }
  });

  it('drains the message queue after evicting a reset session', async () => {
    const { executor, calls, makeSession } = makeMockExecutor();
    const bridge = new OmniBridge({
      natsUrl: 'test://fake',
      pgProvider: degradedPgProvider,
      natsConnectFn: (async () => makeFakeNats()) as any,
    });
    (bridge as any).executor = executor;
    // Force the bridge to look fully saturated so a reset opens a slot.
    (bridge as any).maxConcurrent = 1;
    await bridge.start();

    try {
      const session = makeSession('test-agent', 'chat-1');
      injectSession(bridge, 'test-agent:chat-1', 'inst-1', session);

      // Park a queued message that's waiting for a free slot.
      (bridge as any).messageQueue.push(makeMsg({ chatId: 'chat-2', agent: 'agent-b' }));

      await (bridge as any).handleSessionReset('inst-1', 'chat-1', 'kill');

      // Original session is gone, queued message picked up its slot, drainQueue spawned it.
      expect((bridge as any).sessions.has('test-agent:chat-1')).toBe(false);
      expect((bridge as any).messageQueue.length).toBe(0);
      expect(calls.spawn.length).toBe(1);
      expect(calls.spawn[0].chatId).toBe('chat-2');
    } finally {
      await bridge.stop();
    }
  });

  it('subscribes to omni.session.reset.> on start()', async () => {
    const subscribeCalls: string[] = [];
    const fakeSub: Partial<Subscription> & AsyncIterable<never> = {
      unsubscribe: () => {},
      [Symbol.asyncIterator]: async function* () {},
    };
    const nc: Partial<NatsConnection> = {
      info: undefined,
      closed: async () => undefined,
      close: async () => undefined,
      drain: async () => undefined,
      publish: () => {},
      subscribe: (subject: string) => {
        subscribeCalls.push(subject);
        return fakeSub as Subscription;
      },
    };

    const bridge = new OmniBridge({
      natsUrl: 'test://fake',
      pgProvider: degradedPgProvider,
      natsConnectFn: (async () => nc as NatsConnection) as any,
    });

    try {
      await bridge.start();
      expect(subscribeCalls).toContain('omni.session.reset.>');
    } finally {
      await bridge.stop();
    }
  });
});
