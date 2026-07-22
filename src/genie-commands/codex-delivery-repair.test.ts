import { describe, expect, test } from 'bun:test';
import type { CodexActivationStore, DeliveryRecord, PublishDeliveryInput } from '../lib/codex-activation.js';
import type { DeliveryRecordReadState } from '../lib/codex-host-observation.js';
import type { HeldLifecycleLease } from '../lib/codex-lifecycle-lease.js';
import {
  type CandidateProof,
  type DeliveryRepairSeams,
  type InstalledProof,
  type PinnedManifest,
  type ReobservedTarget,
  type RepairPinnedTarget,
  buildLocalRepairExpectation,
  repairMissingDelivery,
} from './codex-delivery-repair.js';

const T = '5.260722.11';
const N = '5.260722.1';
const PLATFORM = 'darwin-arm64';
const RELEASE_TAG = `v${T}`;
const RELEASE_NAME = `genie-${T}-darwin-arm64.tar.gz`;
const CHANNEL = 'dev';
const PAYLOAD_DIGEST = 'a'.repeat(64);
const BINARY_DIGEST = 'b'.repeat(64);
const MANIFEST_DIGEST = 'c'.repeat(64);
const ARTIFACT_DIGEST = 'd'.repeat(64);
const DELIVERY_ROOT = '/home/dev/.genie';
const TARBALL_PATH = '/tmp/repair/genie.tar.gz';

const PINNED: RepairPinnedTarget = {
  channel: CHANNEL,
  targetVersion: T,
  platformTriple: PLATFORM,
  releaseTag: RELEASE_TAG,
  releaseName: RELEASE_NAME,
};

const INSTALLED: InstalledProof = {
  version: T,
  pluginTreeSha256: PAYLOAD_DIGEST,
  binarySha256: BINARY_DIGEST,
  deliveryRoot: DELIVERY_ROOT,
};

/** A store that records exactly which methods were invoked and echoes the publish input. */
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
      return {
        schemaVersion: 1,
        deliveryId: input.deliveryId ?? 'e'.repeat(32),
        targetVersion: input.targetVersion,
        canonicalPayloadSha256: input.canonicalPayloadSha256,
        channel: input.channel,
        deliveredAt: '2026-07-22T00:00:00.000Z',
        ...(input.attestation ?? {}),
      };
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
  readDeliveryRecord?: () => DeliveryRecordReadState;
  observeInstalled?: () => InstalledProof;
  fetchManifest?: (channel: string) => Promise<PinnedManifest | null>;
  downloadAndVerify?: (target: RepairPinnedTarget) => Promise<string>;
  hashArtifact?: (path: string) => string;
  proveCandidate?: (path: string) => Promise<CandidateProof>;
  reobserve?: () => ReobservedTarget | null;
  installedGeneration?: string | null;
  store?: CodexActivationStore;
}

/** Happy-path seams + a call log; overrides let each test tamper exactly one stage. */
function makeSeams(overrides: SeamOverrides = {}): { seams: DeliveryRepairSeams; log: string[] } {
  const log: string[] = [];
  const installedGeneration = overrides.installedGeneration ?? N; // old-parent by default
  const store = overrides.store ?? spyStore().store;
  const seams: DeliveryRepairSeams = {
    readDeliveryRecord:
      overrides.readDeliveryRecord ??
      (() => {
        log.push('readDeliveryRecord');
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
        return { version: T, manifestSha256: MANIFEST_DIGEST };
      }),
    downloadAndVerify:
      overrides.downloadAndVerify ??
      (async (target) => {
        log.push(`downloadAndVerify:${target.releaseName}`);
        return TARBALL_PATH;
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
    reobserve:
      overrides.reobserve ??
      (() => {
        log.push('reobserve');
        return { installedGeneration, canonicalVersion: T, canonicalPayloadSha256: PAYLOAD_DIGEST };
      }),
    store,
    lease: spyLease(),
    deliveryId: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
  };
  return { seams, log };
}

/** A present authenticated record binding exactly the local tuple (drives the fast path). */
function matchingRecordReadState(): DeliveryRecordReadState {
  return {
    status: 'present',
    record: {
      targetVersion: T,
      canonicalPayloadSha256: PAYLOAD_DIGEST,
      channel: CHANNEL,
      deliveryId: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
      platformTriple: PLATFORM,
      releaseTag: RELEASE_TAG,
      releaseName: RELEASE_NAME,
      releaseManifestSha256: MANIFEST_DIGEST,
      artifactSha256: ARTIFACT_DIGEST,
      installedBinarySha256: BINARY_DIGEST,
      deliveryRoot: DELIVERY_ROOT,
    },
  };
}

describe('buildLocalRepairExpectation — binds only locally-known fields (no network digests)', () => {
  test('binds the local tuple and omits the manifest/artifact digests', () => {
    const expectation = buildLocalRepairExpectation(PINNED, INSTALLED);
    expect(expectation).toEqual({
      targetVersion: T,
      canonicalPayloadSha256: PAYLOAD_DIGEST,
      channel: CHANNEL,
      platformTriple: PLATFORM,
      releaseTag: RELEASE_TAG,
      releaseName: RELEASE_NAME,
      installedBinarySha256: BINARY_DIGEST,
      deliveryRoot: DELIVERY_ROOT,
    });
    // The two network-derived digests are never bound in the fast path.
    expect('releaseManifestSha256' in expectation).toBe(false);
    expect('artifactSha256' in expectation).toBe(false);
  });
});

describe('no-network fast path — a matching record downloads and publishes nothing', () => {
  test('already-matching record returns without any network or publish', async () => {
    const { store, publishCalls, touched } = spyStore();
    const { seams, log } = makeSeams({ store, readDeliveryRecord: () => matchingRecordReadState() });
    const outcome = await repairMissingDelivery(PINNED, seams);
    expect(outcome).toEqual({ kind: 'already-matching' });
    expect(publishCalls).toHaveLength(0);
    expect(touched).toEqual([]);
    // No manifest fetch, download, hash, or prove happened.
    expect(log.some((entry) => entry.startsWith('fetchManifest'))).toBe(false);
    expect(log.some((entry) => entry.startsWith('downloadAndVerify'))).toBe(false);
  });

  test('a repeated repair after publication (matching record) still performs no download', async () => {
    // Simulate the second run: the record now binds the tuple.
    const { seams, log } = makeSeams({ readDeliveryRecord: () => matchingRecordReadState() });
    const outcome = await repairMissingDelivery(PINNED, seams);
    expect(outcome.kind).toBe('already-matching');
    expect(log.filter((entry) => entry.startsWith('downloadAndVerify'))).toHaveLength(0);
  });
});

describe('old-parent → current-target / no-record: publishes one bound record, keeps N, handoff activation-pending', () => {
  test('publishes exactly one record bound to the pinned tuple with the persisted authenticated digest', async () => {
    const { store, publishCalls, touched } = spyStore();
    const { seams } = makeSeams({ store, installedGeneration: N });
    const outcome = await repairMissingDelivery(PINNED, seams);
    expect(outcome.kind).toBe('published');
    if (outcome.kind !== 'published') throw new Error('expected published');
    expect(outcome.handoff).toBe('activation-pending'); // N < T ⇒ still needs setup activation
    expect(outcome.artifactSha256).toBe(ARTIFACT_DIGEST);
    // Exactly one publish; no activation-owned store method touched.
    expect(publishCalls).toHaveLength(1);
    expect(touched).toEqual(['publishDelivery']);
    // The record binds the full pinned tuple, including the computed authenticated digest.
    expect(publishCalls[0].attestation).toEqual({
      platformTriple: PLATFORM,
      releaseTag: RELEASE_TAG,
      releaseName: RELEASE_NAME,
      releaseManifestSha256: MANIFEST_DIGEST,
      artifactSha256: ARTIFACT_DIGEST,
      installedBinarySha256: BINARY_DIGEST,
      deliveryRoot: DELIVERY_ROOT,
    });
    expect(publishCalls[0].targetVersion).toBe(T);
    expect(publishCalls[0].canonicalPayloadSha256).toBe(PAYLOAD_DIGEST);
    expect(publishCalls[0].channel).toBe(CHANNEL);
  });

  test('pins channel/version/platform/tag/name + manifest digest BEFORE the download, and hashes AFTER', async () => {
    const { seams, log } = makeSeams({ installedGeneration: N });
    await repairMissingDelivery(PINNED, seams);
    const firstFetch = log.findIndex((entry) => entry.startsWith('fetchManifest'));
    const download = log.findIndex((entry) => entry.startsWith('downloadAndVerify'));
    const hash = log.findIndex((entry) => entry.startsWith('hashArtifact'));
    // Manifest is pinned before the asset download; the digest is computed after.
    expect(firstFetch).toBeGreaterThanOrEqual(0);
    expect(firstFetch).toBeLessThan(download);
    expect(download).toBeLessThan(hash);
    // The download names the exact pinned asset.
    expect(log[download]).toBe(`downloadAndVerify:${RELEASE_NAME}`);
  });
});

describe('live target-current / removal-observed: repairs with no plugin command', () => {
  test('registered N == T ⇒ published handoff current, only publishDelivery touched', async () => {
    const { store, touched } = spyStore();
    const { seams } = makeSeams({ store, installedGeneration: T });
    const outcome = await repairMissingDelivery(PINNED, seams);
    expect(outcome.kind).toBe('published');
    if (outcome.kind === 'published') expect(outcome.handoff).toBe('current');
    expect(touched).toEqual(['publishDelivery']); // no plugin/activation mutation
  });

  test('removal-observed (registration absent) ⇒ published handoff activation-pending', async () => {
    const { seams } = makeSeams({ installedGeneration: null });
    const outcome = await repairMissingDelivery(PINNED, seams);
    expect(outcome.kind).toBe('published');
    if (outcome.kind === 'published') expect(outcome.handoff).toBe('activation-pending');
  });
});

describe('channel advance routes to ordinary upgrade and mints no record for stale bytes', () => {
  test('pre-download advance: the pinned manifest already names a newer version', async () => {
    const { store, publishCalls } = spyStore();
    const { seams, log } = makeSeams({
      store,
      fetchManifest: async () => ({ version: '5.260722.12', manifestSha256: MANIFEST_DIGEST }),
    });
    const outcome = await repairMissingDelivery(PINNED, seams);
    expect(outcome).toEqual({ kind: 'channel-advanced', from: T, to: '5.260722.12' });
    expect(publishCalls).toHaveLength(0);
    // Never downloads stale bytes when the channel already advanced.
    expect(log.some((entry) => entry.startsWith('downloadAndVerify'))).toBe(false);
  });

  test('under-lease recheck advance: channel moved after download ⇒ no publish', async () => {
    const { store, publishCalls } = spyStore();
    let call = 0;
    const { seams } = makeSeams({
      store,
      fetchManifest: async () => {
        call += 1;
        return call === 1
          ? { version: T, manifestSha256: MANIFEST_DIGEST }
          : { version: '5.260722.12', manifestSha256: 'f'.repeat(64) };
      },
    });
    const outcome = await repairMissingDelivery(PINNED, seams);
    expect(outcome).toEqual({ kind: 'channel-advanced', from: T, to: '5.260722.12' });
    expect(publishCalls).toHaveLength(0);
  });
});

describe('tamper / lease / reobservation matrix — every failure leaves state unchanged, deliveryComplete:false', () => {
  async function expectUnchangedFailure(overrides: SeamOverrides, stage: string): Promise<void> {
    const spy = spyStore();
    const { seams } = makeSeams({ ...overrides, store: spy.store });
    const outcome = await repairMissingDelivery(PINNED, seams);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') throw new Error('expected failed');
    expect(outcome.stage).toBe(stage as never);
    expect(outcome.deliveryComplete).toBe(false);
    // Nothing was published; no store method mutated durable state.
    expect(spy.publishCalls).toHaveLength(0);
    expect(spy.touched).toEqual([]);
  }

  test('manifest unavailable at pin time', async () => {
    await expectUnchangedFailure({ fetchManifest: async () => null }, 'manifest-pin');
  });

  test('artifact signature/attestation rejects the download', async () => {
    await expectUnchangedFailure(
      {
        downloadAndVerify: async () => {
          throw new Error('signature verification failed');
        },
      },
      'download-verify',
    );
  });

  test('artifact digest computation fails', async () => {
    await expectUnchangedFailure(
      {
        hashArtifact: () => {
          throw new Error('cannot read tarball');
        },
      },
      'artifact-digest',
    );
  });

  test('private extraction/prove fails', async () => {
    await expectUnchangedFailure(
      {
        proveCandidate: async () => {
          throw new Error('symlink in payload');
        },
      },
      'extract-prove',
    );
  });

  test('candidate version tampering', async () => {
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
  });

  test('payload tampering — candidate plugin tree differs from installed', async () => {
    await expectUnchangedFailure(
      { proveCandidate: async () => ({ version: T, pluginTreeSha256: '9'.repeat(64), binarySha256: BINARY_DIGEST }) },
      'candidate-payload',
    );
  });

  test('installed-byte tampering — candidate binary differs from installed', async () => {
    await expectUnchangedFailure(
      { proveCandidate: async () => ({ version: T, pluginTreeSha256: PAYLOAD_DIGEST, binarySha256: '9'.repeat(64) }) },
      'candidate-binary',
    );
  });

  test('manifest tampering — recheck bytes changed without a version advance', async () => {
    let call = 0;
    await expectUnchangedFailure(
      {
        fetchManifest: async () => {
          call += 1;
          return call === 1
            ? { version: T, manifestSha256: MANIFEST_DIGEST }
            : { version: T, manifestSha256: '9'.repeat(64) };
        },
      },
      'channel-recheck',
    );
  });

  test('reobservation unavailable', async () => {
    await expectUnchangedFailure({ reobserve: () => null }, 'reobserve');
  });

  test('installed bytes changed between proof and publication', async () => {
    await expectUnchangedFailure(
      { reobserve: () => ({ installedGeneration: N, canonicalVersion: T, canonicalPayloadSha256: '9'.repeat(64) }) },
      'reobserve',
    );
  });

  test('lease-fenced publish leaves everything unchanged and reports publish failure', async () => {
    const fencedStore: CodexActivationStore = {
      ...spyStore().store,
      publishDelivery() {
        throw new Error('codex lifecycle transition fenced: operation does not match held');
      },
    };
    const { seams } = makeSeams({ store: fencedStore });
    const outcome = await repairMissingDelivery(PINNED, seams);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.stage).toBe('publish');
      expect(outcome.deliveryComplete).toBe(false);
    }
  });
});

describe('a non-matching (mismatch) record is repaired, not accepted', () => {
  test('a record binding a different platform is treated as non-matching and repaired', async () => {
    const stalePlatformRecord: DeliveryRecordReadState = {
      status: 'present',
      record: {
        targetVersion: T,
        canonicalPayloadSha256: PAYLOAD_DIGEST,
        channel: CHANNEL,
        deliveryId: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
        platformTriple: 'linux-x64', // differs from the pinned darwin-arm64
      },
    };
    const { seams, log } = makeSeams({ readDeliveryRecord: () => stalePlatformRecord, installedGeneration: T });
    const outcome = await repairMissingDelivery(PINNED, seams);
    expect(outcome.kind).toBe('published');
    // A mismatch is NOT a fast-path hit: the download ran.
    expect(log.some((entry) => entry.startsWith('downloadAndVerify'))).toBe(true);
  });
});
