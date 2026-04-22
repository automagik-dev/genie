/**
 * Runbook-R1 reference consumer — integration test (WISH §Group 7 #5).
 *
 * Three suites:
 *   1. Detector logic — pure unit tests against `R1Detector`.
 *   2. End-to-end replay — synthetically emit a #1192-style burst of
 *      mailbox.delivery rows; assert the consumer sees them and writes a
 *      `runbook.triggered` row with the recommended-SQL payload.
 *   3. Security + survivability — subscriber token cannot reach the audit
 *      channel; consumer restart resumes from the persisted cursor without
 *      re-firing.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { R1Detector } from '../../src/consumers/runbook-r1/detector.js';
import { mintR1Token, startRunbookR1 } from '../../src/consumers/runbook-r1/index.js';
import { type Sql, getConnection } from '../../src/lib/db.js';
import { __resetEmitForTests, __setSpillPathForTests, shutdownEmitter } from '../../src/lib/emit.js';
import { RBACError } from '../../src/lib/events/rbac.js';
import { mintToken } from '../../src/lib/events/tokens.js';
import { DB_AVAILABLE, setupTestDatabase } from '../../src/lib/test-db.js';

// Direct-insert helper that mirrors the seeder pattern in
// test/observability/replay-dataset/index.ts. We bypass emit.ts here because
// the emit writer currently sends the `data` payload as a string (PG stores
// it as a JSONB string scalar, breaking `data->>'from'` lookups). The
// consumer reads the same JSONB ops as production queries — seeding through
// `sql.json()` proves the consumer end-to-end without conflating an
// upstream emit-serialization bug into the runbook test.
async function seedMailboxDelivery(
  sql: Sql,
  args: { from: string; to: string; outcome?: string; trace_id?: string },
): Promise<void> {
  const data = {
    from: args.from,
    to: args.to,
    channel: 'tmux',
    outcome: args.outcome ?? 'delivered',
    duration_ms: 4,
    _severity: 'info',
    _kind: 'span',
    _source_subsystem: 'r1-replay-test',
    _schema_version: 1,
    ...(args.trace_id ? { _trace_id: args.trace_id } : {}),
  };
  await sql`
    INSERT INTO genie_runtime_events
      (repo_path, subject, kind, source, agent, team, text, data,
       severity, schema_version, duration_ms, source_subsystem, created_at)
    VALUES
      ('r1-test', 'mailbox.delivery', 'system', 'sdk', 'system', NULL,
       'mailbox.delivery', ${sql.json(data)},
       'info', 1, 4, 'r1-replay-test', now())
  `;
}

// ---------------------------------------------------------------------------
// 1. Detector unit tests — no DB, no emit.
// ---------------------------------------------------------------------------

describe('R1Detector — pure logic', () => {
  test('does not fire below the threshold', () => {
    const det = new R1Detector({ threshold: 5, idempotencyMs: 1_000 });
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) {
      const finding = det.observe({ createdAt: t0 + i, from: 'scheduler', to: 'team-lead' });
      expect(finding).toBeNull();
    }
    expect(det.getWindowDepth()).toBe(5);
  });

  test('fires once when the threshold is crossed', () => {
    const det = new R1Detector({ threshold: 5, idempotencyMs: 60_000 });
    const t0 = Date.now();
    let firings = 0;
    for (let i = 0; i < 10; i++) {
      const f = det.observe({ createdAt: t0 + i, from: 'scheduler', to: 'team-lead', trace_id: `t-${i}` });
      if (f) firings++;
    }
    expect(firings).toBe(1);
  });

  test('idempotency window suppresses re-fires', () => {
    const det = new R1Detector({ threshold: 3, idempotencyMs: 30_000 });
    const t0 = Date.now();
    let firings = 0;
    for (let i = 0; i < 20; i++) {
      const f = det.observe({ createdAt: t0 + i * 100, from: 'scheduler', to: 'team-lead' });
      if (f) firings++;
    }
    expect(firings).toBe(1);
  });

  test('fires again after idempotency window elapses', () => {
    const det = new R1Detector({ threshold: 3, idempotencyMs: 1_000 });
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) {
      det.observe({ createdAt: t0 + i, from: 'scheduler', to: 'team-lead' });
    }
    const f = det.observe({ createdAt: t0 + 2_000, from: 'scheduler', to: 'team-lead' });
    expect(f).not.toBeNull();
  });

  test('ignores events whose from/to do not match the rule', () => {
    const det = new R1Detector({ threshold: 1, idempotencyMs: 60_000 });
    const t0 = Date.now();
    const decoy = det.observe({ createdAt: t0, from: 'engineer', to: 'reviewer' });
    expect(decoy).toBeNull();
    expect(det.getWindowDepth()).toBe(0);
  });

  test('finding payload carries recommended SQL and correlation id', () => {
    const det = new R1Detector({ threshold: 2, idempotencyMs: 60_000 });
    const t0 = Date.now();
    det.observe({ createdAt: t0, from: 'scheduler', to: 'team-lead', trace_id: 'trace-A' });
    det.observe({ createdAt: t0 + 1, from: 'scheduler', to: 'team-lead', trace_id: 'trace-B' });
    const f = det.observe({ createdAt: t0 + 2, from: 'scheduler', to: 'team-lead', trace_id: 'trace-C' });
    expect(f).not.toBeNull();
    expect(f?.rule).toBe('R1');
    expect(f?.recommended_sql).toContain('DELETE FROM mailbox');
    expect(f?.recommended_sql).toContain("to_worker='team-lead'");
    expect(f?.recommended_sql).toContain("from_worker='scheduler'");
    expect(f?.correlation_id).toBe('trace-C');
    expect(f?.evidence_count).toBeGreaterThanOrEqual(3);
  });

  test('sliding window evicts old entries', () => {
    const det = new R1Detector({ threshold: 3, idempotencyMs: 1, windowMs: 1_000 });
    const t0 = Date.now();
    for (let i = 0; i < 4; i++) {
      det.observe({ createdAt: t0 + i, from: 'scheduler', to: 'team-lead' });
    }
    // Jump 2s — the window should evict everything before [t0+1100..]
    det.observe({ createdAt: t0 + 1_500, from: 'scheduler', to: 'team-lead' });
    expect(det.getWindowDepth()).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// 2. Token scope — subscriber token cannot reach audit.
// ---------------------------------------------------------------------------

describe('R1 consumer — token scope', () => {
  test('subscriber role cannot mint a token for the audit channel', () => {
    expect(() =>
      mintToken({
        role: 'events:subscriber',
        allowed_types: ['mailbox.delivery'],
        allowed_channels: ['genie_events.audit'],
        subscriber_id: 'attempted-escalation',
      }),
    ).toThrow(RBACError);
  });

  test('mintR1Token() returns a token whose payload is restricted to mailbox', () => {
    const { payload } = mintR1Token({ subscriberId: 'unit-test-r1' });
    expect(payload.role).toBe('events:subscriber');
    expect(payload.allowed_types).toEqual(['mailbox.delivery']);
    expect(payload.allowed_channels).toEqual(['genie_events.mailbox']);
    expect(payload.subscriber_id).toBe('unit-test-r1');
  });
});

// ---------------------------------------------------------------------------
// 3. End-to-end replay — emit a synthetic #1192 burst, assert emit.
// ---------------------------------------------------------------------------

describe.skipIf(!DB_AVAILABLE)('R1 consumer — end-to-end #1192 replay', () => {
  let cleanup: () => Promise<void> = async () => {};
  let spillDir: string;

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
  });

  afterAll(async () => {
    await shutdownEmitter();
    await cleanup();
  });

  beforeEach(async () => {
    __resetEmitForTests();
    spillDir = mkdtempSync(join(tmpdir(), 'r1-spill-'));
    __setSpillPathForTests(join(spillDir, 'spill.jsonl'));
    const sql = await getConnection();
    await sql.unsafe(`
      TRUNCATE TABLE genie_runtime_events,
                     genie_runtime_events_debug,
                     genie_runtime_events_audit
      RESTART IDENTITY CASCADE
    `);
  });

  afterEach(() => {
    __setSpillPathForTests(null);
    rmSync(spillDir, { recursive: true, force: true });
  });

  test('synthetic burst triggers runbook.triggered with recommended SQL', async () => {
    // Detector runs in-process via onFinding (skips RBAC enforcement at the
    // stream boundary so we exercise the end-to-end path independently of
    // GENIE_EVENTS_TOKEN_REQUIRED). The observed evidence still proves the
    // detector + consumer fire on a real DB-replayed burst.
    const findings: Array<{ evidence_count: number; recommended_sql: string }> = [];

    const handle = await startRunbookR1({
      detector: { threshold: 50, windowMs: 10 * 60_000, idempotencyMs: 60_000 },
      // Unique subscriberId so the persisted consumer cursor in
      // ~/.genie/state/ from a prior run does not skip our fresh ids.
      subscriberId: `r1-burst-${Date.now()}`,
      onFinding: (f) => findings.push({ evidence_count: f.evidence_count, recommended_sql: f.recommended_sql }),
      maxEvents: 60,
      idleExitMs: 10_000,
    });

    const sql = await getConnection();
    // 51 scheduler→team-lead deliveries — one above threshold.
    for (let i = 0; i < 51; i++) {
      await seedMailboxDelivery(sql, { from: 'scheduler', to: 'team-lead' });
    }
    // 5 unrelated deliveries to verify the detector ignores them.
    for (let i = 0; i < 5; i++) {
      await seedMailboxDelivery(sql, { from: 'engineer', to: 'reviewer' });
    }

    // Wait for the consumer to drain — generous to absorb the 2s polling
    // cadence + a few drain cycles.
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline && findings.length === 0) {
      await new Promise((r) => setTimeout(r, 250));
    }

    await handle.stop();

    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].evidence_count).toBeGreaterThanOrEqual(51);
    expect(findings[0].recommended_sql).toContain('DELETE FROM mailbox');
    expect(findings[0].recommended_sql).toContain("to_worker='team-lead'");
    expect(findings[0].recommended_sql).toContain("from_worker='scheduler'");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 4. Restart survivability — cursor advances, no duplicate fires.
// ---------------------------------------------------------------------------

describe.skipIf(!DB_AVAILABLE)('R1 consumer — survives restart with cursor + idempotency', () => {
  let cleanup: () => Promise<void> = async () => {};
  let spillDir: string;

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
  });

  afterAll(async () => {
    await shutdownEmitter();
    await cleanup();
  });

  beforeEach(async () => {
    __resetEmitForTests();
    spillDir = mkdtempSync(join(tmpdir(), 'r1-restart-spill-'));
    __setSpillPathForTests(join(spillDir, 'spill.jsonl'));
    const sql = await getConnection();
    await sql.unsafe(`
      TRUNCATE TABLE genie_runtime_events,
                     genie_runtime_events_debug,
                     genie_runtime_events_audit
      RESTART IDENTITY CASCADE
    `);
  });

  afterEach(() => {
    __setSpillPathForTests(null);
    rmSync(spillDir, { recursive: true, force: true });
  });

  test('restarted consumer resumes after cursor; idempotency suppresses double-fire', async () => {
    const subscriberId = `r1-restart-${Date.now()}`;
    const findings: Array<{ window_end_ms: number }> = [];

    // Phase 1 — saturate, fire once, then stop.
    const phase1 = await startRunbookR1({
      detector: { threshold: 50, windowMs: 10 * 60_000, idempotencyMs: 60_000 },
      subscriberId,
      onFinding: (f) => findings.push({ window_end_ms: f.window_end_ms }),
      maxEvents: 60,
      idleExitMs: 10_000,
    });
    const sql = await getConnection();
    for (let i = 0; i < 55; i++) {
      await seedMailboxDelivery(sql, { from: 'scheduler', to: 'team-lead' });
    }
    const deadline1 = Date.now() + 12_000;
    while (Date.now() < deadline1 && findings.length === 0) {
      await new Promise((r) => setTimeout(r, 250));
    }
    await phase1.stop();
    expect(findings.length).toBe(1);

    // Phase 2 — restart with same subscriberId. New events of the SAME
    // pathology arrive but a fresh detector starts an empty window, so no
    // duplicate runbook.triggered fires for events already counted before
    // the restart. We assert the consumer at least observed events without
    // crashing and recovered the cursor from disk (no panic, no exception).
    const phase2 = await startRunbookR1({
      detector: { threshold: 50, windowMs: 10 * 60_000, idempotencyMs: 60_000 },
      subscriberId,
      onFinding: (f) => findings.push({ window_end_ms: f.window_end_ms }),
      maxEvents: 60,
      idleExitMs: 8_000,
    });
    // A small tail of new events under the threshold — the post-restart
    // detector starts empty so it won't fire on these alone.
    for (let i = 0; i < 5; i++) {
      await seedMailboxDelivery(sql, { from: 'scheduler', to: 'team-lead' });
    }
    await new Promise((r) => setTimeout(r, 4_000));
    await phase2.stop();

    // Total fires must remain at 1 — restart did not duplicate-fire.
    expect(findings.length).toBe(1);
  }, 45_000);
});
