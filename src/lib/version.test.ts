/**
 * Tests for the runtime version resolver — closes #1464.
 *
 * The resolver must be worktree-aware: when the binary lives in
 * `<repo>/.worktrees/<name>/dist/`, it must find
 * `<repo>/.worktrees/<name>/package.json` (the binary's own package), NOT
 * `<repo>/package.json` (the parent repo).
 *
 * These tests verify the source contract via static-text assertions plus a
 * live runtime check that the currently-loaded VERSION matches the closest
 * `@automagik/genie` package.json walking up from this test file.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { VERSION } from './version.js';

describe('version resolver — Mac CPU sprint sibling fix #1464', () => {
  const versionSource = readFileSync(resolve(__dirname, 'version.ts'), 'utf-8');

  test('VERSION is a non-empty string', () => {
    expect(typeof VERSION).toBe('string');
    expect(VERSION.length).toBeGreaterThan(0);
    expect(VERSION).not.toBe('0.0.0-unknown');
  });

  test('VERSION matches the closest @automagik/genie package.json walking up from this file', () => {
    const ourPackageName = '@automagik/genie';
    let dir = dirname(resolve(__dirname));
    let walked = 0;
    let found: { name?: string; version?: string } | null = null;
    while (walked < 10) {
      const pkgPath = resolve(dir, 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        if (pkg.name === ourPackageName) {
          found = pkg;
          break;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
      walked++;
    }
    expect(found).not.toBeNull();
    expect(found?.version).toBeDefined();
    expect(VERSION).toBe(found?.version as string);
  });

  test('source identifies @automagik/genie as the package name to match', () => {
    expect(versionSource).toContain("PACKAGE_NAME = '@automagik/genie'");
  });

  test('source bounds the walk depth (no runaway scans)', () => {
    expect(versionSource).toContain('MAX_WALK_DEPTH');
  });

  test('source matches by package name FIRST, then falls back to any version', () => {
    // Two-pass walk: name-matched, then any-package-with-version
    const namePassIdx = versionSource.indexOf('pkg?.name === PACKAGE_NAME');
    const fallbackPassIdx = versionSource.indexOf('Fallback');
    expect(namePassIdx).toBeGreaterThan(0);
    expect(fallbackPassIdx).toBeGreaterThan(namePassIdx);
  });

  test('source explicitly stops at filesystem root', () => {
    expect(versionSource).toMatch(/parent === current/);
  });
});
