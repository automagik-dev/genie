import { describe, expect, test } from 'bun:test';
import { computeDispatchOutput, resolveDispatchRuntime } from '../dispatch-command.js';

/**
 * Entry-level fail-closed contract for `genie hook dispatch`.
 *
 * CC reads empty PreToolUse stdout as allow-by-default, so the two error paths
 * that used to crash into empty stdout (unparseable stdin, an unexpected
 * `dispatch()` throw) must instead emit a NON-EMPTY, non-allow envelope. A
 * legitimate empty result from `dispatch()` must still pass through untouched
 * (the AskUserQuestion inline-picker carve-out depends on it).
 */
describe('computeDispatchOutput fail-closed', () => {
  const throwingDispatch = async (): Promise<string> => {
    throw new Error('boom');
  };

  test('unparseable stdin → non-empty, non-allow (neutral block)', async () => {
    const out = await computeDispatchOutput('not json{');
    expect(out).not.toBe('');
    const parsed = JSON.parse(out);
    // Neutral, carve-out-safe form — NOT a hookSpecificOutput envelope, since
    // the tool is unknown and could be the AskUserQuestion carve-out.
    expect(parsed.decision).toBe('block');
    expect(parsed.hookSpecificOutput).toBeUndefined();
  });

  test('dispatch throw on interceptable PreToolUse → non-empty deny', async () => {
    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
    });
    const out = await computeDispatchOutput(payload, throwingDispatch);
    expect(out).not.toBe('');
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
  });

  test('dispatch throw on AskUserQuestion → non-allow but NOT a hookSpecificOutput envelope', async () => {
    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [] },
    });
    const out = await computeDispatchOutput(payload, throwingDispatch);
    expect(out).not.toBe('');
    const parsed = JSON.parse(out);
    // Carve-out tool must never receive a PreToolUse hookSpecificOutput deny —
    // CC would treat it as headless-handle and suppress the inline picker.
    expect(parsed.hookSpecificOutput).toBeUndefined();
    expect(parsed.decision).toBe('block');
  });

  test('valid AskUserQuestion (no matching handler) → empty picker response passes through', async () => {
    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [] },
    });
    // Real dispatcher: no builtin handler matches AskUserQuestion, so dispatch()
    // returns '' and the entry writes nothing — CC renders its inline picker.
    const out = await computeDispatchOutput(payload);
    expect(out).toBe('');
  });

  test('legitimate allow (unmatched event) still passes through as empty', async () => {
    const out = await computeDispatchOutput(JSON.stringify({ hook_event_name: 'PreCompact' }));
    expect(out).toBe('');
  });

  test('structurally invalid Codex PreToolUse fails closed with the event-specific envelope', async () => {
    const out = await computeDispatchOutput(
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }),
      async () => '',
      'codex',
    );
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('tool_input.command');
  });

  test('structurally invalid Codex PermissionRequest fails closed with a deny message', async () => {
    const out = await computeDispatchOutput(
      JSON.stringify({ hook_event_name: 'PermissionRequest', tool_input: { command: 'echo hi' } }),
      async () => '',
      'codex',
    );
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PermissionRequest');
    expect(parsed.hookSpecificOutput.decision.behavior).toBe('deny');
    expect(parsed.hookSpecificOutput.decision.message).toContain('tool_name');
  });

  test('Codex apply_patch reaches the dispatcher with normalized affected paths', async () => {
    let seen: Record<string, unknown> | undefined;
    const out = await computeDispatchOutput(
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'apply_patch',
        tool_input: { command: '*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch' },
      }),
      async (input) => {
        seen = JSON.parse(input) as Record<string, unknown>;
        return '';
      },
      'codex',
    );
    expect(out).toBe('');
    expect((seen?.tool_input as Record<string, unknown>).file_paths).toEqual(['src/a.ts']);
  });

  test('Codex gh pr merge is denied by the local guard without a remote lookup', async () => {
    const out = await computeDispatchOutput(
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'gh pr merge 2545 --repo automagik-dev/genie' },
      }),
      undefined,
      'codex',
    );
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('do not perform network lookups');
  });

  test('a Codex dispatch crash during PermissionRequest returns a documented deny', async () => {
    const out = await computeDispatchOutput(
      JSON.stringify({
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
      }),
      throwingDispatch,
      'codex',
    );
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.decision.behavior).toBe('deny');
    expect(parsed.hookSpecificOutput.decision.message).toContain('dispatch error');
  });
});

/**
 * Runtime selection contract. The shipped portable launcher uses the env
 * (`GENIE_HOOK_RUNTIME=... genie hook dispatch`) so the command line stays
 * parseable by OLD deployed binaries — a `--runtime` flag on the command line
 * would make every pre-flag binary error at parse time and fail-closed deny
 * tools fleet-wide on plugin-first rollouts. The flag remains supported and
 * wins over the env for manual/forward-compat use.
 */
describe('resolveDispatchRuntime', () => {
  test('defaults to claude with no flag, no env — exactly what old binaries did', () => {
    expect(resolveDispatchRuntime(undefined, {})).toBe('claude');
    expect(resolveDispatchRuntime('auto', {})).toBe('claude');
  });

  test('GENIE_HOOK_RUNTIME env selects the runtime (the hooks-file mechanism)', () => {
    expect(resolveDispatchRuntime('auto', { GENIE_HOOK_RUNTIME: 'codex' })).toBe('codex');
    expect(resolveDispatchRuntime(undefined, { GENIE_HOOK_RUNTIME: 'claude', PLUGIN_ROOT: '/p' })).toBe('claude');
  });

  test('explicit --runtime flag wins over the env', () => {
    expect(resolveDispatchRuntime('claude', { GENIE_HOOK_RUNTIME: 'codex' })).toBe('claude');
    expect(resolveDispatchRuntime('codex', { GENIE_HOOK_RUNTIME: 'claude' })).toBe('codex');
  });

  test('auto falls back to PLUGIN_ROOT detection (Codex plugin hosts export it)', () => {
    expect(resolveDispatchRuntime('auto', { PLUGIN_ROOT: '/plugin' })).toBe('codex');
    expect(resolveDispatchRuntime(undefined, { PLUGIN_ROOT: '/plugin' })).toBe('codex');
  });

  test('garbage env value is ignored, not trusted', () => {
    expect(resolveDispatchRuntime('auto', { GENIE_HOOK_RUNTIME: 'weird' })).toBe('claude');
  });
});
