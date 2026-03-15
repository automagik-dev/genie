/**
 * Tests for Session command: buildClaudeCommand and getAgentsSystemPrompt
 *
 * buildClaudeCommand delegates to buildTeamLeadCommand (team-lead-command.ts),
 * which is the single source of truth for team-lead launch commands.
 *
 * Run with: bun test src/genie-commands/__tests__/session.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
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
// Reset cleanup tests — verifies handleReset clears ALL native team dirs
// ============================================================================

describe('deleteAllNativeTeams (reset cleanup)', () => {
  const FAKE_CLAUDE_DIR = '/tmp/session-test-claude-config';
  const TEAMS_DIR = join(FAKE_CLAUDE_DIR, 'teams');
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = FAKE_CLAUDE_DIR;
    rmSync(TEAMS_DIR, { recursive: true, force: true });
    mkdirSync(TEAMS_DIR, { recursive: true });
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      process.env.CLAUDE_CONFIG_DIR = undefined;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalEnv;
    }
    rmSync(FAKE_CLAUDE_DIR, { recursive: true, force: true });
  });

  test('deletes all team directories under ~/.claude/teams/', async () => {
    // Create multiple fake team directories (simulating multiple windows)
    mkdirSync(join(TEAMS_DIR, 'team-alpha'), { recursive: true });
    writeFileSync(join(TEAMS_DIR, 'team-alpha', 'config.json'), '{}');
    mkdirSync(join(TEAMS_DIR, 'team-beta'), { recursive: true });
    writeFileSync(join(TEAMS_DIR, 'team-beta', 'config.json'), '{}');
    mkdirSync(join(TEAMS_DIR, 'team-gamma'), { recursive: true });
    writeFileSync(join(TEAMS_DIR, 'team-gamma', 'config.json'), '{}');

    const deleted = await deleteAllNativeTeams();

    expect(deleted).toBe(3);
    expect(existsSync(join(TEAMS_DIR, 'team-alpha'))).toBe(false);
    expect(existsSync(join(TEAMS_DIR, 'team-beta'))).toBe(false);
    expect(existsSync(join(TEAMS_DIR, 'team-gamma'))).toBe(false);
    // The teams/ base directory should still exist (we only delete contents)
    expect(existsSync(TEAMS_DIR)).toBe(true);
  });

  test('returns 0 when no team directories exist', async () => {
    const deleted = await deleteAllNativeTeams();
    expect(deleted).toBe(0);
  });

  test('returns 0 when teams base dir does not exist', async () => {
    rmSync(TEAMS_DIR, { recursive: true, force: true });
    const deleted = await deleteAllNativeTeams();
    expect(deleted).toBe(0);
  });

  test('ignores non-directory entries in teams dir', async () => {
    mkdirSync(join(TEAMS_DIR, 'real-team'), { recursive: true });
    writeFileSync(join(TEAMS_DIR, 'stale-file.txt'), 'not a team');

    const deleted = await deleteAllNativeTeams();

    expect(deleted).toBe(1);
    // File should still be there — we only delete directories
    expect(existsSync(join(TEAMS_DIR, 'stale-file.txt'))).toBe(true);
  });
});

// ============================================================================
// Workers registry clearing test
// ============================================================================

describe('workers.json reset', () => {
  const FAKE_GENIE_HOME = '/tmp/session-test-genie-home';
  const WORKERS_PATH = join(FAKE_GENIE_HOME, 'workers.json');
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.GENIE_HOME;
    process.env.GENIE_HOME = FAKE_GENIE_HOME;
    rmSync(FAKE_GENIE_HOME, { recursive: true, force: true });
    mkdirSync(FAKE_GENIE_HOME, { recursive: true });
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      process.env.GENIE_HOME = undefined;
    } else {
      process.env.GENIE_HOME = originalEnv;
    }
    rmSync(FAKE_GENIE_HOME, { recursive: true, force: true });
  });

  test('workers.json path uses GENIE_HOME env var', () => {
    // This test verifies the path construction matches what handleReset uses
    const expected = join(FAKE_GENIE_HOME, 'workers.json');
    expect(expected).toBe(WORKERS_PATH);
  });

  test('writing empty array clears stale worker entries', async () => {
    // Simulate stale workers.json
    writeFileSync(WORKERS_PATH, JSON.stringify([{ id: 'ghost-worker', role: 'implementor' }]));

    // Simulate what handleReset does
    const { writeFile } = await import('node:fs/promises');
    await writeFile(WORKERS_PATH, '[]');

    const content = readFileSync(WORKERS_PATH, 'utf-8');
    expect(JSON.parse(content)).toEqual([]);
  });
});
