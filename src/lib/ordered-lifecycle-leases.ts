import type { LifecycleLease } from './lifecycle-lease.js';

export interface ReleasableLifecycleLease {
  release(): void;
}

export type OrderedLifecycleLeaseAcquisition =
  | {
      ok: true;
      agentSyncLease: LifecycleLease;
    }
  | {
      ok: false;
      busy: 'agent-sync';
      detail: string;
    };

export type HeldOrderedLifecycleLeases = Extract<OrderedLifecycleLeaseAcquisition, { ok: true }>;

/**
 * The one busy sentence every lifecycle path prints for an agent-sync holder.
 * It carries the acquirer's own (path-naming) detail forward.
 *
 * Three consumers: `update.ts` (no suffix), `install.ts` (no suffix), and
 * `uninstall.ts` (suffix ` No files were removed; retry once it completes.`).
 * Tests in `__tests__/update.test.ts`, `install.test.ts`, and `uninstall.test.ts`
 * assert this exact prefix — keep the output byte-identical.
 */
export function lifecycleBusyMessage(detail: string, suffix?: string): string {
  return `Another Genie lifecycle command is active: ${detail}${suffix ?? ''}`;
}

/**
 * Acquire the process-wide lifecycle lease.
 *
 * This was an ordered pair (agent-sync outer, Codex inner) while the Codex
 * plugin owned its own lease; with that subsystem retired the pair collapses to
 * the single remaining lease. The tagged shape is kept so every lifecycle
 * command keeps its one busy-projection site.
 */
export function acquireOrderedLifecycleLeases(
  acquireAgentSync: () => LifecycleLease | { skipped: string },
): OrderedLifecycleLeaseAcquisition {
  const agentSyncLease = acquireAgentSync();
  if ('skipped' in agentSyncLease) {
    return { ok: false, busy: 'agent-sync', detail: agentSyncLease.skipped };
  }
  return { ok: true, agentSyncLease };
}

/** Release the held lifecycle lease. */
export function releaseOrderedLifecycleLeases(agentSyncLease: ReleasableLifecycleLease): void {
  agentSyncLease.release();
}
