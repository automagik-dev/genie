/**
 * CodexProvider — Unit Tests
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Executor, SpawnContext } from '../executor-types.js';
import { CodexProvider } from './codex.js';

// ============================================================================
// Test Fixtures
// ============================================================================

function makeExecutor(overrides: Partial<Executor> = {}): Executor {
  return {
    id: 'exec-001',
    agentId: 'agent-001',
    provider: 'codex',
    transport: 'api',
    pid: null,
    tmuxSession: null,
    tmuxPaneId: null,
    tmuxWindow: null,
    tmuxWindowId: null,
    claudeSessionId: null,
    state: 'running',
    metadata: {},
    worktree: null,
    repoPath: '/home/genie/project',
    paneColor: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    turnId: null,
    outcome: null,
    closedAt: null,
    closeReason: null,
    ...overrides,
  };
}

function makeSpawnContext(overrides: Partial<SpawnContext> = {}): SpawnContext {
  return {
    agentId: 'agent-001',
    executorId: 'exec-001',
    team: 'test-team',
    role: 'engineer',
    cwd: '/home/genie/project',
    ...overrides,
  };
}

// ============================================================================
// Provider Identity
// ============================================================================

describe('CodexProvider', () => {
  // Mock Bun.which to pretend codex is installed
  const originalWhich = (Bun as Record<string, unknown>).which;
  beforeAll(() => {
    (Bun as Record<string, unknown>).which = (name: string) =>
      name === 'codex' ? '/usr/local/bin/codex' : typeof originalWhich === 'function' ? originalWhich(name) : null;
  });
  afterAll(() => {
    (Bun as Record<string, unknown>).which = originalWhich;
  });

  const provider = new CodexProvider();

  it('has correct name', () => {
    expect(provider.name).toBe('codex');
  });

  it('uses api transport', () => {
    expect(provider.transport).toBe('api');
  });

  it('does not support resume', () => {
    expect(provider.canResume()).toBe(false);
  });

  it('does not have buildResumeCommand', () => {
    expect((provider as unknown as Record<string, unknown>).buildResumeCommand).toBeUndefined();
  });

  // ============================================================================
  // buildSpawnCommand
  // ============================================================================

  describe('buildSpawnCommand', () => {
    it('produces a codex command with positional prompt', () => {
      const result = provider.buildSpawnCommand(makeSpawnContext());
      expect(result.command).toContain('codex');
      expect(result.command).toContain('Genie worker');
      expect(result.provider).toBe('codex');
    });

    it('includes --yolo for autonomous execution', () => {
      const result = provider.buildSpawnCommand(makeSpawnContext());
      expect(result.command).toContain('--yolo');
    });

    it('includes --no-alt-screen for tmux compatibility', () => {
      const result = provider.buildSpawnCommand(makeSpawnContext());
      expect(result.command).toContain('--no-alt-screen');
    });

    it('includes role in prompt', () => {
      const result = provider.buildSpawnCommand(makeSpawnContext({ role: 'tester' }));
      expect(result.command).toContain('Role: tester');
      expect(result.meta.role).toBe('tester');
    });

    it('includes skill in prompt', () => {
      const result = provider.buildSpawnCommand(makeSpawnContext({ skill: 'work' }));
      expect(result.command).toContain('work');
      expect(result.meta.skill).toBe('work');
    });

    it('forwards extra args', () => {
      const result = provider.buildSpawnCommand(makeSpawnContext({ extraArgs: ['--model', 'o3'] }));
      expect(result.command).toContain('--model');
      expect(result.command).toContain('o3');
    });

    it('produces identical output to buildCodexCommand for same inputs', () => {
      const { buildCodexCommand } = require('../provider-adapters.js');
      const ctx = makeSpawnContext({ role: 'tester', skill: 'work' });
      const providerResult = provider.buildSpawnCommand(ctx);
      const directResult = buildCodexCommand({
        provider: 'codex',
        team: ctx.team,
        role: ctx.role,
        skill: ctx.skill,
      });
      expect(providerResult.command).toBe(directResult.command);
      expect(providerResult.provider).toBe(directResult.provider);
    });
  });

  // ============================================================================
  // extractSession
  // ============================================================================

  describe('extractSession', () => {
    it('always returns null', async () => {
      const exec = makeExecutor();
      const result = await provider.extractSession(exec);
      expect(result).toBeNull();
    });

    it('returns null even with claude session ID set', async () => {
      const exec = makeExecutor({ claudeSessionId: 'some-session' });
      const result = await provider.extractSession(exec);
      expect(result).toBeNull();
    });
  });

  // ============================================================================
  // detectState
  // ============================================================================

  describe('detectState', () => {
    it('returns working for active executor', async () => {
      const exec = makeExecutor({ state: 'running' });
      const state = await provider.detectState(exec);
      expect(state).toBe('working');
    });

    it('returns terminated when state is terminated', async () => {
      const exec = makeExecutor({ state: 'terminated' });
      const state = await provider.detectState(exec);
      expect(state).toBe('terminated');
    });

    it('returns terminated when endedAt is set', async () => {
      const exec = makeExecutor({ state: 'working', endedAt: new Date().toISOString() });
      const state = await provider.detectState(exec);
      expect(state).toBe('terminated');
    });

    it('returns working for idle executor (fire-and-forget)', async () => {
      const exec = makeExecutor({ state: 'idle' });
      const state = await provider.detectState(exec);
      expect(state).toBe('working');
    });
  });

  // ============================================================================
  // terminate
  // ============================================================================

  describe('terminate', () => {
    it('handles executor with no PID gracefully', async () => {
      const exec = makeExecutor({ pid: null });
      await provider.terminate(exec);
      // Should not throw
    });

    it('attempts SIGTERM when PID is available', async () => {
      // Use a PID that doesn't exist — should not throw
      const exec = makeExecutor({ pid: 999999999 });
      await provider.terminate(exec);
      // Should not throw even for non-existent PID
    });
  });

  // ============================================================================
  // Interface Compliance
  // ============================================================================

  describe('interface compliance', () => {
    it('implements all required ExecutorProvider methods', () => {
      expect(typeof provider.buildSpawnCommand).toBe('function');
      expect(typeof provider.extractSession).toBe('function');
      expect(typeof provider.detectState).toBe('function');
      expect(typeof provider.terminate).toBe('function');
      expect(typeof provider.canResume).toBe('function');
      expect(provider.name).toBe('codex');
      expect(provider.transport).toBe('api');
    });
  });
});
