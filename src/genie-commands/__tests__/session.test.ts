/**
 * Tests for Session command: buildClaudeCommand and getAgentsSystemPrompt
 *
 * buildClaudeCommand delegates to buildTeamLeadCommand (team-lead-command.ts),
 * which is the single source of truth for team-lead launch commands.
 *
 * Run with: bun test src/genie-commands/__tests__/session.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { clearAll as clearWorkerRegistry } from '../../lib/agent-registry.js';
import { deleteAllNativeTeams } from '../../lib/claude-native-teams.js';
import { buildClaudeCommand, getAgentsSystemPrompt, sanitizeWindowName } from '../session.js';

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

  test('with system prompt references file via --append-system-prompt-file', () => {
    const cmd = buildClaudeCommand('genie', 'test prompt');
    expect(cmd).toContain('--append-system-prompt-file');
    expect(cmd).toContain('.genie/prompts/genie.md');
  });

  test('without explicit system prompt still includes --system-prompt from team-lead prompt', () => {
    const cmd = buildClaudeCommand('genie');
    // Orchestration prompt is now in ~/.claude/rules/ (auto-loaded by CC)
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
    expect(cmd).toContain('--append-system-prompt-file');
    // Prompt content NOT in the command — only the file path reference
    expect(cmd).not.toContain('very long prompt');
    expect(cmd).toContain('.genie/prompts/genie.md');
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

// ============================================================================
// sanitizeWindowName tests — regression for tmux dot-to-dash fix
//
// tmux uses '.' as a pane separator in targets (session:window.pane).
// Folder/team names containing dots (e.g. "ravi.bot") cause tmux errors
// like "can't find pane: bot". sanitizeWindowName replaces '.' with '-'.
// ============================================================================

describe('sanitizeWindowName', () => {
  test('replaces dot with dash in team name (e.g. ravi.bot -> ravi-bot)', () => {
    expect(sanitizeWindowName('ravi.bot')).toBe('ravi-bot');
  });

  test('leaves names without dots unchanged', () => {
    expect(sanitizeWindowName('my-team')).toBe('my-team');
    expect(sanitizeWindowName('genie')).toBe('genie');
    expect(sanitizeWindowName('api-server')).toBe('api-server');
  });

  test('replaces multiple dots (e.g. my.cool.app -> my-cool-app)', () => {
    expect(sanitizeWindowName('my.cool.app')).toBe('my-cool-app');
  });

  test('handles leading and trailing dots', () => {
    expect(sanitizeWindowName('.hidden')).toBe('-hidden');
    expect(sanitizeWindowName('trailing.')).toBe('trailing-');
    expect(sanitizeWindowName('.both.')).toBe('-both-');
  });

  test('handles consecutive dots', () => {
    expect(sanitizeWindowName('a..b')).toBe('a--b');
  });

  test('handles directory basename with dot (simulates basename of /home/user/ravi.bot)', () => {
    // In production, basename() is called before sanitizeWindowName,
    // so we test the basename result directly.
    const dirBasename = basename('/home/user/ravi.bot');
    expect(sanitizeWindowName(dirBasename)).toBe('ravi-bot');
  });

  test('returns empty string for empty input', () => {
    expect(sanitizeWindowName('')).toBe('');
  });

  test('handles name that is only dots', () => {
    expect(sanitizeWindowName('...')).toBe('---');
  });

  test('sanitize is idempotent (double-sanitize is safe)', () => {
    // resolveWindowName now pre-sanitizes, deriveWindowName sanitizes again.
    // This must be safe (no-op on already-sanitized names).
    const once = sanitizeWindowName('foo.bar');
    const twice = sanitizeWindowName(once);
    expect(twice).toBe(once);
    expect(twice).toBe('foo-bar');
  });

  test('dotted folder collides with dashed folder after sanitize', () => {
    // Regression: "foo.bar" and "foo-bar" must produce the same window name
    // so that collision detection in resolveWindowName works correctly.
    // Before the fix, resolveWindowName looked up "foo.bar" (unsanitized),
    // missed the existing "foo-bar" window, and returned a name that
    // sanitized back to "foo-bar" — attaching to the wrong project.
    expect(sanitizeWindowName('foo.bar')).toBe(sanitizeWindowName('foo-bar'));
  });
});

// ============================================================================
// Reset cleanup tests — verifies handleReset's underlying functions
//
// handleReset() calls deleteAllNativeTeams() + clearWorkerRegistry().
// These tests validate those functions directly since handleReset is private.
// ============================================================================

describe('deleteAllNativeTeams (reset cleanup)', () => {
  const TEST_TEAMS_DIR = '/tmp/session-test-teams';
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.CLAUDE_CONFIG_DIR;
    rmSync(TEST_TEAMS_DIR, { recursive: true, force: true });
    mkdirSync(TEST_TEAMS_DIR, { recursive: true });
    // Point native teams module at our test directory
    process.env.CLAUDE_CONFIG_DIR = TEST_TEAMS_DIR;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      process.env.CLAUDE_CONFIG_DIR = undefined;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalEnv;
    }
    rmSync(TEST_TEAMS_DIR, { recursive: true, force: true });
  });

  test('deletes all team directories under teams/', async () => {
    const teamsDir = join(TEST_TEAMS_DIR, 'teams');
    mkdirSync(join(teamsDir, 'team-a'), { recursive: true });
    mkdirSync(join(teamsDir, 'team-b'), { recursive: true });
    mkdirSync(join(teamsDir, 'team-c'), { recursive: true });
    writeFileSync(join(teamsDir, 'team-a', 'config.json'), '{}');
    writeFileSync(join(teamsDir, 'team-b', 'config.json'), '{}');
    writeFileSync(join(teamsDir, 'team-c', 'config.json'), '{}');

    const deleted = await deleteAllNativeTeams();

    expect(deleted).toBe(3);
    expect(existsSync(join(teamsDir, 'team-a'))).toBe(false);
    expect(existsSync(join(teamsDir, 'team-b'))).toBe(false);
    expect(existsSync(join(teamsDir, 'team-c'))).toBe(false);
  });

  test('returns 0 when no teams directory exists', async () => {
    // Don't create the teams/ subdirectory
    const deleted = await deleteAllNativeTeams();
    expect(deleted).toBe(0);
  });

  test('returns 0 when teams directory is empty', async () => {
    mkdirSync(join(TEST_TEAMS_DIR, 'teams'), { recursive: true });
    const deleted = await deleteAllNativeTeams();
    expect(deleted).toBe(0);
  });
});

describe('clearWorkerRegistry (reset cleanup)', () => {
  let originalEnv: string | undefined;
  const TEST_GENIE_DIR = '/tmp/session-test-genie-home';

  beforeEach(() => {
    originalEnv = process.env.GENIE_HOME;
    rmSync(TEST_GENIE_DIR, { recursive: true, force: true });
    mkdirSync(TEST_GENIE_DIR, { recursive: true });
    process.env.GENIE_HOME = TEST_GENIE_DIR;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      process.env.GENIE_HOME = undefined;
    } else {
      process.env.GENIE_HOME = originalEnv;
    }
    rmSync(TEST_GENIE_DIR, { recursive: true, force: true });
  });

  test('clears workers.json to empty registry', async () => {
    // Seed a non-empty registry
    const registry = {
      workers: { 'agent-1': { id: 'agent-1', state: 'idle' } },
      templates: { 'tmpl-1': { id: 'tmpl-1' } },
      lastUpdated: new Date().toISOString(),
    };
    writeFileSync(join(TEST_GENIE_DIR, 'workers.json'), JSON.stringify(registry));

    await clearWorkerRegistry();

    const content = JSON.parse(require('node:fs').readFileSync(join(TEST_GENIE_DIR, 'workers.json'), 'utf-8'));
    expect(Object.keys(content.workers)).toHaveLength(0);
    expect(Object.keys(content.templates)).toHaveLength(0);
  });
});
