import { beforeEach, describe, expect, mock, test } from 'bun:test';

const mockExecuteTmux = mock(async (_cmd: string) => '');

mock.module('./tmux-wrapper.js', () => ({
  executeTmux: mockExecuteTmux,
  genieTmuxPrefix: () => ['-L', 'genie'],
  genieTmuxCmd: (sub: string) => `tmux -L genie ${sub}`,
}));

const { isPaneAlive, TmuxUnreachableError } = await import('./tmux.js');

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
