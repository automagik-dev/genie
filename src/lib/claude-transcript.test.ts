/**
 * Tests for Claude Code transcript adapter
 * Run with: bun test src/lib/claude-transcript.test.ts
 */

import { describe, expect, test } from 'bun:test';
import type { ClaudeLogEntry } from './claude-logs.js';
import { claudeEntryToTranscript } from './claude-logs.js';

function makeEntry(overrides: Partial<ClaudeLogEntry>): ClaudeLogEntry {
  return {
    type: 'user',
    sessionId: 'test-session',
    uuid: 'msg-1',
    parentUuid: null,
    timestamp: '2026-03-19T10:00:00.000Z',
    cwd: '/tmp/test',
    raw: {},
    ...overrides,
  };
}

describe('claudeEntryToTranscript', () => {
  test('converts user message', () => {
    const entry = makeEntry({
      type: 'user',
      message: { role: 'user', content: 'hello' },
    });
    const result = claudeEntryToTranscript(entry);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect(result[0].text).toBe('hello');
    expect(result[0].provider).toBe('claude');
  });

  test('converts assistant text message', () => {
    const entry = makeEntry({
      type: 'assistant',
      message: { role: 'assistant', content: 'I can help with that' },
    });
    const result = claudeEntryToTranscript(entry);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('assistant');
    expect(result[0].text).toBe('I can help with that');
  });

  test('converts assistant message with tool calls', () => {
    const entry = makeEntry({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Let me read that' }] },
      toolCalls: [
        { id: 'tc1', name: 'Read', input: { file_path: 'foo.ts' } },
        { id: 'tc2', name: 'Bash', input: { command: 'ls' } },
      ],
    });
    const result = claudeEntryToTranscript(entry);
    // 1 assistant text + 2 tool calls
    expect(result).toHaveLength(3);
    expect(result[0].role).toBe('assistant');
    expect(result[1].role).toBe('tool_call');
    expect(result[1].toolCall?.name).toBe('Read');
    expect(result[2].role).toBe('tool_call');
    expect(result[2].toolCall?.name).toBe('Bash');
  });

  test('converts assistant with content array', () => {
    const entry = makeEntry({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'first part' },
          { type: 'text', text: 'second part' },
        ],
      },
    });
    const result = claudeEntryToTranscript(entry);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('first part second part');
  });

  test('skips file-history-snapshot', () => {
    const entry = makeEntry({ type: 'file-history-snapshot' });
    expect(claudeEntryToTranscript(entry)).toEqual([]);
  });

  test('skips user with empty content', () => {
    const entry = makeEntry({
      type: 'user',
      message: { role: 'user', content: '' },
    });
    expect(claudeEntryToTranscript(entry)).toEqual([]);
  });

  test('converts system/progress entries', () => {
    const entry = makeEntry({
      type: 'system',
      message: { role: 'system', content: 'session started' },
    });
    const result = claudeEntryToTranscript(entry);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('system');
  });

  test('includes usage when present', () => {
    const entry = makeEntry({
      type: 'assistant',
      message: { role: 'assistant', content: 'response' },
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const result = claudeEntryToTranscript(entry);
    expect(result[0].usage).toEqual({ input: 100, output: 50 });
  });
});
