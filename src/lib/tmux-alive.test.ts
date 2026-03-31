import { beforeEach, describe, expect, mock, test } from 'bun:test';

const mockExecuteTmux = mock(async (_cmd: string) => '');

mock.module('./tmux-wrapper.js', () => ({
  executeTmux: mockExecuteTmux,
  genieTmuxPrefix: () => ['-L', 'genie'],
  genieTmuxCmd: (sub: string) => `tmux -L genie ${sub}`,
}));

const { isPaneAlive } = await import('./tmux.js');

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

  test('returns false when the tmux server is unavailable', async () => {
    mockExecuteTmux.mockRejectedValueOnce(new Error('no server running'));
    expect(await isPaneAlive('%2')).toBe(false);
  });
});
