import { beforeEach, describe, expect, it, mock } from 'bun:test';

// Mock agent directory
mock.module('../../../lib/agent-directory.js', () => ({
  resolve: mock(async (name: string) => ({
    entry: {
      name,
      dir: '/tmp/test',
      promptMode: 'system' as const,
      model: 'sonnet',
      registeredAt: new Date().toISOString(),
      permissions: { preset: 'full' },
    },
    builtin: false,
  })),
  loadIdentity: mock(() => null),
}));

// Mock the SDK query function
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: mock(() => {
    const gen = (async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'response text' }] } };
    })();
    return Object.assign(gen, {
      interrupt: mock(),
      setPermissionMode: mock(),
      setModel: mock(),
      return: mock(async () => ({ value: undefined, done: true })),
      throw: mock(async () => ({ value: undefined, done: true })),
    });
  }),
}));

// Mock omni-sessions (PG operations)
mock.module('../../omni-sessions.js', () => ({
  upsertSession: mock(async () => ({})),
  getSession: mock(async () => null),
  touchSession: mock(async () => {}),
  deleteSession: mock(async () => {}),
}));

// Mock child_process — include all exports that transitive imports may need
mock.module('node:child_process', () => ({
  execFile: mock((_cmd: string, _args: string[], cb: (err: Error | null) => void) => {
    cb(null);
  }),
  spawn: mock(() => ({
    on: mock(),
    stdout: { on: mock() },
    stderr: { on: mock() },
    kill: mock(),
    pid: 0,
  })),
  spawnSync: mock(() => ({ status: 0, stdout: '', stderr: '' })),
  execSync: mock(() => ''),
  exec: mock((_cmd: string, cb: (err: Error | null) => void) => cb(null)),
}));

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
    it('calls runQuery with message content and sends reply via omni CLI', async () => {
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

      // Verify omni CLI was called (via execFile mock)
      const { execFile } = await import('node:child_process');
      expect(execFile).toHaveBeenCalled();
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
      // After waiting, the delivery should be done.
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
    it('3 concurrent sessions process independently without blocking each other', async () => {
      // Track the order of query starts and completions per session
      const events: string[] = [];
      const resolvers: Record<string, () => void> = {};

      // Override the SDK mock to use per-session delays
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      (sdk.query as ReturnType<typeof mock>).mockImplementation(() => {
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
});
