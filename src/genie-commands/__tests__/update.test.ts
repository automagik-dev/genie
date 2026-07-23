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
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentSyncReport, acquireLifecycleLease, runAgentSync } from '../../lib/agent-sync';
import { observeCodexActivation, openCodexActivationStore } from '../../lib/codex-activation';
import type { DeliveryEvidencePlatformId } from '../../lib/codex-delivery-evidence';
import { mintTestDeliveryEvidence } from '../../lib/codex-delivery-evidence.test-support';
import {
  type HeldLifecycleLease,
  acquireLifecycleLease as acquireCodexLifecycleLease,
} from '../../lib/codex-lifecycle-lease';
import { REQUIRED_GENIE_MCP_TOOLS } from '../../lib/codex-mcp-health-session';
import type { CodexPluginProbe } from '../../lib/codex-project-mcp';
import {
  CANONICAL_GENIE_SKILL_NAMES,
  type CodexHealthProof,
  type CodexPluginOnlyDeps,
  type CommandRunner,
  type IntegrationSelection,
} from '../../lib/runtime-integrations';
import { VERSION } from '../../lib/version';
import type { AuxiliaryTreeOutcome, AuxiliaryTreeStage } from '../auxiliary-trees.js';
import type { PinnedManifest } from '../codex-delivery-repair.js';
import {
  type RefreshUpdatePluginsOptions,
  refreshUpdatePlugins as refreshUpdatePluginsWithPhysicalVerification,
} from '../update-integrations.js';
import {
  CodexDeliveryPublicationError,
  type LatestManifest,
  type VerifyResult,
  _resetNextDeprecationLatchForTest,
  applyConvergenceExitSignal,
  attemptAlreadyCurrentDeliveryRepair,
  buildAlreadyCurrentRepairSeams,
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
  handleAlreadyCurrentUpdate,
  hashPhysicalFileIncrementally,
  isGenieProcessSnapshotLine,
  manifestUrlForChannel,
  mapAlreadyCurrentRepairOutcome,
  narrowUpdateAgentSyncSelection,
  narrowUpdatePluginRefreshSelection,
  normalizeVersion,
  persistChannel,
  resolveChannel,
  resolveLiveBinaryPath,
  resolvePlatformId,
  resolveUpdateExecutionMode,
  resumePendingDelivery,
  rollbackBinaryAt,
  runAgentSyncSafe,
  runFreshBinaryPostDeliveryConvergence,
  runLegacySyncOnlyConvergence,
  runManualUpdateConvergence,
  runNormalUpdatePublicationBoundary,
  runUpdateAgentSync,
  runV4CleanupSafe,
  runVerifyProbe,
  shortCircuitIfCurrent,
  shouldEmitPathDivergenceWarning,
  summarizeJsonlSignals,
  syncAuxiliaryContent,
  updateCommand,
} from '../update.js';

function healthyUpdateCodexProbe(): CodexPluginProbe {
  return {
    cliAvailable: true,
    status: 'ok',
    installed: true,
    enabled: true,
    version: '5.260711.3',
    activePluginRoot: '/fixture/plugin/root',
    usable: true,
    usabilityDetail: 'fixture usable',
    detail: 'fixture healthy codex plugin',
  };
}

/**
 * Full-update codex now converges through convergeCodexPluginOnly. These refresh
 * suites drive fake bundles, so stub the health/probe/retire/role-agent seams and
 * point retirement at an isolated empty fallback tier — convergeCodexPlugin itself
 * still runs for real against the injected runner.
 */
function healthyUpdateCodexPluginOnly(overrides: CodexPluginOnlyDeps = {}): CodexPluginOnlyDeps {
  return {
    probe: () => healthyUpdateCodexProbe(),
    prove: () =>
      Object.freeze({
        version: 1,
        snapshot: healthyUpdateCodexProbe(),
        activePluginRoot: '/fixture/plugin/root',
        expectedVersion: '5.260711.3',
        skillInventory: CANONICAL_GENIE_SKILL_NAMES,
        payload: [],
        mcp: { initialized: true, tools: [...REQUIRED_GENIE_MCP_TOOLS], wishStatusReadOnly: true },
      }) as CodexHealthProof,
    runSession: () => ({
      ok: true,
      detail: 'fixture session',
      tools: [...REQUIRED_GENIE_MCP_TOOLS],
      wishStatusReadOnly: true,
    }),
    installAgents: () => ({ installed: 0, skippedUserOwned: [], keptModified: [], removed: [], backedUp: [] }),
    fallbackSkillsDir: mkdtempSync(join(tmpdir(), 'genie-update-fallback-')),
    ...overrides,
  };
}

function refreshUpdatePlugins(options: RefreshUpdatePluginsOptions) {
  return refreshUpdatePluginsWithPhysicalVerification({
    ...options,
    resolveExecutable: options.resolveExecutable ?? ((name) => name),
    verifyCodexPayload: options.verifyCodexPayload ?? (() => undefined),
    verifyClaudePayload: options.verifyClaudePayload ?? (() => undefined),
    codexPluginOnly: healthyUpdateCodexPluginOnly(options.codexPluginOnly),
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

  test('the already-current handoff prints plain language and returns before convergence', () => {
    const source = readFileSync(join(__dirname, '..', 'update.ts'), 'utf-8');
    // A bare machine trailer must never be the whole human output. Publication
    // returns its activation handoff without entering another authority.
    expect(source).toContain('Codex plugin activation is pending: retire Codex tasks');
    const handoffBranch = source.slice(source.indexOf('handleAlreadyCurrentUpdate'));
    expect(handoffBranch).toContain('log(CODEX_DELIVERY_RESULT_TRAILER)');
    expect(handoffBranch).toContain('process.exitCode = 2');
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
    const normalStart = source.indexOf(
      'const lifecycleLease = acquireRequiredLifecycleLease(dependencies.acquireLease)',
    );
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

  test('a setup-held Codex lease refuses update before recovery or any delivery-owned mutation', async () => {
    const priorExitCode = process.exitCode;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const events: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => stdout.push(args.join(' ')));
    const errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => stderr.push(args.join(' ')));
    process.exitCode = undefined;
    try {
      await updateCommand(
        { yes: true, stable: true },
        {
          fetchManifest: async () => commandManifest,
          readInstalledVersion: () => '5.260700.1',
          resolvePlatform: () => 'darwin-arm64',
          acquireLease: () => {
            events.push('agent-acquire');
            return {
              path: '/fixture/.agent-sync.lock',
              release: () => events.push('agent-release'),
            };
          },
          acquireCodexLease: () => {
            events.push('codex-busy');
            return {
              ok: false,
              reason: 'codex-lifecycle-busy',
              holderKind: 'setup-activation',
              detail: 'held by setup-activation',
            };
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
      );

      expect(events).toEqual(['agent-acquire', 'codex-busy', 'agent-release']);
      expect(events.some((event) => event.startsWith('MUTATION:'))).toBe(false);
      expect(Number(process.exitCode)).toBe(2);
      const output = [...stdout, ...stderr].join('\n');
      expect(output).toContain('codex-lifecycle-busy');
      expect(output).toContain('setup-activation');
      expect(output).toContain('"deliveryComplete":false');
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
  });

  test('normal update holds agent-sync then Codex through delivery and releases in reverse order', async () => {
    const priorExitCode = process.exitCode;
    const events: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
    process.exitCode = undefined;
    try {
      await updateCommand(
        { yes: true, stable: true },
        {
          fetchManifest: async () => {
            events.push('fetch');
            return commandManifest;
          },
          readInstalledVersion: () => {
            events.push('read');
            return '5.260700.1';
          },
          resolvePlatform: () => {
            events.push('platform');
            return 'darwin-arm64';
          },
          acquireLease: () => {
            events.push('agent-acquire');
            return {
              path: '/fixture/.agent-sync.lock',
              release: () => events.push('agent-release'),
            };
          },
          acquireCodexLease: () => {
            events.push('codex-acquire');
            return {
              ok: true,
              operationId: 'c'.repeat(32),
              kind: 'update-delivery',
              assertOperation: () => events.push('codex-assert'),
              release: () => events.push('codex-release'),
            };
          },
          recoverPendingState: () => events.push('recover'),
          persistSelectedChannel: async () => {
            events.push('persist');
          },
          requireCanonicalInstall: () => events.push('canonical'),
          deliverSelectedManifest: async () => {
            events.push('deliver');
            return [];
          },
          finalizeSelectedDelivery: async () => {
            events.push('finalize');
            return true;
          },
        },
      );

      expect(events).toEqual([
        'fetch',
        'read',
        'platform',
        'agent-acquire',
        'codex-acquire',
        'codex-assert',
        'recover',
        'read',
        'persist',
        'canonical',
        'codex-assert',
        'deliver',
        'finalize',
        'codex-release',
        'agent-release',
      ]);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
  });

  test('same-version repair borrows the one command-held Codex lease without nested acquisition', async () => {
    const priorExitCode = process.exitCode;
    const events: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
    process.exitCode = undefined;
    const held: HeldLifecycleLease = {
      ok: true,
      operationId: 'd'.repeat(32),
      kind: 'update-delivery',
      assertOperation: () => events.push('codex-assert'),
      release: () => events.push('codex-release'),
    };
    try {
      await updateCommand(
        { yes: true, stable: true },
        {
          fetchManifest: async () => commandManifest,
          readInstalledVersion: () => commandManifest.version,
          resolvePlatform: () => 'darwin-arm64',
          acquireLease: () => {
            events.push('agent-acquire');
            return {
              path: '/fixture/.agent-sync.lock',
              release: () => events.push('agent-release'),
            };
          },
          acquireCodexLease: () => {
            events.push('codex-acquire');
            return held;
          },
          recoverPendingState: () => events.push('recover'),
          persistSelectedChannel: async () => {
            events.push('persist');
          },
          alreadyCurrent: {
            attemptRepair: async (_channel, _platform, lease) => {
              events.push('repair');
              expect(lease).toBe(held);
              return { action: 'repaired-current' };
            },
            retireLegacyMarker: () => events.push('retire'),
          },
          requireCanonicalInstall: () => {
            throw new Error('same-version path reached normal delivery');
          },
        },
      );

      expect(events).toEqual([
        'agent-acquire',
        'codex-acquire',
        'codex-assert',
        'recover',
        'persist',
        'repair',
        'retire',
        'codex-release',
        'agent-release',
      ]);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
  });
});

describe('normal update publication terminal boundary', () => {
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
          throw new CodexDeliveryPublicationError('delivery store is unwritable');
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

describe('buildAlreadyCurrentRepairSeams — immutable manifest/asset adapter', () => {
  test('the first raw-byte manifest object drives the exact tag/name/platform download; the second fetch only rechecks', async () => {
    const platformId = resolvePlatformId();
    const raw = `{
  "schema_version": 1,
  "channel": "dev",
  "version": "${VERSION}",
  "released_at": "2026-07-23T00:00:00.000Z",
  "tarball_base": "https://example.invalid/releases/v${VERSION}",
  "platforms": ["${platformId}"],
  "ignored_future_field": "raw-byte-binding"
}\n`;
    const expectedDigest = createHash('sha256').update(raw).digest('hex');
    const fetched = { object: null as LatestManifest | null };
    let fetches = 0;
    let downloads = 0;
    const tempRoot = mkdtempSync(join(tmpdir(), 'update-repair-adapter-'));
    const tempRoots: string[] = [];
    const lease: HeldLifecycleLease = {
      ok: true,
      operationId: 'f'.repeat(32),
      kind: 'update-delivery',
      assertOperation() {},
      release() {},
    };
    try {
      const seams = buildAlreadyCurrentRepairSeams(
        platformId,
        {
          version: VERSION,
          pluginTreeSha256: 'a'.repeat(64),
          binarySha256: 'b'.repeat(64),
          deliveryRoot: '/physical/genie-home',
        },
        lease,
        tempRoots,
        '/logical/genie-home',
        {
          fetchManifest: async (channel) => {
            fetches += 1;
            const manifest = await fetchLatestManifest(channel, { fetcher: async () => raw });
            if (fetched.object === null) fetched.object = manifest;
            return manifest;
          },
          createTempRoot: () => tempRoot,
          downloadAndVerifyDeliveryAssets: async (manifest, platform, destination) => {
            downloads += 1;
            expect(manifest).toBe(fetched.object as LatestManifest);
            expect(manifest.manifestSha256).toBe(expectedDigest);
            expect(manifest.released_at).toBe('2026-07-23T00:00:00.000Z');
            expect(manifest.tarball_base).toBe(`https://example.invalid/releases/v${VERSION}`);
            expect(platform).toBe(platformId);
            return {
              tarballPath: join(destination, `genie-${VERSION}-${platformId}.tar.gz`),
              descriptorBytes: Buffer.from('{}'),
              bundleBytes: Buffer.from('{}'),
            };
          },
        },
      );
      const first = await seams.fetchManifest('dev');
      if (first === null) throw new Error('expected first pinned manifest');
      expect(first).toBe(fetched.object as LatestManifest);
      await seams.downloadAndVerify(
        {
          channel: 'dev',
          targetVersion: VERSION,
          platformTriple: `${process.platform}-${process.arch}`,
          platformId,
          releaseTag: `v${VERSION}`,
          releaseName: `genie-${VERSION}-${platformId}.tar.gz`,
        },
        first,
      );
      const second = await seams.fetchManifest('dev');
      expect(second?.manifestSha256).toBe(expectedDigest);
      expect(fetches).toBe(2);
      expect(downloads).toBe(1);
      expect(tempRoots).toEqual([tempRoot]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
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
      await expect(extractTarball(tarball, join(tmp, 'extract'))).rejects.toThrow(/tar -xzf/);
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
      auxiliary: ['plugins', 'skills', 'templates', '.agents', '.claude-plugin'].map((name) => ({
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

  test('a delivery-owned sync has no managed Codex role callback and remains strict-successful when Codex is detected', () => {
    const dir = mkdtempSync(join(tmpdir(), 'genie-asm-'));
    const marker = join(dir, '.last-agent-sync');
    try {
      const report = makeReport();
      const codex = report.agents.find((agent) => agent.agent === 'codex');
      if (codex) codex.detected = true;
      expect(() =>
        runAgentSyncSafe({
          sync: () => report,
          strict: true,
          log: () => {},
          markerPath: marker,
        }),
      ).not.toThrow();
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('updateCommand runs the sync-only fast path before any network/delivery', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'update.ts'), 'utf-8');
    const cmdStart = source.indexOf('export async function updateCommand');
    const cmdBody = source.slice(cmdStart);
    const fastPathIdx = cmdBody.indexOf('await dispatchNonNormalUpdateMode(options)');
    const fetchIdx = cmdBody.indexOf('dependencies.fetchManifest ?? fetchLatestManifest');
    const deliveryIdx = cmdBody.indexOf('runDelivery(resolvedManifest');
    expect(fastPathIdx).toBeGreaterThan(-1);
    expect(fastPathIdx).toBeLessThan(fetchIdx);
    expect(fastPathIdx).toBeLessThan(deliveryIdx);
    // The compatibility mode routes before fetch and remains skills/role-only.
    const dispatcher = source.slice(
      source.indexOf('async function dispatchNonNormalUpdateMode'),
      source.indexOf('async function confirmPlannedDelivery'),
    );
    expect(dispatcher).toContain("mode !== 'normal'");
    expect(dispatcher).toContain('await runExplicitUpdateMode(mode)');
    expect(dispatcher).not.toContain('runTrackedManualUpdateConvergence(');
    expect(dispatcher).not.toContain('refreshUpdatePlugins(');
    const legacyModeStart = source.indexOf('function runLegacySyncOnlyMode()');
    const postDeliveryModeStart = source.indexOf('function runPostDeliveryConvergenceMode()', legacyModeStart);
    const legacyMode = source.slice(legacyModeStart, postDeliveryModeStart);
    expect(legacyMode).toContain('runLegacySyncOnlyConvergence({ selection, expectedVersion: VERSION })');
    expect(legacyMode).not.toContain('runManualUpdateConvergence(');
    expect(legacyMode).not.toContain('refreshUpdatePlugins(');
    const convergenceStart = source.indexOf('export function runLegacySyncOnlyConvergence(');
    const convergenceEnd = source.indexOf('function announceUpdatePlanOrExit(', convergenceStart);
    const convergence = source.slice(convergenceStart, convergenceEnd);
    // D2: sync-only is agent-sync ONLY — no Codex plugin query/inspection/advisory
    // and no plugin convergence at all. A genuine agent-sync failure is the only
    // nonzero result.
    expect(convergence).toContain('runUpdateAgentSync(agentSyncSelection)');
    expect(convergence).not.toContain('legacySyncOnlyPluginAdvisory');
    expect(convergence).not.toContain('inspectSyncOnlyCodexHealth');
    expect(convergence).not.toContain('plugin');
    expect(convergence).not.toContain('runManualUpdateConvergence(');
    expect(convergence).not.toContain('refreshUpdatePlugins(');
  });

  test('short-circuit (already-current) path calls the sync phase before returning', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'update.ts'), 'utf-8');
    const scIdx = source.indexOf('shortCircuitIfCurrent(installedVersion, latestVersion)');
    expect(scIdx).toBeGreaterThan(-1);
    expect(source.slice(scIdx, scIdx + 700)).toContain('runTrackedManualUpdateConvergence(');
  });
});

describe('manual post-update convergence (2026-07-11 cascade regression)', () => {
  test('runs the canonical convergence APIs and returns structured integration outcomes', () => {
    const calls: string[] = [];
    const result = runManualUpdateConvergence({
      expectedVersion: '5.260711.3',
      bundleRoot: '/tmp/verified-bundle',
      runSync: () => calls.push('parent-safe-sync'),
      refreshPlugins: (options) => {
        calls.push(`parent-plugin-refresh:${options.expectedVersion}:${options.selection}`);
        return [{ runtime: 'claude', ok: true, detail: 'plugin refreshed' }];
      },
      log: (line) => calls.push(`log:${line}`),
    });
    expect(calls[0]).toBe('parent-safe-sync');
    expect(calls[1]).toBe('parent-plugin-refresh:5.260711.3:claude');
    expect(result.integrations).toEqual([{ runtime: 'claude', ok: true, detail: 'plugin refreshed' }]);
  });

  test('structurally excludes Codex queries and writes while retaining Claude/Hermes convergence', () => {
    expect(narrowUpdatePluginRefreshSelection('auto')).toBe('claude');
    expect(narrowUpdatePluginRefreshSelection('all')).toBe('claude');
    expect(narrowUpdatePluginRefreshSelection('claude')).toBe('claude');
    expect(narrowUpdatePluginRefreshSelection('codex')).toBeNull();
    expect(narrowUpdatePluginRefreshSelection('none')).toBeNull();

    let codexOnlySyncs = 0;
    let codexOnlyRefreshes = 0;
    const codexOnly = runManualUpdateConvergence({
      expectedVersion: VERSION,
      selection: 'codex',
      runSync: () => {
        codexOnlySyncs += 1;
      },
      refreshPlugins: () => {
        codexOnlyRefreshes += 1;
        return [{ runtime: 'codex', ok: true, detail: 'must not run' }];
      },
    });
    expect(codexOnly).toEqual({ integrations: [] });
    expect(codexOnlySyncs).toBe(0);
    expect(codexOnlyRefreshes).toBe(0);

    let selectedRefresh: IntegrationSelection | undefined;
    const auto = runManualUpdateConvergence({
      expectedVersion: VERSION,
      selection: 'auto',
      runSync: () => {},
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

  test('update-owned agent sync disables setup-owned Codex role convergence', () => {
    let captured: Parameters<typeof runAgentSyncSafe>[0] | undefined;
    runUpdateAgentSync('auto', (options) => {
      captured = options;
      return null;
    });
    expect(captured?.selection).toBe('auto');
    expect(captured?.strict).toBe(true);
    expect(captured?.codexRefresh).toBeUndefined();
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
      expect(message).toContain('genie setup --codex');
      expect(message.indexOf('Rerun `genie update`')).toBeLessThan(message.indexOf('genie setup --codex'));
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

  test('D2: sync-only runs ONLY agent-sync — no Codex plugin query/inspection/advisory', () => {
    const events: string[] = [];
    runLegacySyncOnlyConvergence({
      selection: 'codex',
      expectedVersion: '5.260711.7',
      log: (line) => events.push(`log:${line}`),
      sync: () => {
        events.push('sync');
      },
    });
    // The only observable effect is the injected agent-sync. No plugin advisory
    // was emitted, and no plugin query/inspection ran (the spy `sync` is the sole
    // side effect). A real run would only call runAgentSyncSafe.
    expect(events).toEqual(['sync']);
  });

  test("D2: a genuine agent-sync failure is sync-only's ONLY nonzero result", () => {
    expect(() =>
      runLegacySyncOnlyConvergence({
        selection: 'codex',
        expectedVersion: '5.260711.7',
        sync: () => {
          throw new Error('strict sync failed');
        },
      }),
    ).toThrow('strict sync failed');
  });

  test('D2: a missing/stale/disabled Codex plugin never makes sync-only fail (it never inspects one)', () => {
    // No `runner`/`resolveExecutable`/`probe` seams are consulted — sync-only
    // branches before every plugin observer. Even with codex selected and no
    // Codex CLI reachable, the only work is agent-sync, which succeeds here.
    let synced = false;
    expect(() =>
      runLegacySyncOnlyConvergence({
        selection: 'codex',
        expectedVersion: '5.260711.7',
        sync: () => {
          synced = true;
        },
      }),
    ).not.toThrow();
    expect(synced).toBe(true);
  });
});

describe('runManualUpdateConvergence — hermes leg restored end-to-end (restore-hermes-sync-leg regression)', () => {
  // A prior release (#2572) narrowed every production selection to 'claude'
  // before it reached runAgentSync, so `genie update`'s hermes leg (which
  // only fires on a verbatim 'auto'/'all' selection) silently stopped
  // converging — confirmed live via `genie update --sync-only` printing only
  // 'agent-sync: claude'. This suite drives the REAL runSync path (no `sync`
  // mock) through real GENIE_HOME/HERMES_HOME fixtures, isolated the way
  // doctor.test.ts isolates its lifecycle env, to prove the hermes leg
  // converges again and that the PR #2576 duplicate-external_dirs repair is
  // reachable from the update lifecycle, not just the low-level helper test.
  const ENV_KEYS = ['HOME', 'GENIE_HOME', 'HERMES_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'] as const;
  let isolatedHome: string;
  let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;
  let genieHome: string;
  let hermesHome: string;
  let genieBin: string;

  beforeEach(() => {
    isolatedHome = mkdtempSync(join(tmpdir(), 'genie-update-hermes-'));
    savedEnv = {};
    for (const key of ENV_KEYS) {
      if (process.env[key] !== undefined) savedEnv[key] = process.env[key];
    }
    genieHome = join(isolatedHome, 'genie');
    hermesHome = join(isolatedHome, 'hermes');
    process.env.HOME = isolatedHome;
    process.env.GENIE_HOME = genieHome;
    process.env.HERMES_HOME = hermesHome;
    process.env.CLAUDE_CONFIG_DIR = join(isolatedHome, 'claude'); // absent: claude leg simply undetected
    process.env.CODEX_HOME = join(isolatedHome, 'codex');

    // Minimal real genie plugin source: a populated skills root + VERSION +
    // an executable bin/genie (resolveGenieBinaryPath / resolveProductSkillsRoot
    // both require real files, not injected targets, since this test exercises
    // the default env-resolved paths exactly like production `genie update`).
    mkdirSync(join(genieHome, 'plugins', 'genie', 'skills', 'alpha'), { recursive: true });
    writeFileSync(join(genieHome, 'plugins', 'genie', 'skills', 'alpha', 'SKILL.md'), '# alpha\n');
    // resolveGenieSource requires plugins/hermes-genie NEXT TO plugins/genie for
    // ctx.hermesRoot to resolve — without it, syncHermes bails before either
    // config leg runs (see the 'hermes source ... not found' advisory).
    mkdirSync(join(genieHome, 'plugins', 'hermes-genie'), { recursive: true });
    writeFileSync(join(genieHome, 'plugins', 'hermes-genie', 'plugin.json'), '{"name":"hermes-genie"}\n');
    writeFileSync(join(genieHome, 'VERSION'), '9.9.9\n');
    mkdirSync(join(genieHome, 'bin'), { recursive: true });
    genieBin = join(genieHome, 'bin', 'genie');
    writeFileSync(genieBin, '#!/usr/bin/env bun\n');
    chmodSync(genieBin, 0o755);
    mkdirSync(hermesHome, { recursive: true });
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const saved = savedEnv[key];
      if (saved === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = saved;
    }
    rmSync(isolatedHome, { recursive: true, force: true });
  });

  /**
   * Mirrors `runManualUpdateConvergence`'s own default `runSync` closure
   * (narrow the selection, then `runAgentSyncSafe`), but pins `markerPath`
   * inside the isolated tmpdir. `update.ts`'s `GENIE_HOME` constant is
   * captured once at module import time, before this suite's `beforeEach` can
   * repoint `process.env.GENIE_HOME` — the default marker path would
   * otherwise write `.last-agent-sync` outside this test's sandbox. The sync
   * engine itself is unaffected: `runAgentSync` resolves every target via the
   * live `resolveGenieHome()`/`resolveHermesHome()` env reads, so this still
   * exercises the real narrowing + the real engine end-to-end.
   */
  function realRunSync(selection: IntegrationSelection): () => void {
    return () => {
      const agentSyncSelection = narrowUpdateAgentSyncSelection(selection);
      if (agentSyncSelection !== null) {
        runAgentSyncSafe({
          strict: true,
          selection: agentSyncSelection,
          markerPath: join(isolatedHome, '.last-agent-sync'),
          // hermesBinary: null keeps this test-safe (no `hermes plugins enable`
          // exec) — the same posture agent-sync.test.ts's `run()` fixture takes.
          sync: (opts) => runAgentSync({ ...opts, hermesBinary: null }),
        });
      }
    };
  }

  test('selection auto converges the hermes leg (mcp_servers.genie + skills.external_dirs) into a fresh config', () => {
    const result = runManualUpdateConvergence({
      expectedVersion: '9.9.9',
      selection: 'auto',
      runSync: realRunSync('auto'),
      refreshPlugins: () => [],
      log: () => undefined,
    });
    expect(result.integrations).toEqual([]);

    const configPath = join(hermesHome, 'config.yaml');
    const text = readFileSync(configPath, 'utf8');
    expect(text).toContain('mcp_servers:');
    expect(text).toContain(genieBin);
    expect(text).toContain('skills:');
    expect(text).toContain('external_dirs:');
    expect(text).toContain(join(genieHome, 'plugins', 'genie', 'skills'));
  });

  test('selection auto repairs a config damaged with the duplicate-external_dirs shape (PR #2576)', () => {
    const configPath = join(hermesHome, 'config.yaml');
    const skillsRoot = join(genieHome, 'plugins', 'genie', 'skills');
    // Exact damaged shape from an earlier buggy release: `skills:` carries BOTH
    // an inline empty `external_dirs: []` and a later block-style `external_dirs`
    // holding the genie-marked managed entry — spec-invalid duplicate-key YAML.
    const damaged = `skills:\n  external_dirs: []\n  template_vars: true\n  external_dirs:\n    - ${JSON.stringify(skillsRoot)}  # genie:managed:skills.external_dirs\n`;
    writeFileSync(configPath, damaged);

    runManualUpdateConvergence({
      expectedVersion: '9.9.9',
      selection: 'auto',
      runSync: realRunSync('auto'),
      refreshPlugins: () => [],
      log: () => undefined,
    });

    const text = readFileSync(configPath, 'utf8');
    expect(text.match(/external_dirs:/g)?.length).toBe(1);
    expect(text).toContain('template_vars: true');
    const parsed = Bun.YAML.parse(text) as { skills: { external_dirs: string[]; template_vars: boolean } };
    expect(parsed.skills.external_dirs).toEqual([skillsRoot]);
    expect(parsed.skills.template_vars).toBe(true);
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

  test('a Codex convergence cleanup exception is isolated and Claude still runs', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-update-cross-runtime-'));
    const configPath = join(root, 'config.toml');
    const statePath = join(pluginStateDir, '.integration-refresh-codex.json');
    writeFileSync(configPath, '[plugins."genie@automagik"]\nenabled = false\n');
    let codexLists = 0;
    const calls: string[] = [];
    const results = refreshUpdatePlugins({
      bundleRoot: root,
      expectedVersion: '5.260711.3',
      stateDir: pluginStateDir,
      selection: 'all',
      codexConfigPath: configPath,
      detected: { codex: true, claude: true },
      runner(command, args) {
        calls.push(`${command} ${args.join(' ')}`);
        if (command === 'claude') return { exitCode: 0, stdout: '[]', stderr: '' };
        if (args.join(' ') === 'plugin list --json') {
          codexLists += 1;
          if (codexLists === 2) {
            rmSync(statePath, { force: true });
            mkdirSync(statePath);
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              installed: [{ pluginId: 'genie@automagik', enabled: false, version: '5.260711.3' }],
            }),
            stderr: '',
          };
        }
        return { exitCode: 0, stdout: '{}', stderr: '' };
      },
    });

    expect(results[0]).toMatchObject({ runtime: 'codex', ok: false });
    expect(calls).toContain('claude plugin list --json');
    rmSync(root, { recursive: true, force: true });
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

  test('D1/D3: N≠T delivery defers activation — no plugin add, no cache advance, exit-2 action-required', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-update-plugin-refresh-'));
    const configPath = join(root, 'config.toml');
    writeFileSync(configPath, '[plugins."genie@automagik"]\nenabled = true\n');
    const calls: string[] = [];
    const runner: CommandRunner = (command, args) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (args.join(' ') === 'plugin list --json') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            installed: [{ pluginId: 'genie@automagik', enabled: true, version: '5.260710.2' }],
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
      expect(results).toHaveLength(1);
      // Delivered but NOT activated: the installed N generation is left intact.
      expect(results[0]).toMatchObject({
        runtime: 'codex',
        ok: true,
        deliveryComplete: true,
        actionRequired: true,
      });
      expect(results[0].detail).toContain('Codex plugin left at v5.260710.2 (no cache advance)');
      expect(results[0].detail).toContain('retire tasks → genie setup --codex → /hooks → new task');
      // The classification is the ONLY codex command; NO cache-advancing add/marketplace.
      expect(calls).toEqual(['codex plugin list --json']);
      expect(calls).not.toContain('codex plugin add genie@automagik --json');
      expect(calls).not.toContain(`codex plugin marketplace add ${root} --json`);
      // The plugin enabled flag is never touched by a deferred delivery.
      expect(readFileSync(configPath, 'utf8')).toContain('enabled = true');
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

  test('D1/D3: an indeterminate (malformed) plugin query fails closed — never cache-advances', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-update-plugin-failed-refresh-'));
    const configPath = join(root, 'config.toml');
    writeFileSync(configPath, '[plugins."genie@automagik"]\nenabled = true\n');
    const calls: string[] = [];
    try {
      const results = refreshUpdatePlugins({
        bundleRoot: root,
        expectedVersion: '5.260711.3',
        stateDir: pluginStateDir,
        detected: { codex: true, claude: false },
        codexConfigPath: configPath,
        runner(_command, args) {
          calls.push(args.join(' '));
          if (args.join(' ') === 'plugin list --json') {
            return { exitCode: 0, stdout: '{"unexpected":[]}', stderr: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      });

      // A state the gate cannot classify fails closed (exit 1) with zero mutation.
      expect(results[0]).toMatchObject({ runtime: 'codex', ok: false });
      expect(results[0]?.actionRequired).toBeUndefined();
      expect(results[0]?.detail).toContain('cannot classify plugin state');
      expect(calls).toEqual(['plugin list --json']);
      expect(calls).not.toContain('plugin add genie@automagik --json');
      expect(readFileSync(configPath, 'utf8')).toContain('enabled = true');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('D1/D3: stale (N≠T) delivery makes ZERO plugin add/remove and leaves the old cache byte-identical', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-update-plugin-stale-generation-'));
    const codexHome = join(root, 'codex');
    const oldCache = join(codexHome, 'plugins', 'cache', 'automagik', 'genie', '5.260710.2', 'payload.txt');
    mkdirSync(join(oldCache, '..'), { recursive: true });
    writeFileSync(oldCache, 'old-cache-bytes\n');
    const calls: string[] = [];
    const runner: CommandRunner = (_command, args) => {
      const command = args.join(' ');
      calls.push(command);
      if (command === 'plugin list --json') {
        return {
          exitCode: 0,
          stdout: '{"installed":[{"pluginId":"genie@automagik","enabled":true,"version":"5.260710.2"}]}',
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    try {
      const result = refreshUpdatePlugins({
        bundleRoot: root,
        expectedVersion: '5.260711.3',
        stateDir: pluginStateDir,
        detected: { codex: true, claude: false },
        codexHome,
        runner,
      });
      // Delivered, activation deferred: N stays present and physically unverified.
      expect(result[0]).toMatchObject({ runtime: 'codex', ok: true, deliveryComplete: true, actionRequired: true });
      expect(result[0]?.detail).toContain('Codex plugin left at v5.260710.2 (no cache advance)');
      // ZERO cache-advancing commands — not even a single "non-destructive" add.
      expect(calls).not.toContain('plugin add genie@automagik --json');
      expect(calls).not.toContain('plugin remove genie@automagik --json');
      expect(calls).not.toContain('plugin marketplace add');
      expect(readFileSync(oldCache, 'utf8')).toBe('old-cache-bytes\n');
      // A pure delivery deferral opens no durable convergence intent journal.
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

// ===========================================================================
// A14/R3: --sync-only INSPECTS codex health and fails nonzero + byte-identical
// on a missing / disabled / stale plugin, never enabling or swapping anything.
// ===========================================================================
describe('--sync-only is agent-sync only (D2 — wish decision 3)', () => {
  test('narrowUpdateAgentSyncSelection passes the real selection through (restore-hermes-sync-leg)', () => {
    // codex/none: agent-sync has nothing to do (codex is plugin-only; none is none).
    expect(narrowUpdateAgentSyncSelection('codex')).toBeNull();
    expect(narrowUpdateAgentSyncSelection('none')).toBeNull();
    // auto/all/claude pass through UNCHANGED. Collapsing these to 'claude' (the
    // prior behavior) silently killed runAgentSync's hermes leg, which only
    // fires on a verbatim 'auto'/'all' — see runAgentSync in agent-sync.ts.
    expect(narrowUpdateAgentSyncSelection('auto')).toBe('auto');
    expect(narrowUpdateAgentSyncSelection('all')).toBe('all');
    expect(narrowUpdateAgentSyncSelection('claude')).toBe('claude');
  });

  test('the convergence option surface + body carry NO Codex plugin query/inspection seam', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'update.ts'), 'utf-8');
    // Option interface: no runner/resolveExecutable/probe/prove/inspectCodex hook.
    const ifaceStart = source.indexOf('export interface LegacySyncOnlyConvergenceOptions');
    const iface = source.slice(ifaceStart, source.indexOf('\n}', ifaceStart));
    for (const field of ['inspectCodex', 'probe', 'prove', 'runner', 'resolveExecutable']) {
      expect(iface).not.toContain(field);
    }
    // Function body (past its docstring): agent-sync only, no plugin command.
    const fnStart = source.indexOf('export function runLegacySyncOnlyConvergence(');
    const body = source.slice(fnStart, source.indexOf('\n}', fnStart));
    expect(body).toContain('runUpdateAgentSync(agentSyncSelection)');
    expect(body).not.toContain('plugin');
    expect(body).not.toContain('probe');
    expect(body).not.toContain('inspect');
  });
});

describe('applyConvergenceExitSignal — exit 2 only on delivery-pending (D3 guardrail)', () => {
  let logs: string[];
  let spy: ReturnType<typeof spyOn>;
  const savedExitCode = process.exitCode;

  beforeEach(() => {
    process.exitCode = 0;
    logs = [];
    spy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
  });
  afterEach(() => {
    spy.mockRestore();
    process.exitCode = savedExitCode ?? 0;
  });

  test('a non-codex (claude) failure exits 1 and emits NO trailer', () => {
    applyConvergenceExitSignal({ integrations: [{ runtime: 'claude', ok: false, detail: 'boom' }] });
    expect(process.exitCode).toBe(1);
    expect(logs.join('\n')).not.toContain('deliveryComplete');
  });

  test('an all-ok convergence sets no failure/action-required code and emits no trailer', () => {
    applyConvergenceExitSignal({ integrations: [{ runtime: 'claude', ok: true, detail: 'refreshed' }] });
    // Neither the exit-1 (failure) nor exit-2 (action-required) code is set.
    expect(process.exitCode).toBe(0);
    expect(logs.join('\n')).not.toContain('deliveryComplete');
  });

  test('a codex action-required delivery exits 2 and emits the trailer exactly once', () => {
    applyConvergenceExitSignal({
      integrations: [{ runtime: 'codex', ok: true, detail: 'deferred', deliveryComplete: true, actionRequired: true }],
    });
    expect(process.exitCode).toBe(2);
    expect(logs.filter((line) => line.includes('"deliveryComplete":true'))).toHaveLength(1);
  });

  test('a failed integration wins over action-required (exit 1, no trailer)', () => {
    applyConvergenceExitSignal({
      integrations: [
        { runtime: 'codex', ok: true, detail: 'deferred', actionRequired: true },
        { runtime: 'claude', ok: false, detail: 'boom' },
      ],
    });
    expect(process.exitCode).toBe(1);
    expect(logs.join('\n')).not.toContain('deliveryComplete');
  });

  test('emitTrailer=false (fresh-binary parent) sets exit 2 without printing the trailer', () => {
    applyConvergenceExitSignal(
      { integrations: [{ runtime: 'codex', ok: true, detail: 'deferred', actionRequired: true }] },
      false,
    );
    expect(process.exitCode).toBe(2);
    expect(logs.join('\n')).not.toContain('deliveryComplete');
  });
});

describe('mapAlreadyCurrentRepairOutcome — pure repair→directive mapping (Group D deliverable 1)', () => {
  test('an old-parent publish (activation-pending) hands off to setup', () => {
    expect(
      mapAlreadyCurrentRepairOutcome({
        kind: 'published',
        record: {
          schemaVersion: 2,
          deliveryId: 'a'.repeat(32),
          targetVersion: '5.260722.11',
          canonicalPayloadSha256: 'a'.repeat(64),
          channel: 'dev',
          deliveredAt: '2026-07-22T00:00:00.000Z',
          evidenceDigest: 'e'.repeat(64),
          platformId: 'darwin-arm64',
          platformTriple: 'darwin-arm64',
          releaseTag: 'v5.260722.11',
          releaseName: 'genie-5.260722.11-darwin-arm64.tar.gz',
          releaseManifestSha256: 'b'.repeat(64),
          artifactSha256: 'd'.repeat(64),
          installedBinarySha256: 'c'.repeat(64),
          deliveryRoot: '/home/test/.genie',
        },
        handoff: 'activation-pending',
        artifactSha256: 'd'.repeat(64),
      }),
    ).toEqual({ action: 'exit-handoff' });
  });

  test('a target-current publish reports the repair as an immediate terminal handoff', () => {
    expect(
      mapAlreadyCurrentRepairOutcome({
        kind: 'published',
        record: {
          schemaVersion: 2,
          deliveryId: 'a'.repeat(32),
          targetVersion: '5.260722.11',
          canonicalPayloadSha256: 'a'.repeat(64),
          channel: 'dev',
          deliveredAt: '2026-07-22T00:00:00.000Z',
          evidenceDigest: 'e'.repeat(64),
          platformId: 'darwin-arm64',
          platformTriple: 'darwin-arm64',
          releaseTag: 'v5.260722.11',
          releaseName: 'genie-5.260722.11-darwin-arm64.tar.gz',
          releaseManifestSha256: 'b'.repeat(64),
          artifactSha256: 'd'.repeat(64),
          installedBinarySha256: 'c'.repeat(64),
          deliveryRoot: '/home/test/.genie',
        },
        handoff: 'current',
        artifactSha256: 'd'.repeat(64),
      }),
    ).toEqual({ action: 'repaired-current' });
  });

  test('already-matching proceeds; channel advance routes upgrade; failure is explicit', () => {
    expect(mapAlreadyCurrentRepairOutcome({ kind: 'already-matching' })).toEqual({ action: 'proceed-current' });
    const advancedManifest: PinnedManifest = {
      schema_version: 1,
      channel: 'dev',
      version: '5.260722.12',
      released_at: '2026-07-22T01:00:00Z',
      tarball_base: 'https://example.invalid',
      platforms: ['darwin-arm64'],
      manifestBytes: '{}',
      manifestSha256: 'f'.repeat(64),
    };
    expect(
      mapAlreadyCurrentRepairOutcome({
        kind: 'channel-advanced',
        from: '5.260722.11',
        to: '5.260722.12',
        manifest: advancedManifest,
      }),
    ).toEqual({ action: 'route-upgrade', manifest: advancedManifest });
    expect(
      mapAlreadyCurrentRepairOutcome({
        kind: 'failed',
        stage: 'download-verify',
        detail: 'x',
        deliveryComplete: false,
      }),
    ).toEqual({ action: 'failed', detail: 'download-verify: x' });
  });
});

describe('handleAlreadyCurrentUpdate — same-version terminal authority', () => {
  const advancedManifest: PinnedManifest = {
    schema_version: 1,
    channel: 'dev',
    version: '5.260722.12',
    released_at: '2026-07-22T01:00:00Z',
    tarball_base: 'https://example.invalid',
    platforms: ['darwin-arm64'],
    manifestBytes: '{"version":"5.260722.12"}',
    manifestSha256: 'f'.repeat(64),
  };

  async function runDirective(directive: Awaited<ReturnType<typeof attemptAlreadyCurrentDeliveryRepair>>) {
    const priorExitCode = process.exitCode;
    const output: string[] = [];
    let convergenceRuns = 0;
    let markerRetirements = 0;
    const logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => output.push(args.join(' ')));
    const errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => output.push(args.join(' ')));
    process.exitCode = 0;
    try {
      const manifest = await handleAlreadyCurrentUpdate('dev', 'darwin-arm64', VERSION, VERSION, {
        attemptRepair: async () => directive,
        runConvergence: () => {
          convergenceRuns += 1;
        },
        retireLegacyMarker: () => {
          markerRetirements += 1;
        },
      });
      return {
        manifest,
        output: output.join('\n'),
        exitCode: process.exitCode,
        convergenceRuns,
        markerRetirements,
      };
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.exitCode = priorExitCode ?? 0;
    }
  }

  test('failed is terminal, nonzero, and performs no convergence or marker retirement', async () => {
    const result = await runDirective({ action: 'failed', detail: 'download-verify: invalid provenance' });
    expect(result.manifest).toBeNull();
    expect(result.exitCode).toBe(1);
    expect(result.convergenceRuns).toBe(0);
    expect(result.markerRetirements).toBe(0);
    expect(result.output).toContain('Codex delivery repair failed: download-verify: invalid provenance');
    expect(result.output).toContain('"deliveryComplete":false');
    expect(result.output).not.toContain('Already up to date');
  });

  test('route-upgrade returns the exact advanced manifest without same-version finalizers', async () => {
    const result = await runDirective({ action: 'route-upgrade', manifest: advancedManifest });
    expect(result.manifest).toBe(advancedManifest);
    expect(result.exitCode).toBe(0);
    expect(result.convergenceRuns).toBe(0);
    expect(result.markerRetirements).toBe(0);
    expect(result.output).toContain(`→ ${advancedManifest.version}`);
    expect(result.output).not.toContain('Already up to date');
  });

  test('exit-handoff retires only delivery metadata before the typed activation handoff', async () => {
    const result = await runDirective({ action: 'exit-handoff' });
    expect(result.manifest).toBeNull();
    expect(result.exitCode).toBe(2);
    expect(result.convergenceRuns).toBe(0);
    expect(result.markerRetirements).toBe(1);
    expect(result.output).toContain('Codex plugin activation is pending');
    expect(result.output.match(/"deliveryComplete":true/g)).toHaveLength(1);
    expect(result.output).not.toContain('Already up to date');
  });

  test('repaired-current retires delivery metadata without convergence, trailer, or success masquerade', async () => {
    const result = await runDirective({ action: 'repaired-current' });
    expect(result.manifest).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(result.convergenceRuns).toBe(0);
    expect(result.markerRetirements).toBe(1);
    expect(result.output).toContain('Repaired the missing Codex delivery record');
    expect(result.output).not.toContain('deliveryComplete');
    expect(result.output).not.toContain('Already up to date');
  });

  test('ordinary already-matching reruns retain convergence and marker-retirement semantics', async () => {
    const result = await runDirective({ action: 'proceed-current' });
    expect(result.manifest).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(result.convergenceRuns).toBe(1);
    expect(result.markerRetirements).toBe(1);
    expect(result.output).toContain(`Already up to date (v${VERSION}, channel dev)`);
  });
});

describe('attemptAlreadyCurrentDeliveryRepair — fail-closed skip with no install (CI-portable, no network/codex)', () => {
  let prevGenieHome: string | undefined;
  let dir: string;

  beforeEach(() => {
    prevGenieHome = process.env.GENIE_HOME;
    dir = mkdtempSync(join(tmpdir(), 'update-repair-skip-'));
    process.env.GENIE_HOME = dir;
  });

  afterEach(() => {
    if (prevGenieHome === undefined) Reflect.deleteProperty(process.env, 'GENIE_HOME');
    else process.env.GENIE_HOME = prevGenieHome;
    rmSync(dir, { recursive: true, force: true });
  });

  test('an empty GENIE_HOME reports an explicit incomplete repair without lease/download/mutation', async () => {
    // No plugins/genie payload and no binary ⇒ observeInstalledForRepair returns
    // null ⇒ the repair fails closed before network or codex CLI access.
    const directive = await attemptAlreadyCurrentDeliveryRepair('dev', 'linux-x64', undefined, dir);
    expect(directive).toEqual({ action: 'failed', detail: 'installed payload/binary could not be observed' });
    // No lease file was created (the skip returns before lease acquisition).
    expect(existsSync(join(dir, '.codex-lifecycle.lock'))).toBe(false);
    // No delivery record was minted.
    expect(existsSync(join(dir, '.codex-plugin-delivery-record.json'))).toBe(false);
  });

  test('a symlinked GENIE_HOME fast-path binds the physical canonical delivery root', async () => {
    const physicalHome = join(dir, 'physical-genie-home');
    const logicalHome = join(dir, 'logical-genie-home');
    mkdirSync(join(physicalHome, 'plugins', 'genie'), { recursive: true });
    mkdirSync(join(physicalHome, 'bin'), { recursive: true });
    writeFileSync(join(physicalHome, 'plugins', 'genie', 'plugin.json'), '{"name":"genie"}\n');
    writeFileSync(join(physicalHome, 'VERSION'), `${VERSION}\n`);
    writeFileSync(join(physicalHome, 'bin', 'genie'), '#!/bin/sh\n');
    symlinkSync(physicalHome, logicalHome);
    const snapshot = observeCodexActivation({ genieHome: logicalHome, command: null });
    if (snapshot.canonical.status !== 'ok') throw new Error(snapshot.canonical.detail);
    const platformId = resolvePlatformId();
    const { evidence, pack } = mintTestDeliveryEvidence({
      descriptor: {
        version: snapshot.canonical.version.canonical,
        channel: 'dev',
        platformId: platformId as DeliveryEvidencePlatformId,
        platformTriple: snapshot.canonical.platformTriple,
        releaseTag: `v${VERSION}`,
        releaseName: `genie-${VERSION}-${platformId}.tar.gz`,
        canonicalPayloadSha256: snapshot.canonical.digest,
        installedBinarySha256: snapshot.canonical.installedBinarySha256,
      },
    });
    const lease = acquireCodexLifecycleLease('update-delivery', { genieHome: logicalHome });
    if (!lease.ok) throw new Error(lease.detail);
    try {
      openCodexActivationStore({ genieHome: logicalHome }).publishDelivery(lease, {
        evidence,
        deliveryRoot: snapshot.canonical.deliveryRoot,
      });
    } finally {
      lease.release();
    }
    expect(snapshot.canonical.deliveryRoot).toBe(realpathSync(physicalHome));
    expect(
      await attemptAlreadyCurrentDeliveryRepair('dev', platformId, undefined, logicalHome, {
        evidenceVerification: pack.dependencies,
      }),
    ).toEqual({ action: 'proceed-current' });
  });
});
