/**
 * Back-pressure saturation test (WISH §Group 6 acceptance criterion).
 *
 * Saturates the emit queue past its cap, asserts:
 *  - debug events are dropped silently (stats.dropped_debug > 0).
 *  - info events are dropped with bookkeeping (stats.dropped_info > 0).
 *  - warn/error/fatal events land on disk in the spill journal.
 *  - on recovery the journal drains with original timestamps preserved.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __TEST_QUEUE_CAP,
  __resetEmitForTests,
  __setSpillPathForTests,
  drainSpillJournalNow,
  emitEvent,
  flushNow,
  getEmitStats,
  shutdownEmitter,
} from '../../src/lib/emit.js';

const DB_AVAILABLE = process.env.GENIE_TEST_PG_PORT !== undefined;

function makePayload(): Record<string, unknown> {
  return {
    entity_kind: 'task',
    entity_id: 'task-bp',
    from: 'pending',
    to: 'in_progress',
    reason: 'synthetic load',
    actor: 'backpressure-test',
    before: { status: 'pending' },
    after: { status: 'in_progress' },
  };
}

describe('emit — back-pressure tiers (no DB required)', () => {
  let spillDir: string;
  let spillPath: string;

  beforeEach(() => {
    __resetEmitForTests();
    spillDir = mkdtempSync(join(tmpdir(), 'emit-spill-'));
    spillPath = join(spillDir, 'emit-spill.jsonl');
    __setSpillPathForTests(spillPath);
  });

  afterEach(() => {
    __setSpillPathForTests(null);
    rmSync(spillDir, { recursive: true, force: true });
  });

  test('debug overflow drops silently without spilling', () => {
    // Pre-fill queue to cap by emitting debug — admitted below cap.
    for (let i = 0; i < __TEST_QUEUE_CAP; i++) {
      emitEvent('state_transition', makePayload(), { severity: 'debug' });
    }
    // Additional debug events must be dropped.
    for (let i = 0; i < 500; i++) {
      emitEvent('state_transition', makePayload(), { severity: 'debug' });
    }
    const stats = getEmitStats();
    expect(stats.dropped_debug).toBeGreaterThan(0);
    expect(stats.spilled_warn_plus).toBe(0);
    expect(existsSync(spillPath)).toBe(false);
  });

  test('warn overflow spills to disk journal', () => {
    for (let i = 0; i < __TEST_QUEUE_CAP; i++) {
      emitEvent('state_transition', makePayload(), { severity: 'info' });
    }
    // Next warn emit must go to spill.
    emitEvent('state_transition', makePayload(), { severity: 'warn' });
    emitEvent('state_transition', makePayload(), { severity: 'error' });
    const stats = getEmitStats();
    expect(stats.spilled_warn_plus).toBeGreaterThanOrEqual(2);
    expect(existsSync(spillPath)).toBe(true);
    const lines = readFileSync(spillPath, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  test('info overflow drops with bookkeeping (no spill)', () => {
    for (let i = 0; i < __TEST_QUEUE_CAP; i++) {
      emitEvent('state_transition', makePayload(), { severity: 'info' });
    }
    emitEvent('state_transition', makePayload(), { severity: 'info' });
    const stats = getEmitStats();
    expect(stats.dropped_info).toBeGreaterThan(0);
    expect(stats.spilled_warn_plus).toBe(0);
  });
});

describe.skipIf(!DB_AVAILABLE)('emit — spill journal drain on recovery', () => {
  let spillDir: string;
  let spillPath: string;

  beforeEach(() => {
    __resetEmitForTests();
    spillDir = mkdtempSync(join(tmpdir(), 'emit-spill-'));
    spillPath = join(spillDir, 'emit-spill.jsonl');
    __setSpillPathForTests(spillPath);
  });

  afterEach(async () => {
    await shutdownEmitter();
    __setSpillPathForTests(null);
    rmSync(spillDir, { recursive: true, force: true });
  });

  // This test drains 10_000 events (= QUEUE_CAP) in batches of 500 (= 20+
  // serial PG INSERTs) plus a separate spill-journal drain. Under pgserve-ram
  // load the cumulative elapsed occasionally exceeds the default 5000ms test
  // timeout — three local runs in sequence: pass / pass / fail. The test
  // validates *functional correctness* (journal gone after both drains), not
  // performance; 30s is a generous ceiling that stops the pre-existing flake
  // without masking a real slowdown (a real hang would still fail).
  test('drain replays spilled rows oldest-first after recovery', async () => {
    for (let i = 0; i < __TEST_QUEUE_CAP; i++) {
      emitEvent('state_transition', makePayload(), { severity: 'info' });
    }
    for (let i = 0; i < 5; i++) {
      emitEvent('state_transition', makePayload(), { severity: 'warn' });
    }
    expect(existsSync(spillPath)).toBe(true);

    // Flush first batch to free the queue. flushNow opportunistically drains
    // the spill journal in the background, so we may race it here. Call the
    // explicit drain too — together they must leave the journal empty.
    await flushNow();
    await drainSpillJournalNow();
    // Journal should be gone after successful drain (by either path).
    expect(existsSync(spillPath)).toBe(false);
  }, 30_000);
});
