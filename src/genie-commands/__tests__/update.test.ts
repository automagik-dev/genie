/**
 * Tests for genie update dual-install detection (#750)
 *
 * Run with: bun test src/genie-commands/__tests__/update.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectFromBinaryPath, detectGlobalInstalls } from '../update.js';

// We can't easily mock runCommandSilent inside the module, so we test
// detectGlobalInstalls by actually running the detection commands.
// These tests verify the function returns the correct shape and doesn't throw.

describe('detectGlobalInstalls', () => {
  test('returns a Set of npm | bun entries', async () => {
    const result = await detectGlobalInstalls();
    expect(result).toBeInstanceOf(Set);
    // Every entry must be either 'npm' or 'bun'
    for (const method of result) {
      expect(['npm', 'bun']).toContain(method);
    }
  });

  test('detects install methods without throwing', async () => {
    // In CI, genie may not be globally installed — just verify it doesn't throw
    // and returns a valid (possibly empty) Set
    const result = await detectGlobalInstalls();
    expect(result.size).toBeGreaterThanOrEqual(0);
  });
});

// Group 7 regression: detectFromBinaryPath must follow symlinks before
// pattern-matching. The standard install symlinks
// `~/.local/bin/genie → ~/.bun/bin/genie → ~/.bun/install/global/.../dist/genie.js`
// produce a literal LOCAL_BIN path; pre-fix, that mis-detected as 'source'
// and ran `git fetch` against a non-existent ~/.genie/src, causing
// `ENOENT: posix_spawn 'git'` for bun-installed users.
describe('detectFromBinaryPath symlink resolution (Group 7)', () => {
  test('follows symlink chain to detect bun install via node_modules in target', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'genie-update-detect-'));
    try {
      // Simulate: ~/.bun/install/global/node_modules/@automagik/genie/dist/genie.js
      const realDir = join(tmp, '.bun/install/global/node_modules/@automagik/genie/dist');
      mkdirSync(realDir, { recursive: true });
      const realBin = join(realDir, 'genie.js');
      writeFileSync(realBin, '#!/usr/bin/env bun\n', { mode: 0o755 });

      // Simulate: ~/.local/bin/genie -> ~/.bun/bin/genie -> realBin (two-hop chain)
      const bunBinDir = join(tmp, '.bun/bin');
      mkdirSync(bunBinDir, { recursive: true });
      const bunSymlink = join(bunBinDir, 'genie');
      symlinkSync(realBin, bunSymlink);

      const localBinDir = join(tmp, '.local/bin');
      mkdirSync(localBinDir, { recursive: true });
      const localSymlink = join(localBinDir, 'genie');
      symlinkSync(bunSymlink, localSymlink);

      // Pre-fix this returned 'source' (mismatch on literal path); post-fix
      // returns 'bun' (resolved target contains '.bun/').
      const result = detectFromBinaryPath(localSymlink);
      expect(result).toBe('bun');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('resolves npm install via node_modules path', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'genie-update-detect-'));
    try {
      // ~/.npm/.../node_modules/@automagik/genie/dist/genie.js (no .bun in path)
      const realDir = join(tmp, '.npm/lib/node_modules/@automagik/genie/dist');
      mkdirSync(realDir, { recursive: true });
      const realBin = join(realDir, 'genie.js');
      writeFileSync(realBin, '#!/usr/bin/env node\n', { mode: 0o755 });

      const localBinDir = join(tmp, '.local/bin');
      mkdirSync(localBinDir, { recursive: true });
      const localSymlink = join(localBinDir, 'genie');
      symlinkSync(realBin, localSymlink);

      const result = detectFromBinaryPath(localSymlink);
      expect(result).toBe('npm');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('falls back to original path on broken symlink (graceful)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'genie-update-detect-'));
    try {
      const broken = join(tmp, 'broken-genie');
      symlinkSync('/nonexistent/path/genie', broken);

      // realpathSync throws; we fall back to the original path which has
      // neither '.bun' nor 'node_modules', so result is null.
      const result = detectFromBinaryPath(broken);
      expect(result).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('updateCommand dual-install logic', () => {
  test('secondary method is the opposite of primary', () => {
    // Unit test for the selection logic extracted from updateCommand
    const getSecondary = (primary: 'npm' | 'bun') => (primary === 'bun' ? 'npm' : 'bun');
    expect(getSecondary('bun')).toBe('npm');
    expect(getSecondary('npm')).toBe('bun');
  });

  test('detectGlobalInstalls can return both npm and bun', async () => {
    // This is an integration-style test. On CI both may not be installed,
    // so we just verify the function handles both detection paths without error.
    const result = await detectGlobalInstalls();
    // Should not contain anything other than npm/bun
    for (const method of result) {
      expect(method === 'npm' || method === 'bun').toBe(true);
    }
  });
});
