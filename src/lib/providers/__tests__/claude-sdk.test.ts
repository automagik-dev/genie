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

  describe('terminate -- idempotent for unknown executor', () => {
    it('does not throw when terminating unknown executor', async () => {
      await provider.terminate({ id: 'nonexistent' } as any);
      // Should complete without error
    });
  });

  describe('runQuery -- extraOptions merging', () => {
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

  describe('runQuery -- without permissionConfig', () => {
    it('does not set hooks when no permissionConfig', () => {
      provider.runQuery(ctx, 'no perms');
      const callArgs = (sdk.query as ReturnType<typeof mock>).mock.calls.at(-1)?.[0];
      expect(callArgs.options.hooks).toBeUndefined();
    });
  });

  describe('runQuery -- sdkConfig merging', () => {
    it('applies sdkConfig via translateSdkConfig when provided', () => {
      const sdkConfig = {
        maxTurns: 10,
        maxBudgetUsd: 5.0,
        effort: 'high' as const,
        allowedTools: ['Bash', 'Read'],
      };
      provider.runQuery(ctx, 'test', undefined, undefined, sdkConfig);
      const callArgs = (sdk.query as ReturnType<typeof mock>).mock.calls.at(-1)?.[0];
      expect(callArgs.options.maxTurns).toBe(10);
      expect(callArgs.options.maxBudgetUsd).toBe(5.0);
      expect(callArgs.options.effort).toBe('high');
      expect(callArgs.options.allowedTools).toEqual(['Bash', 'Read']);
    });

    it('extraOptions override sdkConfig values', () => {
      const sdkConfig = {
        maxTurns: 10,
        effort: 'low' as const,
      };
      const extraOptions = { maxTurns: 50 };
      provider.runQuery(ctx, 'test', undefined, extraOptions, sdkConfig);
      const callArgs = (sdk.query as ReturnType<typeof mock>).mock.calls.at(-1)?.[0];
      // extraOptions should win over sdkConfig
      expect(callArgs.options.maxTurns).toBe(50);
      // sdkConfig value that was not overridden should remain
      expect(callArgs.options.effort).toBe('low');
    });

    it('merges permission hooks with sdkConfig hooks', () => {
      const permissionConfig = { allow: ['Read'] };
      const sdkConfig = {
        maxTurns: 5,
      };
      provider.runQuery(ctx, 'test', permissionConfig, undefined, sdkConfig);
      const callArgs = (sdk.query as ReturnType<typeof mock>).mock.calls.at(-1)?.[0];
      // Permission hooks should still be present
      expect(callArgs.options.hooks?.PreToolUse).toBeDefined();
      expect(callArgs.options.hooks.PreToolUse.length).toBeGreaterThan(0);
      // sdkConfig field should also be present
      expect(callArgs.options.maxTurns).toBe(5);
    });
  });
});

// ============================================================================
// translateSdkConfig -- standalone tests
// ============================================================================

const { translateSdkConfig } = await import('../claude-sdk.js');

describe('translateSdkConfig', () => {
  it('maps all basic SdkDirectoryConfig fields to Options', () => {
    const result = translateSdkConfig({
      permissionMode: 'acceptEdits',
      tools: ['Bash', 'Read'],
      allowedTools: ['Bash'],
      disallowedTools: ['Write'],
      maxTurns: 20,
      maxBudgetUsd: 10.5,
      effort: 'medium',
      thinking: { type: 'adaptive' },
      persistSession: false,
      enableFileCheckpointing: true,
      includePartialMessages: true,
      includeHookEvents: false,
      promptSuggestions: true,
      agentProgressSummaries: true,
      systemPrompt: 'Custom prompt',
      betas: ['context-1m-2025-08-07'],
      settingSources: ['user', 'project'],
      settings: '/path/to/settings.json',
    });

    expect(result.permissionMode).toBe('acceptEdits');
    expect(result.tools).toEqual(['Bash', 'Read']);
    expect(result.allowedTools).toEqual(['Bash']);
    expect(result.disallowedTools).toEqual(['Write']);
    expect(result.maxTurns).toBe(20);
    expect(result.maxBudgetUsd).toBe(10.5);
    expect(result.effort).toBe('medium');
    expect(result.thinking).toEqual({ type: 'adaptive' });
    expect(result.persistSession).toBe(false);
    expect(result.enableFileCheckpointing).toBe(true);
    expect(result.includePartialMessages).toBe(true);
    expect(result.includeHookEvents).toBe(false);
    expect(result.promptSuggestions).toBe(true);
    expect(result.agentProgressSummaries).toBe(true);
    expect(result.systemPrompt).toBe('Custom prompt');
    expect(result.betas).toEqual(['context-1m-2025-08-07']);
    expect(result.settingSources).toEqual(['user', 'project']);
    expect(result.settings).toBe('/path/to/settings.json');
  });

  it('maps complex nested fields (agents, mcpServers, plugins, sandbox)', () => {
    const result = translateSdkConfig({
      agents: {
        reviewer: {
          description: 'A reviewer agent',
          prompt: 'You review code',
          tools: ['Read', 'Grep'],
        },
      },
      mcpServers: {
        myServer: { command: 'node', args: ['server.js'] },
      },
      plugins: [{ type: 'local', path: '/my/plugin' }],
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        network: { allowLocalBinding: true },
      },
      outputFormat: {
        type: 'json_schema',
        schema: { type: 'object', properties: { result: { type: 'string' } } },
      },
    });

    expect(result.agents).toEqual({
      reviewer: {
        description: 'A reviewer agent',
        prompt: 'You review code',
        tools: ['Read', 'Grep'],
      },
    });
    expect(result.mcpServers).toEqual({
      myServer: { command: 'node', args: ['server.js'] },
    });
    expect(result.plugins).toEqual([{ type: 'local', path: '/my/plugin' }]);
    expect(result.sandbox).toEqual({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      network: { allowLocalBinding: true },
    });
    expect(result.outputFormat).toEqual({
      type: 'json_schema',
      schema: { type: 'object', properties: { result: { type: 'string' } } },
    });
  });

  it('returns empty object for empty config', () => {
    const result = translateSdkConfig({});
    expect(result).toEqual({});
  });

  it('skips undefined fields', () => {
    const result = translateSdkConfig({ maxTurns: 5 });
    expect(Object.keys(result)).toEqual(['maxTurns']);
    expect(result.maxTurns).toBe(5);
  });

  it('handles persistSession: false (falsy but valid)', () => {
    const result = translateSdkConfig({ persistSession: false });
    expect(result.persistSession).toBe(false);
  });

  it('handles maxTurns: 0 (zero is valid)', () => {
    const result = translateSdkConfig({ maxTurns: 0 });
    expect(result.maxTurns).toBe(0);
  });

  it('handles maxBudgetUsd: 0 (zero is valid)', () => {
    const result = translateSdkConfig({ maxBudgetUsd: 0 });
    expect(result.maxBudgetUsd).toBe(0);
  });

  it('handles tools as preset object', () => {
    const result = translateSdkConfig({ tools: { type: 'preset', preset: 'claude_code' } });
    expect(result.tools).toEqual({ type: 'preset', preset: 'claude_code' });
  });

  it('handles systemPrompt as preset object', () => {
    const result = translateSdkConfig({
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Extra instructions' },
    });
    expect(result.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'Extra instructions',
    });
  });
});
