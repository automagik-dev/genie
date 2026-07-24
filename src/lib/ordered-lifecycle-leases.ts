import type { LifecycleLease } from './agent-sync.js';
import type { HeldLifecycleLease, LifecycleLeaseBusy, LifecycleLeaseResult } from './codex-lifecycle-lease.js';

export interface ReleasableLifecycleLease {
  release(): void;
}

export type OrderedLifecycleLeaseAcquisition =
  | {
      ok: true;
      agentSyncLease: LifecycleLease;
      codexLease: HeldLifecycleLease;
    }
  | {
      ok: false;
      busy: 'agent-sync';
      detail: string;
    }
  | {
      ok: false;
      busy: 'codex';
      refusal: LifecycleLeaseBusy;
    };

export type HeldOrderedLifecycleLeases = Extract<OrderedLifecycleLeaseAcquisition, { ok: true }>;

/**
 * Acquire the process-wide agent-sync lease before the Codex lifecycle lease.
 * A Codex loser releases the already-held outer lease before returning busy.
 */
export function acquireOrderedLifecycleLeases(
  acquireAgentSync: () => LifecycleLease | { skipped: string },
  acquireCodex: () => LifecycleLeaseResult,
): OrderedLifecycleLeaseAcquisition {
  const agentSyncLease = acquireAgentSync();
  if ('skipped' in agentSyncLease) {
    return { ok: false, busy: 'agent-sync', detail: agentSyncLease.skipped };
  }

  let codexLease: LifecycleLeaseResult;
  try {
    codexLease = acquireCodex();
  } catch (acquisitionError) {
    releaseAfterFailedAcquisition(acquisitionError, agentSyncLease);
  }
  if (!codexLease.ok) {
    releaseOrderedLifecycleLeases(null, agentSyncLease);
    return { ok: false, busy: 'codex', refusal: codexLease };
  }
  return { ok: true, agentSyncLease, codexLease };
}

/**
 * Release in exact reverse acquisition order. Both releases are attempted;
 * one failure is preserved and two are aggregated inner-first.
 */
export function releaseOrderedLifecycleLeases(
  codexLease: ReleasableLifecycleLease | null,
  agentSyncLease: ReleasableLifecycleLease,
): void {
  let codexReleaseFailed = false;
  let codexReleaseError: unknown;
  try {
    codexLease?.release();
  } catch (error) {
    codexReleaseFailed = true;
    codexReleaseError = error;
  }

  let agentSyncReleaseFailed = false;
  let agentSyncReleaseError: unknown;
  try {
    agentSyncLease.release();
  } catch (error) {
    agentSyncReleaseFailed = true;
    agentSyncReleaseError = error;
  }

  if (codexReleaseFailed && agentSyncReleaseFailed) {
    throw new AggregateError(
      [codexReleaseError, agentSyncReleaseError],
      'Codex and agent-sync lifecycle lease releases both failed',
    );
  }
  if (codexReleaseFailed) throw codexReleaseError;
  if (agentSyncReleaseFailed) throw agentSyncReleaseError;
}

function releaseAfterFailedAcquisition(acquisitionError: unknown, agentSyncLease: ReleasableLifecycleLease): never {
  try {
    agentSyncLease.release();
  } catch (releaseError) {
    throw new AggregateError(
      [acquisitionError, releaseError],
      'Codex lifecycle lease acquisition and agent-sync lifecycle lease release both failed',
    );
  }
  throw acquisitionError;
}
