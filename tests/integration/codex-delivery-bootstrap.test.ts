/**
 * Group D integration proof: the same-version delivery repair publishes ONE
 * authenticated record through the REAL deep delivery store, round-trips the full
 * attestation tuple back through the store's own parser, and is idempotent on a
 * rerun. Every network/attestation seam is STUBBED — this suite runs with no
 * `codex` binary and no network, so it is CI-portable by construction.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DeliveryRepairSeams,
  type InstalledProof,
  type ReobservedTarget,
  repairMissingDelivery,
} from '../../src/genie-commands/codex-delivery-repair.js';
import {
  observeCodexActivation,
  openCodexActivationStore,
  parseReleaseVersion,
  scanPhysicalTree,
} from '../../src/lib/codex-activation.js';
import type { DeliveryRecordReadState } from '../../src/lib/codex-host-observation.js';
import { acquireLifecycleLease } from '../../src/lib/codex-lifecycle-lease.js';

const T = '5.260722.11';
const PLATFORM = 'linux-x64';
const CHANNEL = 'dev';
const MANIFEST_DIGEST = 'c'.repeat(64);
const ARTIFACT_DIGEST = 'd'.repeat(64);
const BINARY_DIGEST = 'b'.repeat(64);

let genieHome: string;

beforeEach(() => {
  genieHome = mkdtempSync(join(tmpdir(), 'genie-delivery-bootstrap-'));
  // Minimal canonical payload the store's observation can scan: VERSION + plugin tree.
  writeFileSync(join(genieHome, 'VERSION'), `${T}\n`);
  mkdirSync(join(genieHome, 'plugins', 'genie'), { recursive: true });
  writeFileSync(join(genieHome, 'plugins', 'genie', 'plugin.json'), '{"name":"genie"}\n');
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
    binarySha256: BINARY_DIGEST,
    deliveryRoot: genieHome,
  };
}

/** Read the on-disk delivery record via the store's own observation (real parser round-trip). */
function readRecordReadState(): DeliveryRecordReadState {
  const fact = observeCodexActivation({ genieHome, command: null }).delivery;
  if (fact.status === 'present') return { status: 'present', record: fact.record };
  if (fact.status === 'invalid') return { status: 'invalid', detail: fact.detail };
  return { status: 'absent' };
}

interface SeamConfig {
  installedGeneration: string | null;
  fetchManifest?: () => Promise<{ version: string; manifestSha256: string } | null>;
}

/** Real store + real lease; stubbed network/attestation. The lease MUST be released by the caller. */
function makeRealStoreSeams(config: SeamConfig): { seams: DeliveryRepairSeams; release: () => void } {
  const lease = acquireLifecycleLease('update-delivery', { genieHome });
  if (!lease.ok) throw new Error('could not acquire the update-delivery lease in the fixture');
  const reobserve = (): ReobservedTarget => ({
    installedGeneration: config.installedGeneration,
    canonicalVersion: T,
    canonicalPayloadSha256: canonicalPayloadDigest(),
  });
  const seams: DeliveryRepairSeams = {
    readDeliveryRecord: readRecordReadState,
    observeInstalled: installedProof,
    fetchManifest: config.fetchManifest ?? (async () => ({ version: T, manifestSha256: MANIFEST_DIGEST })),
    downloadAndVerify: async () => '/stub/tarball.tar.gz', // no network
    hashArtifact: () => ARTIFACT_DIGEST,
    proveCandidate: async () => ({
      version: T,
      pluginTreeSha256: canonicalPayloadDigest(),
      binarySha256: BINARY_DIGEST,
    }),
    reobserve,
    store: openCodexActivationStore({ genieHome }),
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
          platformTriple: PLATFORM,
          releaseTag: `v${T}`,
          releaseName: `genie-${T}-${PLATFORM}.tar.gz`,
        },
        seams,
      );
      expect(outcome.kind).toBe('published');
      if (outcome.kind === 'published') expect(outcome.handoff).toBe('activation-pending');
    } finally {
      release();
    }
    // The record is now on disk and parses through the store's OWN parser (extended schema round-trip).
    const readState = readRecordReadState();
    expect(readState.status).toBe('present');
    if (readState.status === 'present') {
      expect(readState.record.targetVersion).toBe(T);
      expect(readState.record.artifactSha256).toBe(ARTIFACT_DIGEST);
      expect(readState.record.releaseManifestSha256).toBe(MANIFEST_DIGEST);
      expect(readState.record.platformTriple).toBe(PLATFORM);
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
          platformTriple: PLATFORM,
          releaseTag: `v${T}`,
          releaseName: `genie-${T}-${PLATFORM}.tar.gz`,
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
          platformTriple: PLATFORM,
          releaseTag: `v${T}`,
          releaseName: `genie-${T}-${PLATFORM}.tar.gz`,
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
      fetchManifest: async () => ({ version: '5.260722.12', manifestSha256: MANIFEST_DIGEST }),
    });
    try {
      const outcome = await repairMissingDelivery(
        {
          channel: CHANNEL,
          targetVersion: T,
          platformTriple: PLATFORM,
          releaseTag: `v${T}`,
          releaseName: `genie-${T}-${PLATFORM}.tar.gz`,
        },
        seams,
      );
      expect(outcome.kind).toBe('channel-advanced');
    } finally {
      release();
    }
    // No stale record was minted.
    expect(readRecordReadState().status).toBe('absent');
  });

  test('a tampered persisted platform is treated as non-matching and republished', async () => {
    // Publish a good record first.
    const first = makeRealStoreSeams({ installedGeneration: T });
    try {
      await repairMissingDelivery(
        {
          channel: CHANNEL,
          targetVersion: T,
          platformTriple: PLATFORM,
          releaseTag: `v${T}`,
          releaseName: `genie-${T}-${PLATFORM}.tar.gz`,
        },
        first.seams,
      );
    } finally {
      first.release();
    }
    // Repair for a DIFFERENT platform tuple: the persisted record no longer matches, so it republishes.
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
          platformTriple: 'darwin-arm64',
          releaseTag: `v${T}`,
          releaseName: `genie-${T}-darwin-arm64.tar.gz`,
        },
        second.seams,
      );
      expect(outcome.kind).toBe('published');
      expect(downloaded).toBe(true); // the non-match forced a real download, not the fast path
    } finally {
      second.release();
    }
    const readState = readRecordReadState();
    expect(readState.status).toBe('present');
    if (readState.status === 'present') expect(readState.record.platformTriple).toBe('darwin-arm64');
  });
});
