import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { contractClaudePath, getClaudeSettingsPath, hookScriptExists, removeHookScript } from './claude-settings.js';

describe('getClaudeSettingsPath', () => {
  test('returns path under ~/.claude', () => {
    const path = getClaudeSettingsPath();
    expect(path).toContain('.claude');
    expect(path).toEndWith('settings.json');
  });
});

describe('hookScriptExists', () => {
  test('returns a boolean', () => {
    const result = hookScriptExists();
    expect(typeof result).toBe('boolean');
  });
});

describe('removeHookScript', () => {
  test('does not throw when hook script does not exist', () => {
    // In a clean test env, the hook script likely doesn't exist
    // This just verifies it doesn't crash
    expect(() => removeHookScript()).not.toThrow();
  });
});

describe('contractClaudePath', () => {
  test('contracts home directory to ~', () => {
    const home = homedir();
    expect(contractClaudePath(`${home}/foo/bar`)).toBe('~/foo/bar');
  });

  test('contracts exact home to ~', () => {
    const home = homedir();
    expect(contractClaudePath(home)).toBe('~');
  });

  test('returns non-home paths unchanged', () => {
    expect(contractClaudePath('/tmp/foo')).toBe('/tmp/foo');
  });
});
