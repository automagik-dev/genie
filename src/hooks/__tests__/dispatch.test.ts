import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { dispatch } from '../index.js';

describe('genie hook dispatch', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.GENIE_AGENT_NAME = 'test-worker';
    process.env.GENIE_TEAM = 'test-team';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('returns empty string for invalid JSON', async () => {
    const result = await dispatch('not json');
    expect(result).toBe('');
  });

  test('returns empty string for missing hook_event_name', async () => {
    const result = await dispatch(JSON.stringify({ tool_name: 'Bash' }));
    expect(result).toBe('');
  });

  test('returns empty string for unmatched event', async () => {
    const result = await dispatch(
      JSON.stringify({
        hook_event_name: 'PreCompact',
      }),
    );
    expect(result).toBe('');
  });

  test('returns empty string for unmatched tool_name', async () => {
    const result = await dispatch(
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
      }),
    );
    expect(result).toBe('');
  });

  test('identity-inject adds [from:] tag to SendMessage content', async () => {
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'SendMessage',
      tool_input: {
        type: 'message',
        recipient: 'team-lead',
        content: 'hello world',
        summary: 'test',
      },
    };

    const result = await dispatch(JSON.stringify(payload));
    const parsed = JSON.parse(result);

    expect(parsed.updatedInput).toBeDefined();
    expect(parsed.updatedInput.content).toBe('[from:test-worker] hello world');
    expect(parsed.updatedInput.recipient).toBe('team-lead');
    expect(parsed.updatedInput.type).toBe('message');
  });

  test('identity-inject does not double-tag', async () => {
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'SendMessage',
      tool_input: {
        type: 'message',
        recipient: 'team-lead',
        content: '[from:test-worker] already tagged',
        summary: 'test',
      },
    };

    const result = await dispatch(JSON.stringify(payload));
    // No updatedInput since content is already tagged
    expect(result).toBe('');
  });

  test('identity-inject works with native CC SendMessage (no type, message field)', async () => {
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'SendMessage',
      tool_input: {
        to: 'team-lead',
        message: 'hello from native CC',
      },
    };

    const result = await dispatch(JSON.stringify(payload));
    const parsed = JSON.parse(result);

    expect(parsed.updatedInput).toBeDefined();
    expect(parsed.updatedInput.message).toBe('[from:test-worker] hello from native CC');
    // Should not create a content field
    expect(parsed.updatedInput.content).toBeUndefined();
  });

  test('identity-inject skips non-message types', async () => {
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'SendMessage',
      tool_input: {
        type: 'shutdown_response',
        request_id: 'abc',
        approve: true,
      },
    };

    const result = await dispatch(JSON.stringify(payload));
    expect(result).toBe('');
  });

  test('identity-inject skips when GENIE_AGENT_NAME is unset', async () => {
    process.env.GENIE_AGENT_NAME = undefined;

    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'SendMessage',
      tool_input: {
        type: 'message',
        recipient: 'team-lead',
        content: 'hello',
        summary: 'test',
      },
    };

    const result = await dispatch(JSON.stringify(payload));
    expect(result).toBe('');
  });

  test('identity-inject works for broadcast type', async () => {
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'SendMessage',
      tool_input: {
        type: 'broadcast',
        content: 'team announcement',
        summary: 'test',
      },
    };

    const result = await dispatch(JSON.stringify(payload));
    const parsed = JSON.parse(result);

    expect(parsed.updatedInput.content).toBe('[from:test-worker] team announcement');
  });
});

describe('handler chain behavior', () => {
  beforeEach(() => {
    process.env.GENIE_AGENT_NAME = 'test-worker';
    process.env.GENIE_TEAM = 'test-team';
  });

  afterEach(() => {
    process.env.GENIE_AGENT_NAME = undefined;
    process.env.GENIE_TEAM = undefined;
  });

  test('auto-spawn handler allows messages to team-lead without spawning', async () => {
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'SendMessage',
      tool_input: {
        type: 'message',
        recipient: 'team-lead',
        content: 'hello boss',
        summary: 'test',
      },
    };

    // Should succeed without errors (auto-spawn skips team-lead)
    const result = await dispatch(JSON.stringify(payload));
    const parsed = JSON.parse(result);
    expect(parsed.updatedInput.content).toBe('[from:test-worker] hello boss');
  });
});
