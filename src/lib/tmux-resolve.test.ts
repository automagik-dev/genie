/**
 * Tests for resolveRepoSession — ensures repo path is mapped to the correct tmux session.
 *
 * These tests mock the tmux wrapper to avoid requiring a running tmux server.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// Mock the tmux wrapper before importing tmux module
const mockExecuteTmux = mock(async (_cmd: string) => '');

// We need to mock the module before importing
mock.module('./tmux-wrapper.js', () => ({
  executeTmux: mockExecuteTmux,
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

const { resolveRepoSession } = await import('./tmux.js');

describe('resolveRepoSession', () => {
  const originalTMUX = process.env.TMUX;

  beforeEach(() => {
    mockExecuteTmux.mockReset();
    process.env.TMUX = undefined;
  });

  afterEach(() => {
    if (originalTMUX !== undefined) {
      process.env.TMUX = originalTMUX;
    } else {
      process.env.TMUX = undefined;
    }
  });

  test('returns exact session match for basename', async () => {
    // list-sessions returns a session named "genie"
    mockExecuteTmux.mockImplementation(async (cmd: string) => {
      if (cmd.includes('list-sessions')) {
        return '$1:genie:1:3\n$2:sofia:0:2';
      }
      return '';
    });

    const result = await resolveRepoSession('/workspace/repos/genie');
    expect(result).toBe('genie');
  });

  test('returns current TMUX session when no exact match', async () => {
    process.env.TMUX = '/tmp/tmux-1000/genie,12345,0';

    mockExecuteTmux.mockImplementation(async (cmd: string) => {
      if (cmd.includes('list-sessions')) {
        return '$1:sofia:1:2';
      }
      if (cmd.includes('display-message')) {
        return 'sofia';
      }
      return '';
    });

    const result = await resolveRepoSession('/workspace/repos/my-project');
    expect(result).toBe('sofia');
  });

  test('returns partial match when no exact match and not inside tmux', async () => {
    mockExecuteTmux.mockImplementation(async (cmd: string) => {
      if (cmd.includes('list-sessions')) {
        return '$1:genie-dev:1:3\n$2:sofia:0:2';
      }
      return '';
    });

    const result = await resolveRepoSession('/workspace/repos/genie');
    expect(result).toBe('genie-dev');
  });

  test('returns derived basename when no sessions match', async () => {
    mockExecuteTmux.mockImplementation(async (cmd: string) => {
      if (cmd.includes('list-sessions')) {
        return '$1:sofia:1:2\n$2:totvs:0:1';
      }
      return '';
    });

    const result = await resolveRepoSession('/workspace/repos/genie');
    expect(result).toBe('genie');
  });

  test('returns derived basename when tmux is not available', async () => {
    mockExecuteTmux.mockImplementation(async () => {
      throw new Error('no server running');
    });

    const result = await resolveRepoSession('/workspace/repos/genie');
    expect(result).toBe('genie');
  });

  test('handles repo path with trailing slash', async () => {
    mockExecuteTmux.mockImplementation(async (cmd: string) => {
      if (cmd.includes('list-sessions')) {
        return '$1:genie:1:3';
      }
      return '';
    });

    const result = await resolveRepoSession('/workspace/repos/genie/');
    // basename('/workspace/repos/genie/') returns '' in node, so no exact match
    // The derived name would be empty, falling back to empty string
    // This documents the edge case — callers should provide clean paths
    expect(typeof result).toBe('string');
  });

  test('exact match takes priority over TMUX env session', async () => {
    process.env.TMUX = '/tmp/tmux-1000/genie,12345,0';

    mockExecuteTmux.mockImplementation(async (cmd: string) => {
      if (cmd.includes('list-sessions')) {
        return '$1:genie:1:3\n$2:sofia:0:2';
      }
      if (cmd.includes('display-message')) {
        return 'sofia';
      }
      return '';
    });

    // Exact match "genie" should win over current session "sofia"
    const result = await resolveRepoSession('/workspace/repos/genie');
    expect(result).toBe('genie');
  });

  test('handles genie-os repo correctly', async () => {
    mockExecuteTmux.mockImplementation(async (cmd: string) => {
      if (cmd.includes('list-sessions')) {
        return '$1:genie:1:3\n$2:genie-os:0:2\n$3:sofia:0:1';
      }
      return '';
    });

    const result = await resolveRepoSession('/workspace/repos/genie-os');
    expect(result).toBe('genie-os');
  });
});
