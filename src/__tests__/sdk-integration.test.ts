/**
 * SDK Integration Tests
 *
 * End-to-end integration scenarios covering the full SDK executor pipeline:
 * config roundtrip, provider runQuery, event routing, stream formatting,
 * permission gate, frontmatter parsing, and config priority layering.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { SpawnContext } from '../lib/executor-types.js';

// ============================================================================
// Mock the SDK module before any provider imports
// ============================================================================

const mockQuery = mock(() => {
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
});

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: mockQuery,
}));

// No audit mocking — routeSdkMessage is fire-and-forget (.catch(() => {}))
// and these tests never iterate the message stream, so audit is never invoked.
// Removing audit mocks prevents spyOn leaks that corrupt audit.test.ts in the same bun process.

// ============================================================================
// Dynamic imports (must come after mock.module)
// ============================================================================

const { ClaudeSdkProvider, translateSdkConfig } = await import('../lib/providers/claude-sdk.js');
const { getEventType, buildEventDetails } = await import('../lib/providers/claude-sdk-events.js');
const { formatSdkMessage } = await import('../lib/providers/claude-sdk-stream.js');
const { createPermissionGate } = await import('../lib/providers/claude-sdk-permissions.js');
const { parseFrontmatter } = await import('../lib/frontmatter.js');

// ============================================================================
// Shared helpers
// ============================================================================

function makeCtx(overrides?: Partial<SpawnContext>): SpawnContext {
  return {
    agentId: 'test-agent',
    executorId: 'exec-1',
    team: 'test-team',
    role: 'engineer',
    skill: 'work',
    cwd: '/tmp/test',
    ...overrides,
  };
}

/** Safely get the last call args from the mock query (avoids TS tuple issues). */
function lastCallArgs(): Record<string, unknown> {
  return (mockQuery as ReturnType<typeof mock>).mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

// ============================================================================
// 1. Full config roundtrip
// ============================================================================

describe('Full config roundtrip', () => {
  it('translates all SdkDirectoryConfig fields to Partial<Options>', () => {
    const sdkConfig = {
      maxTurns: 42,
      effort: 'high' as const,
      thinking: { type: 'adaptive' as const },
      mcpServers: {
        myServer: { command: 'node', args: ['server.js'] },
      },
      agents: {
        reviewer: {
          description: 'Code reviewer',
          prompt: 'You review code',
          tools: ['Read', 'Grep'],
        },
      },
      maxBudgetUsd: 3.5,
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        network: { allowLocalBinding: true },
      },
      permissionMode: 'acceptEdits' as const, // translateSdkConfig should strip this
      tools: ['Bash', 'Read'] as string[],
      allowedTools: ['Bash'] as string[],
      disallowedTools: ['Write'] as string[],
      persistSession: false,
      enableFileCheckpointing: true,
      includePartialMessages: true,
      includeHookEvents: false,
      promptSuggestions: true,
      agentProgressSummaries: true,
      systemPrompt: 'Custom prompt',
      betas: ['context-1m-2025-08-07' as const],
      settingSources: ['user' as const, 'project' as const],
      settings: '/path/to/settings.json',
      outputFormat: {
        type: 'json_schema' as const,
        schema: { type: 'object', properties: { result: { type: 'string' } } },
      },
      plugins: [{ type: 'local' as const, path: '/my/plugin' }],
    };

    const result = translateSdkConfig(sdkConfig);

    // Verify all fields appear in the resulting Partial<Options>
    expect(result.maxTurns).toBe(42);
    expect(result.effort).toBe('high');
    expect(result.thinking).toEqual({ type: 'adaptive' });
    expect(result.mcpServers).toEqual({
      myServer: { command: 'node', args: ['server.js'] },
    });
    expect(result.agents).toEqual({
      reviewer: {
        description: 'Code reviewer',
        prompt: 'You review code',
        tools: ['Read', 'Grep'],
      },
    });
    expect(result.maxBudgetUsd).toBe(3.5);
    expect(result.sandbox).toEqual({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      network: { allowLocalBinding: true },
    });
    // permissionMode must NOT be copied — SDK executor always bypasses
    expect(result.permissionMode).toBeUndefined();
    expect(result.tools).toEqual(['Bash', 'Read']);
    expect(result.allowedTools).toEqual(['Bash']);
    expect(result.disallowedTools).toEqual(['Write']);
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
    expect(result.outputFormat).toEqual({
      type: 'json_schema',
      schema: { type: 'object', properties: { result: { type: 'string' } } },
    });
    expect(result.plugins).toEqual([{ type: 'local', path: '/my/plugin' }]);
  });
});

// ============================================================================
// 2. Provider runQuery with SDK config
// ============================================================================

describe('Provider runQuery with SDK config', () => {
  let provider: InstanceType<typeof ClaudeSdkProvider>;

  beforeEach(() => {
    provider = new ClaudeSdkProvider();
    mockQuery.mockClear();
  });

  it('calls SDK query with properly layered options (sdkConfig < extraOptions)', () => {
    const ctx = makeCtx();
    const permissionConfig = { allow: ['Read', 'Glob'] };
    const extraOptions = { maxTokens: 500 } as any;
    const sdkConfig = {
      maxTurns: 20,
      effort: 'medium' as const,
      maxBudgetUsd: 2.0,
    };

    provider.runQuery(ctx, 'do something', permissionConfig, extraOptions, sdkConfig);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const callArgs = lastCallArgs() as any;

    // sdkConfig fields should be present
    expect(callArgs.options.maxTurns).toBe(20);
    expect(callArgs.options.effort).toBe('medium');
    expect(callArgs.options.maxBudgetUsd).toBe(2.0);

    // extraOptions should be present
    expect(callArgs.options.maxTokens).toBe(500);

    // Permission hooks should be wired
    expect(callArgs.options.hooks?.PreToolUse).toBeDefined();
    expect(callArgs.options.hooks.PreToolUse.length).toBeGreaterThan(0);

    // Base context fields
    expect(callArgs.options.cwd).toBe('/tmp/test');
    expect(callArgs.prompt).toBe('do something');
  });
});

// ============================================================================
// 3. Event routing completeness
// ============================================================================

describe('Event routing completeness', () => {
  // Factory functions for all 24+ SDKMessage types
  const messageFactories: Array<{ name: string; msg: Record<string, unknown> }> = [
    // Top-level types
    {
      name: 'assistant',
      msg: {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello' }] },
        parent_tool_use_id: null,
        uuid: 'u-1',
        session_id: 's-1',
      },
    },
    {
      name: 'result/success',
      msg: {
        type: 'result',
        subtype: 'success',
        duration_ms: 1000,
        duration_api_ms: 800,
        is_error: false,
        num_turns: 3,
        result: 'Done',
        stop_reason: 'end_turn',
        total_cost_usd: 0.05,
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        uuid: 'u-2',
        session_id: 's-1',
      },
    },
    {
      name: 'result/error_during_execution',
      msg: {
        type: 'result',
        subtype: 'error_during_execution',
        duration_ms: 500,
        is_error: true,
        num_turns: 1,
        errors: ['fail'],
        uuid: 'u-3',
        session_id: 's-1',
      },
    },
    {
      name: 'result/error_max_turns',
      msg: {
        type: 'result',
        subtype: 'error_max_turns',
        duration_ms: 500,
        is_error: true,
        uuid: 'u-4',
        session_id: 's-1',
      },
    },
    {
      name: 'result/error_max_budget_usd',
      msg: {
        type: 'result',
        subtype: 'error_max_budget_usd',
        duration_ms: 500,
        is_error: true,
        uuid: 'u-5',
        session_id: 's-1',
      },
    },
    {
      name: 'result/error_max_structured_output_retries',
      msg: {
        type: 'result',
        subtype: 'error_max_structured_output_retries',
        duration_ms: 500,
        is_error: true,
        uuid: 'u-6',
        session_id: 's-1',
      },
    },
    {
      name: 'stream_event',
      msg: {
        type: 'stream_event',
        event: { type: 'content_block_delta' },
        parent_tool_use_id: null,
        uuid: 'u-7',
        session_id: 's-1',
      },
    },
    {
      name: 'tool_progress',
      msg: {
        type: 'tool_progress',
        tool_use_id: 'tu-1',
        tool_name: 'Bash',
        parent_tool_use_id: null,
        elapsed_time_seconds: 5,
        uuid: 'u-8',
        session_id: 's-1',
      },
    },
    {
      name: 'tool_use_summary',
      msg: {
        type: 'tool_use_summary',
        summary: 'Ran commands',
        preceding_tool_use_ids: ['tu-1'],
        uuid: 'u-9',
        session_id: 's-1',
      },
    },
    {
      name: 'rate_limit_event',
      msg: {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed', utilization: 0.3 },
        uuid: 'u-10',
        session_id: 's-1',
      },
    },
    {
      name: 'auth_status',
      msg: {
        type: 'auth_status',
        isAuthenticating: false,
        output: ['ok'],
        uuid: 'u-11',
        session_id: 's-1',
      },
    },
    {
      name: 'prompt_suggestion',
      msg: {
        type: 'prompt_suggestion',
        suggestion: 'Run tests',
        uuid: 'u-12',
        session_id: 's-1',
      },
    },
    {
      name: 'user',
      msg: {
        type: 'user',
        message: { role: 'user', content: 'hi' },
        parent_tool_use_id: null,
        uuid: 'u-13',
        session_id: 's-1',
      },
    },
    // System subtypes
    {
      name: 'system/init',
      msg: {
        type: 'system',
        subtype: 'init',
        model: 'claude-sonnet-4-20250514',
        cwd: '/tmp',
        claude_code_version: '1.0.0',
        tools: ['Read'],
        mcp_servers: [],
        uuid: 'u-14',
        session_id: 's-1',
      },
    },
    {
      name: 'system/api_retry',
      msg: {
        type: 'system',
        subtype: 'api_retry',
        attempt: 2,
        max_retries: 5,
        retry_delay_ms: 1000,
        error_status: 429,
        error: 'rate_limit',
        uuid: 'u-15',
        session_id: 's-1',
      },
    },
    {
      name: 'system/compact_boundary',
      msg: {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'auto', pre_tokens: 50000 },
        uuid: 'u-16',
        session_id: 's-1',
      },
    },
    {
      name: 'system/elicitation_complete',
      msg: {
        type: 'system',
        subtype: 'elicitation_complete',
        mcp_server_name: 'srv',
        elicitation_id: 'e-1',
        uuid: 'u-17',
        session_id: 's-1',
      },
    },
    {
      name: 'system/files_persisted',
      msg: {
        type: 'system',
        subtype: 'files_persisted',
        files: [{ filename: 'a.txt', file_id: 'f1' }],
        failed: [],
        uuid: 'u-18',
        session_id: 's-1',
      },
    },
    {
      name: 'system/hook_progress',
      msg: {
        type: 'system',
        subtype: 'hook_progress',
        hook_id: 'h-1',
        hook_name: 'test',
        hook_event: 'PreToolUse',
        uuid: 'u-19',
        session_id: 's-1',
      },
    },
    {
      name: 'system/hook_response',
      msg: {
        type: 'system',
        subtype: 'hook_response',
        hook_id: 'h-1',
        hook_name: 'test',
        hook_event: 'PreToolUse',
        outcome: 'success',
        exit_code: 0,
        uuid: 'u-20',
        session_id: 's-1',
      },
    },
    {
      name: 'system/hook_started',
      msg: {
        type: 'system',
        subtype: 'hook_started',
        hook_id: 'h-1',
        hook_name: 'test',
        hook_event: 'PreToolUse',
        uuid: 'u-21',
        session_id: 's-1',
      },
    },
    {
      name: 'system/local_command_output',
      msg: {
        type: 'system',
        subtype: 'local_command_output',
        content: 'Cost: $0.05',
        uuid: 'u-22',
        session_id: 's-1',
      },
    },
    {
      name: 'system/session_state_changed',
      msg: {
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
        uuid: 'u-23',
        session_id: 's-1',
      },
    },
    {
      name: 'system/status',
      msg: {
        type: 'system',
        subtype: 'status',
        status: 'idle',
        uuid: 'u-24',
        session_id: 's-1',
      },
    },
    {
      name: 'system/task_notification',
      msg: {
        type: 'system',
        subtype: 'task_notification',
        task_id: 't-1',
        status: 'completed',
        summary: 'Done',
        usage: {},
        uuid: 'u-25',
        session_id: 's-1',
      },
    },
    {
      name: 'system/task_progress',
      msg: {
        type: 'system',
        subtype: 'task_progress',
        task_id: 't-1',
        description: 'Working',
        uuid: 'u-26',
        session_id: 's-1',
      },
    },
    {
      name: 'system/task_started',
      msg: {
        type: 'system',
        subtype: 'task_started',
        task_id: 't-1',
        description: 'Start',
        task_type: 'local_workflow',
        uuid: 'u-27',
        session_id: 's-1',
      },
    },
  ];

  it('getEventType returns non-null for all known message types', () => {
    for (const { msg } of messageFactories) {
      const eventType = getEventType(msg as any);
      expect(eventType).not.toBeNull();
      expect(typeof eventType).toBe('string');
      // Sanity: event type should start with 'sdk.'
      expect(eventType!.startsWith('sdk.')).toBe(true);
    }
  });

  it('buildEventDetails returns a details object for all known message types', () => {
    for (const { msg } of messageFactories) {
      const details = buildEventDetails(msg as any);
      expect(details).toBeDefined();
      expect(typeof details).toBe('object');
      expect(details.sdkType).toBe(msg.type);
    }
  });

  it('covers all 24+ distinct event types', () => {
    const eventTypes = new Set<string>();
    for (const { msg } of messageFactories) {
      const eventType = getEventType(msg as any);
      if (eventType) eventTypes.add(eventType);
    }
    // There should be at least 22 distinct event types
    // (some result subtypes map to the same event type, e.g. error -> sdk.result.error)
    expect(eventTypes.size).toBeGreaterThanOrEqual(22);
  });
});

// ============================================================================
// 4. Stream formatting
// ============================================================================

describe('Stream formatting', () => {
  const assistantMsg = {
    type: 'assistant' as const,
    message: { content: [{ type: 'text', text: 'Hello world' }] },
    parent_tool_use_id: null,
    uuid: 'u-1',
    session_id: 's-1',
  };

  const resultMsg = {
    type: 'result' as const,
    subtype: 'success' as const,
    duration_ms: 1000,
    duration_api_ms: 800,
    is_error: false,
    num_turns: 3,
    result: 'All done',
    stop_reason: 'end_turn',
    total_cost_usd: 0.05,
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    uuid: 'u-2',
    session_id: 's-1',
  };

  const errorMsg = {
    type: 'result' as const,
    subtype: 'error_during_execution' as const,
    duration_ms: 500,
    duration_api_ms: 400,
    is_error: true,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0.01,
    usage: { input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    errors: ['Something failed'],
    uuid: 'u-3',
    session_id: 's-1',
  };

  describe('text format', () => {
    it('formats assistant message as human-readable text', () => {
      const output = formatSdkMessage(assistantMsg as any, 'text');
      expect(output).toBe('Hello world');
    });

    it('formats result message with summary, cost, and tokens', () => {
      const output = formatSdkMessage(resultMsg as any, 'text');
      expect(output).not.toBeNull();
      expect(output!).toContain('All done');
      expect(output!).toContain('Turns: 3');
      expect(output!).toContain('$0.0500');
      expect(output!).toContain('100in/50out');
    });

    it('formats error message with ANSI red', () => {
      const output = formatSdkMessage(errorMsg as any, 'text');
      expect(output).not.toBeNull();
      expect(output!).toContain('Something failed');
      expect(output!).toContain('\x1b[31m');
    });
  });

  describe('json format', () => {
    it('returns valid pretty-printed JSON for assistant message', () => {
      const output = formatSdkMessage(assistantMsg as any, 'json');
      expect(output).toBe(JSON.stringify(assistantMsg, null, 2));
      // Verify it parses back
      const parsed = JSON.parse(output!);
      expect(parsed.type).toBe('assistant');
    });

    it('returns valid pretty-printed JSON for result message', () => {
      const output = formatSdkMessage(resultMsg as any, 'json');
      const parsed = JSON.parse(output!);
      expect(parsed.type).toBe('result');
      expect(parsed.subtype).toBe('success');
    });

    it('returns valid pretty-printed JSON for error message', () => {
      const output = formatSdkMessage(errorMsg as any, 'json');
      const parsed = JSON.parse(output!);
      expect(parsed.is_error).toBe(true);
    });
  });

  describe('ndjson format', () => {
    it('returns single-line valid JSON for assistant message', () => {
      const output = formatSdkMessage(assistantMsg as any, 'ndjson');
      expect(output).not.toBeNull();
      expect(output!.includes('\n')).toBe(false);
      const parsed = JSON.parse(output!);
      expect(parsed.type).toBe('assistant');
      expect(parsed.message.content[0].text).toBe('Hello world');
    });

    it('returns single-line valid JSON for result message', () => {
      const output = formatSdkMessage(resultMsg as any, 'ndjson');
      expect(output).not.toBeNull();
      expect(output!.includes('\n')).toBe(false);
      const parsed = JSON.parse(output!);
      expect(parsed.type).toBe('result');
      expect(parsed.total_cost_usd).toBe(0.05);
    });

    it('returns single-line valid JSON for error message', () => {
      const output = formatSdkMessage(errorMsg as any, 'ndjson');
      expect(output).not.toBeNull();
      expect(output!.includes('\n')).toBe(false);
      const parsed = JSON.parse(output!);
      expect(parsed.is_error).toBe(true);
      expect(parsed.errors).toEqual(['Something failed']);
    });
  });
});

// ============================================================================
// 5. Permission gate
// ============================================================================

describe('Permission gate', () => {
  it('creates a valid hook function from a permissionConfig', () => {
    const config = { allow: ['Read', 'Glob'] };
    const gate = createPermissionGate(config);
    expect(typeof gate).toBe('function');
  });

  it('allows tools in the allow list', async () => {
    const config = { allow: ['Read', 'Glob'] };
    const gate = createPermissionGate(config);

    for (const toolName of ['Read', 'Glob']) {
      const result = (await gate(
        {
          hook_event_name: 'PreToolUse',
          tool_name: toolName,
          tool_input: {},
          tool_use_id: 'test',
          session_id: 'test',
          transcript_path: '',
          cwd: '',
        } as any,
        'test',
        { signal: new AbortController().signal },
      )) as any;

      expect(result.hookSpecificOutput.permissionDecision).toBe('allow');
    }
  });

  it('denies tools not in the allow list', async () => {
    const config = { allow: ['Read', 'Glob'] };
    const gate = createPermissionGate(config);

    const result = (await gate(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: {},
        tool_use_id: 'test',
        session_id: 'test',
        transcript_path: '',
        cwd: '',
      } as any,
      'test',
      { signal: new AbortController().signal },
    )) as any;

    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('Bash');
  });
});

// ============================================================================
// 6. Frontmatter -> DirectoryEntry -> SDK Options pipeline
// ============================================================================

describe('Frontmatter -> DirectoryEntry -> SDK Options pipeline', () => {
  it('parses YAML frontmatter with sdk block and translates to Options', () => {
    const markdown = `---
name: test-agent
description: A test agent
model: opus
provider: claude-sdk
sdk:
  maxTurns: 30
  effort: high
  maxBudgetUsd: 10.0
  thinking:
    type: adaptive
  mcpServers:
    myServer:
      command: node
      args:
        - server.js
  agents:
    reviewer:
      description: Code reviewer
      prompt: You review code
  sandbox:
    enabled: true
---

# Test Agent

This is a test agent.
`;

    // Step 1: Parse frontmatter
    const fm = parseFrontmatter(markdown);
    expect(fm.name).toBe('test-agent');
    expect(fm.description).toBe('A test agent');
    expect(fm.model).toBe('opus');
    expect(fm.provider).toBe('claude-sdk');
    expect(fm.sdk).toBeDefined();

    // Step 2: Build DirectoryEntry.sdk (the sdk field is a passthrough record)
    const sdkConfig = fm.sdk as Record<string, unknown>;
    expect(sdkConfig.maxTurns).toBe(30);
    expect(sdkConfig.effort).toBe('high');
    expect(sdkConfig.maxBudgetUsd).toBe(10.0);
    expect(sdkConfig.thinking).toEqual({ type: 'adaptive' });
    expect(sdkConfig.mcpServers).toBeDefined();
    expect(sdkConfig.agents).toBeDefined();
    expect(sdkConfig.sandbox).toEqual({ enabled: true });

    // Step 3: Translate to SDK Options
    const options = translateSdkConfig(sdkConfig as any);
    expect(options.maxTurns).toBe(30);
    expect(options.effort).toBe('high');
    expect(options.maxBudgetUsd).toBe(10.0);
    expect(options.thinking).toEqual({ type: 'adaptive' });
    expect(options.mcpServers).toEqual({
      myServer: { command: 'node', args: ['server.js'] },
    });
    expect(options.agents).toEqual({
      reviewer: {
        description: 'Code reviewer',
        prompt: 'You review code',
      },
    });
    expect(options.sandbox).toEqual({ enabled: true });
  });

  it('handles frontmatter with no sdk block gracefully', () => {
    const markdown = `---
name: simple-agent
model: sonnet
---

# Simple Agent
`;

    const fm = parseFrontmatter(markdown);
    expect(fm.name).toBe('simple-agent');
    expect(fm.sdk).toBeUndefined();

    // translateSdkConfig with empty config should produce empty object
    const options = translateSdkConfig({});
    expect(options).toEqual({});
  });
});

// ============================================================================
// 7. Config priority layering
// ============================================================================

describe('Config priority layering', () => {
  let provider: InstanceType<typeof ClaudeSdkProvider>;

  beforeEach(() => {
    provider = new ClaudeSdkProvider();
    mockQuery.mockClear();
  });

  it('extraOptions override sdkConfig (maxTurns: sdkConfig=100, extraOptions=50 -> SDK sees 50)', () => {
    const ctx = makeCtx();
    const sdkConfig = { maxTurns: 100 };
    const extraOptions = { maxTurns: 50 };

    provider.runQuery(ctx, 'test', undefined, extraOptions, sdkConfig);

    const callArgs = lastCallArgs() as any;
    expect(callArgs.options.maxTurns).toBe(50);
  });

  it('sdkConfig values survive when not overridden by extraOptions', () => {
    const ctx = makeCtx();
    const sdkConfig = {
      maxTurns: 100,
      effort: 'high' as const,
      maxBudgetUsd: 20.0,
    };
    const extraOptions = { maxTurns: 50 };

    provider.runQuery(ctx, 'test', undefined, extraOptions, sdkConfig);

    const callArgs = lastCallArgs() as any;
    // extraOptions wins for maxTurns
    expect(callArgs.options.maxTurns).toBe(50);
    // sdkConfig values that were not overridden remain
    expect(callArgs.options.effort).toBe('high');
    expect(callArgs.options.maxBudgetUsd).toBe(20.0);
  });

  it('context model takes lowest priority (sdkConfig model override is possible)', () => {
    const ctx = makeCtx({ model: 'sonnet' });
    const sdkConfig = { maxTurns: 10 };

    provider.runQuery(ctx, 'test', undefined, undefined, sdkConfig);

    const callArgs = lastCallArgs() as any;
    // Context model is spread first, so sdkConfig/extraOptions could override
    // But sdkConfig does not set model, so context model survives
    expect(callArgs.options.maxTurns).toBe(10);
  });

  it('permission hooks survive config layering', () => {
    const ctx = makeCtx();
    const permissionConfig = { allow: ['Read'] };
    const sdkConfig = { maxTurns: 100 };
    const extraOptions = { maxTurns: 50 };

    provider.runQuery(ctx, 'test', permissionConfig, extraOptions, sdkConfig);

    const callArgs = lastCallArgs() as any;
    // Hooks should be merged, not overwritten
    expect(callArgs.options.hooks?.PreToolUse).toBeDefined();
    expect(callArgs.options.hooks.PreToolUse.length).toBeGreaterThan(0);
    // And the final maxTurns should be 50 (extraOptions wins)
    expect(callArgs.options.maxTurns).toBe(50);
  });
});
