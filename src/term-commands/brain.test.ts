import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkForUpdates } from './brain.js';

/**
 * Tests for the cache-only checkForUpdates function.
 *
 * checkForUpdates reads ~/.genie/brain-version-check.json synchronously.
 * It never makes network calls and never throws.
 *
 * We test it by writing/removing a temp cache file and overriding CACHE_PATH
 * is not possible (module-level const), so we test the exported function
 * against the real cache path. We save/restore the file around the tests.
 */

// The real cache path is ~/.genie/brain-version-check.json
// We test the function's behavior with various cache states.
// Since we can't easily override the const, we test the contract:
// - Returns { updateAvailable: false } when cache doesn't exist or is invalid
// - Returns { updateAvailable: true, latestVersion } when cache says so

describe('checkForUpdates', () => {
  const realCachePath = join(process.env.HOME ?? '/tmp', '.genie', 'brain-version-check.json');
  let savedCache: string | null = null;

  beforeEach(() => {
    // Save existing cache if any
    try {
      const { readFileSync } = require('node:fs');
      savedCache = readFileSync(realCachePath, 'utf-8');
    } catch {
      savedCache = null;
    }
  });

  afterEach(() => {
    // Restore original cache
    if (savedCache !== null) {
      writeFileSync(realCachePath, savedCache);
    } else {
      try {
        rmSync(realCachePath);
      } catch {
        /* didn't exist */
      }
    }
  });

  test('returns updateAvailable false when cache does not exist', () => {
    try {
      rmSync(realCachePath);
    } catch {
      /* ok */
    }
    const result = checkForUpdates();
    expect(result).toEqual({ updateAvailable: false });
  });

  test('returns updateAvailable true when cache says so', () => {
    mkdirSync(join(process.env.HOME ?? '/tmp', '.genie'), { recursive: true });
    writeFileSync(
      realCachePath,
      JSON.stringify({
        checkedAt: new Date().toISOString(),
        localVersion: '1.260401.1',
        latestTag: 'v0.260403.2',
        latestVersion: '0.260403.2',
        updateAvailable: true,
      }),
    );
    const result = checkForUpdates();
    expect(result).toEqual({ updateAvailable: true, latestVersion: '0.260403.2' });
  });

  test('returns updateAvailable false when cache says no update', () => {
    mkdirSync(join(process.env.HOME ?? '/tmp', '.genie'), { recursive: true });
    writeFileSync(
      realCachePath,
      JSON.stringify({
        checkedAt: new Date().toISOString(),
        localVersion: '1.260403.2',
        latestTag: 'v0.260403.2',
        latestVersion: '0.260403.2',
        updateAvailable: false,
      }),
    );
    const result = checkForUpdates();
    expect(result).toEqual({ updateAvailable: false });
  });

  test('returns updateAvailable false when cache is invalid JSON', () => {
    mkdirSync(join(process.env.HOME ?? '/tmp', '.genie'), { recursive: true });
    writeFileSync(realCachePath, 'not valid json{{{');
    const result = checkForUpdates();
    expect(result).toEqual({ updateAvailable: false });
  });

  test('never throws regardless of cache content', () => {
    mkdirSync(join(process.env.HOME ?? '/tmp', '.genie'), { recursive: true });
    writeFileSync(realCachePath, JSON.stringify({ random: 'garbage', updateAvailable: 'yes' }));
    // Should not throw
    const result = checkForUpdates();
    // updateAvailable is string 'yes' which is truthy but latestVersion is undefined
    // so it should return updateAvailable: false
    expect(result.updateAvailable).toBe(false);
  });
});
