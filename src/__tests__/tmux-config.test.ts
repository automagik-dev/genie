/**
 * Regression tests for genie.tmux.conf
 *
 * Ensures status-bar click handling relies on tmux 3.3+ native range=
 * dispatch and is not overridden by custom MouseDown1Status bindings.
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
  test('must NOT bind MouseDown1Status (breaks native range=session dispatch)', () => {
    const hits = activeLines(/MouseDown1Status\b/);
    expect(hits).toEqual([]);
  });

  test('status-format[0] uses range=window for window tabs', () => {
    expect(conf).toContain('range=window|');
  });

  test('status-format[1] uses range=session for agent sessions', () => {
    expect(conf).toContain('range=session|');
  });

  test('mouse is enabled globally', () => {
    const hits = activeLines(/set\s+-g\s+mouse\s+on/);
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  test('DoubleClick1Pane binding still exists', () => {
    const hits = activeLines(/DoubleClick1Pane/);
    expect(hits.length).toBe(1);
  });

  test('DoubleClick1Status binding still exists', () => {
    const hits = activeLines(/DoubleClick1Status/);
    expect(hits.length).toBe(1);
  });
});
