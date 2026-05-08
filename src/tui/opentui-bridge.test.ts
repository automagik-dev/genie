import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { CliRenderer, GetPaletteOptions, TerminalColors, ThemeMode } from '@opentui/core';
import { installOpenTui20Bridge } from './opentui-bridge.js';
import type { TuiTmuxThemeSnapshot } from './tmux-theme-sync.js';

class FakeRenderer extends EventEmitter {
  themeMode: ThemeMode | null = null;
  waitResult: Promise<ThemeMode | null> = new Promise(() => {});
  paletteResult: Promise<TerminalColors> = new Promise(() => {});
  paletteOptions: GetPaletteOptions[] = [];

  waitForThemeMode(_timeoutMs?: number): Promise<ThemeMode | null> {
    return this.waitResult;
  }

  getPalette(options?: GetPaletteOptions): Promise<TerminalColors> {
    if (options) this.paletteOptions.push(options);
    return this.paletteResult;
  }
}

function terminalColors(defaultForeground: string | null, defaultBackground: string | null): TerminalColors {
  return {
    palette: [],
    defaultForeground,
    defaultBackground,
    cursorColor: null,
    mouseForeground: null,
    mouseBackground: null,
    tekForeground: null,
    tekBackground: null,
    highlightBackground: null,
    highlightForeground: null,
  };
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('installOpenTui20Bridge', () => {
  test('can disable tmux theme sync with an env flag', async () => {
    const renderer = new FakeRenderer();
    const calls: TuiTmuxThemeSnapshot[] = [];

    installOpenTui20Bridge(renderer as unknown as CliRenderer, {
      env: { GENIE_TUI_TMUX_THEME_SYNC: '0' },
      syncTheme: (snapshot) => {
        calls.push(snapshot);
        return true;
      },
    });

    renderer.emit('theme_mode', 'light');
    await flushPromises();

    expect(calls).toHaveLength(0);
    expect(renderer.paletteOptions).toHaveLength(0);
  });

  test('syncs theme_mode events and unsubscribes on cleanup', () => {
    const renderer = new FakeRenderer();
    const calls: TuiTmuxThemeSnapshot[] = [];
    const cleanup = installOpenTui20Bridge(renderer as unknown as CliRenderer, {
      env: { GENIE_TUI_TMUX_THEME_SYNC_TIMEOUT_MS: '99' },
      syncTheme: (snapshot, options) => {
        calls.push({ ...snapshot, terminalForeground: String(options.timeoutMs) });
        return true;
      },
    });

    renderer.emit('theme_mode', 'light');
    cleanup();
    renderer.emit('theme_mode', 'dark');

    expect(calls).toEqual([{ mode: 'light', terminalForeground: '99', terminalBackground: undefined }]);
  });

  test('queries the OpenTUI 0.2 palette path with a small bounded request', async () => {
    const renderer = new FakeRenderer();
    renderer.waitResult = Promise.resolve(null);
    renderer.paletteResult = Promise.resolve(terminalColors('#111111', '#eeeeee'));
    const calls: TuiTmuxThemeSnapshot[] = [];

    installOpenTui20Bridge(renderer as unknown as CliRenderer, {
      syncTheme: (snapshot) => {
        calls.push(snapshot);
        return true;
      },
    });
    await flushPromises();

    expect(renderer.paletteOptions).toEqual([{ size: 16, timeout: 700 }]);
    expect(calls).toEqual([{ mode: 'light', terminalForeground: '#111111', terminalBackground: '#eeeeee' }]);
  });

  test('deduplicates repeated mode-only snapshots', async () => {
    const renderer = new FakeRenderer();
    renderer.themeMode = 'dark';
    renderer.waitResult = Promise.resolve('dark');
    const calls: TuiTmuxThemeSnapshot[] = [];

    installOpenTui20Bridge(renderer as unknown as CliRenderer, {
      syncTheme: (snapshot) => {
        calls.push(snapshot);
        return true;
      },
    });
    await flushPromises();

    expect(calls).toEqual([{ mode: 'dark', terminalForeground: undefined, terminalBackground: undefined }]);
  });
});
