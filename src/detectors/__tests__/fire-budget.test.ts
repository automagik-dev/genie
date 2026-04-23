/**
 * Fire-budget enforcement — per-detector hourly budget caps emissions and
 * self-disables the detector for the remainder of the bucket.
 *
 * Wish: Observability B1 — rot-pattern detectors (Group 2 / Phase 0).
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  DEFAULT_DETECTOR_BUDGETS,
  DEFAULT_FIRE_BUDGET,
  type SchedulerHandle,
  start as startScheduler,
} from '../../serve/detector-scheduler.js';
import { makeHelloDetector } from '../__fixtures__/hello.js';
import type { DetectorModule } from '../index.js';

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
 * that way leaked into every later test file (observed as cascading
 * pentest-observability failures). Dependency injection keeps the stub
 * scoped to this file.
 */
function captureEmit(type: string, payload: Record<string, unknown>, opts: Record<string, unknown> = {}): void {
  captured.push({ type, payload, opts });
}

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
      emitFn: captureEmit,
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
      emitFn: captureEmit,
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

  test('default fire budget is 100', () => {
    // Raised from 10 → 100 in #1292 so well-behaved detectors never self-
    // disable under the 60s scheduler cadence (≤60 fires/hr < 100 budget).
    expect(DEFAULT_FIRE_BUDGET).toBe(100);
  });

  test('known-chatty detectors carry built-in budget overrides below the default', () => {
    // #1292: these two detectors were exhausting the old 10/hr budget every
    // bucket. The built-in overrides keep them below the raised default so
    // operators still get a single `detector.disabled` signal per hour rather
    // than continuous `runbook.triggered` noise.
    expect(DEFAULT_DETECTOR_BUDGETS['rot.team-ls-drift']).toBeLessThan(DEFAULT_FIRE_BUDGET);
    expect(DEFAULT_DETECTOR_BUDGETS['rot.backfill-no-worktree']).toBeLessThan(DEFAULT_FIRE_BUDGET);
  });

  test('built-in per-detector overrides apply without explicit fireBudgets', async () => {
    // Simulate the three production shapes in one bucket:
    //   - rot.team-ls-drift   → throttled by DEFAULT_DETECTOR_BUDGETS (20)
    //   - rot.backfill-no-worktree → throttled by DEFAULT_DETECTOR_BUDGETS (40)
    //   - rot.anchor-orphan   → falls through to DEFAULT_FIRE_BUDGET (100)
    const teamLsDrift = makeHelloDetector({ id: 'rot.team-ls-drift', alwaysFire: true });
    const backfill = makeHelloDetector({ id: 'rot.backfill-no-worktree', alwaysFire: true });
    const other = makeHelloDetector({ id: 'rot.anchor-orphan', alwaysFire: true });
    const frozenNow = Date.UTC(2026, 3, 20, 10, 30, 0);

    scheduler = startScheduler({
      tickIntervalMs: 1_000_000,
      jitterMs: 0,
      // No defaultFireBudget override, no fireBudgets — exercise the defaults.
      now: () => frozenNow,
      detectorSource: () => [teamLsDrift, backfill, other] as ReadonlyArray<DetectorModule<unknown>>,
      emitFn: captureEmit,
      setTimeoutFn: () => ({ id: Symbol('test') }),
      clearTimeoutFn: () => {},
    });

    // Ticks chosen so we exceed the largest chatty override (40) without
    // approaching the raised default (100) — `rot.anchor-orphan` must stay
    // below its budget to prove the default still applies.
    for (let i = 0; i < 45; i++) {
      await scheduler.tickNow();
    }

    const teamLsFires = captured.filter(
      (c) => c.type === 'runbook.triggered' && c.opts.entity_id === 'rot.team-ls-drift',
    );
    const backfillFires = captured.filter(
      (c) => c.type === 'runbook.triggered' && c.opts.entity_id === 'rot.backfill-no-worktree',
    );
    const otherFires = captured.filter(
      (c) => c.type === 'runbook.triggered' && c.opts.entity_id === 'rot.anchor-orphan',
    );
    const disabledIds = captured.filter((c) => c.type === 'detector.disabled').map((c) => c.payload.detector_id);

    expect(teamLsFires.length).toBe(DEFAULT_DETECTOR_BUDGETS['rot.team-ls-drift']);
    expect(backfillFires.length).toBe(DEFAULT_DETECTOR_BUDGETS['rot.backfill-no-worktree']);
    expect(otherFires.length).toBe(45);
    expect(disabledIds).toContain('rot.team-ls-drift');
    expect(disabledIds).toContain('rot.backfill-no-worktree');
    expect(disabledIds).not.toContain('rot.anchor-orphan');
  });

  test('caller-supplied fireBudgets override built-in defaults', async () => {
    // Operators (or tests) must be able to loosen or tighten any built-in
    // override by passing fireBudgets. Verify the caller's value for
    // `rot.team-ls-drift` wins over DEFAULT_DETECTOR_BUDGETS['rot.team-ls-drift'].
    const detector = makeHelloDetector({ id: 'rot.team-ls-drift', alwaysFire: true });
    const frozenNow = Date.UTC(2026, 3, 20, 10, 30, 0);
    const overrideBudget = 3;

    scheduler = startScheduler({
      tickIntervalMs: 1_000_000,
      jitterMs: 0,
      fireBudgets: { 'rot.team-ls-drift': overrideBudget },
      now: () => frozenNow,
      detectorSource: () => [detector as DetectorModule<unknown>],
      emitFn: captureEmit,
      setTimeoutFn: () => ({ id: Symbol('test') }),
      clearTimeoutFn: () => {},
    });

    for (let i = 0; i < 10; i++) {
      await scheduler.tickNow();
    }

    const fires = captured.filter((c) => c.type === 'runbook.triggered');
    const disables = captured.filter((c) => c.type === 'detector.disabled');
    expect(fires.length).toBe(overrideBudget);
    expect(disables.length).toBe(1);
    expect(disables[0].payload.budget).toBe(overrideBudget);
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
      emitFn: captureEmit,
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
