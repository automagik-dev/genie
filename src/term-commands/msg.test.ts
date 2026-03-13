/**
 * Messaging Commands — Regression Tests
 *
 * Covers:
 *   - detectSenderIdentity cascade
 *   - checkSendScope team enforcement
 *   - buildTeamLeadCommand shared module
 *   - provider-adapters GENIE_AGENT_NAME
 *
 * Run with: bun test src/term-commands/msg.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSendScope, detectSenderIdentity } from './msg.js';

// ---------------------------------------------------------------------------
// Helpers: save/restore env vars
// ---------------------------------------------------------------------------

const ENV_KEYS = ['GENIE_AGENT_NAME', 'TMUX_PANE', 'CLAUDE_CONFIG_DIR', 'GENIE_HOME', 'GENIE_TEAM'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
  }
  // Isolate from global registry to prevent cross-test contamination
  process.env.GENIE_HOME = `/tmp/msg-test-isolated-${Date.now()}`;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
});

// ---------------------------------------------------------------------------
// detectSenderIdentity tests
// ---------------------------------------------------------------------------

describe('detectSenderIdentity', () => {
  // Scenario 1: Team-lead via Bash tool — GENIE_AGENT_NAME='team-lead'
  test('returns "team-lead" when GENIE_AGENT_NAME is set (team-lead via Bash tool)', async () => {
    process.env.GENIE_AGENT_NAME = 'team-lead';
    process.env.TMUX_PANE = undefined;

    const sender = await detectSenderIdentity('genie');
    expect(sender).toBe('team-lead');
  });

  // Scenario 2: Worker via CLI — GENIE_AGENT_NAME set by provider-adapters
  test('returns worker name when GENIE_AGENT_NAME is set (worker via provider-adapters)', async () => {
    process.env.GENIE_AGENT_NAME = 'implementor';
    process.env.TMUX_PANE = '%5';

    const sender = await detectSenderIdentity('genie');
    expect(sender).toBe('implementor');
  });

  // Scenario 3: External CLI — no env, no tmux → fallback to 'cli'
  test('returns "cli" when no GENIE_AGENT_NAME and no TMUX_PANE', async () => {
    process.env.GENIE_AGENT_NAME = undefined;
    process.env.TMUX_PANE = undefined;

    const sender = await detectSenderIdentity('genie');
    expect(sender).toBe('cli');
  });

  // Scenario 4: GENIE_AGENT_NAME always wins over TMUX_PANE
  test('GENIE_AGENT_NAME takes priority over TMUX_PANE lookup', async () => {
    process.env.GENIE_AGENT_NAME = 'custom-agent';
    process.env.TMUX_PANE = '%99';

    const sender = await detectSenderIdentity('genie');
    expect(sender).toBe('custom-agent');
  });

  // Scenario 5: TMUX_PANE set but no match → falls through to 'cli'
  test('returns "cli" when TMUX_PANE set but no match in registry or config', async () => {
    process.env.GENIE_AGENT_NAME = undefined;
    process.env.TMUX_PANE = '%999';
    process.env.CLAUDE_CONFIG_DIR = `/tmp/genie-test-no-config-${Date.now()}`;

    const sender = await detectSenderIdentity('nonexistent-team');
    expect(sender).toBe('cli');
  });

  // Scenario 6: Works with no teamName (optional parameter)
  test('works without teamName parameter', async () => {
    process.env.GENIE_AGENT_NAME = 'my-agent';

    const sender = await detectSenderIdentity();
    expect(sender).toBe('my-agent');
  });

  // Scenario 7: Falls back to GENIE_TEAM env when no teamName provided
  test('uses GENIE_TEAM env when teamName not provided', async () => {
    process.env.GENIE_AGENT_NAME = undefined;
    process.env.TMUX_PANE = undefined;
    process.env.GENIE_TEAM = 'test-team';

    const sender = await detectSenderIdentity();
    expect(sender).toBe('cli'); // No TMUX_PANE → still falls through to cli
  });
});

// ---------------------------------------------------------------------------
// checkSendScope tests
// ---------------------------------------------------------------------------

describe('checkSendScope', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'scope-test-'));
    // Create .genie/teams directory
    await mkdir(join(tempDir, '.genie', 'teams'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('cli sender has no scope restriction', async () => {
    const error = await checkSendScope(tempDir, 'cli', 'anyone');
    expect(error).toBeNull();
  });

  test('sender not in any team has no scope restriction', async () => {
    const error = await checkSendScope(tempDir, 'free-agent', 'anyone');
    expect(error).toBeNull();
  });

  test('allows sending within same team', async () => {
    // Create team with both sender and recipient as members
    const teamConfig = {
      name: 'test-team',
      repo: tempDir,
      baseBranch: 'dev',
      worktreePath: join(tempDir, '.worktrees', 'test-team'),
      members: ['alice', 'bob'],
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(tempDir, '.genie', 'teams', 'test-team.json'), JSON.stringify(teamConfig));

    const error = await checkSendScope(tempDir, 'alice', 'bob');
    expect(error).toBeNull();
  });

  test('rejects sending to non-team-member', async () => {
    const teamConfig = {
      name: 'test-team',
      repo: tempDir,
      baseBranch: 'dev',
      worktreePath: join(tempDir, '.worktrees', 'test-team'),
      members: ['alice'],
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(tempDir, '.genie', 'teams', 'test-team.json'), JSON.stringify(teamConfig));

    const error = await checkSendScope(tempDir, 'alice', 'outsider');
    expect(error).not.toBeNull();
    expect(error).toContain('Scope violation');
    expect(error).toContain('outsider');
  });

  test('team-lead can always send to team-lead recipient', async () => {
    const teamConfig = {
      name: 'my-team',
      repo: tempDir,
      baseBranch: 'dev',
      worktreePath: join(tempDir, '.worktrees', 'my-team'),
      members: ['implementor'],
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(tempDir, '.genie', 'teams', 'my-team.json'), JSON.stringify(teamConfig));

    // implementor (member) can send to team-lead
    const error = await checkSendScope(tempDir, 'implementor', 'team-lead');
    expect(error).toBeNull();
  });

  test('team-lead uses GENIE_TEAM for team lookup', async () => {
    const teamConfig = {
      name: 'leader-team',
      repo: tempDir,
      baseBranch: 'dev',
      worktreePath: join(tempDir, '.worktrees', 'leader-team'),
      members: ['worker-a', 'worker-b'],
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(tempDir, '.genie', 'teams', 'leader-team.json'), JSON.stringify(teamConfig));

    process.env.GENIE_TEAM = 'leader-team';

    // team-lead can send to team member
    const error = await checkSendScope(tempDir, 'team-lead', 'worker-a');
    expect(error).toBeNull();
  });

  test('team-lead blocked from sending to non-member', async () => {
    const teamConfig = {
      name: 'leader-team',
      repo: tempDir,
      baseBranch: 'dev',
      worktreePath: join(tempDir, '.worktrees', 'leader-team'),
      members: ['worker-a'],
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(tempDir, '.genie', 'teams', 'leader-team.json'), JSON.stringify(teamConfig));

    process.env.GENIE_TEAM = 'leader-team';

    const error = await checkSendScope(tempDir, 'team-lead', 'outsider');
    expect(error).not.toBeNull();
    expect(error).toContain('Scope violation');
  });
});

// ---------------------------------------------------------------------------
// Shared buildTeamLeadCommand — single source of truth
// ---------------------------------------------------------------------------

describe('buildTeamLeadCommand (shared module)', () => {
  test('sets GENIE_AGENT_NAME=team-lead', async () => {
    const { buildTeamLeadCommand } = await import('../lib/team-lead-command.js');
    const cmd = buildTeamLeadCommand('genie');
    expect(cmd).toContain("GENIE_AGENT_NAME='team-lead'");
  });

  test('sets all required CC native team flags', async () => {
    const { buildTeamLeadCommand } = await import('../lib/team-lead-command.js');
    const cmd = buildTeamLeadCommand('genie');
    expect(cmd).toContain('--agent-id');
    expect(cmd).toContain('--agent-name');
    expect(cmd).toContain('--team-name');
    expect(cmd).toContain('--dangerously-skip-permissions');
    expect(cmd).toContain('CLAUDECODE=1');
    expect(cmd).toContain('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1');
  });

  test('includes --resume when resumeSessionId provided', async () => {
    const { buildTeamLeadCommand } = await import('../lib/team-lead-command.js');
    const cmd = buildTeamLeadCommand('genie', { resumeSessionId: 'abc-123' });
    expect(cmd).toContain('--resume');
    expect(cmd).toContain('abc-123');
  });

  test('includes --append-system-prompt-file when systemPrompt provided (default promptMode)', async () => {
    const { buildTeamLeadCommand } = await import('../lib/team-lead-command.js');
    const cmd = buildTeamLeadCommand('genie', { systemPrompt: 'test prompt' });
    expect(cmd).toContain('--append-system-prompt-file');
    expect(cmd).toContain('.genie/prompts/genie.md');
    // Prompt content is in the file, NOT inlined in the command
    expect(cmd).not.toContain('test prompt');
  });

  test('system prompt is persisted to file, referenced by path', async () => {
    const { buildTeamLeadCommand } = await import('../lib/team-lead-command.js');
    const cmd = buildTeamLeadCommand('genie', { systemPrompt: 'line one\nline two' });
    // Command references file path, does not contain prompt text
    expect(cmd).toContain('--append-system-prompt-file');
    expect(cmd).toContain('.genie/prompts/genie.md');
    expect(cmd).not.toContain('line one');
  });

  test('uses --system-prompt-file flag when promptMode is "system"', async () => {
    const { buildTeamLeadCommand } = await import('../lib/team-lead-command.js');
    const cmd = buildTeamLeadCommand('genie', { systemPrompt: 'test prompt', promptMode: 'system' });
    expect(cmd).toContain('--system-prompt-file');
    expect(cmd).not.toContain('--append-system-prompt-file');
  });
});

// ---------------------------------------------------------------------------
// Verify session.ts delegates to shared module
// ---------------------------------------------------------------------------

describe('session.ts: delegates to shared buildTeamLeadCommand', () => {
  test('session buildClaudeCommand sets GENIE_AGENT_NAME=team-lead', async () => {
    const { buildClaudeCommand } = await import('../genie-commands/session.js');
    const cmd = buildClaudeCommand('genie');
    expect(cmd).toContain("GENIE_AGENT_NAME='team-lead'");
  });
});

// ---------------------------------------------------------------------------
// Verify provider-adapters sets GENIE_AGENT_NAME for spawned workers
// ---------------------------------------------------------------------------

describe('provider-adapters: GENIE_AGENT_NAME for workers', () => {
  // Mock Bun.which to pretend claude is installed (hasBinary check)
  const originalWhich = (Bun as Record<string, unknown>).which;
  beforeEach(() => {
    (Bun as Record<string, unknown>).which = (name: string) =>
      name === 'claude' ? '/usr/local/bin/claude' : typeof originalWhich === 'function' ? originalWhich(name) : null;
  });
  afterEach(() => {
    (Bun as Record<string, unknown>).which = originalWhich;
  });

  test('buildClaudeCommand with nativeTeam sets GENIE_AGENT_NAME in env', async () => {
    const { buildClaudeCommand } = await import('../lib/provider-adapters.js');
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'genie',
      role: 'implementor',
      nativeTeam: {
        enabled: true,
        parentSessionId: 'fake-session-id',
        color: 'green',
        agentType: 'general-purpose',
        agentName: 'implementor',
      },
    });
    expect(result.env).toBeDefined();
    expect(result.env!.GENIE_AGENT_NAME).toBe('implementor');
  });

  test('buildClaudeCommand without nativeTeam does NOT set GENIE_AGENT_NAME', async () => {
    const { buildClaudeCommand } = await import('../lib/provider-adapters.js');
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'genie',
      role: 'implementor',
    });
    expect(result.env?.GENIE_AGENT_NAME).toBeUndefined();
  });
});
