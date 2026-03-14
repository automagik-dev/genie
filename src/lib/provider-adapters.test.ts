/**
 * Provider Adapters — Unit Tests
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  type SpawnParams,
  buildClaudeCommand,
  buildCodexCommand,
  buildLaunchCommand,
  validateSpawnParams,
} from './provider-adapters.js';

// ============================================================================
// Validation Tests (Group A)
// ============================================================================

describe('validateSpawnParams', () => {
  it('accepts valid claude params', () => {
    const params: SpawnParams = { provider: 'claude', team: 'work', role: 'implementor' };
    const result = validateSpawnParams(params);
    expect(result.provider).toBe('claude');
    expect(result.team).toBe('work');
    expect(result.role).toBe('implementor');
  });

  it('accepts valid codex params with skill', () => {
    const params: SpawnParams = { provider: 'codex', team: 'work', skill: 'work', role: 'tester' };
    const result = validateSpawnParams(params);
    expect(result.provider).toBe('codex');
    expect(result.skill).toBe('work');
  });

  it('rejects invalid provider', () => {
    expect(() => validateSpawnParams({ provider: 'gpt' as any, team: 'work' })).toThrow();
  });

  it('rejects empty team', () => {
    expect(() => validateSpawnParams({ provider: 'claude', team: '' })).toThrow();
  });

  it('accepts codex without skill', () => {
    const result = validateSpawnParams({ provider: 'codex', team: 'work' });
    expect(result.provider).toBe('codex');
  });

  it('allows claude without skill', () => {
    const params: SpawnParams = { provider: 'claude', team: 'work' };
    const result = validateSpawnParams(params);
    expect(result.provider).toBe('claude');
  });
});

// ============================================================================
// Claude Adapter Tests (Group C)
// ============================================================================

describe('buildClaudeCommand', () => {
  // Mock Bun.which to pretend claude is installed (hasBinary check)
  const originalWhich = (Bun as Record<string, unknown>).which;
  beforeAll(() => {
    (Bun as Record<string, unknown>).which = (name: string) =>
      name === 'claude' ? '/usr/local/bin/claude' : typeof originalWhich === 'function' ? originalWhich(name) : null;
  });
  afterAll(() => {
    (Bun as Record<string, unknown>).which = originalWhich;
  });

  it('builds command with --agent role', () => {
    const result = buildClaudeCommand({ provider: 'claude', team: 'work', role: 'implementor' });
    expect(result.command).toContain('claude');
    expect(result.command).toContain('--agent');
    expect(result.command).toContain('implementor');
    expect(result.provider).toBe('claude');
    expect(result.meta.role).toBe('implementor');
  });

  it('includes --dangerously-skip-permissions', () => {
    const result = buildClaudeCommand({ provider: 'claude', team: 'work', role: 'implementor' });
    expect(result.command).toContain('--dangerously-skip-permissions');
  });

  it('excludes --agent when no role specified', () => {
    const result = buildClaudeCommand({ provider: 'claude', team: 'work' });
    expect(result.command).toContain('--dangerously-skip-permissions');
    expect(result.command).not.toContain('--agent');
  });

  it('does not include hidden teammate flags', () => {
    const result = buildClaudeCommand({ provider: 'claude', team: 'work', role: 'implementor' });
    expect(result.command).not.toContain('--teammate');
    expect(result.command).not.toContain('--internal');
  });

  it('forwards extra args', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      role: 'implementor',
      extraArgs: ['--dangerously-skip-permissions'],
    });
    expect(result.command).toContain('--dangerously-skip-permissions');
  });

  it('includes --model flag when model is set', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      role: 'implementor',
      model: 'opus',
    });
    expect(result.command).toContain("--model 'opus'");
  });

  it('includes --append-system-prompt-file by default when systemPromptFile is set', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      systemPromptFile: '/path/to/AGENTS.md',
    });
    expect(result.command).toContain('--append-system-prompt-file');
    expect(result.command).toContain('/path/to/AGENTS.md');
  });

  it('uses --system-prompt-file when promptMode is "system"', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      systemPromptFile: '/path/to/AGENTS.md',
      promptMode: 'system',
    });
    expect(result.command).toContain('--system-prompt-file');
    expect(result.command).not.toContain('--append-system-prompt-file');
  });

  it('uses --append-system-prompt-file when promptMode is "append"', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      systemPromptFile: '/path/to/AGENTS.md',
      promptMode: 'append',
    });
    expect(result.command).toContain('--append-system-prompt-file');
    expect(result.command).not.toContain("--system-prompt-file '/path");
  });

  it('does not include prompt file flags when systemPromptFile is not set', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      role: 'implementor',
    });
    expect(result.command).not.toContain('--system-prompt-file');
    expect(result.command).not.toContain('--append-system-prompt-file');
  });

  // ============================================================================
  // QA Plan P1 Tests (U-PA-*)
  // ============================================================================

  // U-PA-01: Both systemPromptFile + systemPrompt — systemPromptFile wins
  it('U-PA-01: systemPromptFile wins over systemPrompt (checked first)', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      systemPromptFile: '/path/to/AGENTS.md',
      systemPrompt: 'Inline system prompt text',
      promptMode: 'append',
    });
    expect(result.command).toContain('--append-system-prompt-file');
    expect(result.command).toContain('/path/to/AGENTS.md');
    // systemPrompt should NOT appear when systemPromptFile is set
    expect(result.command).not.toContain('--append-system-prompt ');
    expect(result.command).not.toContain('Inline system prompt text');
  });

  // U-PA-02: Shell injection in role
  it('U-PA-02: shell injection in role is neutralized by escapeShellArg', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      role: '"; rm -rf /',
    });
    // The role arg should be wrapped in single quotes (escapeShellArg)
    const agentIdx = result.command.indexOf('--agent');
    const afterAgent = result.command.slice(agentIdx);
    expect(afterAgent).toMatch(/--agent\s+'/);
    // The dangerous payload is inside single quotes, making it inert
    // Verify the command doesn't have an unquoted semicolon
    expect(result.command).toContain('\'"');
  });

  // U-PA-03: Single quotes in file path
  it('U-PA-03: single quotes in file path are correctly escaped', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      systemPromptFile: "/path/to/agent's dir/AGENTS.md",
      promptMode: 'append',
    });
    // The single quote should be escaped: ' -> '\''
    expect(result.command).toContain("'\\''");
    expect(result.command).toContain('AGENTS.md');
  });

  // U-PA-04: promptMode 'system' produces --system-prompt-file
  it('U-PA-04: promptMode system produces --system-prompt-file flag', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      systemPromptFile: '/path/to/AGENTS.md',
      promptMode: 'system',
    });
    expect(result.command).toContain('--system-prompt-file');
    expect(result.command).not.toContain('--append-system-prompt-file');
  });

  // U-PA-05: promptMode 'append' produces --append-system-prompt-file
  it('U-PA-05: promptMode append produces --append-system-prompt-file flag', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      systemPromptFile: '/path/to/AGENTS.md',
      promptMode: 'append',
    });
    expect(result.command).toContain('--append-system-prompt-file');
    // Should NOT contain the non-append version as a distinct flag
    const parts = result.command.split(' ');
    const systemPromptFileFlags = parts.filter((p) => p === '--system-prompt-file');
    expect(systemPromptFileFlags.length).toBe(0);
  });

  // U-PA-06: nativeTeam enabled with all flags populated
  it('U-PA-06: nativeTeam enabled produces all 8 native team flags', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'feat/test-team',
      role: 'implementor',
      nativeTeam: {
        enabled: true,
        parentSessionId: 'parent-uuid-123',
        color: 'blue',
        agentType: 'general-purpose',
        planModeRequired: true,
        permissionMode: 'acceptEdits',
        agentName: 'my-agent',
      },
    });

    expect(result.command).toContain('--agent-id');
    expect(result.command).toContain('--agent-name');
    expect(result.command).toContain('--team-name');
    expect(result.command).toContain('--agent-color');
    expect(result.command).toContain('--parent-session-id');
    expect(result.command).toContain('--agent-type');
    expect(result.command).toContain('--plan-mode-required');
    expect(result.command).toContain('--permission-mode');

    // Env vars should be set
    expect(result.env?.CLAUDECODE).toBe('1');
    expect(result.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
    expect(result.env?.GENIE_AGENT_NAME).toBe('my-agent');
  });

  // U-PA-07: GENIE_AGENT_NAME env var set for non-native spawns
  it('U-PA-07: GENIE_AGENT_NAME env var set when role exists (non-native)', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      role: 'implementor',
    });
    expect(result.env?.GENIE_AGENT_NAME).toBe('implementor');
  });

  it('U-PA-07: GENIE_AGENT_NAME not set when no role (non-native)', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
    });
    // No role = no GENIE_AGENT_NAME, so env should be undefined (no env keys)
    expect(result.env).toBeUndefined();
  });

  // Additional: systemPrompt with promptMode 'system' uses --system-prompt
  it('systemPrompt with promptMode system uses --system-prompt flag', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      systemPrompt: 'You are a tester agent.',
      promptMode: 'system',
    });
    expect(result.command).toContain('--system-prompt');
    expect(result.command).not.toContain('--system-prompt-file');
    expect(result.command).not.toContain('--append-system-prompt');
  });

  // Additional: systemPrompt with promptMode 'append' uses --append-system-prompt
  it('systemPrompt with promptMode append uses --append-system-prompt flag', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      systemPrompt: 'You are a tester agent.',
      promptMode: 'append',
    });
    expect(result.command).toContain('--append-system-prompt');
    expect(result.command).not.toContain('--append-system-prompt-file');
  });
});

// ============================================================================
// Codex Adapter Tests (Group C)
// ============================================================================

describe('buildCodexCommand', () => {
  // Mock Bun.which to pretend codex is installed (hasBinary check)
  const originalWhich = (Bun as Record<string, unknown>).which;
  beforeAll(() => {
    (Bun as Record<string, unknown>).which = (name: string) =>
      name === 'codex' ? '/usr/local/bin/codex' : typeof originalWhich === 'function' ? originalWhich(name) : null;
  });
  afterAll(() => {
    (Bun as Record<string, unknown>).which = originalWhich;
  });

  it('builds command with positional prompt for skill', () => {
    const result = buildCodexCommand({ provider: 'codex', team: 'work', skill: 'work', role: 'tester' });
    expect(result.command).toContain('codex');
    expect(result.command).not.toContain('--instructions');
    expect(result.command).toContain('work');
    expect(result.provider).toBe('codex');
    expect(result.meta.skill).toBe('work');
    expect(result.meta.role).toBe('tester');
  });

  it('includes --yolo for autonomous execution', () => {
    const result = buildCodexCommand({ provider: 'codex', team: 'work', skill: 'work' });
    expect(result.command).toContain('--yolo');
  });

  it('includes --no-alt-screen for tmux compatibility', () => {
    const result = buildCodexCommand({ provider: 'codex', team: 'work', skill: 'work' });
    expect(result.command).toContain('--no-alt-screen');
  });

  it('builds command without skill', () => {
    const result = buildCodexCommand({ provider: 'codex', team: 'work' });
    expect(result.command).toContain('codex');
    expect(result.command).toContain('Genie worker');
    expect(result.command).not.toContain('Skill:');
  });

  it('includes role in prompt', () => {
    const result = buildCodexCommand({ provider: 'codex', team: 'work', skill: 'work', role: 'tester' });
    expect(result.command).toContain('Role: tester');
  });

  it('does not depend on agent-name routing', () => {
    const result = buildCodexCommand({ provider: 'codex', team: 'work', skill: 'work' });
    expect(result.command).not.toContain('--agent');
  });

  it('places prompt as last argument', () => {
    const result = buildCodexCommand({
      provider: 'codex',
      team: 'work',
      skill: 'work',
      extraArgs: ['--model', 'o3'],
    });
    // Prompt (containing "Genie worker") should come after extra args
    const yoloIdx = result.command.indexOf('--yolo');
    const modelIdx = result.command.indexOf('--model');
    const promptIdx = result.command.indexOf('Genie worker');
    expect(yoloIdx).toBeLessThan(modelIdx);
    expect(modelIdx).toBeLessThan(promptIdx);
  });

  it('forwards extra args', () => {
    const result = buildCodexCommand({
      provider: 'codex',
      team: 'work',
      skill: 'work',
      extraArgs: ['--model', 'o3'],
    });
    expect(result.command).toContain('--model');
    expect(result.command).toContain('o3');
  });
});

// ============================================================================
// Dispatch Tests (Group C)
// ============================================================================

describe('buildLaunchCommand', () => {
  // Mock Bun.which to pretend codex is installed (hasBinary check)
  const originalWhich = (Bun as Record<string, unknown>).which;
  beforeAll(() => {
    (Bun as Record<string, unknown>).which = (name: string) =>
      name === 'codex' || name === 'claude'
        ? `/usr/local/bin/${name}`
        : typeof originalWhich === 'function'
          ? originalWhich(name)
          : null;
  });
  afterAll(() => {
    (Bun as Record<string, unknown>).which = originalWhich;
  });

  it('dispatches to claude adapter', () => {
    const result = buildLaunchCommand({ provider: 'claude', team: 'work', role: 'implementor' });
    expect(result.provider).toBe('claude');
    expect(result.command).toContain('claude');
  });

  it('dispatches to codex adapter', () => {
    const result = buildLaunchCommand({ provider: 'codex', team: 'work', skill: 'work' });
    expect(result.provider).toBe('codex');
    expect(result.command).toContain('codex');
  });

  it('rejects invalid provider before dispatch', () => {
    expect(() => buildLaunchCommand({ provider: 'invalid' as any, team: 'work' })).toThrow();
  });

  it('dispatches codex without skill', () => {
    const result = buildLaunchCommand({ provider: 'codex', team: 'work' });
    expect(result.provider).toBe('codex');
    expect(result.command).toContain('Genie worker');
  });
});
