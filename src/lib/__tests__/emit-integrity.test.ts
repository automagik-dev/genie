/**
 * emit-integrity.test.ts — sentinel guard against process-global mocks of
 * `src/lib/emit.ts`.
 *
 * Why this exists:
 *   Bun's `mock.module(...)` is process-global and cannot be undone; once a
 *   test file replaces `emit.js` with a stub, every later test in the same
 *   worker sees the stub. Earlier iterations of the Observability B1 / Group 2
 *   scheduler tests did exactly that and silently broke six pentest-
 *   observability assertions that depend on the real emit state machine
 *   (schema.violation counters, queue enqueue path, spill-to-disk, and row
 *   writes into `genie_runtime_events`).
 *
 * What this test asserts:
 *   1. `emit.js` exposes the test-only hooks (`__resetEmitForTests`,
 *      `getEmitStats`, etc.) — a stub that returned `{ emitEvent: () => {} }`
 *      would not have these and the import itself would fail typecheck.
 *   2. `emitEvent` actually mutates the real queue. A registered event type
 *      increments `stats.enqueued`; a no-op stub would leave it at 0.
 *      (This mirrors the behavior the pentest-observability suite depends
 *      on at `test/pentest/observability/forge-event.test.ts:59`.)
 *
 * How to read a failure here:
 *   If this test fails, somebody added `mock.module('.../emit.js', ...)` in a
 *   test file that runs before this one. Replace the module mock with a
 *   dependency-injected sink (see `DetectorEmitFn` on
 *   `src/serve/detector-scheduler.ts` for the canonical pattern).
 */

import { describe, expect, test } from 'bun:test';
import { __resetEmitForTests, emitEvent, getEmitStats } from '../emit.js';

describe('emit-integrity sentinel', () => {
  test('emit.js exposes the real test hooks (not a stub)', () => {
    expect(typeof __resetEmitForTests).toBe('function');
    expect(typeof getEmitStats).toBe('function');
    expect(typeof emitEvent).toBe('function');
  });

  test('emitEvent mutates real stats — a no-op stub would not', () => {
    __resetEmitForTests();
    const before = getEmitStats();
    expect(before.enqueued).toBe(0);

    // Unregistered types route into the schema.violation meta event which
    // the real emitter enqueues. A module-level stub would swallow the call
    // and leave `enqueued` at 0. (Same signal the pentest forge-event suite
    // uses — see test/pentest/observability/forge-event.test.ts:59.)
    emitEvent('emit-integrity-sentinel.__unregistered__', { probe: true }, { severity: 'warn' });

    const after = getEmitStats();
    expect(after.enqueued).toBeGreaterThanOrEqual(1);
  });
});
