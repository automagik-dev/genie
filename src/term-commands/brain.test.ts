import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkForUpdates } from './brain.js';

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
