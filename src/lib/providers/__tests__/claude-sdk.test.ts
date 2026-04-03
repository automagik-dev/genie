import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { SpawnContext } from '../../executor-types.js';

// Mock the SDK query function before importing provider
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: mock(() => {
    const gen = (async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } };
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

const { ClaudeSdkProvider } = await import('../claude-sdk.js');
const sdk = await import('@anthropic-ai/claude-agent-sdk');

describe('ClaudeSdkProvider', () => {
  let provider: InstanceType<typeof ClaudeSdkProvider>;
  let ctx: SpawnContext;

  beforeEach(() => {
    provider = new ClaudeSdkProvider();
    ctx = {
      agentId: 'test-agent',
      executorId: 'exec-1',
      team: 'test-team',
      role: 'engineer',
      skill: 'work',
      cwd: '/tmp/test',
    };
  });

  describe('buildSpawnCommand', () => {
    it('returns metadata-only command with "claude-sdk-in-process"', () => {
      const cmd = provider.buildSpawnCommand(ctx);
      expect(cmd.command).toBe('claude-sdk-in-process');
      expect(cmd.provider).toBe('claude-sdk');
      expect(cmd.meta).toEqual({ role: 'engineer', skill: 'work' });
    });
  });

  describe('properties', () => {
    it('has name "claude-sdk"', () => {
      expect(provider.name).toBe('claude-sdk');
    });

    it('has transport "process"', () => {
      expect(provider.transport).toBe('process');
    });
  });

  describe('canResume', () => {
    it('returns false', () => {
      expect(provider.canResume()).toBe(false);
    });
  });

  describe('runQuery', () => {
    it('calls SDK query with correct options', () => {
      const permissionConfig = { allow: ['Read'], deny: [] };
      const { messages, abortController } = provider.runQuery(ctx, 'do something', permissionConfig);

      expect(sdk.query).toHaveBeenCalledWith({
        prompt: 'do something',
        options: expect.objectContaining({
          cwd: '/tmp/test',
          abortController: expect.any(AbortController),
          hooks: expect.objectContaining({
            PreToolUse: expect.any(Array),
          }),
        }),
      });

      expect(messages).toBeDefined();
      expect(abortController).toBeInstanceOf(AbortController);
    });

    it('includes model when provided in context', () => {
      ctx.model = 'opus';
      provider.runQuery(ctx, 'test', undefined);

      expect(sdk.query).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            model: 'opus',
          }),
        }),
      );
    });

    it('includes systemPrompt when provided in context', () => {
      ctx.systemPrompt = 'You are a test agent';
      provider.runQuery(ctx, 'test', undefined);

      expect(sdk.query).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            systemPrompt: 'You are a test agent',
          }),
        }),
      );
    });
  });

  describe('detectState', () => {
    it('returns "done" for unknown executor', async () => {
      const state = await provider.detectState({ id: 'unknown' } as any);
      expect(state).toBe('done');
    });

    it('returns "running" for active query', async () => {
      provider.runQuery(ctx, 'test');
      const state = await provider.detectState({ id: ctx.executorId } as any);
      expect(state).toBe('running');
    });
  });

  describe('terminate', () => {
    it('aborts active query and marks as done', async () => {
      const { abortController } = provider.runQuery(ctx, 'test');
      await provider.terminate({ id: ctx.executorId } as any);

      expect(abortController.signal.aborted).toBe(true);
      expect(await provider.detectState({ id: ctx.executorId } as any)).toBe('done');
    });
  });

  describe('extractSession', () => {
    it('returns session info when claudeSessionId is set', async () => {
      const result = await provider.extractSession({ id: 'x', claudeSessionId: 'sess-123' } as any);
      expect(result).toEqual({ sessionId: 'sess-123' });
    });

    it('returns null when no claudeSessionId', async () => {
      const result = await provider.extractSession({ id: 'x' } as any);
      expect(result).toBeNull();
    });
  });

  describe('terminate — idempotent for unknown executor', () => {
    it('does not throw when terminating unknown executor', async () => {
      await provider.terminate({ id: 'nonexistent' } as any);
      // Should complete without error
    });
  });

  describe('runQuery — extraOptions merging', () => {
    it('passes extraOptions through to SDK query', () => {
      provider.runQuery(ctx, 'test', undefined, { maxTokens: 1000 } as any);
      expect(sdk.query).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            maxTokens: 1000,
          }),
        }),
      );
    });
  });

  describe('runQuery — without permissionConfig', () => {
    it('does not set hooks when no permissionConfig', () => {
      provider.runQuery(ctx, 'no perms');
      const callArgs = (sdk.query as ReturnType<typeof mock>).mock.calls.at(-1)?.[0];
      expect(callArgs.options.hooks).toBeUndefined();
    });
  });
});
