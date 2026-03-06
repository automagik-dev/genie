/**
 * Sender Identity Detection — Regression Tests
 *
 * Covers the detectSenderIdentity cascade to prevent identity bugs
 * where messages arrive as "genie" or "cli" instead of the correct sender.
 *
 * Scenarios:
 *   1. Team-lead calling genie send via CC Bash tool (GENIE_AGENT_NAME set)
 *   2. Worker calling genie send (GENIE_AGENT_NAME set by provider-adapters)
 *   3. External CLI without context (no env, no tmux → fallback to 'cli')
 *   4. GENIE_AGENT_NAME priority over TMUX_PANE
 *   5. TMUX_PANE fallback when no env var and no registry match
 *
 * Run with: bun test src/term-commands/msg.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { detectSenderIdentity } from './msg.js';

// ---------------------------------------------------------------------------
// Helpers: save/restore env vars
// ---------------------------------------------------------------------------

const ENV_KEYS = ['GENIE_AGENT_NAME', 'TMUX_PANE', 'CLAUDE_CONFIG_DIR'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
  }
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

  test('includes --system-prompt when systemPrompt provided', async () => {
    const { buildTeamLeadCommand } = await import('../lib/team-lead-command.js');
    const cmd = buildTeamLeadCommand('genie', { systemPrompt: 'test prompt' });
    expect(cmd).toContain('--system-prompt');
    expect(cmd).toContain('test prompt');
  });

  test('flattens newlines in system prompt', async () => {
    const { buildTeamLeadCommand } = await import('../lib/team-lead-command.js');
    const cmd = buildTeamLeadCommand('genie', { systemPrompt: 'line one\nline two' });
    expect(cmd).not.toContain('\n');
    expect(cmd).toContain('line one line two');
  });
});

// ---------------------------------------------------------------------------
// Verify tui.ts delegates to shared module
// ---------------------------------------------------------------------------

describe('tui.ts: delegates to shared buildTeamLeadCommand', () => {
  test('tui buildClaudeCommand sets GENIE_AGENT_NAME=team-lead', async () => {
    const { buildClaudeCommand } = await import('../genie-commands/tui.js');
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
