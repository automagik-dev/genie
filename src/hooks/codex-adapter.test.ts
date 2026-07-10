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

  test('deny carries the documented optional message so denial reasons surface in Codex', () => {
    const denied = JSON.parse(
      codexPermissionDecision({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'denied via omni approval',
        },
      }),
    );
    expect(denied.hookSpecificOutput.decision).toEqual({ behavior: 'deny', message: 'denied via omni approval' });

    // Legacy decision/reason form maps too.
    const legacy = JSON.parse(codexPermissionDecision({ decision: 'deny', reason: 'branch guard' }));
    expect(legacy.hookSpecificOutput.decision).toEqual({ behavior: 'deny', message: 'branch guard' });

    // Allow never grows a message; deny without a reason stays bare.
    const allow = JSON.parse(
      codexPermissionDecision({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: 'auto-approved',
        },
      }),
    );
    expect(allow.hookSpecificOutput.decision).toEqual({ behavior: 'allow' });
    const bareDeny = JSON.parse(
      codexPermissionDecision({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } }),
    );
    expect(bareDeny.hookSpecificOutput.decision).toEqual({ behavior: 'deny' });
  });

  test('timeout ask returns no decision', async () => {
    const output = await dispatchCodexPermissionRequest(
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash' },
      async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } }),
    );
    expect(output).toBe('');
  });
});
