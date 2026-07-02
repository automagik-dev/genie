/**
 * Tests for claude-settings: ensureBaselineAllowedTools (#1688 baseline merge).
 *
 * The merge helper binds to the cached `~/.claude/settings.json` path at
 * module load. Pivoting HOME at runtime
 * would clobber other tests that hard-reset HOME in their teardown
 * (team-lead-command.test.ts is one such case), so the merge logic is
 * exposed via `ensureBaselineAllowedTools` and tested directly.
 *
 * Run with: bun test src/lib/claude-settings.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { GENIE_BASELINE_ALLOWED_TOOLS, ensureBaselineAllowedTools } from './claude-settings.js';

describe('ensureBaselineAllowedTools — AskUserQuestion baseline (#1688)', () => {
  test('seeds AskUserQuestion when settings has no permissions block', () => {
    const settings: Record<string, unknown> = {};
    const changed = ensureBaselineAllowedTools(settings);

    expect(changed).toBe(true);
    expect(settings.permissions).toEqual({ allow: ['AskUserQuestion'] });
  });

  test('appends AskUserQuestion to existing allow array', () => {
    const settings: Record<string, unknown> = {
      permissions: { allow: ['Bash(git status)', 'Read'], deny: ['Read(//**/.env)'] },
    };
    const changed = ensureBaselineAllowedTools(settings);

    expect(changed).toBe(true);
    expect(settings.permissions).toEqual({
      allow: ['Bash(git status)', 'Read', 'AskUserQuestion'],
      deny: ['Read(//**/.env)'],
    });
  });

  test('does not duplicate AskUserQuestion when already present', () => {
    const settings: Record<string, unknown> = {
      permissions: { allow: ['AskUserQuestion', 'Read'] },
    };
    const changed = ensureBaselineAllowedTools(settings);

    expect(changed).toBe(false);
    expect((settings.permissions as { allow: string[] }).allow).toEqual(['AskUserQuestion', 'Read']);
  });

  test('preserves unrelated permissions sub-keys (defaultMode, deny)', () => {
    const settings: Record<string, unknown> = {
      cleanupPeriodDays: 99999,
      permissions: { defaultMode: 'auto', deny: ['Read(//**/.git/objects/**)'] },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'genie hook dispatch' }] }] },
    };
    const changed = ensureBaselineAllowedTools(settings);

    expect(changed).toBe(true);
    expect(settings.cleanupPeriodDays).toBe(99999);
    expect(settings.hooks).toBeDefined();
    expect(settings.permissions).toEqual({
      defaultMode: 'auto',
      deny: ['Read(//**/.git/objects/**)'],
      allow: ['AskUserQuestion'],
    });
  });

  test('drops non-string entries from allow list when re-emitting', () => {
    // Defensive: if a malformed allow array somehow reaches us, we filter to
    // strings only before merging baseline. The result is stable + valid.
    const settings: Record<string, unknown> = {
      permissions: { allow: ['Read', 42, null, 'Glob'] as unknown[] },
    };
    const changed = ensureBaselineAllowedTools(settings);

    expect(changed).toBe(true);
    expect((settings.permissions as { allow: string[] }).allow).toEqual(['Read', 'Glob', 'AskUserQuestion']);
  });

  test('idempotent — second call on already-baselined settings is a no-op', () => {
    const settings: Record<string, unknown> = {
      permissions: { allow: ['AskUserQuestion'] },
    };
    expect(ensureBaselineAllowedTools(settings)).toBe(false);
    expect((settings.permissions as { allow: string[] }).allow).toEqual(['AskUserQuestion']);
  });
});

describe('GENIE_BASELINE_ALLOWED_TOOLS — invariants', () => {
  test('AskUserQuestion is in the baseline (#1688 contract)', () => {
    expect(GENIE_BASELINE_ALLOWED_TOOLS).toContain('AskUserQuestion');
  });

  test('baseline is non-empty', () => {
    expect(GENIE_BASELINE_ALLOWED_TOOLS.length).toBeGreaterThan(0);
  });
});
