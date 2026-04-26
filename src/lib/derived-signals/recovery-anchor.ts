/**
 * Rule: `observability.recovery_anchor_at_risk`.
 *
 * Detects the corruption fingerprint that prompted this wish:
 *   `session.reconciled` overwrote a session UUID on a terminal-state
 *   executor, destroying the anchor we needed to recover the row.
 *
 * Two fingerprints fire the same signal:
 *   1. **Legacy**: `session.reconciled` with non-null `old_session_id` ≠
 *      `new_session_id` AND the executor was/is in a terminal state. This
 *      is the original `9623de43` corruption — pre-PR-#1397 code paths.
 *   2. **Post-fix**: `session.divergence_preserved` (any payload). The
 *      hook now emits this instead of overwriting; if it fires, the
 *      operator should still see it because *something* tried to write a
 *      diverged session UUID at terminal state. Same root cause class,
 *      different code path.
 */

import type { AuditEventRow } from '../audit.js';
import type { Executor, ExecutorState } from '../executor-types.js';
import type { DerivedSignal } from './types.js';
import { SIGNAL_SEVERITY } from './types.js';

/**
 * Mirrors `session-sync.ts::TERMINAL_EXECUTOR_STATES`. Kept in sync by the
 * invariant test (Group 6) — both definitions must agree on the closed set
 * `{done, error, terminated}` so the rule fires on the same fingerprint
 * the producer is guarding against.
 */
const TERMINAL_EXECUTOR_STATES: ReadonlySet<ExecutorState> = new Set<ExecutorState>(['done', 'error', 'terminated']);

interface RecoveryAnchorDeps {
  /**
   * Resolve an executor by id so we can check if it was in a terminal
   * state at audit-write time. The audit row carries `entity_id =
   * executor_id` so this is a single lookup.
   */
  getExecutor: (executorId: string) => Promise<Executor | null>;
}

/**
 * Inspect a single audit event. Returns a derived signal if the
 * fingerprint matches, otherwise null. Pure function modulo the dep.
 */
export async function detectRecoveryAnchorAtRisk(
  row: AuditEventRow,
  deps: RecoveryAnchorDeps,
): Promise<DerivedSignal | null> {
  if (row.entity_type !== 'executor') return null;

  if (row.event_type === 'session.divergence_preserved') {
    // Post-fix code path — the hook caught the divergence and refused to
    // overwrite. Emit the signal anyway so the operator sees something
    // tried to write a bad UUID at terminal state.
    return {
      type: 'observability.recovery_anchor_at_risk',
      subject: row.entity_id,
      severity: SIGNAL_SEVERITY['observability.recovery_anchor_at_risk'],
      details: {
        fingerprint: 'divergence_preserved',
        stored_session_id: row.details?.stored_session_id ?? null,
        live_session_id: row.details?.live_session_id ?? null,
        executor_state: row.details?.executor_state ?? null,
      },
      triggeredAt: row.created_at,
    };
  }

  if (row.event_type !== 'session.reconciled') return null;

  // Legacy fingerprint: only fire when the reconciliation overwrote a
  // non-null prior session AND the executor was terminal at audit-write
  // time. (Skip first-capture and active rotation — both are benign.)
  const oldId = row.details?.old_session_id;
  const newId = row.details?.new_session_id;
  if (oldId == null || oldId === newId) return null;

  const executor = await deps.getExecutor(row.entity_id);
  if (!executor) return null;
  if (!TERMINAL_EXECUTOR_STATES.has(executor.state)) return null;

  return {
    type: 'observability.recovery_anchor_at_risk',
    subject: row.entity_id,
    severity: SIGNAL_SEVERITY['observability.recovery_anchor_at_risk'],
    details: {
      fingerprint: 'legacy_reconciled',
      old_session_id: oldId,
      new_session_id: newId,
      executor_state: executor.state,
    },
    triggeredAt: row.created_at,
  };
}
