import { beforeEach, describe, expect, it, mock } from 'bun:test';

// Mock audit before importing the module under test
const mockRecordAuditEvent = mock(() => Promise.resolve());
mock.module('../../audit.js', () => ({
  recordAuditEvent: mockRecordAuditEvent,
}));

const { getEventType, buildEventDetails, routeSdkMessage } = await import('../claude-sdk-events.js');

// ============================================================================
// Helpers — minimal SDKMessage factories
// ============================================================================

function assistantMsg(text = 'hello world') {
  return {
    type: 'assistant' as const,
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    uuid: 'uuid-1',
    session_id: 'sess-1',
  };
}

function resultSuccess() {
  return {
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
    uuid: 'uuid-2',
    session_id: 'sess-1',
  };
}

function resultError(subtype = 'error_during_execution') {
  return {
    type: 'result' as const,
    subtype: subtype as any,
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
    uuid: 'uuid-3',
    session_id: 'sess-1',
  };
}

function systemInit() {
  return {
    type: 'system' as const,
    subtype: 'init' as const,
    model: 'claude-sonnet-4-20250514',
    cwd: '/tmp',
    claude_code_version: '1.0.0',
    tools: ['Read', 'Write', 'Bash'],
    mcp_servers: [],
    apiKeySource: 'env',
    permissionMode: 'bypassPermissions',
    slash_commands: [],
    output_style: 'text',
    skills: [],
    plugins: [],
    uuid: 'uuid-4',
    session_id: 'sess-1',
  };
}

function systemSubtype(subtype: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'system' as const,
    subtype,
    uuid: 'uuid-5',
    session_id: 'sess-1',
    ...extra,
  };
}

function streamEvent() {
  return {
    type: 'stream_event' as const,
    event: { type: 'content_block_delta' },
    parent_tool_use_id: null,
    uuid: 'uuid-6',
    session_id: 'sess-1',
  };
}

function toolProgress() {
  return {
    type: 'tool_progress' as const,
    tool_use_id: 'tu-1',
    tool_name: 'Bash',
    parent_tool_use_id: null,
    elapsed_time_seconds: 5,
    uuid: 'uuid-7',
    session_id: 'sess-1',
  };
}

function toolUseSummary() {
  return {
    type: 'tool_use_summary' as const,
    summary: 'Ran 3 bash commands',
    preceding_tool_use_ids: ['tu-1', 'tu-2', 'tu-3'],
    uuid: 'uuid-8',
    session_id: 'sess-1',
  };
}

function rateLimitEvent() {
  return {
    type: 'rate_limit_event' as const,
    rate_limit_info: { status: 'allowed' as const, utilization: 0.3 },
    uuid: 'uuid-9',
    session_id: 'sess-1',
  };
}

function authStatus() {
  return {
    type: 'auth_status' as const,
    isAuthenticating: false,
    output: ['Authenticated'],
    uuid: 'uuid-10',
    session_id: 'sess-1',
  };
}

function promptSuggestion() {
  return {
    type: 'prompt_suggestion' as const,
    suggestion: 'Run the tests',
    uuid: 'uuid-11',
    session_id: 'sess-1',
  };
}

function userMessage() {
  return {
    type: 'user' as const,
    message: { role: 'user' as const, content: 'hi' },
    parent_tool_use_id: null,
    uuid: 'uuid-12',
    session_id: 'sess-1',
  };
}

function userReplay() {
  return {
    type: 'user' as const,
    message: { role: 'user' as const, content: 'replayed' },
    parent_tool_use_id: null,
    isReplay: true as const,
    uuid: 'uuid-13',
    session_id: 'sess-1',
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('claude-sdk-events', () => {
  beforeEach(() => {
    mockRecordAuditEvent.mockClear();
  });

  // --------------------------------------------------------------------------
  // getEventType — all 24 message types
  // --------------------------------------------------------------------------
  describe('getEventType', () => {
    it('maps assistant -> sdk.assistant.message', () => {
      expect(getEventType(assistantMsg() as any)).toBe('sdk.assistant.message');
    });

    it('maps result success -> sdk.result.success', () => {
      expect(getEventType(resultSuccess() as any)).toBe('sdk.result.success');
    });

    it('maps result error_during_execution -> sdk.result.error', () => {
      expect(getEventType(resultError('error_during_execution') as any)).toBe('sdk.result.error');
    });

    it('maps result error_max_turns -> sdk.result.max_turns', () => {
      expect(getEventType(resultError('error_max_turns') as any)).toBe('sdk.result.max_turns');
    });

    it('maps result error_max_budget_usd -> sdk.result.max_budget', () => {
      expect(getEventType(resultError('error_max_budget_usd') as any)).toBe('sdk.result.max_budget');
    });

    it('maps result error_max_structured_output_retries -> sdk.result.error', () => {
      expect(getEventType(resultError('error_max_structured_output_retries') as any)).toBe('sdk.result.error');
    });

    it('maps system init -> sdk.system', () => {
      expect(getEventType(systemInit() as any)).toBe('sdk.system');
    });

    it('maps system api_retry -> sdk.api.retry', () => {
      expect(getEventType(systemSubtype('api_retry') as any)).toBe('sdk.api.retry');
    });

    it('maps system compact_boundary -> sdk.context.compacted', () => {
      expect(getEventType(systemSubtype('compact_boundary') as any)).toBe('sdk.context.compacted');
    });

    it('maps system elicitation_complete -> sdk.elicitation.complete', () => {
      expect(getEventType(systemSubtype('elicitation_complete') as any)).toBe('sdk.elicitation.complete');
    });

    it('maps system files_persisted -> sdk.files.persisted', () => {
      expect(getEventType(systemSubtype('files_persisted') as any)).toBe('sdk.files.persisted');
    });

    it('maps system hook_progress -> sdk.hook.progress', () => {
      expect(getEventType(systemSubtype('hook_progress') as any)).toBe('sdk.hook.progress');
    });

    it('maps system hook_response -> sdk.hook.response', () => {
      expect(getEventType(systemSubtype('hook_response') as any)).toBe('sdk.hook.response');
    });

    it('maps system hook_started -> sdk.hook.started', () => {
      expect(getEventType(systemSubtype('hook_started') as any)).toBe('sdk.hook.started');
    });

    it('maps system local_command_output -> sdk.command.output', () => {
      expect(getEventType(systemSubtype('local_command_output') as any)).toBe('sdk.command.output');
    });

    it('maps system session_state_changed -> sdk.session.state', () => {
      expect(getEventType(systemSubtype('session_state_changed') as any)).toBe('sdk.session.state');
    });

    it('maps system status -> sdk.status', () => {
      expect(getEventType(systemSubtype('status') as any)).toBe('sdk.status');
    });

    it('maps system task_notification -> sdk.task.notification', () => {
      expect(getEventType(systemSubtype('task_notification') as any)).toBe('sdk.task.notification');
    });

    it('maps system task_progress -> sdk.task.progress', () => {
      expect(getEventType(systemSubtype('task_progress') as any)).toBe('sdk.task.progress');
    });

    it('maps system task_started -> sdk.task.started', () => {
      expect(getEventType(systemSubtype('task_started') as any)).toBe('sdk.task.started');
    });

    it('maps stream_event -> sdk.stream.partial', () => {
      expect(getEventType(streamEvent() as any)).toBe('sdk.stream.partial');
    });

    it('maps tool_progress -> sdk.tool.progress', () => {
      expect(getEventType(toolProgress() as any)).toBe('sdk.tool.progress');
    });

    it('maps tool_use_summary -> sdk.tool.summary', () => {
      expect(getEventType(toolUseSummary() as any)).toBe('sdk.tool.summary');
    });

    it('maps rate_limit_event -> sdk.rate_limit', () => {
      expect(getEventType(rateLimitEvent() as any)).toBe('sdk.rate_limit');
    });

    it('maps auth_status -> sdk.auth.status', () => {
      expect(getEventType(authStatus() as any)).toBe('sdk.auth.status');
    });

    it('maps prompt_suggestion -> sdk.prompt.suggestion', () => {
      expect(getEventType(promptSuggestion() as any)).toBe('sdk.prompt.suggestion');
    });

    it('maps user -> sdk.user.message', () => {
      expect(getEventType(userMessage() as any)).toBe('sdk.user.message');
    });

    it('maps user_replay -> sdk.user.message', () => {
      expect(getEventType(userReplay() as any)).toBe('sdk.user.message');
    });

    it('returns null for unknown type', () => {
      expect(getEventType({ type: 'unknown_garbage' } as any)).toBeNull();
    });

    it('returns null for unknown system subtype', () => {
      expect(getEventType({ type: 'system', subtype: 'totally_unknown' } as any)).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // buildEventDetails — key types
  // --------------------------------------------------------------------------
  describe('buildEventDetails', () => {
    it('extracts text preview for assistant messages', () => {
      const details = buildEventDetails(assistantMsg('Hello, this is a test') as any);
      expect(details.sdkType).toBe('assistant');
      expect(details.textPreview).toBe('Hello, this is a test');
    });

    it('truncates assistant text preview to 200 chars', () => {
      const longText = 'x'.repeat(300);
      const details = buildEventDetails(assistantMsg(longText) as any);
      expect((details.textPreview as string).length).toBe(200);
    });

    it('extracts cost/usage for result success', () => {
      const details = buildEventDetails(resultSuccess() as any);
      expect(details.subtype).toBe('success');
      expect(details.totalCostUsd).toBe(0.05);
      expect(details.numTurns).toBe(3);
      expect(details.durationMs).toBe(1000);
      expect(details.resultPreview).toBe('All done');
    });

    it('extracts errors for result error', () => {
      const details = buildEventDetails(resultError() as any);
      expect(details.isError).toBe(true);
      expect(details.errors).toEqual(['Something failed']);
    });

    it('extracts model/cwd/version for system init', () => {
      const details = buildEventDetails(systemInit() as any);
      expect(details.subtype).toBe('init');
      expect(details.model).toBe('claude-sonnet-4-20250514');
      expect(details.cwd).toBe('/tmp');
      expect(details.version).toBe('1.0.0');
      expect(details.tools).toBe(3);
    });

    it('extracts toolName for tool_progress', () => {
      const details = buildEventDetails(toolProgress() as any);
      expect(details.toolName).toBe('Bash');
      expect(details.toolUseId).toBe('tu-1');
      expect(details.elapsedSeconds).toBe(5);
    });

    it('extracts summary for tool_use_summary', () => {
      const details = buildEventDetails(toolUseSummary() as any);
      expect(details.summaryPreview).toBe('Ran 3 bash commands');
      expect(details.toolUseIds).toEqual(['tu-1', 'tu-2', 'tu-3']);
    });

    it('extracts rate limit status', () => {
      const details = buildEventDetails(rateLimitEvent() as any);
      expect(details.status).toBe('allowed');
      expect(details.utilization).toBe(0.3);
    });

    it('extracts auth status', () => {
      const details = buildEventDetails(authStatus() as any);
      expect(details.isAuthenticating).toBe(false);
    });

    it('extracts suggestion text', () => {
      const details = buildEventDetails(promptSuggestion() as any);
      expect(details.suggestion).toBe('Run the tests');
    });

    it('marks isReplay for user_replay messages', () => {
      const details = buildEventDetails(userReplay() as any);
      expect(details.isReplay).toBe(true);
    });

    it('marks isReplay=false for normal user messages', () => {
      const details = buildEventDetails(userMessage() as any);
      expect(details.isReplay).toBe(false);
    });

    it('extracts hook details for hook_response', () => {
      const msg = systemSubtype('hook_response', {
        hook_id: 'h-1',
        hook_name: 'my-hook',
        hook_event: 'PreToolUse',
        outcome: 'success',
        exit_code: 0,
      });
      const details = buildEventDetails(msg as any);
      expect(details.hookId).toBe('h-1');
      expect(details.hookName).toBe('my-hook');
      expect(details.outcome).toBe('success');
      expect(details.exitCode).toBe(0);
    });

    it('extracts session state for session_state_changed', () => {
      const msg = systemSubtype('session_state_changed', { state: 'idle' });
      const details = buildEventDetails(msg as any);
      expect(details.state).toBe('idle');
    });

    it('extracts file count for files_persisted', () => {
      const msg = systemSubtype('files_persisted', {
        files: [{ filename: 'a.txt', file_id: 'f1' }],
        failed: [],
      });
      const details = buildEventDetails(msg as any);
      expect(details.fileCount).toBe(1);
      expect(details.failedCount).toBe(0);
    });

    it('extracts api_retry details', () => {
      const msg = systemSubtype('api_retry', {
        attempt: 2,
        max_retries: 5,
        retry_delay_ms: 1000,
        error_status: 429,
        error: 'rate_limit',
      });
      const details = buildEventDetails(msg as any);
      expect(details.attempt).toBe(2);
      expect(details.maxRetries).toBe(5);
      expect(details.retryDelayMs).toBe(1000);
      expect(details.errorStatus).toBe(429);
      expect(details.error).toBe('rate_limit');
    });

    it('extracts compact_boundary metadata', () => {
      const msg = systemSubtype('compact_boundary', {
        compact_metadata: { trigger: 'auto', pre_tokens: 50000 },
      });
      const details = buildEventDetails(msg as any);
      expect(details.trigger).toBe('auto');
      expect(details.preTokens).toBe(50000);
    });

    it('extracts task_started details', () => {
      const msg = systemSubtype('task_started', {
        task_id: 't-1',
        description: 'Run tests',
        task_type: 'local_workflow',
      });
      const details = buildEventDetails(msg as any);
      expect(details.taskId).toBe('t-1');
      expect(details.description).toBe('Run tests');
      expect(details.taskType).toBe('local_workflow');
    });

    it('extracts task_notification details', () => {
      const msg = systemSubtype('task_notification', {
        task_id: 't-2',
        status: 'completed',
        summary: 'All tests passed',
        usage: { total_tokens: 500, tool_uses: 3, duration_ms: 2000 },
      });
      const details = buildEventDetails(msg as any);
      expect(details.taskId).toBe('t-2');
      expect(details.status).toBe('completed');
      expect(details.summary).toBe('All tests passed');
      expect(details.usage).toEqual({ total_tokens: 500, tool_uses: 3, duration_ms: 2000 });
    });

    it('is sparse for stream_event (high frequency)', () => {
      const details = buildEventDetails(streamEvent() as any);
      expect(details.sdkType).toBe('stream_event');
      // Should NOT include event payload to keep details lean
      expect(details.event).toBeUndefined();
    });

    it('extracts elicitation_complete details', () => {
      const msg = systemSubtype('elicitation_complete', {
        mcp_server_name: 'my-server',
        elicitation_id: 'e-1',
      });
      const details = buildEventDetails(msg as any);
      expect(details.mcpServerName).toBe('my-server');
      expect(details.elicitationId).toBe('e-1');
    });

    it('extracts local_command_output content preview', () => {
      const msg = systemSubtype('local_command_output', {
        content: 'Cost: $0.05',
      });
      const details = buildEventDetails(msg as any);
      expect(details.contentPreview).toBe('Cost: $0.05');
    });
  });

  // --------------------------------------------------------------------------
  // routeSdkMessage — integration with audit
  // --------------------------------------------------------------------------
  describe('routeSdkMessage', () => {
    it('calls recordAuditEvent with correct arguments', async () => {
      const msg = assistantMsg('test');
      const result = await routeSdkMessage(msg as any, 'exec-1', 'agent-1');

      expect(result).toBe('sdk.assistant.message');
      expect(mockRecordAuditEvent).toHaveBeenCalledTimes(1);
      expect(mockRecordAuditEvent).toHaveBeenCalledWith(
        'sdk_message',
        'exec-1',
        'sdk.assistant.message',
        'agent-1',
        expect.objectContaining({
          sdkType: 'assistant',
          executorId: 'exec-1',
          textPreview: 'test',
        }),
      );
    });

    it('returns null for unknown message types without calling audit', async () => {
      const result = await routeSdkMessage({ type: 'unknown' } as any, 'exec-1', 'agent-1');
      expect(result).toBeNull();
      expect(mockRecordAuditEvent).not.toHaveBeenCalled();
    });

    it('includes executorId in details', async () => {
      await routeSdkMessage(toolProgress() as any, 'exec-99', 'agent-1');
      const call = mockRecordAuditEvent.mock.calls[0] as unknown as unknown[];
      const details = call?.[4] as Record<string, unknown>;
      expect(details.executorId).toBe('exec-99');
    });

    it('routes result success correctly', async () => {
      const result = await routeSdkMessage(resultSuccess() as any, 'exec-1', 'agent-1');
      expect(result).toBe('sdk.result.success');
      expect(mockRecordAuditEvent).toHaveBeenCalledWith(
        'sdk_message',
        'exec-1',
        'sdk.result.success',
        'agent-1',
        expect.objectContaining({
          totalCostUsd: 0.05,
          numTurns: 3,
        }),
      );
    });

    it('routes system init correctly', async () => {
      const result = await routeSdkMessage(systemInit() as any, 'exec-1', 'agent-1');
      expect(result).toBe('sdk.system');
    });
  });
});
