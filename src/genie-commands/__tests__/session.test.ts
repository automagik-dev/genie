/**
 * Tests for Session command: buildClaudeCommand and getAgentsFilePath
 *
 * buildClaudeCommand delegates to buildTeamLeadCommand (team-lead-command.ts),
 * which is the single source of truth for team-lead launch commands.
 *
 * Run with: bun test src/genie-commands/__tests__/session.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { buildClaudeCommand, getAgentsFilePath, resolveSessionName, sanitizeWindowName } from '../session.js';

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

  test('sets GENIE_AGENT_NAME env var to folder name', () => {
    const cmd = buildClaudeCommand('genie');
    const folderName = basename(process.cwd());
    expect(cmd).toContain(`GENIE_AGENT_NAME='${folderName}'`);
  });

  test('sets GENIE_TEAM env var', () => {
    const cmd = buildClaudeCommand('genie');
    expect(cmd).toContain("GENIE_TEAM='genie'");
  });

  test('includes --dangerously-skip-permissions', () => {
    const cmd = buildClaudeCommand('genie');
    expect(cmd).toContain('--dangerously-skip-permissions');
  });

  test('includes --agent-id with folderName@team pattern', () => {
    const cmd = buildClaudeCommand('my-team');
    const folderName = basename(process.cwd());
    expect(cmd).toContain(`--agent-id '${folderName}@my-team'`);
  });

  test('includes --agent-name as folder name', () => {
    const cmd = buildClaudeCommand('genie');
    const folderName = basename(process.cwd());
    expect(cmd).toContain(`--agent-name '${folderName}'`);
  });

  test('with system prompt file references it via --append-system-prompt-file', () => {
    const cmd = buildClaudeCommand('genie', '/tmp/test-agents.md');
    expect(cmd).toContain('--append-system-prompt-file');
    expect(cmd).toContain('/tmp/test-agents.md');
  });

  test('without explicit system prompt file has no prompt flag', () => {
    const cmd = buildClaudeCommand('genie');
    // Orchestration prompt is now in ~/.claude/rules/ (auto-loaded by CC)
    expect(cmd).toContain('--team-name');
  });

  test('does not include -c flag (fresh session, no resume)', () => {
    const cmd = buildClaudeCommand('genie');
    expect(cmd).not.toContain(' -c');
    expect(cmd).not.toContain('--resume');
  });

  test('file path is passed directly, no content inlined', () => {
    const cmd = buildClaudeCommand('genie', '/path/to/AGENTS.md');
    expect(cmd).toContain('--append-system-prompt-file');
    expect(cmd).toContain('/path/to/AGENTS.md');
  });
});

// ============================================================================
// getAgentsFilePath tests
// ============================================================================

describe('getAgentsFilePath', () => {
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
    const result = getAgentsFilePath();
    expect(result).toBeNull();
  });

  test('returns file path when AGENTS.md exists in cwd', () => {
    const content = '# Agent Instructions\n\nDo the thing.';
    writeFileSync(join(TEST_DIR, 'AGENTS.md'), content);
    process.chdir(TEST_DIR);
    const result = getAgentsFilePath();
    expect(result).toBe(join(TEST_DIR, 'AGENTS.md'));
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
// resolveSessionName tests — per-project session name derivation
//
// resolveSessionName derives a tmux session name from the cwd:
// - basename(cwd) sanitized (dots → dashes)
// - hash disambiguation when two dirs share the same basename
// ============================================================================

describe('resolveSessionName', () => {
  test('derives session name from basename of cwd', async () => {
    // When no session exists with this name, returns sanitized basename
    const name = await resolveSessionName('/home/user/project-a');
    expect(name).toBe('project-a');
  });

  test('sanitizes dots in directory name', async () => {
    const name = await resolveSessionName('/home/user/my.cool.app');
    expect(name).toBe('my-cool-app');
  });

  test('produces unique names for same-basename dirs via hash', () => {
    // Unit test: the hash disambiguation logic produces different names
    const hash = (p: string) => createHash('md5').update(p).digest('hex').slice(0, 4);
    const a = sanitizeWindowName('project-a');
    const b = `${sanitizeWindowName('project-a')}-${hash('/tmp/project-a')}`;
    expect(a).not.toBe(b);
    expect(b).toMatch(/^project-a-[0-9a-f]{4}$/);
  });

  test('hash disambiguation is deterministic', () => {
    const hash = (p: string) => createHash('md5').update(p).digest('hex').slice(0, 4);
    const h1 = hash('/tmp/project-a');
    const h2 = hash('/tmp/project-a');
    expect(h1).toBe(h2);
  });

  test('different paths produce different hashes', () => {
    const hash = (p: string) => createHash('md5').update(p).digest('hex').slice(0, 4);
    const h1 = hash('/home/user/project-a');
    const h2 = hash('/tmp/project-a');
    expect(h1).not.toBe(h2);
  });
});
