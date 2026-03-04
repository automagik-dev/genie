/**
 * Tests for TUI command: buildClaudeCommand and getAgentsSystemPrompt
 * Run with: bun test src/genie-commands/__tests__/tui.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildClaudeCommand, getAgentsSystemPrompt } from '../tui.js';

// ============================================================================
// buildClaudeCommand tests
// ============================================================================

describe('buildClaudeCommand', () => {
  test('without system prompt should NOT contain --system-prompt', () => {
    const cmd = buildClaudeCommand('genie');
    expect(cmd).not.toContain('--system-prompt');
  });

  test('with system prompt should contain --system-prompt with quoted content', () => {
    const cmd = buildClaudeCommand('genie', 'test prompt');
    expect(cmd).toContain("--system-prompt 'test prompt'");
  });

  test('preserves --agent-id flag', () => {
    const cmd = buildClaudeCommand('genie');
    expect(cmd).toContain('--agent-id');
  });

  test('preserves --agent-name flag', () => {
    const cmd = buildClaudeCommand('genie');
    expect(cmd).toContain('--agent-name');
  });

  test('preserves --team-name flag', () => {
    const cmd = buildClaudeCommand('genie');
    expect(cmd).toContain('--team-name');
  });

  test('preserves --dangerously-skip-permissions flag', () => {
    const cmd = buildClaudeCommand('genie');
    expect(cmd).toContain('--dangerously-skip-permissions');
  });

  test('does not include -c flag (fresh session)', () => {
    const cmd = buildClaudeCommand('genie');
    expect(cmd).not.toContain(' -c');
  });

  test('with system prompt still preserves all existing flags', () => {
    const cmd = buildClaudeCommand('genie', 'some prompt');
    expect(cmd).toContain('--agent-id');
    expect(cmd).toContain('--agent-name');
    expect(cmd).toContain('--team-name');
    expect(cmd).toContain('--dangerously-skip-permissions');
    expect(cmd).not.toContain(' -c');
  });

  test('system prompt with newlines does not break command', () => {
    const cmd = buildClaudeCommand('genie', 'line one\nline two\nline three');
    expect(cmd).not.toContain('\n');
    expect(cmd).toContain('--system-prompt');
    expect(cmd).toContain('line one line two line three');
  });

  test('system prompt with single quotes is properly escaped', () => {
    const cmd = buildClaudeCommand('genie', "it's a test");
    expect(cmd).toContain('--system-prompt');
    // shellQuote wraps in single quotes, escaping inner single quotes
    expect(cmd).toContain("'it'\\''s a test'");
  });
});

// ============================================================================
// getAgentsSystemPrompt tests
// ============================================================================

describe('getAgentsSystemPrompt', () => {
  const TEST_DIR = '/tmp/tui-test-agents-md';
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('returns null when no AGENTS.md in cwd', () => {
    process.chdir(TEST_DIR);
    const result = getAgentsSystemPrompt();
    expect(result).toBeNull();
  });

  test('returns file contents when AGENTS.md exists in cwd', () => {
    const content = '# Agent Instructions\n\nDo the thing.';
    writeFileSync(join(TEST_DIR, 'AGENTS.md'), content);
    process.chdir(TEST_DIR);
    const result = getAgentsSystemPrompt();
    expect(result).toBe(content);
  });
});
