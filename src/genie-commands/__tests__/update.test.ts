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

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeDirDigest, computeFileDigest } from '../../lib/atomic-fs';
import { acquireLifecycleLease, currentSyncLockHostId, lifecycleLockPath } from '../../lib/lifecycle-lease';
import type { IntegrationSelection } from '../../lib/runtime-integrations';
import {
  SKILLS_CLI_VERSION,
  type SkillsChannelConvergenceResult,
  releaseTag,
  writeSkillsInstallRecord,
} from '../../lib/skills-installer.js';
import { VERSION } from '../../lib/version';
import type { AuxiliaryTreeOutcome, AuxiliaryTreeStage } from '../auxiliary-trees.js';
import {
  DeliveryPublicationError,
  type LatestManifest,
  type VerifyResult,
  _resetNextDeprecationLatchForTest,
  applyConvergenceExitSignal,
  compareVersions,
  createPrivateUpdateTempRoot,
  decideDowngrade,
  decideVerify,
  downloadAndVerifyTarball,
  ensureCanonicalInstall,
  extractTarball,
  fetchLatestManifest,
  finalizeAuxiliaryDelivery,
  formatVerifyBanner,
  hashPhysicalFileIncrementally,
  isGenieProcessSnapshotLine,
  manifestUrlForChannel,
  narrowUpdatePluginRefreshSelection,
  normalizeVersion,
  persistChannel,
  refreshOrcaOwnershipAfterDelivery,
  resolveChannel,
  resolveLiveBinaryPath,
  resolvePlatformId,
  resolveUpdateExecutionMode,
  resumePendingDelivery,
  rollbackBinaryAt,
  runFreshBinaryPostDeliveryConvergence,
  runManualUpdateConvergence,
  runNormalUpdatePublicationBoundary,
  runV4CleanupSafe,
  runVerifyProbe,
  shortCircuitIfCurrent,
  shouldEmitPathDivergenceWarning,
  summarizeJsonlSignals,
  syncAuxiliaryContent,
  updateCommand,
} from '../update.js';

/**
 * Every `runManualUpdateConvergence` test injects this: the production default
 * shells out to the pinned skills CLI over the network, which no unit test may
 * do. Group 1's own behavior is covered by the skills.sh describe below and by
 * `src/lib/skills-installer.test.ts`.
 */
const noSkillsChannel = (): SkillsChannelConvergenceResult => ({ status: 'skipped', reason: 'test fixture' });

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
    const downloadIdx = cmdBody.indexOf('dependencies.downloadDeliveryAssets ?? downloadAndVerifyDeliveryAssets');
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
  const commandManifest: LatestManifest = {
    schema_version: 1,
    channel: 'stable',
    version: '5.260723.8',
    released_at: '2026-07-23T00:00:00Z',
    tarball_base: 'https://github.com/automagik-dev/genie/releases/download/v5.260723.8',
    platforms: ['darwin-arm64'],
    manifestBytes: '{"version":"5.260723.8"}\n',
    manifestSha256: 'a'.repeat(64),
  };

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

  test('the already-current terminal reports, converges once, and returns', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    const branch = source.slice(source.indexOf('export async function handleAlreadyCurrentUpdate'));
    // The activation handoff left with the Codex plugin lifecycle: the
    // already-current path is now report + one convergence + marker retirement.
    expect(branch).not.toContain('activation is pending');
    expect(branch).toContain('Already up to date');
    expect(branch).toContain('runConvergence');
    expect(branch).toContain('retireLegacyMarker');
  });

  test('"Already up to date" exit logs version and channel', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    expect(source).toContain('Already up to date');
    // The short-circuit must key off the INSTALLED binary version, not the
    // running process's compile-time VERSION — otherwise a stale shadowing
    // binary on $PATH re-offers the same update forever.
    expect(source).toContain('shortCircuitIfCurrent(installedVersion, latestVersion)');
    expect(source).toContain(
      'const installedVersion = (dependencies.readInstalledVersion ?? resolveInstalledVersion)()',
    );
  });

  test('--rollback short-circuits before downloading anything', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    // Anchor on updateCommand's body, not the function declaration.
    const cmdStart = source.indexOf('export async function updateCommand');
    expect(cmdStart).toBeGreaterThan(-1);
    const cmdBody = source.slice(cmdStart);
    const explicitModeIdx = cmdBody.indexOf('await dispatchNonNormalUpdateMode(options)');
    const fetchIdx = cmdBody.indexOf('dependencies.fetchManifest ?? fetchLatestManifest');
    expect(explicitModeIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(explicitModeIdx).toBeLessThan(fetchIdx);
    const dispatcher = source.slice(
      source.indexOf('async function dispatchNonNormalUpdateMode'),
      source.indexOf('async function confirmPlannedDelivery'),
    );
    expect(dispatcher).toContain('await runExplicitUpdateMode(mode)');
    const explicitMode = source.slice(
      source.indexOf('async function runExplicitUpdateMode'),
      source.indexOf('async function dispatchNonNormalUpdateMode'),
    );
    expect(explicitMode).toContain("if (mode === 'rollback') terminal = await runRollback()");
  });

  test('no hard process exit is reachable while normal or explicit update leases are held', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    const normalStart = source.indexOf('const acquired = acquireUpdateLifecycleLeasesOrProject(dependencies);');
    const normalEnd = source.indexOf('\n/**\n * Post-swap v4 legacy cleanup', normalStart);
    const explicitStart = source.indexOf('async function runExplicitUpdateMode');
    const explicitEnd = source.indexOf('\nasync function dispatchNonNormalUpdateMode', explicitStart);
    expect(normalStart).toBeGreaterThan(-1);
    expect(normalEnd).toBeGreaterThan(normalStart);
    expect(explicitStart).toBeGreaterThan(-1);
    expect(explicitEnd).toBeGreaterThan(explicitStart);
    expect(source.slice(normalStart, normalEnd)).not.toContain('process.exit(');
    expect(source.slice(explicitStart, explicitEnd)).not.toContain('process.exit(');
    expect(source.slice(normalStart, normalEnd)).toContain('projectDeferredUpdateTerminal(terminal)');
    expect(source.slice(explicitStart, explicitEnd)).toContain('projectDeferredUpdateTerminal(terminal)');
  });

  const BUSY_LOCK_PATH = '/fixture/home/.genie-lifecycle-0123456789abcdef.lock';
  const busyLeaseSkip = {
    skipped: `another Genie process holds the lock at ${BUSY_LOCK_PATH}; retry shortly, or remove the file if its owner has crashed`,
    cause: 'held' as const,
  };

  test('a live lease holder past the wait deadline exits 2 with an actionable line and no thrown error', async () => {
    const priorExitCode = process.exitCode;
    const priorWait = process.env.GENIE_LIFECYCLE_LEASE_WAIT_MS;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const events: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => stdout.push(args.join(' ')));
    const errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => stderr.push(args.join(' ')));
    process.exitCode = undefined;
    // Millisecond-scale so the bounded poll is exercised, not endured. 500ms
    // (not 60ms) so a GC/scheduler pause cannot collapse the 25ms poll loop to
    // a single attempt and flake the `attempts > 1` assertion.
    process.env.GENIE_LIFECYCLE_LEASE_WAIT_MS = '500';
    let attempts = 0;
    let thrown: unknown;
    try {
      await updateCommand(
        { yes: true, stable: true },
        {
          fetchManifest: async () => commandManifest,
          readInstalledVersion: () => '5.260700.1',
          resolvePlatform: () => 'darwin-arm64',
          acquireLease: () => {
            attempts += 1;
            return busyLeaseSkip;
          },
          recoverPendingState: () => events.push('MUTATION:recovery'),
          persistSelectedChannel: async () => {
            events.push('MUTATION:channel');
          },
          requireCanonicalInstall: () => events.push('MUTATION:canonical'),
          deliverSelectedManifest: async () => {
            events.push('MUTATION:delivery');
            return [];
          },
          finalizeSelectedDelivery: async () => {
            events.push('MUTATION:finalize');
            return true;
          },
        },
      ).catch((error: unknown) => {
        thrown = error;
      });

      // Graceful projection, not an escaping throw or a hard process.exit.
      expect(thrown).toBeUndefined();
      expect(Number(process.exitCode)).toBe(2);
      expect(events).toEqual([]);
      // The refusal was polled, not answered on the first look.
      expect(attempts).toBeGreaterThan(1);

      const output = [...stdout, ...stderr].join('\n');
      expect(output).toContain('Another Genie lifecycle command is active');
      expect(output).toContain('holds the lock');
      expect(output).toContain(BUSY_LOCK_PATH);
      // The misleading reassurance is gone, and a lease holder is never
      // relabelled as a Codex refusal (install.sh parses that machine code).
      expect(output).not.toContain('the holder converges the same targets');
      expect(output).not.toContain('codex-lifecycle-busy');
      expect(output).not.toContain('schemaVersion');
      // No stack trace reached the terminal.
      expect(output).not.toContain('DeferredUpdateTerminal');
      expect(output).not.toMatch(/\n\s+at /);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.exitCode = priorExitCode;
      if (priorWait === undefined) Reflect.deleteProperty(process.env, 'GENIE_LIFECYCLE_LEASE_WAIT_MS');
      else process.env.GENIE_LIFECYCLE_LEASE_WAIT_MS = priorWait;
    }
  });

  test('post-promotion publication failure is nonzero, emits one false trailer, and runs no success finalizer', async () => {
    const priorExitCode = process.exitCode;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => stdout.push(args.join(' ')));
    const errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => stderr.push(args.join(' ')));
    let successFinalizers = 0;
    process.exitCode = undefined;
    try {
      const complete = await runNormalUpdatePublicationBoundary(
        async () => {
          throw new DeliveryPublicationError('delivery store is unwritable');
        },
        async () => {
          successFinalizers += 1; // includes marker retirement in the real command boundary
          return true;
        },
      );
      expect(complete).toBe(false);
      expect(Number(process.exitCode)).toBe(1);
      expect(successFinalizers).toBe(0);
      const output = [...stdout, ...stderr].join('\n');
      expect(output).toContain('delivery store is unwritable');
      expect(output.match(/"deliveryComplete":false/g)).toHaveLength(1);
      expect(output).not.toContain('Already up to date');
      expect(output).not.toContain('Update complete');
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.exitCode = priorExitCode ?? 0;
    }
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

  test('dev gets its own per-channel file', () => {
    // Canonical taxonomy: stable / dev. beta + canary + homolog retired —
    // no longer accepted by the ReleaseChannel type.
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
  //
  // Isolated under a tmp GENIE_HOME so persistChannel never reads or writes the
  // developer's real ~/.genie/config.json (which would flip a dev-channel user
  // to stable and could materialize a default config on a clean machine).
  let dir: string;
  let prevGenieHome: string | undefined;

  beforeEach(() => {
    prevGenieHome = process.env.GENIE_HOME;
    dir = mkdtempSync(join(tmpdir(), 'update-channel-sticky-'));
    process.env.GENIE_HOME = dir;
  });

  afterEach(() => {
    if (prevGenieHome === undefined) {
      Reflect.deleteProperty(process.env, 'GENIE_HOME');
    } else {
      process.env.GENIE_HOME = prevGenieHome;
    }
    rmSync(dir, { recursive: true, force: true });
  });

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
    writeFileSync(configPath, JSON.stringify({ updateChannel: 'dev', setupComplete: true }, null, 2), 'utf-8');
    expect(await resolveChannel({})).toBe('dev');
    expect(stderrCapture).toBe(''); // happy path is silent
    await persistChannel('dev');
    const saved = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(saved.updateChannel).toBe('dev');
    expect(saved.setupComplete).toBe(true);
  });

  // The homolog channel was removed 2026-07-26. A config still pinned to it
  // must keep PARSING (dropping it from the enum would fail the whole config,
  // taking unrelated keys with it) and must resolve to stable, not dev —
  // homolog sat above dev in the retired ladder, so stable is the conservative
  // landing. The token never round-trips back to disk.
  test('retired "homolog" channel resolves to stable and is rewritten on persist', async () => {
    writeFileSync(configPath, JSON.stringify({ updateChannel: 'homolog', setupComplete: true }, null, 2), 'utf-8');
    expect(await resolveChannel({})).toBe('stable');
    expect(stderrCapture).toBe('');
    await persistChannel('stable');
    const saved = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(saved.updateChannel).toBe('latest');
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
    manifestBytes: '',
    manifestSha256: '0'.repeat(64),
  };

  test('parses a valid latest.json payload', async () => {
    const raw = JSON.stringify({ ...validManifest, manifestBytes: undefined, manifestSha256: undefined });
    const manifest = await fetchLatestManifest('stable', {
      fetcher: async () => raw,
    });
    expect(manifest).toEqual({
      ...validManifest,
      manifestBytes: raw,
      manifestSha256: createHash('sha256').update(raw).digest('hex'),
    });
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

  test('returns null when channel is omitted instead of inventing the requested channel binding', async () => {
    const manifest = await fetchLatestManifest('stable', {
      fetcher: async () =>
        JSON.stringify({ ...validManifest, channel: undefined, manifestBytes: undefined, manifestSha256: undefined }),
    });
    expect(manifest).toBeNull();
  });

  test('returns null when the fetched manifest declares a different channel', async () => {
    const manifest = await fetchLatestManifest('stable', {
      fetcher: async () =>
        JSON.stringify({ ...validManifest, channel: 'dev', manifestBytes: undefined, manifestSha256: undefined }),
    });
    expect(manifest).toBeNull();
  });

  test('returns null when a platform entry is not a string', async () => {
    const manifest = await fetchLatestManifest('stable', {
      fetcher: async () =>
        JSON.stringify({
          ...validManifest,
          platforms: ['darwin-arm64', 42],
          manifestBytes: undefined,
          manifestSha256: undefined,
        }),
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

describe('private external update staging', () => {
  test('creates one current-user mode-0700 root beneath a protected namespace', () => {
    const namespace = mkdtempSync(join(tmpdir(), 'genie-update-temp-parent-'));
    const base = join(namespace, 'base');
    mkdirSync(base, { mode: 0o700 });
    try {
      const root = createPrivateUpdateTempRoot(base);
      expect(statSync(root).mode & 0o777).toBe(0o700);
      expect(root.startsWith(`${base}/genie-update-`)).toBe(true);
    } finally {
      rmSync(namespace, { recursive: true, force: true });
    }
  });

  test('rejects a private-looking base whose namespace parent is world-writable and non-sticky', () => {
    const namespace = mkdtempSync(join(tmpdir(), 'genie-update-temp-unsafe-'));
    const base = join(namespace, 'base');
    mkdirSync(base, { mode: 0o700 });
    chmodSync(namespace, 0o777);
    try {
      expect(() => createPrivateUpdateTempRoot(base)).toThrow('unsafe cross-principal replacement');
      expect(readdirSync(base)).toEqual([]);
    } finally {
      chmodSync(namespace, 0o700);
      rmSync(namespace, { recursive: true, force: true });
    }
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
    manifestBytes: '{}',
    manifestSha256: '0'.repeat(64),
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
      // 37MB+ tarballs outgrew runCommandSilent's 4s default (v5.260714.8
      // timeout regression) — the download must carry its own generous bound.
      expect(calls[0].timeoutMs).toBe(300_000);
      // Second call — gh attestation verify with workflow identity pinned.
      expect(calls[1].cmd).toBe('gh');
      expect(calls[1].args).toEqual([
        'attestation',
        'verify',
        tarballPath,
        '--repo',
        'automagik-dev/genie',
        // Must match the custom predicate type registered by sign-attest.yml,
        // else `gh attestation verify` defaults to slsa.dev/provenance/v1 and
        // 404s the by-digest lookup (the shipped-tarball regression).
        '--predicate-type',
        'https://github.com/automagik-dev/genie/release-tarballs/v1',
        '--cert-identity-regex',
        '^https://github\\.com/automagik-dev/genie/\\.github/workflows/sign-attest\\.yml@refs/heads/main$',
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

  test('fails closed instead of minting delivery facts from the reduced cosign fallback', async () => {
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

      await expect(downloadAndVerifyTarball(manifest, 'linux-x64-glibc', tmp, { runner })).rejects.toThrow(
        /reduced cosign verify-blob proof does not validate/,
      );
      expect(calls.map((call) => call.cmd)).toEqual(['gh', 'gh']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('reports the primary attestation failure and never invokes cosign', async () => {
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
        /gh attestation verify: no matching attestation/,
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
// A4 — the Orca ownership-marker refresh is advisory to delivery. It spawns
// the live Orca CLI, so it can fail for reasons unrelated to the delivered
// bytes (Orca closed, unsupported range, corrupted marker). It must never
// abort an update whose delivery record is already published.
// ============================================================================

describe('refreshOrcaOwnershipAfterDelivery (A4 advisory marker refresh)', () => {
  test('a failing probe is reported and does not reject', async () => {
    const lines: string[] = [];
    await expect(
      refreshOrcaOwnershipAfterDelivery(
        async () => {
          throw new Error('Orca runtime probe timed out after 30000ms');
        },
        (line) => lines.push(line),
      ),
    ).resolves.toBeUndefined();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('ownership marker was not refreshed');
    expect(lines[0]).toContain('probe timed out');
    expect(lines[1]).toContain('genie doctor');
  });

  test('a successful refresh is silent', async () => {
    const lines: string[] = [];
    await refreshOrcaOwnershipAfterDelivery(
      async () => 'refreshed',
      (line) => lines.push(line),
    );
    expect(lines).toEqual([]);
  });
});

// ============================================================================
// G5 — Corrupt artifact (F31a destructive-failure fixture). A tarball that is
// not a valid gzip archive must make `extractTarball` throw so the update never
// reaches the atomic swap with a half-extracted payload.
// ============================================================================

describe('extractTarball (G5 — corrupt artifact)', () => {
  test('throws on a corrupt (non-gzip) tarball', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'genie-extract-corrupt-'));
    try {
      const tarball = join(tmp, 'genie-5.260714.1-linux-x64-glibc.tar.gz');
      writeFileSync(tarball, 'this is not a gzip archive');
      await expect(extractTarball(tarball, join(tmp, 'extract'))).rejects.toThrow(/tar -xzpf/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Regression (2026-08-30): under `umask 077` a bare `tar -xzf` extracted the
  // archived 0755 binary as 0700; admission fchmods only its private copy back
  // to 0755, so the mode-covering content digests diverged and every
  // `genie update` failed with "admitted install payload content does not match
  // the authenticated source". Extraction must reproduce archived modes.
  test('preserves archived member modes regardless of the caller umask', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'genie-extract-umask-'));
    const priorUmask = process.umask(0o077);
    try {
      const stage = join(tmp, 'stage');
      mkdirSync(join(stage, 'plugins'), { recursive: true });
      writeFileSync(join(stage, 'genie'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(stage, 'genie'), 0o755);
      writeFileSync(join(stage, 'plugins', 'note.md'), 'payload\n');
      chmodSync(join(stage, 'plugins', 'note.md'), 0o644);
      chmodSync(join(stage, 'plugins'), 0o755);
      const tarball = join(tmp, 'genie-5.260830.1-linux-x64-glibc.tar.gz');
      const packed = spawnSync('tar', ['-czf', tarball, '-C', stage, 'genie', 'plugins'], { stdio: 'ignore' });
      expect(packed.status).toBe(0);

      const extract = join(tmp, 'extract');
      await extractTarball(tarball, extract);

      expect(statSync(join(extract, 'genie')).mode & 0o777).toBe(0o755);
      expect(statSync(join(extract, 'plugins')).mode & 0o777).toBe(0o755);
      expect(statSync(join(extract, 'plugins', 'note.md')).mode & 0o777).toBe(0o644);
    } finally {
      process.umask(priorUmask);
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// G5 — Atomic binary swap + rollback.
// Real fs operations on tmp dir; no mocks. The swap needs same-fs primitives,
// so tmp dir is on the test runner's filesystem.
// ============================================================================

describe('rollbackBinary (G5)', () => {
  test('fails closed without mutating a legacy binary-only backup', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-rollback-read-only-'));
    const bin = join(root, 'bin');
    const previous = join(bin, '.previous');
    mkdirSync(previous, { recursive: true });
    writeFileSync(join(bin, 'genie'), 'LIVE');
    writeFileSync(join(bin, 'VERSION'), '5.260714.3\n');
    writeFileSync(join(previous, 'genie-5.260714.2'), 'LEGACY');
    const before = readdirSync(previous);
    try {
      expect(() => rollbackBinaryAt(bin)).toThrow(/exact genie\+VERSION generation/);
      expect(readFileSync(join(bin, 'genie'), 'utf8')).toBe('LIVE');
      expect(readFileSync(join(bin, 'VERSION'), 'utf8')).toBe('5.260714.3\n');
      expect(readdirSync(previous)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

describe('update install-promotion authority', () => {
  test('normal delivery delegates the exact release generation to the proven installer engine', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    expect(source).toContain('createPrivateUpdateTempRoot()');
    expect(source).toContain('admitExternalInstallStaging({');
    expect(source).not.toContain("mkdtempSync(join(GENIE_BIN, '.install-staging-'))");
    expect(source).toContain('recoverPendingInstallPromotions({ genieHome: GENIE_HOME })');
    expect(source).toContain('promoteStagedInstall({');
    expect(source).toContain('syncAuxiliaryContent(GENIE_BIN, GENIE_HOME, undefined, true)');
    expect(source).not.toContain('export function atomicBinarySwap');
  });

  test('legacy pending delivery and rollback are production fail-closed', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    expect(source).toContain('legacy pending delivery is retained read-only');
    expect(source).toContain('Automatic rollback is disabled');
    expect(source).not.toContain('atomicBinarySwap(');
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

      expect(outcomes).toHaveLength(3);
      expect(outcomes.map((outcome) => outcome.label)).toEqual(['plugins', 'skills', 'templates']);
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

describe('legacy pending delivery compatibility', () => {
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
    expect(resolveUpdateExecutionMode({ postDeliveryConverge: true }, undefined)).toBe('post-delivery-converge');
    expect(() => resolveUpdateExecutionMode({ rollback: true, syncOnly: true }, undefined)).toThrow(
      '--rollback and --sync-only cannot be used together',
    );
  });

  test('an absent legacy journal is a read-only no-op', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-pending-absent-'));
    try {
      expect(
        resumePendingDelivery({
          genieHome: root,
          genieBin: join(root, 'bin'),
          stagingRoot: join(root, 'bin', '.staging'),
          pendingPath: join(root, '.pending-delivery.json'),
        }),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a valid present legacy journal fails closed without changing live, auxiliary, or journal bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-pending-read-only-'));
    const home = join(root, 'home');
    const bin = join(home, 'bin');
    const staging = join(bin, '.staging');
    const extract = join(staging, 'extract-5.260714.4');
    const tarball = join(staging, 'genie.tar.gz');
    const journal = join(home, '.pending-delivery.json');
    mkdirSync(join(home, 'plugins'), { recursive: true });
    mkdirSync(extract, { recursive: true });
    writeFileSync(join(bin, 'genie'), 'LIVE_BINARY');
    writeFileSync(join(bin, 'VERSION'), '5.260714.3\n');
    writeFileSync(join(home, 'plugins', 'live.txt'), 'LIVE_AUX');
    writeFileSync(join(extract, 'genie'), 'STAGED_BINARY');
    writeFileSync(join(extract, 'VERSION'), '5.260714.4\n');
    writeFileSync(tarball, 'SIGNED_TARBALL');
    const fingerprint = (path: string) => ({
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
      mode: statSync(path).mode & 0o7777,
    });
    const payload = {
      binary: fingerprint(join(extract, 'genie')),
      previousBinary: { present: true, fingerprint: fingerprint(join(bin, 'genie')) },
      versionStamp: { present: true, fingerprint: fingerprint(join(extract, 'VERSION')) },
      tarball: fingerprint(tarball),
      auxiliary: ['plugins', 'skills', 'templates'].map((name) => ({
        name,
        present: false,
        digest: null,
      })),
    };
    writeFileSync(
      journal,
      `${JSON.stringify({
        schemaVersion: 4,
        version: '5.260714.4',
        previousVersion: '5.260714.3',
        extractDir: extract,
        tarballPath: tarball,
        createdAt: '2026-07-15T00:00:00.000Z',
        payload,
      })}\n`,
      { mode: 0o600 },
    );
    const paths = [join(bin, 'genie'), join(bin, 'VERSION'), join(home, 'plugins', 'live.txt'), journal];
    const before = paths.map((path) => readFileSync(path));
    try {
      expect(() =>
        resumePendingDelivery({ genieHome: home, genieBin: bin, stagingRoot: staging, pendingPath: journal }),
      ).toThrow(/retained read-only/);
      expect(paths.map((path) => readFileSync(path))).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
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
    const ensureIdx = cmdBody.indexOf('dependencies.requireCanonicalInstall ?? ensureCanonicalInstall');
    const deliveryIdx = cmdBody.indexOf('runDelivery(resolvedManifest');
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
//      never re-reading the swapped binary. (Now owned by the staged-promotion
//      transaction's mandatory version verification.)
//   2. The PATH heuristic did not guard against `live === canonical`, so a
//      version mismatch caused by a botched swap was misdiagnosed as a PATH
//      problem and rendered as `ln -sf X X`.
//
// The helper below is pure and injectable so the regression is locked in
// without spawning a real `genie` binary.
// ============================================================================

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
// Convergence wiring. `genie update` is the ONE canonical updater: the bounded
// convergence phase runs on --sync-only, while a manual full update converges
// integrations in the reviewed parent process. A newly installed binary is
// never re-entered as `genie update`.
// ============================================================================

describe('manual post-update convergence (2026-07-11 cascade regression)', () => {
  test('runs the canonical convergence APIs and returns structured integration outcomes', () => {
    const calls: string[] = [];
    const result = runManualUpdateConvergence({
      expectedVersion: '5.260711.3',
      bundleRoot: '/tmp/verified-bundle',
      runSkills: noSkillsChannel,
      // Explicit selection: the default reads the host's persisted integration
      // consent, so omitting it makes the test depend on machine state (#2732).
      selection: 'all',
      refreshPlugins: (options) => {
        calls.push(`parent-plugin-refresh:${options.expectedVersion}:${options.selection}`);
        return [{ runtime: 'claude', ok: true, detail: 'plugin refreshed' }];
      },
      log: (line) => calls.push(`log:${line}`),
    });
    expect(calls[0]).toBe('parent-plugin-refresh:5.260711.3:claude');
    expect(result.integrations).toEqual([{ runtime: 'claude', ok: true, detail: 'plugin refreshed' }]);
    expect(result.skills).toEqual({ status: 'skipped', reason: 'test fixture' });
  });

  test('the skills-channel outcome is surfaced, never discarded, so exit 1 survives action-required', () => {
    const savedExitCode = process.exitCode;
    try {
      const result = runManualUpdateConvergence({
        expectedVersion: '5.260711.3',
        selection: 'all',
        runSkills: () => ({ status: 'failed', reason: 'skills CLI exited 1: boom' }),
        refreshPlugins: () => [{ runtime: 'claude', ok: true, detail: 'plugin refreshed' }],
        log: () => {},
      });
      expect(result.skills).toEqual({ status: 'failed', reason: 'skills CLI exited 1: boom' });
      applyConvergenceExitSignal(result);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = savedExitCode ?? 0;
    }
  });

  test('structurally excludes Codex queries and writes while retaining Claude/Hermes convergence', () => {
    expect(narrowUpdatePluginRefreshSelection('auto')).toBe('claude');
    expect(narrowUpdatePluginRefreshSelection('all')).toBe('claude');
    expect(narrowUpdatePluginRefreshSelection('claude')).toBe('claude');
    expect(narrowUpdatePluginRefreshSelection('codex')).toBeNull();
    expect(narrowUpdatePluginRefreshSelection('none')).toBeNull();

    let codexOnlyRefreshes = 0;
    const codexOnly = runManualUpdateConvergence({
      expectedVersion: VERSION,
      selection: 'codex',
      runSkills: noSkillsChannel,
      refreshPlugins: () => {
        codexOnlyRefreshes += 1;
        return [{ runtime: 'codex', ok: true, detail: 'must not run' }];
      },
    });
    // `codex` is not `none`: the skills channel still runs (fixture-skipped here),
    // only the plugin refresh is narrowed away.
    expect(codexOnly).toEqual({
      integrations: [],
      skills: { status: 'skipped', reason: 'test fixture' },
      retirement: null,
    });
    expect(codexOnlyRefreshes).toBe(0);

    let selectedRefresh: IntegrationSelection | undefined;
    const auto = runManualUpdateConvergence({
      expectedVersion: VERSION,
      selection: 'auto',
      runSkills: noSkillsChannel,
      refreshPlugins: (options) => {
        selectedRefresh = options.selection;
        return [
          { runtime: 'claude', ok: true, detail: 'refreshed' },
          { runtime: 'codex', ok: true, detail: 'injected boundary violation' },
        ];
      },
      log: () => {},
    });
    expect(selectedRefresh).toBe('claude');
    expect(auto.integrations).toEqual([{ runtime: 'claude', ok: true, detail: 'refreshed' }]);
  });

  test('normal delivery invokes the fresh binary only through the explicit child protocol', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'update.ts'), 'utf-8');
    expect(source).not.toMatch(/execFileSync\([^\n]+,\s*\['update'\]\s*,/);
    expect(source).toContain("run(binaryPath, ['update', '--post-delivery-converge'], environment)");
    const deliveryIdx = source.indexOf('runDelivery(resolvedManifest');
    const convergeIdx = source.indexOf('runFreshConvergenceOrReport(lifecycleLease)', deliveryIdx);
    const verifyIdx = source.indexOf('await runPostUpdateVerifySafe(');
    expect(deliveryIdx).toBeGreaterThan(-1);
    expect(convergeIdx).toBeGreaterThan(deliveryIdx);
    expect(convergeIdx).toBeLessThan(verifyIdx);
  });

  test('hands the exact live lifecycle lease to the fresh binary without releasing the parent lease', () => {
    const home = mkdtempSync(join(tmpdir(), 'genie-fresh-converge-lease-'));
    const lease = acquireLifecycleLease(home);
    expect('skipped' in lease).toBe(false);
    if ('skipped' in lease) return;
    try {
      let called = false;
      runFreshBinaryPostDeliveryConvergence({
        lifecycleLease: lease,
        binaryPath: '/fixture/fresh-genie',
        run(binaryPath, argv, environment) {
          called = true;
          expect(binaryPath).toBe('/fixture/fresh-genie');
          expect(argv).toEqual(['update', '--post-delivery-converge']);
          expect(environment.GENIE_LIFECYCLE_LEASE_PATH).toBe(lease.path);
          expect(environment.GENIE_LIFECYCLE_LEASE_OWNER).toBe(readFileSync(lease.path, 'utf8').trim());
          expect(existsSync(lease.path)).toBe(true);
          const previousPath = process.env.GENIE_LIFECYCLE_LEASE_PATH;
          const previousOwner = process.env.GENIE_LIFECYCLE_LEASE_OWNER;
          try {
            process.env.GENIE_LIFECYCLE_LEASE_PATH = environment.GENIE_LIFECYCLE_LEASE_PATH;
            process.env.GENIE_LIFECYCLE_LEASE_OWNER = environment.GENIE_LIFECYCLE_LEASE_OWNER;
            const borrowed = acquireLifecycleLease(home);
            expect('skipped' in borrowed).toBe(false);
            if (!('skipped' in borrowed)) borrowed.release();
            expect(existsSync(lease.path)).toBe(true);
          } finally {
            if (previousPath === undefined) process.env.GENIE_LIFECYCLE_LEASE_PATH = undefined;
            else process.env.GENIE_LIFECYCLE_LEASE_PATH = previousPath;
            if (previousOwner === undefined) process.env.GENIE_LIFECYCLE_LEASE_OWNER = undefined;
            else process.env.GENIE_LIFECYCLE_LEASE_OWNER = previousOwner;
          }
        },
      });
      expect(called).toBe(true);
      expect(existsSync(lease.path)).toBe(true);
    } finally {
      lease.release();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('fresh-child failure propagates with explicit operator recovery', () => {
    const home = mkdtempSync(join(tmpdir(), 'genie-fresh-converge-failure-'));
    const lease = acquireLifecycleLease(home);
    expect('skipped' in lease).toBe(false);
    if ('skipped' in lease) return;
    try {
      let message = '';
      try {
        runFreshBinaryPostDeliveryConvergence({
          lifecycleLease: lease,
          run: () => {
            throw new Error('exit 7');
          },
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain('fresh Genie integration convergence failed: exit 7');
      // Integration-neutral operator recovery: retry the update itself first
      // (the rerun re-converges), THEN the Codex activation steps if pending.
      expect(message).toContain('Rerun `genie update`');
      expect(message).not.toContain('genie setup --codex');
    } finally {
      lease.release();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('D3: a fresh-child exit 2 is delivered-but-action-required, not a failure', () => {
    const home = mkdtempSync(join(tmpdir(), 'genie-fresh-converge-deferred-'));
    const lease = acquireLifecycleLease(home);
    expect('skipped' in lease).toBe(false);
    if ('skipped' in lease) return;
    try {
      // The child (--post-delivery-converge) exits 2 when installed N ≠ delivered
      // T; execFileSync surfaces that as an error carrying `status: 2`.
      const outcome = runFreshBinaryPostDeliveryConvergence({
        lifecycleLease: lease,
        run: () => {
          throw Object.assign(new Error('Command failed'), { status: 2 });
        },
      });
      expect(outcome).toBe('action-required');
    } finally {
      lease.release();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('D3: a fresh-child exit 1 (e.g. a failed skills install) stays a hard failure', () => {
    const home = mkdtempSync(join(tmpdir(), 'genie-fresh-converge-failed-'));
    const lease = acquireLifecycleLease(home);
    expect('skipped' in lease).toBe(false);
    if ('skipped' in lease) return;
    try {
      // Only exit 2 is the delivered-but-action-required carve-out. Exit 1 —
      // what the skills channel sets — must never be mapped to it.
      expect(() =>
        runFreshBinaryPostDeliveryConvergence({
          lifecycleLease: lease,
          run: () => {
            throw Object.assign(new Error('Command failed'), { status: 1 });
          },
        }),
      ).toThrow(/fresh Genie integration convergence failed/);
    } finally {
      lease.release();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('D3: a converged fresh-child returns converged', () => {
    const home = mkdtempSync(join(tmpdir(), 'genie-fresh-converge-ok-'));
    const lease = acquireLifecycleLease(home);
    expect('skipped' in lease).toBe(false);
    if ('skipped' in lease) return;
    try {
      const outcome = runFreshBinaryPostDeliveryConvergence({ lifecycleLease: lease, run: () => {} });
      expect(outcome).toBe('converged');
    } finally {
      lease.release();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('skills.sh channel in the post-delivery convergence (wish skills-everywhere, group 1)', () => {
  let previousExitCode: number | string | undefined;

  beforeEach(() => {
    previousExitCode = process.exitCode ?? undefined;
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
  });

  test('installs skills BEFORE the plugin refresh (decision 2 ordering)', () => {
    const calls: string[] = [];
    runManualUpdateConvergence({
      expectedVersion: VERSION,
      selection: 'all',
      runSkills: (selection) => {
        calls.push(`skills:${selection}`);
        return { status: 'skipped', reason: 'test fixture' };
      },
      refreshPlugins: () => {
        calls.push('plugin-refresh');
        return [];
      },
      log: () => undefined,
    });
    expect(calls).toEqual(['skills:all', 'plugin-refresh']);
  });

  test('every non-none selection reaches the channel unnarrowed (decision 3)', () => {
    const seen: string[] = [];
    for (const selection of ['auto', 'all', 'claude', 'codex'] as const) {
      runManualUpdateConvergence({
        expectedVersion: VERSION,
        selection,
        runSkills: (received) => {
          seen.push(received);
          return { status: 'skipped', reason: 'test fixture' };
        },
        refreshPlugins: () => [],
        log: () => undefined,
      });
    }
    expect(seen).toEqual(['auto', 'all', 'claude', 'codex']);
  });

  test('consent none skips the channel with the rest of the convergence', () => {
    let skills = 0;
    runManualUpdateConvergence({
      expectedVersion: VERSION,
      selection: 'none',
      runSkills: () => {
        skills += 1;
        return { status: 'skipped', reason: 'test fixture' };
      },
      refreshPlugins: () => [],
      log: () => undefined,
    });
    expect(skills).toBe(0);
  });

  test('the channel logs through the convergence emitter', () => {
    const lines: string[] = [];
    runManualUpdateConvergence({
      expectedVersion: VERSION,
      selection: 'claude',
      runSkills: (_selection, emit) => {
        emit('skills: fixture line');
        return { status: 'skipped', reason: 'test fixture' };
      },
      refreshPlugins: () => [],
      log: (line) => lines.push(line),
    });
    expect(lines).toContain('skills: fixture line');
  });

  test('a skills failure never aborts the convergence — the promoted binary stays committed', () => {
    const calls: string[] = [];
    const result = runManualUpdateConvergence({
      expectedVersion: VERSION,
      selection: 'all',
      runSkills: () => {
        calls.push('skills');
        process.exitCode = 1;
        return { status: 'failed', reason: 'skills CLI exited 1: boom' };
      },
      refreshPlugins: () => [{ runtime: 'claude', ok: true, detail: 'refreshed' }],
      log: () => undefined,
    });
    expect(calls).toEqual(['skills']);
    expect(result.integrations).toEqual([{ runtime: 'claude', ok: true, detail: 'refreshed' }]);
    expect(process.exitCode).toBe(1);
  });

  test('--sync-only converges through the same manual convergence, with no per-agent sync step', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'update.ts'), 'utf-8');
    const start = source.indexOf('function runLegacySyncOnlyMode(');
    const body = source.slice(start, source.indexOf('\n}', start));
    expect(body).toContain('runTrackedManualUpdateConvergence(VERSION)');
    expect(body).not.toContain('Sync(');
    // No manifest fetch, no download, no binary swap inside the mode.
    for (const forbidden of ['fetchLatestManifest', 'downloadAndVerifyTarball', 'runDelivery']) {
      expect(body).not.toContain(forbidden);
    }
  });
});

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

// ============================================================================
// Explicit update modes (--sync-only / --rollback / --post-delivery-converge)
// resolve the lease through `acquireRequiredLifecycleLease`, whose GENIE_HOME
// is captured at module import time — so this exercises the REAL acquirer in a
// child process with an isolated GENIE_HOME rather than the injected seam. Its
// old raw throw reached the terminal as an unhandled stack trace (exit 1),
// which is exactly what this pins away.
// ============================================================================

describe('--sync-only behind a live lifecycle lease (executed)', () => {
  let work: string;
  let genieHome: string;
  let lockPath: string;
  let runner: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'genie-sync-only-busy-'));
    genieHome = join(work, '.genie');
    mkdirSync(genieHome, { recursive: true });
    lockPath = lifecycleLockPath(genieHome);
    runner = join(work, 'run-sync-only.ts');
    const updateModule = join(import.meta.dir, '..', 'update.ts');
    writeFileSync(
      runner,
      [
        `import { updateCommand } from ${JSON.stringify(updateModule)};`,
        'await updateCommand({ syncOnly: true });',
        '',
      ].join('\n'),
    );
  });

  afterEach(() => rmSync(work, { recursive: true, force: true }));

  test('projects exit 2 with the actionable busy line and no stack trace', () => {
    // A live, same-host, fresh-mtime holder: this test process itself. It can
    // be neither stolen (alive) nor aged out (fresh), so the child must wait
    // out the bounded window and then give up gracefully.
    writeFileSync(lockPath, `${process.pid}:abcdef0123456789abcdef0123456789:unknown:${currentSyncLockHostId()}\n`);

    const result = spawnSync(process.execPath, ['run', runner], {
      encoding: 'utf8',
      env: {
        HOME: work,
        GENIE_HOME: genieHome,
        GENIE_LIFECYCLE_LEASE_WAIT_MS: '40',
        PATH: process.env.PATH ?? '/usr/bin:/bin',
      },
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

    expect(result.status).toBe(2);
    expect(output).toContain('Another Genie lifecycle command is active');
    expect(output).toContain(`holds the lock at ${lockPath}`);
    expect(output).toContain('retry shortly, or remove the file if its owner has crashed');
    // Not a raw throw: no stack frames, no unhandled-error banner.
    expect(output).not.toMatch(/\n\s+at /);
    expect(output).not.toContain('error: Another Genie lifecycle command');
    // Not a Codex refusal, and no machine trailer install.sh could misparse.
    expect(output).not.toContain('codex-lifecycle-busy');
    expect(output).not.toContain('schemaVersion');
    // The live holder's record is untouched, and no steal guard was left.
    expect(readFileSync(lockPath, 'utf8')).toContain(`${process.pid}:`);
    expect(existsSync(`${lockPath}.steal`)).toBe(false);
  });
});

describe('runManualUpdateConvergence — plugin-era retirement runs last, behind a fresh skills install', () => {
  const MANAGED_ROLE_TOML = '# Managed by Genie. Remove with `genie uninstall`.\nname = "genie_reviewer"\n';
  const COUNCIL_TEMPLATE = "export const meta = { name: 'council' };\nconst LENS_ROOT = '__GENIE_LENS_ROOT__';\n";
  const RETIREMENT_NOW = new Date('2026-08-30T12:00:00.000Z');

  interface RetirementFixture {
    home: string;
    genieHome: string;
    pluginRoot: string;
    codexHome: string;
    claudeDir: string;
    hermesHome: string;
    piExtensionsDir: string;
  }

  const retirementRoots: string[] = [];

  afterEach(() => {
    while (retirementRoots.length > 0) rmSync(retirementRoots.pop() as string, { recursive: true, force: true });
  });

  function put(path: string, content: string): void {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }

  function putLink(linkPath: string, target: string): void {
    mkdirSync(join(linkPath, '..'), { recursive: true });
    mkdirSync(target, { recursive: true });
    symlinkSync(target, linkPath);
  }

  function putManagedSkill(dir: string, body: string): void {
    put(join(dir, 'SKILL.md'), body);
    put(
      join(dir, '.genie-sync.json'),
      `${JSON.stringify(
        {
          managedBy: 'genie-agent-sync',
          version: '9.9.9',
          digest: computeDirDigest(dir),
          syncedAt: RETIREMENT_NOW.toISOString(),
          identityVersion: 2,
        },
        null,
        2,
      )}\n`,
    );
  }

  /** The stamped council workflow plus its ownership sidecar, as the stamper left them. */
  function putManagedCouncilWorkflow(workflowsDir: string, body: string): void {
    const targetPath = join(workflowsDir, 'council.js');
    put(targetPath, body);
    chmodSync(targetPath, 0o644);
    const manifestPath = join(workflowsDir, 'council.js.genie-sync.json');
    put(
      manifestPath,
      `${JSON.stringify(
        {
          managedBy: 'genie-agent-sync',
          version: '9.9.9',
          digest: computeFileDigest(targetPath),
          syncedAt: RETIREMENT_NOW.toISOString(),
          identityVersion: 2,
          targetMode: 0o644,
        },
        null,
        2,
      )}\n`,
    );
    chmodSync(manifestPath, 0o644);
  }

  /** Codex role agents plus the v2 ownership inventory, as the role writer left them. */
  function putManagedCodexRoleAgents(codexHome: string, files: Record<string, string>): void {
    const agentsDir = join(codexHome, 'agents');
    const inventory: Record<string, { identity: { kind: 'regular'; mode: number; digest: string } }> = {};
    for (const [name, content] of Object.entries(files)) {
      const path = join(agentsDir, name);
      put(path, content);
      chmodSync(path, 0o644);
      inventory[name] = { identity: { kind: 'regular', mode: 0o644, digest: computeFileDigest(path) } };
    }
    const inventoryPath = join(agentsDir, '.genie-role-agents.json');
    put(
      inventoryPath,
      `${JSON.stringify({ version: 2, managedBy: 'genie-codex-role-agents', files: inventory }, null, 2)}\n`,
    );
    chmodSync(inventoryPath, 0o600);
  }

  /**
   * A host carrying EVERY plugin-era surface, plus the skills.sh copies that
   * already occupy the bare-name skill slots — the real post-channel state, and
   * the reason the claude skills mirror stays inert instead of competing.
   */
  function makeRetirementFixture(): RetirementFixture {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'genie-retire-pipeline-')));
    retirementRoots.push(home);
    const genieHome = join(home, '.genie');
    const pluginRoot = join(genieHome, 'plugins', 'genie');
    const fixture: RetirementFixture = {
      home,
      genieHome,
      pluginRoot,
      codexHome: join(home, '.codex'),
      claudeDir: join(home, '.claude'),
      hermesHome: join(home, '.hermes'),
      piExtensionsDir: join(home, '.pi', 'agent', 'extensions'),
    };

    // Genie-owned payload: plugin source for all three adapters.
    put(join(genieHome, 'VERSION'), '9.9.9\n');
    put(join(pluginRoot, 'skills', 'alpha', 'SKILL.md'), '# alpha\n');
    put(join(pluginRoot, 'agents', 'reviewer.md'), '# reviewer\n');
    put(join(pluginRoot, 'workflows', 'council.js'), COUNCIL_TEMPLATE);
    put(join(pluginRoot, 'codex-agents', 'genie-reviewer.toml'), MANAGED_ROLE_TOML);
    put(join(genieHome, 'plugins', 'hermes-genie', 'plugin.json'), '{"name":"hermes-genie"}\n');
    put(join(genieHome, 'plugins', 'pi-genie', 'package.json'), '{"name":"genie-pi-plugin"}\n');

    // Codex plugin era.
    put(join(fixture.codexHome, 'config.toml'), '[otel]\nkeep = true\n\n[plugins."genie@automagik"]\nenabled = true\n');
    put(join(fixture.codexHome, 'plugins', 'cache', 'automagik', 'genie', '9.9.9', 'plugin.json'), '{}\n');
    putManagedCodexRoleAgents(fixture.codexHome, { 'genie-reviewer.toml': MANAGED_ROLE_TOML });
    putManagedSkill(join(fixture.codexHome, 'skills', '.curated', 'alpha'), '# curated alpha\n');

    // Claude plugin era.
    put(
      join(fixture.claudeDir, 'plugins', 'installed_plugins.json'),
      `${JSON.stringify({ plugins: [{ id: 'genie@automagik' }, { id: 'other@market' }] }, null, 2)}\n`,
    );
    put(join(fixture.claudeDir, 'plugins', 'cache', 'automagik', 'genie', '9.9.9', 'plugin.json'), '{}\n');
    putManagedCouncilWorkflow(
      join(fixture.claudeDir, 'workflows'),
      COUNCIL_TEMPLATE.replace('__GENIE_LENS_ROOT__', pluginRoot),
    );
    const agentPath = join(fixture.claudeDir, 'agents', 'reviewer.md');
    put(agentPath, '# reviewer\n');
    put(
      join(fixture.claudeDir, 'agents', '.genie-sync.json'),
      `${JSON.stringify(
        {
          managedBy: 'genie-agent-sync',
          files: {
            'reviewer.md': {
              digest: computeFileDigest(agentPath),
              version: '9.9.9',
              syncedAt: RETIREMENT_NOW.toISOString(),
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    putManagedSkill(join(fixture.claudeDir, 'skills', 'legacy-mirror'), '# legacy mirror\n');
    // The skills.sh channel already owns the bare-name slot for every SOURCE skill.
    put(join(fixture.claudeDir, 'skills', 'alpha', 'SKILL.md'), '# alpha from skills.sh\n');

    // Hermes + pi plugin era.
    putLink(join(fixture.hermesHome, 'plugins', 'genie'), join(genieHome, 'plugins', 'hermes-genie'));
    put(
      join(fixture.hermesHome, 'config.yaml'),
      [
        'mcp_servers:',
        '  other:',
        '    command: other',
        '# genie:managed:mcp_servers.genie — begin (managed by genie; edit via genie only)',
        '  genie:',
        '    command: genie',
        '# genie:managed:mcp_servers.genie — end',
        'skills:',
        '  external_dirs:',
        '    - /operator/own/skills',
        `    - ${join(genieHome, 'skills')}  # genie:managed:skills.external_dirs`,
        '',
      ].join('\n'),
    );
    putLink(join(fixture.piExtensionsDir, 'genie'), join(genieHome, 'plugins', 'pi-genie'));
    mkdirSync(join(genieHome, 'skills', 'alpha'), { recursive: true });
    put(join(genieHome, 'skills', 'alpha', 'SKILL.md'), '# alpha payload\n');
    return fixture;
  }

  function plantRecord(fixture: RetirementFixture, ref: string): void {
    writeSkillsInstallRecord(fixture.genieHome, {
      ref,
      cliVersion: SKILLS_CLI_VERSION,
      inventory: ['alpha'],
      agentDirs: [],
      installedAt: RETIREMENT_NOW.toISOString(),
    });
  }

  /** One full convergence pass against the fixture's homes. */
  function converge(
    fixture: RetirementFixture,
    skills: SkillsChannelConvergenceResult,
  ): {
    lines: string[];
    retirement: ReturnType<typeof runManualUpdateConvergence>['retirement'];
  } {
    const lines: string[] = [];
    const result = runManualUpdateConvergence({
      expectedVersion: '9.9.9',
      selection: 'all',
      runSkills: () => skills,
      refreshPlugins: () => [],
      retirementHomes: {
        home: fixture.home,
        genieHome: fixture.genieHome,
        codexHome: fixture.codexHome,
        claudeDir: fixture.claudeDir,
        hermesHome: fixture.hermesHome,
        piExtensionsDir: fixture.piExtensionsDir,
      },
      log: (line) => lines.push(line),
    });
    return { lines, retirement: result.retirement };
  }

  function installedSkills(): SkillsChannelConvergenceResult {
    return {
      status: 'installed',
      record: {
        ref: 'v9.9.9',
        cliVersion: SKILLS_CLI_VERSION,
        inventory: ['alpha'],
        agentDirs: [],
        installedAt: RETIREMENT_NOW.toISOString(),
      },
    };
  }

  function treeHash(root: string): string {
    const parts: string[] = [];
    const walk = (dir: string, rel: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(dir, entry.name);
        const next = rel === '' ? entry.name : `${rel}/${entry.name}`;
        if (entry.isSymbolicLink()) parts.push(`L ${next} ${readlinkSync(path)}`);
        else if (entry.isDirectory()) {
          parts.push(`D ${next}`);
          walk(path, next);
        } else parts.push(`F ${next} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`);
      }
    };
    walk(root, '');
    return createHash('sha256').update(parts.join('\n')).digest('hex');
  }

  test('a fresh record: pass one retires every surface, pass two is a byte-for-byte no-op', () => {
    const fixture = makeRetirementFixture();
    plantRecord(fixture, releaseTag(VERSION));
    // The two user-owned Claude registries the plugin era wrote one key into.
    put(
      join(fixture.claudeDir, 'plugins', 'known_marketplaces.json'),
      `${JSON.stringify(
        {
          automagik: {
            source: { source: 'directory', path: fixture.genieHome },
            installLocation: fixture.genieHome,
          },
          'other-market': { source: { source: 'git', repo: 'someone/else' } },
        },
        null,
        2,
      )}\n`,
    );
    put(
      join(fixture.claudeDir, 'settings.json'),
      `${JSON.stringify({ enabledPlugins: { 'genie@automagik': true, 'other@market': true } }, null, 2)}\n`,
    );

    const first = converge(fixture, installedSkills());
    expect(first.retirement?.failures).toEqual([]);
    // Retirement now owns every plugin-era surface outright. Two of them —
    // the bare-name claude skill mirror and the hermes MCP marker block — used
    // to be cleaned by the per-agent convergence engine's own lanes before retirement
    // ran; with that engine deleted they reach retirement still present, which
    // is exactly the surface set a real post-deletion host presents.
    expect(first.retirement?.removed.map((entry) => entry.surface).sort()).toEqual([
      'claude-agent',
      'claude-enabled-plugin',
      'claude-marketplace-registration',
      'claude-plugin-cache',
      'claude-plugin-registry',
      'claude-skill',
      'claude-workflow',
      'codex-legacy-curated-skill',
      'codex-plugin-cache',
      'codex-plugin-registration',
      'codex-role-agent',
      'codex-role-agent-inventory',
      'hermes-mcp-server',
      'hermes-plugin-link',
      'hermes-skills-external-dir',
      'pi-extension-link',
    ]);
    // The two user-owned Claude registries keep every key but genie's own.
    expect(JSON.parse(readFileSync(join(fixture.claudeDir, 'plugins', 'known_marketplaces.json'), 'utf8'))).toEqual({
      'other-market': { source: { source: 'git', repo: 'someone/else' } },
    });
    expect(JSON.parse(readFileSync(join(fixture.claudeDir, 'settings.json'), 'utf8'))).toEqual({
      enabledPlugins: { 'other@market': true },
    });
    const afterFirst = treeHash(fixture.home);

    const second = converge(fixture, installedSkills());
    expect(second.retirement?.removed).toEqual([]);
    expect(second.lines).toContain('nothing to retire');
    expect(treeHash(fixture.home)).toBe(afterFirst);
  });

  test('a non-installed channel skips retirement entirely', () => {
    const fixture = makeRetirementFixture();
    plantRecord(fixture, 'v0.0.1');

    const run = converge(fixture, { status: 'failed', reason: 'skills CLI exited 1: boom' });
    expect(run.retirement).toBeNull();
    expect(run.lines).not.toContain('nothing to retire');

    // Nothing was retired: every plugin-era asset is still exactly where it was.
    expect(readFileSync(join(fixture.codexHome, 'config.toml'), 'utf8')).toContain('[plugins."genie@automagik"]');
    expect(existsSync(join(fixture.claudeDir, 'workflows', 'council.js'))).toBe(true);
    expect(existsSync(join(fixture.codexHome, 'skills', '.curated', 'alpha'))).toBe(true);
    expect(existsSync(join(fixture.piExtensionsDir, 'genie'))).toBe(true);
    expect(existsSync(join(fixture.genieHome, 'state-backups'))).toBe(false);
  });

  test('the retirement call sits after every other convergence step in update.ts', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'update.ts'), 'utf-8');
    const body = source.slice(source.indexOf('export function runManualUpdateConvergence('));
    const convergence = body.slice(0, body.indexOf('\n}\n'));
    expect(convergence.indexOf('runLegacyIntegrationRetirement(')).toBeGreaterThan(
      convergence.indexOf('refreshUpdatePlugins)('),
    );
    expect(convergence).toContain("skills.status === 'installed'");
    // Never at the install seam, never from doctor.
    expect(readFileSync(join(import.meta.dir, '..', 'install.ts'), 'utf-8')).not.toContain(
      'runLegacyIntegrationRetirement',
    );
    expect(readFileSync(join(import.meta.dir, '..', 'doctor.ts'), 'utf-8')).not.toContain(
      'runLegacyIntegrationRetirement',
    );
  });
});
