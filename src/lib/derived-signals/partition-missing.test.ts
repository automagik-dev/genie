/**
 * Tests for `detectPartitionMissing`.
 *
 * Pure function over `collectObservabilityHealth()` — only the `'fail'`
 * branch fires. Other states (`'ok'`, `'warn'`, `'unknown'`) return null;
 * `'unknown'` is a different problem (PG offline) and the engine handles
 * connection failures separately.
 */

import { describe, expect, test } from 'bun:test';
import type { ObservabilityHealthReport, PartitionHealth } from '../../genie-commands/observability-health.js';
import { detectPartitionMissing } from './partition-missing.js';

function fakeReport(partitionHealth: PartitionHealth): ObservabilityHealthReport {
  return {
    partition_health: partitionHealth,
    partition_count: partitionHealth === 'ok' ? 1 : 0,
    next_rotation_at: '2026-04-26T00:00:00.000Z',
    oldest_partition: 'genie_runtime_events_p20260425',
    newest_partition: 'genie_runtime_events_p20260425',
    wide_emit_flag: 'off',
    watchdog: 'ok',
    watcher_metrics: 'ok',
    watcher_metric_details: [],
    spill_journal: 'empty',
    spill_path: '/tmp/spill.jsonl',
  };
}

describe('detectPartitionMissing', () => {
  test('partition_health=ok → no signal', async () => {
    const sig = await detectPartitionMissing({ collect: async () => fakeReport('ok') });
    expect(sig).toBeNull();
  });

  test('partition_health=warn → no signal (warn is rotation-soon, not missing)', async () => {
    const sig = await detectPartitionMissing({ collect: async () => fakeReport('warn') });
    expect(sig).toBeNull();
  });

  test('partition_health=unknown → no signal (PG offline is a different signal)', async () => {
    const sig = await detectPartitionMissing({ collect: async () => fakeReport('unknown') });
    expect(sig).toBeNull();
  });

  test('partition_health=fail → fires critical signal', async () => {
    const sig = await detectPartitionMissing({ collect: async () => fakeReport('fail') });
    expect(sig?.type).toBe('observability.partition.missing');
    expect(sig?.subject).toBe('global');
    expect(sig?.severity).toBe('critical');
    expect(sig?.details.partition_count).toBe(0);
  });

  test('triggeredAt uses the now() injection', async () => {
    const fixedNow = new Date('2026-05-01T00:00:00.000Z');
    const sig = await detectPartitionMissing({
      collect: async () => fakeReport('fail'),
      now: () => fixedNow,
    });
    expect(sig?.triggeredAt).toBe('2026-05-01T00:00:00.000Z');
  });
});
