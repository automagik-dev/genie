import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { sessionSync } from '../handlers/session-sync.js';
import type { HookPayload } from '../types.js';

/**
 * session-sync is fire-and-forget and must NEVER throw — PreToolUse is a
 * blocking event, so a crash would deny the tool use. These tests verify
 * the no-op paths (missing context, test env) return cleanly without I/O.
 */
describe('session-sync handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('no-op when session_id is missing', async () => {
    const payload: HookPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
    };
    const result = await sessionSync(payload);
    expect(result).toBeUndefined();
  });

  test('no-op in test env even with full payload', async () => {
    process.env.NODE_ENV = 'test';
    process.env.GENIE_AGENT_NAME = 'worker';
    process.env.GENIE_TEAM = 'alpha';
    const payload: HookPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      session_id: 'abc-123',
    };
    const result = await sessionSync(payload);
    expect(result).toBeUndefined();
  });

  test('no-op when agent name cannot be resolved', async () => {
    // BUN_ENV guard off, but no GENIE_AGENT_NAME / teammate_name
    process.env.NODE_ENV = 'production';
    process.env.BUN_ENV = 'production';
    process.env.GENIE_AGENT_NAME = undefined;
    process.env.GENIE_TEAM = undefined;
    const payload: HookPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      session_id: 'abc-123',
    };
    const result = await sessionSync(payload);
    expect(result).toBeUndefined();
  });

  test('never throws on non-string session_id', async () => {
    process.env.GENIE_AGENT_NAME = 'worker';
    process.env.GENIE_TEAM = 'alpha';
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      session_id: 12345 as unknown as string,
    } as HookPayload;
    const result = await sessionSync(payload);
    expect(result).toBeUndefined();
  });
});
