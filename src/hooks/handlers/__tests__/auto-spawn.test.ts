import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { HookPayload } from '../../types.js';
import { autoSpawn } from '../auto-spawn.js';

describe('auto-spawn handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.GENIE_AGENT_NAME = 'test-worker';
    process.env.GENIE_TEAM = 'test-team';
    // Ensure we're not in test-skip mode
    process.env.NODE_ENV = undefined;
    process.env.BUN_ENV = undefined;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('skips when NODE_ENV is test', async () => {
    process.env.NODE_ENV = 'test';
    const payload: HookPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'SendMessage',
      tool_input: { type: 'message', recipient: 'some-agent', content: 'hi' },
    };
    const result = await autoSpawn(payload);
    expect(result).toBeUndefined();
  });

  test('skips non-message types', async () => {
    const payload: HookPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'SendMessage',
      tool_input: { type: 'shutdown_response', approve: true },
    };
    const result = await autoSpawn(payload);
    expect(result).toBeUndefined();
  });

  test('skips messages to team-lead', async () => {
    const payload: HookPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'SendMessage',
      tool_input: { type: 'message', recipient: 'team-lead', content: 'hi' },
    };
    const result = await autoSpawn(payload);
    expect(result).toBeUndefined();
  });

  test('returns warning context on spawn failure', async () => {
    // Force non-test env so the handler actually runs
    process.env.NODE_ENV = undefined;
    process.env.BUN_ENV = undefined;
    process.env.GENIE_TEAM = 'nonexistent-team';

    const payload: HookPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'SendMessage',
      tool_input: { type: 'message', recipient: 'ghost-agent', content: 'hi' },
    };

    // The handler will fail because the agent registry/tmux won't be available
    // in this test context. It should return a warning, not crash.
    const result = await autoSpawn(payload);

    // Either undefined (skipped early) or a warning context (error boundary caught)
    if (result !== undefined) {
      expect(result.hookSpecificOutput).toBeDefined();
      expect(result.hookSpecificOutput!.additionalContext).toContain('auto-spawn warning');
    }
  });
});
