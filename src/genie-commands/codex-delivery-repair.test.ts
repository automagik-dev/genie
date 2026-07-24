import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type {
  CodexActivationStore,
  DeliveryFact,
  DeliveryRecord,
  PublishDeliveryInput,
} from '../lib/codex-activation.js';
import {
  type VerifiedDeliveryEvidence,
  deriveDeliveryId,
  verifiedDeliveryEvidenceFacts,
  verifyDownloadedDeliveryEvidence,
} from '../lib/codex-delivery-evidence.js';
import {
  buildTestDeliveryEvidencePack,
  mintTestDeliveryEvidence,
} from '../lib/codex-delivery-evidence.test-support.js';
import type { HeldLifecycleLease } from '../lib/codex-lifecycle-lease.js';
import {
  type CandidateProof,
  type DeliveryRepairSeams,
  type DownloadedRepairAsset,
  type InstalledProof,
  type PinnedManifest,
  type ReobservedTarget,
  type RepairPinnedTarget,
  buildLocalRepairExpectation,
  repairMissingDelivery,
} from './codex-delivery-repair.js';

const T = '5.260722.11';
const N = '5.260722.1';
const CHANNEL = 'dev';
const PLATFORM_ID =
  process.platform === 'darwin' ? 'darwin-arm64' : process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64-glibc';
const PLATFORM_TRIPLE = `${process.platform}-${process.arch}`;
const RELEASE_TAG = `v${T}`;
const RELEASE_NAME = `genie-${T}-${PLATFORM_ID}.tar.gz`;
const PAYLOAD_DIGEST = 'a'.repeat(64);
const BINARY_DIGEST = 'b'.repeat(64);
const ARTIFACT_DIGEST = 'd'.repeat(64);
const DELIVERY_ROOT = '/home/dev/.genie';
const TARBALL_PATH = `/tmp/repair/${RELEASE_NAME}`;

const PINNED: RepairPinnedTarget = {
  channel: CHANNEL,
  targetVersion: T,
  platformTriple: PLATFORM_TRIPLE,
  platformId: PLATFORM_ID,
  releaseTag: RELEASE_TAG,
  releaseName: RELEASE_NAME,
};

const INSTALLED: InstalledProof = {
  version: T,
  pluginTreeSha256: PAYLOAD_DIGEST,
  binarySha256: BINARY_DIGEST,
  deliveryRoot: DELIVERY_ROOT,
};

function packFor(version = T) {
  return buildTestDeliveryEvidencePack({
    descriptor: {
      version,
      channel: CHANNEL,
      artifactSha256: ARTIFACT_DIGEST,
      installedBinarySha256: BINARY_DIGEST,
      canonicalPayloadSha256: PAYLOAD_DIGEST,
    },
  });
}

function pinnedManifest(version = T, changedBytes = false): PinnedManifest {
  const pack = packFor(version);
  const manifestBytes = changedBytes ? `${pack.manifestBytes} ` : pack.manifestBytes;
  const parsed = JSON.parse(pack.manifestBytes) as Omit<PinnedManifest, 'manifestBytes' | 'manifestSha256'>;
  return {
    ...parsed,
    manifestBytes,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
  };
}

function recordForEvidence(evidence: VerifiedDeliveryEvidence, deliveryRoot = DELIVERY_ROOT): DeliveryRecord {
  const facts = verifiedDeliveryEvidenceFacts(evidence);
  const descriptor = facts.descriptor;
  return {
    schemaVersion: 2,
    deliveryId: deriveDeliveryId(facts.evidenceDigest, deliveryRoot),
    targetVersion: descriptor.version,
    canonicalPayloadSha256: descriptor.canonicalPayloadSha256,
    channel: descriptor.channel,
    deliveredAt: facts.deliveredAt,
    evidenceDigest: facts.evidenceDigest,
    platformId: descriptor.platformId,
    platformTriple: descriptor.platformTriple,
    releaseTag: descriptor.releaseTag,
    releaseName: descriptor.releaseName,
    releaseManifestSha256: descriptor.releaseManifestSha256,
    artifactSha256: descriptor.artifactSha256,
    installedBinarySha256: descriptor.installedBinarySha256,
    deliveryRoot,
  };
}

/** A store that records exactly which methods were invoked and echoes the evidence-derived record. */
function spyStore(): { store: CodexActivationStore; publishCalls: PublishDeliveryInput[]; touched: string[] } {
  const publishCalls: PublishDeliveryInput[] = [];
  const touched: string[] = [];
  const forbid = (name: string) => () => {
    touched.push(name);
    throw new Error(`repair must never call ${name}`);
  };
  const store: CodexActivationStore = {
    observe: forbid('observe') as CodexActivationStore['observe'],
    publishDelivery(_lease, input): DeliveryRecord {
      touched.push('publishDelivery');
      publishCalls.push(input);
      return recordForEvidence(input.evidence, input.deliveryRoot);
    },
    withRevalidatedDeliveryRoot: forbid(
      'withRevalidatedDeliveryRoot',
    ) as CodexActivationStore['withRevalidatedDeliveryRoot'],
    beginActivation: forbid('beginActivation') as CodexActivationStore['beginActivation'],
    advanceIntentPhase: forbid('advanceIntentPhase') as CodexActivationStore['advanceIntentPhase'],
    finalizeActivation: forbid('finalizeActivation') as CodexActivationStore['finalizeActivation'],
    quarantineIntent: forbid('quarantineIntent') as CodexActivationStore['quarantineIntent'],
  };
  return { store, publishCalls, touched };
}

function spyLease(): HeldLifecycleLease {
  return { ok: true, operationId: 'f'.repeat(32), kind: 'update-delivery', assertOperation() {}, release() {} };
}

interface SeamOverrides {
  readDeliveryFact?: () => DeliveryFact;
  observeInstalled?: () => InstalledProof;
  fetchManifest?: (channel: string) => Promise<PinnedManifest | null>;
  downloadAndVerify?: (target: RepairPinnedTarget, manifest: PinnedManifest) => Promise<DownloadedRepairAsset>;
  hashArtifact?: (path: string) => string;
  proveCandidate?: (path: string) => Promise<CandidateProof>;
  verifyEvidence?: DeliveryRepairSeams['verifyEvidence'];
  reobserve?: () => ReobservedTarget | null;
  installedGeneration?: string | null;
  store?: CodexActivationStore;
}

/** Happy-path seams + a call log; overrides let each test tamper exactly one stage. */
function makeSeams(overrides: SeamOverrides = {}): { seams: DeliveryRepairSeams; log: string[] } {
  const log: string[] = [];
  const installedGeneration = overrides.installedGeneration ?? N;
  const store = overrides.store ?? spyStore().store;
  const pack = packFor();
  const seams: DeliveryRepairSeams = {
    readDeliveryFact:
      overrides.readDeliveryFact ??
      (() => {
        log.push('readDeliveryFact');
        return { status: 'absent' };
      }),
    observeInstalled:
      overrides.observeInstalled ??
      (() => {
        log.push('observeInstalled');
        return INSTALLED;
      }),
    fetchManifest:
      overrides.fetchManifest ??
      (async (channel) => {
        log.push(`fetchManifest:${channel}`);
        return pinnedManifest();
      }),
    downloadAndVerify:
      overrides.downloadAndVerify ??
      (async (target, manifest) => {
        log.push(`downloadAndVerify:${target.releaseName}:${manifest.manifestSha256}`);
        return { tarballPath: TARBALL_PATH, descriptorBytes: pack.descriptorBytes, bundleBytes: pack.bundleBytes };
      }),
    hashArtifact:
      overrides.hashArtifact ??
      ((path) => {
        log.push(`hashArtifact:${path}`);
        return ARTIFACT_DIGEST;
      }),
    proveCandidate:
      overrides.proveCandidate ??
      (async (path) => {
        log.push(`proveCandidate:${path}`);
        return { version: T, pluginTreeSha256: PAYLOAD_DIGEST, binarySha256: BINARY_DIGEST };
      }),
    verifyEvidence:
      overrides.verifyEvidence ??
      ((input) => {
        log.push('verifyEvidence');
        return verifyDownloadedDeliveryEvidence(input, pack.dependencies);
      }),
    reobserve:
      overrides.reobserve ??
      (() => {
        log.push('reobserve');
        return {
          installedGeneration,
          canonicalVersion: T,
          canonicalPayloadSha256: PAYLOAD_DIGEST,
          installedBinarySha256: BINARY_DIGEST,
          deliveryRoot: DELIVERY_ROOT,
        };
      }),
    store,
    lease: spyLease(),
  };
  return { seams, log };
}

function matchingDeliveryFact(): DeliveryFact {
  const { evidence } = mintTestDeliveryEvidence({
    descriptor: {
      version: T,
      channel: CHANNEL,
      artifactSha256: ARTIFACT_DIGEST,
      installedBinarySha256: BINARY_DIGEST,
      canonicalPayloadSha256: PAYLOAD_DIGEST,
    },
  });
  return {
    status: 'present',
    record: recordForEvidence(evidence),
    evidence: verifiedDeliveryEvidenceFacts(evidence),
  };
}

describe('same-version delivery repair', () => {
  test('builds its expectation from independently verified evidence plus local physical bytes', () => {
    const fact = matchingDeliveryFact();
    if (fact.status !== 'present') throw new Error('expected present fixture');
    const expectation = buildLocalRepairExpectation(PINNED, INSTALLED, fact.evidence);
    const { schemaVersion: _schemaVersion, ...recordExpectation } = fact.record;
    expect(expectation).toEqual(recordExpectation);
  });

  test('matching evidence takes the no-network, no-publication fast path', async () => {
    const spy = spyStore();
    const { seams, log } = makeSeams({ store: spy.store, readDeliveryFact: matchingDeliveryFact });
    expect(await repairMissingDelivery(PINNED, seams)).toEqual({ kind: 'already-matching' });
    expect(spy.publishCalls).toHaveLength(0);
    expect(spy.touched).toEqual([]);
    expect(log.some((entry) => entry.startsWith('fetchManifest'))).toBe(false);
    expect(log.some((entry) => entry.startsWith('downloadAndVerify'))).toBe(false);
  });

  test('verifies exact evidence, publishes once, preserves N, and reports activation pending', async () => {
    const spy = spyStore();
    const { seams, log } = makeSeams({ store: spy.store, installedGeneration: N });
    const outcome = await repairMissingDelivery(PINNED, seams);
    expect(outcome).toMatchObject({
      kind: 'published',
      handoff: 'activation-pending',
      artifactSha256: ARTIFACT_DIGEST,
    });
    expect(spy.publishCalls).toHaveLength(1);
    expect(spy.publishCalls[0].deliveryRoot).toBe(DELIVERY_ROOT);
    expect(verifiedDeliveryEvidenceFacts(spy.publishCalls[0].evidence).descriptor).toMatchObject({
      version: T,
      channel: CHANNEL,
      platformId: PLATFORM_ID,
      artifactSha256: ARTIFACT_DIGEST,
      installedBinarySha256: BINARY_DIGEST,
      canonicalPayloadSha256: PAYLOAD_DIGEST,
    });
    expect(spy.touched).toEqual(['publishDelivery']);
    expect(log.indexOf(`fetchManifest:${CHANNEL}`)).toBeLessThan(
      log.findIndex((entry) => entry.startsWith('downloadAndVerify')),
    );
    expect(log.findIndex((entry) => entry.startsWith('downloadAndVerify'))).toBeLessThan(
      log.findIndex((entry) => entry.startsWith('hashArtifact')),
    );
    expect(log.indexOf('verifyEvidence')).toBeLessThan(log.indexOf('reobserve'));
  });

  test('a current registered generation reports current after publication', async () => {
    const { seams } = makeSeams({ installedGeneration: T });
    const outcome = await repairMissingDelivery(PINNED, seams);
    expect(outcome.kind).toBe('published');
    if (outcome.kind === 'published') expect(outcome.handoff).toBe('current');
  });

  test('channel advance before or after download routes to the ordinary upgrade path without publishing', async () => {
    for (const advanceOn of [1, 2]) {
      const spy = spyStore();
      let calls = 0;
      const { seams } = makeSeams({
        store: spy.store,
        fetchManifest: async () => {
          calls += 1;
          return calls >= advanceOn ? pinnedManifest('5.260722.12') : pinnedManifest();
        },
      });
      const outcome = await repairMissingDelivery(PINNED, seams);
      expect(outcome).toMatchObject({ kind: 'channel-advanced', from: T, to: '5.260722.12' });
      expect(spy.publishCalls).toHaveLength(0);
    }
  });
});

describe('same-version repair failure matrix', () => {
  async function expectUnchangedFailure(overrides: SeamOverrides, stage: string): Promise<void> {
    const spy = spyStore();
    const { seams } = makeSeams({ ...overrides, store: spy.store });
    const outcome = await repairMissingDelivery(PINNED, seams);
    expect(outcome).toMatchObject({ kind: 'failed', stage, deliveryComplete: false });
    expect(spy.publishCalls).toHaveLength(0);
    expect(spy.touched).toEqual([]);
  }

  test('manifest pin failures are closed before download', async () => {
    await expectUnchangedFailure({ fetchManifest: async () => null }, 'manifest-pin');
    await expectUnchangedFailure(
      { fetchManifest: async () => ({ ...pinnedManifest(), channel: 'stable' }) },
      'manifest-pin',
    );
    await expectUnchangedFailure(
      { fetchManifest: async () => ({ ...pinnedManifest(), platforms: ['linux-arm64'] }) },
      'manifest-pin',
    );
  });

  test('download, digest, extraction, candidate, and signed-evidence failures never publish', async () => {
    await expectUnchangedFailure(
      { downloadAndVerify: async () => Promise.reject(new Error('signature verification failed')) },
      'download-verify',
    );
    await expectUnchangedFailure(
      {
        hashArtifact: () => {
          throw new Error('cannot read tarball');
        },
      },
      'artifact-digest',
    );
    await expectUnchangedFailure(
      { proveCandidate: async () => Promise.reject(new Error('symlink in payload')) },
      'extract-prove',
    );
    await expectUnchangedFailure(
      {
        proveCandidate: async () => ({
          version: '5.260722.9',
          pluginTreeSha256: PAYLOAD_DIGEST,
          binarySha256: BINARY_DIGEST,
        }),
      },
      'candidate-version',
    );
    await expectUnchangedFailure(
      {
        proveCandidate: async () => ({
          version: T,
          pluginTreeSha256: '9'.repeat(64),
          binarySha256: BINARY_DIGEST,
        }),
      },
      'candidate-payload',
    );
    await expectUnchangedFailure(
      {
        proveCandidate: async () => ({
          version: T,
          pluginTreeSha256: PAYLOAD_DIGEST,
          binarySha256: '9'.repeat(64),
        }),
      },
      'candidate-binary',
    );
    await expectUnchangedFailure(
      {
        verifyEvidence: () => {
          throw new Error('descriptor signature invalid');
        },
      },
      'evidence-verify',
    );
  });

  test('manifest-byte drift, reobservation drift, and fenced publication fail closed', async () => {
    let calls = 0;
    await expectUnchangedFailure(
      {
        fetchManifest: async () => {
          calls += 1;
          return calls === 1 ? pinnedManifest() : pinnedManifest(T, true);
        },
      },
      'channel-recheck',
    );
    await expectUnchangedFailure({ reobserve: () => null }, 'reobserve');
    await expectUnchangedFailure(
      {
        reobserve: () => ({
          installedGeneration: N,
          canonicalVersion: T,
          canonicalPayloadSha256: PAYLOAD_DIGEST,
          installedBinarySha256: '9'.repeat(64),
          deliveryRoot: DELIVERY_ROOT,
        }),
      },
      'reobserve',
    );
    const fencedStore: CodexActivationStore = {
      ...spyStore().store,
      publishDelivery() {
        throw new Error('codex lifecycle transition fenced');
      },
    };
    const { seams } = makeSeams({ store: fencedStore });
    expect(await repairMissingDelivery(PINNED, seams)).toMatchObject({
      kind: 'failed',
      stage: 'publish',
      deliveryComplete: false,
    });
  });

  test('record/evidence mismatch is repaired rather than accepted', async () => {
    const fact = matchingDeliveryFact();
    if (fact.status !== 'present') throw new Error('expected present fixture');
    const stale: DeliveryFact = {
      ...fact,
      record: { ...fact.record, platformTriple: `${fact.record.platformTriple}-stale` },
    };
    const { seams, log } = makeSeams({ readDeliveryFact: () => stale, installedGeneration: T });
    expect((await repairMissingDelivery(PINNED, seams)).kind).toBe('published');
    expect(log.some((entry) => entry.startsWith('downloadAndVerify'))).toBe(true);
  });
});
