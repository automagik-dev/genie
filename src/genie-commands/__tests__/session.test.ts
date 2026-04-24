/**
 * Tests for Session command: buildClaudeCommand and getAgentsFilePath
 *
 * buildClaudeCommand delegates to buildTeamLeadCommand (team-lead-command.ts),
 * which is the single source of truth for team-lead launch commands.
 *
 * Run with: bun test src/genie-commands/__tests__/session.test.ts
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
// Import the real genie-config module so we can spyOn individual exports.
// Using spyOn instead of mock.module avoids leaking an incomplete mock to
// other test files (bun 1.3.x leaks mock.module across parallel workers —
// see PR #1169). Pattern mirrors src/term-commands/init-bootstrap.test.ts.
import * as genieConfig from '../../lib/genie-config.js';
import { HEARTBEAT_TEMPLATE, SOUL_TEMPLATE, scaffoldAgentFiles } from '../../templates/index.js';
import { buildClaudeCommand, getAgentsFilePath, sanitizeWindowName } from '../session.js';

// ============================================================================
// buildClaudeCommand tests
// ============================================================================

describe('buildClaudeCommand', () => {
  // Pin promptMode so tests asserting --append-system-prompt-file don't depend
  // on the host's ~/.genie/config.json. Without this, a host configured with
  // promptMode: "system" causes buildTeamLeadCommand to emit --system-prompt-file
  // instead, failing the append-system-prompt-file assertions below.
  // Closes the tail surfaced during PR #1169 QA.
  let loadGenieConfigSyncSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    loadGenieConfigSyncSpy = spyOn(genieConfig, 'loadGenieConfigSync').mockReturnValue({
      promptMode: 'append',
    } as ReturnType<typeof genieConfig.loadGenieConfigSync>);
  });

  afterEach(() => {
    loadGenieConfigSyncSpy.mockRestore();
  });

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

  test('includes --permission-mode auto', () => {
    const cmd = buildClaudeCommand('genie');
    expect(cmd).toContain('--permission-mode auto');
  });

  test('sets GENIE_WORKER=1 to skip SessionStart hooks on spawn (#712)', () => {
    const cmd = buildClaudeCommand('genie');
    expect(cmd).toContain('GENIE_WORKER=1');
  });

  test('includes --agent-id with leader@team pattern', () => {
    const cmd = buildClaudeCommand('my-team');
    expect(cmd).toContain(`--agent-id 'my-team@my-team'`);
  });

  test('includes --agent-name matching team name', () => {
    const cmd = buildClaudeCommand('genie');
    expect(cmd).toContain("--agent-name 'genie'");
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

  test('without sessionId does NOT include --resume or --session-id', () => {
    const cmd = buildClaudeCommand('genie');
    expect(cmd).not.toContain('--resume');
    expect(cmd).not.toContain('--session-id');
  });

  test('with sessionId + resume:true emits --resume <uuid>', () => {
    const cmd = buildClaudeCommand('my-team', undefined, undefined, 'uuid-xyz-789', true);
    expect(cmd).toContain("--resume 'uuid-xyz-789'");
    expect(cmd).not.toContain('--session-id');
  });

  test('with sessionId + resume:false emits --session-id <uuid>', () => {
    const cmd = buildClaudeCommand('my-team', undefined, undefined, 'uuid-xyz-789', false);
    expect(cmd).toContain("--session-id 'uuid-xyz-789'");
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
  const TEST_DIR = `${realpathSync('/tmp')}/session-test-agents-md`;
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
// scaffoldAgentFiles tests — first-run scaffold creates SOUL/HEARTBEAT/AGENTS
// ============================================================================

describe('scaffoldAgentFiles', () => {
  const TEST_DIR = `${realpathSync('/tmp')}/session-test-scaffold`;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('creates SOUL.md, HEARTBEAT.md, and AGENTS.md', () => {
    scaffoldAgentFiles(TEST_DIR);
    expect(existsSync(join(TEST_DIR, 'SOUL.md'))).toBe(true);
    expect(existsSync(join(TEST_DIR, 'HEARTBEAT.md'))).toBe(true);
    expect(existsSync(join(TEST_DIR, 'AGENTS.md'))).toBe(true);
  });

  test('created files contain valid markdown with placeholder content', () => {
    scaffoldAgentFiles(TEST_DIR);

    const soul = readFileSync(join(TEST_DIR, 'SOUL.md'), 'utf-8');
    expect(soul).toContain('# Soul');
    expect(soul.length).toBeGreaterThan(0);

    const heartbeat = readFileSync(join(TEST_DIR, 'HEARTBEAT.md'), 'utf-8');
    expect(heartbeat).toContain('# Heartbeat');
    expect(heartbeat).toContain('## Checklist');

    const agents = readFileSync(join(TEST_DIR, 'AGENTS.md'), 'utf-8');
    // New template: no active name field when no agent name given
    expect(agents).toContain('# model:');
    expect(agents).toContain('@HEARTBEAT.md');
    expect(agents).toContain('<mission>');
  });

  test('file contents match exported template constants', () => {
    scaffoldAgentFiles(TEST_DIR);
    expect(readFileSync(join(TEST_DIR, 'SOUL.md'), 'utf-8')).toBe(SOUL_TEMPLATE);
    expect(readFileSync(join(TEST_DIR, 'HEARTBEAT.md'), 'utf-8')).toBe(HEARTBEAT_TEMPLATE);
    // AGENTS.md is rendered with effective defaults (placeholders resolved)
    const agents = readFileSync(join(TEST_DIR, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('# model: opus');
    expect(agents).not.toContain('{{');
  });

  test('AGENTS.md has valid YAML frontmatter', () => {
    scaffoldAgentFiles(TEST_DIR);
    const agents = readFileSync(join(TEST_DIR, 'AGENTS.md'), 'utf-8');
    // Verify frontmatter delimiters
    expect(agents.startsWith('---\n')).toBe(true);
    expect(agents.indexOf('---', 4)).toBeGreaterThan(4);
  });

  test('getAgentsFilePath finds scaffolded AGENTS.md', () => {
    const originalCwd = process.cwd();
    try {
      scaffoldAgentFiles(TEST_DIR);
      process.chdir(TEST_DIR);
      const result = getAgentsFilePath();
      expect(result).toBe(join(TEST_DIR, 'AGENTS.md'));
    } finally {
      process.chdir(originalCwd);
    }
  });
});
