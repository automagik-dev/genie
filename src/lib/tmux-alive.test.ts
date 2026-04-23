import { beforeEach, describe, expect, mock, test } from 'bun:test';

const mockExecuteTmux = mock(async (_cmd: string) => '');
// execSync is injected per-test rather than mocked via mock.module('node:child_process', ...).
// Module-level mocking of node:child_process is process-global and leaks into any test
// file that runs after this one (audit-context, freshness, pg resolveRepoPath all use execSync).
const mockExecSync = mock((_cmd: string, _opts?: object): string => '');

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

const { isPaneAlive, isPaneProcessRunning, TmuxUnreachableError } = await import('./tmux.js');

describe('isPaneAlive', () => {
  beforeEach(() => {
    mockExecuteTmux.mockReset();
  });

  test('returns false for invalid pane ids', async () => {
    expect(await isPaneAlive('')).toBe(false);
    expect(await isPaneAlive('inline')).toBe(false);
    expect(await isPaneAlive('pane-1')).toBe(false);
  });

  test('returns true when tmux reports a live pane', async () => {
    mockExecuteTmux.mockResolvedValueOnce('0');
    expect(await isPaneAlive('%2')).toBe(true);
    expect(mockExecuteTmux).toHaveBeenCalledWith("display-message -t '%2' -p '#{pane_dead}'");
  });

  test('returns false when tmux reports a dead pane', async () => {
    mockExecuteTmux.mockResolvedValueOnce('1');
    expect(await isPaneAlive('%2')).toBe(false);
  });

  test('returns false when tmux returns empty string (non-existent pane in tmux 3.5+)', async () => {
    mockExecuteTmux.mockResolvedValueOnce('');
    expect(await isPaneAlive('%2')).toBe(false);
  });

  test('returns false when pane is not found (tmux reachable)', async () => {
    mockExecuteTmux.mockRejectedValueOnce(new Error("can't find pane %99"));
    expect(await isPaneAlive('%99')).toBe(false);
  });

  test('throws TmuxUnreachableError when tmux server is down', async () => {
    mockExecuteTmux.mockRejectedValueOnce(new Error('no server running'));
    await expect(isPaneAlive('%2')).rejects.toBeInstanceOf(TmuxUnreachableError);
  });

  test('throws TmuxUnreachableError on server exited', async () => {
    mockExecuteTmux.mockRejectedValueOnce(new Error('server exited unexpectedly'));
    await expect(isPaneAlive('%2')).rejects.toBeInstanceOf(TmuxUnreachableError);
  });

  test('throws TmuxUnreachableError on connection error', async () => {
    mockExecuteTmux.mockRejectedValueOnce(new Error('error connecting to /tmp/tmux-1000/default'));
    await expect(isPaneAlive('%2')).rejects.toBeInstanceOf(TmuxUnreachableError);
  });
});

describe('isPaneProcessRunning', () => {
  beforeEach(() => {
    mockExecuteTmux.mockReset();
    mockExecSync.mockReset();
  });

  test('returns false for invalid pane ids', async () => {
    expect(await isPaneProcessRunning('', 'claude', mockExecSync)).toBe(false);
    expect(await isPaneProcessRunning('inline', 'claude', mockExecSync)).toBe(false);
    expect(await isPaneProcessRunning('pane-1', 'claude', mockExecSync)).toBe(false);
  });

  test('returns false when pane pid is empty', async () => {
    mockExecuteTmux.mockResolvedValueOnce('');
    expect(await isPaneProcessRunning('%2', 'claude', mockExecSync)).toBe(false);
  });

  test('returns false when pane pid is non-numeric', async () => {
    mockExecuteTmux.mockResolvedValueOnce('notanumber');
    expect(await isPaneProcessRunning('%2', 'claude', mockExecSync)).toBe(false);
  });

  test('returns true when target process found in descendants', async () => {
    mockExecuteTmux.mockResolvedValueOnce('12345');
    mockExecSync.mockReturnValueOnce('12346 claude --session-id abc\n');
    expect(await isPaneProcessRunning('%2', 'claude', mockExecSync)).toBe(true);
  });

  test('returns false when target process not in descendants', async () => {
    mockExecuteTmux.mockResolvedValueOnce('12345');
    mockExecSync.mockReturnValueOnce('12346 bash\n12347 vim\n');
    expect(await isPaneProcessRunning('%2', 'claude', mockExecSync)).toBe(false);
  });

  test('matches process name case-insensitively', async () => {
    mockExecuteTmux.mockResolvedValueOnce('12345');
    mockExecSync.mockReturnValueOnce('12346 Claude --dangerously-skip-permissions\n');
    expect(await isPaneProcessRunning('%2', 'claude', mockExecSync)).toBe(true);
  });

  test('returns false when tmux command fails', async () => {
    mockExecuteTmux.mockRejectedValueOnce(new Error("can't find pane %99"));
    expect(await isPaneProcessRunning('%99', 'claude', mockExecSync)).toBe(false);
  });

  test('returns false when execSync throws', async () => {
    mockExecuteTmux.mockResolvedValueOnce('12345');
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('command failed');
    });
    expect(await isPaneProcessRunning('%2', 'claude', mockExecSync)).toBe(false);
  });
});
