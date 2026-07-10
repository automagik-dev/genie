import { describe, expect, test } from 'bun:test';
import {
  adaptCodexPreToolUseOutput,
  codexPermissionDecision,
  dispatchCodexPermissionRequest,
} from './codex-adapter.js';

describe('Codex hook adapter', () => {
  test('drops unsupported PreToolUse ask so Codex continues to its local prompt', () => {
    const ask = JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' },
    });
    expect(adaptCodexPreToolUseOutput(ask)).toBe('');
  });

  test('maps allow and deny to PermissionRequest decisions', () => {
    expect(
      codexPermissionDecision({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
      }),
    ).toContain('"behavior":"allow"');
    expect(
      codexPermissionDecision({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
      }),
    ).toContain('"behavior":"deny"');
  });

  test('timeout ask returns no decision', async () => {
    const output = await dispatchCodexPermissionRequest(
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash' },
      async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } }),
    );
    expect(output).toBe('');
  });
});
