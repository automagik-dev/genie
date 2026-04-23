/**
 * Regression test for emit.ts JSONB binding.
 *
 * Bug: writeBatch used to pass `JSON.stringify(data)` as a text parameter
 * to `sql.unsafe`, which caused postgres to store the entire payload as a
 * JSON string scalar rather than a structured JSONB object. Consequence:
 * `data->>'_trace_id'` returned NULL on every emit.ts-written row, which
 * broke `genie events timeline <trace_id>` (a wish success criterion).
 *
 * Fix: cast the `data` placeholder to `::jsonb` in the INSERT statement.
 * This test asserts that structural JSONB access returns real values.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { getConnection } from '../../src/lib/db.js';
import { __resetEmitForTests, emitEvent, flushNow, shutdownEmitter } from '../../src/lib/emit.js';

const DB_AVAILABLE = process.env.GENIE_TEST_PG_PORT !== undefined;

describe.skipIf(!DB_AVAILABLE)('emit — JSONB binding', () => {
  afterAll(async () => {
    await shutdownEmitter();
  });

  test('data column is queryable via JSONB operators (->>, ->)', async () => {
    __resetEmitForTests();
    const sql = await getConnection();

    const [{ max_id }] = (await sql`SELECT COALESCE(MAX(id), 0)::bigint AS max_id FROM genie_runtime_events`) as Array<{
      max_id: number;
    }>;

    emitEvent(
      'state_transition',
      {
        entity_kind: 'task',
        entity_id: 'task-jsonb-probe',
        from: 'pending',
        to: 'in_progress',
        before: { status: 'pending' },
        after: { status: 'in_progress' },
      },
      { severity: 'info', source_subsystem: 'jsonb-test' },
    );

    await flushNow();

    const rows = (await sql`
      SELECT
        id,
        jsonb_typeof(data) AS data_type,
        data->>'_trace_id' AS trace_id,
        data->>'_span_id' AS span_id,
        data->>'_severity' AS severity,
        data->>'_source_subsystem' AS subsystem,
        (data->>'_schema_version')::int AS schema_version
      FROM genie_runtime_events
      WHERE id > ${Number(max_id)}
        AND subject = 'state_transition'
      ORDER BY id DESC
      LIMIT 1
    `) as Array<{
      id: number;
      data_type: string;
      trace_id: string | null;
      span_id: string | null;
      severity: string | null;
      subsystem: string | null;
      schema_version: number | null;
    }>;

    expect(rows.length).toBe(1);
    const row = rows[0];
    // Must be a JSONB object — not a string scalar.
    expect(row.data_type).toBe('object');
    // OTEL fields must be queryable via ->>.
    expect(row.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(row.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(row.severity).toBe('info');
    expect(row.subsystem).toBe('jsonb-test');
    expect(row.schema_version).toBe(1);
  });

  test('timeline-style query by trace_id returns the emitted row', async () => {
    __resetEmitForTests();
    const sql = await getConnection();

    const [{ max_id }] = (await sql`SELECT COALESCE(MAX(id), 0)::bigint AS max_id FROM genie_runtime_events`) as Array<{
      max_id: number;
    }>;

    // Emit two events sharing a trace_id via the ctx plumbing.
    const trace_id = 'abcdef0123456789abcdef0123456789';
    emitEvent(
      'state_transition',
      {
        entity_kind: 'task',
        entity_id: 'task-trace-probe-a',
        from: 'pending',
        to: 'in_progress',
        before: {},
        after: {},
      },
      { ctx: { trace_id }, severity: 'info', source_subsystem: 'jsonb-test' },
    );
    emitEvent(
      'state_transition',
      {
        entity_kind: 'task',
        entity_id: 'task-trace-probe-b',
        from: 'in_progress',
        to: 'done',
        before: {},
        after: {},
      },
      { ctx: { trace_id }, severity: 'info', source_subsystem: 'jsonb-test' },
    );

    await flushNow();

    const rows = (await sql`
      SELECT id
      FROM genie_runtime_events
      WHERE id > ${Number(max_id)}
        AND data->>'_trace_id' = ${trace_id}
      ORDER BY id
    `) as Array<{ id: number }>;

    expect(rows.length).toBe(2);
  });
});
