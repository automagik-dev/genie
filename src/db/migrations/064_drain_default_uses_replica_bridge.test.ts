import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getConnection } from '../../lib/db.js';
import { DB_AVAILABLE, setupTestDatabase } from '../../lib/test-db.js';

// Migration-replay coverage for the privilege scenario lives in
// src/lib/role-cutover.migration-replay.test.ts (the FULL migration set
// applies clean as the non-superuser scoped role after
// ensurePrivilegedBootstrapObjects has staged the bridge). This file is
// the behavioural sibling: it proves drain_default still does its job once
// the implementation routes through the SECURITY DEFINER bridge.

describe.skipIf(!DB_AVAILABLE)('migration 064 — drain_default via replica bridge', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanup();
  });

  test('drain_default returns 0 cleanly when DEFAULT is empty', async () => {
    const sql = await getConnection();
    // The function must short-circuit and return 0 — NOT throw on the
    // session_replication_role GUC. This is the regression guard for the
    // crash-loop the bridge was introduced to fix.
    const [{ drained }] = await sql<{ drained: number }[]>`
      SELECT genie_runtime_events_drain_default() AS drained
    `;
    expect(drained).toBe(0);
  });

  test('drain_default routes a stale DEFAULT row into its dated partition via the bridge', async () => {
    const sql = await getConnection();

    // Insert directly into the DEFAULT leaf with a known historical day. The
    // parent's INSERT-routing would otherwise place the row in a dated
    // partition (that is the routing the drain restores); targeting the leaf
    // sidesteps it and reproduces the stuck-row shape.
    const staleDay = '2024-01-15';
    const eventId = `bridge-test-${Date.now()}`;
    await sql.unsafe(
      `INSERT INTO genie_runtime_events_default (
         repo_path, subject, kind, source, agent, text, severity, schema_version,
         source_subsystem, created_at, tenant_id
       ) VALUES (
         '/tmp/bridge-test', $1, 'test', 'test-suite', 'bridge-test-agent',
         'replica bridge regression', 'info', 1, 'test',
         ($2::date)::timestamptz + interval '6 hours', 'default'
       )`,
      [eventId, staleDay],
    );

    // The bridge runs INSIDE drain_default; this call exercises the full
    // privilege-suppressed path. Must NOT throw, and MUST drain ≥1 row.
    const [{ drained }] = await sql<{ drained: number }[]>`
      SELECT genie_runtime_events_drain_default() AS drained
    `;
    expect(drained).toBeGreaterThanOrEqual(1);

    // The row must now live in a dated partition, not DEFAULT.
    const [{ still_in_default }] = await sql<{ still_in_default: number }[]>`
      SELECT count(*)::int AS still_in_default
        FROM genie_runtime_events_default
       WHERE subject = ${eventId}
    `;
    expect(still_in_default).toBe(0);

    // And it remains visible through the parent (which sees all partitions).
    const [{ visible }] = await sql<{ visible: number }[]>`
      SELECT count(*)::int AS visible
        FROM genie_runtime_events
       WHERE subject = ${eventId}
    `;
    expect(visible).toBe(1);
  });
});
