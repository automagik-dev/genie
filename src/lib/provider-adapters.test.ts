/**
 * Provider Adapters — Unit Tests
 */

import { describe, expect, it } from 'bun:test';
import {
  buildLaunchCommand,
  buildClaudeCommand,
  buildCodexCommand,
  validateSpawnParams,
  type SpawnParams,
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
});

// ============================================================================
// Codex Adapter Tests (Group C)
// ============================================================================

describe('buildCodexCommand', () => {
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
