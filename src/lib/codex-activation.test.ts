import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as mod from './codex-activation.js';
import {
  type ActivationInvocation,
  type CanonicalFact,
  type CodexActivationSnapshot,
  type ConsentContext,
  type FamilyWitness,
  type IntentFact,
  type PhysicalCacheFact,
  type QueryFact,
  type ReceiptFact,
  type RefreshIntent,
  authorizeCodexActivation,
  buildActivationResultTrailer,
  classifyCodexActivation,
  compareReleaseVersions,
  computeActivationFingerprint,
  deriveDirection,
  describeState,
  observeCodexActivation,
  openCodexActivationStore,
  parseReleaseVersion,
  projectHumanStatus,
  projectIntegrationSummary,
  requestRetirementAssertion,
  resolveSetupExitCode,
  scanPhysicalTree,
  serializeActivationResultTrailer,
  stripControl,
} from './codex-activation.js';
import { acquireLifecycleLease } from './codex-lifecycle-lease.js';
import type { CommandResult, CommandRunner } from './runtime-integrations.js';

function canonicalDigest(genieHome: string): string {
  const tree = scanPhysicalTree(join(genieHome, 'plugins', 'genie'));
  if (tree.status !== 'ok' || !tree.digest) throw new Error('fixture canonical payload is not a safe tree');
  return tree.digest;
}

// ============================================================================
// Fixtures
// ============================================================================

const roots: string[] = [];
const savedEnv = new Map<string, string | undefined>();

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setEnv(key: string, value: string | undefined): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'genie-activation-'));
  roots.push(root);
  return root;
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

const PAYLOAD_FILES: Record<string, string> = {
  'codex-agents/agent.md': '# agent\n',
  'scripts/session-context.cjs': 'process.stdout.write("{}");\n',
  'plugin.json': '{"name":"genie"}\n',
};

interface Fixture {
  genieHome: string;
  codexHome: string;
}

/**
 * Build an isolated GENIE_HOME + CODEX_HOME with a canonical payload at
 * `targetVersion` and an installed cache generation at `registeredVersion`.
 * When `sameBytes` the cache mirrors the canonical payload (matching digest).
 */
function makeFixture(opts: {
  targetVersion: string;
  registeredVersion?: string | null;
  sameBytes?: boolean;
  cacheFiles?: Record<string, string>;
}): Fixture {
  const root = freshRoot();
  const genieHome = join(root, 'genie-home');
  const codexHome = join(root, 'codex-home');
  mkdirSync(genieHome, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  writeFiles(join(genieHome, 'plugins', 'genie'), PAYLOAD_FILES);
  writeFileSync(join(genieHome, 'VERSION'), `${opts.targetVersion}\n`);
  if (opts.registeredVersion) {
    const cacheDir = join(codexHome, 'plugins', 'cache', 'automagik', 'genie', opts.registeredVersion);
    const files =
      opts.cacheFiles ?? (opts.sameBytes ? PAYLOAD_FILES : { 'plugin.json': '{"name":"genie","gen":"old"}\n' });
    writeFiles(cacheDir, files);
  }
  // Fixture-isolation contract: point global roots at the fixture and neutralise
  // activation-refusing env so nothing escapes and consent env is deterministic.
  setEnv('HOME', root);
  setEnv('GENIE_HOME', genieHome);
  setEnv('CODEX_HOME', codexHome);
  setEnv('TMPDIR', root);
  setEnv('GENIE_BUNDLE_ROOT', undefined);
  setEnv('CODEX_THREAD_ID', undefined);
  setEnv('CI', undefined);
  return { genieHome, codexHome };
}

function listRunner(result: Partial<CommandResult> & { stdout: string }): CommandRunner {
  return () => ({ exitCode: 0, stderr: '', ...result });
}

function pluginListJson(entries: Array<{ version: string; enabled?: boolean }>): string {
  return JSON.stringify({
    installed: entries.map((e) => ({ pluginId: 'genie@automagik', version: e.version, enabled: e.enabled ?? true })),
  });
}

// ============================================================================
// Pure snapshot builder for the truth-table tests
// ============================================================================

const T = '5.260712.1';
const OLD = '5.260711.9';
const NEWER = '5.260713.4';
const DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'c'.repeat(64);

function ver(s: string) {
  const parsed = parseReleaseVersion(s);
  if (!parsed) throw new Error(`bad test version ${s}`);
  return parsed;
}

function okCanonical(version = T, digest = DIGEST): CanonicalFact {
  return { status: 'ok', version: ver(version), digest, identity: '10:100' };
}
function regPresent(version = T, enabled = true): QueryFact {
  return { status: 'ok', registration: { present: true, enabled, version: ver(version) } };
}
function regAbsent(): QueryFact {
  return { status: 'ok', registration: { present: false } };
}
function cachePresent(digest = DIGEST): PhysicalCacheFact {
  return { kind: 'present', digest, identity: '10:200' };
}
function familyPresent(): FamilyWitness {
  return { status: 'present', digest: 'f'.repeat(64), identity: '10:300' };
}

/** A well-formed `current` snapshot; individual tests override whole facts. */
function currentSnapshot(): CodexActivationSnapshot {
  return {
    canonical: okCanonical(),
    query: regPresent(),
    cache: cachePresent(),
    receipt: { status: 'absent' },
    delivery: { status: 'absent' },
    intent: { status: 'absent' },
    receiptConsumed: false,
    observationWitness: { before: familyPresent(), after: familyPresent() },
    observedAt: '2026-07-12T00:00:00.000Z',
  };
}

function refreshIntent(overrides: Partial<RefreshIntent>): RefreshIntent {
  return {
    schemaVersion: 1,
    refreshIntentId: '1'.repeat(32),
    operationId: '2'.repeat(32),
    fromPluginVersion: OLD,
    targetVersion: T,
    direction: 'upgrade',
    priorEnabled: true,
    canonicalPayloadSha256: DIGEST,
    phase: 'planned',
    commandKind: 'codex-plugin-add',
    lastFailure: '',
    receiptId: null,
    ...overrides,
  };
}

function intent(overrides: Partial<RefreshIntent>): IntentFact {
  return { status: 'valid', intent: refreshIntent(overrides), contentSha256: 'd'.repeat(64) };
}

function goodReceipt(from: string, target: string, receiptId = '9'.repeat(32)): ReceiptFact {
  return {
    status: 'present',
    receipt: {
      schemaVersion: 1,
      receiptId,
      fromPluginVersion: from,
      targetVersion: target,
      canonicalPayloadSha256: DIGEST,
      channel: 'stable',
    },
  };
}

// ============================================================================
// Version grammar + direction
// ============================================================================

describe('release version grammar', () => {
  test('accepts MAJOR.YYMMDD.N and strips build metadata after matching', () => {
    expect(parseReleaseVersion('5.260712.1')?.canonical).toBe('5.260712.1');
    expect(parseReleaseVersion('5.260712.1+build.7')?.canonical).toBe('5.260712.1');
  });

  test('rejects malformed or non-string versions', () => {
    for (const bad of ['5.26712.1', '5.260712', 'v5.260712.1', '', 'latest', '5.260712.1.2']) {
      expect(parseReleaseVersion(bad)).toBeNull();
    }
    expect(parseReleaseVersion(null)).toBeNull();
    expect(parseReleaseVersion(42 as unknown)).toBeNull();
  });

  test('direction is the total comparison of a nullable from against target', () => {
    expect(deriveDirection(null, ver(T))).toBe('install');
    expect(deriveDirection(ver(OLD), ver(T))).toBe('upgrade');
    expect(deriveDirection(ver(NEWER), ver(T))).toBe('downgrade');
    expect(deriveDirection(ver(T), ver(T))).toBe('repair');
    expect(compareReleaseVersions(ver(OLD), ver(T))).toBe(-1);
  });
});

// ============================================================================
// Pure classifier — the complete truth table
// ============================================================================

describe('classifyCodexActivation — truth table', () => {
  test('current: registered T, matching physical T, no intent', () => {
    expect(classifyCodexActivation(currentSnapshot()).kind).toBe('current');
  });

  test('activation-pending: registered N < T with present-unverified cache', () => {
    const s = { ...currentSnapshot(), query: regPresent(OLD), cache: cachePresent('b'.repeat(64)) };
    const state = classifyCodexActivation(s);
    expect(state.kind).toBe('activation-pending');
    if (state.kind === 'activation-pending') {
      expect(state.from).toBe(ver(OLD).canonical);
      expect(state.target).toBe(T);
    }
  });

  test('pending-downgrade-explicit: registered newer with a matching receipt', () => {
    const s = {
      ...currentSnapshot(),
      query: regPresent(NEWER),
      cache: cachePresent('b'.repeat(64)),
      receipt: goodReceipt(NEWER, T),
    };
    expect(classifyCodexActivation(s).kind).toBe('pending-downgrade-explicit');
  });

  test('installed-newer: registered newer WITHOUT a matching receipt fails closed', () => {
    const s = { ...currentSnapshot(), query: regPresent(NEWER), cache: cachePresent('b'.repeat(64)) };
    expect(classifyCodexActivation(s).kind).toBe('installed-newer');
  });

  test('installed-newer: a consumed downgrade receipt no longer authorizes pending', () => {
    const s = {
      ...currentSnapshot(),
      query: regPresent(NEWER),
      cache: cachePresent('b'.repeat(64)),
      receipt: goodReceipt(NEWER, T),
      receiptConsumed: true,
    };
    expect(classifyCodexActivation(s).kind).toBe('installed-newer');
  });

  test('registration-absent: query succeeds, no registration, no intent', () => {
    const s = { ...currentSnapshot(), query: regAbsent(), cache: { kind: 'not-applicable' } as PhysicalCacheFact };
    expect(classifyCodexActivation(s).kind).toBe('registration-absent');
  });

  test('query-failed: subprocess failure or unparseable output', () => {
    const s = { ...currentSnapshot(), query: { status: 'failed', detail: 'exit 1' } as QueryFact };
    expect(classifyCodexActivation(s).kind).toBe('query-failed');
  });

  test('registration-version-invalid: present entry with a version that fails the grammar', () => {
    const s = {
      ...currentSnapshot(),
      query: {
        status: 'ok',
        registration: { present: true, enabled: true, version: null, rawVersion: 'nightly' },
      } as QueryFact,
    };
    expect(classifyCodexActivation(s).kind).toBe('registration-version-invalid');
  });

  test('cache faults: symlink, unsafe, and missing each classify distinctly', () => {
    expect(classifyCodexActivation({ ...currentSnapshot(), cache: { kind: 'unsafe-symlink', detail: 'x' } }).kind).toBe(
      'unsafe-cache-symlink',
    );
    expect(classifyCodexActivation({ ...currentSnapshot(), cache: { kind: 'unsafe', detail: 'x' } }).kind).toBe(
      'unsafe-cache',
    );
    expect(classifyCodexActivation({ ...currentSnapshot(), cache: { kind: 'absent' } }).kind).toBe('cache-missing');
  });

  test('payload-mismatch: registered T but installed bytes differ from canonical', () => {
    const s = { ...currentSnapshot(), cache: cachePresent(OTHER_DIGEST) };
    expect(classifyCodexActivation(s).kind).toBe('payload-mismatch');
  });

  test('snapshot-inconsistent: canonical payload unreadable', () => {
    const s = { ...currentSnapshot(), canonical: { status: 'error', detail: 'unreadable' } as CanonicalFact };
    expect(classifyCodexActivation(s).kind).toBe('snapshot-inconsistent');
  });

  test('intent-invalid: oversized and corrupt intents are quarantine-only', () => {
    expect(classifyCodexActivation({ ...currentSnapshot(), intent: { status: 'oversized', size: 99999 } }).kind).toBe(
      'intent-invalid',
    );
    expect(
      classifyCodexActivation({
        ...currentSnapshot(),
        intent: { status: 'corrupt', contentSha256: 'e'.repeat(64), detail: 'bad' },
      }).kind,
    ).toBe('intent-invalid');
  });

  test('unsafe intent path fails closed rather than becoming quarantine-eligible', () => {
    const s = { ...currentSnapshot(), intent: { status: 'unsafe', detail: 'symlink' } as IntentFact };
    expect(classifyCodexActivation(s).kind).toBe('snapshot-inconsistent');
  });

  test('intent-mismatch: structurally valid intent whose digest binding is stale', () => {
    const s = {
      ...currentSnapshot(),
      query: regPresent(OLD),
      cache: cachePresent('b'.repeat(64)),
      intent: intent({ canonicalPayloadSha256: OTHER_DIGEST }),
    };
    expect(classifyCodexActivation(s).kind).toBe('intent-mismatch');
  });

  test('intent-target-current dominates every phase row and current once T is safely current', () => {
    // A command-started intent, but registration is already T with matching parity.
    const s = {
      ...currentSnapshot(),
      intent: intent({ phase: 'command-started', fromPluginVersion: OLD, direction: 'upgrade' }),
    };
    expect(classifyCodexActivation(s).kind).toBe('intent-target-current');
  });

  test('all four refresh-intent phases classify when the target is not yet current', () => {
    const pendingBase = { ...currentSnapshot(), query: regPresent(OLD), cache: cachePresent('b'.repeat(64)) };
    expect(
      classifyCodexActivation({ ...pendingBase, intent: intent({ phase: 'planned', fromPluginVersion: OLD }) }).kind,
    ).toBe('intent-planned');
    expect(
      classifyCodexActivation({ ...pendingBase, intent: intent({ phase: 'command-started', fromPluginVersion: OLD }) })
        .kind,
    ).toBe('intent-command-started');
    const removed = {
      ...currentSnapshot(),
      query: regAbsent(),
      cache: { kind: 'not-applicable' } as PhysicalCacheFact,
    };
    expect(
      classifyCodexActivation({ ...removed, intent: intent({ phase: 'removal-observed', fromPluginVersion: OLD }) })
        .kind,
    ).toBe('intent-removal-observed');
    expect(
      classifyCodexActivation({ ...removed, intent: intent({ phase: 'ambiguous-absent', fromPluginVersion: OLD }) })
        .kind,
    ).toBe('intent-ambiguous-absent');
  });

  test('the classifier is total: every fact combination returns exactly one kind', () => {
    const snapshots = [
      currentSnapshot(),
      { ...currentSnapshot(), query: regAbsent(), cache: { kind: 'not-applicable' } as PhysicalCacheFact },
      { ...currentSnapshot(), cache: { kind: 'absent' } as PhysicalCacheFact },
    ];
    for (const s of snapshots) {
      const state = classifyCodexActivation(s);
      expect(typeof state.kind).toBe('string');
    }
  });
});

describe('describeState — exit codes and mutation authority', () => {
  test('exit codes follow the truth table', () => {
    expect(describeState({ kind: 'current' }).exit).toBe(0);
    expect(describeState({ kind: 'activation-pending', from: OLD, target: T }).exit).toBe(2);
    expect(describeState({ kind: 'registration-absent' }).exit).toBe(2);
    expect(describeState({ kind: 'pending-downgrade-explicit', from: NEWER, target: T, receiptId: 'x' }).exit).toBe(2);
    expect(describeState({ kind: 'intent-planned', intent: refreshIntent({}) }).exit).toBe(2);
    expect(describeState({ kind: 'intent-target-current', intent: refreshIntent({}) }).exit).toBe(2);
    expect(describeState({ kind: 'query-failed', detail: 'x' }).exit).toBe(1);
    expect(describeState({ kind: 'installed-newer', from: NEWER, target: T }).exit).toBe(1);
    expect(describeState({ kind: 'cache-missing' }).exit).toBe(1);
  });

  test('mutation authority is none / journal-quarantine-only / external-tty-setup per state', () => {
    expect(describeState({ kind: 'current' }).authority).toBe('none');
    expect(describeState({ kind: 'installed-newer', from: NEWER, target: T }).authority).toBe('none');
    expect(
      describeState({ kind: 'intent-invalid', quarantine: { oversized: false, contentSha256: null } }).authority,
    ).toBe('journal-quarantine-only');
    expect(describeState({ kind: 'activation-pending', from: OLD, target: T }).authority).toBe('external-tty-setup');
  });
});

// ============================================================================
// Consent + authorization + unforgeable brands
// ============================================================================

function ttyContext(overrides: Partial<ConsentContext> = {}): ConsentContext {
  return { stdinIsTTY: true, stdoutIsTTY: true, env: {}, argv: [], prompt: () => true, ...overrides };
}

function pendingSnapshot(): CodexActivationSnapshot {
  return { ...currentSnapshot(), query: regPresent(OLD), cache: cachePresent('b'.repeat(64)) };
}

describe('requestRetirementAssertion — the only source of a genuine brand', () => {
  test('grants an assertion only with real TTYs, clean env, no quick flag, and an affirmative', () => {
    const result = requestRetirementAssertion(pendingSnapshot(), ttyContext());
    expect(result.result).toBe('granted');
  });

  test('every guard refuses and mints nothing', () => {
    const s = pendingSnapshot();
    expect(requestRetirementAssertion(s, ttyContext({ stdinIsTTY: false })).result).toBe('refused');
    expect(requestRetirementAssertion(s, ttyContext({ stdoutIsTTY: false })).result).toBe('refused');
    expect(requestRetirementAssertion(s, ttyContext({ env: { CODEX_THREAD_ID: 't1' } })).result).toBe('refused');
    expect(requestRetirementAssertion(s, ttyContext({ env: { CI: '1' } })).result).toBe('refused');
    for (const flag of [
      '--quick',
      '--fast',
      '--no-interactive',
      '--non-interactive',
      '--noninteractive',
      '--yes',
      '-y',
    ]) {
      expect(requestRetirementAssertion(s, ttyContext({ argv: [flag] })).result).toBe('refused');
    }
  });

  test('decline and prompt failure (EOF) both refuse', () => {
    expect(requestRetirementAssertion(pendingSnapshot(), ttyContext({ prompt: () => false })).result).toBe('refused');
    expect(
      requestRetirementAssertion(
        pendingSnapshot(),
        ttyContext({
          prompt: () => {
            throw new Error('EOF');
          },
        }),
      ).result,
    ).toBe('refused');
  });
});

describe('authorizeCodexActivation — fingerprint-bound permit from a genuine assertion', () => {
  function grantAssertion(snapshot: CodexActivationSnapshot) {
    const consent = requestRetirementAssertion(snapshot, ttyContext());
    if (consent.result !== 'granted') throw new Error('expected consent to grant');
    return consent.assertion;
  }

  test('a genuine assertion on an external setup path grants a permit', () => {
    const snapshot = pendingSnapshot();
    const invocation: ActivationInvocation = { entry: 'setup-codex', assertion: grantAssertion(snapshot) };
    const result = authorizeCodexActivation({ state: classifyCodexActivation(snapshot), snapshot, invocation });
    expect(result.result).toBe('granted');
  });

  test('a structural forgery / persisted-consent lookalike is refused at the runtime boundary', () => {
    const snapshot = pendingSnapshot();
    const forged = { observedFrom: OLD, observedTarget: T, assertedAt: 'now' } as unknown as mod.RetirementAssertion;
    const result = authorizeCodexActivation({
      state: classifyCodexActivation(snapshot),
      snapshot,
      invocation: { entry: 'setup-codex', assertion: forged },
    });
    expect(result.result).toBe('refused');
  });

  test('a boolean substitute cannot stand in for the brand', () => {
    const snapshot = pendingSnapshot();
    const result = authorizeCodexActivation({
      state: classifyCodexActivation(snapshot),
      snapshot,
      invocation: { entry: 'setup-codex', assertion: true as unknown as mod.RetirementAssertion },
    });
    expect(result.result).toBe('refused');
  });

  test('a non-setup entry path with a genuine assertion still requires external setup', () => {
    const snapshot = pendingSnapshot();
    const invocation: ActivationInvocation = { entry: 'update', assertion: grantAssertion(snapshot) };
    const result = authorizeCodexActivation({ state: classifyCodexActivation(snapshot), snapshot, invocation });
    expect(result.result).toBe('required');
  });

  test('a stale assertion whose observed versions changed is refused', () => {
    const consentSnapshot = pendingSnapshot();
    const assertion = grantAssertion(consentSnapshot);
    const changed = { ...pendingSnapshot(), query: regPresent('5.260710.1') };
    const result = authorizeCodexActivation({
      state: classifyCodexActivation(changed),
      snapshot: changed,
      invocation: { entry: 'setup-codex', assertion },
    });
    expect(result.result).toBe('refused');
  });

  test('a state with no mutation authority reports not-requested', () => {
    const snapshot = currentSnapshot();
    const result = authorizeCodexActivation({
      state: classifyCodexActivation(snapshot),
      snapshot,
      invocation: { entry: 'setup-codex', assertion: null },
    });
    expect(result.result).toBe('not-requested');
  });

  test('an eligible state with no assertion reports required', () => {
    const snapshot = pendingSnapshot();
    const result = authorizeCodexActivation({
      state: classifyCodexActivation(snapshot),
      snapshot,
      invocation: { entry: 'setup-codex', assertion: null },
    });
    expect(result.result).toBe('required');
  });
});

// ============================================================================
// Observation — bounded, inert, physical-fault aware
// ============================================================================

describe('observeCodexActivation — bounded plugin query', () => {
  test('a current fixture classifies as current with a verified cache', () => {
    const fx = makeFixture({ targetVersion: T, registeredVersion: T, sameBytes: true });
    const snapshot = observeCodexActivation({
      genieHome: fx.genieHome,
      codexHome: fx.codexHome,
      command: 'codex',
      runner: listRunner({ stdout: pluginListJson([{ version: T }]) }),
    });
    expect(classifyCodexActivation(snapshot).kind).toBe('current');
    expect(
      projectIntegrationSummary(classifyCodexActivation(snapshot), snapshot, { result: 'not-requested' }, true)
        .codexPlugin.cache,
    ).toBe('verified-current');
  });

  test('registered N < canonical T is activation-pending (present-unverified)', () => {
    const fx = makeFixture({ targetVersion: T, registeredVersion: OLD });
    const snapshot = observeCodexActivation({
      genieHome: fx.genieHome,
      codexHome: fx.codexHome,
      command: 'codex',
      runner: listRunner({ stdout: pluginListJson([{ version: OLD }]) }),
    });
    expect(classifyCodexActivation(snapshot).kind).toBe('activation-pending');
    expect(projectCacheOf(snapshot)).toBe('present-unverified');
  });

  function projectCacheOf(snapshot: CodexActivationSnapshot): string {
    return projectIntegrationSummary(classifyCodexActivation(snapshot), snapshot, { result: 'not-requested' }, true)
      .codexPlugin.cache;
  }

  test('timeout, output overflow, non-zero exit, and stderr each fail the query', () => {
    const fx = makeFixture({ targetVersion: T, registeredVersion: T });
    const base = { genieHome: fx.genieHome, codexHome: fx.codexHome, command: 'codex' };
    const cases: CommandRunner[] = [
      () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: true }),
      () => ({ exitCode: 0, stdout: pluginListJson([{ version: T }]), stderr: '', outputOverflow: true }),
      () => ({ exitCode: 1, stdout: '', stderr: '' }),
      () => ({ exitCode: 0, stdout: pluginListJson([{ version: T }]), stderr: 'boom' }),
    ];
    for (const runner of cases) {
      const snapshot = observeCodexActivation({ ...base, runner });
      expect(snapshot.query.status).toBe('failed');
      expect(classifyCodexActivation(snapshot).kind).toBe('query-failed');
    }
  });

  test('a second trailing JSON value fails the single-value requirement', () => {
    const fx = makeFixture({ targetVersion: T, registeredVersion: T });
    const doubled = `${pluginListJson([{ version: T }])}\n${pluginListJson([{ version: T }])}`;
    const snapshot = observeCodexActivation({
      genieHome: fx.genieHome,
      codexHome: fx.codexHome,
      command: 'codex',
      runner: listRunner({ stdout: doubled }),
    });
    expect(snapshot.query.status).toBe('failed');
  });

  test('duplicate Genie registrations are rejected', () => {
    const fx = makeFixture({ targetVersion: T, registeredVersion: T });
    const snapshot = observeCodexActivation({
      genieHome: fx.genieHome,
      codexHome: fx.codexHome,
      command: 'codex',
      runner: listRunner({ stdout: pluginListJson([{ version: T }, { version: T }]) }),
    });
    expect(snapshot.query.status).toBe('failed');
  });

  test('ANSI/OSC wrappers are sanitised before the JSON is parsed', () => {
    const fx = makeFixture({ targetVersion: T, registeredVersion: T, sameBytes: true });
    const wrapped = `[32m${pluginListJson([{ version: T }])}[0m`;
    const snapshot = observeCodexActivation({
      genieHome: fx.genieHome,
      codexHome: fx.codexHome,
      command: 'codex',
      runner: listRunner({ stdout: wrapped }),
    });
    expect(snapshot.query.status).toBe('ok');
    expect(classifyCodexActivation(snapshot).kind).toBe('current');
  });

  test('a missing codex command reports a failed query', () => {
    const fx = makeFixture({ targetVersion: T, registeredVersion: T });
    const snapshot = observeCodexActivation({ genieHome: fx.genieHome, codexHome: fx.codexHome, command: null });
    expect(snapshot.query.status).toBe('failed');
  });

  test('the cache-family witness is identical before and after the query (observation is inert)', () => {
    const fx = makeFixture({ targetVersion: T, registeredVersion: T, sameBytes: true });
    const snapshot = observeCodexActivation({
      genieHome: fx.genieHome,
      codexHome: fx.codexHome,
      command: 'codex',
      runner: listRunner({ stdout: pluginListJson([{ version: T }]) }),
    });
    expect(snapshot.observationWitness.before).toEqual(snapshot.observationWitness.after);
  });

  test('production rejects GENIE_BUNDLE_ROOT as a canonical root', () => {
    const fx = makeFixture({ targetVersion: T, registeredVersion: T, sameBytes: true });
    setEnv('GENIE_BUNDLE_ROOT', fx.genieHome);
    const snapshot = observeCodexActivation({
      genieHome: fx.genieHome,
      codexHome: fx.codexHome,
      command: 'codex',
      runner: listRunner({ stdout: pluginListJson([{ version: T }]) }),
    });
    expect(snapshot.canonical.status).toBe('error');
    expect(classifyCodexActivation(snapshot).kind).toBe('snapshot-inconsistent');
  });
});

describe('observeCodexActivation — physical cache faults', () => {
  test('a symlinked cache generation is unsafe-cache-symlink', () => {
    const fx = makeFixture({ targetVersion: T, registeredVersion: null });
    const familyDir = join(fx.codexHome, 'plugins', 'cache', 'automagik', 'genie');
    mkdirSync(familyDir, { recursive: true });
    const realTarget = join(fx.codexHome, 'elsewhere');
    writeFiles(realTarget, PAYLOAD_FILES);
    symlinkSync(realTarget, join(familyDir, T));
    const snapshot = observeCodexActivation({
      genieHome: fx.genieHome,
      codexHome: fx.codexHome,
      command: 'codex',
      runner: listRunner({ stdout: pluginListJson([{ version: T }]) }),
    });
    expect(classifyCodexActivation(snapshot).kind).toBe('unsafe-cache-symlink');
  });

  test('a missing cache generation for a present registration is cache-missing', () => {
    const fx = makeFixture({ targetVersion: T, registeredVersion: null });
    const snapshot = observeCodexActivation({
      genieHome: fx.genieHome,
      codexHome: fx.codexHome,
      command: 'codex',
      runner: listRunner({ stdout: pluginListJson([{ version: T }]) }),
    });
    expect(classifyCodexActivation(snapshot).kind).toBe('cache-missing');
  });

  test('installed T bytes differing from canonical is payload-mismatch', () => {
    const fx = makeFixture({
      targetVersion: T,
      registeredVersion: T,
      cacheFiles: { 'plugin.json': '{"tampered":true}\n' },
    });
    const snapshot = observeCodexActivation({
      genieHome: fx.genieHome,
      codexHome: fx.codexHome,
      command: 'codex',
      runner: listRunner({ stdout: pluginListJson([{ version: T }]) }),
    });
    expect(classifyCodexActivation(snapshot).kind).toBe('payload-mismatch');
  });
});

// ============================================================================
// The deep store
// ============================================================================

function heldLease(genieHome: string) {
  const lease = acquireLifecycleLease('setup-activation', { genieHome });
  if (!lease.ok) throw new Error('could not acquire lease');
  return lease;
}

describe('CodexActivationStore — delivery + downgrade receipt', () => {
  test('publishDelivery writes a delivery record and no receipt for an ordinary delivery', () => {
    const fx = makeFixture({ targetVersion: T, registeredVersion: T, sameBytes: true });
    const store = openCodexActivationStore({
      genieHome: fx.genieHome,
      codexHome: fx.codexHome,
      command: 'codex',
      runner: listRunner({ stdout: pluginListJson([{ version: T }]) }),
    });
    const lease = heldLease(fx.genieHome);
    try {
      const record = store.publishDelivery(lease, {
        targetVersion: T,
        canonicalPayloadSha256: DIGEST,
        channel: 'stable',
      });
      expect(record.deliveryId).toMatch(/^[0-9a-f]{32}$/);
      expect(existsSync(join(fx.genieHome, '.codex-plugin-delivery-record.json'))).toBe(true);
      expect(existsSync(join(fx.genieHome, '.codex-plugin-downgrade-receipt.json'))).toBe(false);
    } finally {
      lease.release();
    }
  });

  test('an explicit downgrade delivery writes a matching receipt whose id equals the delivery id', () => {
    const fx = makeFixture({ targetVersion: T, registeredVersion: NEWER });
    const store = openCodexActivationStore({
      genieHome: fx.genieHome,
      codexHome: fx.codexHome,
      command: 'codex',
      runner: listRunner({ stdout: pluginListJson([{ version: NEWER }]) }),
    });
    const lease = heldLease(fx.genieHome);
    try {
      const record = store.publishDelivery(lease, {
        targetVersion: T,
        canonicalPayloadSha256: canonicalDigest(fx.genieHome),
        channel: 'stable',
        downgradeFrom: NEWER,
      });
      const snapshot = store.observe();
      expect(snapshot.receipt.status).toBe('present');
      if (snapshot.receipt.status === 'present') expect(snapshot.receipt.receipt.receiptId).toBe(record.deliveryId);
      // Registered newer + matching receipt => pending-downgrade-explicit, not installed-newer.
      expect(classifyCodexActivation(snapshot).kind).toBe('pending-downgrade-explicit');
    } finally {
      lease.release();
    }
  });

  test('a downgrade delivery whose from <= target is rejected', () => {
    const fx = makeFixture({ targetVersion: T, registeredVersion: OLD });
    const store = openCodexActivationStore({
      genieHome: fx.genieHome,
      codexHome: fx.codexHome,
      command: 'codex',
      runner: listRunner({ stdout: pluginListJson([{ version: OLD }]) }),
    });
    const lease = heldLease(fx.genieHome);
    try {
      expect(() =>
        store.publishDelivery(lease, {
          targetVersion: T,
          canonicalPayloadSha256: DIGEST,
          channel: 'stable',
          downgradeFrom: OLD,
        }),
      ).toThrow();
    } finally {
      lease.release();
    }
  });
});

describe('CodexActivationStore — withRevalidatedDeliveryRoot', () => {
  test('revalidates and exposes only callback-scoped ops, then invalidates them', () => {
    const fx = makeFixture({ targetVersion: T, registeredVersion: T, sameBytes: true });
    const store = openCodexActivationStore({
      genieHome: fx.genieHome,
      codexHome: fx.codexHome,
      command: 'codex',
      runner: listRunner({ stdout: pluginListJson([{ version: T }]) }),
    });
    const lease = heldLease(fx.genieHome);
    let escaped: mod.DeliveryRootOps | null = null;
    try {
      store.publishDelivery(lease, {
        targetVersion: T,
        canonicalPayloadSha256: canonicalDigest(fx.genieHome),
        channel: 'stable',
      });
      const version = store.withRevalidatedDeliveryRoot(lease, (ops) => {
        escaped = ops;
        expect(ops.inventoryDigest()).toMatch(/^[0-9a-f]{64}$/);
        return ops.deliveredVersion();
      });
      expect(version).toBe(T);
      // An escaped capability throws once the callback has returned.
      expect(() => escaped?.inventoryDigest()).toThrow();
    } finally {
      lease.release();
    }
  });

  test('rejects a delivery record whose digest no longer matches the payload', () => {
    const fx = makeFixture({ targetVersion: T, registeredVersion: T, sameBytes: true });
    const store = openCodexActivationStore({
      genieHome: fx.genieHome,
      codexHome: fx.codexHome,
      command: 'codex',
      runner: listRunner({ stdout: pluginListJson([{ version: T }]) }),
    });
    const lease = heldLease(fx.genieHome);
    try {
      store.publishDelivery(lease, { targetVersion: T, canonicalPayloadSha256: DIGEST, channel: 'stable' }); // wrong digest
      expect(() => store.withRevalidatedDeliveryRoot(lease, (ops) => ops.deliveredVersion())).toThrow();
    } finally {
      lease.release();
    }
  });

  test('the store object exposes no raw path capabilities', () => {
    const fx = makeFixture({ targetVersion: T, registeredVersion: T, sameBytes: true });
    const store = openCodexActivationStore({
      genieHome: fx.genieHome,
      codexHome: fx.codexHome,
      command: 'codex',
      runner: listRunner({ stdout: pluginListJson([{ version: T }]) }),
    });
    expect(Object.keys(store).sort()).toEqual(
      [
        'advanceIntentPhase',
        'beginActivation',
        'finalizeActivation',
        'observe',
        'publishDelivery',
        'quarantineIntent',
        'withRevalidatedDeliveryRoot',
      ].sort(),
    );
  });
});

describe('CodexActivationStore — beginActivation fingerprint binding', () => {
  function grantPermit(store: mod.CodexActivationStore) {
    const snapshot = store.observe();
    const consent = requestRetirementAssertion(snapshot, ttyContext());
    if (consent.result !== 'granted') throw new Error('consent not granted');
    const auth = authorizeCodexActivation({
      state: classifyCodexActivation(snapshot),
      snapshot,
      invocation: { entry: 'setup-codex', assertion: consent.assertion },
    });
    if (auth.result !== 'granted') throw new Error('authorization not granted');
    return auth.permit;
  }

  test('a fresh permit begins a planned transaction fenced by the lease operation id', () => {
    const fx = makeFixture({ targetVersion: T, registeredVersion: OLD });
    const store = openCodexActivationStore({
      genieHome: fx.genieHome,
      codexHome: fx.codexHome,
      command: 'codex',
      runner: listRunner({ stdout: pluginListJson([{ version: OLD }]) }),
    });
    const permit = grantPermit(store);
    const lease = heldLease(fx.genieHome);
    try {
      const result = store.beginActivation(lease, permit);
      expect(result.status).toBe('started');
      if (result.status === 'started') {
        expect(result.handle.operationId).toBe(lease.operationId);
        expect(existsSync(join(fx.genieHome, '.codex-plugin-refresh-intent.json'))).toBe(true);
        const observed = store.observe();
        expect(observed.intent.status).toBe('valid');
        if (observed.intent.status === 'valid') expect(observed.intent.intent.phase).toBe('planned');
      }
    } finally {
      lease.release();
    }
  });

  test('a stale permit is detected on re-observation and performs zero mutation', () => {
    const fx = makeFixture({ targetVersion: T, registeredVersion: OLD });
    const store = openCodexActivationStore({
      genieHome: fx.genieHome,
      codexHome: fx.codexHome,
      command: 'codex',
      runner: listRunner({ stdout: pluginListJson([{ version: OLD }]) }),
    });
    const permit = grantPermit(store);
    // Change the canonical payload so its digest (a fingerprint field) drifts.
    writeFileSync(join(fx.genieHome, 'plugins', 'genie', 'new-file.txt'), 'drift\n');
    const lease = heldLease(fx.genieHome);
    try {
      const result = store.beginActivation(lease, permit);
      expect(result.status).toBe('stale');
      if (result.status === 'stale') expect(result.mismatchField).toBe('canonicalPayloadSha256');
      // No intent was written.
      expect(existsSync(join(fx.genieHome, '.codex-plugin-refresh-intent.json'))).toBe(false);
    } finally {
      lease.release();
    }
  });

  test('a forged permit is refused with zero mutation', () => {
    const fx = makeFixture({ targetVersion: T, registeredVersion: OLD });
    const store = openCodexActivationStore({
      genieHome: fx.genieHome,
      codexHome: fx.codexHome,
      command: 'codex',
      runner: listRunner({ stdout: pluginListJson([{ version: OLD }]) }),
    });
    const snapshot = store.observe();
    const forged = {
      capability: 'activation',
      fingerprint: computeActivationFingerprint(snapshot),
      observedFrom: OLD,
      observedTarget: T,
    } as unknown as mod.ActivationPermit;
    const lease = heldLease(fx.genieHome);
    try {
      const result = store.beginActivation(lease, forged);
      expect(result.status).toBe('refused');
      expect(existsSync(join(fx.genieHome, '.codex-plugin-refresh-intent.json'))).toBe(false);
    } finally {
      lease.release();
    }
  });

  test('advance then finalize deletes the intent (crash-safe delete order)', () => {
    const fx = makeFixture({ targetVersion: T, registeredVersion: OLD });
    const store = openCodexActivationStore({
      genieHome: fx.genieHome,
      codexHome: fx.codexHome,
      command: 'codex',
      runner: listRunner({ stdout: pluginListJson([{ version: OLD }]) }),
    });
    const permit = grantPermit(store);
    const lease = heldLease(fx.genieHome);
    try {
      const begun = store.beginActivation(lease, permit);
      if (begun.status !== 'started') throw new Error('expected started');
      store.advanceIntentPhase(lease, begun.handle, 'command-started', 'in flight');
      const mid = store.observe();
      expect(mid.intent.status === 'valid' && mid.intent.intent.phase).toBe('command-started');
      store.finalizeActivation(lease, begun.handle);
      expect(existsSync(join(fx.genieHome, '.codex-plugin-refresh-intent.json'))).toBe(false);
    } finally {
      lease.release();
    }
  });

  test('a superseded lease operation id fences an intent advance', () => {
    const fx = makeFixture({ targetVersion: T, registeredVersion: OLD });
    const store = openCodexActivationStore({
      genieHome: fx.genieHome,
      codexHome: fx.codexHome,
      command: 'codex',
      runner: listRunner({ stdout: pluginListJson([{ version: OLD }]) }),
    });
    const permit = grantPermit(store);
    const lease = heldLease(fx.genieHome);
    const begun = store.beginActivation(lease, permit);
    if (begun.status !== 'started') throw new Error('expected started');
    // Simulate supersession: replace the on-disk lease with a foreign operation id.
    writeFileSync(
      join(fx.genieHome, '.codex-lifecycle.lock'),
      `${JSON.stringify({ schemaVersion: 1, operationId: 'f'.repeat(32), kind: 'rollback', pid: process.pid, startedAt: 'x' })}\n`,
    );
    expect(() => store.advanceIntentPhase(lease, begun.handle, 'command-started')).toThrow();
  });
});

describe('CodexActivationStore — journal quarantine', () => {
  function grantQuarantinePermit(store: mod.CodexActivationStore) {
    const snapshot = store.observe();
    const consent = requestRetirementAssertion(snapshot, ttyContext());
    if (consent.result !== 'granted') throw new Error('consent not granted');
    const auth = authorizeCodexActivation({
      state: classifyCodexActivation(snapshot),
      snapshot,
      invocation: { entry: 'setup-codex', assertion: consent.assertion },
    });
    if (auth.result !== 'granted') throw new Error('authorization not granted');
    return auth.permit;
  }

  test('a corrupt intent is renamed to a non-overwriting .invalid-<sha256> sidecar', () => {
    const fx = makeFixture({ targetVersion: T, registeredVersion: T, sameBytes: true });
    writeFileSync(join(fx.genieHome, '.codex-plugin-refresh-intent.json'), '{ corrupt');
    const store = openCodexActivationStore({
      genieHome: fx.genieHome,
      codexHome: fx.codexHome,
      command: 'codex',
      runner: listRunner({ stdout: pluginListJson([{ version: T }]) }),
    });
    expect(classifyCodexActivation(store.observe()).kind).toBe('intent-invalid');
    const permit = grantQuarantinePermit(store);
    const lease = heldLease(fx.genieHome);
    try {
      const result = store.quarantineIntent(lease, permit);
      expect('quarantinedTo' in result).toBe(true);
      expect(existsSync(join(fx.genieHome, '.codex-plugin-refresh-intent.json'))).toBe(false);
      const quarantined = readdirSync(fx.genieHome).filter((n) => n.includes('.invalid-'));
      expect(quarantined.length).toBe(1);
    } finally {
      lease.release();
    }
  });

  test('an oversized intent is quarantined with an .invalid-oversized-<nonce> name', () => {
    const fx = makeFixture({ targetVersion: T, registeredVersion: T, sameBytes: true });
    writeFileSync(join(fx.genieHome, '.codex-plugin-refresh-intent.json'), 'x'.repeat(17 * 1024));
    const store = openCodexActivationStore({
      genieHome: fx.genieHome,
      codexHome: fx.codexHome,
      command: 'codex',
      runner: listRunner({ stdout: pluginListJson([{ version: T }]) }),
    });
    const permit = grantQuarantinePermit(store);
    const lease = heldLease(fx.genieHome);
    try {
      const result = store.quarantineIntent(lease, permit);
      expect('quarantinedTo' in result).toBe(true);
      const quarantined = readdirSync(fx.genieHome).filter((n) => n.includes('.invalid-oversized-'));
      expect(quarantined.length).toBe(1);
    } finally {
      lease.release();
    }
  });

  test('a symlinked intent path is not quarantined (fails closed)', () => {
    // A symlinked intent classifies as snapshot-inconsistent (no quarantine
    // authority). Mint a genuine quarantine permit from a corrupt intent, then
    // swap the file to a symlink and prove quarantineIntent refuses to move it.
    const fx = makeFixture({ targetVersion: T, registeredVersion: T, sameBytes: true });
    const intentPath = join(fx.genieHome, '.codex-plugin-refresh-intent.json');
    writeFileSync(intentPath, '{ corrupt');
    const store = openCodexActivationStore({
      genieHome: fx.genieHome,
      codexHome: fx.codexHome,
      command: 'codex',
      runner: listRunner({ stdout: pluginListJson([{ version: T }]) }),
    });
    const permit = grantQuarantinePermit(store);
    rmSync(intentPath);
    const decoy = join(fx.genieHome, 'decoy-intent.json');
    writeFileSync(decoy, '{}');
    symlinkSync(decoy, intentPath);
    const lease = heldLease(fx.genieHome);
    try {
      const result = store.quarantineIntent(lease, permit);
      expect('skipped' in result).toBe(true);
      expect(existsSync(intentPath)).toBe(true);
      // No .invalid sidecar was created for the symlinked path.
      expect(readdirSync(fx.genieHome).filter((n) => n.includes('.invalid-')).length).toBe(0);
    } finally {
      lease.release();
    }
  });
});

// ============================================================================
// Projections, serializer, exit overlay
// ============================================================================

describe('projections and result trailer', () => {
  test('integrationSummary preserves the additive schema-1 shape', () => {
    const snapshot = pendingSnapshot();
    const summary = projectIntegrationSummary(
      classifyCodexActivation(snapshot),
      snapshot,
      { result: 'required', reason: 'need setup' },
      true,
    );
    expect(summary.schemaVersion).toBe(1);
    expect(summary.codexPlugin.state).toBe('activation-pending');
    expect(summary.codexPlugin.installedVersion).toBe(ver(OLD).canonical);
    expect(summary.codexPlugin.targetVersion).toBe(T);
    expect(summary.codexPlugin.direction).toBe('upgrade');
    expect(summary.codexPlugin.mutationAuthority).toBe('external-tty-setup');
    expect(summary.codexPlugin.authorization).toEqual({ result: 'required', reason: 'need setup' });
    expect(summary.codexPlugin.deliveryComplete).toBe(true);
    expect(summary.codexPlugin.actionRequired).toBe(true);
  });

  test('human output routes pending to stdout and broken to stderr with no all-green footer', () => {
    const pending = projectHumanStatus(classifyCodexActivation(pendingSnapshot()), pendingSnapshot());
    expect(pending.stream).toBe('stdout');
    expect(pending.exitCode).toBe(2);
    const broken = projectHumanStatus({ kind: 'cache-missing' }, currentSnapshot());
    expect(broken.stream).toBe('stderr');
    expect(broken.exitCode).toBe(1);
  });

  test('the result trailer has exactly one canonical serializer', () => {
    const trailer = buildActivationResultTrailer(classifyCodexActivation(pendingSnapshot()), false);
    expect(trailer.deliveryComplete).toBe(false);
    const serialized = JSON.parse(serializeActivationResultTrailer(trailer));
    expect(serialized).toEqual({
      schemaVersion: 1,
      code: 'activation-pending',
      deliveryComplete: false,
      retry: false,
      nextAction: trailer.nextAction,
    });
  });

  test('eligible setup refusal exits 2 even when the ordinary doctor exit is 1', () => {
    const brokenButEligible = { kind: 'cache-missing' } as const; // ordinary exit 1, authority external-tty-setup
    expect(resolveSetupExitCode(brokenButEligible, { result: 'refused', reason: 'declined' })).toBe(2);
    expect(resolveSetupExitCode(brokenButEligible, { result: 'not-requested' })).toBe(1);
  });
});

// ============================================================================
// Type / source guards
// ============================================================================

describe('module surface', () => {
  test('raw state and root path helpers are not exported', () => {
    const exported = mod as Record<string, unknown>;
    for (const name of [
      'refreshIntentPath',
      'downgradeReceiptPath',
      'deliveryRecordPath',
      'receiptTombstonePath',
      'resolveCanonicalRoot',
      'hashFileBounded',
    ]) {
      expect(exported[name]).toBeUndefined();
    }
  });

  test('stripControl removes CSI and OSC sequences', () => {
    expect(stripControl('[31mred[0m')).toBe('red');
    expect(stripControl(']0;titlebody')).toBe('body');
  });
});
