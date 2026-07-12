import { describe, expect, test } from 'bun:test';
import { adaptCodexPreToolUseOutput, codexPermissionDecision, normalizeCodexHookPayload } from './codex-adapter.js';

describe('Codex hook adapter', () => {
  test('converts unsupported PreToolUse ask to an explicit deny', () => {
    const ask = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: 'remote approval timed out',
      },
    });
    const parsed = JSON.parse(adaptCodexPreToolUseOutput(ask));
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe('remote approval timed out');
  });

  test('normalizes canonical apply_patch commands to semantic file paths', () => {
    const payload = normalizeCodexHookPayload({
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: {
        command: [
          '*** Begin Patch',
          '*** Update File: src/a.ts',
          '*** Move to: src/b.ts',
          '*** Add File: src/c.ts',
          '*** End Patch',
        ].join('\n'),
      },
    });
    expect(payload.genie_hook_runtime).toBe('codex');
    expect(payload.tool_input?.file_path).toBe('src/a.ts');
    expect(payload.tool_input?.file_paths).toEqual(['src/a.ts', 'src/c.ts', 'src/b.ts']);
    expect(payload.tool_input?.file_paths_truncated).toBeUndefined();
  });

  test('caps attacker-sized apply_patch path expansion at downstream need and marks truncation', () => {
    const command = [
      '*** Begin Patch',
      ...Array.from({ length: 50_000 }, (_, index) => `*** Update File: src/file-${index}.ts`),
      '*** End Patch',
    ].join('\n');
    const payload = normalizeCodexHookPayload({
      hook_event_name: 'PermissionRequest',
      tool_name: 'apply_patch',
      tool_input: { command },
    });
    expect(payload.tool_input?.file_paths).toEqual(Array.from({ length: 10 }, (_, index) => `src/file-${index}.ts`));
    expect(payload.tool_input?.file_paths_truncated).toBe(true);
  });

  test('marks non-patch and malformed-patch payloads as Codex without mutating the originals', () => {
    const bash = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' } };
    expect(normalizeCodexHookPayload(bash)).toEqual({ ...bash, genie_hook_runtime: 'codex' });
    expect(bash).not.toHaveProperty('genie_hook_runtime');
    const patch = { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: 'no headers' } };
    expect(normalizeCodexHookPayload(patch)).toEqual({ ...patch, genie_hook_runtime: 'codex' });
    expect(patch).not.toHaveProperty('genie_hook_runtime');
  });

  test('maps allow, deny, and ask to PermissionRequest decisions', () => {
    expect(codexPermissionDecision({ decision: 'allow' })).toContain('"behavior":"allow"');
    expect(codexPermissionDecision({ decision: 'deny', reason: 'nope' })).toContain('"behavior":"deny"');
    const timeout = JSON.parse(codexPermissionDecision({ decision: 'ask', reason: 'timed out' }));
    expect(timeout.hookSpecificOutput.decision).toEqual({ behavior: 'deny', message: 'timed out' });
  });

  test('deny always carries a message so the reason surfaces in Codex', () => {
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

    const bareDeny = JSON.parse(codexPermissionDecision({ decision: 'deny' }));
    expect(bareDeny.hookSpecificOutput.decision.behavior).toBe('deny');
    expect(bareDeny.hookSpecificOutput.decision.message).toContain('could not complete');
  });
});
