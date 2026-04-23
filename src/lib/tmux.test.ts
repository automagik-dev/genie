/**
 * Tests for tmux.ts — session creation atomicity and retry logic.
 *
 * Run with: bun test src/lib/tmux.test.ts
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';

const mockExecuteTmux = mock(async (_cmd: string) => '');

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

// Must import after mock.module
const { ensureTeamWindow, TmuxUnreachableError } = await import('./tmux.js');

/** Standard mock responses for common tmux commands */
function defaultTmuxResponse(cmd: string, overrides?: Record<string, string | (() => string)>): string {
  for (const [key, val] of Object.entries(overrides ?? {})) {
    if (cmd.includes(key)) return typeof val === 'function' ? val() : val;
  }
  if (cmd.includes('list-windows')) return '@1:my-team:0:1';
  if (cmd.includes('list-panes')) return '%0:pane-title:1';
  if (cmd.includes('set-window-option') || cmd.includes('set-hook')) return '';
  return '';
}

describe('ensureTeamWindow', () => {
  beforeEach(() => {
    mockExecuteTmux.mockReset();
  });

  test('creates session atomically — handles duplicate session gracefully', async () => {
    let newSessionCalls = 0;
    mockExecuteTmux.mockImplementation(async (cmd: string) => {
      if (cmd.includes('new-session')) {
        newSessionCalls++;
        throw new Error('duplicate session: test-session');
      }
      return defaultTmuxResponse(cmd);
    });

    const result = await ensureTeamWindow('test-session', 'my-team');
    expect(newSessionCalls).toBe(1);
    expect(result.created).toBe(false);
    expect(result.windowName).toBe('my-team');
  });

  test('retries on tmux server unreachable with backoff', async () => {
    let attempts = 0;
    mockExecuteTmux.mockImplementation(async (cmd: string) => {
      if (cmd.includes('new-session')) {
        attempts++;
        if (attempts <= 2) throw new Error('no server running on /tmp/tmux-1000/default');
        return '';
      }
      return defaultTmuxResponse(cmd);
    });

    const result = await ensureTeamWindow('test-session', 'my-team');
    expect(attempts).toBe(3);
    expect(result.created).toBe(false);
  });

  test('gives up after max retries on persistent tmux server failure', async () => {
    mockExecuteTmux.mockImplementation(async (cmd: string) => {
      if (cmd.includes('new-session')) throw new Error('no server running on /tmp/tmux-1000/default');
      return '';
    });

    await expect(ensureTeamWindow('test-session', 'my-team')).rejects.toThrow('no server running');
  });

  test('does not retry on non-server errors', async () => {
    let attempts = 0;
    mockExecuteTmux.mockImplementation(async (cmd: string) => {
      if (cmd.includes('new-session')) {
        attempts++;
        throw new Error('some other tmux error');
      }
      return '';
    });

    await expect(ensureTeamWindow('test-session', 'my-team')).rejects.toThrow('some other tmux error');
    expect(attempts).toBe(1);
  });

  test('creates new window when none exists', async () => {
    mockExecuteTmux.mockImplementation(async (cmd: string) =>
      defaultTmuxResponse(cmd, {
        'new-session': '',
        'list-windows': '',
        'new-window': '@2:1',
        'list-panes': '%1:pane-title:1',
      }),
    );

    const result = await ensureTeamWindow('test-session', 'new-team');
    expect(result.created).toBe(true);
    expect(result.windowName).toBe('new-team');
  });

  test('concurrent calls: both succeed when one gets duplicate session', async () => {
    let sessionCreated = false;
    mockExecuteTmux.mockImplementation(async (cmd: string) => {
      if (cmd.includes('new-session')) {
        if (sessionCreated) throw new Error('duplicate session: test-session');
        sessionCreated = true;
        return '';
      }
      return defaultTmuxResponse(cmd, { 'list-windows': '@1:team-a:0:1' });
    });

    const [result1, result2] = await Promise.allSettled([
      ensureTeamWindow('test-session', 'team-a'),
      ensureTeamWindow('test-session', 'team-a'),
    ]);

    expect(result1.status).toBe('fulfilled');
    expect(result2.status).toBe('fulfilled');
  });
});

describe('TmuxUnreachableError', () => {
  test('is an instance of Error', () => {
    const err = new TmuxUnreachableError('no server running');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TmuxUnreachableError);
    expect(err.name).toBe('TmuxUnreachableError');
    expect(err.message).toBe('no server running');
  });
});
