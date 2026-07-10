/**
 * Tests for the `genie install` post-install finisher.
 *
 * The v4 cleanup engine is covered by legacy-v4.test.ts and the agent-sync
 * engine by agent-sync.test.ts; here we only prove the command wiring: v4
 * cleanup is gated by --skip-v4-cleanup, while the layout-normalize and
 * agent-sync steps always run. Every seam is injected — calling the real
 * cleanup/normalize/sync from a test would target the actual home directory.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installCommand, normalizeAuxLayout } from './install.js';
import type { cleanupV4 } from './legacy-v4.js';

function makeCleanupSpy(): { runner: typeof cleanupV4; calls: () => number } {
  let count = 0;
  const runner: typeof cleanupV4 = () => {
    count += 1;
    return {
      report: { rulesFile: { path: '/fixture', status: 'absent' }, cacheDirs: [], hasRelics: false },
      homeResidue: [],
      actions: [],
      backupDir: null,
      logFile: null,
      noOp: true,
    };
  };
  return { runner, calls: () => count };
}

describe('installCommand', () => {
  test('runs v4 cleanup + layout normalize + agent sync by default', () => {
    const spy = makeCleanupSpy();
    let normalizeCalls = 0;
    let syncCalls = 0;
    installCommand(
      {},
      spy.runner,
      () => {
        normalizeCalls += 1;
      },
      () => {
        syncCalls += 1;
      },
    );
    expect(spy.calls()).toBe(1);
    expect(normalizeCalls).toBe(1);
    expect(syncCalls).toBe(1);
  });

  test('--skip-v4-cleanup skips ONLY the cleanup; normalize + sync still run', () => {
    const spy = makeCleanupSpy();
    let normalizeCalls = 0;
    let syncCalls = 0;
    installCommand(
      { skipV4Cleanup: true },
      spy.runner,
      () => {
        normalizeCalls += 1;
      },
      () => {
        syncCalls += 1;
      },
    );
    expect(spy.calls()).toBe(0);
    expect(normalizeCalls).toBe(1);
    expect(syncCalls).toBe(1);
  });
});

describe('normalizeAuxLayout', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'genie-normalize-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('moves bin/<dir> to the canonical <dir> when the target is absent', () => {
    mkdirSync(join(home, 'bin', 'plugins', 'genie'), { recursive: true });
    normalizeAuxLayout(home);
    expect(existsSync(join(home, 'plugins', 'genie'))).toBe(true);
    expect(existsSync(join(home, 'bin', 'plugins'))).toBe(false);
  });

  test('leaves the bin/ copy untouched when the canonical target already exists', () => {
    mkdirSync(join(home, 'bin', 'skills'), { recursive: true });
    mkdirSync(join(home, 'skills', 'existing'), { recursive: true });
    normalizeAuxLayout(home);
    expect(existsSync(join(home, 'bin', 'skills'))).toBe(true);
    expect(existsSync(join(home, 'skills', 'existing'))).toBe(true);
  });

  test('is a non-throwing no-op when neither layout is present', () => {
    expect(() => normalizeAuxLayout(home)).not.toThrow();
    expect(existsSync(join(home, 'plugins'))).toBe(false);
  });
});
