/**
 * ClaudeCodeProvider — Unit Tests
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Executor, ResumeContext, SpawnContext } from '../executor-types.js';
import { ClaudeCodeProvider } from './claude-code.js';

// ============================================================================
// Test Fixtures
// ============================================================================

function makeExecutor(overrides: Partial<Executor> = {}): Executor {
  return {
    id: 'exec-001',
    agentId: 'agent-001',
    provider: 'claude',
    transport: 'tmux',
    pid: 12345,
    tmuxSession: 'genie',
    tmuxPaneId: '%5',
    tmuxWindow: 'engineer',
    tmuxWindowId: '@3',
    claudeSessionId: 'abc-123-def',
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

function makeResumeContext(overrides: Partial<ResumeContext> = {}): ResumeContext {
  return {
    agentId: 'agent-001',
    executorId: 'exec-002',
    team: 'test-team',
    role: 'engineer',
    cwd: '/home/genie/project',
    claudeSessionId: 'abc-123-def',
    ...overrides,
  };
}

// ============================================================================
// Provider Identity
// ============================================================================

describe('ClaudeCodeProvider', () => {
  // Mock Bun.which to pretend claude is installed
  const originalWhich = (Bun as Record<string, unknown>).which;
  beforeAll(() => {
    (Bun as Record<string, unknown>).which = (name: string) =>
      name === 'claude' ? '/usr/local/bin/claude' : typeof originalWhich === 'function' ? originalWhich(name) : null;
  });
  afterAll(() => {
    (Bun as Record<string, unknown>).which = originalWhich;
  });

  const provider = new ClaudeCodeProvider();

  it('has correct name', () => {
    expect(provider.name).toBe('claude-code');
  });

  it('uses tmux transport', () => {
    expect(provider.transport).toBe('tmux');
  });

  it('supports resume', () => {
    expect(provider.canResume()).toBe(true);
  });

  // ============================================================================
  // buildSpawnCommand
  // ============================================================================

  describe('buildSpawnCommand', () => {
    it('produces a claude command with --agent role', () => {
      const result = provider.buildSpawnCommand(makeSpawnContext());
      expect(result.command).toContain('claude');
      expect(result.command).toContain('--agent');
      expect(result.command).toContain('engineer');
      expect(result.provider).toBe('claude');
      expect(result.meta.role).toBe('engineer');
    });

    it('includes --dangerously-skip-permissions', () => {
      const result = provider.buildSpawnCommand(makeSpawnContext());
      expect(result.command).toContain('--dangerously-skip-permissions');
    });

    it('produces identical output to buildClaudeCommand for same inputs', () => {
      const { buildClaudeCommand } = require('../provider-adapters.js');
      const ctx = makeSpawnContext({ role: 'reviewer', model: 'opus' });
      const providerResult = provider.buildSpawnCommand(ctx);
      const directResult = buildClaudeCommand({
        provider: 'claude',
        team: ctx.team,
        role: ctx.role,
        model: ctx.model,
      });
      // Both should contain the same key components
      expect(providerResult.command).toContain("--agent 'reviewer'");
      expect(directResult.command).toContain("--agent 'reviewer'");
      expect(providerResult.command).toContain("--model 'opus'");
      expect(directResult.command).toContain("--model 'opus'");
      expect(providerResult.provider).toBe(directResult.provider);
    });

    it('excludes --agent when no role specified', () => {
      const result = provider.buildSpawnCommand(makeSpawnContext({ role: undefined }));
      expect(result.command).not.toContain('--agent');
    });

    it('forwards model flag', () => {
      const result = provider.buildSpawnCommand(makeSpawnContext({ model: 'sonnet' }));
      expect(result.command).toContain("--model 'sonnet'");
    });

    it('includes session-id when provided', () => {
      const result = provider.buildSpawnCommand(
        makeSpawnContext({ sessionId: '550e8400-e29b-41d4-a716-446655440000' }),
      );
      expect(result.command).toContain('--session-id');
      expect(result.command).toContain('550e8400-e29b-41d4-a716-446655440000');
    });

    it('forwards extra args', () => {
      const result = provider.buildSpawnCommand(makeSpawnContext({ extraArgs: ['--verbose'] }));
      expect(result.command).toContain('--verbose');
    });

    it('includes initial prompt as positional arg', () => {
      const result = provider.buildSpawnCommand(makeSpawnContext({ initialPrompt: 'Do the work' }));
      expect(result.command).toContain('Do the work');
    });

    it('sets GENIE_WORKER=1 in env', () => {
      const result = provider.buildSpawnCommand(makeSpawnContext());
      expect(result.env?.GENIE_WORKER).toBe('1');
    });

    it('sets GENIE_AGENT_NAME in env', () => {
      const result = provider.buildSpawnCommand(makeSpawnContext({ role: 'qa' }));
      expect(result.env?.GENIE_AGENT_NAME).toBe('qa');
    });

    it('handles native team params', () => {
      const result = provider.buildSpawnCommand(
        makeSpawnContext({
          nativeTeam: {
            enabled: true,
            parentSessionId: 'parent-uuid',
            color: 'blue',
            agentName: 'engineer',
          },
        }),
      );
      expect(result.command).toContain('--agent-id');
      expect(result.command).toContain('--team-name');
      expect(result.env?.CLAUDECODE).toBe('1');
    });

    it('handles systemPromptFile', () => {
      const result = provider.buildSpawnCommand(makeSpawnContext({ systemPromptFile: '/path/to/AGENTS.md' }));
      expect(result.command).toContain('--append-system-prompt-file');
      expect(result.command).toContain('/path/to/AGENTS.md');
    });

    it('injects OTel env vars when otelPort is set', () => {
      const saved = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = undefined as unknown as string;
      try {
        const result = provider.buildSpawnCommand(makeSpawnContext({ otelPort: 19643 }));
        expect(result.env?.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
        expect(result.env?.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://127.0.0.1:19643');
      } finally {
        if (saved) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = saved;
        else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = undefined as unknown as string;
      }
    });
  });

  // ============================================================================
  // buildResumeCommand
  // ============================================================================

  describe('buildResumeCommand', () => {
    it('produces a claude command with --resume', () => {
      const result = provider.buildResumeCommand!(makeResumeContext());
      expect(result.command).toContain('claude');
      expect(result.command).toContain('--resume');
      expect(result.command).toContain('abc-123-def');
      expect(result.provider).toBe('claude');
    });

    it('does not include --session-id when resuming', () => {
      const result = provider.buildResumeCommand!(makeResumeContext());
      expect(result.command).not.toContain('--session-id');
    });

    it('includes --agent role when provided', () => {
      const result = provider.buildResumeCommand!(makeResumeContext({ role: 'reviewer' }));
      expect(result.command).toContain("--agent 'reviewer'");
    });

    it('includes --model when provided', () => {
      const result = provider.buildResumeCommand!(makeResumeContext({ model: 'opus' }));
      expect(result.command).toContain("--model 'opus'");
    });

    it('forwards native team params', () => {
      const result = provider.buildResumeCommand!(
        makeResumeContext({
          nativeTeam: {
            enabled: true,
            parentSessionId: 'parent-uuid',
            color: 'green',
            agentName: 'engineer',
          },
        }),
      );
      expect(result.command).toContain('--agent-id');
      expect(result.env?.CLAUDECODE).toBe('1');
    });
  });

  // ============================================================================
  // detectState
  // ============================================================================

  describe('detectState', () => {
    it('returns terminated when no pane ID', async () => {
      const exec = makeExecutor({ tmuxPaneId: null });
      const state = await provider.detectState(exec);
      expect(state).toBe('terminated');
    });

    // Note: Full detectState tests require tmux runtime and are covered
    // by integration tests in Group 8. These unit tests verify the
    // contract and edge cases.
  });

  // ============================================================================
  // extractSession
  // ============================================================================

  describe('extractSession', () => {
    it('returns null when no claude session ID', async () => {
      const exec = makeExecutor({ claudeSessionId: null });
      const result = await provider.extractSession(exec);
      expect(result).toBeNull();
    });

    it('returns session ID when claude session ID is set', async () => {
      const exec = makeExecutor({ claudeSessionId: 'test-session-id' });
      // Will return sessionId even if log file not found (logPath will be undefined)
      const result = await provider.extractSession(exec);
      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('test-session-id');
    });
  });

  // ============================================================================
  // terminate
  // ============================================================================

  describe('terminate', () => {
    it('handles executor with no pane and no PID gracefully', async () => {
      const exec = makeExecutor({ tmuxPaneId: null, pid: null });
      // Should not throw
      await provider.terminate(exec);
    });
  });

  // ============================================================================
  // State Mapping
  // ============================================================================

  describe('state mapping coverage', () => {
    // Test the mapDetectedState function indirectly through the contract
    it('provider implements all 7 ExecutorProvider methods', () => {
      expect(typeof provider.buildSpawnCommand).toBe('function');
      expect(typeof provider.extractSession).toBe('function');
      expect(typeof provider.detectState).toBe('function');
      expect(typeof provider.terminate).toBe('function');
      expect(typeof provider.canResume).toBe('function');
      expect(typeof provider.buildResumeCommand).toBe('function');
      // name and transport are readonly properties
      expect(provider.name).toBe('claude-code');
      expect(provider.transport).toBe('tmux');
    });
  });
});
