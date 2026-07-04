/**
 * Tests for the `genie install` post-install finisher.
 *
 * The v4 cleanup engine is covered by legacy-v4.test.ts; here we only prove
 * the command wiring: cleanup runs by default and --skip-v4-cleanup opts out.
 * The runner is always injected — calling the real cleanup from a test would
 * target the actual home directory.
 */

import { describe, expect, test } from 'bun:test';
import { installCommand } from './install.js';
import type { cleanupV4 } from './legacy-v4.js';

function makeCleanupSpy(): { runner: typeof cleanupV4; calls: () => number } {
  let count = 0;
  const runner: typeof cleanupV4 = () => {
    count += 1;
    return {
      report: { rulesFile: { path: '/fixture', status: 'absent' }, cacheDirs: [], hasRelics: false },
      actions: [],
      backupDir: null,
      logFile: null,
      noOp: true,
    };
  };
  return { runner, calls: () => count };
}

describe('installCommand', () => {
  test('runs the v4 cleanup by default', () => {
    const spy = makeCleanupSpy();
    installCommand({}, spy.runner);
    expect(spy.calls()).toBe(1);
  });

  test('--skip-v4-cleanup opts out of the cleanup', () => {
    const spy = makeCleanupSpy();
    installCommand({ skipV4Cleanup: true }, spy.runner);
    expect(spy.calls()).toBe(0);
  });
});
