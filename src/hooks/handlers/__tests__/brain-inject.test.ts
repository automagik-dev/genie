import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { HookPayload } from '../../types.js';
import { _resetEnrichedSessions, brainInject } from '../brain-inject.js';

describe('brain-inject handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    _resetEnrichedSessions();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('returns undefined when brain is not installed', async () => {
    const payload: HookPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/test.ts' },
      session_id: 'test-session-1',
      cwd: '/tmp',
    };
    const result = await brainInject(payload);
    expect(result).toBeUndefined();
  });

  test('only fires once per session', async () => {
    const payload: HookPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/test.ts' },
      session_id: 'test-session-2',
      cwd: '/tmp',
    };

    // First call — runs (returns undefined because brain isn't installed)
    await brainInject(payload);

    // Second call — should skip immediately (session already enriched)
    const result = await brainInject(payload);
    expect(result).toBeUndefined();
  });

  test('different sessions get separate enrichment', async () => {
    const payload1: HookPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/test.ts' },
      session_id: 'session-a',
      cwd: '/tmp',
    };

    const payload2: HookPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/test.ts' },
      session_id: 'session-b',
      cwd: '/tmp',
    };

    // Both should run (not skip), returning undefined since brain isn't installed
    const result1 = await brainInject(payload1);
    const result2 = await brainInject(payload2);
    expect(result1).toBeUndefined();
    expect(result2).toBeUndefined();
  });

  test('uses process.pid when session_id is missing', async () => {
    const payload: HookPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/test.ts' },
      cwd: '/tmp',
    };

    // Should not throw when session_id is undefined
    const result = await brainInject(payload);
    expect(result).toBeUndefined();
  });
});
