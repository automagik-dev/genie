/**
 * Tests for Codex log parsing and normalization
 * Run with: bun test src/lib/codex-logs.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { extractCodexContent, parseCodexLine } from './codex-logs.js';

// ============================================================================
// Test Fixtures — real Codex JSONL lines
// ============================================================================

const sessionMeta = JSON.stringify({
  timestamp: '2026-03-19T16:06:10.906Z',
  type: 'session_meta',
  payload: {
    id: '019d06d8-dee4-7970-8e18-133489a1221f',
    cwd: '/Users/luis/project',
    cli_version: '0.114.0',
    source: 'vscode',
    model_provider: 'openai',
  },
});

const userMessage = JSON.stringify({
  timestamp: '2026-03-19T16:06:10.909Z',
  type: 'event_msg',
  payload: { type: 'user_message', message: 'hello codex' },
});

const agentMessage = JSON.stringify({
  timestamp: '2026-03-19T16:06:20.468Z',
  type: 'event_msg',
  payload: { type: 'agent_message', message: 'Hi! How can I help?', phase: 'final_answer' },
});

const functionCall = JSON.stringify({
  timestamp: '2025-11-03T20:50:16.216Z',
  type: 'response_item',
  payload: {
    type: 'function_call',
    name: 'shell',
    arguments: '{"command":["bash","-lc","cat foo.ts"],"workdir":"/Users/luis/project"}',
    call_id: 'call_abc123',
  },
});

const functionCallOutput = JSON.stringify({
  timestamp: '2025-11-03T20:50:16.216Z',
  type: 'response_item',
  payload: {
    type: 'function_call_output',
    call_id: 'call_abc123',
    output: '{"output":"file contents here"}',
  },
});

const webSearchCall = JSON.stringify({
  timestamp: '2026-03-19T16:44:59.862Z',
  type: 'response_item',
  payload: {
    type: 'web_search_call',
    status: 'completed',
    action: { type: 'search', query: 'how to use bun:sqlite' },
  },
});

const reasoning = JSON.stringify({
  timestamp: '2026-03-19T16:06:19.774Z',
  type: 'response_item',
  payload: { type: 'reasoning', summary: [], encrypted_content: 'gAAAA...' },
});

const responseItemUser = JSON.stringify({
  timestamp: '2026-03-19T16:06:10.908Z',
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'inline user message' }],
  },
});

const responseItemDeveloper = JSON.stringify({
  timestamp: '2026-03-19T16:06:10.908Z',
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'developer',
    content: [{ type: 'input_text', text: 'system instructions' }],
  },
});

const tokenCount = JSON.stringify({
  timestamp: '2026-03-19T16:06:20.491Z',
  type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 50 } } },
});

const taskComplete = JSON.stringify({
  timestamp: '2026-03-19T16:06:20.495Z',
  type: 'event_msg',
  payload: { type: 'task_complete', turn_id: 'turn-1' },
});

// ============================================================================
// Tests
// ============================================================================

describe('parseCodexLine', () => {
  test('skips session_meta', () => {
    expect(parseCodexLine(sessionMeta)).toEqual([]);
  });

  test('parses user_message event_msg', () => {
    const entries = parseCodexLine(userMessage);
    expect(entries).toHaveLength(1);
    expect(entries[0].role).toBe('user');
    expect(entries[0].text).toBe('hello codex');
    expect(entries[0].provider).toBe('codex');
  });

  test('parses agent_message event_msg', () => {
    const entries = parseCodexLine(agentMessage);
    expect(entries).toHaveLength(1);
    expect(entries[0].role).toBe('assistant');
    expect(entries[0].text).toBe('Hi! How can I help?');
  });

  test('parses function_call as tool_call', () => {
    const entries = parseCodexLine(functionCall);
    expect(entries).toHaveLength(1);
    expect(entries[0].role).toBe('tool_call');
    expect(entries[0].toolCall?.name).toBe('shell');
    expect(entries[0].toolCall?.id).toBe('call_abc123');
    expect(entries[0].toolCall?.input).toHaveProperty('command');
  });

  test('parses function_call_output as tool_result', () => {
    const entries = parseCodexLine(functionCallOutput);
    expect(entries).toHaveLength(1);
    expect(entries[0].role).toBe('tool_result');
    expect(entries[0].text).toContain('file contents here');
  });

  test('parses web_search_call as tool_call', () => {
    const entries = parseCodexLine(webSearchCall);
    expect(entries).toHaveLength(1);
    expect(entries[0].role).toBe('tool_call');
    expect(entries[0].toolCall?.name).toBe('web_search');
    expect(entries[0].text).toContain('how to use bun:sqlite');
  });

  test('skips reasoning entries', () => {
    expect(parseCodexLine(reasoning)).toEqual([]);
  });

  test('parses response_item message with role user', () => {
    const entries = parseCodexLine(responseItemUser);
    expect(entries).toHaveLength(1);
    expect(entries[0].role).toBe('user');
    expect(entries[0].text).toBe('inline user message');
  });

  test('parses response_item message with role developer as system', () => {
    const entries = parseCodexLine(responseItemDeveloper);
    expect(entries).toHaveLength(1);
    expect(entries[0].role).toBe('system');
    expect(entries[0].text).toBe('system instructions');
  });

  test('skips token_count events', () => {
    expect(parseCodexLine(tokenCount)).toEqual([]);
  });

  test('skips task_complete events', () => {
    expect(parseCodexLine(taskComplete)).toEqual([]);
  });

  test('handles empty/invalid lines', () => {
    expect(parseCodexLine('')).toEqual([]);
    expect(parseCodexLine('not json')).toEqual([]);
    expect(parseCodexLine('{}')).toEqual([]);
  });
});

describe('extractCodexContent', () => {
  test('extracts from string', () => {
    expect(extractCodexContent('hello')).toBe('hello');
  });

  test('extracts from content array with text', () => {
    const content = [
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
    ];
    expect(extractCodexContent(content)).toBe('hello world');
  });

  test('extracts from content array with input_text', () => {
    const content = [{ type: 'input_text', input_text: 'user input' }];
    expect(extractCodexContent(content)).toBe('user input');
  });

  test('handles empty/null', () => {
    expect(extractCodexContent(null)).toBe('');
    expect(extractCodexContent([])).toBe('');
    expect(extractCodexContent(undefined)).toBe('');
  });
});
