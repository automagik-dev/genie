/**
 * Tests for spawn-command.ts - buildSpawnCommand function
 * Run with: bun test src/lib/spawn-command.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { type WorkerProfile, buildSpawnCommand } from './spawn-command.js';

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

  test('includes BEADS_DIR env prefix when provided', () => {
    const profile = makeProfile({
      launcher: 'claude',
      claudeArgs: ['--dangerously-skip-permissions'],
    });
    const command = buildSpawnCommand(profile, {
      sessionId: 'abc-123',
      beadsDir: '/home/genie/workspace/project/.genie',
    });
    expect(command).toBe(
      "BEADS_DIR='/home/genie/workspace/project/.genie' claude '--dangerously-skip-permissions' --session-id 'abc-123'",
    );
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
    // Session IDs should be quoted to handle any special chars
    const command = buildSpawnCommand(profile, { sessionId: "abc'def" });
    // Should escape single quotes in the session ID
    expect(command).toBe("claude --session-id 'abc'\\''def'");
  });

  test('handles beadsDir with spaces', () => {
    const profile = makeProfile({
      launcher: 'claude',
      claudeArgs: [],
    });
    const command = buildSpawnCommand(profile, {
      sessionId: 'test-123',
      beadsDir: '/path/with spaces/.genie',
    });
    expect(command).toBe("BEADS_DIR='/path/with spaces/.genie' claude --session-id 'test-123'");
  });

  test('sessionId takes precedence if both sessionId and resume provided', () => {
    const profile = makeProfile({
      launcher: 'claude',
      claudeArgs: [],
    });
    // If both are somehow provided, sessionId should take precedence
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
    // The malicious payload should be safely escaped within single quotes
    // Single quotes inside are escaped as '\'' (end quote, backslash-quote, start quote)
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
    // Backticks should be safely enclosed in single quotes (no interpretation)
    expect(command).toBe("claude '--prompt' '`id`' --session-id 'test-abc'");
  });

  test('escapes dollar signs in claudeArgs', () => {
    const profile = makeProfile({
      launcher: 'claude',
      claudeArgs: ['--env', '$HOME'],
    });
    const command = buildSpawnCommand(profile, { sessionId: 'test-def' });
    // Dollar signs should be safely enclosed in single quotes (no interpretation)
    expect(command).toBe("claude '--env' '$HOME' --session-id 'test-def'");
  });

  test('escapes newlines in claudeArgs', () => {
    const profile = makeProfile({
      launcher: 'claude',
      claudeArgs: ['--prompt', 'hello\nworld'],
    });
    const command = buildSpawnCommand(profile, { sessionId: 'test-jkl' });
    // Newlines should be safely enclosed in single quotes
    expect(command).toBe("claude '--prompt' 'hello\nworld' --session-id 'test-jkl'");
  });
});
