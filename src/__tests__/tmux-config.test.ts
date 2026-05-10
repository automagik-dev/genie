/**
 * Regression tests for genie.tmux.conf and tui-tmux.conf
 *
 * Ensures status-bar click handling works for both windows (single-click)
 * and sessions (double-click on any status area).
 * See: https://github.com/automagik-dev/genie/issues/784
 *
 * v5: terminal owns the selection lifecycle. tmux's automatic OSC 52
 * emit is disabled — drag highlights via terminal-native selection,
 * Cmd+C copies via the terminal's normal hotkey.
 * See: wish/tui-native-selection
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CONF_PATH = resolve(import.meta.dirname, '../../scripts/tmux/genie.tmux.conf');
const conf = readFileSync(CONF_PATH, 'utf-8');

const TUI_CONF_PATH = resolve(import.meta.dirname, '../../scripts/tmux/tui-tmux.conf');
const tuiConf = readFileSync(TUI_CONF_PATH, 'utf-8');

// Color/format directives now live in the generated theme file (sourced by
// both confs above). Tests that target color or status-format[N] content
// must consult the generated file rather than the now-color-free configs.
const THEME_PATH = resolve(import.meta.dirname, '../../scripts/tmux/.generated.theme.conf');
const theme = readFileSync(THEME_PATH, 'utf-8');
const confAndTheme = `${conf}\n${theme}`;

/** Return non-comment, non-empty lines that match a pattern. */
function activeLines(pattern: RegExp): string[] {
  return confAndTheme
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#') && l.trim() !== '')
    .filter((l) => pattern.test(l));
}

describe('tmux config — status bar click handling', () => {
  test('MouseDown1Status binds select-window for window clicking', () => {
    const hits = activeLines(/bind\s+-n\s+MouseDown1Status\s+select-window/);
    expect(hits.length).toBe(1);
  });

  test('MouseDown1StatusDefault binds select-window for gap clicking', () => {
    const hits = activeLines(/bind\s+-n\s+MouseDown1StatusDefault\s+select-window/);
    expect(hits.length).toBe(1);
  });

  test('MouseDown1StatusRight opens session picker', () => {
    const hits = activeLines(/bind\s+-n\s+MouseDown1StatusRight\s+choose-tree/);
    expect(hits.length).toBe(1);
  });

  test('status-format[0] uses range=window for window tabs', () => {
    const hits = activeLines(/range=window\|/);
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  test('status-format[1] uses range=session for agent sessions', () => {
    const hits = activeLines(/range=session\|/);
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  test('mouse is conditionally enabled (GENIE_TMUX_MOUSE opt-out)', () => {
    const hits = activeLines(/GENIE_TMUX_MOUSE.*set\s+-g\s+mouse\s+on/);
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  test('DoubleClick1Pane binding exists', () => {
    const hits = activeLines(/DoubleClick1Pane/);
    expect(hits.length).toBe(1);
  });

  test('double-click opens session picker on all status areas', () => {
    expect(activeLines(/DoubleClick1Status\b/).length).toBe(1);
    expect(activeLines(/DoubleClick1StatusDefault/).length).toBe(1);
    expect(activeLines(/DoubleClick1StatusLeft/).length).toBe(1);
    expect(activeLines(/DoubleClick1StatusRight/).length).toBe(1);
  });
});

/** Return non-comment, non-empty lines from a config that match a pattern. */
function activeLinesIn(config: string, pattern: RegExp): string[] {
  return config
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#') && l.trim() !== '')
    .filter((l) => pattern.test(l));
}

describe('tmux config — terminal-native selection (v5, wish/tui-native-selection)', () => {
  test('genie.tmux.conf uses set-clipboard off (terminal owns clipboard)', () => {
    const hits = activeLinesIn(conf, /set\s+-g\s+set-clipboard\s+off/);
    expect(hits.length).toBe(1);
    // Must NOT have "set-clipboard external" or "set-clipboard on"
    const bad = activeLinesIn(conf, /set\s+-g\s+set-clipboard\s+(external|on)\b/);
    expect(bad.length).toBe(0);
  });

  test('genie.tmux.conf has allow-passthrough on (kept — other tools use DCS passthrough)', () => {
    const hits = activeLinesIn(conf, /set\s+-g\s+allow-passthrough\s+on/);
    expect(hits.length).toBe(1);
  });

  test('genie.tmux.conf does NOT emit OSC 52 via terminal-overrides Ms cap', () => {
    const hits = activeLinesIn(conf, /terminal-overrides.*Ms=/);
    expect(hits.length).toBe(0);
  });

  test('genie.tmux.conf uses copy-selection-and-cancel (no osc52-copy.sh pipe)', () => {
    const good = activeLinesIn(conf, /copy-selection-and-cancel/);
    expect(good.length).toBeGreaterThanOrEqual(1);
    const bad = activeLinesIn(conf, /copy-pipe-and-cancel|osc52-copy\.sh/);
    expect(bad.length).toBe(0);
  });

  test('tui-tmux.conf uses set-clipboard off (terminal owns clipboard)', () => {
    const hits = activeLinesIn(tuiConf, /set\s+-g\s+set-clipboard\s+off/);
    expect(hits.length).toBe(1);
    const bad = activeLinesIn(tuiConf, /set\s+-g\s+set-clipboard\s+(external|on)\b/);
    expect(bad.length).toBe(0);
  });

  test('tui-tmux.conf does NOT emit OSC 52 via terminal-overrides Ms cap', () => {
    const hits = activeLinesIn(tuiConf, /terminal-overrides.*Ms=/);
    expect(hits.length).toBe(0);
  });

  test('tui-tmux.conf uses copy-selection-and-cancel (no osc52-copy.sh pipe)', () => {
    const good = activeLinesIn(tuiConf, /copy-selection-and-cancel/);
    expect(good.length).toBeGreaterThanOrEqual(1);
    const bad = activeLinesIn(tuiConf, /copy-pipe-and-cancel|osc52-copy\.sh/);
    expect(bad.length).toBe(0);
  });

  test('tui-tmux.conf forwards click events to OpenTUI', () => {
    expect(activeLinesIn(tuiConf, /MouseDown1Pane.*send-keys -M/).length).toBe(1);
    expect(activeLinesIn(tuiConf, /MouseUp1Pane\s+if-shell.*send-keys -M/).length).toBe(1);
    expect(activeLinesIn(tuiConf, /WheelDownPane\s+if-shell.*send-keys -M/).length).toBe(1);
  });

  test('osc52-copy.sh helper script remains on disk (D7 — kept for ad-hoc operator use)', () => {
    const scriptPath = resolve(import.meta.dirname, '../../scripts/tmux/osc52-copy.sh');
    expect(existsSync(scriptPath)).toBe(true);
  });
});
