/**
 * Tests for claude-settings: ensureClaudeSettingsSafe baseline-allowlist seeding.
 *
 * Run with: bun test src/lib/claude-settings.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GENIE_BASELINE_ALLOWED_TOOLS, ensureClaudeSettingsSafe } from './claude-settings.js';

let TEST_HOME: string;
let SETTINGS_PATH: string;
let originalHome: string | undefined;

beforeEach(() => {
  TEST_HOME = mkdtempSync(join(tmpdir(), 'genie-claude-settings-'));
  SETTINGS_PATH = join(TEST_HOME, '.claude', 'settings.json');
  originalHome = process.env.HOME;
  process.env.HOME = TEST_HOME;
});

afterEach(() => {
  if (originalHome === undefined) {
    process.env.HOME = '';
  } else {
    process.env.HOME = originalHome;
  }
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function readSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8')) as Record<string, unknown>;
}

describe('ensureClaudeSettingsSafe AskUserQuestion baseline (#1688)', () => {
  test('seeds AskUserQuestion into permissions.allow on a fresh install', () => {
    ensureClaudeSettingsSafe();

    expect(existsSync(SETTINGS_PATH)).toBe(true);
    const settings = readSettings();
    const permissions = settings.permissions as { allow?: string[] };
    expect(permissions.allow).toEqual([...GENIE_BASELINE_ALLOWED_TOOLS]);
    expect(permissions.allow).toContain('AskUserQuestion');
  });

  test('appends AskUserQuestion when allow list exists but is missing it', () => {
    mkdirSync(join(TEST_HOME, '.claude'), { recursive: true });
    writeFileSync(
      SETTINGS_PATH,
      JSON.stringify({
        permissions: { allow: ['Bash(git status)', 'Read'], deny: ['Read(//**/.env)'] },
      }),
    );

    ensureClaudeSettingsSafe();

    const settings = readSettings();
    const permissions = settings.permissions as { allow?: string[]; deny?: string[] };
    expect(permissions.allow).toEqual(['Bash(git status)', 'Read', 'AskUserQuestion']);
    // Existing deny rules must be preserved untouched.
    expect(permissions.deny).toEqual(['Read(//**/.env)']);
  });

  test('does not duplicate AskUserQuestion when already present', () => {
    mkdirSync(join(TEST_HOME, '.claude'), { recursive: true });
    writeFileSync(
      SETTINGS_PATH,
      JSON.stringify({
        permissions: { allow: ['AskUserQuestion', 'Read'] },
      }),
    );

    ensureClaudeSettingsSafe();

    const settings = readSettings();
    const permissions = settings.permissions as { allow?: string[] };
    expect(permissions.allow).toEqual(['AskUserQuestion', 'Read']);
  });

  test('preserves unrelated top-level keys (hooks, defaultMode, plugins)', () => {
    mkdirSync(join(TEST_HOME, '.claude'), { recursive: true });
    writeFileSync(
      SETTINGS_PATH,
      JSON.stringify({
        cleanupPeriodDays: 99999,
        permissions: { defaultMode: 'auto' },
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'genie hook dispatch' }] }] },
        plugins: { something: true },
      }),
    );

    ensureClaudeSettingsSafe();

    const settings = readSettings();
    expect(settings.cleanupPeriodDays).toBe(99999);
    expect(settings.hooks).toBeDefined();
    expect(settings.plugins).toEqual({ something: true });
    const permissions = settings.permissions as { allow?: string[]; defaultMode?: string };
    expect(permissions.defaultMode).toBe('auto');
    expect(permissions.allow).toEqual(['AskUserQuestion']);
  });

  test('is idempotent — second call leaves settings byte-identical', () => {
    ensureClaudeSettingsSafe();
    const first = readFileSync(SETTINGS_PATH, 'utf-8');

    ensureClaudeSettingsSafe();
    const second = readFileSync(SETTINGS_PATH, 'utf-8');

    expect(second).toBe(first);
  });
});
