/**
 * Group D — immutable same-version delivery repair.
 *
 * A machine can hold the delivered generation T with NO readable authenticated
 * delivery record: `install.sh`/an interrupted convergence left the binary at T
 * but never published the record, so setup exits `delivery-incomplete` and an
 * already-current `genie update` used to return before repairing it. This module
 * lets update/install publish that MISSING record EXACTLY ONCE for the installed
 * target, without performing activation and without redefining the target from a
 * moving channel.
 *
 * The hazard this closes (Decision 10): installed bytes cannot attest to
 * themselves. So the repair does NOT relabel local bytes — it re-fetches the
 * exact signed artifact and proves it reproduces the installed bytes:
 *
 *   1. Pin channel + immutable target version/platform + release tag/name +
 *      fetched release-manifest bytes/digest BEFORE any asset download. The
 *      manifest is NOT a source of the artifact digest.
 *   2. Download the exact named asset, compute its SHA-256 AFTER download, and
 *      authenticate that digest through the existing GitHub attestation/cosign
 *      trust anchors (the injected `downloadAndVerify` rejects on any failure).
 *   3. Extract privately and prove the candidate VERSION / binary / plugin tree
 *      against the canonical installed bytes.
 *   4. Recheck the pinned channel under the already-held lifecycle lease. A
 *      channel advance routes to ordinary upgrade and mints NO record for stale
 *      bytes; otherwise reobserve and publish once through the existing deep
 *      delivery store, persisting the computed authenticated digest.
 *
 * A no-network fast path returns `already-matching` when a record already binds
 * the locally-known pinned tuple, so a repeated repair neither downloads nor
 * republishes. EVERY verification/lease/reobservation failure returns before the
 * single publish, so all delivery/journal/plugin/cache/config/role state is left
 * unchanged with `deliveryComplete: false`. Publishing writes only the delivery
 * record: it preserves the old registered generation and performs no
 * activation-owned prompt, journal, enabled-state, plugin, or role mutation.
 */

// Group B's contract, consumed (not reimplemented) via the stable executor facade
// for the assessment and directly from the leaf module for its record/expectation types.
import { assessAuthenticatedDelivery } from '../lib/codex-activation-executor.js';
import type { CodexActivationStore, DeliveryAttestationBinding, DeliveryRecord } from '../lib/codex-activation.js';
import type { ActivationDeliveryExpectation, DeliveryRecordReadState } from '../lib/codex-host-observation.js';
import type { HeldLifecycleLease } from '../lib/codex-lifecycle-lease.js';
import { classifyCodexDelivery } from './codex-delivery.js';

/** The immutable target pinned before any download; every field is locally known at pin time. */
export interface RepairPinnedTarget {
  channel: string;
  /** The installed/canonical VERSION being repaired (never a moving-channel value). */
  targetVersion: string;
  /** `process.platform-process.arch` (e.g. `linux-x64`, `darwin-arm64`). */
  platformTriple: string;
  /** Release tag, e.g. `v5.260722.11`. */
  releaseTag: string;
  /** Exact named asset, e.g. `genie-5.260722.11-darwin-arm64.tar.gz`. */
  releaseName: string;
}

/** The fetched release manifest, reduced to the fields the repair pins/rechecks. */
export interface PinnedManifest {
  /** The channel's resolved target version at fetch time. */
  version: string;
  /** SHA-256 of the fetched manifest bytes (NOT an artifact digest source). */
  manifestSha256: string;
}

/** What a freshly extracted candidate tarball proves about itself. */
export interface CandidateProof {
  version: string;
  pluginTreeSha256: string;
  binarySha256: string;
}

/** The canonical installed bytes the candidate is proven against — all locally computed. */
export interface InstalledProof {
  version: string;
  /** The canonical installed plugin-payload digest (equals a matching record's `canonicalPayloadSha256`). */
  pluginTreeSha256: string;
  binarySha256: string;
  deliveryRoot: string;
}

/** Re-observed reality immediately before the single publish. */
export interface ReobservedTarget {
  /** Installed plugin generation N from a live query (null = absent registration). */
  installedGeneration: string | null;
  canonicalVersion: string;
  canonicalPayloadSha256: string;
}

/** Injected I/O seams so the orchestrator is pure of network/codex/home coupling in tests. */
export interface DeliveryRepairSeams {
  /** Current on-disk delivery record read-state (Group B assessment input). Local, no network. */
  readDeliveryRecord(): DeliveryRecordReadState;
  /** The canonical installed bytes — all locally computed; used for the fast path AND candidate proof. */
  observeInstalled(): InstalledProof;
  /** Fetch the pinned manifest for the channel (pre-download pin AND under-lease recheck). null = unavailable. */
  fetchManifest(channel: string): Promise<PinnedManifest | null>;
  /** Download + attestation-verify the exact named asset; resolves to the local path, rejects on any verify failure. */
  downloadAndVerify(target: RepairPinnedTarget): Promise<string>;
  /** SHA-256 of the downloaded artifact, computed AFTER download. */
  hashArtifact(tarballPath: string): string;
  /** Extract privately and prove the candidate tree; rejects on unsafe extraction. */
  proveCandidate(tarballPath: string): Promise<CandidateProof>;
  /** Re-observe the installed generation + canonical digest immediately before publish. null = unobservable. */
  reobserve(): ReobservedTarget | null;
  /** The deep delivery store, opened by the caller under the held lease. */
  store: CodexActivationStore;
  /** The held lifecycle lease (parent-owned; the repair never acquires its own). */
  lease: HeldLifecycleLease;
  now?: () => Date;
  deliveryId?: string;
}

/** After a successful publish, whether setup will find the target current or still pending activation. */
export type RepairHandoff = 'activation-pending' | 'current';

export type RepairFailureStage =
  | 'manifest-pin'
  | 'download-verify'
  | 'artifact-digest'
  | 'extract-prove'
  | 'candidate-version'
  | 'candidate-payload'
  | 'candidate-binary'
  | 'channel-recheck'
  | 'reobserve'
  | 'publish';

export type DeliveryRepairOutcome =
  | { kind: 'already-matching' }
  | { kind: 'published'; record: DeliveryRecord; handoff: RepairHandoff; artifactSha256: string }
  | { kind: 'channel-advanced'; from: string; to: string }
  | { kind: 'failed'; stage: RepairFailureStage; detail: string; deliveryComplete: false };

/**
 * Build the LOCAL matching expectation — every field is known without a network
 * round-trip, so the fast path can prove a record `matching` and skip the
 * download entirely. The manifest and artifact digests are deliberately NOT bound
 * here: they were authenticated at publish time and require the network to
 * recompute, which would defeat the no-network fast path.
 */
export function buildLocalRepairExpectation(
  pinned: RepairPinnedTarget,
  installed: InstalledProof,
): ActivationDeliveryExpectation {
  return {
    targetVersion: pinned.targetVersion,
    canonicalPayloadSha256: installed.pluginTreeSha256,
    channel: pinned.channel,
    platformTriple: pinned.platformTriple,
    releaseTag: pinned.releaseTag,
    releaseName: pinned.releaseName,
    installedBinarySha256: installed.binarySha256,
    deliveryRoot: installed.deliveryRoot,
  };
}

/**
 * Repair a missing/non-matching delivery record for the installed target exactly
 * once. Returns `already-matching` (no network) when a record already binds the
 * local tuple, `channel-advanced` when the pinned channel moved (route to ordinary
 * upgrade), `published` on the one successful publication, or `failed` with every
 * durable state left unchanged.
 */
export async function repairMissingDelivery(
  pinned: RepairPinnedTarget,
  seams: DeliveryRepairSeams,
): Promise<DeliveryRepairOutcome> {
  const installed = seams.observeInstalled();
  // No-network fast path: an already-bound record needs no download or publish.
  const expectation = buildLocalRepairExpectation(pinned, installed);
  if (assessAuthenticatedDelivery(seams.readDeliveryRecord(), expectation) === 'matching') {
    return { kind: 'already-matching' };
  }

  // Pin the manifest BEFORE any asset download; the manifest is not the artifact digest.
  const pinnedManifest = await seams.fetchManifest(pinned.channel);
  if (pinnedManifest === null) {
    return fail('manifest-pin', 'release manifest unavailable; cannot pin the repair target');
  }
  const preAdvance = channelAdvance(pinnedManifest.version, pinned.targetVersion);
  if (preAdvance !== null) return preAdvance;

  const verified = await downloadAndProve(pinned, installed, seams);
  if (verified.kind !== 'ok') return verified.outcome;

  // Recheck the pinned channel under the held lease immediately before publication.
  const recheck = await seams.fetchManifest(pinned.channel);
  if (recheck === null) return fail('channel-recheck', 'release manifest unavailable at the under-lease recheck');
  const advance = channelAdvance(recheck.version, pinned.targetVersion);
  if (advance !== null) return advance;
  // Same version but different manifest bytes is manifest tampering — fail closed.
  if (recheck.manifestSha256 !== pinnedManifest.manifestSha256) {
    return fail('channel-recheck', 'release manifest bytes changed under the lease without a version advance');
  }

  return publishRepair(pinned, installed, pinnedManifest, verified, seams);
}

interface VerifiedCandidate {
  kind: 'ok';
  artifactSha256: string;
  candidate: CandidateProof;
}

/** Download → hash-after → extract/prove → prove-against-installed. Any failure returns before publish. */
async function downloadAndProve(
  pinned: RepairPinnedTarget,
  installed: InstalledProof,
  seams: DeliveryRepairSeams,
): Promise<VerifiedCandidate | { kind: 'fail'; outcome: DeliveryRepairOutcome }> {
  let tarballPath: string;
  try {
    tarballPath = await seams.downloadAndVerify(pinned);
  } catch (error) {
    return { kind: 'fail', outcome: fail('download-verify', errorText(error)) };
  }
  let artifactSha256: string;
  try {
    artifactSha256 = seams.hashArtifact(tarballPath);
  } catch (error) {
    return { kind: 'fail', outcome: fail('artifact-digest', errorText(error)) };
  }
  let candidate: CandidateProof;
  try {
    candidate = await seams.proveCandidate(tarballPath);
  } catch (error) {
    return { kind: 'fail', outcome: fail('extract-prove', errorText(error)) };
  }
  const mismatch = proveCandidateAgainstInstalled(candidate, installed, pinned);
  if (mismatch !== null) return { kind: 'fail', outcome: mismatch };
  return { kind: 'ok', artifactSha256, candidate };
}

/** The candidate must reproduce the installed target exactly: version, payload tree, and binary. */
function proveCandidateAgainstInstalled(
  candidate: CandidateProof,
  installed: InstalledProof,
  pinned: RepairPinnedTarget,
): DeliveryRepairOutcome | null {
  if (candidate.version !== pinned.targetVersion || candidate.version !== installed.version) {
    return fail('candidate-version', `candidate version ${candidate.version} differs from installed target`);
  }
  if (candidate.pluginTreeSha256 !== installed.pluginTreeSha256) {
    return fail('candidate-payload', 'candidate plugin tree differs from the canonical installed payload');
  }
  if (candidate.binarySha256 !== installed.binarySha256) {
    return fail('candidate-binary', 'candidate binary differs from the installed binary');
  }
  return null;
}

/** Reobserve, then publish the single authenticated record; N is preserved (no plugin/cache mutation). */
function publishRepair(
  pinned: RepairPinnedTarget,
  installed: InstalledProof,
  pinnedManifest: PinnedManifest,
  verified: VerifiedCandidate,
  seams: DeliveryRepairSeams,
): DeliveryRepairOutcome {
  const reobserved = seams.reobserve();
  if (reobserved === null) return fail('reobserve', 'installed state unobservable before publication');
  if (
    reobserved.canonicalVersion !== pinned.targetVersion ||
    reobserved.canonicalPayloadSha256 !== installed.pluginTreeSha256
  ) {
    return fail('reobserve', 'installed bytes changed between candidate proof and publication');
  }
  const attestation: DeliveryAttestationBinding = {
    platformTriple: pinned.platformTriple,
    releaseTag: pinned.releaseTag,
    releaseName: pinned.releaseName,
    releaseManifestSha256: pinnedManifest.manifestSha256,
    artifactSha256: verified.artifactSha256,
    installedBinarySha256: installed.binarySha256,
    deliveryRoot: installed.deliveryRoot,
  };
  let record: DeliveryRecord;
  try {
    record = seams.store.publishDelivery(seams.lease, {
      targetVersion: pinned.targetVersion,
      canonicalPayloadSha256: reobserved.canonicalPayloadSha256,
      channel: pinned.channel,
      deliveryId: seams.deliveryId,
      now: seams.now,
      attestation,
    });
  } catch (error) {
    return fail('publish', errorText(error));
  }
  return {
    kind: 'published',
    record,
    handoff: handoffFor(reobserved.installedGeneration, pinned.targetVersion),
    artifactSha256: verified.artifactSha256,
  };
}

/**
 * A channel advance is a target-version change (someone published a newer
 * generation). It routes to ordinary upgrade and mints NO same-version record for
 * stale installed bytes. A manifest whose version equals the pinned target is not
 * an advance.
 */
function channelAdvance(manifestVersion: string, targetVersion: string): DeliveryRepairOutcome | null {
  if (manifestVersion === targetVersion) return null;
  const order = classifyCodexDelivery(targetVersion, manifestVersion);
  // Any non-equal parseable pair (upgrade or downgrade) is an advance; an
  // unparseable manifest version is fail-closed as an advance so no stale record mints.
  if (order.kind === 'current') return null;
  return { kind: 'channel-advanced', from: targetVersion, to: manifestVersion };
}

/** After publish, setup finds `current` only when the registered generation already equals the target. */
function handoffFor(installedGeneration: string | null, targetVersion: string): RepairHandoff {
  return installedGeneration === targetVersion ? 'current' : 'activation-pending';
}

function fail(stage: RepairFailureStage, detail: string): DeliveryRepairOutcome {
  return { kind: 'failed', stage, detail, deliveryComplete: false };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
