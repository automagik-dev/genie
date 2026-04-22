/**
 * Tests for `genie events stream --follow` consumer behavior.
 *
 * Pure (non-DB) assertions validate the filter-parsing and option shape;
 * DB-backed tests exercise the LISTEN+cursor drain path against a seeded
 * `genie_runtime_events` row.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConnection } from '../lib/db.js';
import { generateConsumerId } from '../lib/events/consumer-state.js';
import { parseSince } from '../lib/events/v2-query.js';
import { DB_AVAILABLE, setupTestDatabase } from '../lib/test-db.js';
import { runEventsStreamFollow } from './events-stream.js';

describe('events-stream — pure helpers', () => {
  test('parseSince converts 1h, 5m, 2d to ISO timestamps in the past', () => {
    const isoH = parseSince('1h');
    const isoM = parseSince('5m');
    const isoD = parseSince('2d');
    for (const iso of [isoH, isoM, isoD]) {
      const t = Date.parse(iso);
      expect(Number.isFinite(t)).toBe(true);
      expect(t).toBeLessThan(Date.now() + 10);
    }
    expect(Date.parse(isoH)).toBeLessThan(Date.parse(isoM));
  });

  test('parseSince passes ISO through unchanged', () => {
    const iso = '2026-01-01T00:00:00Z';
    expect(parseSince(iso)).toBe(iso);
  });
});

describe.skipIf(!DB_AVAILABLE)('events-stream — DB path', () => {
  let homeDir: string;
  let prev: string | undefined;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'events-stream-'));
    prev = process.env.GENIE_HOME;
    process.env.GENIE_HOME = homeDir;
  });

  afterEach(() => {
    if (prev === undefined) process.env.GENIE_HOME = undefined;
    else process.env.GENIE_HOME = prev;
    rmSync(homeDir, { recursive: true, force: true });
  });

  async function seedEvent(subject: string, severity: string): Promise<number> {
    const sql = await getConnection();
    const rows = (await sql.unsafe(
      `INSERT INTO genie_runtime_events (repo_path, subject, kind, source, agent, text, data, severity, created_at)
       VALUES ($1, $2, 'system', 'test', 'test-agent', $2, '{}'::jsonb, $3, now())
       RETURNING id`,
      ['/tmp/repo', subject, severity],
    )) as unknown as Array<{ id: number }>;
    return Number(rows[0].id);
  }

  test('follow delivers new rows via drain after seeded INSERT', async () => {
    const consumerId = generateConsumerId('unit-test');
    const received: Array<{ id: number; subject: string | null }> = [];

    const handle = await runEventsStreamFollow(
      {
        follow: true,
        consumerId,
        maxEvents: 1,
        heartbeatIntervalMs: 60_000,
        idleExitMs: 3_000,
      },
      (row) => {
        received.push({ id: row.id, subject: row.subject });
      },
    );

    // Seed AFTER the follow is established so the initial latest-id snapshot
    // is behind the inserted row — the NOTIFY + poll safety-net both
    // guarantee delivery.
    const newId = await seedEvent('mailbox.delivery.sent', 'info');

    // Wait for NOTIFY + drain (poll fallback covers LISTEN races).
    const start = Date.now();
    while (received.length === 0 && Date.now() - start < 4000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await handle.stop();

    expect(received.length).toBeGreaterThan(0);
    expect(received[0].id).toBe(newId);
    expect(handle.getLastSeenId()).toBe(newId);
  });

  test('filter by kind prefix drops non-matching events', async () => {
    const consumerId = generateConsumerId('unit-test-kind');
    const received: Array<{ id: number; subject: string | null }> = [];

    const handle = await runEventsStreamFollow(
      {
        follow: true,
        consumerId,
        kind: 'mailbox',
        maxEvents: 1,
        heartbeatIntervalMs: 60_000,
        idleExitMs: 3_000,
      },
      (row) => {
        received.push({ id: row.id, subject: row.subject });
      },
    );

    await seedEvent('agent.lifecycle', 'info'); // should be filtered out
    const mailboxId = await seedEvent('mailbox.delivery.sent', 'info');

    const start = Date.now();
    while (received.length === 0 && Date.now() - start < 4000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await handle.stop();

    expect(received.length).toBe(1);
    expect(received[0].id).toBe(mailboxId);
    expect(received[0].subject).toBe('mailbox.delivery.sent');
  });

  test('persisted cursor resumes on reconnect', async () => {
    const consumerId = generateConsumerId('unit-test-resume');
    // Generous safety-net: the barrier fires as soon as the target rows are
    // delivered by the callback, so the timeout only trips on a real failure.
    const BARRIER_TIMEOUT_MS = 30_000;

    const withTimeout = async <T>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      });
      try {
        return await Promise.race([promise, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    // First run — consume one event, persist cursor. A per-row barrier fires
    // when the consumer callback observes the seeded id; no wall-clock polling.
    const firstRun: number[] = [];
    let firstTargetId: number | null = null;
    let firstResolve!: () => void;
    const firstBarrier = new Promise<void>((resolve) => {
      firstResolve = resolve;
    });
    const h1 = await runEventsStreamFollow(
      { follow: true, consumerId, maxEvents: 1, idleExitMs: 3_000, heartbeatIntervalMs: 60_000 },
      (row) => {
        firstRun.push(row.id);
        if (firstTargetId !== null && row.id === firstTargetId) firstResolve();
      },
    );
    const firstId = await seedEvent('agent.lifecycle', 'info');
    firstTargetId = firstId;
    // Handle the race where the callback already fired before the target was set.
    if (firstRun.includes(firstId)) firstResolve();
    await withTimeout(firstBarrier, BARRIER_TIMEOUT_MS, `timeout waiting for firstId=${firstId}`);
    await h1.stop();
    expect(firstRun[0]).toBe(firstId);

    // Seed more events while disconnected.
    const missedA = await seedEvent('agent.lifecycle', 'info');
    const missedB = await seedEvent('agent.lifecycle', 'info');

    // Second run — same consumer id must resume from persisted cursor and
    // deliver the previously-missed rows. Use a generous maxEvents so that
    // any incidental emit.ts background rows that landed between runs do
    // not starve the target deliveries. The barrier resolves as soon as both
    // missed ids have been observed by the callback.
    const secondRun: number[] = [];
    let secondResolve!: () => void;
    const secondBarrier = new Promise<void>((resolve) => {
      secondResolve = resolve;
    });
    const h2 = await runEventsStreamFollow(
      { follow: true, consumerId, maxEvents: 10, idleExitMs: 3_000, heartbeatIntervalMs: 60_000 },
      (row) => {
        secondRun.push(row.id);
        if (secondRun.includes(missedA) && secondRun.includes(missedB)) secondResolve();
      },
    );
    await withTimeout(secondBarrier, BARRIER_TIMEOUT_MS, `timeout waiting for missed=${missedA},${missedB}`);
    await h2.stop();

    expect(secondRun).toContain(missedA);
    expect(secondRun).toContain(missedB);
  });
});
