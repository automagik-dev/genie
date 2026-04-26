/**
 * Rule: `observability.partition.missing`.
 *
 * The runtime-events partition state is not in the audit stream — it's
 * read from `pg_inherits` via `collectObservabilityHealth()`. This rule
 * polls the health probe and emits the signal when `partition_health
 * === 'fail'` (no partition for today, or rotation overdue).
 *
 * Polled lazily by `genie status --health`; the rule engine doesn't
 * spin a background timer because the partition state changes only on
 * day boundaries (or operator action). Pure function — easy to test.
 */

import { collectObservabilityHealth } from '../../genie-commands/observability-health.js';
import type { DerivedSignal } from './types.js';
import { SIGNAL_SEVERITY } from './types.js';

interface PartitionMissingDeps {
  collect?: typeof collectObservabilityHealth;
  now?: () => Date;
}

/**
 * Probe partition health and return a signal if it's failing. Returns
 * null when health is `'ok'`, `'warn'`, or `'unknown'` — `'unknown'`
 * means PG is unreachable, which is a different problem (the engine's
 * subscriber will catch the connection failure separately).
 */
export async function detectPartitionMissing(deps: PartitionMissingDeps = {}): Promise<DerivedSignal | null> {
  const collect = deps.collect ?? collectObservabilityHealth;
  const now = (deps.now ?? (() => new Date()))();

  const report = await collect();
  if (report.partition_health !== 'fail') return null;

  return {
    type: 'observability.partition.missing',
    subject: 'global',
    severity: SIGNAL_SEVERITY['observability.partition.missing'],
    details: {
      partition_count: report.partition_count,
      newest_partition: report.newest_partition,
      next_rotation_at: report.next_rotation_at,
    },
    triggeredAt: now.toISOString(),
  };
}
