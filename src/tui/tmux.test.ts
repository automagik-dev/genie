/**
 * Tests for tui/tmux.ts — attachTuiSession nested tmux handling.
 *
 * Run with: bun test src/tui/tmux.test.ts
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';

const mockSpawnSync = mock((..._args: unknown[]) => ({
  status: 0,
  stdout: '',
  stderr: '',
  pid: 0,
  signal: null,
  output: [],
}));

mock.module('node:child_process', () => ({
  spawnSync: mockSpawnSync,
  execSync: () => '/usr/bin/tmux',
}));

mock.module('../lib/ensure-tmux.js', () => ({
  tmuxBin: () => 'tmux',
}));

const { attachTuiSession } = await import('./tmux.js');

describe('attachTuiSession', () => {
  afterEach(() => {
    mockSpawnSync.mockClear();
    process.env.TMUX = undefined;
  });

  test('uses attach-session when TMUX is not set', () => {
    process.env.TMUX = undefined;
    attachTuiSession();

    const calls = mockSpawnSync.mock.calls;
    const lastCall = calls[calls.length - 1];
    const args = lastCall[1] as string[];
    expect(args).toContain('attach-session');
    expect(args).not.toContain('switch-client');
    expect(args).toContain('genie-tui');
  });

  test('uses switch-client when TMUX is set (inside another tmux session)', () => {
    process.env.TMUX = '/tmp/tmux-1000/default,12345,0';
    attachTuiSession();

    const calls = mockSpawnSync.mock.calls;
    const lastCall = calls[calls.length - 1];
    const args = lastCall[1] as string[];
    expect(args).toContain('switch-client');
    expect(args).not.toContain('attach-session');
    expect(args).toContain('genie-tui');
  });

  test('uses switch-client when TMUX contains genie-tui socket', () => {
    process.env.TMUX = '/tmp/tmux-1000/genie-tui,12345,0';
    attachTuiSession();

    const calls = mockSpawnSync.mock.calls;
    const lastCall = calls[calls.length - 1];
    const args = lastCall[1] as string[];
    expect(args).toContain('switch-client');
    expect(args).not.toContain('attach-session');
  });

  test('passes inherit stdio for terminal interaction', () => {
    process.env.TMUX = undefined;
    attachTuiSession();

    const calls = mockSpawnSync.mock.calls;
    const lastCall = calls[calls.length - 1];
    const options = lastCall[2] as { stdio: string };
    expect(options.stdio).toBe('inherit');
  });
});
