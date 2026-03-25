/**
 * Regression tests for genie.tmux.conf
 *
 * Ensures status-bar click handling works for both windows (single-click)
 * and sessions (double-click on any status area).
 * See: https://github.com/automagik-dev/genie/issues/784
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CONF_PATH = resolve(import.meta.dirname, '../../scripts/tmux/genie.tmux.conf');
const conf = readFileSync(CONF_PATH, 'utf-8');

/** Return non-comment, non-empty lines that match a pattern. */
function activeLines(pattern: RegExp): string[] {
  return conf
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

  test('mouse is enabled globally', () => {
    const hits = activeLines(/set\s+-g\s+mouse\s+on/);
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
