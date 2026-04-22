/**
 * Detector Scheduler — runs every registered detector on a 60s cadence.
 *
 * Wish: Observability B1 — rot-pattern detectors (Group 2 / Phase 0).
 *
 * Responsibilities (read-only):
 *   1. Tick every 60s ± jitter (5s window).
 *   2. For each registered detector: run query → shouldFire → render.
 *   3. Emit the rendered event through `src/lib/emit.ts` with the
 *      detector's `version` threaded into `detector_version`.
 *   4. Enforce a per-detector hourly `fire_budget`. When a detector's fire
 *      count in the current hour bucket meets its configured budget the
 *      scheduler silences it for the rest of the bucket and emits one
 *      `detector.disabled` meta-event. The next bucket resets the counter.
 *
 * The scheduler is *measurement only*. It never mutates genie state — no
 * runbook execution, no SQL DDL, no file writes. Future phases build on top
 * of the events produced here; this module stays read-only forever.
 *
 * Wired into `src/term-commands/serve.ts` startup. No opt-in flag.
 */

import { listDetectors } from '../detectors/index.js';
import type { DetectorEvent, DetectorModule } from '../detectors/index.js';
import { emitEvent as defaultEmitEvent } from '../lib/emit.js';

// Production detector modules — each self-registers at import time via the
// `registerDetector(...)` call at the bottom of its own file. Importing them
// here triggers those side effects so `listDetectors()` returns every
// production module when the scheduler boots. Append-only: new detector
// wishes add one line each, ordered by their Group number.
//
// NOTE: do NOT place these imports inside `src/detectors/index.ts` — doing
// so creates a TDZ-breaking circular import (detector module imports
// `registerDetector` from index, index imports detector module for its side
// effect, and index's `const registry = new Map()` is not yet initialized
// when the detector's top-level registration runs through the cycle).
// Importing here keeps `src/detectors/index.ts` dependency-free.
import '../detectors/pattern-2-team-ls-drift.js';

/**
 * Sink contract for emitted detector rows. Production wires this to the real
 * `emitEvent` in `src/lib/emit.ts`; tests pass a capture closure so they do
 * not need `mock.module('emit.js', ...)`. Bun's `mock.module` is process-
 * global and cannot be undone — stubbing emit that way pollutes every later
 * test that exercises the real emit substrate (observed via the pentest-
 * observability failures before this DI landed).
 */
export type DetectorEmitFn = (type: string, payload: Record<string, unknown>, opts?: Record<string, unknown>) => void;

/** Alias for the concrete render() output so helper signatures stay readable. */
type DetectorEventResult = DetectorEvent;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base tick interval. Production default: 60 seconds. */
export const DEFAULT_TICK_INTERVAL_MS = 60_000;
/** Jitter window applied per-tick (±) to smear scheduler load. */
export const DEFAULT_JITTER_MS = 5_000;
/**
 * Default hourly fire budget per detector.
 *
 * Raised from 10 → 100 in #1292. At the old 10/hr cap, noisy-but-valid
 * detectors (`rot.team-ls-drift`, `rot.backfill-no-worktree`) exhausted the
 * budget within the first few minutes of every hour bucket and self-disabled
 * for the remaining 55+ minutes, producing bursty `detector.disabled` traffic
 * every hour rollover. 100 covers one fire every ~36s over the bucket — well
 * above the scheduler's own 60s cadence — so well-behaved detectors never hit
 * the ceiling under normal load.
 */
export const DEFAULT_FIRE_BUDGET = 100;
/**
 * Built-in per-detector budget overrides applied automatically for detectors
 * known to emit at elevated rates. Callers that pass `fireBudgets` in
 * `SchedulerOptions` can still override any entry here — the caller's map is
 * layered on top of these defaults.
 *
 * - `rot.team-ls-drift`: throttled hard while #1291 is open. Every fire is
 *   currently rejected by the event receiver schema, so fewer rows is strictly
 *   better than more. One `detector.disabled` per bucket signals the condition
 *   without drowning the receiver in events that will be dropped anyway.
 * - `rot.backfill-no-worktree`: chatty when the observable worktree population
 *   is large. Keeping it under the default gives operators a clear disable
 *   signal instead of wall-to-wall `runbook.triggered` noise.
 */
export const DEFAULT_DETECTOR_BUDGETS: Readonly<Record<string, number>> = Object.freeze({
  'rot.team-ls-drift': 20,
  'rot.backfill-no-worktree': 40,
});
/** Hour bucket size in milliseconds. */
const HOUR_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SchedulerOptions {
  /** Base tick interval in ms. Defaults to 60 seconds. */
  tickIntervalMs?: number;
  /** Jitter window applied per-tick (±) to smear load across detectors. */
  jitterMs?: number;
  /** Default fire budget applied to every detector unless overridden. */
  defaultFireBudget?: number;
  /** Per-detector fire budget overrides keyed on DetectorModule.id. */
  fireBudgets?: Readonly<Record<string, number>>;
  /**
   * Time source — injected so tests can drive deterministic buckets without
   * mocking the global `Date` object.
   */
  now?: () => number;
  /**
   * Timer primitives — injected so tests can use fake timers or manual ticks
   * without pausing the real event loop. The handle type is deliberately
   * opaque (`unknown`) so callers can return whatever their timer library
   * produces (`ReturnType<typeof setTimeout>`, a test stub, etc).
   */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /**
   * Detector source — defaults to the module-level registry
   * (`listDetectors()`). Tests that want isolated detector sets pass a custom
   * resolver so the global registry stays clean.
   */
  detectorSource?: () => ReadonlyArray<DetectorModule<unknown>>;
  /**
   * Emit sink — defaults to the real `emitEvent` from `src/lib/emit.ts`.
   * Tests pass a capture closure instead of using `mock.module('emit.js', ...)`,
   * which Bun cannot undo across test files (see `DetectorEmitFn` docstring).
   */
  emitFn?: DetectorEmitFn;
}

export interface SchedulerHandle {
  /** Stop the scheduler (idempotent). Any in-flight tick completes. */
  stop(): void;
  /** Run one tick synchronously. Exposed for tests. */
  tickNow(): Promise<void>;
  /** Observable stats for introspection / tests. */
  stats(): SchedulerStats;
}

export interface SchedulerStats {
  ticks: number;
  fires: number;
  disables: number;
  /** Fire counts keyed on `${detector_id}:${hour_bucket_start_ms}`. */
  budgetBuckets: Record<string, number>;
}

/** Opaque timer handle returned by injected setTimeout primitives. */
type TimerHandle = unknown;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the scheduler. Returns a handle the serve startup path stores and
 * invokes `stop()` on during graceful shutdown.
 *
 * The first tick runs after `tickIntervalMs ± jitter`; no immediate tick on
 * startup. That matches how the production emit pipeline pre-warms — a
 * synchronous tick at boot would fight pgserve readiness in practice.
 */
export function start(options: SchedulerOptions = {}): SchedulerHandle {
  const tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const jitterMs = options.jitterMs ?? DEFAULT_JITTER_MS;
  const defaultBudget = options.defaultFireBudget ?? DEFAULT_FIRE_BUDGET;
  // Layer built-in overrides (chatty production detectors) under caller-
  // provided overrides so tests and future callers can bump any specific
  // detector without having to remember the whole default set.
  const budgets: Record<string, number> = { ...DEFAULT_DETECTOR_BUDGETS, ...(options.fireBudgets ?? {}) };
  const now = options.now ?? (() => Date.now());
  const setTimeoutFn = options.setTimeoutFn ?? ((fn: () => void, ms: number): TimerHandle => setTimeout(fn, ms));
  const clearTimeoutFn =
    options.clearTimeoutFn ??
    ((handle: TimerHandle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    });
  const resolveDetectors = options.detectorSource ?? listDetectors;
  const emit: DetectorEmitFn = options.emitFn ?? defaultEmitEvent;

  const state: SchedulerStats = {
    ticks: 0,
    fires: 0,
    disables: 0,
    budgetBuckets: {},
  };

  /**
   * Per-bucket cache of detectors that have already emitted `detector.disabled`
   * in this hour. Prevents repeated disable events during the silenced window.
   */
  const disabledBuckets = new Set<string>();

  let stopped = false;
  let currentTimer: TimerHandle | null = null;
  let tickInFlight: Promise<void> | null = null;

  async function runTick(): Promise<void> {
    if (stopped) return;
    state.ticks++;

    const detectors = resolveDetectors();
    for (const detector of detectors) {
      await runOneDetector(detector);
    }
  }

  /** Safely invoke a detector step; return `null` if the callback throws. */
  async function safeCall<R>(fn: () => R | Promise<R>): Promise<R | null> {
    try {
      return await fn();
    } catch {
      return null;
    }
  }

  function emitFire(detector: DetectorModule<unknown>, event: DetectorEventResult): void {
    emit(event.type, event.payload, {
      detector_version: detector.version,
      source_subsystem: 'detector-scheduler',
      entity_id: event.subject ?? detector.id,
      agent: process.env.GENIE_AGENT_NAME ?? 'detector-scheduler',
    });
    state.fires++;
  }

  function emitDisable(detector: DetectorModule<unknown>, budget: number, current: number, bucketStart: number): void {
    state.disables++;
    emit(
      'detector.disabled',
      {
        detector_id: detector.id,
        cause: 'fire_budget_exceeded',
        budget,
        fire_count: current,
        bucket_end_ts: new Date(bucketStart + HOUR_MS).toISOString(),
      },
      {
        detector_version: detector.version,
        source_subsystem: 'detector-scheduler',
        entity_id: detector.id,
        severity: 'warn',
        agent: process.env.GENIE_AGENT_NAME ?? 'detector-scheduler',
      },
    );
  }

  async function runOneDetector(detector: DetectorModule<unknown>): Promise<void> {
    const bucketStart = Math.floor(now() / HOUR_MS) * HOUR_MS;
    const bucketKey = `${detector.id}:${bucketStart}`;
    const budget = budgets[detector.id] ?? defaultBudget;

    // Silenced for this bucket — short-circuit without running query.
    if (disabledBuckets.has(bucketKey)) return;

    const result = await safeCall(() => detector.query());
    if (result === null) return;
    const fires = await safeCall(() => detector.shouldFire(result));
    if (!fires) return;

    // Increment the bucket counter BEFORE emitting so an exception during
    // emit() doesn't let a noisy detector bypass the budget.
    const current = (state.budgetBuckets[bucketKey] ?? 0) + 1;
    state.budgetBuckets[bucketKey] = current;

    const event = await safeCall(() => detector.render(result));
    if (event === null) return;

    emitFire(detector, event);

    // Budget enforcement — self-disable on the fire that meets the budget.
    if (current >= budget && !disabledBuckets.has(bucketKey)) {
      disabledBuckets.add(bucketKey);
      emitDisable(detector, budget, current, bucketStart);
    }
  }

  function scheduleNext(): void {
    if (stopped) return;
    const jitter = jitterMs > 0 ? Math.floor((Math.random() * 2 - 1) * jitterMs) : 0;
    const delay = Math.max(0, tickIntervalMs + jitter);
    currentTimer = setTimeoutFn(() => {
      tickInFlight = runTick().finally(() => {
        tickInFlight = null;
        scheduleNext();
      });
    }, delay);
  }

  scheduleNext();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (currentTimer) {
        clearTimeoutFn(currentTimer);
        currentTimer = null;
      }
    },
    async tickNow(): Promise<void> {
      if (tickInFlight) await tickInFlight;
      await runTick();
    },
    stats(): SchedulerStats {
      return { ...state, budgetBuckets: { ...state.budgetBuckets } };
    },
  };
}
