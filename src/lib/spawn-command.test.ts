/**
 * Tests for spawn-command.ts - buildSpawnCommand + waitForAgentReady
 * Run with: bun test src/lib/spawn-command.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  DEFAULT_SPAWN_TIMEOUT_MS,
  READINESS_POLL_INTERVAL_MS,
  type WorkerProfile,
  _pgDeps,
  buildSpawnCommand,
  waitForAgentReady,
  waitForExecutorReady,
} from './spawn-command.js';

// ============================================================================
// Test Helpers
// ============================================================================

function makeProfile(overrides: Partial<WorkerProfile> = {}): WorkerProfile {
  return {
    launcher: 'claude',
    claudeArgs: ['--dangerously-skip-permissions'],
    ...overrides,
  };
}

// ============================================================================
// WorkerProfile Types
// ============================================================================

describe('WorkerProfile type', () => {
  test('claude profile has launcher and claudeArgs', () => {
    const profile: WorkerProfile = {
      launcher: 'claude',
      claudeArgs: ['--dangerously-skip-permissions'],
    };
    expect(profile.launcher).toBe('claude');
    expect(profile.claudeArgs).toContain('--dangerously-skip-permissions');
  });
});

// ============================================================================
// buildSpawnCommand - Claude profiles
// ============================================================================

describe('buildSpawnCommand with claude launcher', () => {
  test('builds command with session-id', () => {
    const profile = makeProfile({
      launcher: 'claude',
      claudeArgs: ['--dangerously-skip-permissions'],
    });
    const command = buildSpawnCommand(profile, { sessionId: 'abc-123' });
    expect(command).toBe("claude '--dangerously-skip-permissions' --session-id 'abc-123'");
  });

  test('builds command with multiple claude args', () => {
    const profile = makeProfile({
      launcher: 'claude',
      claudeArgs: ['--dangerously-skip-permissions', '--model', 'opus'],
    });
    const command = buildSpawnCommand(profile, { sessionId: 'def-456' });
    expect(command).toBe("claude '--dangerously-skip-permissions' '--model' 'opus' --session-id 'def-456'");
  });

  test('builds command with empty claudeArgs', () => {
    const profile = makeProfile({
      launcher: 'claude',
      claudeArgs: [],
    });
    const command = buildSpawnCommand(profile, { sessionId: 'ghi-789' });
    expect(command).toBe("claude --session-id 'ghi-789'");
  });

  test('builds command with resume instead of session-id', () => {
    const profile = makeProfile({
      launcher: 'claude',
      claudeArgs: ['--dangerously-skip-permissions'],
    });
    const command = buildSpawnCommand(profile, { resume: 'abc-123' });
    expect(command).toBe("claude '--dangerously-skip-permissions' --resume 'abc-123'");
  });
});

// ============================================================================
// buildSpawnCommand - No profile (throws error)
// ============================================================================

describe('buildSpawnCommand with undefined profile', () => {
  test('throws error when no profile is provided', () => {
    expect(() => buildSpawnCommand(undefined, { sessionId: 'test-123' })).toThrow(/No worker profile configured/);
  });
});

// ============================================================================
// buildSpawnCommand - Edge cases
// ============================================================================

describe('buildSpawnCommand edge cases', () => {
  test('handles session-id with special characters', () => {
    const profile = makeProfile({
      launcher: 'claude',
      claudeArgs: [],
    });
    const command = buildSpawnCommand(profile, { sessionId: "abc'def" });
    expect(command).toBe("claude --session-id 'abc'\\''def'");
  });

  test('sessionId takes precedence if both sessionId and resume provided', () => {
    const profile = makeProfile({
      launcher: 'claude',
      claudeArgs: [],
    });
    const command = buildSpawnCommand(profile, {
      sessionId: 'session-id-value',
      resume: 'resume-value',
    });
    expect(command).toBe("claude --session-id 'session-id-value'");
  });

  test('handles command without sessionId or resume', () => {
    const profile = makeProfile({
      launcher: 'claude',
      claudeArgs: ['--dangerously-skip-permissions'],
    });
    const command = buildSpawnCommand(profile, {});
    expect(command).toBe("claude '--dangerously-skip-permissions'");
  });
});

// ============================================================================
// Shell Injection Prevention
// ============================================================================

describe('shell injection prevention', () => {
  test('escapes shell metacharacters in claudeArgs', () => {
    const profile = makeProfile({
      launcher: 'claude',
      claudeArgs: ['--dangerously-skip-permissions', '--append-system-prompt', "'; rm -rf /; echo '"],
    });
    const command = buildSpawnCommand(profile, { sessionId: 'test-123' });
    expect(command).toBe(
      "claude '--dangerously-skip-permissions' '--append-system-prompt' ''\\''; rm -rf /; echo '\\''' --session-id 'test-123'",
    );
  });

  test('escapes backticks in claudeArgs', () => {
    const profile = makeProfile({
      launcher: 'claude',
      claudeArgs: ['--prompt', '`id`'],
    });
    const command = buildSpawnCommand(profile, { sessionId: 'test-abc' });
    expect(command).toBe("claude '--prompt' '`id`' --session-id 'test-abc'");
  });

  test('escapes dollar signs in claudeArgs', () => {
    const profile = makeProfile({
      launcher: 'claude',
      claudeArgs: ['--env', '$HOME'],
    });
    const command = buildSpawnCommand(profile, { sessionId: 'test-def' });
    expect(command).toBe("claude '--env' '$HOME' --session-id 'test-def'");
  });

  test('escapes newlines in claudeArgs', () => {
    const profile = makeProfile({
      launcher: 'claude',
      claudeArgs: ['--prompt', 'hello\nworld'],
    });
    const command = buildSpawnCommand(profile, { sessionId: 'test-jkl' });
    expect(command).toBe("claude '--prompt' 'hello\nworld' --session-id 'test-jkl'");
  });
});

// ============================================================================
// Readiness Detection — Constants
// ============================================================================

describe('readiness constants', () => {
  test('DEFAULT_SPAWN_TIMEOUT_MS is 30s', () => {
    expect(DEFAULT_SPAWN_TIMEOUT_MS).toBe(30_000);
  });

  test('READINESS_POLL_INTERVAL_MS is 2s', () => {
    expect(READINESS_POLL_INTERVAL_MS).toBe(2_000);
  });
});

// ============================================================================
// Readiness Detection — waitForAgentReady
// ============================================================================

// We mock the two dependencies that waitForAgentReady calls internally.
// Since bun:test mock.module hoists, we declare them before describe blocks.

const mockCapturePaneContent = mock<(paneId: string, lines?: number) => Promise<string>>();
const mockDetectState =
  mock<(output: string) => { type: string; confidence: number; timestamp: number; rawOutput: string }>();

// Mock tmux-wrapper (not tmux.js) to avoid poisoning the global module cache
// for other test files that import real functions from ./tmux.js.
mock.module('./tmux-wrapper.js', () => ({
  executeTmux: async (cmd: string) => {
    // capturePaneContent calls: capture-pane -p ... -t '<paneId>' -S -<lines> -E -
    if (cmd.includes('capture-pane')) {
      const paneMatch = cmd.match(/-t '(%\d+)'/);
      const linesMatch = cmd.match(/-S -(\d+)/);
      const paneId = paneMatch ? paneMatch[1] : '';
      const lines = linesMatch ? Number.parseInt(linesMatch[1], 10) : 200;
      return mockCapturePaneContent(paneId, lines);
    }
    return '';
  },
  genieTmuxPrefix: () => ['-L', 'genie', '-f', '/dev/null'],
  genieTmuxCmd: (sub: string) => `tmux -L genie ${sub}`,
  // Passthrough matches the real implementation (issue #1223): the mock
  // must preserve behavior because Bun's mock.module is process-global,
  // so tmux-wrapper.test.ts can race and see this stub.
  prependEnvVars: (command: string, env?: Record<string, string>) => {
    if (!env || Object.keys(env).length === 0) return command;
    const envArgs = Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    return `env ${envArgs} ${command}`;
  },
}));

mock.module('./orchestrator/index.js', () => ({
  detectState: (output: string) => mockDetectState(output),
}));

function makeState(type: string) {
  return { type, confidence: 0.9, timestamp: Date.now(), rawOutput: '' };
}

describe('waitForAgentReady', () => {
  const savedEnv = process.env.GENIE_SPAWN_TIMEOUT_MS;

  beforeEach(() => {
    mockCapturePaneContent.mockReset();
    mockDetectState.mockReset();
    process.env.GENIE_SPAWN_TIMEOUT_MS = undefined;
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.GENIE_SPAWN_TIMEOUT_MS = savedEnv;
    } else {
      process.env.GENIE_SPAWN_TIMEOUT_MS = undefined;
    }
  });

  test('returns ready when pane shows idle state', async () => {
    mockCapturePaneContent.mockResolvedValue('> What would you like to do?');
    mockDetectState.mockReturnValue(makeState('idle'));

    const result = await waitForAgentReady('%5', { timeoutMs: 500, pollIntervalMs: 50 });

    expect(result.ready).toBe(true);
    expect(result.elapsedMs).toBeLessThan(500);
  });

  test('returns ready when pane shows tool_use state', async () => {
    mockCapturePaneContent.mockResolvedValue('tool_use: Read file.ts');
    mockDetectState.mockReturnValue(makeState('tool_use'));

    const result = await waitForAgentReady('%5', { timeoutMs: 500, pollIntervalMs: 50 });

    expect(result.ready).toBe(true);
    expect(result.elapsedMs).toBeLessThan(500);
  });

  test('times out when pane never becomes ready', async () => {
    mockCapturePaneContent.mockResolvedValue('loading...');
    mockDetectState.mockReturnValue(makeState('working'));

    const result = await waitForAgentReady('%5', { timeoutMs: 200, pollIntervalMs: 50 });

    expect(result.ready).toBe(false);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(200);
  });

  test('keeps polling when capturePaneContent throws', async () => {
    let callCount = 0;
    mockCapturePaneContent.mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) throw new Error('pane not found');
      return 'idle prompt >';
    });
    mockDetectState.mockReturnValue(makeState('idle'));

    const result = await waitForAgentReady('%5', { timeoutMs: 2000, pollIntervalMs: 50 });

    expect(result.ready).toBe(true);
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  test('keeps polling when pane content is empty', async () => {
    let callCount = 0;
    mockCapturePaneContent.mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) return '';
      return 'idle prompt >';
    });
    mockDetectState.mockReturnValue(makeState('idle'));

    const result = await waitForAgentReady('%5', { timeoutMs: 2000, pollIntervalMs: 50 });

    expect(result.ready).toBe(true);
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  test('transitions from working to idle', async () => {
    let callCount = 0;
    mockCapturePaneContent.mockResolvedValue('some output');
    mockDetectState.mockImplementation(() => {
      callCount++;
      if (callCount <= 3) return makeState('working');
      return makeState('idle');
    });

    const result = await waitForAgentReady('%5', { timeoutMs: 2000, pollIntervalMs: 50 });

    expect(result.ready).toBe(true);
    expect(callCount).toBeGreaterThanOrEqual(4);
  });

  test('respects GENIE_SPAWN_TIMEOUT_MS env var', async () => {
    process.env.GENIE_SPAWN_TIMEOUT_MS = '150';
    mockCapturePaneContent.mockResolvedValue('loading...');
    mockDetectState.mockReturnValue(makeState('working'));

    const result = await waitForAgentReady('%5', { pollIntervalMs: 50 });

    expect(result.ready).toBe(false);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(150);
    expect(result.elapsedMs).toBeLessThan(1000);
  });

  test('opts.timeoutMs overrides env var', async () => {
    process.env.GENIE_SPAWN_TIMEOUT_MS = '5000';
    mockCapturePaneContent.mockResolvedValue('loading...');
    mockDetectState.mockReturnValue(makeState('working'));

    const result = await waitForAgentReady('%5', { timeoutMs: 150, pollIntervalMs: 50 });

    expect(result.ready).toBe(false);
    expect(result.elapsedMs).toBeLessThan(1000);
  });

  test('passes correct pane ID and line count to capturePaneContent', async () => {
    mockCapturePaneContent.mockResolvedValue('idle');
    mockDetectState.mockReturnValue(makeState('idle'));

    await waitForAgentReady('%42', { timeoutMs: 500, pollIntervalMs: 50 });

    expect(mockCapturePaneContent).toHaveBeenCalledWith('%42', 50);
  });
});

// ============================================================================
// PG-Based Readiness Detection — waitForExecutorReady
// ============================================================================

describe('waitForExecutorReady', () => {
  // Save original deps for restore
  const origIsAvailable = _pgDeps.isAvailable;
  const origGetConnection = _pgDeps.getConnection;
  const origGetExecutor = _pgDeps.getExecutor;

  afterEach(() => {
    // Restore real deps
    _pgDeps.isAvailable = origIsAvailable;
    _pgDeps.getConnection = origGetConnection;
    _pgDeps.getExecutor = origGetExecutor;
  });

  test('returns ready immediately if executor already in running state', async () => {
    _pgDeps.isAvailable = async () => true;
    _pgDeps.getExecutor = async () => ({ id: 'exec-1', state: 'running' });

    const result = await waitForExecutorReady('exec-1', { timeoutMs: 500 });

    expect(result.ready).toBe(true);
    expect(result.elapsedMs).toBeLessThan(500);
  });

  test('returns ready immediately if executor already in idle state', async () => {
    _pgDeps.isAvailable = async () => true;
    _pgDeps.getExecutor = async () => ({ id: 'exec-1', state: 'idle' });

    const result = await waitForExecutorReady('exec-1', { timeoutMs: 500 });

    expect(result.ready).toBe(true);
    expect(result.elapsedMs).toBeLessThan(500);
  });

  test('returns not ready if PG is unavailable (graceful degradation)', async () => {
    _pgDeps.isAvailable = async () => false;

    const result = await waitForExecutorReady('exec-1', { timeoutMs: 500 });

    expect(result.ready).toBe(false);
    expect(result.elapsedMs).toBe(0);
  });

  test('times out if executor stays in spawning state', async () => {
    _pgDeps.isAvailable = async () => true;
    _pgDeps.getExecutor = async () => ({ id: 'exec-1', state: 'spawning' });
    _pgDeps.getConnection = async () => ({
      listen: async () => ({ unlisten: async () => {} }),
    });

    const result = await waitForExecutorReady('exec-1', { timeoutMs: 300 });

    expect(result.ready).toBe(false);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(300);
  });

  test('returns ready when executor transitions to running during poll', async () => {
    _pgDeps.isAvailable = async () => true;

    let callCount = 0;
    _pgDeps.getExecutor = async () => {
      callCount++;
      // First call (initial check): spawning
      // Second call (poll): running
      if (callCount <= 1) return { id: 'exec-1', state: 'spawning' };
      return { id: 'exec-1', state: 'running' };
    };
    _pgDeps.getConnection = async () => ({
      listen: async () => ({ unlisten: async () => {} }),
    });

    const result = await waitForExecutorReady('exec-1', { timeoutMs: 5000 });

    expect(result.ready).toBe(true);
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});
