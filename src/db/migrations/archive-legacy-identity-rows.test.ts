/**
 * Integration tests for migration 050 — archive_legacy_identity_rows.
 *
 * Covers Group 5 acceptance criteria from the invincible-genie wish:
 *   - `felipe-trace-*` rows are quiesced (auto_resume flipped to false).
 *   - Legacy bare-name identity rows whose UUID counterpart exists are quiesced.
 *   - Wish-named team-lead orphans (team = id, no live executor) get
 *     state='archived' + auto_resume=false.
 *   - Each flipped row emits a corresponding `audit_events` row.
 *   - The migration is idempotent: re-running it touches zero new rows.
 *   - Rows that don't match the heuristic are NEVER flipped.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getConnection } from '../../lib/db.js';
import { DB_AVAILABLE, setupTestDatabase } from '../../lib/test-db.js';

const MIGRATION_PATH = join(import.meta.dir, '050_archive_legacy_identity_rows.sql');

async function applyMigrationManually(): Promise<void> {
  const sql = await getConnection();
  const body = await readFile(MIGRATION_PATH, 'utf-8');
  await sql.unsafe(body);
}

describe.skipIf(!DB_AVAILABLE)('migration 050 — archive_legacy_identity_rows', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    const sql = await getConnection();
    // Migration runner already applied 050 once at boot. Reset the surface
    // we touch and replay manually for assertions.
    await sql`DELETE FROM audit_events WHERE actor = 'migration:050_archive_legacy_identity_rows'`;
    await sql`DELETE FROM assignments`;
    await sql`DELETE FROM executors`;
    await sql`DELETE FROM agents`;
  });

  test('quiesces felipe-trace-* rows', async () => {
    const sql = await getConnection();
    await sql`
      INSERT INTO agents (id, pane_id, session, started_at, repo_path, auto_resume, reports_to)
      VALUES ('felipe-trace-001', 'p1', 's1', now(), '/tmp', true, 'felipe'),
             ('felipe-trace-002', 'p2', 's1', now(), '/tmp', true, 'felipe')
    `;

    await applyMigrationManually();

    const rows = await sql<{ id: string; auto_resume: boolean }[]>`
      SELECT id, auto_resume FROM agents WHERE id LIKE 'felipe-trace-%' ORDER BY id
    `;
    expect(rows.length).toBe(2);
    for (const r of rows) expect(r.auto_resume).toBe(false);

    const audits = await sql<{ entity_id: string; details: { reason: string } }[]>`
      SELECT entity_id, details FROM audit_events
       WHERE actor = 'migration:050_archive_legacy_identity_rows'
         AND entity_id LIKE 'felipe-trace-%'
       ORDER BY entity_id
    `;
    expect(audits.length).toBe(2);
    for (const a of audits) expect(a.details.reason).toBe('legacy_trace_row_quiesced');
  });

  test('quiesces legacy bare-name rows when a UUID counterpart exists', async () => {
    const sql = await getConnection();
    await sql`
      INSERT INTO agents (id, pane_id, session, started_at, repo_path, auto_resume, reports_to, custom_name)
      VALUES ('felipe',                                'p3', 's1', now(), '/tmp', true,  NULL, NULL),
             ('00000000-0000-0000-0000-000000000001', 'p4', 's1', now(), '/tmp', true,  NULL, 'felipe')
    `;

    await applyMigrationManually();

    const legacy = await sql<{ id: string; auto_resume: boolean }[]>`
      SELECT id, auto_resume FROM agents WHERE id = 'felipe'
    `;
    expect(legacy.length).toBe(1);
    expect(legacy[0].auto_resume).toBe(false);

    // The UUID-keyed peer is left untouched.
    const peer = await sql<{ auto_resume: boolean }[]>`
      SELECT auto_resume FROM agents WHERE id = '00000000-0000-0000-0000-000000000001'
    `;
    expect(peer[0].auto_resume).toBe(true);
  });

  test('does NOT quiesce a bare-name row when no UUID counterpart exists', async () => {
    const sql = await getConnection();
    await sql`
      INSERT INTO agents (id, pane_id, session, started_at, repo_path, auto_resume, reports_to, custom_name)
      VALUES ('orphan-bare-name', 'p5', 's1', now(), '/tmp', true, NULL, NULL)
    `;

    await applyMigrationManually();

    const rows = await sql<{ auto_resume: boolean }[]>`
      SELECT auto_resume FROM agents WHERE id = 'orphan-bare-name'
    `;
    expect(rows[0].auto_resume).toBe(true);
  });

  test('archives wish-named team-lead orphans (team = id, no live executor)', async () => {
    const sql = await getConnection();
    await sql`
      INSERT INTO agents (id, pane_id, session, started_at, repo_path, auto_resume, reports_to, team, state)
      VALUES ('design-system-severance', 'p6', 's1', now(), '/tmp', true, NULL, 'design-system-severance', 'idle')
    `;

    await applyMigrationManually();

    const rows = await sql<{ auto_resume: boolean; state: string }[]>`
      SELECT auto_resume, state FROM agents WHERE id = 'design-system-severance'
    `;
    expect(rows[0].auto_resume).toBe(false);
    expect(rows[0].state).toBe('archived');
  });

  test('does NOT archive a wish-named row that has a live executor', async () => {
    const sql = await getConnection();
    await sql`
      INSERT INTO agents (id, pane_id, session, started_at, repo_path, auto_resume, reports_to, team, state)
      VALUES ('still-running', 'p7', 's1', now(), '/tmp', true, NULL, 'still-running', 'idle')
    `;
    await sql`
      INSERT INTO executors (id, agent_id, provider, transport, state)
      VALUES ('exec-1', 'still-running', 'claude', 'tmux', 'running')
    `;

    await applyMigrationManually();

    const rows = await sql<{ auto_resume: boolean; state: string }[]>`
      SELECT auto_resume, state FROM agents WHERE id = 'still-running'
    `;
    expect(rows[0].auto_resume).toBe(true);
    expect(rows[0].state).toBe('idle');
  });

  test('is idempotent — second application touches zero rows', async () => {
    const sql = await getConnection();
    await sql`
      INSERT INTO agents (id, pane_id, session, started_at, repo_path, auto_resume, reports_to)
      VALUES ('felipe-trace-idem', 'p8', 's1', now(), '/tmp', true, 'felipe')
    `;

    await applyMigrationManually();
    const firstAuditCount = await sql<{ cnt: number }[]>`
      SELECT count(*)::int AS cnt FROM audit_events WHERE actor = 'migration:050_archive_legacy_identity_rows'
    `;

    await applyMigrationManually();
    const secondAuditCount = await sql<{ cnt: number }[]>`
      SELECT count(*)::int AS cnt FROM audit_events WHERE actor = 'migration:050_archive_legacy_identity_rows'
    `;

    expect(secondAuditCount[0].cnt).toBe(firstAuditCount[0].cnt);
  });
});
