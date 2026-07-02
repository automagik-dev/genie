import { describe, expect, test } from 'bun:test';
import { computeDispatchOutput } from '../dispatch-command.js';

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
});
