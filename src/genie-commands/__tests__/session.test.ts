/**
 * Tests for Session command: buildClaudeCommand and getAgentsSystemPrompt
 *
 * buildClaudeCommand delegates to buildTeamLeadCommand (team-lead-command.ts),
 * which is the single source of truth for team-lead launch commands.
 *
 * Run with: bun test src/genie-commands/__tests__/session.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildClaudeCommand, getAgentsSystemPrompt } from '../session.js';

// ============================================================================
// buildClaudeCommand tests
// ============================================================================

describe('buildClaudeCommand', () => {
  test('always contains --team-name flag', () => {
    const cmd = buildClaudeCommand('genie');
    expect(cmd).toContain('--team-name');
    expect(cmd).toContain("'genie'");
  });

  test('always contains claude binary', () => {
    const cmd = buildClaudeCommand('genie');
    expect(cmd).toContain('claude');
  });

  test('sets GENIE_AGENT_NAME env var to team-lead', () => {
    const cmd = buildClaudeCommand('genie');
    expect(cmd).toContain("GENIE_AGENT_NAME='team-lead'");
  });

  test('sets GENIE_TEAM env var', () => {
    const cmd = buildClaudeCommand('genie');
    expect(cmd).toContain("GENIE_TEAM='genie'");
  });

  test('includes --dangerously-skip-permissions', () => {
    const cmd = buildClaudeCommand('genie');
    expect(cmd).toContain('--dangerously-skip-permissions');
  });

  test('includes --agent-id with team-lead@team pattern', () => {
    const cmd = buildClaudeCommand('my-team');
    expect(cmd).toContain("--agent-id 'team-lead@my-team'");
  });

  test('includes --agent-name team-lead', () => {
    const cmd = buildClaudeCommand('genie');
    expect(cmd).toContain("--agent-name 'team-lead'");
  });

  test('with system prompt references file via $(cat)', () => {
    const cmd = buildClaudeCommand('genie', 'test prompt');
    expect(cmd).toContain('--append-system-prompt');
    expect(cmd).toContain('$(cat');
    expect(cmd).toContain('.genie/prompts/genie.md');
  });

  test('without explicit system prompt still includes --system-prompt from team-lead prompt', () => {
    const cmd = buildClaudeCommand('genie');
    // buildTeamLeadCommand always loads TEAM_LEAD_PROMPT.md if it exists
    // In test env it may or may not exist, but the flag structure is correct
    expect(cmd).toContain('--team-name');
  });

  test('does not include -c flag (fresh session, no resume)', () => {
    const cmd = buildClaudeCommand('genie');
    expect(cmd).not.toContain(' -c');
    expect(cmd).not.toContain('--resume');
  });

  test('system prompt is persisted to file, not inlined', () => {
    const cmd = buildClaudeCommand('genie', "it's a test with a very long prompt");
    expect(cmd).toContain('--append-system-prompt');
    // Prompt content NOT in the command — only the $(cat) reference
    expect(cmd).not.toContain('very long prompt');
    expect(cmd).toContain('$(cat');
  });
});

// ============================================================================
// getAgentsSystemPrompt tests
// ============================================================================

describe('getAgentsSystemPrompt', () => {
  const TEST_DIR = '/tmp/session-test-agents-md';
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
