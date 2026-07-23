import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLifecycleLease, lifecycleLockPath } from '../lib/agent-sync.js';
import type { ActivationExecutionResult } from '../lib/codex-activation-executor.js';
import type {
  CanonicalFact,
  CodexActivationSnapshot,
  FamilyWitness,
  PhysicalCacheFact,
  QueryFact,
} from '../lib/codex-activation.js';
import { parseReleaseVersion } from '../lib/codex-activation.js';
import {
  DELIVERY_EVIDENCE_DIGEST_ALGORITHM,
  DELIVERY_EVIDENCE_REPOSITORY,
  type VerifiedDeliveryEvidenceFacts,
  deriveDeliveryId,
} from '../lib/codex-delivery-evidence.js';
import { loadGenieConfig, saveGenieConfig } from '../lib/genie-config.js';
import {
  createSetupCodexConsentCommitConsumer,
  persistIntegrationConsent,
  readIntegrationConsent,
  runDeliveryRootConsumer,
} from '../lib/runtime-integrations.js';
import { type SetupDeps, mergeCodexIntegrationConsent, resolveDefaultAgentAfterCodex, setupCommand } from './setup.js';

// resolveDefaultAgentAfterCodex is the single decision point `genie setup
// --codex` runs through before saving runtime.defaultAgent (setup.ts wires it
// directly into the successful-activation branch), so these tests pin the whole
// contract: codex activation must never steal an explicit agent choice.

describe('resolveDefaultAgentAfterCodex', () => {
  test("'auto' (never-chosen default) flips to codex with no hint", () => {
    expect(resolveDefaultAgentAfterCodex('auto')).toEqual({ agent: 'codex' });
  });

  test("an explicit 'claude' is preserved and the user gets a switch hint instead", () => {
    const decision = resolveDefaultAgentAfterCodex('claude');
    expect(decision.agent).toBe('claude');
    expect(decision.hint).toContain("stays 'claude'");
    expect(decision.hint).toContain('"defaultAgent": "codex"');
    expect(decision.hint).toContain('config.json');
  });

  test("an already-'codex' setting is idempotent with no hint", () => {
    expect(resolveDefaultAgentAfterCodex('codex')).toEqual({ agent: 'codex' });
  });
});

describe('mergeCodexIntegrationConsent', () => {
  test('adds Codex without dropping an existing explicit Claude scope', () => {
    expect(mergeCodexIntegrationConsent('none')).toBe('codex');
    expect(mergeCodexIntegrationConsent('claude')).toBe('all');
    expect(mergeCodexIntegrationConsent('codex')).toBe('codex');
    expect(mergeCodexIntegrationConsent('all')).toBe('all');
    expect(mergeCodexIntegrationConsent('auto')).toBe('codex');
  });
});

// ============================================================================
// Codex activation — A's consent + B's permit-gated executor (Group D, D1/D2)
// ============================================================================

const T = '5.260712.1';
const OLD = '5.260711.9';
const NEWER = '5.260713.4';
const DIGEST = 'a'.repeat(64);
const BINARY_DIGEST = 'b'.repeat(64);
const MANIFEST_DIGEST = 'c'.repeat(64);
const ARTIFACT_DIGEST = 'd'.repeat(64);
const PLATFORM = 'darwin-arm64';
const DELIVERY_ROOT = '/fixture/genie/deliveries/current';
const EVIDENCE_DIGEST = 'e'.repeat(64);
const MARKETPLACE_CONSUMER = Object.freeze({ kind: 'marketplace' }) as never;
const ROLE_CONSUMER = Object.freeze({ kind: 'roles' }) as never;
const ROLE_RESULT = {
  installed: 7,
  skippedUserOwned: [],
  keptModified: [],
  removed: [],
  backedUp: [],
};

function setupDeliveryOps(consume?: (consumer: unknown) => unknown) {
  return {
    inventoryDigest: () => DIGEST,
    deliveredVersion: () => T,
    consume: (consumer: unknown) =>
      consume !== undefined
        ? consume(consumer)
        : consumer === ROLE_CONSUMER
          ? ROLE_RESULT
          : consumer === MARKETPLACE_CONSUMER
            ? undefined
            : runDeliveryRootConsumer(consumer as never, DELIVERY_ROOT),
  };
}

function ver(s: string) {
  const parsed = parseReleaseVersion(s);
  if (!parsed) throw new Error(`bad version ${s}`);
  return parsed;
}
function family(): FamilyWitness {
  return { status: 'present', digest: 'f'.repeat(64), identity: '10:300' };
}
function okCanonical(): CanonicalFact {
  return {
    status: 'ok',
    version: ver(T),
    digest: DIGEST,
    identity: '10:100',
    platformTriple: PLATFORM,
    installedBinarySha256: BINARY_DIGEST,
    deliveryRoot: DELIVERY_ROOT,
  };
}
function reg(version: string): QueryFact {
  return { status: 'ok', registration: { present: true, enabled: true, version: ver(version) } };
}
function cache(digest = DIGEST): PhysicalCacheFact {
  return { kind: 'present', digest, identity: '10:200' };
}
/** A matching authenticated delivery record binding the canonical target (Group E delivery gate). */
function deliveryPresent(): CodexActivationSnapshot['delivery'] {
  return {
    status: 'present',
    record: {
      schemaVersion: 2,
      deliveryId: deriveDeliveryId(EVIDENCE_DIGEST, DELIVERY_ROOT),
      targetVersion: T,
      canonicalPayloadSha256: DIGEST,
      channel: 'stable',
      deliveredAt: '2026-07-12T00:00:00.000Z',
      evidenceDigest: EVIDENCE_DIGEST,
      platformId: 'darwin-arm64',
      platformTriple: PLATFORM,
      releaseTag: `v${T}`,
      releaseName: `genie-${T}-${PLATFORM}.tar.gz`,
      releaseManifestSha256: MANIFEST_DIGEST,
      artifactSha256: ARTIFACT_DIGEST,
      installedBinarySha256: BINARY_DIGEST,
      deliveryRoot: DELIVERY_ROOT,
    },
    evidence: deliveryEvidenceFacts(),
  };
}

function deliveryEvidenceFacts(): VerifiedDeliveryEvidenceFacts {
  return {
    evidenceDigest: EVIDENCE_DIGEST,
    deliveredAt: '2026-07-12T00:00:00.000Z',
    descriptor: {
      schemaVersion: 1 as const,
      repository: DELIVERY_EVIDENCE_REPOSITORY,
      version: T,
      channel: 'stable' as const,
      platformId: 'darwin-arm64' as const,
      platformTriple: PLATFORM,
      releaseTag: `v${T}`,
      releaseName: `genie-${T}-${PLATFORM}.tar.gz`,
      releaseManifestSha256: MANIFEST_DIGEST,
      artifactSha256: ARTIFACT_DIGEST,
      installedBinarySha256: BINARY_DIGEST,
      canonicalPayloadSha256: DIGEST,
      sourceSha: '1'.repeat(40),
      sourceBranch: 'main',
      sourceCiRunId: '123',
      controlSha: '2'.repeat(40),
      digestAlgorithm: DELIVERY_EVIDENCE_DIGEST_ALGORITHM,
    },
  };
}
function snapshot(over: Partial<CodexActivationSnapshot> = {}): CodexActivationSnapshot {
  return {
    canonical: okCanonical(),
    query: reg(T),
    cache: cache(),
    receipt: { status: 'absent' },
    delivery: deliveryPresent(),
    intent: { status: 'absent' },
    receiptConsumed: false,
    observationWitness: { before: family(), after: family() },
    observedAt: '2026-07-12T00:00:00.000Z',
    ...over,
  };
}
/** Registered N<T, present-unverified cache → activation-pending (authority external-tty-setup). */
function pendingSnapshot(): CodexActivationSnapshot {
  return snapshot({ query: reg(OLD), cache: cache('b'.repeat(64)) });
}
/** Registered==canonical and digest matches → current. */
function currentSnapshot(): CodexActivationSnapshot {
  return snapshot();
}
/** Registered N>T without a downgrade receipt → installed-newer (authority none, exit 1). */
function installedNewerSnapshot(): CodexActivationSnapshot {
  return snapshot({ query: reg(NEWER) });
}
/** Canonical payload unreadable → deliveryComplete false (nothing delivered to activate). */
function noPayloadSnapshot(): CodexActivationSnapshot {
  return snapshot({ canonical: { status: 'error', detail: 'canonical plugin payload root not found' } });
}

const ACTIVATED: ActivationExecutionResult = {
  status: 'activated',
  version: T,
  enabled: true,
  direction: 'upgrade',
  hookReviewRequired: true,
  recovery: 'retire tasks → genie setup --codex → /hooks → new task',
};

function capture(): {
  restore: () => { out: string; err: string; trailer: string; exitCode: number };
} {
  const priorExit = process.exitCode;
  process.exitCode = 0;
  const realOut = process.stdout.write.bind(process.stdout);
  const realLog = console.log;
  const realErr = console.error;
  let out = '';
  let err = '';
  let trailer = '';
  console.log = (...a: unknown[]) => {
    out += `${a.join(' ')}\n`;
  };
  console.error = (...a: unknown[]) => {
    err += `${a.join(' ')}\n`;
  };
  process.stdout.write = ((c: string) => {
    if (c.includes('"schemaVersion"')) trailer += c;
    out += c;
    return true;
  }) as typeof process.stdout.write;
  return {
    restore: () => {
      const exitCode = Number(process.exitCode ?? 0);
      process.stdout.write = realOut;
      console.log = realLog;
      console.error = realErr;
      process.exitCode = priorExit ?? 0;
      return { out, err, trailer, exitCode };
    },
  };
}

describe('setup Codex activation (Group D)', () => {
  let root: string;
  let priorGenieHome: string | undefined;
  let priorCodexHome: string | undefined;
  let priorCi: string | undefined;
  let priorThread: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'genie-setup-'));
    priorGenieHome = process.env.GENIE_HOME;
    priorCodexHome = process.env.CODEX_HOME;
    priorCi = process.env.CI;
    priorThread = process.env.CODEX_THREAD_ID;
    process.env.GENIE_HOME = join(root, 'genie-home');
    process.env.CODEX_HOME = join(root, 'codex-home');
    Reflect.deleteProperty(process.env, 'CI');
    Reflect.deleteProperty(process.env, 'CODEX_THREAD_ID');
    mkdirSync(join(root, 'repo'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: join(root, 'repo') });
    process.exitCode = 0;
  });

  afterEach(() => {
    for (const [key, value] of [
      ['GENIE_HOME', priorGenieHome],
      ['CODEX_HOME', priorCodexHome],
      ['CI', priorCi],
      ['CODEX_THREAD_ID', priorThread],
    ] as const) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    process.exitCode = 0;
    rmSync(root, { recursive: true, force: true });
  });

  /** Base seams reaching the consent gate on a pending activation (real consent guards). */
  function baseDeps(over: Partial<SetupDeps> = {}): SetupDeps {
    return {
      cwd: join(root, 'repo'),
      resolveExecutable: () => '/fixture/bin/codex',
      checkCommand: async () => ({ exists: true, version: 'fixture' }),
      observeCodexActivation: () => pendingSnapshot(),
      stdinIsTTY: true,
      stdoutIsTTY: true,
      promptRetirementConfirmation: () => true,
      // Don't touch the real agent-sync lease or the deep store in unit tests.
      acquireLifecycleLease: () => ({ path: join(root, 'genie-home', '.lock'), release: () => {} }),
      acquireActivationLease: (() => ({
        ok: true,
        kind: 'setup-activation',
        operationId: 'op-setup-test',
        assertOperation: () => {},
        release: () => {},
      })) as never,
      openCodexActivationStore: (() => ({
        observe: () => currentSnapshot(),
        withRevalidatedDeliveryRoot: (
          _lease: unknown,
          callback: (ops: ReturnType<typeof setupDeliveryOps>) => unknown,
        ) => callback(setupDeliveryOps()),
      })) as never,
      createCodexMarketplaceConsumer: () => MARKETPLACE_CONSUMER,
      createCodexRoleAgentConsumer: () => ROLE_CONSUMER,
      ...over,
    };
  }

  /** Stub the granted consent→authorize chain so the executor result is the variable under test. */
  function grantedDeps(result: ActivationExecutionResult, over: Partial<SetupDeps> = {}): SetupDeps {
    return baseDeps({
      requestRetirementAssertion: () => ({ result: 'granted', assertion: {} as never }),
      authorizeCodexActivation: () => ({ result: 'granted', permit: {} as never }),
      executeCodexActivation: () => result,
      ...over,
    });
  }

  test('a granted assertion activates through the executor: exit 0, configured, consent merged', async () => {
    const genieHome = process.env.GENIE_HOME as string;
    persistIntegrationConsent('claude', genieHome);
    const cap = capture();
    await setupCommand({ codex: true }, grantedDeps(ACTIVATED));
    const { out, exitCode } = cap.restore();
    expect(exitCode).not.toBe(1);
    expect(exitCode).not.toBe(2);
    expect(out).toContain('Activated Codex plugin');
    expect(out).toContain('/hooks');
    expect((await loadGenieConfig()).codex?.configured).toBe(true);
    // Durable maintenance consent merged claude → all.
    expect(readIntegrationConsent(genieHome)).toBe('all');
  });

  test('fresh activation revalidates current before committing consent and converging roles', async () => {
    const events: string[] = [];
    const genieHome = process.env.GENIE_HOME as string;
    const cap = capture();
    await setupCommand(
      { codex: true },
      grantedDeps(ACTIVATED, {
        executeCodexActivation: () => {
          events.push('executor');
          return ACTIVATED;
        },
        openCodexActivationStore: (() => ({
          observe: () => {
            events.push('reobserve-current');
            return currentSnapshot();
          },
          withRevalidatedDeliveryRoot: (
            _lease: unknown,
            callback: (ops: ReturnType<typeof setupDeliveryOps>) => unknown,
          ) => {
            events.push('delivery-callback-enter');
            const result = callback(
              setupDeliveryOps((consumer) => {
                if (consumer === ROLE_CONSUMER) {
                  events.push(`roles:${readIntegrationConsent(genieHome)}`);
                  return ROLE_RESULT;
                }
                return runDeliveryRootConsumer(consumer as never, DELIVERY_ROOT);
              }),
            );
            events.push('delivery-callback-exit');
            return result;
          },
        })) as never,
        createCodexConsentCommitConsumer: (options) =>
          createSetupCodexConsentCommitConsumer({
            ...options,
            persist: (selection, home) => {
              events.push(`consent:${selection}`);
              persistIntegrationConsent(selection, home);
            },
          }),
      }),
    );
    const { exitCode } = cap.restore();

    expect(exitCode).toBe(0);
    expect(events).toEqual([
      'executor',
      'delivery-callback-enter',
      'reobserve-current',
      'consent:codex',
      'roles:codex',
      'delivery-callback-exit',
    ]);
  });

  test('post-activation delivery advance refuses consent, roles, route, and config success', async () => {
    let consentCalls = 0;
    let roleCalls = 0;
    const cap = capture();
    await setupCommand(
      { codex: true },
      grantedDeps(ACTIVATED, {
        openCodexActivationStore: (() => ({
          observe: () => pendingSnapshot(),
          withRevalidatedDeliveryRoot: (
            _lease: unknown,
            callback: (ops: ReturnType<typeof setupDeliveryOps>) => unknown,
          ) => callback(setupDeliveryOps()),
        })) as never,
        createCodexConsentCommitConsumer: (options) =>
          createSetupCodexConsentCommitConsumer({
            ...options,
            persist: () => {
              consentCalls += 1;
            },
          }),
        createCodexRoleAgentConsumer: () => {
          roleCalls += 1;
          return ROLE_CONSUMER;
        },
      }),
    );
    const { out, exitCode } = cap.restore();

    expect(exitCode).toBe(1);
    expect(consentCalls).toBe(0);
    expect(roleCalls).toBe(0);
    expect(out).not.toContain('Project MCP route');
    expect(out).not.toContain('Codex configuration saved');
  });

  test("a granted activation flips a never-chosen 'auto' default agent to codex", async () => {
    await setupCommand({ codex: true }, grantedDeps(ACTIVATED));
    expect((await loadGenieConfig()).runtime.defaultAgent).toBe('codex');
  });

  test('a granted activation preserves an explicit Claude agent choice', async () => {
    const config = await loadGenieConfig();
    config.runtime.defaultAgent = 'claude';
    await saveGenieConfig(config);
    await setupCommand({ codex: true }, grantedDeps(ACTIVATED));
    expect((await loadGenieConfig()).runtime.defaultAgent).toBe('claude');
  });

  test('quick mode is an unconditional activation refusal: exit 2, executor never runs', async () => {
    let executeCalls = 0;
    const cap = capture();
    // Real requestRetirementAssertion runs; quick appends --quick to argv → refused.
    await setupCommand(
      { codex: true, quick: true },
      baseDeps({
        executeCodexActivation: () => {
          executeCalls += 1;
          return ACTIVATED;
        },
      }),
    );
    const { err, trailer, exitCode } = cap.restore();
    expect(exitCode).toBe(2);
    expect(executeCalls).toBe(0);
    expect(err).toContain('Retirement assertion refused');
    expect(JSON.parse(trailer.trim()).schemaVersion).toBe(1);
    expect((await loadGenieConfig()).codex?.configured).not.toBe(true);
  });

  test('a non-TTY stdin refuses activation with zero executor calls (exit 2)', async () => {
    let executeCalls = 0;
    const cap = capture();
    await setupCommand(
      { codex: true },
      baseDeps({
        stdinIsTTY: false,
        executeCodexActivation: () => {
          executeCalls += 1;
          return ACTIVATED;
        },
      }),
    );
    const { exitCode } = cap.restore();
    expect(exitCode).toBe(2);
    expect(executeCalls).toBe(0);
  });

  test('CI in the environment refuses activation (exit 2)', async () => {
    process.env.CI = '1';
    const cap = capture();
    await setupCommand({ codex: true }, baseDeps());
    const { exitCode } = cap.restore();
    expect(exitCode).toBe(2);
  });

  test('a declined retirement prompt refuses activation with zero executor calls (exit 2)', async () => {
    let executeCalls = 0;
    const cap = capture();
    await setupCommand(
      { codex: true },
      baseDeps({
        promptRetirementConfirmation: () => false,
        executeCodexActivation: () => {
          executeCalls += 1;
          return ACTIVATED;
        },
      }),
    );
    const { err, exitCode } = cap.restore();
    expect(exitCode).toBe(2);
    expect(executeCalls).toBe(0);
    expect(err).toContain('refused');
  });

  test('a busy lifecycle lease surfaces the executor busy trailer: exit 2, deliveryComplete false', async () => {
    const cap = capture();
    await setupCommand(
      { codex: true },
      grantedDeps({
        status: 'busy',
        code: 'codex-lifecycle-busy',
        holderKind: 'update-delivery',
        detail: 'held by update-delivery',
        trailer: {
          schemaVersion: 1,
          code: 'codex-lifecycle-busy',
          deliveryComplete: false,
          retry: true,
          nextAction: 'retry',
        },
      }),
    );
    const { trailer, exitCode } = cap.restore();
    expect(exitCode).toBe(2);
    const parsed = JSON.parse(trailer.trim());
    expect(parsed.code).toBe('codex-lifecycle-busy');
    expect(parsed.deliveryComplete).toBe(false);
  });

  test('a broken executor result exits 1 and names the delivery fix', async () => {
    const cap = capture();
    await setupCommand(
      { codex: true },
      grantedDeps({
        status: 'broken',
        code: 'cache-missing',
        detail: 'plugin add failed',
        trailer: { schemaVersion: 1, code: 'cache-missing', deliveryComplete: true, retry: true, nextAction: 'x' },
      }),
    );
    const { err, exitCode } = cap.restore();
    expect(exitCode).toBe(1);
    expect(err).toContain('genie update');
  });

  test('condition 1: no delivered payload is actionable, not a dead end (exit 1, executor never runs)', async () => {
    let executeCalls = 0;
    let assertionRequested = 0;
    const cap = capture();
    await setupCommand(
      { codex: true },
      baseDeps({
        observeCodexActivation: () => noPayloadSnapshot(),
        requestRetirementAssertion: () => {
          assertionRequested += 1;
          return { result: 'granted', assertion: {} as never };
        },
        executeCodexActivation: () => {
          executeCalls += 1;
          return ACTIVATED;
        },
      }),
    );
    const { err, exitCode } = cap.restore();
    expect(exitCode).toBe(1);
    expect(executeCalls).toBe(0);
    expect(assertionRequested).toBe(0); // refused before any consent prompt
    expect(err).toContain('genie update');
  });

  test('an already-current plugin needs no consent and exits 0', async () => {
    let assertionRequested = 0;
    const cap = capture();
    await setupCommand(
      { codex: true },
      baseDeps({
        observeCodexActivation: () => currentSnapshot(),
        requestRetirementAssertion: () => {
          assertionRequested += 1;
          return { result: 'refused', reason: 'x' };
        },
      }),
    );
    const { out, exitCode } = cap.restore();
    expect(exitCode).not.toBe(1);
    expect(exitCode).not.toBe(2);
    expect(assertionRequested).toBe(0);
    expect(out).toContain('already current');
    expect((await loadGenieConfig()).codex?.configured).toBe(true);
  });

  test('already-current setup revalidates before marketplace, then commits consent before roles', async () => {
    const events: string[] = [];
    const genieHome = process.env.GENIE_HOME as string;
    const cap = capture();
    await setupCommand(
      { codex: true },
      baseDeps({
        observeCodexActivation: () => currentSnapshot(),
        openCodexActivationStore: (() => ({
          observe: () => {
            events.push('reobserve-current');
            return currentSnapshot();
          },
          withRevalidatedDeliveryRoot: (
            _lease: unknown,
            callback: (ops: ReturnType<typeof setupDeliveryOps>) => unknown,
          ) => {
            events.push('delivery-callback-enter');
            const result = callback(
              setupDeliveryOps((consumer) => {
                if (consumer === MARKETPLACE_CONSUMER) {
                  events.push('marketplace');
                  return undefined;
                }
                if (consumer === ROLE_CONSUMER) {
                  events.push(`roles:${readIntegrationConsent(genieHome)}`);
                  return ROLE_RESULT;
                }
                return runDeliveryRootConsumer(consumer as never, DELIVERY_ROOT);
              }),
            );
            events.push('delivery-callback-exit');
            return result;
          },
        })) as never,
        createCodexConsentCommitConsumer: (options) =>
          createSetupCodexConsentCommitConsumer({
            ...options,
            persist: (selection, home) => {
              events.push(`consent:${selection}`);
              persistIntegrationConsent(selection, home);
            },
          }),
      }),
    );
    const { exitCode } = cap.restore();

    expect(exitCode).toBe(0);
    expect(events).toEqual([
      'delivery-callback-enter',
      'reobserve-current',
      'marketplace',
      'consent:codex',
      'roles:codex',
      'delivery-callback-exit',
    ]);
  });

  test('an installed-newer plugin has no activation authority: exit 1, no consent prompt', async () => {
    let assertionRequested = 0;
    const cap = capture();
    await setupCommand(
      { codex: true },
      baseDeps({
        observeCodexActivation: () => installedNewerSnapshot(),
        requestRetirementAssertion: () => {
          assertionRequested += 1;
          return { result: 'refused', reason: 'x' };
        },
      }),
    );
    const { exitCode } = cap.restore();
    expect(exitCode).toBe(1);
    expect(assertionRequested).toBe(0);
  });

  test('full quick setup refuses codex activation (exit 2) but preserves completed unrelated sections', async () => {
    const cap = capture();
    await setupCommand({ quick: true }, baseDeps());
    const { exitCode } = cap.restore();
    // Codex activation refused under quick → exit 2, but the wizard saved the rest.
    expect(exitCode).toBe(2);
    const saved = await loadGenieConfig();
    expect(saved.setupComplete).toBe(true);
    // Codex was not activated, so a never-chosen default is NOT flipped to codex.
    expect(saved.runtime.defaultAgent).not.toBe('codex');
    expect(saved.codex?.configured).not.toBe(true);
  });

  test('setup reaches the brand only through A/B: no fabricated assertion/permit in source', () => {
    const source = readFileSync(join(import.meta.dir, 'setup.ts'), 'utf8');
    // Setup consumes A's consent + B's executor…
    expect(source.includes('requestRetirementAssertion')).toBe(true);
    expect(source.includes('executeCodexActivation')).toBe(true);
    expect(source.includes('authorizeCodexActivation')).toBe(true);
    // …and never fabricates a brand or reimplements the legacy cache-advancing convergence.
    for (const forbidden of [
      'mintRetirementAssertion',
      'mintActivationPermit',
      'new RetirementAssertion',
      'installRuntimeIntegrations',
      'convergeCodexPlugin',
    ]) {
      expect(source.includes(forbidden)).toBe(false);
    }
  });

  test('source-checkout setup performs zero writes while another process owns the GENIE_HOME lease', () => {
    const genieHome = process.env.GENIE_HOME as string;
    const lease = acquireLifecycleLease(genieHome);
    expect('skipped' in lease).toBe(false);
    if ('skipped' in lease) throw new Error(lease.skipped);
    const lockPath = lifecycleLockPath(genieHome);
    const ownerRecord = readFileSync(lockPath, 'utf8');
    const runnerPath = join(root, 'setup-contender.ts');
    writeFileSync(
      runnerPath,
      [
        `import { setupCommand } from ${JSON.stringify(join(import.meta.dir, 'setup.ts'))};`,
        'await setupCommand({ reset: true });',
      ].join('\n'),
    );
    try {
      const child = Bun.spawnSync(['bun', runnerPath], {
        env: { ...process.env, GENIE_HOME: genieHome },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(child.exitCode).toBe(1);
      expect(child.stderr.toString()).toContain('holds the lock');
      expect(existsSync(genieHome)).toBe(false);
      expect(readFileSync(lockPath, 'utf8')).toBe(ownerRecord);
    } finally {
      lease.release();
    }
    expect(existsSync(lockPath)).toBe(false);
  });
  // ==========================================================================
  // Group E, Decision 9/12: the setup-side delivery gate + typed outcome
  // ==========================================================================

  // ==========================================================================
  // Group E live-QA regression: a journal-quarantine permit must be consumed by
  // A's quarantineIntent (then re-observe), never fed to the activation executor.
  // ==========================================================================

  /** A corrupt activation journal → state intent-invalid → authority journal-quarantine-only. */
  function corruptIntentSnapshot(): CodexActivationSnapshot {
    return {
      ...pendingSnapshot(),
      intent: { status: 'corrupt', contentSha256: 'd'.repeat(64), detail: 'not json' },
    };
  }
  const FAKE_LEASE = {
    ok: true,
    kind: 'setup-activation',
    operationId: 'op-quarantine-test',
    assertOperation: () => {},
    release: () => {},
  };

  test('Group E: a stale journal is quarantined via the REAL consent/authorize chain, then activation proceeds', async () => {
    let observeCalls = 0;
    let quarantineCalls = 0;
    const cap = capture();
    await setupCommand(
      { codex: true },
      baseDeps({
        observeCodexActivation: () => {
          observeCalls += 1;
          return observeCalls === 1 ? corruptIntentSnapshot() : pendingSnapshot();
        },
        // REAL requestRetirementAssertion + REAL authorizeCodexActivation run:
        // pass 1 mints a journal-quarantine permit, pass 2 an activation permit.
        acquireActivationLease: (() => FAKE_LEASE) as never,
        openCodexActivationStore: (() => ({
          observe: () => currentSnapshot(),
          withRevalidatedDeliveryRoot: (
            _lease: unknown,
            callback: (ops: ReturnType<typeof setupDeliveryOps>) => unknown,
          ) => callback(setupDeliveryOps()),
          quarantineIntent: () => {
            quarantineCalls += 1;
            return { quarantinedTo: '/quarantine/intent.invalid-d' };
          },
        })) as never,
        executeCodexActivation: () => ACTIVATED,
      }),
    );
    const { out, exitCode } = cap.restore();
    expect(exitCode).toBe(0);
    expect(quarantineCalls).toBe(1);
    expect(observeCalls).toBe(2);
    expect(out).toContain('Quarantined stale activation journal');
    expect(out).toContain('Activated Codex plugin');
    expect((await loadGenieConfig()).codex?.configured).toBe(true);
  });

  test('Group E: a skipped quarantine reports and exits 1 without touching the executor', async () => {
    let executeCalls = 0;
    const cap = capture();
    await setupCommand(
      { codex: true },
      baseDeps({
        observeCodexActivation: () => corruptIntentSnapshot(),
        acquireActivationLease: (() => FAKE_LEASE) as never,
        openCodexActivationStore: (() => ({
          quarantineIntent: () => ({ skipped: 'unsafe intent path is not quarantined (symlink)' }),
        })) as never,
        executeCodexActivation: () => {
          executeCalls += 1;
          return ACTIVATED;
        },
      }),
    );
    const { err, exitCode } = cap.restore();
    expect(exitCode).toBe(1);
    expect(executeCalls).toBe(0);
    expect(err).toContain('not quarantined');
  });

  test('Group E: a second quarantine grant in one invocation refuses instead of looping', async () => {
    let quarantineCalls = 0;
    const cap = capture();
    await setupCommand(
      { codex: true },
      baseDeps({
        // The journal never clears: every pass re-observes the corrupt intent.
        observeCodexActivation: () => corruptIntentSnapshot(),
        acquireActivationLease: (() => FAKE_LEASE) as never,
        openCodexActivationStore: (() => ({
          quarantineIntent: () => {
            quarantineCalls += 1;
            return { quarantinedTo: '/quarantine/intent.invalid-d' };
          },
        })) as never,
      }),
    );
    const { err, exitCode } = cap.restore();
    expect(exitCode).toBe(1);
    expect(quarantineCalls).toBe(1);
    expect(err).toContain('refusing to loop');
  });

  test('Group E: an ABSENT delivery record refuses before any consent prompt with the recovery command (exit 1)', async () => {
    let assertionRequested = 0;
    let executeCalls = 0;
    let marketplaceCalls = 0;
    let roleCalls = 0;
    const cap = capture();
    await setupCommand(
      { codex: true },
      baseDeps({
        observeCodexActivation: () => ({ ...pendingSnapshot(), delivery: { status: 'absent' } }),
        requestRetirementAssertion: () => {
          assertionRequested += 1;
          return { result: 'granted', assertion: {} as never };
        },
        executeCodexActivation: () => {
          executeCalls += 1;
          return ACTIVATED;
        },
        createCodexMarketplaceConsumer: () => {
          marketplaceCalls += 1;
          return MARKETPLACE_CONSUMER;
        },
        createCodexRoleAgentConsumer: () => {
          roleCalls += 1;
          return ROLE_CONSUMER;
        },
      }),
    );
    const { err, trailer, exitCode } = cap.restore();
    expect(exitCode).toBe(1);
    expect(assertionRequested).toBe(0);
    expect(executeCalls).toBe(0);
    expect(marketplaceCalls).toBe(0);
    expect(roleCalls).toBe(0);
    expect(err).toContain('delivery record is absent');
    expect(err).toContain('genie update');
    const parsed = JSON.parse(trailer) as { code: string; deliveryComplete: boolean; retry: boolean };
    expect(parsed).toMatchObject({ code: 'delivery-incomplete', deliveryComplete: false, retry: true });
  });

  test('INVALID and MISMATCHED records produce the same consistent delivery-incomplete refusal', async () => {
    const mismatchedRecord: CodexActivationSnapshot['delivery'] = {
      status: 'present',
      record: {
        schemaVersion: 2,
        deliveryId: deriveDeliveryId(EVIDENCE_DIGEST, DELIVERY_ROOT),
        targetVersion: OLD,
        canonicalPayloadSha256: DIGEST,
        channel: 'stable',
        deliveredAt: '2026-07-12T00:00:00.000Z',
        evidenceDigest: EVIDENCE_DIGEST,
        platformId: 'darwin-arm64',
        platformTriple: PLATFORM,
        releaseTag: `v${OLD}`,
        releaseName: `genie-${OLD}-${PLATFORM}.tar.gz`,
        releaseManifestSha256: MANIFEST_DIGEST,
        artifactSha256: ARTIFACT_DIGEST,
        installedBinarySha256: BINARY_DIGEST,
        deliveryRoot: DELIVERY_ROOT,
      },
      evidence: deliveryEvidenceFacts(),
    };
    const cases: Array<{ delivery: CodexActivationSnapshot['delivery']; assessment: string }> = [
      { delivery: { status: 'invalid', detail: 'corrupt json' }, assessment: 'invalid' },
      { delivery: mismatchedRecord, assessment: 'mismatch' },
    ];
    for (const { delivery, assessment } of cases) {
      const cap = capture();
      await setupCommand(
        { codex: true },
        baseDeps({ observeCodexActivation: () => ({ ...pendingSnapshot(), delivery }) }),
      );
      const { err, exitCode } = cap.restore();
      expect(exitCode).toBe(1);
      expect(err).toContain(`delivery record is ${assessment}`);
    }
  });

  test('even an already-current machine without a record is delivery-incomplete, never a success claim', async () => {
    const cap = capture();
    await setupCommand(
      { codex: true },
      baseDeps({ observeCodexActivation: () => ({ ...currentSnapshot(), delivery: { status: 'absent' } }) }),
    );
    const { out, err, exitCode } = cap.restore();
    expect(exitCode).toBe(1);
    expect(out).not.toContain('already current');
    expect(out).not.toContain('Codex configuration saved');
    expect(err).toContain('delivery record is absent');
    expect((await loadGenieConfig()).codex?.configured).not.toBe(true);
  });

  test('historically configured machine: a failed run preserves config bytes and prints NO green banner (Decision 12)', async () => {
    // Run 1: current + matching record → success, banner, configured persisted.
    const capFirst = capture();
    await setupCommand({ codex: true }, baseDeps({ observeCodexActivation: () => currentSnapshot() }));
    const first = capFirst.restore();
    expect(first.out).toContain('Codex configuration saved');
    expect((await loadGenieConfig()).codex?.configured).toBe(true);

    // Run 2: same machine, record now missing → failed run, historical
    // configured stays persisted (bytes preserved) but no success banner.
    const capSecond = capture();
    await setupCommand(
      { codex: true },
      baseDeps({ observeCodexActivation: () => ({ ...currentSnapshot(), delivery: { status: 'absent' } }) }),
    );
    const second = capSecond.restore();
    expect(second.exitCode).toBe(1);
    expect(second.out).not.toContain('Codex configuration saved');
    expect((await loadGenieConfig()).codex?.configured).toBe(true);
  });

  test('failed standalone setup preserves compact user config byte-for-byte, including unknown keys', async () => {
    const configPath = join(process.env.GENIE_HOME as string, 'config.json');
    mkdirSync(process.env.GENIE_HOME as string, { recursive: true });
    const compact =
      '{"version":2,"runtime":{"defaultAgent":"claude"},"codex":{"configured":true},"userOwned":{"keep":"exactly"}}\n';
    writeFileSync(configPath, compact);
    const before = readFileSync(configPath);

    const cap = capture();
    await setupCommand(
      { codex: true },
      baseDeps({ observeCodexActivation: () => ({ ...currentSnapshot(), delivery: { status: 'absent' } }) }),
    );
    const { out, exitCode } = cap.restore();

    expect(exitCode).toBe(1);
    expect(out).not.toContain('Codex configuration saved');
    expect(readFileSync(configPath).equals(before)).toBe(true);
  });

  test('pending standalone setup preserves compact user config byte-for-byte and prints no success banner', async () => {
    const configPath = join(process.env.GENIE_HOME as string, 'config.json');
    mkdirSync(process.env.GENIE_HOME as string, { recursive: true });
    const compact =
      '{ "version": 2, "runtime": { "defaultAgent": "claude" }, "codex": { "configured": true }, "userOwned": 7 }\n';
    writeFileSync(configPath, compact);
    const before = readFileSync(configPath);

    const cap = capture();
    await setupCommand(
      { codex: true },
      baseDeps({
        requestRetirementAssertion: () => ({ result: 'refused', reason: 'fixture pending' }),
      }),
    );
    const { out, exitCode } = cap.restore();

    expect(exitCode).toBe(2);
    expect(out).not.toContain('Codex configuration saved');
    expect(readFileSync(configPath).equals(before)).toBe(true);
  });

  test("full wizard summary reflects THIS run's typed outcome, not historical state", async () => {
    const cap = capture();
    await setupCommand({ quick: true }, baseDeps());
    const { out, exitCode } = cap.restore();
    expect(exitCode).toBe(2);
    expect(out).toContain('not configured this run (consent-refused)');
    expect(out).not.toContain('Codex:   \x1b[32mconfigured');
  });
});
