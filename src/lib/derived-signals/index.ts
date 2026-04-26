/**
 * Derived-signal rule engine.
 *
 * Subscribes to the audit stream, dispatches each event to every rule,
 * and writes detected signals back to `audit_events` with
 * `entity_type='derived_signal'`. `genie status` reads from the same
 * table — one storage surface, one query path, no new infrastructure.
 *
 * Per Decision #6: this is a distinct subscriber, NOT folded into the
 * reconciler. The reconciler is the emitter; the gap that this wish
 * closes is the SUBSCRIBER. Folding back collapses to the broken
 * status-quo where `session.reconciled` screamed into a closet.
 */

import { type AuditEventRow, followAuditEvents, queryAuditEvents, recordAuditEvent } from '../audit.js';
import { getExecutor } from '../executor-registry.js';
import { LostAnchorDetector } from './lost-anchor.js';
import { detectPartitionMissing } from './partition-missing.js';
import { detectRecoveryAnchorAtRisk } from './recovery-anchor.js';
import type { DerivedSignal, DerivedSignalType } from './types.js';
import { ZombieStormDetector } from './zombie-storm.js';

export { detectPartitionMissing, detectRecoveryAnchorAtRisk, LostAnchorDetector, ZombieStormDetector };
export type { DerivedSignal, DerivedSignalType } from './types.js';
export { SIGNAL_DRILLDOWN, SIGNAL_SEVERITY } from './types.js';

/**
 * Persist a derived signal as an audit event. `entity_type='derived_signal'`
 * keeps the storage path uniform with every other audit row; the existing
 * follow + query infrastructure stays unchanged.
 *
 * Best-effort — never throws. Consumer surfaces (`genie status`) read with
 * the same audit query, so a write failure shows up as "no signal" not
 * as a crash.
 */
export async function recordDerivedSignal(signal: DerivedSignal): Promise<void> {
  await recordAuditEvent('derived_signal', signal.subject, signal.type, 'derived-signals', {
    severity: signal.severity,
    triggered_at: signal.triggeredAt,
    ...signal.details,
  });
}

/**
 * Active derived signals from the last `windowMs` (default 1h). Returns
 * the most recent one per (type, subject) pair so a chronic
 * `recovery_anchor_at_risk` for one executor renders once, not once per
 * audit row.
 */
export async function listActiveDerivedSignals(windowMs = 60 * 60 * 1000): Promise<DerivedSignal[]> {
  const sinceMs = Date.now() - windowMs;
  const since = new Date(sinceMs).toISOString();
  const rows = await queryAuditEvents({ entity: 'derived_signal', since, limit: 200 });

  // Most-recent-per-(type,subject) dedup — `queryAuditEvents` returns DESC,
  // so the first hit wins.
  const seen = new Set<string>();
  const out: DerivedSignal[] = [];
  for (const row of rows) {
    if (row.entity_type !== 'derived_signal') continue;
    const key = `${row.event_type}::${row.entity_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const details = row.details ?? {};
    const severity = (details.severity as DerivedSignal['severity']) ?? 'warn';
    const triggeredAt = (details.triggered_at as string) ?? row.created_at;
    out.push({
      type: row.event_type as DerivedSignalType,
      subject: row.entity_id,
      severity,
      details,
      triggeredAt,
    });
  }
  return out;
}

interface EngineHandle {
  stop: () => Promise<void>;
}

/**
 * Start the rule engine: subscribe to audit events, run every rule on
 * each row, persist any detected signals.
 *
 * Resilient to single-rule failures — a bad row in one detector cannot
 * wedge the others. The subscriber itself uses `followAuditEvents`,
 * which has its own LISTEN/NOTIFY + 2s safety-net poll.
 */
export async function startDerivedSignalsEngine(): Promise<EngineHandle> {
  const lost = new LostAnchorDetector();
  const zombie = new ZombieStormDetector();

  const handle = await followAuditEvents({}, (row: AuditEventRow) => {
    void dispatch(row, { lost, zombie });
  });

  return {
    stop: async () => {
      await handle.stop();
    },
  };
}

interface Dispatchers {
  lost: LostAnchorDetector;
  zombie: ZombieStormDetector;
}

/**
 * Run every rule against one audit row and persist matches. Exported for
 * direct invocation by tests that prefer to feed events synchronously.
 */
export async function dispatch(row: AuditEventRow, deps: Dispatchers): Promise<DerivedSignal[]> {
  const signals: DerivedSignal[] = [];

  // Recovery anchor: needs an executor lookup (async).
  try {
    const sig = await detectRecoveryAnchorAtRisk(row, { getExecutor });
    if (sig) signals.push(sig);
  } catch {
    /* one bad row can't wedge the engine */
  }

  // Lost anchor: in-memory ring buffer, sync.
  try {
    const sig = deps.lost.ingest(row);
    if (sig) signals.push(sig);
  } catch {
    /* ignore */
  }

  // Zombie storm: same shape as lost anchor.
  try {
    const sig = deps.zombie.ingest(row);
    if (sig) signals.push(sig);
  } catch {
    /* ignore */
  }

  for (const sig of signals) {
    await recordDerivedSignal(sig).catch(() => {});
  }
  return signals;
}
