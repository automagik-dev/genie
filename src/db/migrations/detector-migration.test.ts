/**
 * Idempotency tests for migration 043 (self-healing detector schema).
 *
 * Wish: genie-self-healing-observability-b1-detectors (Group 1 / Phase 0).
 *
 * Verifies:
 *   - the detector_version column lands on the partitioned parent and both
 *     sibling tables (debug / audit)
 *   - the three partial indexes exist
 *   - re-applying the migration body against the already-migrated schema
 *     produces ZERO net schema diff (strict idempotency)
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Sql, getConnection } from '../../lib/db.js';
import { DB_AVAILABLE, setupTestDatabase } from '../../lib/test-db.js';

const MIGRATIONS_DIR = join(import.meta.dir);
const MIGRATION_FILE = '043_detector_events_schema.sql';

function loadMigration(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name), 'utf-8');
}

/**
 * Snapshot the columns (name + data type) of the three runtime-event tables
 * plus every index defined on them. Used as the before/after fingerprint for
 * idempotency checks.
 */
async function fingerprintSchema(sql: Sql): Promise<{ columns: string[]; indexes: string[] }> {
  const cols = await sql<{ table_name: string; column_name: string; data_type: string }[]>`
    SELECT table_name, column_name, data_type
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name IN (
         'genie_runtime_events',
         'genie_runtime_events_debug',
         'genie_runtime_events_audit'
       )
     ORDER BY table_name, column_name
  `;
  const idx = await sql<{ tablename: string; indexname: string; indexdef: string }[]>`
    SELECT tablename, indexname, indexdef
      FROM pg_indexes
     WHERE schemaname = current_schema()
       AND tablename IN (
         'genie_runtime_events',
         'genie_runtime_events_debug',
         'genie_runtime_events_audit'
       )
     ORDER BY tablename, indexname
  `;
  return {
    columns: cols.map(
      (c: { table_name: string; column_name: string; data_type: string }) =>
        `${c.table_name}.${c.column_name}:${c.data_type}`,
    ),
    indexes: idx.map(
      (i: { tablename: string; indexname: string; indexdef: string }) => `${i.tablename}.${i.indexname}=${i.indexdef}`,
    ),
  };
}

describe.skipIf(!DB_AVAILABLE)('043 detector_events_schema migration', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanup();
  });

  test('detector_version column exists on parent + both siblings', async () => {
    const sql = await getConnection();
    const rows = await sql<{ table_name: string }[]>`
      SELECT table_name
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND column_name = 'detector_version'
         AND table_name IN (
           'genie_runtime_events',
           'genie_runtime_events_debug',
           'genie_runtime_events_audit'
         )
       ORDER BY table_name
    `;
    const tables = rows.map((r: { table_name: string }) => r.table_name);
    expect(tables).toContain('genie_runtime_events');
    expect(tables).toContain('genie_runtime_events_debug');
    expect(tables).toContain('genie_runtime_events_audit');
  });

  test('partial indexes on detector_version exist on all three tables', async () => {
    const sql = await getConnection();
    const rows = await sql<{ indexname: string }[]>`
      SELECT indexname
        FROM pg_indexes
       WHERE schemaname = current_schema()
         AND indexname IN (
           'idx_runtime_events_detector_version',
           'idx_runtime_events_debug_detector_version',
           'idx_runtime_events_audit_detector_version'
         )
       ORDER BY indexname
    `;
    const names = rows.map((r: { indexname: string }) => r.indexname);
    expect(names).toContain('idx_runtime_events_detector_version');
    expect(names).toContain('idx_runtime_events_debug_detector_version');
    expect(names).toContain('idx_runtime_events_audit_detector_version');
  });

  test('inserting a row with detector_version succeeds and round-trips', async () => {
    const sql = await getConnection();
    await sql`
      INSERT INTO genie_runtime_events
        (repo_path, kind, source, agent, text, detector_version, data, created_at)
      VALUES
        ('test', 'detector.rot.backfill-no-worktree', 'detector', 'felipe',
         'probe', '2.3.0', '{"fs_check_result":"missing"}'::jsonb, now())
    `;
    const rows = await sql<{ detector_version: string | null }[]>`
      SELECT detector_version
        FROM genie_runtime_events
       WHERE kind = 'detector.rot.backfill-no-worktree'
         AND detector_version = '2.3.0'
    `;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].detector_version).toBe('2.3.0');
  });

  test('rows with NULL detector_version still insert (column is nullable)', async () => {
    const sql = await getConnection();
    await sql`
      INSERT INTO genie_runtime_events
        (repo_path, kind, source, agent, text, created_at)
      VALUES
        ('test', 'mailbox.delivery.sent', 'mailbox', 'felipe', 'not-a-detector', now())
    `;
    const rows = await sql<{ detector_version: string | null }[]>`
      SELECT detector_version
        FROM genie_runtime_events
       WHERE kind = 'mailbox.delivery.sent'
         AND text = 'not-a-detector'
    `;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].detector_version).toBeNull();
  });

  test('running the migration body twice produces zero net schema diff', async () => {
    const sql = await getConnection();
    const before = await fingerprintSchema(sql);
    const body = loadMigration(MIGRATION_FILE);

    // First re-apply (on top of the bootstrap already run).
    await sql.unsafe(body);
    const afterFirst = await fingerprintSchema(sql);
    expect(afterFirst).toEqual(before);

    // Second re-apply — same no-op contract.
    await sql.unsafe(body);
    const afterSecond = await fingerprintSchema(sql);
    expect(afterSecond).toEqual(before);
  });
});
