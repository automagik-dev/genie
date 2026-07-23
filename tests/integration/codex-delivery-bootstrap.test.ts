/**
 * Group D integration proof: the same-version delivery repair publishes ONE
 * authenticated record through the REAL deep delivery store, round-trips the full
 * attestation tuple back through the store's own parser, and is idempotent on a
 * rerun. Every network/attestation seam is STUBBED — this suite runs with no
 * `codex` binary and no network, so it is CI-portable by construction.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DeliveryRepairSeams,
  type InstalledProof,
  type PinnedManifest,
  type ReobservedTarget,
  repairMissingDelivery,
} from '../../src/genie-commands/codex-delivery-repair.js';
import {
  observeCodexActivation,
  openCodexActivationStore,
  parseReleaseVersion,
  scanPhysicalTree,
} from '../../src/lib/codex-activation.js';
import type { DeliveryFact } from '../../src/lib/codex-activation.js';
import { verifyDownloadedDeliveryEvidence } from '../../src/lib/codex-delivery-evidence.js';
import {
  type TestDeliveryEvidencePack,
  buildTestDeliveryEvidencePack,
} from '../../src/lib/codex-delivery-evidence.test-support.js';
import { acquireLifecycleLease } from '../../src/lib/codex-lifecycle-lease.js';

const T = '5.260722.11';
const CHANNEL = 'dev';
const ARTIFACT_DIGEST = 'd'.repeat(64);
const PLATFORM_ID =
  process.platform === 'darwin' ? 'darwin-arm64' : process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64-glibc';
const PLATFORM_TRIPLE = `${process.platform}-${process.arch}`;

let genieHome: string;

beforeEach(() => {
  genieHome = mkdtempSync(join(tmpdir(), 'genie-delivery-bootstrap-'));
  // Minimal canonical payload the store's observation can scan: VERSION + plugin tree.
  writeFileSync(join(genieHome, 'VERSION'), `${T}\n`);
  mkdirSync(join(genieHome, 'plugins', 'genie'), { recursive: true });
  writeFileSync(join(genieHome, 'plugins', 'genie', 'plugin.json'), '{"name":"genie"}\n');
  mkdirSync(join(genieHome, 'bin'), { recursive: true });
  writeFileSync(join(genieHome, 'bin', 'genie'), 'fixture installed binary\n');
});

afterEach(() => {
  rmSync(genieHome, { recursive: true, force: true });
});

/** The canonical installed plugin-tree digest the store computes for this fixture. */
function canonicalPayloadDigest(): string {
  const tree = scanPhysicalTree(join(genieHome, 'plugins', 'genie'));
  if (tree.status !== 'ok' || tree.digest === undefined)
    throw new Error(`fixture payload not scannable: ${tree.status}`);
  return tree.digest;
}

function installedProof(): InstalledProof {
  return {
    version: T,
    pluginTreeSha256: canonicalPayloadDigest(),
    binarySha256: installedBinaryDigest(),
    deliveryRoot: realpathSync(genieHome),
  };
}

function installedBinaryDigest(): string {
  return createHash('sha256')
    .update(readFileSync(join(genieHome, 'bin', 'genie')))
    .digest('hex');
}

interface SeamConfig {
  installedGeneration: string | null;
  fetchManifest?: () => Promise<PinnedManifest | null>;
}

function evidencePack(version = T): TestDeliveryEvidencePack {
  return buildTestDeliveryEvidencePack({
    descriptor: {
      version,
      channel: CHANNEL,
      platformId: PLATFORM_ID,
      platformTriple: PLATFORM_TRIPLE,
      releaseTag: `v${version}`,
      releaseName: `genie-${version}-${PLATFORM_ID}.tar.gz`,
      artifactSha256: ARTIFACT_DIGEST,
      installedBinarySha256: installedBinaryDigest(),
      canonicalPayloadSha256: canonicalPayloadDigest(),
    },
  });
}

function pinnedManifest(version = T): PinnedManifest {
  const pack = evidencePack(version);
  return {
    ...(JSON.parse(pack.manifestBytes) as Omit<PinnedManifest, 'manifestBytes' | 'manifestSha256'>),
    manifestBytes: pack.manifestBytes,
    manifestSha256: pack.descriptor.releaseManifestSha256,
  };
}

/** Read the on-disk delivery fact via the store's own parser and offline re-verifier. */
function readDeliveryFact(pack: TestDeliveryEvidencePack): DeliveryFact {
  return observeCodexActivation({
    genieHome,
    command: null,
    deliveryEvidenceVerification: pack.dependencies,
  }).delivery;
}

/** Real store + real lease; stubbed network/attestation. The lease MUST be released by the caller. */
function makeRealStoreSeams(config: SeamConfig): { seams: DeliveryRepairSeams; release: () => void } {
  const pack = evidencePack();
  const lease = acquireLifecycleLease('update-delivery', { genieHome });
  if (!lease.ok) throw new Error('could not acquire the update-delivery lease in the fixture');
  const reobserve = (): ReobservedTarget => ({
    installedGeneration: config.installedGeneration,
    canonicalVersion: T,
    canonicalPayloadSha256: canonicalPayloadDigest(),
    installedBinarySha256: installedBinaryDigest(),
    deliveryRoot: realpathSync(genieHome),
  });
  const seams: DeliveryRepairSeams = {
    readDeliveryFact: () => readDeliveryFact(pack),
    observeInstalled: installedProof,
    fetchManifest: config.fetchManifest ?? (async () => pinnedManifest()),
    downloadAndVerify: async () => ({
      tarballPath: '/stub/tarball.tar.gz',
      descriptorBytes: pack.descriptorBytes,
      bundleBytes: pack.bundleBytes,
    }),
    hashArtifact: () => ARTIFACT_DIGEST,
    proveCandidate: async () => ({
      version: T,
      pluginTreeSha256: canonicalPayloadDigest(),
      binarySha256: installedBinaryDigest(),
    }),
    verifyEvidence: (input) => verifyDownloadedDeliveryEvidence(input, pack.dependencies),
    reobserve,
    store: openCodexActivationStore({ genieHome, deliveryEvidenceVerification: pack.dependencies }),
    lease,
  };
  return { seams, release: () => lease.release() };
}

describe('codex-delivery-bootstrap — repair round-trips one authenticated record through the real store', () => {
  test('old-parent/no-record: publishes one bound record readable as present, handoff activation-pending', async () => {
    const { seams, release } = makeRealStoreSeams({ installedGeneration: '5.260722.1' });
    try {
      const outcome = await repairMissingDelivery(
        {
          channel: CHANNEL,
          targetVersion: T,
          platformTriple: PLATFORM_TRIPLE,
          platformId: PLATFORM_ID,
          releaseTag: `v${T}`,
          releaseName: `genie-${T}-${PLATFORM_ID}.tar.gz`,
        },
        seams,
      );
      expect(outcome.kind).toBe('published');
      if (outcome.kind === 'published') expect(outcome.handoff).toBe('activation-pending');
    } finally {
      release();
    }
    // The record is now on disk and parses through the store's OWN parser (extended schema round-trip).
    const readState = readDeliveryFact(evidencePack());
    expect(readState.status).toBe('present');
    if (readState.status === 'present') {
      expect(readState.record.targetVersion).toBe(T);
      expect(readState.record.artifactSha256).toBe(ARTIFACT_DIGEST);
      expect(readState.record.releaseManifestSha256).toBe(evidencePack().descriptor.releaseManifestSha256);
      expect(readState.record.platformTriple).toBe(PLATFORM_TRIPLE);
      expect(readState.record.releaseTag).toBe(`v${T}`);
      expect(parseReleaseVersion(readState.record.targetVersion)).not.toBeNull();
    }
  });

  test('rerun after publication is already-matching with no second download', async () => {
    const first = makeRealStoreSeams({ installedGeneration: T });
    try {
      await repairMissingDelivery(
        {
          channel: CHANNEL,
          targetVersion: T,
          platformTriple: PLATFORM_TRIPLE,
          platformId: PLATFORM_ID,
          releaseTag: `v${T}`,
          releaseName: `genie-${T}-${PLATFORM_ID}.tar.gz`,
        },
        first.seams,
      );
    } finally {
      first.release();
    }
    // Second run: a download seam that fails proves the fast path never reaches it.
    const second = makeRealStoreSeams({ installedGeneration: T });
    let downloadCalled = false;
    second.seams.downloadAndVerify = async () => {
      downloadCalled = true;
      throw new Error('rerun must not download');
    };
    try {
      const outcome = await repairMissingDelivery(
        {
          channel: CHANNEL,
          targetVersion: T,
          platformTriple: PLATFORM_TRIPLE,
          platformId: PLATFORM_ID,
          releaseTag: `v${T}`,
          releaseName: `genie-${T}-${PLATFORM_ID}.tar.gz`,
        },
        second.seams,
      );
      expect(outcome).toEqual({ kind: 'already-matching' });
      expect(downloadCalled).toBe(false);
    } finally {
      second.release();
    }
  });

  test('a channel advance under the lease publishes nothing and leaves the store record absent', async () => {
    const { seams, release } = makeRealStoreSeams({
      installedGeneration: '5.260722.1',
      fetchManifest: async () => pinnedManifest('5.260722.12'),
    });
    try {
      const outcome = await repairMissingDelivery(
        {
          channel: CHANNEL,
          targetVersion: T,
          platformTriple: PLATFORM_TRIPLE,
          platformId: PLATFORM_ID,
          releaseTag: `v${T}`,
          releaseName: `genie-${T}-${PLATFORM_ID}.tar.gz`,
        },
        seams,
      );
      expect(outcome.kind).toBe('channel-advanced');
    } finally {
      release();
    }
    // No stale record was minted.
    expect(readDeliveryFact(evidencePack()).status).toBe('absent');
  });

  test('a tampered persisted platform is treated as non-matching and republished', async () => {
    // Publish a good record first.
    const first = makeRealStoreSeams({ installedGeneration: T });
    try {
      await repairMissingDelivery(
        {
          channel: CHANNEL,
          targetVersion: T,
          platformTriple: PLATFORM_TRIPLE,
          platformId: PLATFORM_ID,
          releaseTag: `v${T}`,
          releaseName: `genie-${T}-${PLATFORM_ID}.tar.gz`,
        },
        first.seams,
      );
    } finally {
      first.release();
    }
    const recordPath = join(genieHome, '.codex-plugin-delivery-record.json');
    const tamperedRecord = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
    tamperedRecord.platformId = PLATFORM_ID === 'darwin-arm64' ? 'linux-arm64' : 'darwin-arm64';
    tamperedRecord.platformTriple = PLATFORM_TRIPLE === 'darwin-arm64' ? 'linux-arm64' : 'darwin-arm64';
    writeFileSync(recordPath, `${JSON.stringify(tamperedRecord, null, 2)}\n`);

    // Repair the original pinned tuple: the record/evidence mismatch forces publication.
    const second = makeRealStoreSeams({ installedGeneration: T });
    let downloaded = false;
    const originalDownload = second.seams.downloadAndVerify;
    second.seams.downloadAndVerify = async (target) => {
      downloaded = true;
      return originalDownload(target);
    };
    try {
      const outcome = await repairMissingDelivery(
        {
          channel: CHANNEL,
          targetVersion: T,
          platformTriple: PLATFORM_TRIPLE,
          platformId: PLATFORM_ID,
          releaseTag: `v${T}`,
          releaseName: `genie-${T}-${PLATFORM_ID}.tar.gz`,
        },
        second.seams,
      );
      expect(outcome.kind).toBe('published');
      expect(downloaded).toBe(true); // the non-match forced a real download, not the fast path
    } finally {
      second.release();
    }
    const readState = readDeliveryFact(evidencePack());
    expect(readState.status).toBe('present');
    if (readState.status === 'present') expect(readState.record.platformTriple).toBe(PLATFORM_TRIPLE);
  });
});
