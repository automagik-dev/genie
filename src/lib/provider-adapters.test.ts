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

  it('does not include prompt file flags when neither systemPromptFile nor systemPrompt is set', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      role: 'implementor',
    });
    expect(result.command).not.toContain('--system-prompt-file');
    expect(result.command).not.toContain('--append-system-prompt-file');
  });

  it('writes systemPrompt to temp file and uses --append-system-prompt-file', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      role: 'implementor',
      systemPrompt: 'You are an implementor agent.',
    });
    expect(result.command).toContain('--append-system-prompt-file');
    expect(result.command).toContain('/tmp/genie-prompts/implementor-');
    // Must NOT contain inline --append-system-prompt (without -file)
    expect(result.command).not.toMatch(/--append-system-prompt(?!-file)/);
  });

  it('writes systemPrompt to temp file with --system-prompt-file when promptMode is "system"', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      role: 'implementor',
      systemPrompt: 'You are an implementor agent.',
      promptMode: 'system',
    });
    expect(result.command).toContain('--system-prompt-file');
    expect(result.command).not.toContain('--append-system-prompt-file');
    expect(result.command).toContain('/tmp/genie-prompts/implementor-');
  });

  it('never emits inline --system-prompt or --append-system-prompt flags', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      role: 'tester',
      systemPrompt: 'Multi-line prompt\nwith ```code blocks```\nand special chars: $VAR "quotes"',
    });
    // Should use file-based flag
    expect(result.command).toContain('--append-system-prompt-file');
    // Must NOT contain inline prompt flags (without -file suffix)
    expect(result.command).not.toMatch(/--append-system-prompt(?!-file)/);
    expect(result.command).not.toMatch(/--system-prompt(?!-file)/);
  });

  it('uses "agent" as fallback role in temp file name when no role set', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      systemPrompt: 'Some prompt',
    });
    expect(result.command).toContain('/tmp/genie-prompts/agent-');
    expect(result.command).toContain('--append-system-prompt-file');
  });

  it('merges systemPromptFile and systemPrompt into one temp file', () => {
    const fs = require('node:fs');
    const testFile = '/tmp/genie-prompts/test-agents.md';
    fs.mkdirSync('/tmp/genie-prompts', { recursive: true });
    fs.writeFileSync(testFile, 'User agent instructions');

    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      role: 'implementor',
      systemPromptFile: testFile,
      systemPrompt: 'Built-in prompt',
    });
    expect(result.command).toContain('--append-system-prompt-file');
    // Should reference the NEW temp file, not the original
    expect(result.command).toContain('/tmp/genie-prompts/implementor-');

    // Verify merged content
    const match = result.command.match(/\/tmp\/genie-prompts\/implementor-[^']+/);
    expect(match).toBeTruthy();
    const content = fs.readFileSync(match![0], 'utf-8');
    expect(content).toContain('User agent instructions');
    expect(content).toContain('Built-in prompt');
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
