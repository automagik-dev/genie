import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkForUpdates, compareVersions } from './brain.js';

/**
 * Tests for the cache-only checkForUpdates function.
 *
 * checkForUpdates reads a JSON cache file synchronously.
 * It never makes network calls and never throws.
 *
 * We use a temp directory so tests never touch the real ~/.genie/
 * and work in CI without permission issues.
 */

describe('checkForUpdates', () => {
  let tempDir: string;
  let cachePath: string;

  beforeAll(() => {
    tempDir = join(tmpdir(), `brain-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    cachePath = join(tempDir, 'brain-version-check.json');
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  beforeEach(() => {
    try {
      rmSync(cachePath);
    } catch {
      /* ok */
    }
  });

  test('returns updateAvailable false when cache does not exist', () => {
    const result = checkForUpdates(cachePath);
    expect(result).toEqual({ updateAvailable: false });
  });

  test('returns updateAvailable true when cache says so', () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        checkedAt: new Date().toISOString(),
        localVersion: '1.260401.1',
        latestTag: 'v0.260403.2',
        latestVersion: '0.260403.2',
        updateAvailable: true,
      }),
    );
    const result = checkForUpdates(cachePath);
    expect(result).toEqual({ updateAvailable: true, latestVersion: '0.260403.2' });
  });

  test('returns updateAvailable false when cache says no update', () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        checkedAt: new Date().toISOString(),
        localVersion: '1.260403.2',
        latestTag: 'v0.260403.2',
        latestVersion: '0.260403.2',
        updateAvailable: false,
      }),
    );
    const result = checkForUpdates(cachePath);
    expect(result).toEqual({ updateAvailable: false });
  });

  test('returns updateAvailable false when cache is invalid JSON', () => {
    writeFileSync(cachePath, 'not valid json{{{');
    const result = checkForUpdates(cachePath);
    expect(result).toEqual({ updateAvailable: false });
  });

  test('never throws regardless of cache content', () => {
    writeFileSync(cachePath, JSON.stringify({ random: 'garbage', updateAvailable: 'yes' }));
    // updateAvailable is string 'yes' which is truthy but latestVersion is undefined
    const result = checkForUpdates(cachePath);
    expect(result.updateAvailable).toBe(false);
  });
});

describe('compareVersions', () => {
  test('equal versions return 0', () => {
    expect(compareVersions('260403.1', '260403.1')).toBe(0);
  });

  test('a > b returns positive', () => {
    expect(compareVersions('260403.2', '260403.1')).toBeGreaterThan(0);
  });

  test('a < b returns negative', () => {
    expect(compareVersions('260403.1', '260403.2')).toBeLessThan(0);
  });

  test('handles multi-digit segments correctly (the bug)', () => {
    // String comparison: "260403.9" > "260403.10" → true (wrong)
    // Numeric comparison: 9 < 10 → correct
    expect(compareVersions('260403.10', '260403.9')).toBeGreaterThan(0);
    expect(compareVersions('260403.9', '260403.10')).toBeLessThan(0);
  });

  test('handles different segment counts', () => {
    expect(compareVersions('260403.1.1', '260403.1')).toBeGreaterThan(0);
    expect(compareVersions('260403', '260403.0')).toBe(0);
  });

  test('handles major version differences', () => {
    expect(compareVersions('260404.1', '260403.99')).toBeGreaterThan(0);
  });
});

/**
 * Closes khal-os/brain wish brain-v2-onboarding-overhaul Grupo G.
 *
 * Source-grep guard verifying installBrain chains the brain-side
 * install wizard. We use a structural test rather than mocking the
 * dynamic brain import (which is brittle across genie test envs).
 */
describe('installBrain → brain install wizard chain', () => {
  test('source extracts wizard call into runBrainInstallWizard helper', () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { dirname, join } = require('node:path') as typeof import('node:path');
    const src = readFileSync(join(dirname(import.meta.path), 'brain.ts'), 'utf-8');

    // Helper exists and chains via brain.execute(['install', '--apply', '--yes']).
    expect(src).toContain('async function runBrainInstallWizard()');
    expect(src).toMatch(/brain\.execute\(\['install', '--apply', '--yes'\]\)/);
    // installBrain calls the helper after the migrations + before the
    // final "Get started" line.
    expect(src).toContain('await runBrainInstallWizard();');
    // Best-effort: failure is non-fatal (try/catch with skip message).
    expect(src).toMatch(/Install wizard skipped/);
    expect(src).toMatch(/brain install --apply --yes/);
  });
});
