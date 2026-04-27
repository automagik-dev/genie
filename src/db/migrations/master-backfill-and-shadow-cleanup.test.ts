/**
 * Integration tests for migration 053 — master_backfill_and_shadow_cleanup.
 *
 * Covers Group 14 sub-deliverables 14a (bare-name shadow archival) and 14b
 * (master backfill of dir:<name> rows).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getConnection } from '../../lib/db.js';
import { DB_AVAILABLE, setupTestDatabase } from '../../lib/test-db.js';

const MIGRATION_PATH = join(import.meta.dir, '053_master_backfill_and_shadow_cleanup.sql');

async function applyMigrationManually(): Promise<void> {
  const sql = await getConnection();
  const body = await readFile(MIGRATION_PATH, 'utf-8');
  await sql.unsafe(body);
}

describe.skipIf(!DB_AVAILABLE)('migration 053 — master_backfill_and_shadow_cleanup', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    const sql = await getConnection();
    await sql`DELETE FROM audit_events WHERE actor = 'migration:053_master_backfill_and_shadow_cleanup'`;
    await sql`DELETE FROM assignments`;
    await sql`DELETE FROM executors`;
    await sql`DELETE FROM agents`;
  });

  // ==========================================================================
  // 14b — master backfill: dir:<name> created from existing canonical fields
  // ==========================================================================

  test('14b: backfills dir:felipe from a bare felipe row (Type-B shape)', async () => {
    const sql = await getConnection();
    // Twin's analysis: the bare row is the only candidate carrying
    // repo_path. `custom_name` is empty/null in production (the partial
    // unique index `idx_agents_custom_name_team` requires it to be unique
    // when populated alongside team — bare rows skirt that by leaving it
    // null); role is the canonical identity.
    await sql`
      INSERT INTO agents (id, role, custom_name, team, repo_path, started_at, state, auto_resume, reports_to)
      VALUES ('felipe', 'felipe', NULL, 'felipe', '/home/genie/workspace/agents/felipe', now(), NULL, true, NULL)
    `;

    await applyMigrationManually();

    const dirRow = await sql<
      { id: string; role: string; custom_name: string | null; team: string; repo_path: string }[]
    >`
      SELECT id, role, custom_name, team, repo_path
      FROM agents WHERE id = 'dir:felipe'
    `;
    expect(dirRow.length).toBe(1);
    expect(dirRow[0].role).toBe('felipe');
    expect(dirRow[0].custom_name).toBe('felipe');
    expect(dirRow[0].team).toBe('felipe');
    expect(dirRow[0].repo_path).toBe('/home/genie/workspace/agents/felipe');

    const audit = await sql<{ details: { reason: string; group: string } }[]>`
      SELECT details FROM audit_events
       WHERE actor = 'migration:053_master_backfill_and_shadow_cleanup'
         AND entity_id = 'dir:felipe'
         AND event_type = 'directory.master_backfilled'
    `;
    expect(audit.length).toBe(1);
    expect(audit[0].details.reason).toBe('master_backfill');
    expect(audit[0].details.group).toBe('14b');
  });

  test('14b: backfills dir:genie and dir:genie-pgserve from twin-shape masters', async () => {
    const sql = await getConnection();
    await sql`
      INSERT INTO agents (id, role, custom_name, team, repo_path, started_at, state, auto_resume, reports_to)
      VALUES
        ('genie', 'genie', NULL, 'genie', '/home/genie/workspace/agents/genie', now(), 'idle', true, NULL),
        ('genie-pgserve', 'genie-pgserve', NULL, 'genie', '/home/genie/workspace/agents/genie-pgserve', now(), NULL, true, NULL)
    `;

    await applyMigrationManually();

    const created = await sql<{ id: string }[]>`
      SELECT id FROM agents WHERE id LIKE 'dir:%' ORDER BY id
    `;
    expect(created.map((r: { id: string }) => r.id)).toEqual(['dir:genie', 'dir:genie-pgserve']);

    const repoPaths = await sql<{ id: string; repo_path: string }[]>`
      SELECT id, repo_path FROM agents WHERE id LIKE 'dir:%' ORDER BY id
    `;
    const byId = new Map(repoPaths.map((r: { id: string; repo_path: string }) => [r.id, r.repo_path]));
    expect(byId.get('dir:genie')).toBe('/home/genie/workspace/agents/genie');
    expect(byId.get('dir:genie-pgserve')).toBe('/home/genie/workspace/agents/genie-pgserve');
  });

  test('14b: NULLs custom_name when (name, team) slot is held by another live peer', async () => {
    const sql = await getConnection();
    // Production Type-B: UUID peer holds (custom_name='felipe', team='felipe')
    // in the unique partial index. The bare row lacks dir:<name>. Backfilling
    // dir:felipe with custom_name='felipe' team='felipe' would conflict with
    // the index, so the migration must NULL custom_name on the new row.
    await sql`
      INSERT INTO agents (id, role, custom_name, team, repo_path, started_at, state, auto_resume, reports_to)
      VALUES
        ('00000000-0000-0000-0000-feedfacefeed', 'felipe', 'felipe', 'felipe', '/some/uuid/path', now(), 'idle', true, NULL),
        ('felipe', 'felipe', NULL, 'felipe', '/home/genie/workspace/agents/felipe', now(), 'idle', true, NULL)
    `;

    await applyMigrationManually();

    const dirRow = await sql<{ custom_name: string | null }[]>`
      SELECT custom_name FROM agents WHERE id = 'dir:felipe'
    `;
    expect(dirRow.length).toBe(1);
    expect(dirRow[0].custom_name).toBeNull();
  });

  test('14b: skips agents that already have a dir:<name> peer (no duplicate insert)', async () => {
    const sql = await getConnection();
    await sql`
      INSERT INTO agents (id, role, custom_name, team, repo_path, started_at, state, auto_resume, reports_to)
      VALUES ('dir:email', 'email', 'email', 'felipe', '/home/genie/workspace/agents/email', now(), NULL, true, NULL)
    `;
    await sql`
      INSERT INTO agents (id, role, custom_name, team, repo_path, started_at, state, auto_resume, reports_to)
      VALUES ('email', 'email', NULL, 'felipe', '/home/genie/workspace/agents/email', now(), NULL, true, NULL)
    `;

    await applyMigrationManually();

    const dirRows = await sql<{ id: string }[]>`
      SELECT id FROM agents WHERE id LIKE 'dir:%' ORDER BY id
    `;
    expect(dirRows.length).toBe(1);
    expect(dirRows[0].id).toBe('dir:email');
  });

  test('14b: skips bare task-shaped rows (kind=task / archived / no repo_path)', async () => {
    const sql = await getConnection();
    await sql`
      INSERT INTO agents (id, role, custom_name, team, repo_path, started_at, state, auto_resume, reports_to)
      VALUES
        ('engineer-w2g3', 'engineer', 'engineer', 'master-aware-spawn', '/some/path', now(), 'idle', true, 'team-lead-uuid'),
        ('archived-master', 'archived', '', 'archived', '/some/path', now(), 'archived', true, NULL),
        ('no-repo-master', 'foo', '', 'foo', NULL, now(), NULL, true, NULL)
    `;

    await applyMigrationManually();

    const dirRows = await sql<{ id: string }[]>`SELECT id FROM agents WHERE id LIKE 'dir:%'`;
    expect(dirRows.length).toBe(0);
  });

  // ==========================================================================
  // 14a — bare-name shadow cleanup (heal-not-wipe)
  // ==========================================================================

  test('14a: archives bare-name shadow when dir:<name> peer exists (no executor)', async () => {
    const sql = await getConnection();
    await sql`
      INSERT INTO agents (id, role, custom_name, team, repo_path, started_at, state, auto_resume, reports_to)
      VALUES
        ('dir:email', 'email', 'email', 'felipe', '/home/genie/workspace/agents/email', now(), NULL, false, NULL),
        ('email', 'email', NULL, 'felipe', '/home/genie/workspace/agents/email', now(), NULL, true, NULL)
    `;

    await applyMigrationManually();

    const bare = await sql<{ state: string | null; auto_resume: boolean }[]>`
      SELECT state, auto_resume FROM agents WHERE id = 'email'
    `;
    expect(bare[0].state).toBe('archived');
    expect(bare[0].auto_resume).toBe(false);

    // dir: row left intact.
    const dir = await sql<{ state: string | null; repo_path: string }[]>`
      SELECT state, repo_path FROM agents WHERE id = 'dir:email'
    `;
    expect(dir[0].state).toBeNull();
    expect(dir[0].repo_path).toBe('/home/genie/workspace/agents/email');

    const audit = await sql<{ details: { reason: string; group: string } }[]>`
      SELECT details FROM audit_events
       WHERE actor = 'migration:053_master_backfill_and_shadow_cleanup'
         AND entity_id = 'email'
         AND event_type = 'state_changed'
    `;
    expect(audit.length).toBe(1);
    expect(audit[0].details.reason).toBe('bare_name_shadow_archived');
    expect(audit[0].details.group).toBe('14a');
  });

  test('14a: NEVER deletes bare-name shadow rows (heal-not-wipe contract)', async () => {
    const sql = await getConnection();
    await sql`
      INSERT INTO agents (id, role, custom_name, team, repo_path, started_at, state, auto_resume, reports_to)
      VALUES
        ('dir:email', 'email', 'email', 'felipe', '/home/genie/workspace/agents/email', now(), NULL, false, NULL),
        ('email', 'email', NULL, 'felipe', '/home/genie/workspace/agents/email', now(), NULL, true, NULL)
    `;

    await applyMigrationManually();

    // Row still exists (just archived). Wholesale deletion is the failure
    // mode the master-aware-spawn wish was born from.
    const stillThere = await sql<{ id: string; state: string | null }[]>`
      SELECT id, state FROM agents WHERE id = 'email'
    `;
    expect(stillThere.length).toBe(1);
    expect(stillThere[0].state).toBe('archived');
  });

  test('14a: leaves bare-name shadow alone when current_executor_id is set (live peer)', async () => {
    const sql = await getConnection();
    await sql`
      INSERT INTO agents (id, role, custom_name, team, repo_path, started_at, state, auto_resume, reports_to)
      VALUES
        ('dir:email', 'email', 'email', 'felipe', '/some/path', now(), NULL, false, NULL),
        ('email', 'email', NULL, 'felipe', '/some/path', now(), 'idle', true, NULL)
    `;
    // Attach a live executor to the bare row.
    await sql`
      INSERT INTO executors (id, agent_id, provider, transport, state)
      VALUES ('exec-live', 'email', 'claude', 'tmux', 'running')
    `;
    await sql`UPDATE agents SET current_executor_id = 'exec-live' WHERE id = 'email'`;

    await applyMigrationManually();

    const bare = await sql<{ state: string | null }[]>`
      SELECT state FROM agents WHERE id = 'email'
    `;
    expect(bare[0].state).toBe('idle');
  });

  test('14a: never archives UUID-shaped rows even if dir:<uuid> exists', async () => {
    const sql = await getConnection();
    const uuid = '11111111-2222-3333-4444-555555555555';
    await sql`
      INSERT INTO agents (id, role, custom_name, team, repo_path, started_at, state, auto_resume, reports_to)
      VALUES
        (${`dir:${uuid}`}, 'weird', 'weird', 'team-dir', '/p', now(), NULL, false, NULL),
        (${uuid}, 'weird', 'weird', 'team-uuid', '/p', now(), 'idle', true, NULL)
    `;

    await applyMigrationManually();

    const uuidRow = await sql<{ state: string | null }[]>`
      SELECT state FROM agents WHERE id = ${uuid}
    `;
    expect(uuidRow[0].state).toBe('idle');
  });

  // ==========================================================================
  // Composite + idempotency
  // ==========================================================================

  test('14a + 14b run in one pass: bare felipe gets archived AFTER dir:felipe is backfilled', async () => {
    const sql = await getConnection();
    // Only the bare row exists; the migration must first create dir:felipe
    // (14b) and only THEN archive the bare felipe shadow (14a).
    await sql`
      INSERT INTO agents (id, role, custom_name, team, repo_path, started_at, state, auto_resume, reports_to)
      VALUES ('felipe', 'felipe', NULL, 'felipe', '/home/genie/workspace/agents/felipe', now(), 'idle', true, NULL)
    `;

    await applyMigrationManually();

    const dir = await sql<{ id: string }[]>`SELECT id FROM agents WHERE id = 'dir:felipe'`;
    expect(dir.length).toBe(1);

    const bare = await sql<{ state: string | null; auto_resume: boolean }[]>`
      SELECT state, auto_resume FROM agents WHERE id = 'felipe'
    `;
    expect(bare[0].state).toBe('archived');
    expect(bare[0].auto_resume).toBe(false);
  });

  test('idempotent: re-running the migration touches zero new rows', async () => {
    const sql = await getConnection();
    await sql`
      INSERT INTO agents (id, role, custom_name, team, repo_path, started_at, state, auto_resume, reports_to)
      VALUES ('felipe', 'felipe', NULL, 'felipe', '/home/genie/workspace/agents/felipe', now(), 'idle', true, NULL)
    `;

    await applyMigrationManually();
    const firstAuditCount = await sql<{ cnt: number }[]>`
      SELECT count(*)::int AS cnt FROM audit_events
       WHERE actor = 'migration:053_master_backfill_and_shadow_cleanup'
    `;

    await applyMigrationManually();
    const secondAuditCount = await sql<{ cnt: number }[]>`
      SELECT count(*)::int AS cnt FROM audit_events
       WHERE actor = 'migration:053_master_backfill_and_shadow_cleanup'
    `;

    expect(secondAuditCount[0].cnt).toBe(firstAuditCount[0].cnt);
  });
});
