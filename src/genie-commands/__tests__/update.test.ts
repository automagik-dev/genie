/**
 * Tests for genie update dual-install detection (#750)
 *
 * Run with: bun test src/genie-commands/__tests__/update.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type VerifyResult,
  decideVerify,
  detectFromBinaryPath,
  detectGlobalInstalls,
  formatVerifyBanner,
  normalizeVersion,
  runVerifyProbe,
  shortCircuitIfCurrent,
} from '../update.js';

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

  test('post-update maintenance does not auto-start pgserve', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    expect(source).toContain("withTemporaryEnv('GENIE_PG_NO_AUTOSTART', '1'");
    expect(source).toContain('will not auto-start it');
    expect(source).toContain('update-diagnostics-');
    expect(source).toContain('Recent scheduler signals');
  });
});

describe('updateCommand legacy-cleanup wiring (Group 2)', () => {
  test('runUpdate calls cleanupLegacyArtifacts after install, before maintenance', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    const cleanupIdx = source.indexOf('runLegacyCleanupSafe(cleanupSkipList)');
    const maintenanceIdx = source.indexOf('runPostUpdateMaintenanceSafe(');
    const syncPluginIdx = source.indexOf('await syncPlugin(installType)');
    expect(cleanupIdx).toBeGreaterThan(-1);
    expect(maintenanceIdx).toBeGreaterThan(-1);
    expect(syncPluginIdx).toBeGreaterThan(-1);
    expect(syncPluginIdx).toBeLessThan(cleanupIdx);
    expect(cleanupIdx).toBeLessThan(maintenanceIdx);
  });

  test('--no-sidecar-cleanup adds nats-reply-sidecar to skipList and logs the notice', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    expect(source).toContain("skipList.add('nats-reply-sidecar')");
    expect(source).toContain('no-op for genie, retained for cross-CLI portability');
  });

  test('--skip-cleanup parsed via parseSkipCleanupFlag', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    expect(source).toContain('parseSkipCleanupFlag(options.skipCleanup)');
  });
});

// ============================================================================
// Group 1 — `decideVerify` + `VerifyResult` tagged-union + `normalizeVersion`.
// Pure-function tests; every kind variant pinned. Shape mirrors omni's
// SHARED-DESIGN §4.3 so reviewers/operators learn one mental model.
// ============================================================================

describe('normalizeVersion (Group 1)', () => {
  test('strips +gitsha build metadata', () => {
    expect(normalizeVersion('4.260504.21+abc1234')).toBe('4.260504.21');
  });

  test('returns input unchanged when no +metadata is present', () => {
    expect(normalizeVersion('4.260504.21')).toBe('4.260504.21');
  });

  test('trims surrounding whitespace before parsing', () => {
    expect(normalizeVersion('  4.260504.21+abc  ')).toBe('4.260504.21');
    expect(normalizeVersion('\n4.260504.21\n')).toBe('4.260504.21');
  });

  test('preserves SemVer pre-release (-rc.N) tags; only build metadata after + is stripped', () => {
    expect(normalizeVersion('1.0.0-rc.1+build.42')).toBe('1.0.0-rc.1');
    expect(normalizeVersion('2.0.0-next.0')).toBe('2.0.0-next.0');
  });

  test('strips multi-segment build metadata after the first +', () => {
    expect(normalizeVersion('4.260504.21+sha.deadbeef.dirty')).toBe('4.260504.21');
  });
});

describe('decideVerify (Group 1)', () => {
  test('skipReason "no-restart" returns skipped variant regardless of other inputs', () => {
    const result = decideVerify({
      cliVersion: '1.0.0',
      serverHealthBody: { version: '1.0.0' },
      endpoint: 'genie doctor --json',
      skipReason: 'no-restart',
    });
    expect(result).toEqual({ kind: 'skipped', reason: 'no-restart' });
  });

  test('skipReason "no-verify-flag" returns skipped variant', () => {
    const result = decideVerify({
      cliVersion: '1.0.0',
      serverHealthBody: null,
      endpoint: 'genie doctor --json',
      skipReason: 'no-verify-flag',
    });
    expect(result).toEqual({ kind: 'skipped', reason: 'no-verify-flag' });
  });

  test('skipReason "no-running-services" returns skipped variant', () => {
    const result = decideVerify({
      cliVersion: '1.0.0',
      serverHealthBody: null,
      endpoint: 'genie doctor --json',
      skipReason: 'no-running-services',
    });
    expect(result).toEqual({ kind: 'skipped', reason: 'no-running-services' });
  });

  test('null serverHealthBody (no skipReason) returns health-unreachable with endpoint', () => {
    const result = decideVerify({
      cliVersion: '1.0.0',
      serverHealthBody: null,
      endpoint: 'genie doctor --json',
    });
    expect(result).toEqual({ kind: 'health-unreachable', endpoint: 'genie doctor --json' });
  });

  test('mismatched versions return version-mismatch with normalized strings', () => {
    const result = decideVerify({
      cliVersion: '1.0.0',
      serverHealthBody: { version: '0.9.0+abc' },
      endpoint: 'genie doctor --json',
    });
    expect(result).toEqual({
      kind: 'version-mismatch',
      cliVersion: '1.0.0',
      serverVersion: '0.9.0',
    });
  });

  test('server reachable but version field absent returns version-mismatch with null serverVersion', () => {
    const result = decideVerify({
      cliVersion: '1.0.0',
      serverHealthBody: {},
      endpoint: 'genie doctor --json',
    });
    expect(result).toEqual({
      kind: 'version-mismatch',
      cliVersion: '1.0.0',
      serverVersion: null,
    });
  });

  test('matching versions (after +gitsha strip) return ok variant', () => {
    const result = decideVerify({
      cliVersion: '1.0.0',
      serverHealthBody: { version: '1.0.0+abc1234' },
      endpoint: 'genie doctor --json',
    });
    expect(result).toEqual({ kind: 'ok', cliVersion: '1.0.0', serverVersion: '1.0.0' });
  });

  test('matching versions both with +gitsha differ in metadata only → ok', () => {
    const result = decideVerify({
      cliVersion: '4.260504.21+abc1234',
      serverHealthBody: { version: '4.260504.21+def5678' },
      endpoint: 'genie doctor --json',
    });
    expect(result).toEqual({ kind: 'ok', cliVersion: '4.260504.21', serverVersion: '4.260504.21' });
  });

  test('VerifyResult tagged-union shape is exhaustive (auth-invalid variant reserved for shape parity)', () => {
    // The auth-invalid variant exists in the type for cross-CLI shape parity with
    // omni; decideVerify never returns it for genie inputs today. This test
    // exists to lock the union shape — adding/removing a variant should
    // require touching this exhaustiveness check.
    const variants: VerifyResult[] = [
      { kind: 'ok', cliVersion: '1.0.0', serverVersion: '1.0.0' },
      { kind: 'health-unreachable', endpoint: 'x' },
      { kind: 'version-mismatch', cliVersion: '1.0.0', serverVersion: '0.9.0' },
      { kind: 'auth-invalid' },
      { kind: 'skipped', reason: 'no-restart' },
      { kind: 'skipped', reason: 'no-running-services' },
      { kind: 'skipped', reason: 'no-verify-flag' },
    ];
    expect(variants).toHaveLength(7);
  });
});

// ============================================================================
// Group 3 — pre-flight version check + confirmation prompt + `--yes`.
// `shortCircuitIfCurrent` is the pure decider; `fetchLatestVersion` is the
// I/O wrapper covered separately by integration tests.
// ============================================================================

describe('shortCircuitIfCurrent (Group 3)', () => {
  test('null/undefined latestVersion → false (proceed with install)', () => {
    expect(shortCircuitIfCurrent('1.0.0', null)).toBe(false);
    expect(shortCircuitIfCurrent('1.0.0', undefined)).toBe(false);
  });

  test('empty-string latestVersion → false (defensive against parse failure)', () => {
    expect(shortCircuitIfCurrent('1.0.0', '')).toBe(false);
  });

  test('exact match returns true', () => {
    expect(shortCircuitIfCurrent('4.260504.21', '4.260504.21')).toBe(true);
  });

  test('build metadata strip lets +gitsha CLI match registry-published version', () => {
    expect(shortCircuitIfCurrent('4.260504.21+abc1234', '4.260504.21')).toBe(true);
    expect(shortCircuitIfCurrent('4.260504.21', '4.260504.21+def5678')).toBe(true);
    expect(shortCircuitIfCurrent('4.260504.21+abc', '4.260504.21+def')).toBe(true);
  });

  test('different versions return false', () => {
    expect(shortCircuitIfCurrent('1.0.0', '1.0.1')).toBe(false);
    expect(shortCircuitIfCurrent('1.0.0', '0.9.9')).toBe(false);
  });

  test('whitespace in inputs is normalized away', () => {
    expect(shortCircuitIfCurrent('  1.0.0  ', '1.0.0\n')).toBe(true);
  });
});

describe('updateCommand flag wiring (Group 3)', () => {
  test('--yes flag plumbs through UpdateCommandOptions.yes', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    expect(source).toContain('shouldAutoConfirm(options)');
    expect(source).toContain('isTruthyEnv(process.env.GENIE_UPDATE_YES)');
  });

  test('CLI exposes -y / --yes / --no-restart / --no-verify flags', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'genie.ts'), 'utf-8');
    expect(source).toContain('-y, --yes');
    expect(source).toContain('--no-restart');
    expect(source).toContain('--no-verify');
  });

  test('pre-flight version check runs BEFORE detectInstallationType', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    const fetchIdx = source.indexOf('await fetchLatestVersion(channel)');
    const detectIdx = source.indexOf('await detectInstallationType()');
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(detectIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeLessThan(detectIdx);
  });

  test('"Already up to date" exit logs version and channel', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    expect(source).toContain('Already up to date');
    expect(source).toContain('shortCircuitIfCurrent(VERSION, latestVersion)');
  });
});

// ============================================================================
// Group 4 — post-restart health probe + `--no-verify` + `--no-restart`.
// Probe I/O is exercised via the test seam `readHealth` injection so the
// suite never depends on a live daemon.
// ============================================================================

describe('runVerifyProbe (Group 4)', () => {
  test('skipReason "no-restart" returns skipped variant without polling', async () => {
    let calls = 0;
    const result = await runVerifyProbe({
      cliVersion: '1.0.0',
      skipReason: 'no-restart',
      readHealth: async () => {
        calls++;
        return { version: '1.0.0' };
      },
    });
    expect(result).toEqual({ kind: 'skipped', reason: 'no-restart' });
    expect(calls).toBe(0); // skip path never invokes the reader
  });

  test('skipReason "no-verify-flag" returns skipped variant', async () => {
    const result = await runVerifyProbe({
      cliVersion: '1.0.0',
      skipReason: 'no-verify-flag',
      readHealth: async () => null,
    });
    expect(result).toEqual({ kind: 'skipped', reason: 'no-verify-flag' });
  });

  test('reader returns body on first poll → ok', async () => {
    const result = await runVerifyProbe({
      cliVersion: '4.260504.21',
      readHealth: async () => ({ version: '4.260504.21+abc' }),
    });
    expect(result).toEqual({ kind: 'ok', cliVersion: '4.260504.21', serverVersion: '4.260504.21' });
  });

  test('reader returns mismatched version → version-mismatch', async () => {
    const result = await runVerifyProbe({
      cliVersion: '1.0.0',
      readHealth: async () => ({ version: '0.9.0' }),
    });
    expect(result).toEqual({ kind: 'version-mismatch', cliVersion: '1.0.0', serverVersion: '0.9.0' });
  });

  test('reader returns null until deadline → health-unreachable with endpoint', async () => {
    let calls = 0;
    const result = await runVerifyProbe({
      cliVersion: '1.0.0',
      readHealth: async () => {
        calls++;
        return null;
      },
      deadlineMs: 50, // shortened via test seam
      intervalMs: 10,
    });
    expect(result.kind).toBe('health-unreachable');
    if (result.kind === 'health-unreachable') {
      expect(result.endpoint).toContain('pgserve');
    }
    expect(calls).toBeGreaterThan(0);
  });

  test('reader exception is caught and treated as null read', async () => {
    let firstCall = true;
    const result = await runVerifyProbe({
      cliVersion: '1.0.0',
      readHealth: async () => {
        if (firstCall) {
          firstCall = false;
          throw new Error('connection refused');
        }
        return { version: '1.0.0' };
      },
      deadlineMs: 200,
      intervalMs: 10,
    });
    // Recovery path: first call throws, second call succeeds → ok.
    expect(result.kind).toBe('ok');
  });
});

describe('formatVerifyBanner (Group 4)', () => {
  test('ok variant emits CLI + Server lines with healthy marker', () => {
    const lines = formatVerifyBanner({ kind: 'ok', cliVersion: '1.0.0', serverVersion: '1.0.0' });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('CLI');
    expect(lines[0]).toContain('1.0.0');
    expect(lines[1]).toContain('Server');
    expect(lines[1]).toContain('healthy');
  });

  test('skipped variant collapses to single-line note with reason', () => {
    const lines = formatVerifyBanner({ kind: 'skipped', reason: 'no-restart' });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes('skipped'))).toBe(true);
    expect(lines.some((l) => l.includes('no-restart'))).toBe(true);
  });

  test('health-unreachable surfaces the probe endpoint', () => {
    const lines = formatVerifyBanner({ kind: 'health-unreachable', endpoint: 'doctor --json' });
    expect(lines.some((l) => l.includes('Server'))).toBe(true);
    expect(lines.some((l) => l.includes('doctor --json'))).toBe(true);
  });

  test('version-mismatch reports both versions', () => {
    const lines = formatVerifyBanner({ kind: 'version-mismatch', cliVersion: '1.0.0', serverVersion: '0.9.0' });
    expect(lines.some((l) => l.includes('1.0.0'))).toBe(true);
    expect(lines.some((l) => l.includes('0.9.0'))).toBe(true);
    expect(lines.some((l) => l.includes('mismatch'))).toBe(true);
  });
});

// ============================================================================
// Group 5 — diagnostics `verify` block + schema bump 1 → 2 + ora/chalk polish.
// These are source-shape lock tests; behavior is exercised end-to-end via
// the smoke flow on a real install (out of scope for unit tests).
// ============================================================================

describe('Diagnostics schema (Group 5)', () => {
  test('schema version bumped to 2', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    expect(source).toContain('UPDATE_DIAGNOSTIC_SCHEMA_VERSION = 2');
  });

  test('diagnostics object includes verify and cleanups blocks', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    expect(source).toContain('verify: extras.verify');
    expect(source).toContain('cleanups: extras.cleanups');
  });

  test('schema bump policy is documented in the file header', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    expect(source).toContain('Bump on every additive change');
  });

  test('NO_COLOR honored via colorEnabled() helper', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    expect(source).toContain('process.env.NO_COLOR');
    expect(source).toContain('colorEnabled');
  });
});
