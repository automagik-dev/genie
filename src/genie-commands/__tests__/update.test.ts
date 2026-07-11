/**
 * Tests for genie update — GH Releases delivery layer (genie-distribution-cutover G5).
 *
 * The npm/bun-add code path was deleted in G5; tests that exercised it are
 * gone. Coverage now centers on:
 *   - VerifyResult tagged-union (decideVerify, runVerifyProbe, formatVerifyBanner)
 *   - GH-Releases primitives (manifest URL routing, fetchLatestManifest, platform
 *     resolution, downloadAndVerifyTarball, atomicBinarySwap, rollbackBinary)
 *   - Diagnostics v3 schema lock + plugin-marker filter regression
 *
 * Run with: bun test src/genie-commands/__tests__/update.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSyncReport } from '../../lib/agent-sync';
import type { CommandRunner } from '../../lib/runtime-integrations';
import type { AuxiliaryTreeOutcome, AuxiliaryTreeStage } from '../auxiliary-trees.js';
import {
  type RefreshUpdatePluginsOptions,
  refreshUpdatePlugins as refreshUpdatePluginsWithPhysicalVerification,
} from '../update-integrations.js';
import {
  type LatestManifest,
  type VerifyResult,
  _resetNextDeprecationLatchForTest,
  atomicBinarySwap,
  compareVersions,
  decideDowngrade,
  decideVerify,
  downloadAndVerifyTarball,
  ensureCanonicalInstall,
  fetchLatestManifest,
  finalizeAuxiliaryDelivery,
  formatVerifyBanner,
  hashPhysicalFileIncrementally,
  isGenieProcessSnapshotLine,
  manifestUrlForChannel,
  normalizeVersion,
  persistChannel,
  pruneSameVersionBackups,
  quarantinePendingDelivery,
  recordPendingDelivery,
  resolveChannel,
  resolveLiveBinaryPath,
  resolvePlatformId,
  resolveUpdateExecutionMode,
  resumePendingDelivery,
  rollbackBinary,
  runAgentSyncSafe,
  runManualUpdateConvergence,
  runV4CleanupSafe,
  runVerifyProbe,
  shortCircuitIfCurrent,
  shouldEmitPathDivergenceWarning,
  summarizeJsonlSignals,
  syncAuxiliaryContent,
  syncBinaryVersionStamp,
  verifySwappedBinary,
} from '../update.js';

function refreshUpdatePlugins(options: RefreshUpdatePluginsOptions) {
  return refreshUpdatePluginsWithPhysicalVerification({
    ...options,
    resolveExecutable: options.resolveExecutable ?? ((name) => name),
    verifyCodexPayload: options.verifyCodexPayload ?? (() => undefined),
    verifyClaudePayload: options.verifyClaudePayload ?? (() => undefined),
  });
}

// ============================================================================
// Pure-helper coverage — `decideVerify`, `normalizeVersion`,
// `shortCircuitIfCurrent`. These are the operator-facing decisions; every
// kind variant is pinned so a future edit can't silently degrade them.
// ============================================================================

describe('normalizeVersion', () => {
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

describe('decideVerify', () => {
  test('skipReason "no-restart" returns skipped variant regardless of other inputs', () => {
    const result = decideVerify({
      reportedVersion: '1.0.0',
      targetVersion: '1.0.0',
      binaryPath: '/home/.genie/bin/genie',
      skipReason: 'no-restart',
    });
    expect(result).toEqual({ kind: 'skipped', reason: 'no-restart' });
  });

  test('skipReason "no-verify-flag" returns skipped variant', () => {
    const result = decideVerify({
      reportedVersion: null,
      targetVersion: null,
      binaryPath: null,
      skipReason: 'no-verify-flag',
    });
    expect(result).toEqual({ kind: 'skipped', reason: 'no-verify-flag' });
  });

  test('null reportedVersion (binary would not run) → verify-failed naming the binary path', () => {
    const result = decideVerify({
      reportedVersion: null,
      targetVersion: '4.260507.2',
      binaryPath: '/home/.genie/bin/genie',
    });
    expect(result.kind).toBe('verify-failed');
    if (result.kind === 'verify-failed') {
      expect(result.reason).toContain('did not report a version');
      expect(result.reason).toContain('/home/.genie/bin/genie');
      expect(result.path).toBe('/home/.genie/bin/genie');
    }
  });

  test('reported version matches target → ok carrying normalized version + path', () => {
    const result = decideVerify({
      reportedVersion: '4.260507.2+abc1234',
      targetVersion: '4.260507.2',
      binaryPath: '/home/.genie/bin/genie',
    });
    expect(result).toEqual({ kind: 'ok', version: '4.260507.2', path: '/home/.genie/bin/genie' });
  });

  test('reported version differs from target → verify-failed carrying both versions', () => {
    const result = decideVerify({
      reportedVersion: '4.260520.3',
      targetVersion: '4.260522.2',
      binaryPath: '/home/.genie/bin/genie',
    });
    expect(result.kind).toBe('verify-failed');
    if (result.kind === 'verify-failed') {
      expect(result.reason).toContain('4.260522.2');
      expect(result.reason).toContain('4.260520.3');
    }
  });

  test('null targetVersion accepts any parsable reported version as ok', () => {
    const result = decideVerify({
      reportedVersion: '4.260507.2',
      targetVersion: null,
      binaryPath: '/home/.genie/bin/genie',
    });
    expect(result).toEqual({ kind: 'ok', version: '4.260507.2', path: '/home/.genie/bin/genie' });
  });

  test('VerifyResult tagged-union shape is exhaustive', () => {
    const variants: VerifyResult[] = [
      { kind: 'ok', version: '1.0.0', path: '/home/.genie/bin/genie' },
      { kind: 'verify-failed', reason: 'boom', path: '/home/.genie/bin/genie' },
      { kind: 'skipped', reason: 'no-restart' },
      { kind: 'skipped', reason: 'no-verify-flag' },
    ];
    expect(variants).toHaveLength(4);
  });
});

describe('shortCircuitIfCurrent', () => {
  test('null/undefined latestVersion → false (proceed with install)', () => {
    expect(shortCircuitIfCurrent('1.0.0', null)).toBe(false);
    expect(shortCircuitIfCurrent('1.0.0', undefined)).toBe(false);
  });

  test('empty-string latestVersion → false', () => {
    expect(shortCircuitIfCurrent('1.0.0', '')).toBe(false);
  });

  test('exact match returns true', () => {
    expect(shortCircuitIfCurrent('4.260504.21', '4.260504.21')).toBe(true);
  });

  test('build metadata strip lets +gitsha CLI match registry-published version', () => {
    expect(shortCircuitIfCurrent('4.260504.21+abc1234', '4.260504.21')).toBe(true);
    expect(shortCircuitIfCurrent('4.260504.21', '4.260504.21+def5678')).toBe(true);
  });

  test('different versions return false', () => {
    expect(shortCircuitIfCurrent('1.0.0', '1.0.1')).toBe(false);
  });
});

describe('numeric prerelease comparator laws', () => {
  test('equal numeric identifiers with leading zeroes remain symmetric', () => {
    const a = '5.260711.1-rc.01';
    const b = '5.260711.1-rc.1';
    expect(compareVersions(a, b)).toBe(0);
    expect(compareVersions(b, a)).toBe(0);
  });
});

// ============================================================================
// Downgrade guard (BUG B) — numeric version comparison + the pure decision
// function that refuses a silent backward swap. `shortCircuitIfCurrent` only
// covers the EQUAL case; these cover installed > latest.
// ============================================================================

describe('compareVersions', () => {
  test('older < newer across each MAJOR.YYMMDD.N component', () => {
    expect(compareVersions('5.260710.2', '5.260710.10')).toBe(-1);
    expect(compareVersions('5.260709.9', '5.260710.1')).toBe(-1);
    expect(compareVersions('4.999999.9', '5.000000.0')).toBe(-1);
  });

  test('newer > older is the inverse', () => {
    expect(compareVersions('5.260710.10', '5.260710.2')).toBe(1);
    expect(compareVersions('5.260710.1', '5.260709.9')).toBe(1);
  });

  test('equal versions compare 0', () => {
    expect(compareVersions('5.260710.11', '5.260710.11')).toBe(0);
  });

  test('build metadata is stripped before comparing', () => {
    expect(compareVersions('5.260710.11+abc1234', '5.260710.11')).toBe(0);
    expect(compareVersions('5.260710.10+deadbee', '5.260710.2')).toBe(1);
  });

  test('N is compared numerically, not lexically (10 > 2)', () => {
    // The core of the live bug: string compare would rank "2" above "10".
    expect(compareVersions('5.260710.10', '5.260710.2')).toBe(1);
  });

  test('final releases rank above prereleases of the same core', () => {
    expect(compareVersions('5.260710.14', '5.260710.14-rc.1')).toBe(1);
    expect(compareVersions('5.260710.14-rc.1', '5.260710.14')).toBe(-1);
  });

  test('prerelease identifiers follow SemVer-like numeric and lexical precedence', () => {
    expect(compareVersions('5.260710.14-rc.2', '5.260710.14-rc.10')).toBe(-1);
    expect(compareVersions('5.260710.14-1', '5.260710.14-rc')).toBe(-1);
    expect(compareVersions('5.260710.14-alpha', '5.260710.14-beta')).toBe(-1);
  });

  test('malformed versions are rejected instead of being coerced to zero', () => {
    for (const malformed of ['5.260710', 'garbage', '', '5.260710.1-', '5.260710.1+']) {
      expect(() => compareVersions(malformed, '5.260710.1')).toThrow('Invalid Genie version');
    }
  });
});

describe('decideDowngrade', () => {
  test('installed older → upgrade (proceed normally)', () => {
    expect(
      decideDowngrade({ installedVersion: '5.260710.2', latestVersion: '5.260710.10', explicitChannel: false }).kind,
    ).toBe('upgrade');
  });

  test('installed equal → current (short-circuit)', () => {
    expect(
      decideDowngrade({ installedVersion: '5.260710.11', latestVersion: '5.260710.11', explicitChannel: false }).kind,
    ).toBe('current');
  });

  test('installed newer + NO explicit flag → block-downgrade with both versions', () => {
    const d = decideDowngrade({
      installedVersion: '5.260710.10',
      latestVersion: '5.260710.2',
      explicitChannel: false,
    });
    expect(d.kind).toBe('block-downgrade');
    if (d.kind === 'block-downgrade') {
      expect(d.installed).toBe('5.260710.10');
      expect(d.latest).toBe('5.260710.2');
    }
  });

  test('installed newer + explicit channel flag → allow-downgrade (operator intent)', () => {
    const d = decideDowngrade({
      installedVersion: '5.260710.10',
      latestVersion: '5.260710.2',
      explicitChannel: true,
    });
    expect(d.kind).toBe('allow-downgrade');
    if (d.kind === 'allow-downgrade') {
      expect(d.installed).toBe('5.260710.10');
      expect(d.latest).toBe('5.260710.2');
    }
  });

  test('null/undefined latest → upgrade (defers to the manifest-unavailable abort)', () => {
    expect(decideDowngrade({ installedVersion: '5.260710.10', latestVersion: null, explicitChannel: false }).kind).toBe(
      'upgrade',
    );
    expect(
      decideDowngrade({ installedVersion: '5.260710.10', latestVersion: undefined, explicitChannel: true }).kind,
    ).toBe('upgrade');
  });

  test('final/RC decisions never reverse the release direction', () => {
    expect(
      decideDowngrade({
        installedVersion: '5.260710.14',
        latestVersion: '5.260710.14-rc.1',
        explicitChannel: false,
      }).kind,
    ).toBe('block-downgrade');
    expect(
      decideDowngrade({
        installedVersion: '5.260710.14-rc.1',
        latestVersion: '5.260710.14',
        explicitChannel: false,
      }).kind,
    ).toBe('upgrade');
  });

  test('malformed installed and manifest versions are explicit tagged outcomes', () => {
    expect(
      decideDowngrade({ installedVersion: 'broken', latestVersion: '5.260710.1', explicitChannel: false }),
    ).toEqual({ kind: 'invalid-version', field: 'installed', value: 'broken' });
    expect(
      decideDowngrade({ installedVersion: '5.260710.1', latestVersion: 'broken', explicitChannel: false }),
    ).toEqual({ kind: 'invalid-version', field: 'latest', value: 'broken' });
  });
});

describe('updateCommand downgrade wiring (BUG B source-shape lock)', () => {
  test('updateCommand runs the downgrade guard before download', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    const cmdStart = source.indexOf('export async function updateCommand');
    const cmdBody = source.slice(cmdStart);
    const guardIdx = cmdBody.indexOf('applyDowngradeGuard(');
    const downloadIdx = cmdBody.indexOf('await downloadAndVerifyTarball(');
    // The guard must run BEFORE any tarball is fetched.
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(downloadIdx);
    // A refused downgrade still converges owned assets + installed plugins.
    const afterGuard = cmdBody.slice(guardIdx);
    expect(afterGuard).toContain('runTrackedManualUpdateConvergence(');
  });

  test('the guard consults decideDowngrade and honors both refusal and explicit-intent paths', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    expect(source).toContain('decideDowngrade({');
    // block-downgrade path: refuse loudly.
    expect(source).toContain("downgrade.kind === 'block-downgrade'");
    expect(source).toContain('refusing automatic downgrade');
    // allow-downgrade path: loud one-liner honoring explicit operator intent.
    expect(source).toContain("downgrade.kind === 'allow-downgrade'");
    expect(source).toContain('DOWNGRADE v');
    // An explicit channel flag is what authorizes the backward move.
    expect(source).toContain('const explicitChannel = Boolean(');
  });
});

// ============================================================================
// updateCommand wiring (source-shape locks).
// ============================================================================

describe('updateCommand wiring', () => {
  test('npm-update path is gone — no `bun add @automagik/genie` references', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    expect(source).not.toMatch(/bun add[^\n]*@automagik\/genie/);
    expect(source).not.toMatch(/npm install[^\n]*@automagik\/genie/);
  });

  test('npm-fallback env-var is fully removed (acceptance: hard-cutover Decision 7)', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    // The pre-G5 fallback toggled an env var built from the prefix/suffix below.
    // Build the literal from parts here so the audit grep finds zero hits in src/.
    const removedEnvVar = ['GENIE', 'UPDATE', 'NPM'].join('_');
    expect(source).not.toContain(removedEnvVar);
  });

  test('--yes flag plumbs through UpdateCommandOptions.yes', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    expect(source).toContain('shouldAutoConfirm(options)');
    expect(source).toContain('isTruthyEnv(process.env.GENIE_UPDATE_YES)');
  });

  test('CLI exposes -y / --yes / --no-restart / --no-verify / --rollback flags', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'genie.ts'), 'utf-8');
    expect(source).toContain('-y, --yes');
    expect(source).toContain('--no-restart');
    expect(source).toContain('--no-verify');
    expect(source).toContain('--rollback');
  });

  test('"Already up to date" exit logs version and channel', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    expect(source).toContain('Already up to date');
    // The short-circuit must key off the INSTALLED binary version, not the
    // running process's compile-time VERSION — otherwise a stale shadowing
    // binary on $PATH re-offers the same update forever.
    expect(source).toContain('shortCircuitIfCurrent(installedVersion, latestVersion)');
    expect(source).toContain('const installedVersion = resolveInstalledVersion()');
  });

  test('--rollback short-circuits before downloading anything', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    // Anchor on updateCommand's body, not the function declaration.
    const cmdStart = source.indexOf('export async function updateCommand');
    expect(cmdStart).toBeGreaterThan(-1);
    const cmdBody = source.slice(cmdStart);
    const rollbackIdx = cmdBody.indexOf("mode === 'rollback'");
    const downloadIdx = cmdBody.indexOf('await downloadAndVerifyTarball(');
    expect(rollbackIdx).toBeGreaterThan(-1);
    expect(downloadIdx).toBeGreaterThan(-1);
    expect(rollbackIdx).toBeLessThan(downloadIdx);
  });
});

// ============================================================================
// Verify probe + banner (zero-daemon v5). The probe re-executes the installed
// binary and compares its --version to the target; I/O is exercised via the
// `readVersion` test seam so the suite never spawns a real binary.
// ============================================================================

describe('runVerifyProbe', () => {
  test('skipReason "no-restart" returns skipped without probing the binary', () => {
    let calls = 0;
    const result = runVerifyProbe({
      skipReason: 'no-restart',
      targetVersion: '1.0.0',
      readVersion: () => {
        calls++;
        return '1.0.0';
      },
    });
    expect(result).toEqual({ kind: 'skipped', reason: 'no-restart' });
    expect(calls).toBe(0);
  });

  test('binary reports the target version → ok (build metadata normalized)', () => {
    const result = runVerifyProbe({
      targetVersion: '4.260507.2',
      binaryPath: '/home/.genie/bin/genie',
      readVersion: () => '4.260507.2+abc',
    });
    expect(result).toEqual({ kind: 'ok', version: '4.260507.2', path: '/home/.genie/bin/genie' });
  });

  test('binary that will not run (reader returns null) → verify-failed', () => {
    const result = runVerifyProbe({
      targetVersion: '4.260507.2',
      binaryPath: '/home/.genie/bin/genie',
      readVersion: () => null,
    });
    expect(result.kind).toBe('verify-failed');
  });

  test('binary reports a different version than the target → verify-failed', () => {
    const result = runVerifyProbe({
      targetVersion: '4.260522.2',
      binaryPath: '/home/.genie/bin/genie',
      readVersion: () => '4.260520.3',
    });
    expect(result.kind).toBe('verify-failed');
  });

  test('passes the resolved binaryPath through to the reader seam', () => {
    const seen: string[] = [];
    runVerifyProbe({
      binaryPath: '/custom/genie',
      targetVersion: null,
      readVersion: (p) => {
        seen.push(p);
        return '1.2.3';
      },
    });
    expect(seen).toEqual(['/custom/genie']);
  });
});

describe('formatVerifyBanner', () => {
  test('ok variant emits a single verified line carrying the version', () => {
    const lines = formatVerifyBanner({ kind: 'ok', version: '4.260507.2', path: '/home/.genie/bin/genie' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Genie');
    expect(lines[0]).toContain('4.260507.2');
    expect(lines[0]).toContain('verified');
  });

  test('ok variant with null version falls back to "version unknown"', () => {
    const lines = formatVerifyBanner({ kind: 'ok', version: null, path: null });
    expect(lines[0]).toContain('version unknown');
  });

  test('skipped variant collapses to single-line note with reason', () => {
    const lines = formatVerifyBanner({ kind: 'skipped', reason: 'no-restart' });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes('skipped'))).toBe(true);
    expect(lines.some((l) => l.includes('no-restart'))).toBe(true);
  });

  test('verify-failed surfaces the reason and the offending binary path', () => {
    const lines = formatVerifyBanner({
      kind: 'verify-failed',
      reason: 'expected v4.260522.2, but /home/.genie/bin/genie reports v4.260520.3',
      path: '/home/.genie/bin/genie',
    });
    expect(lines.some((l) => l.includes('verification failed'))).toBe(true);
    expect(lines.some((l) => l.includes('4.260522.2'))).toBe(true);
    expect(lines.some((l) => l.includes('/home/.genie/bin/genie'))).toBe(true);
  });

  test('verify-failed with null path omits the binary follow-up line', () => {
    const lines = formatVerifyBanner({ kind: 'verify-failed', reason: 'boom', path: null });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('boom');
  });
});

// ============================================================================
// G5 — GH-Releases delivery primitives. URL routing, manifest parsing,
// platform detection. Network I/O is stubbed via `fetcher` test seam.
// ============================================================================

describe('manifestUrlForChannel (G5)', () => {
  test('stable maps to .well-known/latest.json', () => {
    expect(manifestUrlForChannel('stable')).toBe(
      'https://raw.githubusercontent.com/automagik-dev/genie/main/.well-known/latest.json',
    );
  });

  test('homolog/dev get their own per-channel files', () => {
    // Canonical taxonomy (2026-05-12, cross-repo unified): stable / homolog / dev.
    // beta + canary retired — no longer accepted by ReleaseChannel type.
    expect(manifestUrlForChannel('homolog')).toContain('.well-known/homolog.json');
    expect(manifestUrlForChannel('dev')).toContain('.well-known/dev.json');
  });
});

describe('resolveChannel — --dev flag + --next deprecation alias (release-channel-dev)', () => {
  // Captures the stderr write so the deprecation-notice assertions can inspect
  // it without leaking into the test runner's terminal.
  let stderrCapture: string;
  const realStderrWrite = process.stderr.write.bind(process.stderr);

  beforeEach(() => {
    stderrCapture = '';
    _resetNextDeprecationLatchForTest();
    // Cast through unknown — `process.stderr.write` has 3 overloads and we
    // only need the string-argument form for the deprecation notice.
    (process.stderr.write as unknown) = ((chunk: string | Uint8Array): boolean => {
      stderrCapture += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    (process.stderr.write as unknown) = realStderrWrite as typeof process.stderr.write;
    _resetNextDeprecationLatchForTest();
  });

  test('--dev resolves to channel "dev"', async () => {
    expect(await resolveChannel({ dev: true })).toBe('dev');
    expect(stderrCapture).toBe('');
  });

  test('--next resolves to channel "dev" AND emits a deprecation notice on stderr', async () => {
    expect(await resolveChannel({ next: true })).toBe('dev');
    expect(stderrCapture).toContain('--next is deprecated');
    expect(stderrCapture).toContain('--dev');
  });

  test('--next deprecation notice fires at most once per process', async () => {
    await resolveChannel({ next: true });
    await resolveChannel({ next: true });
    await resolveChannel({ next: true });
    // Count occurrences of the deprecation marker.
    const matches = stderrCapture.match(/--next is deprecated/g) ?? [];
    expect(matches.length).toBe(1);
  });

  test('--stable wins over --next when both are set (explicit stable preference)', async () => {
    // PR #2419 review (codex P2 + gemini medium): an explicit --stable must
    // override prerelease intent. Without this ordering, scripts that append
    // --stable to pull users back from prerelease channels silently no-op'd.
    expect(await resolveChannel({ next: true, stable: true })).toBe('stable');
    // The deprecation notice still fires because --next was on the command
    // line — operators learn the rename even when --stable overrode the
    // channel selection.
    expect(stderrCapture).toContain('--next is deprecated');
  });

  test('--stable wins over --dev when both are set', async () => {
    expect(await resolveChannel({ dev: true, stable: true })).toBe('stable');
    expect(stderrCapture).toBe('');
  });

  test('--dev wins over --next without emitting deprecation', async () => {
    expect(await resolveChannel({ dev: true, next: true })).toBe('dev');
    expect(stderrCapture).toBe('');
  });

  test('no flags + no config → defaults to stable', async () => {
    // resolveChannel reads from ~/.genie/config.json via genieConfigExists().
    // On a fresh test environment where the file may or may not exist, the
    // default is stable. We assert the function returns SOMETHING in the
    // {stable, dev} set rather than pinning it to one — environment-dependent
    // tests are flaky. The next test (--stable explicit) pins stable.
    const channel = await resolveChannel({});
    expect(['stable', 'dev']).toContain(channel);
  });

  test('--stable resolves to "stable" even if config previously set dev', async () => {
    expect(await resolveChannel({ stable: true })).toBe('stable');
  });

  // Canonical taxonomy (2026-05-12): stable / homolog / dev.
  // homolog is the middle tier in the dev → homolog → stable promotion
  // ladder. The flag ranks ABOVE --dev (closer to stable) but BELOW --stable.
  test('--homolog resolves to channel "homolog"', async () => {
    expect(await resolveChannel({ homolog: true })).toBe('homolog');
    expect(stderrCapture).toBe('');
  });

  test('--stable wins over --homolog when both are set', async () => {
    expect(await resolveChannel({ homolog: true, stable: true })).toBe('stable');
    expect(stderrCapture).toBe('');
  });

  test('--homolog wins over --dev when both are set (closer to stable)', async () => {
    expect(await resolveChannel({ homolog: true, dev: true })).toBe('homolog');
    expect(stderrCapture).toBe('');
  });

  test('--homolog wins over --next without emitting deprecation', async () => {
    expect(await resolveChannel({ homolog: true, next: true })).toBe('homolog');
    expect(stderrCapture).toBe('');
  });
});

describe('GenieConfigSchema.updateChannel — read-time alias for "next"', () => {
  // The wish (decision #3) says configs written by pre-rename binaries with
  // `updateChannel: "next"` must be honored — zod transforms the legacy
  // token to the canonical `dev` on parse so downstream code only sees
  // 'latest' | 'dev'.
  test('"next" parses as "dev"', async () => {
    const { GenieConfigSchema } = await import('../../types/genie-config.js');
    const parsed = GenieConfigSchema.parse({ updateChannel: 'next' });
    expect(parsed.updateChannel).toBe('dev');
  });

  test('"dev" parses as "dev"', async () => {
    const { GenieConfigSchema } = await import('../../types/genie-config.js');
    const parsed = GenieConfigSchema.parse({ updateChannel: 'dev' });
    expect(parsed.updateChannel).toBe('dev');
  });

  test('"latest" parses as "latest"', async () => {
    const { GenieConfigSchema } = await import('../../types/genie-config.js');
    const parsed = GenieConfigSchema.parse({ updateChannel: 'latest' });
    expect(parsed.updateChannel).toBe('latest');
  });

  test('absent updateChannel defaults to "latest"', async () => {
    const { GenieConfigSchema } = await import('../../types/genie-config.js');
    const parsed = GenieConfigSchema.parse({});
    expect(parsed.updateChannel).toBe('latest');
  });

  test('invalid channel value is rejected', async () => {
    const { GenieConfigSchema } = await import('../../types/genie-config.js');
    expect(() => GenieConfigSchema.parse({ updateChannel: 'banana' })).toThrow();
  });
});

describe('persistChannel — sticky channel persistence (release-channel-dev)', () => {
  // Smoke-level coverage. The full disk round-trip is exercised via the
  // schema test above (write "dev" → read back as "dev") plus the
  // resolveChannel test (which reads from genie-config). We just assert
  // that persistChannel does not throw on either channel input.
  test('persistChannel("dev") does not throw', async () => {
    await expect(persistChannel('dev')).resolves.toBeUndefined();
  });

  test('persistChannel("stable") does not throw', async () => {
    await expect(persistChannel('stable')).resolves.toBeUndefined();
  });
});

// ============================================================================
// Channel persistence never clobbers the config (BUG A). A transient config
// read failure between two `genie update` runs must NOT (a) silently reset a
// persisted channel to stable, nor (b) rewrite the whole file from defaults.
// Isolated under a tmp GENIE_HOME so a real ~/.genie/config.json is never read
// or written; stderr is captured so the advisory lines are asserted, not leaked.
// ============================================================================

describe('resolveChannel + persistChannel — config preservation (BUG A)', () => {
  let dir: string;
  let configPath: string;
  let prevGenieHome: string | undefined;
  let stderrCapture: string;
  const realStderrWrite = process.stderr.write.bind(process.stderr);

  beforeEach(() => {
    prevGenieHome = process.env.GENIE_HOME;
    dir = mkdtempSync(join(tmpdir(), 'update-channel-'));
    process.env.GENIE_HOME = dir;
    configPath = join(dir, 'config.json');
    stderrCapture = '';
    (process.stderr.write as unknown) = ((chunk: string | Uint8Array): boolean => {
      stderrCapture += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    (process.stderr.write as unknown) = realStderrWrite as typeof process.stderr.write;
    if (prevGenieHome === undefined) {
      Reflect.deleteProperty(process.env, 'GENIE_HOME');
    } else {
      process.env.GENIE_HOME = prevGenieHome;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test('valid persisted channel resolves back and persist preserves sibling keys', async () => {
    writeFileSync(configPath, JSON.stringify({ updateChannel: 'homolog', setupComplete: true }, null, 2), 'utf-8');
    expect(await resolveChannel({})).toBe('homolog');
    expect(stderrCapture).toBe(''); // happy path is silent
    await persistChannel('homolog');
    const saved = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(saved.updateChannel).toBe('homolog');
    expect(saved.setupComplete).toBe(true);
  });

  test('valid config with unknown/extra fields survives persistChannel byte-for-byte except updateChannel', async () => {
    // Unknown keys (myTool) are stripped by the schema on parse — proving that even
    // the happy path must NOT round-trip through saveGenieConfig, or they vanish.
    const original = {
      updateChannel: 'dev',
      setupComplete: true,
      promptMode: 'system',
      myTool: { foo: 1, list: ['a', 'b'] },
    };
    writeFileSync(configPath, JSON.stringify(original, null, 2), 'utf-8');

    await persistChannel('stable'); // dev → latest

    const after = readFileSync(configPath, 'utf-8');
    // Byte-for-byte identical except updateChannel flipped to its canonical token.
    expect(after).toBe(JSON.stringify({ ...original, updateChannel: 'latest' }, null, 2));
    const saved = JSON.parse(after) as Record<string, unknown>;
    expect(saved.updateChannel).toBe('latest');
    expect(saved.setupComplete).toBe(true);
    expect(saved.promptMode).toBe('system');
    expect(saved.myTool).toEqual({ foo: 1, list: ['a', 'b'] });
    expect(stderrCapture).toBe('');
  });

  test('schema-invalid-but-parseable config keeps its channel on resolve and is NOT clobbered on persist', async () => {
    // omni present but missing its required apiUrl → the full schema rejects this,
    // but the file is valid JSON, so the channel is still recoverable.
    const invalid = { updateChannel: 'dev', setupComplete: true, omni: { instance: 'x' } };
    writeFileSync(configPath, JSON.stringify(invalid, null, 2), 'utf-8');

    // resolve: recovers 'dev' from the raw key rather than silently → stable.
    expect(await resolveChannel({})).toBe('dev');
    expect(stderrCapture).toContain('keeping channel dev');

    // persist: raw read-modify-write; the invalid-but-present siblings survive.
    await persistChannel('dev');
    const saved = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(saved.updateChannel).toBe('dev');
    expect(saved.setupComplete).toBe(true); // NOT reset to the default (false)
    expect(saved.omni).toEqual({ instance: 'x' }); // NOT dropped
  });

  test('unparseable config → advisory + no write on persist, stated stable fallback on resolve', async () => {
    const garbage = '{ this is not valid json ,,, ';
    writeFileSync(configPath, garbage, 'utf-8');

    // resolve: falls back to stable, and says so.
    expect(await resolveChannel({})).toBe('stable');
    expect(stderrCapture).toContain('could not read');
    expect(stderrCapture).toContain('falling back to stable channel');

    // persist: leaves the file untouched rather than clobbering it.
    await persistChannel('dev');
    expect(readFileSync(configPath, 'utf-8')).toBe(garbage);
    expect(stderrCapture).toContain('unparseable');
    expect(stderrCapture).toContain('not persisted');
  });

  test('valid config with no updateChannel key resolves to stable silently (schema default)', async () => {
    writeFileSync(configPath, JSON.stringify({ setupComplete: true }, null, 2), 'utf-8');
    expect(await resolveChannel({})).toBe('stable');
    expect(stderrCapture).toBe('');
  });
});

describe('fetchLatestManifest (G5)', () => {
  const validManifest: LatestManifest = {
    schema_version: 1,
    channel: 'stable',
    version: '4.260509.5',
    released_at: '2026-05-09T22:11:00Z',
    tarball_base: 'https://github.com/automagik-dev/genie/releases/download/v4.260509.5',
    platforms: ['linux-x64-glibc', 'linux-x64-musl', 'linux-arm64', 'darwin-arm64'],
  };

  test('parses a valid latest.json payload', async () => {
    const manifest = await fetchLatestManifest('stable', {
      fetcher: async () => JSON.stringify(validManifest),
    });
    expect(manifest).toEqual(validManifest);
  });

  test('returns null when fetcher resolves null (network failure)', async () => {
    const manifest = await fetchLatestManifest('stable', {
      fetcher: async () => null,
    });
    expect(manifest).toBeNull();
  });

  test('returns null on JSON parse failure', async () => {
    const manifest = await fetchLatestManifest('stable', {
      fetcher: async () => '<html>not json</html>',
    });
    expect(manifest).toBeNull();
  });

  test('returns null on schema mismatch (missing version field)', async () => {
    const manifest = await fetchLatestManifest('stable', {
      fetcher: async () => JSON.stringify({ schema_version: 1, tarball_base: 'x', platforms: [] }),
    });
    expect(manifest).toBeNull();
  });

  test('returns null on schema mismatch (platforms not array)', async () => {
    const manifest = await fetchLatestManifest('stable', {
      fetcher: async () => JSON.stringify({ schema_version: 1, version: 'x', tarball_base: 'x', platforms: 'all' }),
    });
    expect(manifest).toBeNull();
  });

  test('honors timeoutMs and resolves null when fetcher hangs', async () => {
    const manifest = await fetchLatestManifest('stable', {
      timeoutMs: 30,
      fetcher: () => new Promise((r) => setTimeout(() => r('{}'), 200)),
    });
    expect(manifest).toBeNull();
  });
});

describe('resolvePlatformId (G5)', () => {
  test('returns one of the four supported platform identifiers', () => {
    // Don't pin a specific value — runs in CI on linux-x64; locally on
    // darwin-arm64. Just verify the contract.
    const platform = resolvePlatformId();
    expect(['linux-x64-glibc', 'linux-x64-musl', 'linux-arm64', 'darwin-arm64']).toContain(platform);
  });

  test('produces a value matching scripts/build-binary.sh naming contract', () => {
    // The G1 build-tarballs.yml emits `genie-<version>-<platform>.tar.gz`;
    // any platform we resolve must be parseable by that filename schema.
    const platform = resolvePlatformId();
    const filename = `genie-1.2.3-${platform}.tar.gz`;
    expect(filename).toMatch(/^genie-1\.2\.3-(linux-x64-glibc|linux-x64-musl|linux-arm64|darwin-arm64)\.tar\.gz$/);
  });
});

describe('downloadAndVerifyTarball (G5)', () => {
  const manifest: LatestManifest = {
    schema_version: 1,
    channel: 'stable',
    version: '4.260509.5',
    released_at: '2026-05-09T22:11:00Z',
    tarball_base: 'https://github.com/automagik-dev/genie/releases/download/v4.260509.5',
    platforms: ['linux-x64-glibc', 'linux-x64-musl', 'linux-arm64', 'darwin-arm64'],
  };

  test('issues gh release download with the correct version tag and pattern set', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'genie-update-dl-'));
    try {
      const calls: Array<{ cmd: string; args: string[]; timeoutMs?: number }> = [];
      // Stub runner: capture every gh invocation, place the tarball where
      // downloadAndVerifyTarball expects it on the success path.
      const runner = async (cmd: string, args: string[], timeoutMs?: number) => {
        calls.push({ cmd, args, timeoutMs });
        if (cmd === 'gh' && args[0] === 'release') {
          // Drop a placeholder tarball so the existsSync check passes.
          const tarballName = `genie-${manifest.version}-linux-x64-glibc.tar.gz`;
          writeFileSync(join(tmp, tarballName), 'fake-tarball-bytes');
        }
        return { success: true, output: '' };
      };
      const tarballPath = await downloadAndVerifyTarball(manifest, 'linux-x64-glibc', tmp, { runner });
      expect(tarballPath).toBe(join(tmp, `genie-${manifest.version}-linux-x64-glibc.tar.gz`));
      // First call — release download with v<version>.
      expect(calls[0].cmd).toBe('gh');
      expect(calls[0].args).toContain('release');
      expect(calls[0].args).toContain('download');
      expect(calls[0].args).toContain(`v${manifest.version}`);
      // Patterns include tarball + sidecar artifacts.
      const argString = calls[0].args.join(' ');
      expect(argString).toContain(`genie-${manifest.version}-linux-x64-glibc.tar.gz`);
      expect(argString).toContain('.bundle');
      expect(argString).toContain('.intoto.jsonl');
      // Second call — gh attestation verify with workflow identity pinned.
      expect(calls[1].cmd).toBe('gh');
      expect(calls[1].args).toEqual([
        'attestation',
        'verify',
        tarballPath,
        '--repo',
        'automagik-dev/genie',
        '--cert-identity-regex',
        '^https://github.com/automagik-dev/genie/.github/workflows/sign-attest.yml@',
        '--cert-oidc-issuer',
        'https://token.actions.githubusercontent.com',
      ]);
      expect(calls[1].timeoutMs).toBe(60_000);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('throws when gh release download fails', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'genie-update-dl-'));
    try {
      const runner = async () => ({ success: false, output: 'release not found' });
      await expect(downloadAndVerifyTarball(manifest, 'linux-x64-glibc', tmp, { runner })).rejects.toThrow(
        /gh release download/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('throws when attestation verification fails', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'genie-update-dl-'));
    try {
      let call = 0;
      const runner = async (_cmd: string, _args: string[]) => {
        call++;
        if (call === 1) {
          // download succeeds — drop the file
          writeFileSync(join(tmp, `genie-${manifest.version}-linux-x64-glibc.tar.gz`), 'x');
          return { success: true, output: '' };
        }
        // attestation verify fails
        return { success: false, output: 'no matching attestation' };
      };
      await expect(downloadAndVerifyTarball(manifest, 'linux-x64-glibc', tmp, { runner })).rejects.toThrow(
        /attestation verify/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('falls back to cosign bundle when gh attestation verify fails', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'genie-update-dl-'));
    try {
      const tarballPath = join(tmp, `genie-${manifest.version}-linux-x64-glibc.tar.gz`);
      const bundlePath = `${tarballPath}.bundle`;
      const calls: Array<{ cmd: string; args: string[]; timeoutMs?: number }> = [];
      const runner = async (cmd: string, args: string[], timeoutMs?: number) => {
        calls.push({ cmd, args, timeoutMs });
        if (cmd === 'gh' && args[0] === 'release') {
          writeFileSync(tarballPath, 'x');
          writeFileSync(bundlePath, 'bundle');
          return { success: true, output: '' };
        }
        if (cmd === 'gh' && args[0] === 'attestation') {
          return { success: false, output: 'Timed out after 60000ms' };
        }
        return { success: true, output: '' };
      };

      await expect(downloadAndVerifyTarball(manifest, 'linux-x64-glibc', tmp, { runner })).resolves.toBe(tarballPath);
      expect(calls.map((call) => call.cmd)).toEqual(['gh', 'gh', 'cosign']);
      expect(calls[2].args).toEqual([
        'verify-blob',
        '--bundle',
        bundlePath,
        '--certificate-identity-regexp',
        '^https://github.com/automagik-dev/genie/.github/workflows/sign-attest.yml@',
        '--certificate-oidc-issuer',
        'https://token.actions.githubusercontent.com',
        tarballPath,
      ]);
      expect(calls[2].timeoutMs).toBe(30_000);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('throws with both verifier errors when gh and cosign verification fail', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'genie-update-dl-'));
    try {
      const tarballPath = join(tmp, `genie-${manifest.version}-linux-x64-glibc.tar.gz`);
      const runner = async (cmd: string, args: string[]) => {
        if (cmd === 'gh' && args[0] === 'release') {
          writeFileSync(tarballPath, 'x');
          writeFileSync(`${tarballPath}.bundle`, 'bundle');
          return { success: true, output: '' };
        }
        if (cmd === 'gh' && args[0] === 'attestation') {
          return { success: false, output: 'no matching attestation' };
        }
        return { success: false, output: 'invalid signature' };
      };
      await expect(downloadAndVerifyTarball(manifest, 'linux-x64-glibc', tmp, { runner })).rejects.toThrow(
        /cosign verify-blob: invalid signature/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('skipAttestation skips signature verification calls', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'genie-update-dl-'));
    try {
      const calls: Array<{ cmd: string; args: string[] }> = [];
      const runner = async (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        writeFileSync(join(tmp, `genie-${manifest.version}-darwin-arm64.tar.gz`), 'x');
        return { success: true, output: '' };
      };
      await downloadAndVerifyTarball(manifest, 'darwin-arm64', tmp, { runner, skipAttestation: true });
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0]).toBe('release');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// G5 — Atomic binary swap + rollback.
// Real fs operations on tmp dir; no mocks. The swap needs same-fs primitives,
// so tmp dir is on the test runner's filesystem.
// ============================================================================

describe('atomicBinarySwap (G5)', () => {
  test('happy path: stages binary, backs up old, swaps in new', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'genie-swap-'));
    try {
      const stagedBin = join(tmp, 'staged', 'genie');
      const targetBin = join(tmp, 'bin', 'genie');
      const previousDir = join(tmp, 'bin', '.previous');
      mkdirSync(join(tmp, 'staged'), { recursive: true });
      mkdirSync(join(tmp, 'bin'), { recursive: true });
      writeFileSync(stagedBin, 'NEW_BINARY');
      writeFileSync(targetBin, 'OLD_BINARY');

      const result = atomicBinarySwap(stagedBin, targetBin, previousDir, '4.260507.0');
      expect(result.swapped).toBe(true);
      expect(result.oldVersionBackup).toBe(join(previousDir, 'genie-4.260507.0'));
      expect(readFileSync(targetBin, 'utf-8')).toBe('NEW_BINARY');
      expect(readFileSync(result.oldVersionBackup as string, 'utf-8')).toBe('OLD_BINARY');
      // staging consumed
      expect(existsSync(stagedBin)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('first-time install (no current binary) skips backup', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'genie-swap-'));
    try {
      const stagedBin = join(tmp, 'staged', 'genie');
      const targetBin = join(tmp, 'bin', 'genie');
      const previousDir = join(tmp, 'bin', '.previous');
      mkdirSync(join(tmp, 'staged'), { recursive: true });
      writeFileSync(stagedBin, 'FIRST_BINARY');

      const result = atomicBinarySwap(stagedBin, targetBin, previousDir, '4.260507.0');
      expect(result.swapped).toBe(true);
      expect(result.oldVersionBackup).toBeNull();
      expect(readFileSync(targetBin, 'utf-8')).toBe('FIRST_BINARY');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('throws when the staged binary is missing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'genie-swap-'));
    try {
      const stagedBin = join(tmp, 'staged', 'genie');
      const targetBin = join(tmp, 'bin', 'genie');
      const previousDir = join(tmp, 'bin', '.previous');
      expect(() => atomicBinarySwap(stagedBin, targetBin, previousDir, '4.260507.0')).toThrow(/staged binary missing/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('overwrites a stale backup at the same version', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'genie-swap-'));
    try {
      const stagedBin = join(tmp, 'staged', 'genie');
      const targetBin = join(tmp, 'bin', 'genie');
      const previousDir = join(tmp, 'bin', '.previous');
      mkdirSync(join(tmp, 'staged'), { recursive: true });
      mkdirSync(join(tmp, 'bin'), { recursive: true });
      mkdirSync(previousDir, { recursive: true });
      writeFileSync(stagedBin, 'NEW');
      writeFileSync(targetBin, 'CURRENT');
      // Stale backup from a prior run at the same old version.
      writeFileSync(join(previousDir, 'genie-4.260507.0'), 'STALE_BACKUP');

      const result = atomicBinarySwap(stagedBin, targetBin, previousDir, '4.260507.0');
      expect(readFileSync(result.oldVersionBackup as string, 'utf-8')).toBe('CURRENT');
      expect(readdirSync(previousDir)).toHaveLength(2);
      expect(pruneSameVersionBackups(previousDir, '4.260507.0', result.oldVersionBackup as string)).toHaveLength(1);
      expect(readdirSync(previousDir)).toEqual([expect.stringMatching(/^genie-4\.260507\.0(?:\.|$)/)]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('preserves a journal-bound source while removing the redundant swap copy', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'genie-swap-journal-source-'));
    try {
      const stagedBin = join(tmp, 'staged', 'genie');
      const targetBin = join(tmp, 'bin', 'genie');
      mkdirSync(join(tmp, 'staged'), { recursive: true });
      writeFileSync(stagedBin, 'NEW');
      atomicBinarySwap(stagedBin, targetBin, join(tmp, 'bin', '.previous'), '4.260507.0', {
        preserveSource: true,
      });
      expect(readFileSync(stagedBin, 'utf8')).toBe('NEW');
      expect(readFileSync(targetBin, 'utf8')).toBe('NEW');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('preserves 0o755 permissions on the swapped-in binary', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'genie-swap-'));
    try {
      const stagedBin = join(tmp, 'staged', 'genie');
      const targetBin = join(tmp, 'bin', 'genie');
      const previousDir = join(tmp, 'bin', '.previous');
      mkdirSync(join(tmp, 'staged'), { recursive: true });
      writeFileSync(stagedBin, 'NEW');

      atomicBinarySwap(stagedBin, targetBin, previousDir, '4.260507.0');
      const mode = statSync(targetBin).mode & 0o777;
      // 0o755 — owner rwx, group/other rx
      expect(mode & 0o100).toBe(0o100); // owner exec bit
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('an interruption before promotion leaves the old canonical binary runnable', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'genie-swap-interrupt-'));
    try {
      const stagedBin = join(tmp, 'staged', 'genie');
      const targetBin = join(tmp, 'bin', 'genie');
      const previousDir = join(tmp, 'bin', '.previous');
      mkdirSync(join(tmp, 'staged'), { recursive: true });
      mkdirSync(join(tmp, 'bin'), { recursive: true });
      writeFileSync(stagedBin, 'NEW_BINARY');
      writeFileSync(targetBin, 'OLD_BINARY');

      expect(() =>
        atomicBinarySwap(stagedBin, targetBin, previousDir, '4.260507.0', {
          beforePromote: () => {
            expect(readFileSync(targetBin, 'utf8')).toBe('OLD_BINARY');
            throw new Error('power loss injected');
          },
        }),
      ).toThrow('power loss injected');

      expect(readFileSync(targetBin, 'utf8')).toBe('OLD_BINARY');
      expect(readFileSync(stagedBin, 'utf8')).toBe('NEW_BINARY');
      expect(readFileSync(join(previousDir, 'genie-4.260507.0'), 'utf8')).toBe('OLD_BINARY');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('rollbackBinary (G5)', () => {
  // rollbackBinary reads from `~/.genie/bin/.previous` directly via the
  // module-level GENIE_HOME constant. We override GENIE_HOME via env BEFORE
  // re-importing so the test sees a temp directory. The single import at the
  // top of this file already captured the real GENIE_HOME; therefore these
  // tests run against the real ~/.genie path. To keep them hermetic we create
  // a backup, run rollback, then assert + clean up. If a real .previous
  // directory exists with newer entries the test would conflict; gate the
  // tests behind an explicit env so CI runs them and dev workstations can
  // skip when needed.
  const SHOULD_RUN =
    process.env.GENIE_TEST_RUN_ROLLBACK === '1' ||
    !existsSync(join(process.env.HOME ?? '', '.genie', 'bin', '.previous'));

  test.skipIf(!SHOULD_RUN)('throws when no .previous directory exists', () => {
    // Best-effort: only assert when the directory is genuinely absent.
    const previousDir = join(process.env.HOME ?? '', '.genie', 'bin', '.previous');
    if (existsSync(previousDir)) return;
    expect(() => rollbackBinary()).toThrow(/No rollback target/);
  });
});

// ============================================================================
// Diagnostics schema lock (G5: bumped 2 → 3).
// ============================================================================

describe('Diagnostics schema (G5)', () => {
  test('schema version bumped to 3 (G5 cutover)', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    expect(source).toContain('UPDATE_DIAGNOSTIC_SCHEMA_VERSION = 3');
  });

  test('diagnostics object includes verify and delivery blocks', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    expect(source).toContain('verify: extras.verify');
    // G5 delivery block names the new artifacts: manifest, tarballPath, attestation, previousBackup.
    expect(source).toContain('delivery:');
    expect(source).toContain('manifest: ctx.manifest');
    expect(source).toContain('tarballPath: ctx.tarballPath');
    expect(source).toContain('attestationVerified: ctx.attestationVerified');
    expect(source).toContain('previousBackup: ctx.previousBackup');
  });

  test('diagnostics process snapshot excludes pgserve/autopg noise and keeps Genie serve lines', () => {
    expect(
      isGenieProcessSnapshotLine(
        '2554274 1 2554274 Ssl 0.0 0.4 00:08:00 /home/genie/.local/bin/genie serve start --daemon',
      ),
    ).toBe(true);
    expect(
      isGenieProcessSnapshotLine(
        '2588570 171462 2588570 Rsl 1.0 2.8 3-12:34:22 bun /home/genie/.bun/install/global/node_modules/pgserve/bin/postgres-server.js postmaster --port 8432',
      ),
    ).toBe(false);
    expect(isGenieProcessSnapshotLine('2588570 1 2588570 S postgres -D /home/genie/.genie/data/pgserve')).toBe(false);
  });

  test('NO_COLOR honored via colorEnabled() helper', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    expect(source).toContain('process.env.NO_COLOR');
    expect(source).toContain('colorEnabled');
  });
});

// ============================================================================
// Post-update verify wiring (zero-daemon v5 — pm2 restart + legacy cleanup removed).
// ============================================================================

describe('post-update verify wiring', () => {
  test('exit-code 1 path fires on verify-failed', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    expect(source).toContain("verify.kind === 'verify-failed'");
    expect(source).toContain('process.exitCode = 1');
  });

  test('verify keys off the installed binary version — no daemon/pgserve/pm2 poll', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    // Zero-daemon: the pgserve status + serve.pid poll is gone entirely.
    expect(source).not.toContain('readServerHealth');
    expect(source).not.toContain('pgserve status --json + ~/.genie/serve.pid');
    // The probe re-executes the swapped binary and compares to the target.
    expect(source).toContain("execFileSync(binaryPath, ['--version']");
    expect(source).toContain('targetVersion: diagnosticsCtx.latestVersion');
  });
});

// ============================================================================
// Skill-loading regression — `.orphaned_at` must NOT propagate via copyDirSync.
// Diagnosed 2026-05-06; the lock must survive the G5 rewrite.
// ============================================================================

describe('Plugin sync — .orphaned_at filter (skills regression 2026-05-06)', () => {
  test('FRAMEWORK_MARKER_FILES set contains .orphaned_at', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    expect(source).toContain('FRAMEWORK_MARKER_FILES');
    expect(source).toContain("'.orphaned_at'");
  });

  test('transactional copier receives and applies FRAMEWORK_MARKER_FILES', () => {
    const updateSource = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    const helperSource = readFileSync(join(__dirname, '..', 'auxiliary-trees.ts'), 'utf-8');
    expect(updateSource).toContain('excludedEntryNames: FRAMEWORK_MARKER_FILES');
    expect(helperSource).toContain('if (excludedEntryNames.has(entry.name)) continue;');
  });

  test('repo source tree does NOT contain plugins/genie/.orphaned_at', () => {
    const repoRoot = join(__dirname, '..', '..', '..');
    const orphanedMarkerPath = join(repoRoot, 'plugins', 'genie', '.orphaned_at');
    expect(require('node:fs').existsSync(orphanedMarkerPath)).toBe(false);
  });

  test('.gitignore lists .orphaned_at', () => {
    const repoRoot = join(__dirname, '..', '..', '..');
    const gitignorePath = join(repoRoot, '.gitignore');
    const contents = readFileSync(gitignorePath, 'utf-8');
    expect(contents).toMatch(/^\.orphaned_at$/m);
  });
});

// ============================================================================
// PR #1733 review fixes — atomic-swap temp file pattern + live-binary detection.
// Pinning the bug fixes so a future regression can't slip them back in.
// ============================================================================

describe('atomicBinarySwap canonical-path safety', () => {
  test('promotes a complete target-directory replacement with one rename-over-live', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    const fnStart = source.indexOf('export function atomicBinarySwap');
    const fnEnd = source.indexOf('\nexport function ', fnStart + 1);
    const body = source.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
    expect(body).toContain('.genie-replacement-');
    expect(body).toContain('fsyncFile(replacementPath)');
    expect(body).toContain('renameSync(replacementPath, targetBinPath)');
    expect(body).not.toContain('rmSync(targetBinPath');
    expect(body).not.toContain('renameSync(targetBinPath');
  });

  test('backs up by copy so the old canonical path remains live before promotion', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    const fnStart = source.indexOf('export function atomicBinarySwap');
    const fnEnd = source.indexOf('\nexport function ', fnStart + 1);
    const body = source.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
    expect(body).toContain('copyFileSync(targetBinPath, backupStaging');
    expect(body).toContain('renameSync(backupStaging, oldBackup)');
    expect(body).not.toContain('renameSync(targetBinPath, oldBackup)');
  });
});

describe('fsyncSync import (review fix #1)', () => {
  test('fsyncSync is in the named imports list, not loaded via require()', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    // Match the node:fs import block.
    const importBlockMatch = source.match(/from\s+'node:fs';/);
    expect(importBlockMatch).not.toBeNull();
    const blockEnd = source.indexOf("from 'node:fs';");
    const blockStart = source.lastIndexOf('import {', blockEnd);
    const block = source.slice(blockStart, blockEnd);
    expect(block).toContain('fsyncSync');
    // Belt + suspenders: make sure no `require('node:fs').fsyncSync` lurks.
    expect(source).not.toContain("require('node:fs').fsyncSync");
  });
});

describe('syncAuxiliaryContent transactional outcomes', () => {
  test('returns a digest-backed outcome for every payload tree and refreshes changed content', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-update-aux-'));
    const extract = join(root, 'extract');
    const home = join(root, 'home');
    try {
      mkdirSync(join(extract, 'plugins'), { recursive: true });
      mkdirSync(join(home, 'plugins'), { recursive: true });
      writeFileSync(join(extract, 'plugins', 'payload.txt'), 'fresh');
      writeFileSync(join(extract, 'plugins', '.orphaned_at'), 'must not copy');
      writeFileSync(join(home, 'plugins', 'payload.txt'), 'old');

      const outcomes = syncAuxiliaryContent(extract, home);

      expect(outcomes).toHaveLength(5);
      expect(outcomes.find((outcome) => outcome.label === 'plugins')?.status).toBe('refreshed');
      expect(readFileSync(join(home, 'plugins', 'payload.txt'), 'utf8')).toBe('fresh');
      expect(existsSync(join(home, 'plugins', '.orphaned_at'))).toBe(false);
      // Update retains extraction until the caller confirms every tree and
      // removes the whole staging area in one final cleanup.
      expect(readFileSync(join(extract, 'plugins', 'payload.txt'), 'utf8')).toBe('fresh');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('removes root and nested live framework markers even when payload content otherwise matches', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-update-aux-markers-'));
    const extract = join(root, 'extract');
    const home = join(root, 'home');
    try {
      for (const tree of [join(extract, 'plugins'), join(home, 'plugins')]) {
        mkdirSync(join(tree, 'nested'), { recursive: true });
        writeFileSync(join(tree, 'payload.txt'), 'same');
        writeFileSync(join(tree, 'nested', 'payload.txt'), 'same nested');
      }
      writeFileSync(join(extract, 'plugins', '.orphaned_at'), 'source marker');
      writeFileSync(join(extract, 'plugins', 'nested', '.orphaned_at'), 'source nested marker');
      writeFileSync(join(home, 'plugins', '.orphaned_at'), 'live marker');
      writeFileSync(join(home, 'plugins', 'nested', '.orphaned_at'), 'live nested marker');

      const outcomes = syncAuxiliaryContent(extract, home);
      expect(outcomes.find((outcome) => outcome.label === 'plugins')?.status).toBe('refreshed');
      expect(existsSync(join(home, 'plugins', '.orphaned_at'))).toBe(false);
      expect(existsSync(join(home, 'plugins', 'nested', '.orphaned_at'))).toBe(false);
      expect(readFileSync(join(home, 'plugins', 'nested', 'payload.txt'), 'utf8')).toBe('same nested');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a promotion failure restores old live content and returns retained fresh evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-update-aux-failure-'));
    const extract = join(root, 'extract');
    const home = join(root, 'home');
    let renames = 0;
    try {
      mkdirSync(join(extract, 'plugins'), { recursive: true });
      mkdirSync(join(home, 'plugins'), { recursive: true });
      writeFileSync(join(extract, 'plugins', 'payload.txt'), 'fresh');
      writeFileSync(join(home, 'plugins', 'payload.txt'), 'old');
      const outcomes = syncAuxiliaryContent(extract, home, {
        rename: (from, to) => {
          renames += 1;
          if (renames === 2) throw new Error('promote injected');
          renameSync(from, to);
        },
      });
      const plugins = outcomes.find((outcome) => outcome.label === 'plugins');
      expect(plugins?.status).toBe('failed');
      if (plugins?.status === 'failed') {
        expect(plugins.stage).toBe('promote-fresh');
        expect(plugins.freshArtifact).toBeDefined();
        if (plugins.freshArtifact) expect(existsSync(plugins.freshArtifact)).toBe(true);
      }
      expect(readFileSync(join(home, 'plugins', 'payload.txt'), 'utf8')).toBe('old');
      expect(readFileSync(join(extract, 'plugins', 'payload.txt'), 'utf8')).toBe('fresh');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('auxiliary VERSION and extraction finalization gate', () => {
  test('every injected non-success blocks both VERSION stamping and extraction cleanup', () => {
    const stages: AuxiliaryTreeStage[] = [
      'copy-fresh',
      'verify-copy',
      'park-live',
      'promote-fresh',
      'remove-identical-source',
      'remove-source',
    ];
    for (const stage of stages) {
      const outcome: AuxiliaryTreeOutcome = {
        label: `fixture-${stage}`,
        status: 'failed',
        source: '/tmp/extract/plugins',
        destination: '/tmp/home/plugins',
        stage,
        error: 'injected',
      };
      let versionWrites = 0;
      let extractionCleanups = 0;
      expect(() =>
        finalizeAuxiliaryDelivery([outcome], {
          writeVersion: () => {
            versionWrites += 1;
          },
          cleanupExtraction: () => {
            extractionCleanups += 1;
          },
        }),
      ).toThrow(`fixture-${stage}`);
      expect(versionWrites).toBe(0);
      expect(extractionCleanups).toBe(0);
    }
  });

  test('verified convergence stamps VERSION before cleaning extraction', () => {
    const calls: string[] = [];
    finalizeAuxiliaryDelivery(
      [
        {
          label: 'plugins',
          status: 'refreshed',
          source: '/tmp/extract/plugins',
          destination: '/tmp/home/plugins',
          digest: 'a'.repeat(64),
          warnings: [],
        },
      ],
      {
        writeVersion: () => calls.push('version'),
        cleanupExtraction: () => calls.push('cleanup'),
      },
    );
    expect(calls).toEqual(['version', 'cleanup']);
  });
});

describe('durable pending delivery recovery', () => {
  test('incremental hashing matches SHA-256 across multiple fixed-size reads', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-incremental-hash-'));
    const path = join(root, 'payload');
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 0x5a);
    try {
      writeFileSync(path, bytes);
      expect(hashPhysicalFileIncrementally(path, 64 * 1024)).toBe(createHash('sha256').update(bytes).digest('hex'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('explicit update modes are resolved before recovery and cannot conflict', () => {
    expect(resolveUpdateExecutionMode({}, undefined)).toBe('normal');
    expect(resolveUpdateExecutionMode({ syncOnly: true }, undefined)).toBe('sync-only');
    expect(resolveUpdateExecutionMode({}, '1')).toBe('sync-only');
    expect(resolveUpdateExecutionMode({ rollback: true }, '1')).toBe('rollback');
    expect(() => resolveUpdateExecutionMode({ rollback: true, syncOnly: true }, undefined)).toThrow(
      '--rollback and --sync-only cannot be used together',
    );
  });

  test('rollback quarantine atomically removes a pending journal from the recovery path', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-pending-cancel-'));
    const journal = join(root, '.pending-delivery.json');
    writeFileSync(journal, '{"schemaVersion":2}\n', { mode: 0o600 });
    try {
      const quarantined = quarantinePendingDelivery(journal);
      expect(quarantined).not.toBeNull();
      expect(existsSync(journal)).toBe(false);
      expect(quarantined && existsSync(quarantined)).toBe(true);
      expect(quarantinePendingDelivery(journal)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('resumes local auxiliary convergence before clearing the journal', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-pending-delivery-'));
    const home = join(root, 'home');
    const staging = join(home, 'bin', '.staging');
    const extract = join(staging, 'extract-5.260711.7');
    const tarball = join(staging, 'genie.tar.gz');
    const journal = join(home, '.pending-delivery.json');
    mkdirSync(join(extract, 'plugins', 'genie'), { recursive: true });
    writeFileSync(join(extract, 'genie'), 'verified binary');
    writeFileSync(join(extract, 'plugins', 'genie', 'payload.txt'), 'fresh');
    writeFileSync(tarball, 'verified');
    try {
      recordPendingDelivery({ version: '5.260711.7', extractDir: extract, tarballPath: tarball }, journal, staging);
      let binaryChecks = 0;
      expect(
        resumePendingDelivery({
          genieHome: home,
          stagingRoot: staging,
          pendingPath: journal,
          ensureBinary: () => {
            binaryChecks += 1;
          },
        }),
      ).toBe(true);
      expect(binaryChecks).toBe(1);
      expect(readFileSync(join(home, 'plugins', 'genie', 'payload.txt'), 'utf8')).toBe('fresh');
      expect(readFileSync(join(home, 'VERSION'), 'utf8')).toBe('5.260711.7\n');
      expect(existsSync(journal)).toBe(false);
      expect(resumePendingDelivery({ genieHome: home, stagingRoot: staging, pendingPath: journal })).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('successful pending-delivery recovery prunes older backups for the recorded previous version', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-pending-prune-'));
    const home = join(root, 'home');
    const staging = join(home, 'bin', '.staging');
    const extract = join(staging, 'extract-5.260711.7');
    const tarball = join(staging, 'genie.tar.gz');
    const journal = join(home, '.pending-delivery.json');
    const previous = join(home, 'bin', '.previous');
    mkdirSync(join(extract, 'plugins', 'genie'), { recursive: true });
    mkdirSync(previous, { recursive: true });
    writeFileSync(join(extract, 'genie'), 'verified binary');
    writeFileSync(join(extract, 'plugins', 'genie', 'payload.txt'), 'fresh');
    writeFileSync(tarball, 'verified');
    const older = join(previous, 'genie-5.260711.6');
    const retained = join(previous, 'genie-5.260711.6.retry');
    writeFileSync(older, 'older rollback');
    writeFileSync(retained, 'new rollback');
    utimesSync(older, 1, 1);
    utimesSync(retained, 2, 2);
    try {
      recordPendingDelivery(
        {
          version: '5.260711.7',
          previousVersion: '5.260711.6',
          extractDir: extract,
          tarballPath: tarball,
        },
        journal,
        staging,
      );
      expect(
        resumePendingDelivery({
          genieHome: home,
          stagingRoot: staging,
          pendingPath: journal,
          ensureBinary: () => undefined,
        }),
      ).toBe(true);
      expect(existsSync(older)).toBe(false);
      expect(readFileSync(retained, 'utf8')).toBe('new rollback');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a failed resume retains the verified journal and succeeds on a normal retry', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-pending-retry-'));
    const home = join(root, 'home');
    const staging = join(home, 'bin', '.staging');
    const extract = join(staging, 'extract-5.260711.7');
    const tarball = join(staging, 'genie.tar.gz');
    const journal = join(home, '.pending-delivery.json');
    mkdirSync(join(extract, 'plugins', 'genie'), { recursive: true });
    writeFileSync(join(extract, 'genie'), 'verified binary');
    writeFileSync(join(extract, 'plugins', 'genie', 'payload.txt'), 'fresh');
    writeFileSync(tarball, 'verified');
    recordPendingDelivery({ version: '5.260711.7', extractDir: extract, tarballPath: tarball }, journal, staging);
    try {
      expect(() =>
        resumePendingDelivery({
          genieHome: home,
          stagingRoot: staging,
          pendingPath: journal,
          ensureBinary: () => undefined,
          operations: {
            rename() {
              throw new Error('promotion unavailable');
            },
          },
        }),
      ).toThrow('auxiliary payload convergence failed');
      expect(existsSync(journal)).toBe(true);
      expect(
        resumePendingDelivery({
          genieHome: home,
          stagingRoot: staging,
          pendingPath: journal,
          ensureBinary: () => undefined,
        }),
      ).toBe(true);
      expect(existsSync(journal)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects binary and auxiliary tampering before any live mutation', () => {
    for (const tamper of ['binary', 'auxiliary'] as const) {
      const root = mkdtempSync(join(tmpdir(), `genie-pending-tamper-${tamper}-`));
      const home = join(root, 'home');
      const staging = join(home, 'bin', '.staging');
      const extract = join(staging, 'extract-5.260711.7');
      const tarball = join(staging, 'genie.tar.gz');
      const journal = join(home, '.pending-delivery.json');
      mkdirSync(join(extract, 'plugins', 'genie'), { recursive: true });
      writeFileSync(join(extract, 'genie'), 'verified binary');
      writeFileSync(join(extract, 'plugins', 'genie', 'payload.txt'), 'verified auxiliary');
      writeFileSync(tarball, 'verified tarball');
      try {
        recordPendingDelivery({ version: '5.260711.7', extractDir: extract, tarballPath: tarball }, journal, staging);
        if (tamper === 'binary') writeFileSync(join(extract, 'genie'), 'substituted binary');
        else writeFileSync(join(extract, 'plugins', 'genie', 'payload.txt'), 'substituted auxiliary');
        let binaryChecks = 0;
        expect(() =>
          resumePendingDelivery({
            genieHome: home,
            stagingRoot: staging,
            pendingPath: journal,
            ensureBinary: () => {
              binaryChecks += 1;
            },
          }),
        ).toThrow('pending delivery payload fingerprint mismatch');
        expect(binaryChecks).toBe(0);
        expect(existsSync(join(home, 'plugins'))).toBe(false);
        expect(existsSync(journal)).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});

describe('ensureCanonicalInstall + resolveLiveBinaryPath (review fix #3)', () => {
  test('resolveLiveBinaryPath returns null or a string (which-genie probe)', () => {
    // Smoke test: the function must not throw on any host. If genie isn't on
    // PATH (CI sandbox), we get null. If it is, we get a resolved path.
    const result = resolveLiveBinaryPath();
    expect(result === null || typeof result === 'string').toBe(true);
  });

  test('ensureCanonicalInstall returns target path when there is no live binary', () => {
    // When `which genie` fails (no install yet), the function should fall
    // through to the canonical target without throwing — first-install path.
    // We can't mock the bash call from the import boundary, so we skip the
    // assertion when a live binary IS resolved (most dev hosts) — the
    // happy-path test runs in CI sandboxes only.
    const live = resolveLiveBinaryPath();
    if (live !== null) return;
    expect(() => ensureCanonicalInstall()).not.toThrow();
  });

  test('migration message references install.sh + ~/.genie/bin canonical path', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    const fnStart = source.indexOf('export function ensureCanonicalInstall');
    const fnEnd = source.indexOf('\nexport function ', fnStart + 1);
    const body = source.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
    expect(body).toContain('install.sh');
    expect(body).toContain('~/.genie/bin');
    // The error message must include enough context for the operator to
    // recognize what to do — both the live path and the canonical target.
    expect(body).toMatch(/Live genie binary is at/);
    expect(body).toMatch(/realpathSync/);
  });

  test('updateCommand calls ensureCanonicalInstall before delivery', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    const cmdStart = source.indexOf('export async function updateCommand');
    expect(cmdStart).toBeGreaterThan(-1);
    const cmdBody = source.slice(cmdStart);
    const ensureIdx = cmdBody.indexOf('requireCanonicalInstallOrExit()');
    const deliveryIdx = cmdBody.indexOf('await runDelivery(');
    expect(ensureIdx).toBeGreaterThan(-1);
    expect(deliveryIdx).toBeGreaterThan(-1);
    // The check must run BEFORE we touch the binary on disk.
    expect(ensureIdx).toBeLessThan(deliveryIdx);
  });
});

describe('Knip-clean exports (PR #1733 follow-up)', () => {
  test('fetchLatestVersion shim is removed (knip dead-code finding)', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    expect(source).not.toContain('export async function fetchLatestVersion');
  });

  test('RELEASES_BASE_URL constant + bottom re-export are removed (knip dead-code)', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    expect(source).not.toContain('RELEASES_BASE_URL');
    expect(source).not.toMatch(/^export\s*\{\s*RELEASES_/m);
  });
});

// ============================================================================
// Silent swap + self-symlink regression (trace 2026-05-22).
//
// Symptom on operator host (genie@khal-os): `genie update --dev` reported
// "✔ Genie binary updated → v4.260522.2" but the on-disk binary at
// `~/.genie/bin/genie` remained v4.260520.3 (mtime unchanged), and the
// subsequent PATH advisory suggested `ln -sf <path> <path>` — a self-symlink.
//
// Root causes:
//   1. runDelivery printed success based on `manifest.version` (intent),
//      never re-reading the swapped binary.
//   2. The PATH heuristic did not guard against `live === canonical`, so a
//      version mismatch caused by a botched swap was misdiagnosed as a PATH
//      problem and rendered as `ln -sf X X`.
//
// Both helpers below are pure and injectable so the regression is locked in
// without spawning a real `genie` binary.
// ============================================================================

describe('verifySwappedBinary (post-swap correctness guard)', () => {
  test('returns void when reported version matches expected', () => {
    expect(() =>
      verifySwappedBinary('/fake/path/genie', '4.260522.2', {
        runVersion: () => '4.260522.2\n',
      }),
    ).not.toThrow();
  });

  test('strips build metadata before comparison (normalizeVersion parity)', () => {
    expect(() =>
      verifySwappedBinary('/fake/path/genie', '4.260522.2', {
        runVersion: () => '4.260522.2+abc1234\n',
      }),
    ).not.toThrow();
  });

  test('throws with intended-vs-on-disk diff when version mismatches', () => {
    expect(() =>
      verifySwappedBinary('/fake/path/genie', '4.260522.2', {
        runVersion: () => '4.260520.3\n',
        stagingDir: '/tmp/staging',
        previousDir: '/tmp/previous',
      }),
    ).toThrow(/Intended: v4\.260522\.2[\s\S]*On disk : v4\.260520\.3/);
  });

  test('mismatch message includes staging + previous hints for forensics', () => {
    let captured: string | null = null;
    try {
      verifySwappedBinary('/fake/path/genie', '4.260522.2', {
        runVersion: () => '4.260520.3\n',
        stagingDir: '/home/genie/.genie/bin/.staging',
        previousDir: '/home/genie/.genie/bin/.previous',
      });
    } catch (err) {
      captured = err instanceof Error ? err.message : String(err);
    }
    expect(captured).toContain('/home/genie/.genie/bin/.staging');
    expect(captured).toContain('/home/genie/.genie/bin/.previous');
  });

  test('throws when binary cannot be executed (wraps underlying error)', () => {
    expect(() =>
      verifySwappedBinary('/fake/path/genie', '4.260522.2', {
        runVersion: () => {
          throw new Error('ENOENT: no such file');
        },
      }),
    ).toThrow(/Post-swap verification failed.*could not execute.*ENOENT/);
  });

  test('throws when binary runs but emits no parseable version', () => {
    expect(() =>
      verifySwappedBinary('/fake/path/genie', '4.260522.2', {
        runVersion: () => 'banner with no version string\n',
      }),
    ).toThrow(/emitted no parsable version/);
  });
});

describe('syncBinaryVersionStamp (binary-sibling VERSION file)', () => {
  // The compiled binary reads `dirname(process.execPath)/VERSION` at startup
  // (src/lib/version.ts). The atomic swap replaces `genie` but leaves the
  // sibling VERSION stamp untouched — so without this sync, the new binary
  // reports the OLD version until something else rewrites the stamp. These
  // tests pin the contract so a future "simplification" can't remove it.

  test('copies VERSION from extractDir → binDir when the tarball ships one', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'genie-stamp-'));
    try {
      const extractDir = join(tmp, 'extract');
      const binDir = join(tmp, 'bin');
      mkdirSync(extractDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(extractDir, 'VERSION'), '4.260522.3\n');
      // Pre-existing stale stamp the swap left behind:
      writeFileSync(join(binDir, 'VERSION'), '4.260520.3\n');

      syncBinaryVersionStamp(extractDir, binDir, '4.260522.3');

      expect(readFileSync(join(binDir, 'VERSION'), 'utf-8').trim()).toBe('4.260522.3');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('falls back to writing manifestVersion when tarball is missing VERSION', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'genie-stamp-'));
    try {
      const extractDir = join(tmp, 'extract');
      const binDir = join(tmp, 'bin');
      mkdirSync(extractDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      // No VERSION file in extractDir — simulates an older build that
      // pre-dates the G1 stamp convention.
      writeFileSync(join(binDir, 'VERSION'), '4.260520.3\n');

      syncBinaryVersionStamp(extractDir, binDir, '4.260522.3');

      expect(readFileSync(join(binDir, 'VERSION'), 'utf-8').trim()).toBe('4.260522.3');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('first install (binDir has no prior VERSION) — creates the stamp', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'genie-stamp-'));
    try {
      const extractDir = join(tmp, 'extract');
      const binDir = join(tmp, 'bin');
      mkdirSync(extractDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(extractDir, 'VERSION'), '4.260522.3\n');

      syncBinaryVersionStamp(extractDir, binDir, '4.260522.3');

      expect(existsSync(join(binDir, 'VERSION'))).toBe(true);
      expect(readFileSync(join(binDir, 'VERSION'), 'utf-8').trim()).toBe('4.260522.3');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('preserves the tarball stamp byte-for-byte (no normalisation)', () => {
    // The G1 build pipeline may include build metadata (`+sha`) or trailing
    // newlines we don't want to silently strip. Copy verbatim.
    const tmp = mkdtempSync(join(tmpdir(), 'genie-stamp-'));
    try {
      const extractDir = join(tmp, 'extract');
      const binDir = join(tmp, 'bin');
      mkdirSync(extractDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      const exotic = '4.260522.3+abc1234\n';
      writeFileSync(join(extractDir, 'VERSION'), exotic);

      syncBinaryVersionStamp(extractDir, binDir, '4.260522.3');

      expect(readFileSync(join(binDir, 'VERSION'), 'utf-8')).toBe(exotic);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('swallows fs errors (best-effort; verifySwappedBinary catches mismatch)', () => {
    // Pass an extractDir that exists but a binDir that doesn't — copy will
    // fail, write fallback will also fail. Should not throw.
    const tmp = mkdtempSync(join(tmpdir(), 'genie-stamp-'));
    try {
      const extractDir = join(tmp, 'extract');
      const binDir = join(tmp, 'nonexistent', 'bin');
      mkdirSync(extractDir, { recursive: true });
      writeFileSync(join(extractDir, 'VERSION'), '4.260522.3\n');

      expect(() => syncBinaryVersionStamp(extractDir, binDir, '4.260522.3')).not.toThrow();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('shouldEmitPathDivergenceWarning (self-symlink suppression)', () => {
  const canonical = '/home/genie/.genie/bin/genie';

  test('suppresses when live is null (nothing on PATH)', () => {
    expect(
      shouldEmitPathDivergenceWarning({
        live: null,
        canonical,
        canonicalReal: canonical,
        liveVersion: '4.260520.3',
        intendedVersion: '4.260522.2',
      }),
    ).toBe(false);
  });

  test('suppresses when live version is unknown', () => {
    expect(
      shouldEmitPathDivergenceWarning({
        live: '/usr/local/bin/genie',
        canonical,
        canonicalReal: canonical,
        liveVersion: null,
        intendedVersion: '4.260522.2',
      }),
    ).toBe(false);
  });

  test('suppresses when versions match (PATH is fine)', () => {
    expect(
      shouldEmitPathDivergenceWarning({
        live: '/usr/local/bin/genie',
        canonical,
        canonicalReal: canonical,
        liveVersion: '4.260522.2',
        intendedVersion: '4.260522.2',
      }),
    ).toBe(false);
  });

  test('suppresses when live === canonical (the self-symlink bug)', () => {
    expect(
      shouldEmitPathDivergenceWarning({
        live: canonical,
        canonical,
        canonicalReal: canonical,
        liveVersion: '4.260520.3',
        intendedVersion: '4.260522.2',
      }),
    ).toBe(false);
  });

  test('suppresses when live === canonicalReal (canonical is itself a symlink)', () => {
    const realTarget = '/opt/genie/bin/genie';
    expect(
      shouldEmitPathDivergenceWarning({
        live: realTarget,
        canonical,
        canonicalReal: realTarget,
        liveVersion: '4.260520.3',
        intendedVersion: '4.260522.2',
      }),
    ).toBe(false);
  });

  test('emits when paths differ AND versions disagree (legitimate PATH shadow)', () => {
    expect(
      shouldEmitPathDivergenceWarning({
        live: '/usr/local/bin/genie',
        canonical,
        canonicalReal: canonical,
        liveVersion: '4.260000.0',
        intendedVersion: '4.260522.2',
      }),
    ).toBe(true);
  });

  test('normalizes build metadata when comparing versions', () => {
    expect(
      shouldEmitPathDivergenceWarning({
        live: '/usr/local/bin/genie',
        canonical,
        canonicalReal: canonical,
        liveVersion: '4.260522.2+abc',
        intendedVersion: '4.260522.2',
      }),
    ).toBe(false);
  });
});

// ============================================================================
// Post-swap v4 legacy cleanup wiring (G8 fix). v5 machines upgrade through
// `genie update`, never by re-running install.sh, so the upgrade path must
// invoke the same cleanup seam the installer does — and a cleanup failure
// must never fail a completed update.
// ============================================================================

describe('runV4CleanupSafe', () => {
  const stubResult = {
    report: { rulesFile: { path: '/fixture', status: 'absent' as const }, cacheDirs: [], hasRelics: false },
    homeResidue: [],
    actions: [],
    backupDir: null,
    logFile: null,
    noOp: true,
  };

  test('invokes the injected v4 cleanup runner exactly once', () => {
    let calls = 0;
    runV4CleanupSafe(() => {
      calls += 1;
      return stubResult;
    });
    expect(calls).toBe(1);
  });

  test('a cleanup throw does not fail the update', () => {
    expect(() =>
      runV4CleanupSafe(() => {
        throw new Error('boom');
      }),
    ).not.toThrow();
  });

  test('updateCommand calls the cleanup seam before the post-update verify', () => {
    // Wiring lock: the seam runs after a successful delivery and before
    // runPostUpdateVerifySafe. Source-level assertion — running the real
    // updateCommand would hit the network.
    const source = readFileSync(join(import.meta.dir, '..', 'update.ts'), 'utf-8');
    const callIdx = source.indexOf('runV4CleanupSafe();');
    const verifyIdx = source.indexOf('await runPostUpdateVerifySafe(');
    expect(callIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeLessThan(verifyIdx);
  });
});

// ============================================================================
// Agent-sync wiring (agent-sync wish G2). `genie update` is the ONE canonical
// updater: the bounded sync phase runs on --sync-only, while a manual full
// update converges integrations in the reviewed parent process. A newly
// installed binary is never re-entered as `genie update`.
// ============================================================================

describe('runAgentSyncSafe (agent-sync phase)', () => {
  function makeReport(): AgentSyncReport {
    return {
      source: { pluginRoot: '/home/.genie/plugins/genie', hermesRoot: null, version: '5.0.0' },
      agents: [
        {
          agent: 'claude',
          detected: true,
          skills: [
            { name: 'wish', action: 'created' },
            { name: 'work', action: 'updated' },
            { name: 'review', action: 'created' },
          ],
          extras: [{ kind: 'stamp', action: 'written', detail: '/x/council.js' }],
          advisories: [],
        },
        { agent: 'codex', detected: false, skills: [], extras: [], advisories: [] },
        {
          agent: 'hermes',
          detected: true,
          skills: [],
          extras: [{ kind: 'symlink', action: 'created' }],
          advisories: ['hermes plugins enable genie failed: boom'],
        },
      ],
      backupsDir: null,
    };
  }

  test('runs the injected engine and prints a compact per-agent summary', () => {
    const lines: string[] = [];
    const marker = join(mkdtempSync(join(tmpdir(), 'genie-asm-')), '.last-agent-sync');
    runAgentSyncSafe({ sync: makeReport, log: (l) => lines.push(l), markerPath: marker });
    const joined = lines.join('\n');
    expect(joined).toContain('claude');
    expect(joined).toContain('created 2');
    expect(joined).toContain('updated 1');
    expect(joined).toContain('codex not detected');
    expect(joined).toContain('hermes plugins enable genie failed'); // advisory surfaced
  });

  test('an engine throw is non-fatal and reported as an advisory', () => {
    const lines: string[] = [];
    const marker = join(mkdtempSync(join(tmpdir(), 'genie-asm-')), '.last-agent-sync');
    expect(() =>
      runAgentSyncSafe({
        sync: () => {
          throw new Error('boom');
        },
        log: (l) => lines.push(l),
        markerPath: marker,
      }),
    ).not.toThrow();
    expect(lines.join('\n')).toContain('agent sync failed: boom');
  });

  test('refreshes the ~/.genie/.last-agent-sync marker with an ISO timestamp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'genie-asm-'));
    const marker = join(dir, '.last-agent-sync');
    try {
      runAgentSyncSafe({
        sync: makeReport,
        log: () => {},
        markerPath: marker,
        now: () => new Date('2026-07-10T00:00:00.000Z'),
      });
      expect(readFileSync(marker, 'utf-8').trim()).toBe('2026-07-10T00:00:00.000Z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('marker is not refreshed when convergence fails so the retry remains immediate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'genie-asm-'));
    const marker = join(dir, '.last-agent-sync');
    try {
      runAgentSyncSafe({
        sync: () => {
          throw new Error('x');
        },
        log: () => {},
        markerPath: marker,
      });
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('updateCommand runs the sync-only fast path before any network/delivery', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'update.ts'), 'utf-8');
    const cmdStart = source.indexOf('export async function updateCommand');
    const cmdBody = source.slice(cmdStart);
    const fastPathIdx = cmdBody.indexOf("mode !== 'normal'");
    const fetchIdx = cmdBody.indexOf('await fetchLatestManifest(');
    const deliveryIdx = cmdBody.indexOf('await runDelivery(');
    expect(fastPathIdx).toBeGreaterThan(-1);
    expect(fastPathIdx).toBeLessThan(fetchIdx);
    expect(fastPathIdx).toBeLessThan(deliveryIdx);
    // The fast-path block calls the sync phase (and only that path does, pre-fetch).
    const fastPath = cmdBody.slice(fastPathIdx, fetchIdx);
    expect(fastPath).toContain('runAgentSyncSafe({ strict: true, selection })');
    expect(fastPath).not.toContain('runTrackedManualUpdateConvergence(');
    expect(fastPath).not.toContain('refreshUpdatePlugins(');
  });

  test('short-circuit (already-current) path calls the sync phase before returning', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'update.ts'), 'utf-8');
    const scIdx = source.indexOf('shortCircuitIfCurrent(installedVersion, latestVersion)');
    expect(scIdx).toBeGreaterThan(-1);
    expect(source.slice(scIdx, scIdx + 700)).toContain('runTrackedManualUpdateConvergence(');
  });
});

describe('manual post-update convergence (2026-07-11 cascade regression)', () => {
  test('runs reviewed parent-side APIs and returns structured integration outcomes', () => {
    const calls: string[] = [];
    const result = runManualUpdateConvergence({
      expectedVersion: '5.260711.3',
      bundleRoot: '/tmp/verified-bundle',
      runSync: () => calls.push('parent-safe-sync'),
      refreshPlugins: (options) => {
        calls.push(`parent-plugin-refresh:${options.expectedVersion}`);
        return [{ runtime: 'codex', ok: true, detail: 'plugin/hooks refreshed' }];
      },
      log: (line) => calls.push(`log:${line}`),
    });
    expect(calls[0]).toBe('parent-safe-sync');
    expect(calls[1]).toBe('parent-plugin-refresh:5.260711.3');
    expect(result.integrations).toEqual([{ runtime: 'codex', ok: true, detail: 'plugin/hooks refreshed' }]);
  });

  test('never executes an older fresh binary as full update based only on an environment marker', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'update.ts'), 'utf-8');
    // Incident: parent installed 5.260710.2, then child ignored
    // GENIE_UPDATE_SYNC_ONLY and performed a second full update to 5.260711.3.
    expect(source).not.toContain('runFreshBinaryAgentSync');
    expect(source).not.toMatch(/execFileSync\([^\n]+,\s*\['update'\]/);
    const verifyIdx = source.indexOf('await runPostUpdateVerifySafe(');
    const convergeIdx = source.lastIndexOf('runTrackedManualUpdateConvergence(', verifyIdx);
    expect(convergeIdx).toBeGreaterThan(-1);
    expect(convergeIdx).toBeLessThan(verifyIdx);
  });
});

describe('operator-driven plugin refresh', () => {
  let pluginStateDir: string;

  beforeEach(() => {
    pluginStateDir = mkdtempSync(join(tmpdir(), 'genie-update-plugin-state-'));
  });

  afterEach(() => {
    rmSync(pluginStateDir, { recursive: true, force: true });
  });

  test('CLI detection is not consent: validly absent integrations remain absent', () => {
    const calls: string[] = [];
    const results = refreshUpdatePlugins({
      bundleRoot: '/tmp/fixture-bundle',
      expectedVersion: '5.260711.3',
      stateDir: pluginStateDir,
      detected: { codex: true, claude: true },
      runner(command, args) {
        calls.push(`${command} ${args.join(' ')}`);
        if (command === 'codex') return { exitCode: 0, stdout: '{"installed":[]}', stderr: '' };
        return { exitCode: 0, stdout: '[]', stderr: '' };
      },
    });

    expect(results).toEqual([]);
    expect(calls).toEqual(['codex plugin list --json', 'claude plugin list --json']);
  });

  test('a Codex resolver failure does not suppress the independently selected Claude refresh', () => {
    const resolved: string[] = [];
    const calls: string[] = [];
    const results = refreshUpdatePlugins({
      bundleRoot: '/tmp/fixture-bundle',
      expectedVersion: '5.260711.3',
      stateDir: pluginStateDir,
      selection: 'all',
      detected: { codex: true, claude: true },
      resolveExecutable(name) {
        resolved.push(name);
        if (name === 'codex') throw new Error('unsafe Codex executable');
        return '/fixture/claude';
      },
      runner(command, args) {
        calls.push(`${command} ${args.join(' ')}`);
        return { exitCode: 0, stdout: '[]', stderr: '' };
      },
    });

    expect(resolved).toEqual(['codex', 'claude']);
    expect(calls).toEqual(['/fixture/claude plugin list --json']);
    expect(results).toEqual([{ runtime: 'codex', ok: false, detail: 'unsafe Codex executable' }]);
  });

  test('indeterminate pre-update state fails closed without installing either integration', () => {
    const calls: string[] = [];
    const results = refreshUpdatePlugins({
      bundleRoot: '/tmp/fixture-bundle',
      expectedVersion: '5.260711.3',
      stateDir: pluginStateDir,
      detected: { codex: true, claude: true },
      runner(command, args) {
        calls.push(`${command} ${args.join(' ')}`);
        return { exitCode: 0, stdout: '{}', stderr: '' };
      },
    });

    expect(results).toHaveLength(2);
    expect(results.every((result) => !result.ok && result.detail.includes('malformed JSON'))).toBe(true);
    expect(calls).toEqual(['codex plugin list --json', 'claude plugin list --json']);
  });

  test('recaches Codex plugin/hooks from the local bundle and preserves disabled state', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-update-plugin-refresh-'));
    const configPath = join(root, 'config.toml');
    writeFileSync(configPath, '[plugins."genie@automagik"]\nenabled = true\n');
    const calls: string[] = [];
    let lists = 0;
    const runner: CommandRunner = (command, args) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (args.join(' ') === 'plugin list --json') {
        lists += 1;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            installed: [
              {
                pluginId: 'genie@automagik',
                enabled: lists === 2,
                version: lists === 1 ? '5.260710.2' : '5.260711.3',
              },
            ],
          }),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    try {
      const results = refreshUpdatePlugins({
        bundleRoot: root,
        expectedVersion: '5.260711.3',
        stateDir: pluginStateDir,
        detected: { codex: true, claude: false },
        codexConfigPath: configPath,
        runner,
      });
      expect(results).toEqual([
        {
          runtime: 'codex',
          ok: true,
          detail: 'plugin/hooks refreshed to v5.260711.3',
          preservedDisabled: true,
        },
      ]);
      expect(calls).toContain(`codex plugin marketplace add ${root} --json`);
      expect(calls).toContain('codex plugin add genie@automagik --json');
      expect(readFileSync(configPath, 'utf8')).toContain('enabled = false');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('returns a structured timed-out integration result', () => {
    const results = refreshUpdatePlugins({
      bundleRoot: '/tmp/fixture-bundle',
      expectedVersion: '5.260711.3',
      stateDir: pluginStateDir,
      detected: { codex: true, claude: false },
      runner: () => ({ exitCode: 1, stdout: '', stderr: '', timedOut: true }),
    });
    expect(results[0]).toMatchObject({ runtime: 'codex', ok: false, timedOut: true });
    expect(results[0].detail).toContain('timed out');
  });

  test('malformed Codex post-refresh state fails and still restores the prior disabled state', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-update-plugin-failed-refresh-'));
    const configPath = join(root, 'config.toml');
    writeFileSync(configPath, '[plugins."genie@automagik"]\nenabled = true\n');
    let lists = 0;
    try {
      const results = refreshUpdatePlugins({
        bundleRoot: root,
        expectedVersion: '5.260711.3',
        stateDir: pluginStateDir,
        detected: { codex: true, claude: false },
        codexConfigPath: configPath,
        runner(_command, args) {
          if (args.join(' ') === 'plugin list --json') {
            lists += 1;
            return {
              exitCode: 0,
              stdout:
                lists === 1
                  ? '{"installed":[{"pluginId":"genie@automagik","enabled":false,"version":"5.260710.2"}]}'
                  : '{"unexpected":[]}',
              stderr: '',
            };
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      });

      expect(results[0]).toMatchObject({ runtime: 'codex', ok: false });
      expect(results[0]?.detail).toMatch(/malformed JSON.*after plugin add/);
      expect(readFileSync(configPath, 'utf8')).toContain('enabled = false');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a failed Codex re-add remains durable and converges on the next invocation', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-update-plugin-retry-'));
    let installed = true;
    let version = '5.260710.2';
    let addCalls = 0;
    const runner: CommandRunner = (_command, args) => {
      const command = args.join(' ');
      if (command === 'plugin list --json') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            installed: installed ? [{ pluginId: 'genie@automagik', enabled: true, version }] : [],
          }),
          stderr: '',
        };
      }
      if (command === 'plugin remove genie@automagik --json') {
        installed = false;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (command === 'plugin add genie@automagik --json') {
        addCalls += 1;
        if (addCalls === 2) return { exitCode: 7, stdout: '', stderr: 'transient cache failure' };
        if (!installed) {
          installed = true;
          version = '5.260711.3';
        }
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    try {
      const first = refreshUpdatePlugins({
        bundleRoot: root,
        expectedVersion: '5.260711.3',
        stateDir: pluginStateDir,
        detected: { codex: true, claude: false },
        runner,
      });
      expect(first[0]).toMatchObject({ runtime: 'codex', ok: false });
      expect(installed).toBe(false);
      expect(existsSync(join(pluginStateDir, '.integration-refresh-codex.json'))).toBe(true);

      const second = refreshUpdatePlugins({
        bundleRoot: root,
        expectedVersion: '5.260711.3',
        stateDir: pluginStateDir,
        detected: { codex: true, claude: false },
        runner,
      });
      expect(second[0]).toMatchObject({ runtime: 'codex', ok: true });
      expect(installed).toBe(true);
      expect(existsSync(join(pluginStateDir, '.integration-refresh-codex.json'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('actively restores and verifies a disabled Claude plugin after refresh', () => {
    const calls: string[] = [];
    const timeouts: Array<number | undefined> = [];
    let lists = 0;
    const results = refreshUpdatePlugins({
      bundleRoot: '/tmp/fixture-bundle',
      expectedVersion: '5.260711.3',
      stateDir: pluginStateDir,
      detected: { codex: false, claude: true },
      timeoutMs: 777,
      runner(command, args, options) {
        calls.push(`${command} ${args.join(' ')}`);
        timeouts.push(options?.timeoutMs);
        if (args.join(' ') === 'plugin list --json') {
          lists += 1;
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                id: 'genie@automagik',
                enabled: lists === 1 ? false : lists === 2,
                version: lists === 1 ? '5.260710.2' : '5.260711.3',
              },
            ]),
            stderr: '',
          };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(results).toEqual([
      {
        runtime: 'claude',
        ok: true,
        detail: 'plugin/hooks refreshed to v5.260711.3',
        preservedDisabled: true,
      },
    ]);
    expect(calls).toEqual([
      'claude plugin list --json',
      'claude plugin marketplace add /tmp/fixture-bundle',
      'claude plugin update genie@automagik',
      'claude plugin list --json',
      'claude plugin disable genie@automagik',
      'claude plugin list --json',
    ]);
    expect(timeouts.every((timeout) => timeout === 777)).toBe(true);
  });

  test('Claude disable command failure is a structured refresh failure, not preservation fiction', () => {
    let lists = 0;
    const results = refreshUpdatePlugins({
      bundleRoot: '/tmp/fixture-bundle',
      expectedVersion: '5.260711.3',
      stateDir: pluginStateDir,
      detected: { codex: false, claude: true },
      runner(_command, args) {
        if (args.join(' ') === 'plugin list --json') {
          lists += 1;
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                id: 'genie@automagik',
                enabled: lists !== 1,
                version: lists === 1 ? '5.260710.2' : '5.260711.3',
              },
            ]),
            stderr: '',
          };
        }
        if (args.join(' ') === 'plugin disable genie@automagik') {
          return { exitCode: 1, stdout: '', stderr: 'disable refused' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(results[0]).toMatchObject({ runtime: 'claude', ok: false });
    expect(results[0]?.detail).toContain('disable refused');
    expect(results[0]?.preservedDisabled).not.toBe(true);
  });

  test('Claude post-disable state must verify disabled before preservation is reported', () => {
    let lists = 0;
    const results = refreshUpdatePlugins({
      bundleRoot: '/tmp/fixture-bundle',
      expectedVersion: '5.260711.3',
      stateDir: pluginStateDir,
      detected: { codex: false, claude: true },
      runner(_command, args) {
        if (args.join(' ') === 'plugin list --json') {
          lists += 1;
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                id: 'genie@automagik',
                enabled: lists !== 1,
                version: lists === 1 ? '5.260710.2' : '5.260711.3',
              },
            ]),
            stderr: '',
          };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(lists).toBe(3);
    expect(results[0]).toMatchObject({ runtime: 'claude', ok: false });
    expect(results[0]?.detail).toContain('disabled-state restore verification failed');
    expect(results[0]?.preservedDisabled).not.toBe(true);
  });
});

// ============================================================================
// Scheduler-signal age filter (wish v4-home-residue-doctor): a June disk-full
// incident must not resurface as "Recent scheduler signals" weeks later.
// ============================================================================

describe('summarizeJsonlSignals age filter', () => {
  const HOUR = 60 * 60 * 1000;
  const NOW = Date.parse('2026-07-05T12:00:00.000Z');
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sched-age-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeLog(entries: Array<{ level: string; event: string; ageHours?: number; error?: string }>): string {
    const path = join(dir, 'scheduler.log');
    const lines = entries.map((e) => {
      const timestamp = e.ageHours === undefined ? undefined : new Date(NOW - e.ageHours * HOUR).toISOString();
      return JSON.stringify({ level: e.level, event: e.event, timestamp, error: e.error });
    });
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf-8');
    return path;
  }

  test('only-stale log → zero signals, newest stale timestamp reported', () => {
    const path = writeLog([
      { level: 'error', event: 'disk.full', ageHours: 320, error: 'ENOSPC' },
      { level: 'error', event: 'disk.full', ageHours: 313, error: 'ENOSPC' },
    ]);
    const summary = summarizeJsonlSignals(path, NOW);
    expect(summary.signals).toHaveLength(0);
    expect(summary.newestStaleTimestamp).toBe(new Date(NOW - 313 * HOUR).toISOString());
  });

  test('mixed log → only fresh entries summarized', () => {
    const path = writeLog([
      { level: 'error', event: 'disk.full', ageHours: 320, error: 'ENOSPC' },
      { level: 'warn', event: 'queue.slow', ageHours: 3 },
    ]);
    const summary = summarizeJsonlSignals(path, NOW);
    expect(summary.signals.map((s) => s.event)).toEqual(['queue.slow']);
    expect(summary.newestStaleTimestamp).toBe(new Date(NOW - 320 * HOUR).toISOString());
  });

  test('48h boundary: exactly 48h kept, just past excluded', () => {
    const path = writeLog([
      { level: 'error', event: 'at.boundary', ageHours: 48 },
      { level: 'error', event: 'past.boundary', ageHours: 48.001 },
    ]);
    const summary = summarizeJsonlSignals(path, NOW);
    expect(summary.signals.map((s) => s.event)).toEqual(['at.boundary']);
    expect(summary.newestStaleTimestamp).not.toBeNull();
  });

  test('entries without a parseable timestamp are kept — staleness must be proven', () => {
    const path = writeLog([{ level: 'error', event: 'no.timestamp' }]);
    const summary = summarizeJsonlSignals(path, NOW);
    expect(summary.signals.map((s) => s.event)).toEqual(['no.timestamp']);
    expect(summary.newestStaleTimestamp).toBeNull();
  });
});
