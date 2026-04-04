import { describe, expect, it } from 'bun:test';
import { formatSdkMessage } from '../claude-sdk-stream.js';

// ============================================================================
// Helpers -- minimal SDKMessage factories
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

function assistantWithToolUse() {
  return {
    type: 'assistant' as const,
    message: {
      content: [
        { type: 'text', text: 'Let me check that.' },
        { type: 'tool_use', name: 'Read', id: 'tu-1', input: {} },
      ],
    },
    parent_tool_use_id: null,
    uuid: 'uuid-1b',
    session_id: 'sess-1',
  };
}

function assistantWithError() {
  return {
    type: 'assistant' as const,
    message: { content: [] },
    error: 'rate_limit' as const,
    parent_tool_use_id: null,
    uuid: 'uuid-1c',
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

function resultError() {
  return {
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
    uuid: 'uuid-3',
    session_id: 'sess-1',
  };
}

function streamEventTextDelta(text = 'partial') {
  return {
    type: 'stream_event' as const,
    event: {
      type: 'content_block_delta' as const,
      index: 0,
      delta: { type: 'text_delta' as const, text },
    },
    parent_tool_use_id: null,
    uuid: 'uuid-4',
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
    uuid: 'uuid-5',
    session_id: 'sess-1',
  };
}

function toolUseSummary() {
  return {
    type: 'tool_use_summary' as const,
    summary: 'Ran 3 bash commands',
    preceding_tool_use_ids: ['tu-1', 'tu-2', 'tu-3'],
    uuid: 'uuid-6',
    session_id: 'sess-1',
  };
}

function systemStatus() {
  return {
    type: 'system' as const,
    subtype: 'status' as const,
    status: 'idle',
    uuid: 'uuid-7',
    session_id: 'sess-1',
  };
}

function rateLimitEvent() {
  return {
    type: 'rate_limit_event' as const,
    rate_limit_info: { status: 'allowed' as const, utilization: 0.3 },
    uuid: 'uuid-8',
    session_id: 'sess-1',
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('claude-sdk-stream', () => {
  // --------------------------------------------------------------------------
  // Text format
  // --------------------------------------------------------------------------
  describe('text format', () => {
    it('formats assistant message with text blocks', () => {
      const result = formatSdkMessage(assistantMsg('hello world') as any, 'text');
      expect(result).toBe('hello world');
    });

    it('formats assistant message with tool_use indicators', () => {
      const result = formatSdkMessage(assistantWithToolUse() as any, 'text');
      expect(result).toContain('Let me check that.');
      expect(result).toContain('[using Read]');
    });

    it('formats assistant message with error', () => {
      const result = formatSdkMessage(assistantWithError() as any, 'text');
      expect(result).toContain('[error: rate_limit]');
    });

    it('formats result success with summary and token usage', () => {
      const result = formatSdkMessage(resultSuccess() as any, 'text');
      expect(result).not.toBeNull();
      expect(result!).toContain('All done');
      expect(result!).toContain('Turns: 3');
      expect(result!).toContain('$0.0500');
      expect(result!).toContain('100in/50out');
    });

    it('formats result error in red', () => {
      const result = formatSdkMessage(resultError() as any, 'text');
      expect(result).not.toBeNull();
      expect(result!).toContain('Something failed');
      // ANSI red escape code
      expect(result!).toContain('\x1b[31m');
    });

    it('formats stream_event text delta for typing effect', () => {
      const result = formatSdkMessage(streamEventTextDelta('hello') as any, 'text');
      expect(result).toBe('hello');
    });

    it('formats tool_progress with tool name and elapsed time', () => {
      const result = formatSdkMessage(toolProgress() as any, 'text');
      expect(result).toContain('[Bash]');
      expect(result).toContain('5s');
    });

    it('formats tool_use_summary with summary text', () => {
      const result = formatSdkMessage(toolUseSummary() as any, 'text');
      expect(result).toContain('Ran 3 bash commands');
    });

    it('formats system status updates', () => {
      const result = formatSdkMessage(systemStatus() as any, 'text');
      expect(result).toContain('[status] idle');
    });

    it('returns null for unknown/non-text types in text format', () => {
      const result = formatSdkMessage(rateLimitEvent() as any, 'text');
      expect(result).toBeNull();
    });

    it('returns null for unknown message types', () => {
      const result = formatSdkMessage({ type: 'unknown_garbage' } as any, 'text');
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // JSON format
  // --------------------------------------------------------------------------
  describe('json format', () => {
    it('returns pretty-printed JSON', () => {
      const msg = assistantMsg('test');
      const result = formatSdkMessage(msg as any, 'json');
      expect(result).toBe(JSON.stringify(msg, null, 2));
    });
  });

  // --------------------------------------------------------------------------
  // NDJSON format
  // --------------------------------------------------------------------------
  describe('ndjson format', () => {
    it('returns single-line valid JSON', () => {
      const msg = assistantMsg('test');
      const result = formatSdkMessage(msg as any, 'ndjson');
      expect(result).not.toBeNull();
      // Must be single line
      expect(result!.includes('\n')).toBe(false);
      // Must be valid JSON that parses back to the original
      const parsed = JSON.parse(result!);
      expect(parsed.type).toBe('assistant');
      expect(parsed.message.content[0].text).toBe('test');
    });

    it('outputs valid JSON for result messages', () => {
      const msg = resultSuccess();
      const result = formatSdkMessage(msg as any, 'ndjson');
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result!);
      expect(parsed.type).toBe('result');
      expect(parsed.subtype).toBe('success');
    });

    it('never returns null (all messages are serializable)', () => {
      // Even types that text format skips should produce valid NDJSON
      const msg = rateLimitEvent();
      const result = formatSdkMessage(msg as any, 'ndjson');
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result!);
      expect(parsed.type).toBe('rate_limit_event');
    });
  });
});
