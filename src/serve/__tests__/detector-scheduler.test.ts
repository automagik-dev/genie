/**
 * Detector scheduler — tick timing (60s ± 5s) and stub-detector emission.
 *
 * Wish: Observability B1 — rot-pattern detectors (Group 2 / Phase 0).
 *
 * Uses an injected timer primitive so tests run synchronously. Each scheduled
 * timer is captured, its delay is asserted to fall within the jitter window,
 * and it is fired manually to advance the scheduler.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { makeHelloDetector } from '../../detectors/__fixtures__/hello.js';
import type { DetectorModule } from '../../detectors/index.js';
import {
  DEFAULT_JITTER_MS,
  DEFAULT_TICK_INTERVAL_MS,
  type SchedulerHandle,
  start as startScheduler,
} from '../detector-scheduler.js';

interface CapturedEmit {
  type: string;
  payload: Record<string, unknown>;
  opts: Record<string, unknown>;
}
const captured: CapturedEmit[] = [];

/**
 * Capture sink passed to the scheduler via the `emitFn` option. Replaces a
 * previous `mock.module('../../lib/emit.js', ...)` approach — Bun's
 * `mock.module` is process-global and cannot be undone, so stubbing emit
 * that way leaked into every later test file. Dependency injection keeps
 * the stub scoped to this file. See `DetectorEmitFn` docstring in
 * `detector-scheduler.ts` for the full root-cause analysis.
 */
function captureEmit(type: string, payload: Record<string, unknown>, opts: Record<string, unknown> = {}): void {
  captured.push({ type, payload, opts });
}

interface CapturedTimer {
  delay: number;
  fn: () => void;
  handle: { readonly id: symbol };
  fired: boolean;
}

function makeManualClock(): {
  setTimeoutFn: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn: (h: unknown) => void;
  timers: CapturedTimer[];
  fireAll: () => Promise<void>;
} {
  const timers: CapturedTimer[] = [];
  return {
    setTimeoutFn(fn: () => void, ms: number): unknown {
      const handle = { id: Symbol('timer') };
      timers.push({ delay: ms, fn, handle, fired: false });
      return handle;
    },
    clearTimeoutFn(h: unknown) {
      for (const t of timers) {
        if (t.handle === h) t.fired = true;
      }
    },
    timers,
    async fireAll() {
      // Fire all un-fired timers; each firing may schedule the next.
      for (const t of timers) {
        if (t.fired) continue;
        t.fired = true;
        t.fn();
      }
      // Yield so any promises scheduled by the fired callbacks resolve.
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe('detector scheduler', () => {
  let scheduler: SchedulerHandle | null = null;

  afterEach(() => {
    if (scheduler) {
      scheduler.stop();
      scheduler = null;
    }
    captured.length = 0;
  });

  test('exported default tick interval is 60s with 5s jitter', () => {
    expect(DEFAULT_TICK_INTERVAL_MS).toBe(60_000);
    expect(DEFAULT_JITTER_MS).toBe(5_000);
  });

  test('consecutive tick delays land within 60s ± 5s', async () => {
    const clock = makeManualClock();
    const detector = makeHelloDetector({ id: 'test.scheduler.timing', alwaysFire: false });
    scheduler = startScheduler({
      tickIntervalMs: DEFAULT_TICK_INTERVAL_MS,
      jitterMs: DEFAULT_JITTER_MS,
      defaultFireBudget: 100,
      detectorSource: () => [detector as DetectorModule<unknown>],
      emitFn: captureEmit,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    // First scheduled timer exists right after start().
    expect(clock.timers.length).toBe(1);

    // Advance 5 ticks — assert each scheduled delay is in [55s, 65s].
    for (let i = 0; i < 5; i++) {
      await clock.fireAll();
    }

    expect(clock.timers.length).toBeGreaterThanOrEqual(5);
    for (const t of clock.timers) {
      expect(t.delay).toBeGreaterThanOrEqual(DEFAULT_TICK_INTERVAL_MS - DEFAULT_JITTER_MS);
      expect(t.delay).toBeLessThanOrEqual(DEFAULT_TICK_INTERVAL_MS + DEFAULT_JITTER_MS);
    }
  });

  test('stub detector fires expected payload on every tick', async () => {
    const clock = makeManualClock();
    const detector = makeHelloDetector({ id: 'test.scheduler.fires', alwaysFire: true });
    scheduler = startScheduler({
      tickIntervalMs: 1_000,
      jitterMs: 0,
      defaultFireBudget: 100,
      detectorSource: () => [detector as DetectorModule<unknown>],
      emitFn: captureEmit,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    // Drive 3 scheduled ticks by firing the timer chain.
    for (let i = 0; i < 3; i++) {
      await clock.fireAll();
    }

    const fires = captured.filter((c) => c.type === 'runbook.triggered');
    expect(fires.length).toBe(3);
    for (const f of fires) {
      expect(f.opts.detector_version).toBe('0.0.1');
      expect(f.opts.entity_id).toBe('test.scheduler.fires');
      expect(f.opts.source_subsystem).toBe('detector-scheduler');
    }
  });

  test('stop() prevents further ticks', async () => {
    const clock = makeManualClock();
    const detector = makeHelloDetector({ id: 'test.scheduler.stop', alwaysFire: true });
    scheduler = startScheduler({
      tickIntervalMs: 1_000,
      jitterMs: 0,
      defaultFireBudget: 100,
      detectorSource: () => [detector as DetectorModule<unknown>],
      emitFn: captureEmit,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    // Fire one tick, stop, then try to fire more.
    await clock.fireAll();
    const fireCountBeforeStop = captured.length;

    scheduler.stop();
    await clock.fireAll();

    expect(captured.length).toBe(fireCountBeforeStop);
    scheduler = null;
  });

  test('tickNow() runs a tick synchronously even with no scheduled timer yet', async () => {
    const clock = makeManualClock();
    const detector = makeHelloDetector({ id: 'test.scheduler.tick-now', alwaysFire: true });
    scheduler = startScheduler({
      tickIntervalMs: 1_000_000,
      jitterMs: 0,
      defaultFireBudget: 100,
      detectorSource: () => [detector as DetectorModule<unknown>],
      emitFn: captureEmit,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    await scheduler.tickNow();
    const fires = captured.filter((c) => c.type === 'runbook.triggered');
    expect(fires.length).toBe(1);
  });

  test('a detector that throws does not stop the scheduler', async () => {
    const clock = makeManualClock();
    const bad: DetectorModule<number> = {
      id: 'test.scheduler.throws',
      version: '1.0.0',
      riskClass: 'low',
      query: () => {
        throw new Error('boom');
      },
      shouldFire: () => true,
      render: () => ({ type: 'runbook.triggered', payload: { rule: 'R1', evidence_count: 1 } }),
    };
    const good = makeHelloDetector({ id: 'test.scheduler.ok', alwaysFire: true });

    scheduler = startScheduler({
      tickIntervalMs: 1_000,
      jitterMs: 0,
      defaultFireBudget: 100,
      detectorSource: () => [bad as DetectorModule<unknown>, good as DetectorModule<unknown>],
      emitFn: captureEmit,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    await scheduler.tickNow();
    const goodFires = captured.filter((c) => c.opts.entity_id === 'test.scheduler.ok');
    expect(goodFires.length).toBe(1);
  });
});
