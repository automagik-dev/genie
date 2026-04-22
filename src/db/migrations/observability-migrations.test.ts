/**
 * Idempotency tests for Group 1 observability migrations (037-040).
 *
 * Wish: genie-serve-structured-observability. Each migration is re-applied
 * against a fresh test schema after the initial migration run; re-application
 * must not error (IF NOT EXISTS + guard clauses).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConnection } from '../../lib/db.js';
import { DB_AVAILABLE, setupTestDatabase } from '../../lib/test-db.js';

const MIGRATIONS_DIR = join(import.meta.dir);

function loadMigration(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name), 'utf-8');
}

describe.skipIf(!DB_AVAILABLE)('Group 1 observability migrations', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanup();
  });

  test('genie_runtime_events has the Group 1 OTEL columns', async () => {
    const sql = await getConnection();
    const cols = await sql<{ column_name: string }[]>`
      SELECT column_name
        FROM information_schema.columns
       WHERE table_name = 'genie_runtime_events'
         AND table_schema = current_schema()
    `;
    const names = new Set((cols as Array<{ column_name: string }>).map((r) => r.column_name));
    for (const expected of [
      'span_id',
      'parent_span_id',
      'severity',
      'schema_version',
      'duration_ms',
      'dedup_key',
      'source_subsystem',
    ]) {
      expect(names.has(expected)).toBe(true);
    }
  });

  test('severity CHECK constraint rejects invalid levels', async () => {
    const sql = await getConnection();
    let err: Error | null = null;
    try {
      await sql`
        INSERT INTO genie_runtime_events (repo_path, kind, source, agent, text, severity, created_at)
        VALUES ('test', 'test.kind', 'test', 'test', 'test', 'bogus', now())
      `;
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeTruthy();
    expect(err?.message).toMatch(/check constraint/i);
  });

  test('severity CHECK allows valid levels', async () => {
    const sql = await getConnection();
    for (const level of ['debug', 'info', 'warn', 'error', 'fatal']) {
      await sql`
        INSERT INTO genie_runtime_events (repo_path, kind, source, agent, text, severity, created_at)
        VALUES ('test', 'test.kind', 'test', 'test', 'test', ${level}, now())
      `;
    }
  });

  test('genie_runtime_events is partitioned', async () => {
    const sql = await getConnection();
    const rows = await sql<{ relkind: string }[]>`
      SELECT c.relkind::TEXT AS relkind
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relname = 'genie_runtime_events'
         AND n.nspname = current_schema()
    `;
    expect(rows[0]?.relkind).toBe('p');
  });

  test('rolling partitions exist for today/yesterday/tomorrow', async () => {
    const sql = await getConnection();
    const parts = await sql<{ relname: string }[]>`
      SELECT c.relname
        FROM pg_inherits i
        JOIN pg_class   c ON i.inhrelid = c.oid
        JOIN pg_class   p ON i.inhparent = p.oid
       WHERE p.relname = 'genie_runtime_events'
         AND c.relname ~ '^genie_runtime_events_p[0-9]{8}$'
    `;
    expect(parts.length).toBeGreaterThanOrEqual(3);
  });

  test('maintain_partitions helper is idempotent and returns JSON', async () => {
    const sql = await getConnection();
    const result = await sql<{ r: { created_or_present: number; dropped: number } }[]>`
      SELECT genie_runtime_events_maintain_partitions(2, 30)::jsonb AS r
    `;
    expect(result[0].r.created_or_present).toBeGreaterThan(0);

    // Re-run — should still succeed, just returning same info.
    await sql`SELECT genie_runtime_events_maintain_partitions(2, 30)`;
  });

  test('sibling tables exist with correct shape', async () => {
    const sql = await getConnection();
    const dbg = await sql<{ column_name: string }[]>`
      SELECT column_name
        FROM information_schema.columns
       WHERE table_name = 'genie_runtime_events_debug'
         AND table_schema = current_schema()
    `;
    const aud = await sql<{ column_name: string }[]>`
      SELECT column_name
        FROM information_schema.columns
       WHERE table_name = 'genie_runtime_events_audit'
         AND table_schema = current_schema()
    `;
    expect(dbg.length).toBeGreaterThan(10);
    expect(aud.length).toBeGreaterThan(10);
    // Audit has chain columns.
    expect((aud as Array<{ column_name: string }>).some((c) => c.column_name === 'chain_hash')).toBe(true);
    expect((aud as Array<{ column_name: string }>).some((c) => c.column_name === 'chain_key_version')).toBe(true);
  });

  test('audit chain hash is computed server-side', async () => {
    const sql = await getConnection();
    await sql`
      INSERT INTO genie_runtime_events_audit (repo_path, kind, source, agent, text)
      VALUES ('test', 'audit.sample', 'test', 'test', 'first')
    `;
    await sql`
      INSERT INTO genie_runtime_events_audit (repo_path, kind, source, agent, text)
      VALUES ('test', 'audit.sample', 'test', 'test', 'second')
    `;
    const rows = await sql<{ chain_hash: Buffer }[]>`
      SELECT chain_hash FROM genie_runtime_events_audit ORDER BY id
    `;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) {
      expect(r.chain_hash).toBeTruthy();
      expect(r.chain_hash.length).toBe(32); // SHA256 / HMAC-SHA256 digest
    }
    // Different rows should have different chain hashes.
    expect(rows[0].chain_hash.toString('hex')).not.toBe(rows[1].chain_hash.toString('hex'));
  });

  test('audit chain rejects client-supplied chain_hash', async () => {
    const sql = await getConnection();
    let err: Error | null = null;
    try {
      await sql`
        INSERT INTO genie_runtime_events_audit (repo_path, kind, source, agent, text, chain_hash)
        VALUES ('test', 'audit.sample', 'test', 'test', 'forged', decode('deadbeef' || repeat('00', 28), 'hex'))
      `;
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeTruthy();
    expect(err?.message).toMatch(/chain_hash is server-computed/);
  });

  test('audit table rejects UPDATE and DELETE (WORM)', async () => {
    const sql = await getConnection();
    await sql`
      INSERT INTO genie_runtime_events_audit (repo_path, kind, source, agent, text)
      VALUES ('test', 'audit.worm', 'test', 'test', 'worm-row')
    `;

    let updateErr: Error | null = null;
    try {
      await sql`UPDATE genie_runtime_events_audit SET text = 'tampered' WHERE kind = 'audit.worm'`;
    } catch (e) {
      updateErr = e as Error;
    }
    expect(updateErr).toBeTruthy();
    expect(updateErr?.message).toMatch(/append-only/);

    let deleteErr: Error | null = null;
    try {
      await sql`DELETE FROM genie_runtime_events_audit WHERE kind = 'audit.worm'`;
    } catch (e) {
      deleteErr = e as Error;
    }
    expect(deleteErr).toBeTruthy();
    expect(deleteErr?.message).toMatch(/append-only/);
  });

  test('Group 1 migrations are idempotent on re-apply', async () => {
    // Re-run each migration body against the already-migrated schema and
    // confirm the guarded statements are all no-ops.
    const sql = await getConnection();
    for (const name of [
      '037_runtime_events_otel_columns.sql',
      '039_runtime_events_siblings.sql',
      '040_listen_channel_split.sql',
    ]) {
      const body = loadMigration(name);
      await sql.unsafe(body);
    }
    // 038 is also idempotent: the DO block short-circuits when relkind='p'.
    const body = loadMigration('038_runtime_events_partition.sql');
    await sql.unsafe(body);
  });
});
