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
      const natsPublish = mock();
      executor.setNatsPublish(natsPublish);

      const session = await executor.spawn('test-agent', 'chat-1', {});
      const message = {
        content: 'Hello agent',
        sender: 'user',
        instanceId: 'inst-1',
        chatId: 'chat-1',
        agent: 'test-agent',
      };

      await executor.deliver(session, message);

      // Verify NATS publish was called with the reply
      expect(natsPublish).toHaveBeenCalledTimes(1);
      const [topic, payload] = natsPublish.mock.calls[0];
      expect(topic).toBe('omni.reply.inst-1.chat-1');
      const parsed = JSON.parse(payload);
      expect(parsed.content).toBe('response text');
      expect(parsed.agent).toBe('test-agent');
      expect(parsed.chat_id).toBe('chat-1');
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
  });
});
