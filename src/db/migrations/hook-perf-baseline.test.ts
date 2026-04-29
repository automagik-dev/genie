/**
 * `hook_perf_baseline` view test (migration 056).
 *
 * Asserts shape and percentile correctness on synthetic `hook.delivery` rows.
 * Group 4 acceptance gate of wish hookify-perf-foundation.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getConnection } from '../../lib/db.js';
import { DB_AVAILABLE, setupTestDatabase } from '../../lib/test-db.js';

describe.skipIf(!DB_AVAILABLE)('hook_perf_baseline view', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanup();
  });

  test('view has the expected columns', async () => {
    const sql = await getConnection();
    const cols = (await sql`
      SELECT column_name
        FROM information_schema.columns
       WHERE table_name = 'hook_perf_baseline'
         AND table_schema = current_schema()
    `) as Array<{ column_name: string }>;
    const names = new Set(cols.map((r) => r.column_name));
    for (const expected of [
      'event_name',
      'tool_name',
      'handler_name',
      'p50_1h',
      'p99_1h',
      'p50_24h',
      'p99_24h',
      'p50_7d',
      'p99_7d',
      'sample_count_24h',
    ]) {
      expect(names.has(expected)).toBe(true);
    }
  });

  test('empty source data → view returns no rows (no error)', async () => {
    const sql = await getConnection();
    // Wipe any rows the migration runner might have left.
    await sql`DELETE FROM genie_runtime_events WHERE subject = 'hook.delivery' OR kind = 'hook.delivery'`;
    const rows = (await sql`SELECT * FROM hook_perf_baseline`) as unknown[];
    expect(rows.length).toBe(0);
  });

  test('PERCENTILE_CONT computes P50/P99 correctly with full window present', async () => {
    const sql = await getConnection();
    // Wipe and seed a known distribution: durations 1..101 ms for one
    // (event, tool, handler) tuple. Created 5 minutes ago so they fall
    // inside the 1h, 24h, AND 7d windows.
    await sql`DELETE FROM genie_runtime_events WHERE subject = 'hook.delivery' OR kind = 'hook.delivery'`;

    const fiveMinAgo = new Date(Date.now() - 5 * 60_000);
    for (let i = 1; i <= 101; i++) {
      const data = sql.json({
        _kind: 'span',
        event: 'PreToolUse',
        tool: 'Bash',
        hook_name: 'branch-guard',
        duration_ms: i,
      });
      await sql`
        INSERT INTO genie_runtime_events
          (repo_path, subject, kind, source, agent, text, data, created_at)
        VALUES
          ('test', 'hook.delivery', 'system', 'hooks', 'test', '', ${data}, ${fiveMinAgo})
      `;
    }

    const rows = (await sql`
      SELECT event_name, tool_name, handler_name,
             p50_1h::float8 AS p50_1h,
             p99_1h::float8 AS p99_1h,
             p50_24h::float8 AS p50_24h,
             p99_24h::float8 AS p99_24h,
             p50_7d::float8 AS p50_7d,
             p99_7d::float8 AS p99_7d,
             sample_count_24h
        FROM hook_perf_baseline
       WHERE event_name = 'PreToolUse'
         AND tool_name = 'Bash'
         AND handler_name = 'branch-guard'
    `) as Array<{
      event_name: string;
      tool_name: string;
      handler_name: string;
      p50_1h: number;
      p99_1h: number;
      p50_24h: number;
      p99_24h: number;
      p50_7d: number;
      p99_7d: number;
      sample_count_24h: bigint | number;
    }>;

    expect(rows.length).toBe(1);
    const row = rows[0];

    // For the integer sequence 1..101: P50 (PERCENTILE_CONT) = 51, P99 = 100.
    // PERCENTILE_CONT does linear interpolation, so checking near the integer
    // values (within 0.01 ms) catches arithmetic mistakes without being
    // brittle to floating-point representation.
    expect(row.p50_1h).toBeCloseTo(51, 1);
    expect(row.p99_1h).toBeCloseTo(100, 1);
    expect(row.p50_24h).toBeCloseTo(51, 1);
    expect(row.p99_24h).toBeCloseTo(100, 1);
    expect(row.p50_7d).toBeCloseTo(51, 1);
    expect(row.p99_7d).toBeCloseTo(100, 1);
    expect(Number(row.sample_count_24h)).toBe(101);
  });

  test('rolling windows correctly partition rows by created_at', async () => {
    const sql = await getConnection();
    await sql`DELETE FROM genie_runtime_events WHERE subject = 'hook.delivery' OR kind = 'hook.delivery'`;

    // Two cohorts:
    //   - 50 rows at 30 minutes ago, duration 10ms → falls in 1h, 24h, 7d
    //   - 50 rows at 5 days ago,    duration 100ms → falls only in 7d
    const thirtyMinAgo = new Date(Date.now() - 30 * 60_000);
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60_000);

    for (let i = 0; i < 50; i++) {
      const data = sql.json({
        _kind: 'span',
        event: 'PreToolUse',
        tool: 'Read',
        hook_name: 'freshness',
        duration_ms: 10,
      });
      await sql`
        INSERT INTO genie_runtime_events
          (repo_path, subject, kind, source, agent, text, data, created_at)
        VALUES
          ('test', 'hook.delivery', 'system', 'hooks', 'test', '', ${data}, ${thirtyMinAgo})
      `;
    }
    for (let i = 0; i < 50; i++) {
      const data = sql.json({
        _kind: 'span',
        event: 'PreToolUse',
        tool: 'Read',
        hook_name: 'freshness',
        duration_ms: 100,
      });
      await sql`
        INSERT INTO genie_runtime_events
          (repo_path, subject, kind, source, agent, text, data, created_at)
        VALUES
          ('test', 'hook.delivery', 'system', 'hooks', 'test', '', ${data}, ${fiveDaysAgo})
      `;
    }

    const rows = (await sql`
      SELECT
        p50_1h::float8 AS p50_1h,
        p50_24h::float8 AS p50_24h,
        p50_7d::float8 AS p50_7d,
        sample_count_24h
      FROM hook_perf_baseline
      WHERE handler_name = 'freshness'
    `) as Array<{
      p50_1h: number | null;
      p50_24h: number | null;
      p50_7d: number | null;
      sample_count_24h: bigint | number;
    }>;

    expect(rows.length).toBe(1);
    const row = rows[0];
    // 1h window only sees the 10ms cohort → P50 = 10
    expect(row.p50_1h).toBeCloseTo(10, 1);
    // 24h window also only sees the 10ms cohort
    expect(row.p50_24h).toBeCloseTo(10, 1);
    // 7d window sees both cohorts (50× 10ms + 50× 100ms) → P50 = 55
    expect(row.p50_7d).toBeCloseTo(55, 1);
    // sample_count_24h counts only the 10ms cohort (30 min ago)
    expect(Number(row.sample_count_24h)).toBe(50);
  });

  test('rows missing data.duration_ms are filtered out', async () => {
    const sql = await getConnection();
    await sql`DELETE FROM genie_runtime_events WHERE subject = 'hook.delivery' OR kind = 'hook.delivery'`;

    // One valid row + one row missing duration_ms.
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000);
    const validData = sql.json({
      _kind: 'span',
      event: 'Stop',
      tool: '<none>',
      hook_name: 'runtime-emit-assistant-response',
      duration_ms: 42,
    });
    const missingDurData = sql.json({
      _kind: 'span',
      event: 'Stop',
      tool: '<none>',
      hook_name: 'runtime-emit-assistant-response',
    });
    await sql`
      INSERT INTO genie_runtime_events
        (repo_path, subject, kind, source, agent, text, data, created_at)
      VALUES
        ('test', 'hook.delivery', 'system', 'hooks', 'test', '', ${validData}, ${fiveMinAgo}),
        ('test', 'hook.delivery', 'system', 'hooks', 'test', '', ${missingDurData}, ${fiveMinAgo})
    `;

    const rows = (await sql`
      SELECT sample_count_24h FROM hook_perf_baseline
       WHERE handler_name = 'runtime-emit-assistant-response'
    `) as Array<{ sample_count_24h: bigint | number }>;
    expect(rows.length).toBe(1);
    expect(Number(rows[0].sample_count_24h)).toBe(1);
  });
});
