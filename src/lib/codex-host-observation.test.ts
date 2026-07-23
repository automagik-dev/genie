import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ActivationDeliveryExpectation,
  type AuthenticatedDeliveryRecord,
  type CodexHostObservation,
  type DeliveryRecordReadState,
  type HostCacheWitness,
  type HostObservationFailureCode,
  assessAuthenticatedDelivery,
  buildDeliveryIncompleteResult,
  parseCodexHostObservation,
  projectHostQuery,
  witnessCodexCacheFamily,
} from './codex-host-observation.js';
import type { CommandResult } from './runtime-integrations.js';

// ============================================================================
// Fixtures
// ============================================================================

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'genie-host-obs-'));
  roots.push(root);
  return root;
}

const T = '5.260712.1';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);
const DIGEST_D = 'd'.repeat(64);
const DIGEST_E = 'e'.repeat(64);
const ID_128 = '1'.repeat(32);
const PRESENT_FAMILY: HostCacheWitness = { status: 'present', digest: 'f'.repeat(64), identity: '10:20' };

function result(overrides: Partial<CommandResult> & { stdout?: string } = {}): CommandResult {
  return { exitCode: 0, stdout: '', stderr: '', ...overrides };
}
function pluginListJson(entries: Array<{ version: string; enabled?: boolean }>): string {
  return JSON.stringify({
    installed: entries.map((e) => ({ pluginId: 'genie@automagik', version: e.version, enabled: e.enabled ?? true })),
  });
}
function parse(
  overrides: Partial<CommandResult> & { stdout?: string },
  cacheFamily = PRESENT_FAMILY,
): CodexHostObservation {
  return parseCodexHostObservation({ result: result(overrides), cacheFamily });
}

// ============================================================================
// parseCodexHostObservation — the bounded query (deliverable 6)
// ============================================================================

describe('parseCodexHostObservation — one bounded subprocess result', () => {
  test('exit 0 + one valid JSON + clean stderr → ok with parsed plugin facts and no advisory', () => {
    const obs = parse({ stdout: pluginListJson([{ version: T, enabled: true }]) });
    expect(obs.status).toBe('ok');
    if (obs.status !== 'ok') throw new Error('unreachable');
    expect(obs.plugin).toEqual({ installed: true, enabled: true, version: T });
    expect(obs.advisoryStderr).toBeNull();
    expect(obs.effectiveChildCwd).toBeNull();
    expect(obs.childPid).toBeNull();
  });

  test('an absent registration parses to installed:false', () => {
    const obs = parse({ stdout: JSON.stringify({ installed: [] }) });
    expect(obs.status).toBe('ok');
    if (obs.status !== 'ok') throw new Error('unreachable');
    expect(obs.plugin).toEqual({ installed: false, enabled: null, version: null });
  });

  // THE real sandbox-PATH-advisory case: advisory stderr is retained (not a failure) with exit 0 + valid stdout.
  test('exit 0 + valid stdout + advisory stderr → ok, advisory retained as sanitized metadata', () => {
    const obs = parse({
      stdout: pluginListJson([{ version: T }]),
      stderr: 'warning: codex added to PATH; restart your shell',
    });
    expect(obs.status).toBe('ok');
    if (obs.status !== 'ok') throw new Error('unreachable');
    expect(obs.plugin.installed).toBe(true);
    expect(obs.advisoryStderr).toBe('warning: codex added to PATH; restart your shell');
  });

  test('advisory stderr is stripped of ANSI control sequences and bounded to the cap', () => {
    const obs = parseCodexHostObservation({
      result: result({ stdout: pluginListJson([{ version: T }]), stderr: `\x1b[33m${'x'.repeat(50)}\x1b[0m` }),
      cacheFamily: PRESENT_FAMILY,
      maxAdvisoryBytes: 10,
    });
    expect(obs.status).toBe('ok');
    if (obs.status !== 'ok') throw new Error('unreachable');
    expect(obs.advisoryStderr).not.toContain('\x1b');
    // 10 bytes retained + an ellipsis marker.
    expect(obs.advisoryStderr).toBe(`${'x'.repeat(10)}…`);
  });

  test('ANSI/OSC-wrapped stdout is sanitized before the JSON is parsed', () => {
    const obs = parse({ stdout: `\x1b[32m${pluginListJson([{ version: T }])}\x1b[0m` });
    expect(obs.status).toBe('ok');
  });

  const failureCases: Array<{
    name: string;
    result: Partial<CommandResult> & { stdout?: string };
    code: HostObservationFailureCode;
  }> = [
    { name: 'timeout', result: { timedOut: true, stdout: pluginListJson([{ version: T }]) }, code: 'timeout' },
    {
      name: 'output overflow',
      result: { outputOverflow: true, stdout: pluginListJson([{ version: T }]) },
      code: 'output-overflow',
    },
    { name: 'nonzero exit', result: { exitCode: 3, stdout: pluginListJson([{ version: T }]) }, code: 'nonzero-exit' },
    { name: 'empty stdout', result: { stdout: '' }, code: 'malformed-json' },
    { name: 'unparseable stdout', result: { stdout: '{not json' }, code: 'malformed-json' },
    {
      name: 'two JSON values',
      result: { stdout: `${pluginListJson([{ version: T }])}\n${pluginListJson([{ version: T }])}` },
      code: 'malformed-json',
    },
    {
      name: 'duplicate registration',
      result: { stdout: pluginListJson([{ version: T }, { version: T }]) },
      code: 'duplicate-registration',
    },
    {
      name: 'invalid (non-release) version',
      result: { stdout: pluginListJson([{ version: '1.2.3' }]) },
      code: 'invalid-plugin-version',
    },
    {
      name: 'malformed enabled field',
      result: {
        stdout: JSON.stringify({ installed: [{ pluginId: 'genie@automagik', version: T, enabled: 'yes' }] }),
      },
      code: 'malformed-json',
    },
  ];
  for (const c of failureCases) {
    test(`${c.name} → typed failure ${c.code}, ANSI-free detail`, () => {
      const obs = parse(c.result);
      expect(obs.status).toBe('failed');
      if (obs.status !== 'failed') throw new Error('unreachable');
      expect(obs.code).toBe(c.code);
      expect(obs.detail).not.toContain('\x1b');
    });
  }

  test('an unsafe cache family root fails the observation before parsing plugin facts', () => {
    const obs = parse(
      { stdout: pluginListJson([{ version: T }]) },
      { status: 'unsafe', detail: 'family is a symlink' },
    );
    expect(obs.status).toBe('failed');
    if (obs.status !== 'failed') throw new Error('unreachable');
    expect(obs.code).toBe('unsafe-cache-root');
  });

  test('a genieRuntime self-report populates effective child CWD / identity / PID', () => {
    const stdout = JSON.stringify({
      installed: [{ pluginId: 'genie@automagik', version: T, enabled: true }],
      genieRuntime: { effectiveCwd: '/repo/a', cwdIdentity: '99:100', pid: 4242 },
    });
    const obs = parse({ stdout });
    expect(obs.status).toBe('ok');
    if (obs.status !== 'ok') throw new Error('unreachable');
    expect(obs.effectiveChildCwd).toBe('/repo/a');
    expect(obs.effectiveChildCwdIdentity).toBe('99:100');
    expect(obs.childPid).toBe(4242);
  });

  test('a malformed genieRuntime envelope is ignored (optional metadata), not a failure', () => {
    const stdout = JSON.stringify({
      installed: [{ pluginId: 'genie@automagik', version: T, enabled: true }],
      genieRuntime: { effectiveCwd: '', pid: 'nope' },
    });
    const obs = parse({ stdout });
    expect(obs.status).toBe('ok');
    if (obs.status !== 'ok') throw new Error('unreachable');
    expect(obs.effectiveChildCwd).toBeNull();
    expect(obs.childPid).toBeNull();
  });
});

// ============================================================================
// projectHostQuery — ONE observation feeds downstream projections
// ============================================================================

describe('projectHostQuery — the single downstream projection', () => {
  test('an exit-0 advisory observation projects registration present AND not query-failed', () => {
    const obs = parse({ stdout: pluginListJson([{ version: T }]), stderr: 'PATH advisory' });
    const projection = projectHostQuery(obs);
    // The real sandbox advisory can never produce a PASS + query-failed pair.
    expect(projection.queryFailed).toBe(false);
    expect(projection.registration).toBe('present');
    expect(projection.installedVersion).toBe(T);
    expect(projection.advisory).toBe('PATH advisory');
  });

  test('a failed observation projects queryFailed with no registration claim', () => {
    const obs = parse({ exitCode: 1, stdout: '' });
    const projection = projectHostQuery(obs);
    expect(projection.queryFailed).toBe(true);
    expect(projection.registration).toBe('unknown');
    expect(projection.failureCode).toBe('nonzero-exit');
  });
});

// ============================================================================
// witnessCodexCacheFamily — filesystem witness
// ============================================================================

describe('witnessCodexCacheFamily', () => {
  function codexHomeWith(build: (familyDir: string, root: string) => void): string {
    const root = freshRoot();
    const familyDir = join(root, 'plugins', 'cache', 'automagik', 'genie');
    build(familyDir, root);
    return root;
  }

  test('an absent family is absent', () => {
    const root = freshRoot();
    expect(witnessCodexCacheFamily(root)).toEqual({ status: 'absent' });
  });

  test('a present family reports a stable dev:ino identity + digest', () => {
    const root = codexHomeWith((familyDir) => {
      mkdirSync(join(familyDir, T), { recursive: true });
    });
    const witness = witnessCodexCacheFamily(root);
    expect(witness.status).toBe('present');
    if (witness.status !== 'present') throw new Error('unreachable');
    expect(witness.identity).toMatch(/^\d+:\d+$/);
    expect(witness.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test('a symlinked family is unsafe', () => {
    const root = codexHomeWith((familyDir, base) => {
      const parent = join(base, 'plugins', 'cache', 'automagik');
      mkdirSync(parent, { recursive: true });
      const real = join(base, 'elsewhere');
      mkdirSync(real, { recursive: true });
      symlinkSync(real, familyDir);
    });
    const witness = witnessCodexCacheFamily(root);
    expect(witness.status).toBe('unsafe');
  });
});

// ============================================================================
// assessAuthenticatedDelivery — the pure classifier (deliverables 4, 7)
// ============================================================================

function fullRecord(overrides: Partial<AuthenticatedDeliveryRecord> = {}): AuthenticatedDeliveryRecord {
  return {
    targetVersion: T,
    canonicalPayloadSha256: DIGEST_A,
    channel: 'stable',
    deliveryId: ID_128,
    evidenceDigest: DIGEST_E,
    platformId: 'darwin-arm64',
    platformTriple: 'darwin-arm64',
    releaseTag: 'v5.260712.1',
    releaseName: 'genie-5.260712.1-darwin-arm64.tar.gz',
    releaseManifestSha256: DIGEST_B,
    artifactSha256: DIGEST_C,
    installedBinarySha256: DIGEST_D,
    deliveryRoot: '/home/.genie/deliveries/abc',
    deliveredAt: '2026-07-12T00:00:00.000Z',
    ...overrides,
  };
}
function fullExpectation(overrides: Partial<ActivationDeliveryExpectation> = {}): ActivationDeliveryExpectation {
  return {
    targetVersion: T,
    canonicalPayloadSha256: DIGEST_A,
    channel: 'stable',
    deliveryId: ID_128,
    evidenceDigest: DIGEST_E,
    platformId: 'darwin-arm64',
    platformTriple: 'darwin-arm64',
    releaseTag: 'v5.260712.1',
    releaseName: 'genie-5.260712.1-darwin-arm64.tar.gz',
    releaseManifestSha256: DIGEST_B,
    artifactSha256: DIGEST_C,
    installedBinarySha256: DIGEST_D,
    deliveryRoot: '/home/.genie/deliveries/abc',
    deliveredAt: '2026-07-12T00:00:00.000Z',
    ...overrides,
  };
}
function present(record: AuthenticatedDeliveryRecord): DeliveryRecordReadState {
  return { status: 'present', record };
}

describe('assessAuthenticatedDelivery — matching | absent | invalid | mismatch', () => {
  test('a fully-bound record matching every expectation field is matching', () => {
    expect(assessAuthenticatedDelivery(present(fullRecord()), fullExpectation())).toBe('matching');
  });

  test('an absent record is absent', () => {
    expect(assessAuthenticatedDelivery({ status: 'absent' }, fullExpectation())).toBe('absent');
  });

  test('an on-disk invalid read-state is invalid', () => {
    expect(assessAuthenticatedDelivery({ status: 'invalid', detail: 'bad json' }, fullExpectation())).toBe('invalid');
  });

  // Structural corruption => invalid (never mismatch).
  const invalidStructures: Array<{ name: string; record: Partial<AuthenticatedDeliveryRecord> }> = [
    { name: 'non-release targetVersion', record: { targetVersion: '1.2.3' } },
    { name: 'short payload digest', record: { canonicalPayloadSha256: 'abc' } },
    { name: 'non-hex deliveryId', record: { deliveryId: 'ZZZZ' } },
    { name: 'malformed evidence digest', record: { evidenceDigest: 'nothex' } },
    { name: 'empty platform id', record: { platformId: '' } },
    { name: 'empty channel', record: { channel: '' } },
    { name: 'malformed platform triple', record: { platformTriple: 'Darwin ARM' } },
    { name: 'malformed manifest digest', record: { releaseManifestSha256: 'nothex' } },
    { name: 'malformed artifact digest', record: { artifactSha256: 'nothex' } },
    { name: 'malformed binary digest', record: { installedBinarySha256: 'nothex' } },
  ];
  for (const c of invalidStructures) {
    test(`a record with ${c.name} is invalid`, () => {
      expect(assessAuthenticatedDelivery(present(fullRecord(c.record)), fullExpectation())).toBe('invalid');
    });
  }

  // Tampering ANY bound field => mismatch (deliverable 7 + acceptance criterion).
  const tampers: Array<{ name: string; record: Partial<AuthenticatedDeliveryRecord> }> = [
    {
      name: 'version',
      record: {
        targetVersion: '5.260799.9',
        releaseTag: 'v5.260799.9',
        releaseName: 'genie-5.260799.9-darwin-arm64.tar.gz',
      },
    },
    { name: 'platform', record: { platformTriple: 'linux-x64' } },
    { name: 'manifest', record: { releaseManifestSha256: DIGEST_E } },
    { name: 'artifact', record: { artifactSha256: DIGEST_E } },
    { name: 'binary', record: { installedBinarySha256: DIGEST_E } },
    { name: 'payload', record: { canonicalPayloadSha256: DIGEST_E } },
    { name: 'delivery id', record: { deliveryId: '2'.repeat(32) } },
    { name: 'evidence digest', record: { evidenceDigest: 'f'.repeat(64) } },
    { name: 'platform id', record: { platformId: 'linux-x64-glibc' } },
    { name: 'channel', record: { channel: 'homolog' } },
    { name: 'delivery root', record: { deliveryRoot: '/tmp/evil' } },
  ];
  for (const c of tampers) {
    test(`tampering the ${c.name} binding => mismatch`, () => {
      expect(assessAuthenticatedDelivery(present(fullRecord(c.record)), fullExpectation())).toBe('mismatch');
    });
  }

  test('intent binding: a record minted for a different activation intent (target) => mismatch', () => {
    // The record is internally consistent but bound to a different intent than the current activation.
    const record = fullRecord({
      targetVersion: '5.260799.9',
      releaseTag: 'v5.260799.9',
      releaseName: 'genie-5.260799.9-darwin-arm64.tar.gz',
    });
    expect(assessAuthenticatedDelivery(present(record), fullExpectation({ targetVersion: T }))).toBe('mismatch');
  });

  test('downgrade binding: matching requires the record deliveryId to equal the consumed receipt id', () => {
    const receiptId = '7'.repeat(32);
    const bound = fullExpectation({ deliveryId: receiptId });
    expect(assessAuthenticatedDelivery(present(fullRecord({ deliveryId: receiptId })), bound)).toBe('matching');
    expect(assessAuthenticatedDelivery(present(fullRecord({ deliveryId: ID_128 })), bound)).toBe('mismatch');
  });

  test('a full expectation rejects a minimal record lacking authenticated bindings', () => {
    const minimal = {
      targetVersion: T,
      canonicalPayloadSha256: DIGEST_A,
      channel: 'stable',
      deliveryId: ID_128,
    } as AuthenticatedDeliveryRecord;
    expect(assessAuthenticatedDelivery(present(minimal), fullExpectation())).toBe('invalid');
  });

  for (const field of [
    'evidenceDigest',
    'platformId',
    'platformTriple',
    'releaseTag',
    'releaseName',
    'releaseManifestSha256',
    'artifactSha256',
    'installedBinarySha256',
    'deliveryRoot',
    'deliveredAt',
  ] as const) {
    test(`a record missing ${field} is invalid even for a full expectation`, () => {
      const record = { ...fullRecord() };
      Reflect.deleteProperty(record, field);
      expect(assessAuthenticatedDelivery(present(record as AuthenticatedDeliveryRecord), fullExpectation())).toBe(
        'invalid',
      );
    });
  }

  test('an internally inconsistent release tag/name is invalid', () => {
    expect(assessAuthenticatedDelivery(present(fullRecord({ releaseTag: 'v9.9.9' })), fullExpectation())).toBe(
      'invalid',
    );
    expect(assessAuthenticatedDelivery(present(fullRecord({ releaseName: 'evil' })), fullExpectation())).toBe(
      'invalid',
    );
  });
});

// ============================================================================
// buildDeliveryIncompleteResult — the stable typed result (deliverable 4)
// ============================================================================

describe('buildDeliveryIncompleteResult', () => {
  test('is authority none, exit 1, deliveryComplete false, with an ANSI-free detail and recovery command', () => {
    for (const assessment of ['absent', 'invalid', 'mismatch'] as const) {
      const r = buildDeliveryIncompleteResult(assessment);
      expect(r.code).toBe('delivery-incomplete');
      expect(r.authority).toBe('none');
      expect(r.exit).toBe(1);
      expect(r.deliveryComplete).toBe(false);
      expect(r.assessment).toBe(assessment);
      expect(r.recovery).toContain('genie update');
      expect(r.detail).not.toContain('\x1b');
      expect(r.detail.length).toBeGreaterThan(0);
    }
  });
});
