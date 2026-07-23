import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ActivationExecutionResult,
  type ActivationPhaseHooks,
  type CodexActivationExecutorDeps,
  executeCodexActivation,
  runBoundedH3Smoke,
} from './codex-activation-executor.js';
import {
  type AuthorizationResult,
  type CodexActivationStore,
  type CodexActivationStoreOptions,
  type RefreshIntent,
  authorizeCodexActivation,
  classifyCodexActivation,
  openCodexActivationStore,
  requestRetirementAssertion,
  scanPhysicalTree,
} from './codex-activation.js';
import { mintTestDeliveryEvidence } from './codex-delivery-evidence.test-support.js';
import { acquireLifecycleLease } from './codex-lifecycle-lease.js';
import type { CommandResult, CommandRunner } from './runtime-integrations.js';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const REAL_SESSION_CONTEXT = join(REPO_ROOT, 'plugins', 'genie', 'scripts', 'session-context.cjs');
const FROM_VERSION = '5.260710.1';
const TARGET_VERSION = '5.260712.1';
const NEWER_VERSION = '5.260799.9';
const STUB_COMMAND = '/stub/codex';

const TEST_EVIDENCE_VERIFICATION = {
  verifyBundle: () => ({ integratedTime: '1753228800' }),
};

// ---------------------------------------------------------------------------
// Fixture isolation contract
// ---------------------------------------------------------------------------

interface EnvSnapshot {
  restore(): void;
}

function isolateEnv(fixtureRoot: string): EnvSnapshot {
  const keys = [
    'HOME',
    'GENIE_HOME',
    'CODEX_HOME',
    'TMPDIR',
    'GENIE_BUNDLE_ROOT',
    'CODEX_THREAD_ID',
    'CI',
    'GENIE_WORKER',
  ];
  const prior = new Map<string, string | undefined>();
  for (const key of keys) prior.set(key, process.env[key]);
  const home = join(fixtureRoot, 'home');
  const temp = join(fixtureRoot, 'tmp');
  mkdirSync(home, { recursive: true });
  mkdirSync(temp, { recursive: true });
  process.env.HOME = home;
  process.env.GENIE_HOME = join(fixtureRoot, 'genie-home');
  process.env.CODEX_HOME = join(fixtureRoot, 'codex-home');
  process.env.TMPDIR = temp;
  for (const key of ['GENIE_BUNDLE_ROOT', 'CODEX_THREAD_ID', 'CI', 'GENIE_WORKER']) {
    Reflect.deleteProperty(process.env, key);
  }
  return {
    restore(): void {
      for (const [key, value] of prior) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Stubbed codex CLI + fixture state
// ---------------------------------------------------------------------------

interface Fixture {
  root: string;
  genieHome: string;
  codexHome: string;
  configPath: string;
  canonicalRoot: string;
  canonicalPayloadDir: string;
  targetCacheDir: string;
  canonicalDigest: string;
  runnerCalls: string[];
  makeRunner(): CommandRunner;
  openStore(): CodexActivationStore;
}

function json(value: unknown): CommandResult {
  return { exitCode: 0, stdout: JSON.stringify(value), stderr: '' };
}

function configEnabled(configPath: string): boolean {
  return !/enabled\s*=\s*false/.test(readFileSync(configPath, 'utf8'));
}

function setConfigEnabled(configPath: string, enabled: boolean): void {
  writeFileSync(configPath, `[plugins."genie@automagik"]\nenabled = ${enabled}\n`, { encoding: 'utf8', mode: 0o600 });
}

interface FixtureOptions {
  /** Registration version reported before `plugin add`; null means absent. */
  from: string | null;
  target?: string;
  initialEnabled: boolean;
  /** Create a physical N cache generation (needed for activation-pending). */
  createFromCache?: boolean;
}

function buildFixture(options: FixtureOptions): Fixture {
  const target = options.target ?? TARGET_VERSION;
  const root = mkdtempSync(join(tmpdir(), 'genie-executor-fixture-'));
  const genieHome = join(root, 'genie-home');
  const codexHome = join(root, 'codex-home');
  const canonicalRoot = genieHome;
  const canonicalPayloadDir = join(canonicalRoot, 'plugins', 'genie');
  const familyDir = join(codexHome, 'plugins', 'cache', 'automagik', 'genie');
  const targetCacheDir = join(familyDir, target);
  mkdirSync(genieHome, { recursive: true });
  mkdirSync(join(canonicalPayloadDir, 'scripts'), { recursive: true });
  mkdirSync(join(canonicalPayloadDir, 'codex-agents'), { recursive: true });
  mkdirSync(familyDir, { recursive: true });

  // Canonical payload: the real H3 script plus a couple of physical files.
  cpSync(REAL_SESSION_CONTEXT, join(canonicalPayloadDir, 'scripts', 'session-context.cjs'));
  writeFileSync(join(canonicalPayloadDir, 'README.md'), 'genie codex payload\n');
  mkdirSync(join(canonicalPayloadDir, 'hooks'), { recursive: true });
  writeFileSync(join(canonicalPayloadDir, 'hooks', 'codex-hooks.json'), '{"hooks":{}}\n');
  writeFileSync(join(canonicalRoot, 'VERSION'), `${target}\n`);
  writeFileSync(join(canonicalRoot, 'genie'), '#!/bin/sh\n');

  const configPath = join(codexHome, 'config.toml');
  setConfigEnabled(configPath, options.initialEnabled);

  if (options.createFromCache && options.from !== null) {
    const fromCache = join(familyDir, options.from);
    mkdirSync(fromCache, { recursive: true });
    writeFileSync(join(fromCache, 'README.md'), 'old generation\n');
  }

  const scan = scanPhysicalTree(canonicalPayloadDir);
  if (scan.status !== 'ok' || !scan.digest) throw new Error(`canonical payload scan failed: ${scan.status}`);
  const canonicalDigest = scan.digest;

  const runnerCalls: string[] = [];
  const makeRunner = (): CommandRunner => (command, args) => {
    const key = args.join(' ');
    runnerCalls.push(`${command} ${key}`);
    if (key === 'plugin list --json') {
      const installedTarget = existsSync(targetCacheDir);
      const version = installedTarget ? target : options.from;
      if (version === null) return json({ installed: [] });
      return json({
        installed: [{ pluginId: 'genie@automagik', enabled: configEnabled(configPath), version }],
      });
    }
    if (key === 'plugin add genie@automagik --json') {
      // The supported add installs the target generation and enables the plugin.
      cpSync(canonicalPayloadDir, targetCacheDir, { recursive: true });
      setConfigEnabled(configPath, true);
      return { exitCode: 0, stdout: '{}', stderr: '' };
    }
    return { exitCode: 0, stdout: '{}', stderr: '' };
  };

  const observeOptions: CodexActivationStoreOptions = {
    genieHome,
    codexHome,
    canonicalRoot,
    allowRootOverride: true,
    command: STUB_COMMAND,
    runner: makeRunner(),
    deliveryEvidenceVerification: TEST_EVIDENCE_VERIFICATION,
  };

  return {
    root,
    genieHome,
    codexHome,
    configPath,
    canonicalRoot,
    canonicalPayloadDir,
    targetCacheDir,
    canonicalDigest,
    runnerCalls,
    makeRunner,
    openStore: () => openCodexActivationStore({ ...observeOptions, runner: makeRunner() }),
  };
}

/** Publish an installed-delivery (and optional downgrade receipt) exactly as Group C would. */
function publishDelivery(fixture: Fixture, opts: { downgradeFrom?: string } = {}): void {
  const lease = acquireLifecycleLease('update-delivery', { genieHome: fixture.genieHome });
  if (!lease.ok) throw new Error(`could not acquire delivery lease: ${lease.detail}`);
  try {
    fixture.openStore().publishDelivery(lease, {
      evidence: mintTestDeliveryEvidence({
        descriptor: {
          version: TARGET_VERSION,
          releaseTag: `v${TARGET_VERSION}`,
          releaseName: `genie-${TARGET_VERSION}-${
            process.platform === 'darwin'
              ? 'darwin-arm64'
              : process.arch === 'arm64'
                ? 'linux-arm64'
                : 'linux-x64-glibc'
          }.tar.gz`,
          canonicalPayloadSha256: fixture.canonicalDigest,
          installedBinarySha256: createHash('sha256')
            .update(readFileSync(join(fixture.canonicalRoot, 'genie')))
            .digest('hex'),
        },
      }).evidence,
      deliveryRoot: fixture.canonicalRoot,
      downgradeFrom: opts.downgradeFrom,
    });
  } finally {
    lease.release();
  }
}

/** Mint a genuine permit through A's real consent + authorization API (TTY seam, affirmative prompt). */
function mintPermit(store: CodexActivationStore): {
  permit: Extract<AuthorizationResult, { result: 'granted' }>['permit'];
} {
  const snapshot = store.observe();
  const state = classifyCodexActivation(snapshot);
  const consent = requestRetirementAssertion(snapshot, {
    stdinIsTTY: true,
    stdoutIsTTY: true,
    env: {},
    argv: [],
    prompt: () => true,
  });
  if (consent.result !== 'granted') throw new Error(`consent not granted: ${JSON.stringify(consent)}`);
  const auth = authorizeCodexActivation({
    state,
    snapshot,
    invocation: { entry: 'setup-codex', assertion: consent.assertion },
  });
  if (auth.result !== 'granted') throw new Error(`authorization not granted: ${JSON.stringify(auth)}`);
  return { permit: auth.permit };
}

function runActivation(fixture: Fixture, deps: CodexActivationExecutorDeps = {}): ActivationExecutionResult {
  const store = fixture.openStore();
  const { permit } = mintPermit(store);
  return executeCodexActivation({
    permit,
    store,
    command: STUB_COMMAND,
    codexHome: fixture.codexHome,
    genieHome: fixture.genieHome,
    configPath: fixture.configPath,
    deps: { runner: fixture.makeRunner(), ...deps },
  });
}

function intentPath(fixture: Fixture): string {
  return join(fixture.genieHome, '.codex-plugin-refresh-intent.json');
}
function receiptPath(fixture: Fixture): string {
  return join(fixture.genieHome, '.codex-plugin-downgrade-receipt.json');
}
function tombstonePath(fixture: Fixture): string {
  return join(fixture.genieHome, '.codex-plugin-receipt-tombstone.json');
}
function leasePath(fixture: Fixture): string {
  return join(fixture.genieHome, '.codex-lifecycle.lock');
}
function addCalls(fixture: Fixture): number {
  return fixture.runnerCalls.filter((call) => call.endsWith('plugin add genie@automagik --json')).length;
}
function marketplaceCalls(fixture: Fixture): number {
  return fixture.runnerCalls.filter((call) => call.includes('plugin marketplace add ')).length;
}
function readIntent(fixture: Fixture): RefreshIntent {
  return JSON.parse(readFileSync(intentPath(fixture), 'utf8')) as RefreshIntent;
}

// ---------------------------------------------------------------------------

let activeFixtures: Fixture[] = [];
let activeH3Roots: string[] = [];
let envSnapshot: EnvSnapshot | null = null;

function fixture(options: FixtureOptions): Fixture {
  const created = buildFixture(options);
  activeFixtures.push(created);
  return created;
}

beforeEach(() => {
  const shared = mkdtempSync(join(tmpdir(), 'genie-executor-env-'));
  envSnapshot = isolateEnv(shared);
});

afterEach(() => {
  envSnapshot?.restore();
  envSnapshot = null;
  for (const created of activeFixtures) rmSync(created.root, { recursive: true, force: true });
  activeFixtures = [];
});

describe('permit boundary', () => {
  test('a non-genuine permit cannot start activation and mutates nothing', () => {
    const fx = fixture({ from: FROM_VERSION, initialEnabled: true, createFromCache: true });
    publishDelivery(fx);
    const store = fx.openStore();
    // A structural lookalike is not registered in A's WeakSet and is rejected.
    const forged = {
      capability: 'activation',
      fingerprint: {},
      observedFrom: FROM_VERSION,
      observedTarget: TARGET_VERSION,
    };
    const result = executeCodexActivation({
      permit: forged as never,
      store,
      command: STUB_COMMAND,
      codexHome: fx.codexHome,
      genieHome: fx.genieHome,
      configPath: fx.configPath,
      deps: { runner: fx.makeRunner() },
    });
    expect(result.status === 'refused' || result.status === 'broken').toBe(true);
    expect(existsSync(intentPath(fx))).toBe(false);
    expect(marketplaceCalls(fx)).toBe(0);
    expect(addCalls(fx)).toBe(0);
    expect(existsSync(leasePath(fx))).toBe(false); // released
  });
});

describe('delivery-incomplete inner guard', () => {
  test('activation without a delivery record refuses as delivery-incomplete with zero mutation', () => {
    const fx = fixture({ from: FROM_VERSION, initialEnabled: true, createFromCache: true });
    // Intentionally do NOT publishDelivery: the inner guard must refuse before any mutation.
    const result = runActivation(fx);
    expect(result.status).toBe('delivery-incomplete');
    if (result.status !== 'delivery-incomplete') throw new Error('unreachable');
    expect(result.code).toBe('delivery-incomplete');
    expect(result.assessment).toBe('absent');
    expect(result.trailer.deliveryComplete).toBe(false);
    expect(result.recovery).toContain('genie update');
    // No activation-owned mutation: no journal, no plugin add, released lease.
    expect(existsSync(intentPath(fx))).toBe(false);
    expect(addCalls(fx)).toBe(0);
    expect(existsSync(leasePath(fx))).toBe(false);
  });

  test('a matching delivery record proceeds normally (control for the guard)', () => {
    const fx = fixture({ from: FROM_VERSION, initialEnabled: true, createFromCache: true });
    publishDelivery(fx);
    const result = runActivation(fx);
    expect(result.status).toBe('activated');
    expect(marketplaceCalls(fx)).toBe(1);
    expect(addCalls(fx)).toBe(1);
  });
});

describe('successful activation', () => {
  test('inner begin precedes callback-scoped marketplace registration, which precedes plugin add', () => {
    const fx = fixture({ from: null, initialEnabled: true });
    publishDelivery(fx);
    const order: string[] = [];
    const runner = fx.makeRunner();
    const result = runActivation(fx, {
      hooks: {
        afterBeginActivation: () => order.push('begin'),
        beforeMarketplaceRegistration: () => order.push('marketplace-before'),
        afterMarketplaceRegistration: () => order.push('marketplace-after'),
        beforeCommandStarted: () => order.push('command-started'),
        beforePluginAdd: () => order.push('plugin-add'),
      },
      runner: (command, args, options) => {
        if (args.slice(0, 3).join(' ') === 'plugin marketplace add') order.push('marketplace-command');
        return runner(command, args, options);
      },
    });

    expect(result.status).toBe('activated');
    expect(order).toEqual([
      'begin',
      'marketplace-before',
      'marketplace-command',
      'marketplace-after',
      'command-started',
      'plugin-add',
    ]);
  });

  test('marketplace registration failure leaves plugin/cache untouched and roles remain outside the executor', () => {
    const fx = fixture({ from: null, initialEnabled: true });
    publishDelivery(fx);
    const runner = fx.makeRunner();
    const result = runActivation(fx, {
      runner: (command, args, options) => {
        if (args.slice(0, 3).join(' ') === 'plugin marketplace add') {
          return { exitCode: 1, stdout: '', stderr: 'injected marketplace registration failure' };
        }
        return runner(command, args, options);
      },
    });

    expect(result.status).toBe('broken');
    expect(addCalls(fx)).toBe(0);
    expect(existsSync(fx.targetCacheDir)).toBe(false);
    expect(existsSync(join(fx.codexHome, 'agents'))).toBe(false);
    expect(classifyCodexActivation(fx.openStore().observe()).kind).toBe('intent-planned');
  });

  test('upgrade preserves enabled state, proves parity + H3, clears the journal, returns verified', () => {
    const fx = fixture({ from: FROM_VERSION, initialEnabled: true, createFromCache: true });
    publishDelivery(fx);
    const result = runActivation(fx);
    expect(result.status).toBe('activated');
    if (result.status !== 'activated') throw new Error('unreachable');
    expect(result.version).toBe(TARGET_VERSION);
    expect(result.enabled).toBe(true);
    expect(result.direction).toBe('upgrade');
    expect(result.hookReviewRequired).toBe(true);
    expect(addCalls(fx)).toBe(1);
    expect(existsSync(intentPath(fx))).toBe(false);
    expect(existsSync(leasePath(fx))).toBe(false);
    // The installed generation is now current per A's classifier.
    expect(classifyCodexActivation(fx.openStore().observe()).kind).toBe('current');
  });

  test('a previously disabled plugin is restored to disabled after the add enables it', () => {
    const fx = fixture({ from: FROM_VERSION, initialEnabled: false, createFromCache: true });
    publishDelivery(fx);
    const result = runActivation(fx);
    expect(result.status).toBe('activated');
    if (result.status !== 'activated') throw new Error('unreachable');
    expect(result.enabled).toBe(false);
    expect(configEnabled(fx.configPath)).toBe(false);
  });

  test('fresh install (registration absent) activates enabled through a single add', () => {
    const fx = fixture({ from: null, initialEnabled: true });
    publishDelivery(fx);
    const result = runActivation(fx);
    expect(result.status).toBe('activated');
    if (result.status !== 'activated') throw new Error('unreachable');
    expect(result.direction).toBe('install');
    expect(result.enabled).toBe(true);
    expect(configEnabled(fx.configPath)).toBe(true);
    expect(addCalls(fx)).toBe(1);
  });
});

describe('fingerprint freshness', () => {
  test('a permit goes stale when an observed field changes before beginActivation; zero mutation', () => {
    const fx = fixture({ from: FROM_VERSION, initialEnabled: true, createFromCache: true });
    publishDelivery(fx);
    const store = fx.openStore();
    const { permit } = mintPermit(store);
    // Mutate an observed fingerprint field (enabled) after consent, before execution.
    setConfigEnabled(fx.configPath, false);
    const result = executeCodexActivation({
      permit,
      store,
      command: STUB_COMMAND,
      codexHome: fx.codexHome,
      genieHome: fx.genieHome,
      configPath: fx.configPath,
      deps: { runner: fx.makeRunner() },
    });
    expect(result.status).toBe('stale');
    if (result.status !== 'stale') throw new Error('unreachable');
    expect(result.mismatchField).toBe('enabled');
    expect(existsSync(intentPath(fx))).toBe(false);
    expect(marketplaceCalls(fx)).toBe(0);
    expect(addCalls(fx)).toBe(0);
    expect(existsSync(leasePath(fx))).toBe(false);
  });

  test('journal-byte tampering after consent makes the permit stale with zero mutation', () => {
    const fx = fixture({ from: FROM_VERSION, initialEnabled: false, createFromCache: true });
    publishDelivery(fx);
    const first = runActivation(fx, {
      hooks: {
        beforeEnabledRestore() {
          throw new Error('injected crash before enabled restore');
        },
      },
    });
    expect(first.status).toBe('broken');
    expect(classifyCodexActivation(fx.openStore().observe()).kind).toBe('intent-target-current');

    const store = fx.openStore();
    const { permit } = mintPermit(store);
    const tampered = { ...readIntent(fx), priorEnabled: true };
    writeFileSync(intentPath(fx), `${JSON.stringify(tampered, null, 2)}\n`);
    const tamperedBytes = readFileSync(intentPath(fx), 'utf8');
    const addsBefore = addCalls(fx);
    const marketplacesBefore = marketplaceCalls(fx);

    const result = executeCodexActivation({
      permit,
      store,
      command: STUB_COMMAND,
      codexHome: fx.codexHome,
      genieHome: fx.genieHome,
      configPath: fx.configPath,
      deps: { runner: fx.makeRunner() },
    });
    expect(result.status).toBe('stale');
    if (result.status !== 'stale') throw new Error('unreachable');
    expect(result.mismatchField).toBe('intentContentSha256');
    expect(readFileSync(intentPath(fx), 'utf8')).toBe(tamperedBytes);
    expect(addCalls(fx)).toBe(addsBefore);
    expect(marketplaceCalls(fx)).toBe(marketplacesBefore);
    expect(existsSync(leasePath(fx))).toBe(false);
  });
});

describe('lifecycle lease', () => {
  test('a busy lease yields codex-lifecycle-busy with zero mutation and no held lease left behind', () => {
    const fx = fixture({ from: FROM_VERSION, initialEnabled: true, createFromCache: true });
    publishDelivery(fx);
    const holder = acquireLifecycleLease('update-delivery', { genieHome: fx.genieHome });
    if (!holder.ok) throw new Error('setup: could not pre-acquire lease');
    try {
      const result = runActivation(fx);
      expect(result.status).toBe('busy');
      if (result.status !== 'busy') throw new Error('unreachable');
      expect(result.code).toBe('codex-lifecycle-busy');
      expect(result.holderKind).toBe('update-delivery');
      expect(result.trailer.deliveryComplete).toBe(false);
      expect(existsSync(intentPath(fx))).toBe(false);
      expect(addCalls(fx)).toBe(0);
    } finally {
      holder.release();
    }
  });

  test('a superseded operation id is rejected mid-transaction (fenced) and reported broken', () => {
    const fx = fixture({ from: FROM_VERSION, initialEnabled: true, createFromCache: true });
    publishDelivery(fx);
    const hooks: ActivationPhaseHooks = {
      beforeCommandStarted() {
        // Simulate a supersession: replace the on-disk lease with a foreign record.
        writeFileSync(
          leasePath(fx),
          `${JSON.stringify({
            schemaVersion: 1,
            operationId: 'ffffffffffffffffffffffffffffffff',
            kind: 'setup-activation',
            pid: process.pid,
            startedAt: new Date().toISOString(),
          })}\n`,
        );
      },
    };
    const result = runActivation(fx, { hooks });
    expect(result.status).toBe('broken');
    if (result.status !== 'broken') throw new Error('unreachable');
    expect(result.code).toBe('codex-lifecycle-fenced');
  });
});

describe('crash recovery', () => {
  test('a failure after the add leaves a recoverable journal; a second run finalizes without add/remove', () => {
    const fx = fixture({ from: FROM_VERSION, initialEnabled: true, createFromCache: true });
    publishDelivery(fx);
    // First run: interrupt immediately before finalization. The add already ran,
    // so the target is current and the journal is left for recovery.
    const first = runActivation(fx, {
      hooks: {
        beforeFinalize() {
          throw new Error('injected crash before finalize');
        },
      },
    });
    expect(first.status).toBe('broken');
    expect(existsSync(intentPath(fx))).toBe(true);
    expect(addCalls(fx)).toBe(1);
    // The target is now physically current: the intent classifies as target-current.
    expect(classifyCodexActivation(fx.openStore().observe()).kind).toBe('intent-target-current');

    // Second authorized run: finalizes via target-current with NO further add.
    const second = runActivation(fx);
    expect(second.status).toBe('activated');
    expect(addCalls(fx)).toBe(1); // no second add
    expect(existsSync(intentPath(fx))).toBe(false);
    expect(classifyCodexActivation(fx.openStore().observe()).kind).toBe('current');
  });

  test('a failure before the add leaves command-started; a fresh authorized run resumes it to completion', () => {
    const fx = fixture({ from: FROM_VERSION, initialEnabled: true, createFromCache: true });
    publishDelivery(fx);
    const first = runActivation(fx, {
      hooks: {
        beforePluginAdd() {
          throw new Error('injected crash before the add');
        },
      },
    });
    expect(first.status).toBe('broken');
    expect(addCalls(fx)).toBe(0);
    expect(existsSync(intentPath(fx))).toBe(true);
    expect(classifyCodexActivation(fx.openStore().observe()).kind).toBe('intent-command-started');

    // Second authorized run: the DESIGN truth table grants command-started an
    // external-tty-setup transaction. beginActivation resumes the bound journal and
    // the executor idempotently reconciles through one supported add + verify.
    const second = runActivation(fx);
    expect(second.status).toBe('activated');
    if (second.status !== 'activated') throw new Error('unreachable');
    // Never claims N survived: the recovery names the old-generation break risk.
    expect(second.recovery).toContain('old generation');
    expect(addCalls(fx)).toBe(1);
    expect(existsSync(intentPath(fx))).toBe(false);
    expect(classifyCodexActivation(fx.openStore().observe()).kind).toBe('current');
  });

  const TARGET_CURRENT_RECOVERY_CASES = [
    {
      name: 'disabled upgrade',
      from: FROM_VERSION,
      initialEnabled: false,
      createFromCache: true,
      downgradeFrom: undefined,
      direction: 'upgrade',
      priorEnabled: false,
      finalEnabled: false,
    },
    {
      name: 'fresh install',
      from: null,
      initialEnabled: false,
      createFromCache: false,
      downgradeFrom: undefined,
      direction: 'install',
      priorEnabled: true,
      finalEnabled: true,
    },
    {
      name: 'explicit downgrade',
      from: NEWER_VERSION,
      initialEnabled: true,
      createFromCache: true,
      downgradeFrom: NEWER_VERSION,
      direction: 'downgrade',
      priorEnabled: true,
      finalEnabled: true,
    },
  ] as const;

  for (const recoveryCase of TARGET_CURRENT_RECOVERY_CASES) {
    test(`${recoveryCase.name} resumes the target-current journal without losing transaction identity`, () => {
      const fx = fixture({
        from: recoveryCase.from,
        initialEnabled: recoveryCase.initialEnabled,
        createFromCache: recoveryCase.createFromCache,
      });
      publishDelivery(
        fx,
        recoveryCase.downgradeFrom === undefined ? {} : { downgradeFrom: recoveryCase.downgradeFrom },
      );
      const first = runActivation(fx, {
        hooks: {
          beforeEnabledRestore() {
            throw new Error('injected crash before enabled restore');
          },
        },
      });
      expect(first.status).toBe('broken');
      expect(addCalls(fx)).toBe(1);
      expect(classifyCodexActivation(fx.openStore().observe()).kind).toBe('intent-target-current');
      const before = readIntent(fx);
      expect(before.phase).toBe('removal-observed');
      expect(before.direction).toBe(recoveryCase.direction);
      expect(before.priorEnabled).toBe(recoveryCase.priorEnabled);
      if (recoveryCase.direction === 'downgrade') expect(before.receiptId).not.toBeNull();
      else expect(before.receiptId).toBeNull();

      const rebound: RefreshIntent[] = [];
      const second = runActivation(fx, {
        hooks: {
          afterBeginActivation() {
            rebound.push(readIntent(fx));
          },
        },
      });
      expect(second.status).toBe('activated');
      if (second.status !== 'activated') throw new Error('unreachable');
      expect(second.direction).toBe(recoveryCase.direction);
      expect(second.enabled).toBe(recoveryCase.finalEnabled);
      expect(configEnabled(fx.configPath)).toBe(recoveryCase.finalEnabled);
      expect(addCalls(fx)).toBe(1);
      const reboundIntent = rebound[0];
      if (reboundIntent === undefined) throw new Error('target-current journal was not rebound');
      expect(reboundIntent.refreshIntentId).toBe(before.refreshIntentId);
      expect(reboundIntent.phase).toBe(before.phase);
      expect(reboundIntent.direction).toBe(before.direction);
      expect(reboundIntent.priorEnabled).toBe(before.priorEnabled);
      expect(reboundIntent.receiptId).toBe(before.receiptId);
      expect(reboundIntent.operationId).not.toBe(before.operationId);
      expect(existsSync(intentPath(fx))).toBe(false);

      if (recoveryCase.direction === 'downgrade') {
        if (before.receiptId === null) throw new Error('downgrade journal lost its receipt id');
        expect(existsSync(receiptPath(fx))).toBe(false);
        expect(existsSync(tombstonePath(fx))).toBe(true);
        const tombstone = JSON.parse(readFileSync(tombstonePath(fx), 'utf8')) as { receiptId: string };
        expect(tombstone.receiptId).toBe(before.receiptId);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Post-command phase resume (DESIGN truth table: command-started /
// removal-observed / ambiguous-absent are external-tty-setup transactions that
// RESUME the bound journal and reconcile idempotently through the supported add).
// ---------------------------------------------------------------------------

function activateWith(
  fx: Fixture,
  runner: CommandRunner,
  deps: CodexActivationExecutorDeps = {},
): ActivationExecutionResult {
  const store = openCodexActivationStore({
    genieHome: fx.genieHome,
    codexHome: fx.codexHome,
    canonicalRoot: fx.canonicalRoot,
    allowRootOverride: true,
    command: STUB_COMMAND,
    runner,
    deliveryEvidenceVerification: TEST_EVIDENCE_VERIFICATION,
  });
  const { permit } = mintPermit(store);
  return executeCodexActivation({
    permit,
    store,
    command: STUB_COMMAND,
    codexHome: fx.codexHome,
    genieHome: fx.genieHome,
    configPath: fx.configPath,
    deps: { runner, ...deps },
  });
}

function installedList(version: string | null): CommandResult {
  return version === null
    ? json({ installed: [] })
    : json({ installed: [{ pluginId: 'genie@automagik', enabled: true, version }] });
}

/** First-run runner whose add fails AFTER the old registration goes absent (→ removal-observed). */
function removalObservedRunner(fx: Fixture): CommandRunner {
  let removed = false;
  return (_command, args) => {
    const key = args.join(' ');
    if (key === 'plugin list --json') {
      if (existsSync(fx.targetCacheDir)) return installedList(TARGET_VERSION);
      return installedList(removed ? null : FROM_VERSION);
    }
    if (key === 'plugin add genie@automagik --json') {
      removed = true; // the old generation is gone, but T was never installed
      return { exitCode: 1, stdout: '', stderr: 'plugin add failed after removing the old generation' };
    }
    return { exitCode: 0, stdout: '{}', stderr: '' };
  };
}

/** First-run runner whose add fails and leaves the follow-up query unavailable (→ ambiguous-absent). */
function ambiguousAbsentRunner(fx: Fixture): CommandRunner {
  let added = false;
  return (_command, args) => {
    const key = args.join(' ');
    if (key === 'plugin list --json') {
      if (existsSync(fx.targetCacheDir)) return installedList(TARGET_VERSION);
      if (added) return { exitCode: 1, stdout: '', stderr: 'plugin list unavailable' };
      return installedList(FROM_VERSION);
    }
    if (key === 'plugin add genie@automagik --json') {
      added = true; // outcome unknowable: the follow-up query cannot attribute absence
      return { exitCode: 1, stdout: '', stderr: 'plugin add failed with an ambiguous outcome' };
    }
    return { exitCode: 0, stdout: '{}', stderr: '' };
  };
}

describe('post-command phase resume', () => {
  test('resumed fresh intent enables the plugin, while resumed existing-disabled intent preserves false', () => {
    for (const fixtureCase of [
      { name: 'fresh', from: null, initialEnabled: false, createFromCache: false, expectedEnabled: true },
      {
        name: 'existing-disabled',
        from: FROM_VERSION,
        initialEnabled: false,
        createFromCache: true,
        expectedEnabled: false,
      },
    ] as const) {
      const fx = fixture(fixtureCase);
      publishDelivery(fx);
      const first = runActivation(fx, {
        hooks: {
          beforePluginAdd() {
            throw new Error(`${fixtureCase.name}: injected pre-add crash`);
          },
        },
      });
      expect(first.status).toBe('broken');
      const journal = JSON.parse(readFileSync(intentPath(fx), 'utf8')) as Record<string, unknown>;
      if (fixtureCase.from === null) {
        // Compatibility case: older planners persisted false for a fresh
        // registration. Resume derives the desired state from from=null.
        journal.priorEnabled = false;
        writeFileSync(intentPath(fx), `${JSON.stringify(journal)}\n`);
      }

      const resumed = runActivation(fx);
      expect(resumed.status).toBe('activated');
      if (resumed.status !== 'activated') throw new Error(`${fixtureCase.name}: activation did not resume`);
      expect(resumed.enabled).toBe(fixtureCase.expectedEnabled);
      expect(configEnabled(fx.configPath)).toBe(fixtureCase.expectedEnabled);
    }
  });

  test('removal-observed resumes: a fresh authorized run reconciles through add + verify', () => {
    const fx = fixture({ from: FROM_VERSION, initialEnabled: true, createFromCache: true });
    publishDelivery(fx);
    // First run: the add fails after the old registration went absent, T never installed.
    const first = activateWith(fx, removalObservedRunner(fx));
    expect(first.status).toBe('broken');
    expect(existsSync(intentPath(fx))).toBe(true);
    expect(classifyCodexActivation(fx.openStore().observe()).kind).toBe('intent-removal-observed');

    // Second authorized run resumes the bound journal and completes via a supported add.
    const second = runActivation(fx);
    expect(second.status).toBe('activated');
    if (second.status !== 'activated') throw new Error('unreachable');
    expect(second.recovery).toContain('old generation'); // never claims N survived
    expect(addCalls(fx)).toBe(1);
    expect(existsSync(intentPath(fx))).toBe(false);
    expect(classifyCodexActivation(fx.openStore().observe()).kind).toBe('current');
  });

  test('ambiguous-absent resumes: a fresh authorized run reconciles idempotently', () => {
    const fx = fixture({ from: FROM_VERSION, initialEnabled: true, createFromCache: true });
    publishDelivery(fx);
    const first = activateWith(fx, ambiguousAbsentRunner(fx));
    expect(first.status).toBe('broken');
    expect(existsSync(intentPath(fx))).toBe(true);
    expect(classifyCodexActivation(fx.openStore().observe()).kind).toBe('intent-ambiguous-absent');

    const second = runActivation(fx);
    expect(second.status).toBe('activated');
    if (second.status !== 'activated') throw new Error('unreachable');
    expect(second.recovery).toContain('old generation');
    expect(addCalls(fx)).toBe(1);
    expect(existsSync(intentPath(fx))).toBe(false);
    expect(classifyCodexActivation(fx.openStore().observe()).kind).toBe('current');
  });

  test('a resumed post-command run interrupted again stays broken with the journal intact', () => {
    const fx = fixture({ from: FROM_VERSION, initialEnabled: true, createFromCache: true });
    publishDelivery(fx);
    runActivation(fx, {
      hooks: {
        beforePluginAdd() {
          throw new Error('injected crash 1');
        },
      },
    });
    expect(classifyCodexActivation(fx.openStore().observe()).kind).toBe('intent-command-started');
    // Second authorized run resumes but is interrupted again before the add.
    const second = runActivation(fx, {
      hooks: {
        beforePluginAdd() {
          throw new Error('injected crash 2');
        },
      },
    });
    expect(second.status).toBe('broken');
    expect(addCalls(fx)).toBe(0);
    expect(existsSync(intentPath(fx))).toBe(true);
    expect(classifyCodexActivation(fx.openStore().observe()).kind).toBe('intent-command-started');
    // A third authorized run finally resumes to completion (idempotent retry).
    const third = runActivation(fx);
    expect(third.status).toBe('activated');
    expect(addCalls(fx)).toBe(1);
    expect(existsSync(intentPath(fx))).toBe(false);
  });

  test('a stale permit on a post-command resume refuses with zero mutation', () => {
    const fx = fixture({ from: FROM_VERSION, initialEnabled: true, createFromCache: true });
    publishDelivery(fx);
    runActivation(fx, {
      hooks: {
        beforePluginAdd() {
          throw new Error('injected crash');
        },
      },
    });
    expect(classifyCodexActivation(fx.openStore().observe()).kind).toBe('intent-command-started');
    const journalBefore = readFileSync(intentPath(fx), 'utf8');

    const store = fx.openStore();
    const { permit } = mintPermit(store);
    // Drift an observed fingerprint field (enabled) after consent, before execution.
    setConfigEnabled(fx.configPath, false);
    const result = executeCodexActivation({
      permit,
      store,
      command: STUB_COMMAND,
      codexHome: fx.codexHome,
      genieHome: fx.genieHome,
      configPath: fx.configPath,
      deps: { runner: fx.makeRunner() },
    });
    expect(result.status).toBe('stale');
    if (result.status !== 'stale') throw new Error('unreachable');
    expect(result.mismatchField).toBe('enabled');
    expect(addCalls(fx)).toBe(0);
    expect(readFileSync(intentPath(fx), 'utf8')).toBe(journalBefore);
  });

  // Reviewer MEDIUM: failure injection at each post-add phase leaves a recoverable
  // target-current journal and an idempotent authorized rerun with no second add.
  const INJECTION_PHASES = [
    'afterPluginAdd',
    'beforeRemovalObserved',
    'beforeParity',
    'beforeH3',
    'beforeEnabledRestore',
  ] as const;
  for (const phase of INJECTION_PHASES) {
    test(`an injected failure at ${phase} recovers via target-current with no second add`, () => {
      const fx = fixture({ from: FROM_VERSION, initialEnabled: true, createFromCache: true });
      publishDelivery(fx);
      const hooks: ActivationPhaseHooks = {};
      hooks[phase] = () => {
        throw new Error(`injected crash at ${phase}`);
      };
      const first = runActivation(fx, { hooks });
      expect(first.status).toBe('broken');
      expect(addCalls(fx)).toBe(1);
      expect(existsSync(intentPath(fx))).toBe(true);
      // The add already reached T, so the interrupted journal classifies target-current.
      expect(classifyCodexActivation(fx.openStore().observe()).kind).toBe('intent-target-current');

      // Second authorized run finalizes via target-current with NO second add.
      const second = runActivation(fx);
      expect(second.status).toBe('activated');
      expect(addCalls(fx)).toBe(1);
      expect(existsSync(intentPath(fx))).toBe(false);
      expect(classifyCodexActivation(fx.openStore().observe()).kind).toBe('current');
    });
  }
});

describe('explicit downgrade', () => {
  test('activation consumes the receipt one-time through A: receipt removed, tombstone written', () => {
    const fx = fixture({ from: NEWER_VERSION, initialEnabled: true, createFromCache: true });
    // Delivery of older canonical bytes writes the matching downgrade receipt.
    publishDelivery(fx, { downgradeFrom: NEWER_VERSION });
    expect(existsSync(receiptPath(fx))).toBe(true);
    expect(classifyCodexActivation(fx.openStore().observe()).kind).toBe('pending-downgrade-explicit');

    const result = runActivation(fx);
    expect(result.status).toBe('activated');
    if (result.status !== 'activated') throw new Error('unreachable');
    expect(result.direction).toBe('downgrade');
    // One-time durable consumption: the receipt is gone and a tombstone remains.
    expect(existsSync(receiptPath(fx))).toBe(false);
    expect(existsSync(tombstonePath(fx))).toBe(true);
    const tombstone = JSON.parse(readFileSync(tombstonePath(fx), 'utf8'));
    expect(tombstone.receiptId).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('store is the sole mutation surface', () => {
  test('every activation-time transition goes through A; no protocol file is written outside the store', () => {
    const fx = fixture({ from: FROM_VERSION, initialEnabled: true, createFromCache: true });
    publishDelivery(fx);
    const inner = fx.openStore();
    const calls: string[] = [];
    const spy: CodexActivationStore = {
      observe: () => inner.observe(),
      publishDelivery: (lease, input) => {
        calls.push('publishDelivery');
        return inner.publishDelivery(lease, input);
      },
      withRevalidatedDeliveryRoot: (lease, cb) => {
        calls.push('withRevalidatedDeliveryRoot');
        return inner.withRevalidatedDeliveryRoot(lease, cb);
      },
      beginActivation: (lease, permit) => {
        calls.push('beginActivation');
        return inner.beginActivation(lease, permit);
      },
      advanceIntentPhase: (lease, handle, phase, failure) => {
        calls.push(`advanceIntentPhase:${phase}`);
        return inner.advanceIntentPhase(lease, handle, phase, failure);
      },
      finalizeActivation: (lease, handle) => {
        calls.push('finalizeActivation');
        return inner.finalizeActivation(lease, handle);
      },
      quarantineIntent: (lease, permit) => inner.quarantineIntent(lease, permit),
    };
    const { permit } = mintPermit(inner);
    const result = executeCodexActivation({
      permit,
      store: spy,
      command: STUB_COMMAND,
      codexHome: fx.codexHome,
      genieHome: fx.genieHome,
      configPath: fx.configPath,
      deps: { runner: fx.makeRunner() },
    });
    expect(result.status).toBe('activated');
    expect(calls).toContain('beginActivation');
    expect(calls).toContain('advanceIntentPhase:command-started');
    expect(calls).toContain('advanceIntentPhase:removal-observed');
    expect(calls).toContain('withRevalidatedDeliveryRoot');
    expect(calls).toContain('finalizeActivation');
    // The executor never publishes delivery (that is Group C's authority).
    expect(calls).not.toContain('publishDelivery');
  });
});

describe('H3 SessionStart smoke', () => {
  function makeTRoot(script: string): string {
    const root = mkdtempSync(join(tmpdir(), 'genie-h3-troot-'));
    activeH3Roots.push(root);
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'session-context.cjs'), script, { encoding: 'utf8', mode: 0o755 });
    return root;
  }

  test('the real H3 script produces the exact expected wish-state context', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-h3-real-'));
    activeH3Roots.push(root);
    mkdirSync(join(root, 'scripts'), { recursive: true });
    cpSync(REAL_SESSION_CONTEXT, join(root, 'scripts', 'session-context.cjs'));
    const result = runBoundedH3Smoke(root);
    expect(result.ok).toBe(true);
  });

  test('the sterile environment ignores poisoned inherited variables', () => {
    process.env.GENIE_BUNDLE_ROOT = '/hostile/root';
    process.env.CI = 'true';
    process.env.CODEX_THREAD_ID = 'task-123';
    process.env.GENIE_WORKER = '1';
    const root = mkdtempSync(join(tmpdir(), 'genie-h3-poison-'));
    activeH3Roots.push(root);
    mkdirSync(join(root, 'scripts'), { recursive: true });
    cpSync(REAL_SESSION_CONTEXT, join(root, 'scripts', 'session-context.cjs'));
    const result = runBoundedH3Smoke(root);
    // GENIE_WORKER=1 would short-circuit the hook to "{}"; a sterile env prevents it.
    expect(result.ok).toBe(true);
  });

  test('a timeout is a deterministic failure', () => {
    const root = makeTRoot('setTimeout(() => {}, 60000);\n');
    expect(() => runBoundedH3Smoke(root)).toThrow(/timeout|H3 SessionStart smoke failed/);
  }, 15_000);

  test('an output-cap breach is a deterministic failure', () => {
    const root = makeTRoot('process.stdout.write("x".repeat(200000));\n');
    expect(() => runBoundedH3Smoke(root)).toThrow(/cap|H3 SessionStart smoke failed/);
  });

  test('a schema mismatch is a deterministic failure', () => {
    const root = makeTRoot(
      'process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "Other" } }));\n',
    );
    expect(() => runBoundedH3Smoke(root)).toThrow(/H3 SessionStart smoke failed/);
  });

  test('any stderr output is a deterministic failure', () => {
    const root = makeTRoot('process.stderr.write("noise");process.stdout.write("{}");\n');
    expect(() => runBoundedH3Smoke(root)).toThrow(/stderr|H3 SessionStart smoke failed/);
  });

  test('a missing Node executable is refused before spawn', () => {
    const root = makeTRoot('process.stdout.write("{}");\n');
    expect(() => runBoundedH3Smoke(root, { resolveNode: () => null })).toThrow(/no Node executable/);
  });

  test('a non-absolute Node path is refused', () => {
    const root = makeTRoot('process.stdout.write("{}");\n');
    expect(() => runBoundedH3Smoke(root, { resolveNode: () => 'node' })).toThrow(/absolute path/);
  });
});

afterEach(() => {
  for (const root of activeH3Roots) rmSync(root, { recursive: true, force: true });
  activeH3Roots = [];
});

// ---------------------------------------------------------------------------
// Two-process executor race (real OS processes, one shared fixture-root store)
// ---------------------------------------------------------------------------

describe('two-process executor race', () => {
  test('exactly one activation transaction wins; the loser makes zero mutation', async () => {
    const fx = fixture({ from: FROM_VERSION, initialEnabled: true, createFromCache: true });
    publishDelivery(fx);

    const childScript = join(fx.root, 'race-child.ts');
    writeFileSync(childScript, raceChildSource(), 'utf8');

    const startAt = Date.now() + 700;
    const env = {
      ...process.env,
      RACE_GENIE_HOME: fx.genieHome,
      RACE_CODEX_HOME: fx.codexHome,
      RACE_CONFIG_PATH: fx.configPath,
      RACE_CANONICAL_ROOT: fx.canonicalRoot,
      RACE_CANONICAL_PAYLOAD: fx.canonicalPayloadDir,
      RACE_TARGET_CACHE: fx.targetCacheDir,
      RACE_TARGET_VERSION: TARGET_VERSION,
      RACE_FROM_VERSION: FROM_VERSION,
      RACE_START_AT: String(startAt),
      RACE_EXECUTOR: join(import.meta.dir, 'codex-activation-executor.ts'),
      RACE_ACTIVATION: join(import.meta.dir, 'codex-activation.ts'),
    } as Record<string, string>;

    const spawnChild = () => Bun.spawn(['bun', childScript], { env, stdout: 'pipe', stderr: 'pipe' });
    const a = spawnChild();
    const b = spawnChild();
    const [outA, outB] = await Promise.all([readAll(a.stdout), readAll(b.stdout)]);
    await Promise.all([a.exited, b.exited]);

    const results = [parseChild(outA), parseChild(outB)];
    const activated = results.filter((r) => r.status === 'activated');
    const busy = results.filter((r) => r.status === 'busy');
    expect(activated.length).toBe(1);
    expect(busy.length).toBe(1);
    expect(busy[0]?.code).toBe('codex-lifecycle-busy');
    // The loser observed the lease held and never reached the journal.
    expect(busy[0]?.addCalls).toBe(0);
    // After both finish, the winner released the lease.
    expect(existsSync(leasePath(fx))).toBe(false);
    expect(existsSync(intentPath(fx))).toBe(false);
  }, 30_000);
});

async function readAll(stream: ReadableStream<Uint8Array> | undefined): Promise<string> {
  if (!stream) return '';
  return await new Response(stream).text();
}

function parseChild(output: string): { status: string; code?: string; addCalls?: number } {
  const line = output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .pop();
  if (!line) throw new Error(`child produced no result line: ${output}`);
  return JSON.parse(line);
}

function raceChildSource(): string {
  return String.raw`
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const { openCodexActivationStore, classifyCodexActivation, requestRetirementAssertion, authorizeCodexActivation } = await import(process.env.RACE_ACTIVATION);
const { executeCodexActivation } = await import(process.env.RACE_EXECUTOR);

const configPath = process.env.RACE_CONFIG_PATH;
const canonicalPayload = process.env.RACE_CANONICAL_PAYLOAD;
const targetCache = process.env.RACE_TARGET_CACHE;
const target = process.env.RACE_TARGET_VERSION;
const from = process.env.RACE_FROM_VERSION;
let addCalls = 0;

const runner = (command, args) => {
  const key = args.join(' ');
  if (key === 'plugin list --json') {
    const version = existsSync(targetCache) ? target : from;
    const enabled = !/enabled\s*=\s*false/.test(readFileSync(configPath, 'utf8'));
    return { exitCode: 0, stdout: JSON.stringify({ installed: [{ pluginId: 'genie@automagik', enabled, version }] }), stderr: '' };
  }
  if (key === 'plugin add genie@automagik --json') {
    addCalls += 1;
    cpSync(canonicalPayload, targetCache, { recursive: true });
    writeFileSync(configPath, '[plugins."genie@automagik"]\nenabled = true\n');
    return { exitCode: 0, stdout: '{}', stderr: '' };
  }
  return { exitCode: 0, stdout: '{}', stderr: '' };
};

const store = openCodexActivationStore({
  genieHome: process.env.RACE_GENIE_HOME,
  codexHome: process.env.RACE_CODEX_HOME,
  canonicalRoot: process.env.RACE_CANONICAL_ROOT,
  allowRootOverride: true,
  command: '/stub/codex',
  runner,
  deliveryEvidenceVerification: { verifyBundle: () => ({ integratedTime: '1753228800' }) },
});

const snapshot = store.observe();
const state = classifyCodexActivation(snapshot);
const consent = requestRetirementAssertion(snapshot, { stdinIsTTY: true, stdoutIsTTY: true, env: {}, argv: [], prompt: () => true });
if (consent.result !== 'granted') { process.stdout.write(JSON.stringify({ status: 'consent-failed' })); process.exit(0); }
const auth = authorizeCodexActivation({ state, snapshot, invocation: { entry: 'setup-codex', assertion: consent.assertion } });
if (auth.result !== 'granted') { process.stdout.write(JSON.stringify({ status: 'auth-failed' })); process.exit(0); }

// Barrier: both children begin contending within the same window.
const startAt = Number(process.env.RACE_START_AT);
while (Date.now() < startAt) { Bun.sleepSync(2); }

const result = executeCodexActivation({
  permit: auth.permit,
  store,
  command: '/stub/codex',
  codexHome: process.env.RACE_CODEX_HOME,
  genieHome: process.env.RACE_GENIE_HOME,
  configPath,
  deps: {
    runner,
    // The winner holds the lease long enough that the loser observes it busy.
    hooks: { afterLeaseAcquired: () => Bun.sleepSync(400) },
  },
});
process.stdout.write(JSON.stringify({ status: result.status, code: result.code, addCalls }) + '\n');
`;
}
