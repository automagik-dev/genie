import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { dispatch, runHandler } from '../index.js';
import type { Handler, HookPayload } from '../types.js';

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

  test('identity-inject skips when both GENIE_AGENT_ID and GENIE_AGENT_NAME are unset', async () => {
    // G7 — must clear BOTH env vars to suppress injection. Setting only the
    // name to undefined is insufficient post-flip because readEnvAgentId
    // falls back from a UUID env id when the name is missing.
    process.env.GENIE_AGENT_ID = undefined;
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

  test('identity-inject prefers GENIE_AGENT_NAME for human-readable display when both env vars set', async () => {
    // G7 — readEnvAgentId/readEnvAgentName both succeed; tag prefers name.
    process.env.GENIE_AGENT_ID = '11111111-2222-3333-4444-555555555555';
    process.env.GENIE_AGENT_NAME = 'test-worker';

    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'SendMessage',
      tool_input: {
        type: 'message',
        recipient: 'team-lead',
        content: 'env id + name set',
        summary: 'test',
      },
    };

    const result = await dispatch(JSON.stringify(payload));
    const parsed = JSON.parse(result);
    expect(parsed.updatedInput.content).toBe('[from:test-worker] env id + name set');
  });

  test('identity-inject falls back to GENIE_AGENT_ID when only the UUID is set', async () => {
    // G7 — name unset; tag uses the env id (last-resort identifier).
    process.env.GENIE_AGENT_ID = '11111111-2222-3333-4444-555555555555';
    process.env.GENIE_AGENT_NAME = undefined;

    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'SendMessage',
      tool_input: {
        type: 'message',
        recipient: 'team-lead',
        content: 'only id set',
        summary: 'test',
      },
    };

    const result = await dispatch(JSON.stringify(payload));
    const parsed = JSON.parse(result);
    expect(parsed.updatedInput.content).toBe('[from:11111111-2222-3333-4444-555555555555] only id set');
  });

  test('identity-inject ignores GENIE_AGENT_ID when it is not a UUID', async () => {
    // G7 — readEnvAgentId returns undefined for non-UUID; falls back to name.
    process.env.GENIE_AGENT_ID = 'cli:something';
    process.env.GENIE_AGENT_NAME = 'test-worker';

    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'SendMessage',
      tool_input: {
        type: 'message',
        recipient: 'team-lead',
        content: 'bad id',
        summary: 'test',
      },
    };

    const result = await dispatch(JSON.stringify(payload));
    const parsed = JSON.parse(result);
    expect(parsed.updatedInput.content).toBe('[from:test-worker] bad id');
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

describe('UserPromptSubmit dispatch flow', () => {
  const originalEnv = { ...process.env };
  let originalDeps: { findCodexAgent: unknown; fetchUnread: unknown; markReadBatch: unknown };

  beforeEach(async () => {
    process.env.GENIE_AGENT_NAME = 'codex-eng';
    process.env.GENIE_TEAM = 'test-team';
    process.env.NODE_ENV = undefined;
    process.env.BUN_ENV = undefined;
    const mod = await import('../handlers/codex-inbox-deliver.js');
    originalDeps = { ...mod._deps };
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    const mod = await import('../handlers/codex-inbox-deliver.js');
    mod._deps.findCodexAgent = originalDeps.findCodexAgent as typeof mod._deps.findCodexAgent;
    mod._deps.fetchUnread = originalDeps.fetchUnread as typeof mod._deps.fetchUnread;
    mod._deps.markReadBatch = originalDeps.markReadBatch as typeof mod._deps.markReadBatch;
  });

  test('codex inbox deliver additionalContext surfaces as hookSpecificOutput', async () => {
    const mod = await import('../handlers/codex-inbox-deliver.js');
    mod._deps.findCodexAgent = async () => ({
      id: 'agent-uuid',
      role: 'codex-eng',
      customName: 'codex-eng',
      repoPath: '/repo',
      provider: 'codex',
    });
    mod._deps.fetchUnread = async () => [
      {
        id: 'msg-1',
        from: 'operator',
        to: 'codex-eng',
        body: 'pong test',
        createdAt: '2026-04-28T00:00:00Z',
        read: false,
        deliveredAt: null,
        source: 'agent',
        meta: {},
      },
    ];
    mod._deps.markReadBatch = async () => 1;

    const payload = {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-1',
      cwd: '/repo',
      prompt: 'hi',
    };
    const raw = await dispatch(JSON.stringify(payload));
    expect(raw).not.toBe('');
    const parsed = JSON.parse(raw);
    expect(parsed.hookSpecificOutput).toBeDefined();
    expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(parsed.hookSpecificOutput.additionalContext).toBe('pong test');
  });

  test('UserPromptSubmit returns empty when no codex agent matches (no hookSpecificOutput)', async () => {
    const mod = await import('../handlers/codex-inbox-deliver.js');
    mod._deps.findCodexAgent = async () => null;
    mod._deps.fetchUnread = async () => [];
    mod._deps.markReadBatch = async () => 0;

    const payload = {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-1',
      cwd: '/repo',
      prompt: 'hi',
    };
    const raw = await dispatch(JSON.stringify(payload));
    expect(raw).toBe('');
  });
});

describe('runHandler crash behavior', () => {
  const crashingHandler: Handler = {
    version: '1',
    source: 'builtin',
    manifest_path: 'src/hooks/__tests__/dispatch.test.ts',
    name: 'crashing-handler',
    event: 'PreToolUse',
    matcher: /^Bash$/,
    priority: 1,
    fn: async () => {
      throw new Error('handler exploded');
    },
  };

  const payload: HookPayload = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'echo hello' },
  };

  test('blocking handler crash returns deny', async () => {
    const result = await runHandler(crashingHandler, payload, undefined, true);
    expect(result).toBeDefined();
    expect(result!.decision).toBe('deny');
    expect(result!.reason).toContain('handler crashed');
    expect(result!.reason).toContain('handler exploded');
  });

  test('non-blocking handler crash returns undefined (allow)', async () => {
    const result = await runHandler(crashingHandler, payload, undefined, false);
    expect(result).toBeUndefined();
  });

  test('successful handler returns its result unchanged', async () => {
    const okHandler: Handler = {
      version: '1',
      source: 'builtin',
      manifest_path: 'src/hooks/__tests__/dispatch.test.ts',
      name: 'ok-handler',
      event: 'PreToolUse',
      matcher: /^Bash$/,
      priority: 1,
      fn: async () => ({ decision: 'deny' as const, reason: 'nope' }),
    };
    const result = await runHandler(okHandler, payload, undefined, true);
    expect(result).toBeDefined();
    expect(result!.decision).toBe('deny');
    expect(result!.reason).toBe('nope');
  });
});
