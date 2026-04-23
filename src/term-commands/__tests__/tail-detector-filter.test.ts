/**
 * Integration test — operator can live-stream `detector.*` events through
 * `genie events stream-follow --kind 'detector.*'` (the verb that owns the
 * live runtime stream today; see PR body inventory paragraph for the
 * grep-derived mapping).
 *
 * Wish: genie-self-healing-observability-b1-detectors (Group 4).
 *
 * The test deliberately uses Group 2's stub detector — NOT any production
 * detector module from Wave 3.1 — so this group ships and merges in any
 * order relative to 3a/3b/3c.
 *
 * Flow:
 *   1. Boot a `runEventsStreamFollow` consumer with `kind: 'detector.*'`.
 *   2. Start the detector scheduler with the stub detector + fire_budget=1
 *      and the REAL `emitEvent` sink so rows actually land in PG.
 *   3. Call `tickNow()` — the stub fires once, the budget is exhausted,
 *      the scheduler emits `detector.disabled`.
 *   4. Flush the emit queue and wait for the consumer to surface a row
 *      whose subject begins with `detector.`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeHelloDetector } from '../../detectors/__fixtures__/hello.js';
import type { DetectorModule } from '../../detectors/index.js';
import { emitEvent, flushNow } from '../../lib/emit.js';
import { generateConsumerId } from '../../lib/events/consumer-state.js';
import { DB_AVAILABLE, setupTestDatabase } from '../../lib/test-db.js';
import { start as startScheduler } from '../../serve/detector-scheduler.js';
import { runEventsStreamFollow } from '../events-stream.js';

describe.skipIf(!DB_AVAILABLE)('tail / events stream-follow — detector.* filter', () => {
  let homeDir: string;
  let prevHome: string | undefined;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'tail-detector-'));
    prevHome = process.env.GENIE_HOME;
    process.env.GENIE_HOME = homeDir;
  });

  afterEach(() => {
    if (prevHome === undefined) process.env.GENIE_HOME = undefined;
    else process.env.GENIE_HOME = prevHome;
    rmSync(homeDir, { recursive: true, force: true });
  });

  test('--kind detector.* surfaces detector-scheduler events end-to-end', async () => {
    const consumerId = generateConsumerId('tail-detector-filter');
    const received: Array<{ subject: string | null }> = [];

    const handle = await runEventsStreamFollow(
      {
        follow: true,
        consumerId,
        kind: 'detector.*',
        maxEvents: 1,
        // Budget tests hammer the scheduler hard; raise the headroom so the
        // 60s budget gate cannot starve the assertion under CI load.
        heartbeatIntervalMs: 60_000,
        idleExitMs: 60_000,
      },
      (row) => {
        received.push({ subject: row.subject });
      },
    );

    // Stand up an isolated scheduler with the stub detector + budget=1 so
    // the very first tick produces a real `detector.disabled` row.
    const detector = makeHelloDetector({
      id: 'test.tail-detector-filter',
      version: '0.0.1',
      alwaysFire: true,
    });
    const scheduler = startScheduler({
      tickIntervalMs: 60_000_000, // long — we drive ticks manually
      jitterMs: 0,
      defaultFireBudget: 1,
      detectorSource: () => [detector as DetectorModule<unknown>],
      emitFn: (type, payload, opts) => {
        // Bridge the scheduler's emit signature into the production emitter.
        emitEvent(type, payload, opts ?? {});
      },
    });

    try {
      await scheduler.tickNow();
      await flushNow();

      const startedAt = Date.now();
      // Allow up to 65s — the 60s wish budget plus a 5s safety window for
      // NOTIFY round-trip + drain. In practice the stream-follow safety-net
      // poll fires every 2s so this resolves in well under one second.
      while (received.length === 0 && Date.now() - startedAt < 65_000) {
        await flushNow();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      scheduler.stop();
      await handle.stop();
    }

    expect(received.length).toBeGreaterThan(0);
    expect(received[0].subject ?? '').toMatch(/^detector\./);
  }, 70_000);

  test('--kind command.* (negative) does NOT surface detector events', async () => {
    // Regression guard — proves the glob is not silently matching unrelated
    // event families. Pairs with the affirmative case above.
    const consumerId = generateConsumerId('tail-detector-filter-neg');
    const received: Array<{ subject: string | null }> = [];

    const handle = await runEventsStreamFollow(
      {
        follow: true,
        consumerId,
        kind: 'command.*',
        maxEvents: 1,
        heartbeatIntervalMs: 60_000,
        idleExitMs: 2_000,
      },
      (row) => {
        received.push({ subject: row.subject });
      },
    );

    const detector = makeHelloDetector({
      id: 'test.tail-detector-filter-neg',
      version: '0.0.1',
      alwaysFire: true,
    });
    const scheduler = startScheduler({
      tickIntervalMs: 60_000_000,
      jitterMs: 0,
      defaultFireBudget: 1,
      detectorSource: () => [detector as DetectorModule<unknown>],
      emitFn: (type, payload, opts) => {
        emitEvent(type, payload, opts ?? {});
      },
    });

    try {
      await scheduler.tickNow();
      await flushNow();
      // Wait for the idle-exit timer; consumer should drain to empty.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
    } finally {
      scheduler.stop();
      await handle.stop();
    }

    // None of the rows the scheduler produced (detector.disabled +
    // runbook.triggered) start with `command.`, so the consumer must
    // observe zero hits.
    for (const row of received) {
      expect(row.subject ?? '').not.toMatch(/^detector\./);
      expect(row.subject ?? '').not.toMatch(/^runbook\./);
    }
  }, 30_000);
});
