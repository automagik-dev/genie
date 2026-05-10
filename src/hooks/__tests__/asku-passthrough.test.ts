/**
 * AskUserQuestion non-interception — Bug 3 (#1710 Group 2).
 *
 * Empirical trace (see .genie/wishes/spawn-compounding-defects/evidence/
 * bug3-mechanism.md) confirmed that the load-bearing field for CC's
 * "headless-handle" interpretation of AskUserQuestion is the presence of a
 * `hookSpecificOutput` envelope in the dispatcher response — specifically,
 * `hookSpecificOutput.additionalContext` propagates through the
 * `executeBlockingChain` and reaches CC, which then suppresses the inline
 * picker UI.
 *
 * Per-handler `permissionDecision: 'allow'` is NOT load-bearing — the
 * dispatcher's `executeBlockingChain` (src/hooks/index.ts) drops it before
 * building the response. So the test below asserts the CORRECT load-bearing
 * absence: for any AskUserQuestion PreToolUse payload, regardless of what
 * each handler tries to return, the dispatcher's final response must NOT
 * carry a `hookSpecificOutput` envelope.
 *
 * This guards against ANY current or future handler emitting
 * additionalContext / updatedInput / permissionDecision for AskUserQuestion
 * — including external handlers loaded by the boot-scan loader.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { dispatch, getRegistry, setRegistry } from '../index.js';
import type { Handler } from '../types.js';

const ASK_USER_QUESTION_PAYLOAD = {
  hook_event_name: 'PreToolUse',
  tool_name: 'AskUserQuestion',
  tool_input: {
    questions: [
      {
        question: 'Which library should we use for date formatting?',
        header: 'Library',
        options: [
          { label: 'date-fns', description: 'Modular' },
          { label: 'dayjs', description: 'Tiny' },
        ],
        multiSelect: false,
      },
    ],
  },
  session_id: 'asku-test-session',
  cwd: '/tmp/asku-test',
};

const FAKE_HANDLER_BASE = {
  version: '1' as const,
  source: 'builtin' as const,
  manifest_path: 'asku-passthrough.test.ts',
  event: 'PreToolUse' as const,
  matcher: /.*/,
  priority: 5,
};

describe('AskUserQuestion non-interception (Bug 3 #1710 Group 2)', () => {
  let originalRegistry: ReadonlyArray<Handler>;

  beforeEach(() => {
    originalRegistry = getRegistry();
  });

  afterEach(() => {
    setRegistry(originalRegistry);
  });

  /**
   * The load-bearing assertion: any AskUserQuestion PreToolUse response from
   * the dispatcher must NOT carry a `hookSpecificOutput` envelope.
   *
   * Two acceptable shapes:
   *   - Empty string `""` (dispatcher emits nothing → CC reads no output → falls
   *     back to default permissions handling → AskUserQuestion in
   *     `permissions.allow` per #1688 → inline picker renders).
   *   - JSON object with NO `hookSpecificOutput` key (e.g. `{}`, or
   *     `{ updatedInput: ... }` without the envelope).
   */
  function assertNoHeadlessHandle(response: string): void {
    if (response === '') return;
    const parsed = JSON.parse(response) as Record<string, unknown>;
    expect(parsed.hookSpecificOutput).toBeUndefined();
  }

  test('default builtin chain returns no hookSpecificOutput for AskUserQuestion', async () => {
    const out = await dispatch(JSON.stringify(ASK_USER_QUESTION_PAYLOAD));
    assertNoHeadlessHandle(out);
  });

  test('handler returning permissionDecision: "allow" alone — does not surface hookSpecificOutput', async () => {
    setRegistry([
      {
        ...FAKE_HANDLER_BASE,
        name: 'fake-allow-only',
        fn: async () => ({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
          },
        }),
      } as Handler,
    ]);
    const out = await dispatch(JSON.stringify(ASK_USER_QUESTION_PAYLOAD));
    assertNoHeadlessHandle(out);
  });

  test('handler returning additionalContext — does not surface hookSpecificOutput for AskUserQuestion', async () => {
    setRegistry([
      {
        ...FAKE_HANDLER_BASE,
        name: 'fake-context-emitter',
        fn: async () => ({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            additionalContext: '[fake-handler] context that must not leak through',
          },
        }),
      } as Handler,
    ]);
    const out = await dispatch(JSON.stringify(ASK_USER_QUESTION_PAYLOAD));
    assertNoHeadlessHandle(out);
    // Specifically: CC must not see the additionalContext text.
    expect(out).not.toContain('fake-handler');
    expect(out).not.toContain('additionalContext');
  });

  test('handler returning updatedInput — does not surface hookSpecificOutput for AskUserQuestion', async () => {
    setRegistry([
      {
        ...FAKE_HANDLER_BASE,
        name: 'fake-input-mutator',
        fn: async () => ({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            updatedInput: { extra: 'mutation-attempt' },
          },
        }),
      } as Handler,
    ]);
    const out = await dispatch(JSON.stringify(ASK_USER_QUESTION_PAYLOAD));
    assertNoHeadlessHandle(out);
    expect(out).not.toContain('mutation-attempt');
  });

  test('multiple handlers all attempting to inject — no hookSpecificOutput surfaces', async () => {
    setRegistry([
      {
        ...FAKE_HANDLER_BASE,
        name: 'h1',
        priority: 1,
        fn: async () => ({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: '[h1] context',
          },
        }),
      } as Handler,
      {
        ...FAKE_HANDLER_BASE,
        name: 'h2',
        priority: 2,
        fn: async () => ({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            updatedInput: { tampered: true },
          },
        }),
      } as Handler,
    ]);
    const out = await dispatch(JSON.stringify(ASK_USER_QUESTION_PAYLOAD));
    assertNoHeadlessHandle(out);
    expect(out).not.toContain('[h1]');
    expect(out).not.toContain('tampered');
  });

  test('regression — Bash + additionalContext STILL propagates (only AskUserQuestion is suppressed)', async () => {
    setRegistry([
      {
        ...FAKE_HANDLER_BASE,
        name: 'fake-bash-context',
        fn: async () => ({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: '[fake-handler] bash context',
          },
        }),
      } as Handler,
    ]);
    const bashPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
      session_id: 'bash-test',
      cwd: '/tmp',
    };
    const out = await dispatch(JSON.stringify(bashPayload));
    expect(out).toContain('hookSpecificOutput');
    expect(out).toContain('additionalContext');
    expect(out).toContain('[fake-handler] bash context');
  });

  test('decision: "deny" still short-circuits AskUserQuestion (deny outranks passthrough)', async () => {
    setRegistry([
      {
        ...FAKE_HANDLER_BASE,
        name: 'fake-denier',
        fn: async () => ({
          decision: 'deny' as const,
          reason: 'test denial',
        }),
      } as Handler,
    ]);
    const out = await dispatch(JSON.stringify(ASK_USER_QUESTION_PAYLOAD));
    // Deny path emits a hookSpecificOutput with permissionDecision: 'deny'.
    // The non-interception rule does NOT mask explicit denials — security
    // handlers that reject AskUserQuestion (e.g. on a sensitive question
    // template) MUST still be able to block the call.
    expect(out).toContain('"permissionDecision":"deny"');
    expect(out).toContain('test denial');
  });
});
