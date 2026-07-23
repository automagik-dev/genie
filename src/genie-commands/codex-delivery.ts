/**
 * Group C delivery seam — the ONE gate every noninteractive Codex delivery path
 * (parent publish + `--post-delivery-converge` child converge) shares, so
 * delivery NEVER advances the Codex plugin cache.
 *
 * The 2026-07-11 incident came from delivery invoking `codex plugin add` on a
 * stale installed generation, pruning the versioned cache a live task still
 * pointed at. This module closes that with one classifier keyed purely on
 * observed reality — the installed generation N (from a live `codex plugin list`)
 * versus the delivered target T — plus one publish helper over A's
 * `publishDelivery`. It holds no permit, mints no assertion, begins no
 * activation, consumes/tombstones no receipt, advances no journal, retains no
 * delivery root, and runs no plugin/cache mutator: it only classifies and
 * publishes attested facts.
 *
 * The parent (which holds the lifecycle lease) publishes; the
 * `--post-delivery-converge` child (which never acquires the lease) converges
 * only NON-plugin agents when the classifier says the target differs from the
 * installed generation, deferring the cache advance to the permit-gated
 * `genie setup --codex`. Both callers route through `classifyCodexDelivery`, so
 * there is exactly one gate and no divergent implementation for a bypass to hide
 * in. Facts are never manifest-trusted: T and its digest come from a physical
 * scan of the delivered tree, N from a live query.
 */

import { serializeActivationResultTrailer } from '../lib/codex-activation-executor.js';
import {
  type CodexActivationStore,
  type DeliveryRecord,
  type PublishDeliveryInput,
  compareReleaseVersions,
  parseReleaseVersion,
} from '../lib/codex-activation.js';
import {
  type VerifiedDeliveryEvidence,
  deriveDeliveryId,
  verifiedDeliveryEvidenceFacts,
} from '../lib/codex-delivery-evidence.js';
import {
  type AuthenticatedDeliveryRecord,
  type DeliveryRecordReadState,
  assessAuthenticatedDelivery,
} from '../lib/codex-host-observation.js';
import type { HeldLifecycleLease } from '../lib/codex-lifecycle-lease.js';

/** The exact operator recovery every delivered-but-action-required Codex path names. */
export const CODEX_RETIRE_RECOVERY = 'retire tasks → genie setup --codex → /hooks → new task';

/**
 * The one stable, ANSI-free, single-line JSON exit-2 result trailer (A-owned
 * serializer) every delivered-but-action-required Codex path emits so automation
 * has a machine-readable `deliveryComplete` carrier. Group D's `doctor --json`
 * carries the same facts inside `integrationSummary` instead of this line.
 */
export const CODEX_DELIVERY_RESULT_TRAILER = serializeActivationResultTrailer({
  schemaVersion: 1,
  code: 'activation-pending',
  deliveryComplete: true,
  retry: false,
  nextAction: CODEX_RETIRE_RECOVERY,
});

/**
 * The exit-2 result trailer for a lifecycle-lease loser (deliverable 9). Unlike
 * the delivery-pending trailer, `deliveryComplete` is false and `retry` is true:
 * nothing was delivered because another lifecycle command held the lease.
 */
export const CODEX_LIFECYCLE_BUSY_TRAILER = serializeActivationResultTrailer({
  schemaVersion: 1,
  code: 'codex-lifecycle-busy',
  deliveryComplete: false,
  retry: true,
  nextAction: 'another Genie lifecycle command is active; retry once it completes',
});

/** A verified binary/payload exists, but no authenticated delivery record was committed. */
export const CODEX_DELIVERY_INCOMPLETE_TRAILER = serializeActivationResultTrailer({
  schemaVersion: 1,
  code: 'delivery-incomplete',
  deliveryComplete: false,
  retry: true,
  nextAction: 'retry genie update (or genie install) to publish the authenticated delivery record',
});

/**
 * Thrown when the Codex lifecycle lease is held by another command. The caller
 * maps it to exit 2 with the `codex-lifecycle-busy` trailer and zero mutation —
 * it is raised before any binary swap or protocol write.
 */
export class CodexLifecycleBusyError extends Error {
  readonly code = 'codex-lifecycle-busy';
  constructor(readonly holderKind: string | null) {
    super(
      `codex-lifecycle-busy: another Genie lifecycle command (${holderKind ?? 'unknown'}) holds the Codex lease; refused before any mutation.`,
    );
    this.name = 'CodexLifecycleBusyError';
  }
}

export type CodexDeliveryState =
  | { kind: 'absent' }
  | { kind: 'current' }
  | { kind: 'pending'; direction: 'upgrade' | 'downgrade' }
  | { kind: 'indeterminate'; detail: string };

/**
 * The ONE Codex delivery classifier, shared by the parent (publish) and the
 * child (converge). Keyed purely on observed reality: installed generation N vs
 * delivered target T. Never manifest-trusted — the caller supplies N from a live
 * `codex plugin list` and T from the physically scanned delivered tree.
 *
 * - N absent            → `absent`  (update leaves it alone; install activates)
 * - N canonical-equal T → `current` (safe convergence, provably no cache advance)
 * - N ≠ T               → `pending` (defer the cache-advancing activation)
 * - unparseable N or T  → `indeterminate` (fail closed; never cache-advance)
 */
export function classifyCodexDelivery(installedVersion: string | null, targetVersion: string): CodexDeliveryState {
  if (installedVersion === null) return { kind: 'absent' };
  const to = parseReleaseVersion(targetVersion);
  if (to === null)
    return { kind: 'indeterminate', detail: `delivered target fails the release grammar: ${targetVersion}` };
  const from = parseReleaseVersion(installedVersion);
  if (from === null) {
    return { kind: 'indeterminate', detail: `installed version fails the release grammar: ${installedVersion}` };
  }
  const order = compareReleaseVersions(from, to);
  if (order === 0) return { kind: 'current' };
  return { kind: 'pending', direction: order > 0 ? 'downgrade' : 'upgrade' };
}

export interface CodexDeliveryFacts {
  /** The installed generation N from a live `codex plugin list` (null = absent). */
  installedVersion: string | null;
  /** Opaque proof minted only after the signed descriptor matches the downloaded candidate. */
  evidence: VerifiedDeliveryEvidence;
  /** Physical canonical root revalidated by the deep store immediately before publication. */
  deliveryRoot: string;
  /**
   * The on-disk record read-state (Group E). Lets a verified delivery whose
   * plugin generation is already `current` (e.g. install converged the plugin
   * itself) republish a STALE record: without it, a prior-generation record
   * survives the delivery and setup's Decision-9 gate refuses with `mismatch`
   * while its recovery points back at the very command that skipped publishing
   * (2026-07-23 live-QA finding). A matching record is never republished.
   */
  existingRecord?: DeliveryRecordReadState;
}

/**
 * Build the `publishDelivery` input for a pending OR absent-N delivery, or null
 * when there is nothing to publish (current/indeterminate). A downgrade binds
 * `downgradeFrom = N` so A writes the one-time downgrade receipt.
 *
 * Group E: `absent` (no installed plugin generation) publishes too. The record
 * binds the DELIVERY facts, not an activation — and setup's Decision-9 gate
 * refuses to activate a fresh host without a matching record, so a delivery
 * that skipped publication forced a second `genie update` (already-current
 * repair) before the first `genie setup --codex` could ever succeed
 * (2026-07-23 live-QA finding). Publication remains a pure fact write: no
 * journal, activation, or cache mutation.
 */
export function buildDeliveryPublication(facts: CodexDeliveryFacts): PublishDeliveryInput | null {
  const evidence = verifiedDeliveryEvidenceFacts(facts.evidence);
  const state = classifyCodexDelivery(facts.installedVersion, evidence.descriptor.version);
  if (state.kind === 'indeterminate') return null;
  if (existingDeliveryMatches(facts)) return null;
  const input: PublishDeliveryInput = {
    evidence: facts.evidence,
    deliveryRoot: facts.deliveryRoot,
  };
  if (state.kind === 'pending' && state.direction === 'downgrade' && facts.installedVersion !== null) {
    input.downgradeFrom = facts.installedVersion;
  }
  return input;
}

/**
 * A `current` generation republishes ONLY when the caller supplied the on-disk
 * record state and it fails the core binding (absent/invalid/mismatched). No
 * record state supplied → conservative no-publish (the pre-Group-E contract).
 */
function existingDeliveryMatches(facts: CodexDeliveryFacts): boolean {
  if (facts.existingRecord?.status !== 'present') return false;
  const evidence = verifiedDeliveryEvidenceFacts(facts.evidence);
  const descriptor = evidence.descriptor;
  return (
    assessAuthenticatedDelivery(facts.existingRecord, {
      targetVersion: descriptor.version,
      canonicalPayloadSha256: descriptor.canonicalPayloadSha256,
      channel: descriptor.channel,
      deliveryId: deriveDeliveryId(evidence.evidenceDigest, facts.deliveryRoot),
      evidenceDigest: evidence.evidenceDigest,
      platformId: descriptor.platformId,
      platformTriple: descriptor.platformTriple,
      releaseTag: descriptor.releaseTag,
      releaseName: descriptor.releaseName,
      releaseManifestSha256: descriptor.releaseManifestSha256,
      artifactSha256: descriptor.artifactSha256,
      installedBinarySha256: descriptor.installedBinarySha256,
      deliveryRoot: facts.deliveryRoot,
      deliveredAt: evidence.deliveredAt,
    }) === 'matching'
  );
}

export interface PublishCodexDeliveryInput extends CodexDeliveryFacts {
  /** The caller-held `update-delivery` / `install-converge` lease (parent only). */
  lease: HeldLifecycleLease;
  /** A's deep store, opened by the caller (`openCodexActivationStore`). */
  store: CodexActivationStore;
}

export type PublishedCodexDelivery =
  | {
      outcome: 'matching';
      state: CodexDeliveryState;
      published: false;
      wroteDowngradeReceipt: false;
      record: AuthenticatedDeliveryRecord;
    }
  | {
      outcome: 'published';
      state: CodexDeliveryState;
      published: true;
      wroteDowngradeReceipt: boolean;
      record: DeliveryRecord;
    }
  | {
      outcome: 'skipped';
      state: CodexDeliveryState;
      published: false;
      wroteDowngradeReceipt: false;
      record: null;
      detail: string;
    }
  | {
      outcome: 'failed';
      state: CodexDeliveryState;
      published: false;
      wroteDowngradeReceipt: false;
      record: null;
      detail: string;
    };

/**
 * Parent-side: publish attested delivery facts through A when the delivery is
 * pending (installed N ≠ delivered T). C only publishes facts here — it never
 * begins activation, consumes/tombstones a receipt, advances a journal, retains
 * a delivery root, or runs a plugin/cache mutator. B later consumes the record
 * at permit-gated setup activation.
 */
export function publishCodexDelivery(input: PublishCodexDeliveryInput): PublishedCodexDelivery {
  const descriptor = verifiedDeliveryEvidenceFacts(input.evidence).descriptor;
  const state = classifyCodexDelivery(input.installedVersion, descriptor.version);
  if (existingDeliveryMatches(input) && input.existingRecord?.status === 'present') {
    return {
      outcome: 'matching',
      state,
      published: false,
      wroteDowngradeReceipt: false,
      record: input.existingRecord.record,
    };
  }
  const publication = buildDeliveryPublication(input);
  if (publication === null) {
    return {
      outcome: 'skipped',
      state,
      published: false,
      wroteDowngradeReceipt: false,
      record: null,
      detail:
        state.kind === 'indeterminate'
          ? state.detail
          : 'delivery publication lacked a determinable non-matching record state',
    };
  }
  try {
    const record = input.store.publishDelivery(input.lease, publication);
    return {
      outcome: 'published',
      state,
      published: true,
      wroteDowngradeReceipt: publication.downgradeFrom !== undefined,
      record,
    };
  } catch (cause) {
    return {
      outcome: 'failed',
      state,
      published: false,
      wroteDowngradeReceipt: false,
      record: null,
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
