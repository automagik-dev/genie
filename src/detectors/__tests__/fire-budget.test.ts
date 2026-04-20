/**
 * Fire-budget enforcement — per-detector hourly budget caps emissions and
 * self-disables the detector for the remainder of the bucket.
 *
 * Wish: Observability B1 — rot-pattern detectors (Group 2 / Phase 0).
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';

interface CapturedEmit {
  type: string;
  payload: Record<string, unknown>;
  opts: Record<string, unknown>;
}
const captured: CapturedEmit[] = [];

// Mock emit before importing the scheduler so it wires to the stub.
mock.module('../../lib/emit.js', () => ({
  emitEvent: (type: string, payload: Record<string, unknown>, opts: Record<string, unknown> = {}) => {
    captured.push({ type, payload, opts });
  },
  startSpan: () => ({
    type: '',
    trace_id: '',
    span_id: '',
    started_at: 0,
    start_attrs: {},
    severity: 'info',
  }),
  endSpan: () => {},
}));

import { DEFAULT_FIRE_BUDGET, type SchedulerHandle, start as startScheduler } from '../../serve/detector-scheduler.js';
import { makeHelloDetector } from '../__fixtures__/hello.js';
import type { DetectorModule } from '../index.js';

describe('fire_budget enforcement', () => {
  let scheduler: SchedulerHandle | null = null;

  beforeAll(() => {
    // Freeze time within a single hour bucket for the default-budget test.
  });

  afterEach(() => {
    if (scheduler) {
      scheduler.stop();
      scheduler = null;
    }
    captured.length = 0;
  });

  afterAll(() => {
    // nothing to teardown
  });

  test('stub detector that always fires stops after hitting the budget', async () => {
    const detector = makeHelloDetector({ id: 'test.fire-budget.always', alwaysFire: true });
    // Freeze clock inside one hour bucket.
    const frozenNow = Date.UTC(2026, 3, 20, 10, 30, 0); // 10:30 UTC
    const budget = 3;

    scheduler = startScheduler({
      tickIntervalMs: 1_000_000, // never naturally ticks — we drive via tickNow
      jitterMs: 0,
      defaultFireBudget: budget,
      now: () => frozenNow,
      detectorSource: () => [detector as DetectorModule<unknown>],
      // No real setTimeout scheduling — we just need the handle to exist.
      setTimeoutFn: () => ({ id: Symbol('test') }),
      clearTimeoutFn: () => {},
    });

    // Drive 5 ticks — only `budget` (3) fires should be emitted, plus a
    // single detector.disabled meta event at the cap.
    for (let i = 0; i < 5; i++) {
      await scheduler.tickNow();
    }

    const runbookFires = captured.filter((c) => c.type === 'runbook.triggered');
    const disableEvents = captured.filter((c) => c.type === 'detector.disabled');

    expect(runbookFires.length).toBe(budget);
    expect(disableEvents.length).toBe(1);

    const disable = disableEvents[0];
    expect(disable.payload.detector_id).toBe('test.fire-budget.always');
    expect(disable.payload.cause).toBe('fire_budget_exceeded');
    expect(disable.payload.budget).toBe(budget);
    expect(disable.payload.fire_count).toBe(budget);
    expect(typeof disable.payload.bucket_end_ts).toBe('string');

    // Every fire — including the disable event — carries detector_version.
    for (const emit of captured) {
      expect(emit.opts.detector_version).toBe('0.0.1');
    }
  });

  test('next hour bucket resets the counter', async () => {
    const detector = makeHelloDetector({ id: 'test.fire-budget.bucket-reset', alwaysFire: true });
    const budget = 2;
    let clock = Date.UTC(2026, 3, 20, 10, 30, 0);

    scheduler = startScheduler({
      tickIntervalMs: 1_000_000,
      jitterMs: 0,
      defaultFireBudget: budget,
      now: () => clock,
      detectorSource: () => [detector as DetectorModule<unknown>],
      setTimeoutFn: () => ({ id: Symbol('test') }),
      clearTimeoutFn: () => {},
    });

    // Burn the first bucket: 3 ticks → 2 fires + 1 disable.
    for (let i = 0; i < 3; i++) {
      await scheduler.tickNow();
    }
    expect(captured.filter((c) => c.type === 'runbook.triggered').length).toBe(budget);
    expect(captured.filter((c) => c.type === 'detector.disabled').length).toBe(1);

    // Advance clock into the next hour bucket.
    clock = Date.UTC(2026, 3, 20, 11, 15, 0);

    // Fire again — counter should start fresh.
    for (let i = 0; i < 3; i++) {
      await scheduler.tickNow();
    }
    expect(captured.filter((c) => c.type === 'runbook.triggered').length).toBe(budget * 2);
    expect(captured.filter((c) => c.type === 'detector.disabled').length).toBe(2);
  });

  test('default fire budget is 10', () => {
    expect(DEFAULT_FIRE_BUDGET).toBe(10);
  });

  test('per-detector budget overrides default', async () => {
    const loud = makeHelloDetector({ id: 'test.fire-budget.loud', alwaysFire: true });
    const quiet = makeHelloDetector({ id: 'test.fire-budget.quiet', alwaysFire: true });
    const frozenNow = Date.UTC(2026, 3, 20, 10, 30, 0);

    scheduler = startScheduler({
      tickIntervalMs: 1_000_000,
      jitterMs: 0,
      defaultFireBudget: 100,
      fireBudgets: { 'test.fire-budget.quiet': 2 },
      now: () => frozenNow,
      detectorSource: () => [loud as DetectorModule<unknown>, quiet as DetectorModule<unknown>],
      setTimeoutFn: () => ({ id: Symbol('test') }),
      clearTimeoutFn: () => {},
    });

    for (let i = 0; i < 5; i++) {
      await scheduler.tickNow();
    }

    const loudFires = captured.filter(
      (c) => c.type === 'runbook.triggered' && c.opts.entity_id === 'test.fire-budget.loud',
    );
    const quietFires = captured.filter(
      (c) => c.type === 'runbook.triggered' && c.opts.entity_id === 'test.fire-budget.quiet',
    );
    const disables = captured.filter((c) => c.type === 'detector.disabled');

    expect(loudFires.length).toBe(5);
    expect(quietFires.length).toBe(2);
    expect(disables.length).toBe(1);
    expect(disables[0].payload.detector_id).toBe('test.fire-budget.quiet');
  });
});
