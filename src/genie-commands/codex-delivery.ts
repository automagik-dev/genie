/**
 * Group C delivery seam: the one gate every noninteractive Codex delivery path
 * flows through so delivery NEVER advances the Codex plugin cache.
 *
 * The 2026-07-11 incident came from delivery invoking `codex plugin add` on a
 * stale installed generation, pruning the versioned cache a live task still
 * pointed at. This module closes that: it observes and classifies through B's
 * stable facade (never A's private persistence, never B's executor internals),
 * and for any cache-advancing N→T state it publishes attested delivery facts
 * through A's `publishDelivery` under a caller-held lifecycle lease, converges
 * only NON-plugin agents, and returns an action-required exit-2 disposition —
 * deferring the actual cache advance to the permit-gated setup activation path.
 * Only a verified-current re-observation runs the (provably non-cache-advancing)
 * plugin convergence. This module holds no permit, mints no assertion, begins no
 * activation, consumes/tombstones no receipt, advances no journal, retains no
 * delivery root, and runs no plugin/cache mutator — it only publishes facts.
 *
 * Lease ownership stays with the caller (the normative acquisition points differ
 * per command: update/install acquire after signed download verification but
 * before the first swap or publication; the `--post-delivery-converge` child
 * never acquires — its parent holds). This keeps the seam pure and testable.
 */

import {
  buildActivationResultTrailer,
  classifyCodexActivation,
  describeState,
  projectHumanStatus,
  serializeActivationResultTrailer,
} from '../lib/codex-activation-executor.js';
import type {
  ActivationResultTrailer,
  CodexActivationSnapshot,
  CodexActivationState,
  CodexActivationStore,
  DeliveryRecord,
  HumanProjection,
} from '../lib/codex-activation.js';
import type { HeldLifecycleLease } from '../lib/codex-lifecycle-lease.js';
import type { IntegrationResult } from '../lib/runtime-integrations.js';

export type CodexDeliveryDisposition = 'current' | 'delivered' | 'broken';

export interface CodexDeliveryOutcome {
  disposition: CodexDeliveryDisposition;
  state: CodexActivationState;
  /** 0 verified-current, 2 delivered/action-required, 1 broken/indeterminate. */
  exitCode: 0 | 1 | 2;
  /** True once the binary/payload is delivered; only `current` and every action-required path are complete. */
  deliveryComplete: boolean;
  /** The delivery-record transaction id C published this run, or null when it published nothing. */
  publishedDeliveryId: string | null;
  /** True when this run wrote a downgrade receipt (explicit channel downgrade). */
  wroteDowngradeReceipt: boolean;
  /** Deterministic human output naming N/T and the recovery action. */
  human: HumanProjection;
  /** The A-owned exit-2 result trailer, already serialized (null only for exit 0). */
  resultTrailer: string | null;
  /** The safe re-converge result for a verified-current path (else null). */
  convergeResult: IntegrationResult | null;
}

export interface DeliverCodexPluginInput {
  /** Caller-acquired lifecycle lease (`update-delivery` / `install-converge`). */
  lease: HeldLifecycleLease;
  /** A's deep store, opened by the caller (`openCodexActivationStore`). */
  store: CodexActivationStore;
  /** The canonical target version being delivered (informational for the caller). */
  expectedVersion: string;
  /** Delivery channel (dev/homolog/stable/next) recorded in the published facts. */
  channel: string;
  /** Present only for an explicit cross-version channel downgrade. */
  downgradeFrom?: string;
  /** The 128-bit delivery transaction id; A mints one when omitted. */
  deliveryId?: string;
  /**
   * Safe already-current re-convergence (marketplace registration idempotency,
   * role-agent refresh, one health proof). It MUST NOT cache-advance — the
   * caller passes `convergeCodexPluginOnly`, which only runs `plugin add` when
   * installed≠target, a case this seam never routes here.
   */
  convergeCurrent: () => IntegrationResult | null;
  /**
   * Non-plugin agent convergence for a deferred (action-required) delivery —
   * role-agent TOMLs only, never a plugin/cache command. Preserves the
   * "non-plugin agent convergence" guarantee while activation is deferred.
   */
  convergeAgentsOnly: () => void;
  now?: () => Date;
}

interface PublishPlan {
  publish: boolean;
  downgrade: boolean;
  input?: { targetVersion: string; canonicalPayloadSha256: string; channel: string; downgradeFrom?: string };
}

/**
 * Gate one Codex delivery. Observes → classifies → (optionally) publishes
 * attested facts → converges the safe surface → returns a typed disposition and
 * exit code. Never advances the plugin cache and never touches activation state.
 */
export function deliverCodexPlugin(input: DeliverCodexPluginInput): CodexDeliveryOutcome {
  let snapshot = input.store.observe();
  let state = classifyCodexActivation(snapshot);

  const plan = planPublish(state, snapshot, input);
  let publishedDeliveryId: string | null = null;
  let wroteDowngradeReceipt = false;
  if (plan.publish && plan.input !== undefined) {
    const record: DeliveryRecord = input.store.publishDelivery(input.lease, {
      targetVersion: plan.input.targetVersion,
      canonicalPayloadSha256: plan.input.canonicalPayloadSha256,
      channel: plan.input.channel,
      downgradeFrom: plan.input.downgradeFrom,
      deliveryId: input.deliveryId,
      now: input.now,
    });
    publishedDeliveryId = record.deliveryId;
    wroteDowngradeReceipt = plan.downgrade;
    // Re-observe so the returned disposition reflects the newly written receipt
    // (an explicit downgrade moves installed-newer → pending-downgrade-explicit).
    snapshot = input.store.observe();
    state = classifyCodexActivation(snapshot);
  }

  const descriptor = describeState(state);
  const human = projectHumanStatus(state, snapshot);

  if (descriptor.exit === 0) {
    const convergeResult = input.convergeCurrent();
    return {
      disposition: 'current',
      state,
      exitCode: 0,
      deliveryComplete: true,
      publishedDeliveryId,
      wroteDowngradeReceipt,
      human,
      resultTrailer: null,
      convergeResult,
    };
  }

  const trailer: ActivationResultTrailer = buildActivationResultTrailer(state, true);
  if (descriptor.exit === 2) {
    // Delivered but action-required: converge only non-plugin agents and defer
    // the cache-advancing activation to external `genie setup --codex`.
    input.convergeAgentsOnly();
    return {
      disposition: 'delivered',
      state,
      exitCode: 2,
      deliveryComplete: true,
      publishedDeliveryId,
      wroteDowngradeReceipt,
      human,
      resultTrailer: serializeActivationResultTrailer(trailer),
      convergeResult: null,
    };
  }

  // exit 1 — broken/indeterminate. The binary/payload is delivered but the
  // plugin is unhealthy; never publish activation facts, never cache-advance.
  return {
    disposition: 'broken',
    state,
    exitCode: 1,
    deliveryComplete: true,
    publishedDeliveryId,
    wroteDowngradeReceipt,
    human,
    resultTrailer: serializeActivationResultTrailer(trailer),
    convergeResult: null,
  };
}

/**
 * Decide whether this delivery publishes attested facts, and which.
 *
 * - `activation-pending` (clean N→T upgrade with a valid canonical target):
 *   publish installed-delivery facts so a later setup activation can consume them.
 * - `installed-newer` WITH an explicit channel downgrade requested: publish the
 *   downgrade delivery + receipt binding `downgradeFrom > target`.
 * - Everything else (already published `pending-downgrade-explicit`, intent
 *   resumes, broken states, absent registration, implicit downgrade refusal):
 *   publish nothing. Re-publishing a still-pending delivery would mint a second
 *   transaction id, so we stay idempotent and let A own the existing record.
 */
function planPublish(
  state: CodexActivationState,
  snapshot: CodexActivationSnapshot,
  input: DeliverCodexPluginInput,
): PublishPlan {
  if (snapshot.canonical.status !== 'ok') return { publish: false, downgrade: false };
  const targetVersion = snapshot.canonical.version.canonical;
  const canonicalPayloadSha256 = snapshot.canonical.digest;

  if (state.kind === 'activation-pending') {
    return {
      publish: true,
      downgrade: false,
      input: { targetVersion, canonicalPayloadSha256, channel: input.channel },
    };
  }
  if (state.kind === 'installed-newer' && input.downgradeFrom !== undefined) {
    return {
      publish: true,
      downgrade: true,
      input: { targetVersion, canonicalPayloadSha256, channel: input.channel, downgradeFrom: input.downgradeFrom },
    };
  }
  return { publish: false, downgrade: false };
}
