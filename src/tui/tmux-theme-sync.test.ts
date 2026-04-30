import { describe, expect, test } from 'bun:test';
import { buildTuiTmuxThemeCommands, syncTuiTmuxTheme } from './tmux-theme-sync.js';

describe('tmux theme sync', () => {
  test('builds light-mode tmux commands from OpenTUI terminal colors', () => {
    const commands = buildTuiTmuxThemeCommands({
      mode: 'light',
      terminalForeground: '#111111',
      terminalBackground: '#eeeeee',
    });
    const joined = commands.join(' ');

    expect(joined).toContain('set-environment -g GENIE_TUI_THEME_MODE light');
    expect(joined).toContain('set-environment -g GENIE_TUI_TERMINAL_FG #111111');
    expect(joined).toContain('set-environment -g GENIE_TUI_TERMINAL_BG #eeeeee');
    expect(joined).toContain('set-option -g status-style bg=#eeeeee,fg=#111111');
    expect(joined).toContain('set-option -g pane-active-border-style fg=#2f7a62');
  });

  test('keeps the Genie dark palette for dark terminals', () => {
    const commands = buildTuiTmuxThemeCommands({
      mode: 'dark',
      terminalForeground: '#ffffff',
      terminalBackground: '#000000',
    });
    const joined = commands.join(' ');

    expect(joined).toContain('set-environment -g GENIE_TUI_THEME_MODE dark');
    expect(joined).toContain('set-option -g status-style bg=#0a1d2a,fg=#c9cfd4');
    expect(joined).toContain('set-option -g pane-active-border-style fg=#7fc8a9');
  });

  test('applies commands through one bounded tmux invocation', () => {
    const calls: unknown[][] = [];
    const ok = syncTuiTmuxTheme(
      { mode: 'light', terminalForeground: '#111111', terminalBackground: '#eeeeee' },
      {
        tmuxBin: '/usr/bin/tmux',
        socketName: 'test-tui',
        configPath: '/tmp/tui-tmux.conf',
        timeoutMs: 123,
        spawnSync: ((command: string, args: string[], options: unknown) => {
          calls.push([command, args, options]);
          return { status: 0 };
        }) as never,
      },
    );

    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('/usr/bin/tmux');
    const args = calls[0][1] as string[];
    expect(args.slice(0, 5)).toEqual(['-L', 'test-tui', '-f', '/tmp/tui-tmux.conf', 'set-environment']);
    expect(args).toContain('GENIE_TUI_THEME_MODE');
    expect(calls[0][2]).toEqual({ stdio: 'ignore', timeout: 123 });
  });
});
