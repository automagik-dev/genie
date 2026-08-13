import { describe, expect, test } from 'bun:test';
import { PERMISSION_HOST_TIMEOUT_MS } from '../src/lib/omni-config.js';
import {
  HOOK_BUDGET_MANIFESTS,
  HOOK_CLASS_CEILINGS,
  type HookBudgetEntry,
  collectHookBudgetViolations,
  lintHookBudgetManifests,
  omniLadderViolations,
  parseClaudeStyleManifest,
  parseHookManifest,
  scriptFromCommand,
} from './hook-budgets-lint.ts';

describe('hook timeout budget lint', () => {
  test('class ceilings are the approved budgets', () => {
    expect(HOOK_CLASS_CEILINGS).toEqual({ guard: 30, context: 5, telemetry: 2 });
  });

  test('scriptFromCommand extracts the script basename from every shipped command form', () => {
    expect(scriptFromCommand('node "${PLUGIN_ROOT}/scripts/session-context.cjs"')).toBe('session-context.cjs');
    expect(scriptFromCommand('node "$KIMI_PLUGIN_ROOT/scripts/dispatch-runtime.cjs" claude')).toBe(
      'dispatch-runtime.cjs',
    );
    expect(scriptFromCommand('node ${CLAUDE_PLUGIN_ROOT}/scripts/validate-wish.cjs')).toBe('validate-wish.cjs');
    expect(
      scriptFromCommand(
        'node "${PLUGIN_ROOT}/scripts/dispatch-runtime.cjs" codex PreToolUse --launcher-contract genie-codex-dispatch-v1 --launcher-sha256 48ea38c7d8e715b209553be825cb0b448e35402381c5b717d6466fe12943b214',
      ),
    ).toBe('dispatch-runtime.cjs');
    expect(scriptFromCommand('"$HOME/.genie/bin/genie" hook dispatch')).toBe('');
  });

  test('every shipped manifest entry sits inside its class ceiling', () => {
    expect(lintHookBudgetManifests()).toEqual([]);
  });

  test('shipped manifests carry the lockstep budgets: claude + kimi 5s/30s, codex ladder 125s', () => {
    const entries = HOOK_BUDGET_MANIFESTS.flatMap(parseHookManifest);
    const find = (manifest: string, event: string, script: string) =>
      entries.find((entry) => entry.manifest === manifest && entry.event === event && entry.script === script);
    expect(find('plugins/genie/hooks/hooks.json', 'SessionStart', 'session-context.cjs')?.timeout).toBe(5);
    expect(find('plugins/genie/hooks/hooks.json', 'PreToolUse', 'dispatch-runtime.cjs')?.timeout).toBe(30);
    expect(find('plugins/genie/.kimi-plugin/plugin.json', 'SessionStart', 'session-context.cjs')?.timeout).toBe(5);
    expect(find('plugins/genie/.kimi-plugin/plugin.json', 'PreToolUse', 'dispatch-runtime.cjs')?.timeout).toBe(30);
    expect(find('plugins/genie/hooks/codex-hooks.json', 'PermissionRequest', 'dispatch-runtime.cjs')?.timeout).toBe(
      PERMISSION_HOST_TIMEOUT_MS / 1000,
    );
  });

  test('a pre-fix fixture (10s context, 120s guard) fails exactly twice', () => {
    const raw = JSON.stringify({
      hooks: {
        SessionStart: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'node "${PLUGIN_ROOT}/scripts/session-context.cjs"', timeout: 10 }],
          },
        ],
        PreToolUse: [
          {
            matcher: 'Bash|Read|Write|Edit|NotebookEdit|SendMessage',
            hooks: [
              { type: 'command', command: 'node "${PLUGIN_ROOT}/scripts/dispatch-runtime.cjs" claude', timeout: 120 },
            ],
          },
        ],
      },
    });
    const violations = collectHookBudgetViolations(parseClaudeStyleManifest('fixture-hooks.json', raw));
    expect(violations).toEqual([
      'fixture-hooks.json SessionStart session-context.cjs: timeout 10s exceeds the context class ceiling of 5s',
      'fixture-hooks.json PreToolUse dispatch-runtime.cjs: timeout 120s exceeds the guard class ceiling of 30s',
    ]);
  });

  test('a guard entry at exactly 30s passes (the ceiling is inclusive)', () => {
    const entry: HookBudgetEntry = {
      manifest: 'fixture.json',
      event: 'PreToolUse',
      script: 'dispatch-runtime.cjs',
      timeout: 30,
    };
    expect(collectHookBudgetViolations([entry])).toEqual([]);
  });

  test('an unlisted script name fails instead of defaulting to a permissive class', () => {
    const entry: HookBudgetEntry = {
      manifest: 'fixture.json',
      event: 'SessionStart',
      script: 'future-hook.cjs',
      timeout: 1,
    };
    const violations = collectHookBudgetViolations([entry]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('unlisted script name');
    expect(violations[0]).toContain('HOOK_SCRIPT_CLASSES');
  });

  test('a command that names no script and a missing timeout both fail closed', () => {
    const noScript: HookBudgetEntry = { manifest: 'fixture.json', event: 'PreToolUse', script: '', timeout: 5 };
    const noTimeout: HookBudgetEntry = {
      manifest: 'fixture.json',
      event: 'PreToolUse',
      script: 'session-context.cjs',
      timeout: null,
    };
    const violations = collectHookBudgetViolations([noScript, noTimeout]);
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain('names no hook script');
    expect(violations[1]).toContain('missing or non-finite timeout');
  });

  test('the Omni ladder exception is event-scoped and pinned to the ladder constants', () => {
    const ladder: HookBudgetEntry = {
      manifest: 'plugins/genie/hooks/codex-hooks.json',
      event: 'PermissionRequest',
      script: 'dispatch-runtime.cjs',
      timeout: PERMISSION_HOST_TIMEOUT_MS / 1000,
    };
    expect(collectHookBudgetViolations([ladder])).toEqual([]);
    expect(omniLadderViolations(ladder)).toEqual([]);

    const drifted = omniLadderViolations({ ...ladder, timeout: PERMISSION_HOST_TIMEOUT_MS / 1000 - 1 });
    expect(drifted.some((violation) => violation.includes('pinned to the host rung'))).toBe(true);

    // The exception is event-scoped: the same script on any other
    // manifest/event stays a guard-class hook with the 30s ceiling.
    const guardLeak: HookBudgetEntry = { ...ladder, event: 'PreToolUse', timeout: 31 };
    const leaked = collectHookBudgetViolations([guardLeak]);
    expect(leaked).toEqual([
      'plugins/genie/hooks/codex-hooks.json PreToolUse dispatch-runtime.cjs: timeout 31s exceeds the guard class ceiling of 30s',
    ]);
  });
});
