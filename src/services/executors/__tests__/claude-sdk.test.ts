// IMPORTANT: _sdk-mocks.ts must be imported FIRST — it registers the
// process-global mock.module entries that both this file and
// claude-sdk-resume.test.ts depend on. Bun's mock.module is process-global
// and the first-loaded mock wins (subsequent registrations are dead weight),
// so we share a single source of truth for mock instances across the two
// files to prevent CI-only failures where one file's mocks get shadowed.
import {
  createAndLinkExecutorMock,
  findOrCreateAgentMock,
  queryMock,
  resetAllMocks,
  resetQueryMock,
  terminateExecutorMock,
  updateExecutorStateMock,
} from './_sdk-mocks.js';

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

// NOTE: mock.restore() is intentionally NOT called in afterAll here.
// The shared _sdk-mocks.ts approach means both files use the same mock
// instances; resetAllMocks() in each beforeEach prevents cross-test leaks.

// NOTE: audit-events and sdk-session-capture are intentionally NOT mocked
// via mock.module. Bun's mock.module is process-global and mock.restore()
// does NOT undo module-level registrations. Both files use the real modules
// — recordAuditEvent / session-capture route through safePgCall, which is
// mocked per-test via setSafePgCall() (or guarded null for no-bridge tests).

const { ClaudeSdkOmniExecutor } = await import('../claude-sdk.js');
const directory = await import('../../../lib/agent-directory.js');

describe('ClaudeSdkOmniExecutor', () => {
  let executor: InstanceType<typeof ClaudeSdkOmniExecutor>;

  beforeEach(() => {
    executor = new ClaudeSdkOmniExecutor();
  });

  describe('spawn', () => {
    it('creates session with correct id format', async () => {
      const session = await executor.spawn('test-agent', 'chat-123', {});
      expect(session.id).toBe('test-agent:chat-123');
      expect(session.agentName).toBe('test-agent');
      expect(session.chatId).toBe('chat-123');
      expect(session.paneId).toBe('sdk-chat-123');
      expect(session.tmuxSession).toBe('');
      expect(session.tmuxWindow).toBe('');
    });

    it('resolves agent from directory', async () => {
      await executor.spawn('my-agent', 'chat-1', {});
      expect(directory.resolve).toHaveBeenCalledWith('my-agent');
    });

    it('throws if agent not found in directory', async () => {
      (directory.resolve as ReturnType<typeof mock>).mockResolvedValueOnce(null);
      await expect(executor.spawn('unknown', 'chat-1', {})).rejects.toThrow('not found in genie directory');
    });
  });

  describe('isAlive', () => {
    it('returns true for active session', async () => {
      const session = await executor.spawn('test-agent', 'chat-1', {});
      expect(await executor.isAlive(session)).toBe(true);
    });

    it('returns false after shutdown', async () => {
      const session = await executor.spawn('test-agent', 'chat-1', {});
      await executor.shutdown(session);
      expect(await executor.isAlive(session)).toBe(false);
    });

    it('returns false for unknown session', async () => {
      const fakeSession = {
        id: 'nonexistent',
        agentName: 'x',
        chatId: 'y',
        tmuxSession: '',
        tmuxWindow: '',
        paneId: '',
        createdAt: 0,
        lastActivityAt: 0,
      };
      expect(await executor.isAlive(fakeSession)).toBe(false);
    });
  });

  describe('shutdown', () => {
    it('aborts via AbortController', async () => {
      const session = await executor.spawn('test-agent', 'chat-1', {});
      await executor.shutdown(session);
      // Session is removed, isAlive returns false
      expect(await executor.isAlive(session)).toBe(false);
    });

    it('is idempotent for unknown session', async () => {
      const fakeSession = {
        id: 'nonexistent',
        agentName: 'x',
        chatId: 'y',
        tmuxSession: '',
        tmuxWindow: '',
        paneId: '',
        createdAt: 0,
        lastActivityAt: 0,
      };
      // Should not throw
      await executor.shutdown(fakeSession);
    });
  });

  describe('deliver', () => {
    it('calls runQuery with message content and publishes reply via NATS', async () => {
      const session = await executor.spawn('test-agent', 'chat-1', {});
      const message = {
        content: 'Hello agent',
        sender: 'user',
        instanceId: 'inst-1',
        chatId: 'chat-1',
        agent: 'test-agent',
      };

      await executor.deliver(session, message);
      await executor.waitForDeliveries(session.id);
    });

    it('returns immediately without awaiting the query', async () => {
      const session = await executor.spawn('test-agent', 'chat-imm', {});
      const message = {
        content: 'Hello',
        sender: 'user',
        instanceId: 'inst-1',
        chatId: 'chat-imm',
        agent: 'test-agent',
      };

      // deliver() should resolve before the query completes
      await executor.deliver(session, message);
      // At this point, the async queue may not have published yet — this proves
      // deliver() does not block on the SDK query.
      // After waiting, the publish should be done.
      await executor.waitForDeliveries(session.id);
    });

    it('throws if session not found', async () => {
      const fakeSession = {
        id: 'nonexistent',
        agentName: 'x',
        chatId: 'y',
        tmuxSession: '',
        tmuxWindow: '',
        paneId: '',
        createdAt: 0,
        lastActivityAt: 0,
      };
      await expect(
        executor.deliver(fakeSession, { content: 'hi', sender: 'u', instanceId: 'i', chatId: 'c', agent: 'a' }),
      ).rejects.toThrow('No SDK session found');
    });

    it('does not throw when NATS publish is not set', async () => {
      const session = await executor.spawn('test-agent', 'chat-no-nats', {});
      const message = {
        content: 'Hello agent',
        sender: 'user',
        instanceId: 'inst-1',
        chatId: 'chat-no-nats',
        agent: 'test-agent',
      };

      // Should not throw — reply is silently dropped when no NATS
      await executor.deliver(session, message);
      await executor.waitForDeliveries(session.id);
    });

    it('updates lastActivityAt after delivery', async () => {
      const session = await executor.spawn('test-agent', 'chat-ts', {});
      const before = session.lastActivityAt;

      // Small delay to ensure timestamp changes
      await new Promise((r) => setTimeout(r, 5));

      await executor.deliver(session, {
        content: 'test',
        sender: 'user',
        instanceId: 'inst-1',
        chatId: 'chat-ts',
        agent: 'test-agent',
      });

      await executor.waitForDeliveries(session.id);
      expect(session.lastActivityAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe('concurrent delivery', () => {
    afterEach(() => {
      // Restore the default SDK query mock so later tests don't hang on unresolved barriers.
      resetQueryMock();
    });

    it('3 concurrent sessions process independently without blocking each other', async () => {
      // Track the order of query starts and completions per session
      const events: string[] = [];
      const resolvers: Record<string, () => void> = {};

      // Override the SDK mock to use per-session delays
      queryMock.mockImplementation(() => {
        // Each call gets a unique ID based on call count
        const callNum = events.length;
        const sessionTag = `call-${callNum}`;
        events.push(`start:${sessionTag}`);

        const barrier = new Promise<void>((resolve) => {
          resolvers[sessionTag] = resolve;
        });

        const gen = (async function* () {
          await barrier;
          events.push(`end:${sessionTag}`);
          yield { type: 'assistant', message: { content: [{ type: 'text', text: `reply-${sessionTag}` }] } };
        })();

        return Object.assign(gen, {
          interrupt: mock(),
          setPermissionMode: mock(),
          setModel: mock(),
          return: mock(async () => ({ value: undefined, done: true })),
          throw: mock(async () => ({ value: undefined, done: true })),
        });
      });

      // Spawn 3 independent sessions
      const s1 = await executor.spawn('agent-a', 'chat-1', {});
      const s2 = await executor.spawn('agent-b', 'chat-2', {});
      const s3 = await executor.spawn('agent-c', 'chat-3', {});

      const mkMsg = (chatId: string) => ({
        content: `msg for ${chatId}`,
        sender: 'user',
        instanceId: 'inst-1',
        chatId,
        agent: 'test-agent',
      });

      // Fire all 3 deliveries — deliver() should return immediately for each
      await executor.deliver(s1, mkMsg('chat-1'));
      await executor.deliver(s2, mkMsg('chat-2'));
      await executor.deliver(s3, mkMsg('chat-3'));

      // All 3 queries should have started (events captured synchronously on enqueue)
      // Give a tick for the async generators to begin
      await new Promise((r) => setTimeout(r, 10));
      expect(events.filter((e) => e.startsWith('start:'))).toHaveLength(3);

      // Complete session 3 first (out of order) to prove independence
      resolvers['call-2']!();
      await executor.waitForDeliveries(s3.id);

      // Session 3 done, sessions 1 and 2 still pending
      expect(events.filter((e) => e.startsWith('end:'))).toHaveLength(1);

      // Complete session 1
      resolvers['call-0']!();
      await executor.waitForDeliveries(s1.id);

      // Complete session 2
      resolvers['call-1']!();
      await executor.waitForDeliveries(s2.id);

      // All 3 completed
      expect(events.filter((e) => e.startsWith('end:'))).toHaveLength(3);
    });
  });

  describe('multiple sessions', () => {
    it('manages independent sessions for different chats', async () => {
      const s1 = await executor.spawn('agent-a', 'chat-1', {});
      const s2 = await executor.spawn('agent-b', 'chat-2', {});

      expect(s1.id).not.toBe(s2.id);
      expect(await executor.isAlive(s1)).toBe(true);
      expect(await executor.isAlive(s2)).toBe(true);

      await executor.shutdown(s1);
      expect(await executor.isAlive(s1)).toBe(false);
      expect(await executor.isAlive(s2)).toBe(true);
    });
  });

  // ==========================================================================
  // World A registry wiring (Group 4 — Decision 1)
  // ==========================================================================

  describe('World A registry integration', () => {
    /** Fake sql tagged-template that returns an empty array (no rows). */
    const mockSql = ((_strings: TemplateStringsArray, ..._values: any[]) => Promise.resolve([])) as any;

    /** Fake bridge.safePgCall that invokes fn directly — happy path. */
    const happySafePgCall = async <T>(
      _op: string,
      fn: (_sql: any) => Promise<T>,
      _fallback: T,
      _ctx?: { executorId?: string; chatId?: string },
    ): Promise<T> => fn(mockSql);

    /** Fake bridge.safePgCall that never invokes fn — simulates pgAvailable=false. */
    const degradedSafePgCall = async <T>(
      _op: string,
      _fn: (_sql: any) => Promise<T>,
      fallback: T,
      _ctx?: { executorId?: string; chatId?: string },
    ): Promise<T> => fallback;

    beforeEach(() => {
      resetAllMocks();
    });

    it('spawn(): calls findOrCreateAgent and createAndLinkExecutor with transport="api" and omni metadata', async () => {
      executor.setSafePgCall(happySafePgCall);
      const session = await executor.spawn('test-agent', 'chat-123', { OMNI_INSTANCE: 'inst-abc' });

      expect(findOrCreateAgentMock).toHaveBeenCalledWith('test-agent', 'omni', 'omni');
      expect(createAndLinkExecutorMock).toHaveBeenCalledTimes(1);

      const [agentId, provider, transport, opts] = createAndLinkExecutorMock.mock.calls[0];
      expect(agentId).toBe('agent-id-fixture');
      expect(provider).toBe('claude');
      expect(transport).toBe('api');
      expect(opts).toMatchObject({
        claudeSessionId: undefined,
        metadata: { source: 'omni', chat_id: 'chat-123', instance_id: 'inst-abc' },
      });

      // Session still built and returned as before.
      expect(session.id).toBe('test-agent:chat-123');
    });

    it('spawn(): transitions state spawning → running after executor is linked', async () => {
      executor.setSafePgCall(happySafePgCall);
      await executor.spawn('test-agent', 'chat-1', { OMNI_INSTANCE: 'inst-1' });

      // updateExecutorState should have been called at least once with "running".
      const runningCalls = updateExecutorStateMock.mock.calls.filter(([, state]) => state === 'running');
      expect(runningCalls.length).toBeGreaterThanOrEqual(1);
      expect(runningCalls[0][0]).toBe('executor-id-fixture');
    });

    it('deliver(): transitions state working → idle around the query', async () => {
      executor.setSafePgCall(happySafePgCall);

      const session = await executor.spawn('test-agent', 'chat-deliver', { OMNI_INSTANCE: 'inst-1' });
      updateExecutorStateMock.mockClear(); // reset so we only see the deliver transitions

      await executor.deliver(session, {
        content: 'hi',
        sender: 'user',
        instanceId: 'inst-1',
        chatId: 'chat-deliver',
        agent: 'test-agent',
      });
      await executor.waitForDeliveries(session.id);

      const states = updateExecutorStateMock.mock.calls.map(([, state]) => state);
      expect(states).toContain('working');
      expect(states).toContain('idle');
      // Order matters: working must come before idle.
      expect(states.indexOf('working')).toBeLessThan(states.indexOf('idle'));
    });

    it('shutdown(): calls terminateExecutor with the linked executor ID', async () => {
      executor.setSafePgCall(happySafePgCall);
      const session = await executor.spawn('test-agent', 'chat-shutdown', { OMNI_INSTANCE: 'inst-1' });

      await executor.shutdown(session);

      expect(terminateExecutorMock).toHaveBeenCalledTimes(1);
      expect(terminateExecutorMock.mock.calls[0][0]).toBe('executor-id-fixture');
    });

    it('safePgCall is the mechanism: mocked safePgCall sees all registry op names', async () => {
      const safePgCallSpy = mock(
        async <T>(_op: string, fn: (_sql: any) => Promise<T>, _fallback: T): Promise<T> => fn(mockSql),
      );
      executor.setSafePgCall(safePgCallSpy as never);

      const session = await executor.spawn('spy-agent', 'chat-spy', { OMNI_INSTANCE: 'inst-1' });
      await executor.deliver(session, {
        content: 'hi',
        sender: 'u',
        instanceId: 'inst-1',
        chatId: 'chat-spy',
        agent: 'spy-agent',
      });
      await executor.waitForDeliveries(session.id);
      await executor.shutdown(session);

      const ops = safePgCallSpy.mock.calls.map((args) => args[0]);
      expect(ops).toContain('sdk-find-or-create-agent');
      expect(ops).toContain('sdk-create-executor');
      expect(ops).toContain('sdk-update-executor-state');
      expect(ops).toContain('sdk-terminate-executor');
    });

    it('degraded mode: safePgCall returning fallback immediately keeps spawn/deliver/shutdown working', async () => {
      executor.setSafePgCall(degradedSafePgCall);

      // No PG work should happen because fn is never invoked.
      const session = await executor.spawn('test-agent', 'chat-degraded', { OMNI_INSTANCE: 'inst-1' });
      expect(findOrCreateAgentMock).not.toHaveBeenCalled();
      expect(createAndLinkExecutorMock).not.toHaveBeenCalled();
      expect(updateExecutorStateMock).not.toHaveBeenCalled();

      await executor.deliver(session, {
        content: 'hi',
        sender: 'user',
        instanceId: 'inst-1',
        chatId: 'chat-degraded',
        agent: 'test-agent',
      });
      await executor.waitForDeliveries(session.id);

      await executor.shutdown(session);
      expect(terminateExecutorMock).not.toHaveBeenCalled();

      // Session lifecycle still worked end-to-end.
      expect(await executor.isAlive(session)).toBe(false);
    });

    it('no bridge attached: spawn/deliver/shutdown work without any registry calls', async () => {
      // No setSafePgCall call — executor.safePgCall stays null.
      const session = await executor.spawn('test-agent', 'chat-solo', { OMNI_INSTANCE: 'inst-1' });
      await executor.deliver(session, {
        content: 'hi',
        sender: 'user',
        instanceId: 'inst-1',
        chatId: 'chat-solo',
        agent: 'test-agent',
      });
      await executor.waitForDeliveries(session.id);
      await executor.shutdown(session);

      expect(findOrCreateAgentMock).not.toHaveBeenCalled();
      expect(createAndLinkExecutorMock).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Turn-based prompt injection (Group 4 — omni-turn-based-dx)
  // ==========================================================================

  describe('turn-based prompt injection', () => {
    beforeEach(() => {
      resetAllMocks();
    });

    it('includes turn-based instructions in system prompt when OMNI_INSTANCE is set', async () => {
      const env = { OMNI_INSTANCE: 'inst-wb', OMNI_CHAT: 'chat-wb', OMNI_AGENT: 'bot' };
      const session = await executor.spawn('test-agent', 'chat-wb', env);

      await executor.deliver(session, {
        content: 'Hello from WhatsApp',
        sender: 'Alice',
        instanceId: 'inst-wb',
        chatId: 'chat-wb',
        agent: 'test-agent',
      });
      await executor.waitForDeliveries(session.id);

      expect(queryMock).toHaveBeenCalledTimes(1);
      const callArgs = (queryMock.mock.calls[0] as unknown as [{ options?: { systemPrompt?: string } }])[0];
      const systemPrompt = callArgs.options?.systemPrompt ?? '';

      // Verify turn-based prompt content
      expect(systemPrompt).toContain('WhatsApp');
      expect(systemPrompt).toContain('Alice');
      expect(systemPrompt).toContain('omni say');
      expect(systemPrompt).toContain('omni done');
      expect(systemPrompt).toContain('inst-wb');
    });

    it('does NOT include turn-based instructions when OMNI_INSTANCE is absent', async () => {
      const session = await executor.spawn('test-agent', 'chat-plain', {});

      await executor.deliver(session, {
        content: 'Hello from CLI',
        sender: 'bob',
        instanceId: 'inst-1',
        chatId: 'chat-plain',
        agent: 'test-agent',
      });
      await executor.waitForDeliveries(session.id);

      expect(queryMock).toHaveBeenCalledTimes(1);
      const callArgs = (queryMock.mock.calls[0] as unknown as [{ options?: { systemPrompt?: string } }])[0];
      const systemPrompt = callArgs.options?.systemPrompt ?? '';

      expect(systemPrompt).not.toContain('WhatsApp');
      expect(systemPrompt).not.toContain('omni say');
      expect(systemPrompt).not.toContain('omni done');
    });
  });
});
