/**
 * Dispatcher allow/ask/deny mechanism + config-gated omni-approval registry.
 *
 * Group 3 of the omni-runner-port wish adds two things to the dispatcher:
 *   1. A handler can now emit a terminal `allow` or `ask` PreToolUse decision
 *      (deny already worked). `allow` propagates to CC; `ask` short-circuits the
 *      chain (the remote-approval fail-safe).
 *   2. The `omni-approval` handler is registered ONLY when the feature is on
 *      (`buildOmniRegistry(true)`); off by default, the dispatcher output is
 *      byte-identical to a build with no Omni.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { orchestrationGuard } from '../handlers/orchestration-guard.js';
import { buildOmniRegistry, dispatch, getRegistry, installDispatchRegistry, setRegistry } from '../index.js';
import type { Handler, HandlerResult } from '../types.js';

function restoreEnv(key: string, prev: string | undefined): void {
  if (prev === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = prev;
}

const BASE = {
  version: '1' as const,
  source: 'builtin' as const,
  manifest_path: 'omni-dispatch.test.ts',
  event: 'PreToolUse' as const,
  matcher: /^Bash$/,
  priority: 5,
};

const BASH_PAYLOAD = {
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'echo hi' },
  session_id: 's',
  cwd: '/tmp/x',
};

function handler(name: string, priority: number, fn: () => Promise<HandlerResult>): Handler {
  return { ...BASE, name, priority, fn } as Handler;
}

describe('config-gated omni-approval registry', () => {
  test('buildOmniRegistry(false) is the builtin set only — no omni-approval', () => {
    const reg = buildOmniRegistry(false);
    expect(reg.some((h) => h.name === 'omni-approval')).toBe(false);
  });

  test('buildOmniRegistry(true) appends the omni-approval handler', () => {
    const reg = buildOmniRegistry(true);
    const omni = reg.find((h) => h.name === 'omni-approval');
    expect(omni).toBeDefined();
    expect(omni?.event).toBe('PreToolUse');
    expect(omni?.priority).toBe(5);
    // Enabled registry = builtin + exactly one extra.
    expect(reg.length).toBe(buildOmniRegistry(false).length + 1);
  });

  test('custom tool matcher is honored', () => {
    const reg = buildOmniRegistry(true, /^WebFetch$/);
    const omni = reg.find((h) => h.name === 'omni-approval');
    expect(omni?.matcher?.test('WebFetch')).toBe(true);
    expect(omni?.matcher?.test('Bash')).toBe(false);
  });
});

describe('installDispatchRegistry — config-gated boot seam', () => {
  let original: ReadonlyArray<Handler>;
  let prev: Record<string, string | undefined>;
  let isolatedHome: string;
  beforeEach(() => {
    original = getRegistry();
    prev = {
      enabled: process.env.OMNI_APPROVALS_ENABLED,
      instance: process.env.OMNI_INSTANCE,
      chat: process.env.OMNI_APPROVAL_CHAT,
      home: process.env.GENIE_HOME,
    };
    // Isolate global state: "default config" must not mean the host's real
    // ~/.genie/config.json, which may have omni approvals enabled.
    isolatedHome = mkdtempSync(join(tmpdir(), 'genie-omni-dispatch-'));
    process.env.GENIE_HOME = isolatedHome;
  });
  afterEach(() => {
    setRegistry(original);
    restoreEnv('OMNI_APPROVALS_ENABLED', prev.enabled);
    restoreEnv('OMNI_INSTANCE', prev.instance);
    restoreEnv('OMNI_APPROVAL_CHAT', prev.chat);
    restoreEnv('GENIE_HOME', prev.home);
    rmSync(isolatedHome, { recursive: true, force: true });
  });

  test('disabled (no env, default config) → registry has NO omni-approval handler', async () => {
    restoreEnv('OMNI_APPROVALS_ENABLED', undefined);
    restoreEnv('OMNI_INSTANCE', undefined);
    restoreEnv('OMNI_APPROVAL_CHAT', undefined);
    await installDispatchRegistry();
    expect(getRegistry().some((h) => h.name === 'omni-approval')).toBe(false);
  });

  test('enabled via env → registry gains the omni-approval handler', async () => {
    process.env.OMNI_APPROVALS_ENABLED = '1';
    process.env.OMNI_INSTANCE = 'inst';
    process.env.OMNI_APPROVAL_CHAT = 'chat';
    await installDispatchRegistry();
    expect(getRegistry().some((h) => h.name === 'omni-approval')).toBe(true);
  });
});

describe('dispatcher allow / ask / deny propagation', () => {
  let original: ReadonlyArray<Handler>;
  beforeEach(() => {
    original = getRegistry();
  });
  afterEach(() => {
    setRegistry(original);
  });

  test('handler-driven allow surfaces permissionDecision:"allow" to CC', async () => {
    setRegistry([
      handler('allower', 5, async () => ({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: 'approved remotely',
        },
      })),
    ]);
    const out = await dispatch(JSON.stringify(BASH_PAYLOAD));
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe('approved remotely');
  });

  test('handler-driven ask short-circuits the chain and emits permissionDecision:"ask"', async () => {
    let laterRan = false;
    setRegistry([
      handler('asker', 5, async () => ({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: 'timed out',
        },
      })),
      handler('later', 6, async () => {
        laterRan = true;
        return undefined;
      }),
    ]);
    const out = await dispatch(JSON.stringify(BASH_PAYLOAD));
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('ask');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe('timed out');
    expect(laterRan).toBe(false); // ask short-circuits
  });

  test('deny via hookSpecificOutput.permissionDecision (not just top-level decision) short-circuits', async () => {
    setRegistry([
      handler('denier', 5, async () => ({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'nope',
        },
      })),
    ]);
    const out = await dispatch(JSON.stringify(BASH_PAYLOAD));
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe('nope');
  });

  test('allow does NOT short-circuit — a later deny still wins', async () => {
    setRegistry([
      handler('allower', 5, async () => ({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
      })),
      handler('denier', 6, async () => ({ decision: 'deny', reason: 'later veto' })),
    ]);
    const out = await dispatch(JSON.stringify(BASH_PAYLOAD));
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe('later veto');
  });

  test('an intentional bare allow and a later context-carrying allow compose — the allow surfaces AND the context is injected', async () => {
    // The intentional standalone allow (omni-approval's shape) records the
    // permission decision; a later context handler adds its note without needing
    // its own incidental allow to be recorded. Both fields land in one envelope.
    setRegistry([
      handler('omni-like', 5, async () => ({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: 'approved remotely',
        },
      })),
      handler('ctx-allow', 8, async () => ({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          additionalContext: '[audit-context] recent history',
        },
      })),
    ]);
    const out = await dispatch(JSON.stringify(BASH_PAYLOAD));
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe('approved remotely');
    expect(parsed.hookSpecificOutput.additionalContext).toBe('[audit-context] recent history');
  });
});

describe('byte-identical dispatcher output when omni disabled', () => {
  let original: ReadonlyArray<Handler>;
  beforeEach(() => {
    original = getRegistry();
  });
  afterEach(() => {
    setRegistry(original);
  });

  test('no handler emitting allow/ask → context-only output is unchanged (no permissionDecision leaks)', async () => {
    // A context-only handler must still produce the pre-Group-3 envelope shape:
    // additionalContext WITHOUT any permissionDecision field.
    setRegistry([
      handler('ctx', 5, async () => ({
        hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'note' },
      })),
    ]);
    const out = await dispatch(JSON.stringify(BASH_PAYLOAD));
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.additionalContext).toBe('note');
    expect(parsed.hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  test('context handler carrying BOTH additionalContext AND permissionDecision:"allow" (the real builtin shape) does NOT leak permissionDecision', async () => {
    // Faithful stand-in for orchestration-guard / audit-context / freshness:
    // they attach a default `permissionDecision: 'allow'` next to their
    // `additionalContext`. Pre-Group-3 the dispatcher dropped that allow and
    // surfaced only the context. The strawman above (context-only, no allow)
    // MISSED this because it never carried the incidental allow. This is the
    // regression the MEDIUM was about: the incidental allow must stay dropped.
    setRegistry([
      handler('ctx-allow', 5, async () => ({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          additionalContext: 'note',
        },
      })),
    ]);
    const out = await dispatch(JSON.stringify(BASH_PAYLOAD));
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.additionalContext).toBe('note');
    expect(parsed.hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  test('the REAL orchestration-guard (allow + tmux nudge) surfaces context but NOT permissionDecision', async () => {
    // Exercise the actual builtin handler, not a fabricated shape: on a tmux
    // capture-pane command it returns permissionDecision:'allow' + a nudge.
    // The disabled-omni dispatcher must surface the nudge with NO
    // permissionDecision — otherwise it silently auto-allows the matched Bash.
    setRegistry([{ ...BASE, name: 'orchestration-guard', priority: 2, fn: orchestrationGuard } as Handler]);
    const out = await dispatch(
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'tmux capture-pane -p' },
        cwd: '/tmp/x',
      }),
    );
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.additionalContext).toContain('[orchestration-guard]');
    expect(parsed.hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  test('empty chain on the builtin (disabled) registry returns empty string for a passing Bash call', async () => {
    // With no omni handler and a benign command, the builtin chain allows
    // implicitly → empty output, exactly as before Group 3.
    setRegistry(buildOmniRegistry(false));
    const out = await dispatch(
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' } }),
    );
    expect(out).toBe('');
  });
});
