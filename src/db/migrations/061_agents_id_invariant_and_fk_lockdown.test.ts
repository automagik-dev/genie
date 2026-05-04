/**
 * Integration tests for migration 061 — agents_id_invariant_and_fk_lockdown.
 *
 * Group 1 of the retire-session-names-id-only wish.
 *
 * Coverage matrix (mirrors WISH §Acceptance Criteria for Group 1):
 *
 *   (a) UUID + `dir:<name>` inserts on `agents` succeed.
 *   (b) Bare-name insert on `agents` is rejected by the CHECK constraint.
 *   (c) Orphan FK insert (mailbox with non-existent to_worker, etc.) is
 *       rejected by the FK constraint.
 *   (d) Backfill resolves a representative bare-name reference (mailbox /
 *       team_chat / teams.leader / agents.reports_to / teams.members) onto
 *       its UUID peer via the (custom_name, team) composite.
 *   (e) `legacy_barename_archived` audit event is emitted per pre-existing
 *       bare-name agent row, and the row STAYS in the table with
 *       `state='archived'` (heal-not-wipe — never DELETE).
 *   (f) `agent_templates` ends up with UUID PK + unique (name, team) index.
 *   (g) `teams.members` UUID-array CHECK rejects bare-name elements on new
 *       inserts.
 *   (h) Migration is idempotent (second apply is a no-op).
 *
 * The setupTestDatabase helper clones genie_template, which has every
 * migration applied — including this one. To exercise backfill / heal
 * semantics we temporarily DROP the constraints under test, seed legacy-
 * shaped rows, and then re-apply the migration body via `sql.unsafe(...)`.
 * The migration's idempotent guards keep the re-apply safe.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getConnection } from '../../lib/db.js';
import { setupTestDatabase } from '../../lib/test-db.js';

const MIGRATION_PATH = join(import.meta.dir, '061_agents_id_invariant_and_fk_lockdown.sql');

async function loadMigration(): Promise<string> {
  return await readFile(MIGRATION_PATH, 'utf-8');
}

async function applyMigration(): Promise<void> {
  const sql = await getConnection();
  await sql.unsafe(await loadMigration());
}

/**
 * Drop every constraint / index this migration installs. Lets a test seed
 * legacy-shaped rows that the post-migration schema would otherwise reject.
 */
async function dropMigrationArtifacts(): Promise<void> {
  const sql = await getConnection();
  await sql`ALTER TABLE agents DROP CONSTRAINT IF EXISTS fk_agents_reports_to`;
  await sql`ALTER TABLE teams DROP CONSTRAINT IF EXISTS fk_teams_leader`;
  await sql`ALTER TABLE mailbox DROP CONSTRAINT IF EXISTS fk_mailbox_from_worker`;
  await sql`ALTER TABLE mailbox DROP CONSTRAINT IF EXISTS fk_mailbox_to_worker`;
  await sql`ALTER TABLE team_chat DROP CONSTRAINT IF EXISTS fk_team_chat_sender`;
  await sql`ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_id_shape_check`;
  await sql`ALTER TABLE teams DROP CONSTRAINT IF EXISTS teams_members_uuid_check`;
}

function uuid(): string {
  // UUID v4 hex shape (lowercase) that satisfies the CHECK regex.
  const a = `${Math.random().toString(16).slice(2)}${'0'.repeat(8)}`.slice(0, 8);
  const b = `${Math.random().toString(16).slice(2)}${'0'.repeat(4)}`.slice(0, 4);
  const c = `4${`${Math.random().toString(16).slice(2)}${'0'.repeat(3)}`.slice(0, 3)}`;
  const d = `8${`${Math.random().toString(16).slice(2)}${'0'.repeat(3)}`.slice(0, 3)}`;
  const e = `${Math.random().toString(16).slice(2)}${'0'.repeat(12)}`.slice(0, 12);
  return [a, b, c, d, e].join('-');
}

describe.skip('migration 061 — agents_id_invariant_and_fk_lockdown — TODO retire-session-names #175: tests timing out at 15s on CI; bun test silent-exit pattern', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    const sql = await getConnection();
    // Clean slate per test. Drop dependent rows first to keep FKs happy.
    await sql`DELETE FROM mailbox`;
    await sql`DELETE FROM team_chat`;
    await sql`DELETE FROM audit_events
              WHERE actor = 'migration:061_agents_id_invariant_and_fk_lockdown'`;
    await sql`DELETE FROM executors`;
    await sql`DELETE FROM teams`;
    await sql`DELETE FROM agents`;
    await sql`DELETE FROM agent_templates`;
  });

  // ==========================================================================
  // (a) + (b): CHECK constraint on agents.id
  // ==========================================================================

  test('UUID-shaped agents.id insert succeeds', async () => {
    const sql = await getConnection();
    const id = uuid();
    await sql`
      INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, custom_name, team)
      VALUES (${id}, '%1', 's-1', 'spawning', '/tmp', now(), 'engineer', 'demo')
    `;
    const rows = await sql<{ id: string }[]>`SELECT id FROM agents WHERE id = ${id}`;
    expect(rows.length).toBe(1);
  });

  test('dir:<name> agents.id insert succeeds', async () => {
    const sql = await getConnection();
    await sql`
      INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, custom_name)
      VALUES ('dir:engineer', '%2', 's-2', 'spawning', '/tmp', now(), 'engineer')
    `;
    const rows = await sql<{ id: string }[]>`SELECT id FROM agents WHERE id = 'dir:engineer'`;
    expect(rows.length).toBe(1);
  });

  test('bare-name agents.id insert is rejected by CHECK constraint', async () => {
    const sql = await getConnection();
    await expect(
      sql`
        INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, custom_name)
        VALUES ('felipe', '%3', 's-3', 'spawning', '/tmp', now(), 'felipe')
      `,
    ).rejects.toThrow(/agents_id_shape_check|check constraint/i);
  });

  test('UUID-shape with capital letters is rejected (regex is lowercase-only)', async () => {
    // The CHECK regex enforces lowercase hex; inserts with uppercase UUIDs
    // fail loudly. This locks producers to a single canonical casing.
    const sql = await getConnection();
    await expect(
      sql`
        INSERT INTO agents (id, pane_id, session, state, repo_path, started_at)
        VALUES ('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE', '%4', 's-4', 'spawning', '/tmp', now())
      `,
    ).rejects.toThrow(/agents_id_shape_check|check constraint/i);
  });

  // ==========================================================================
  // (c): FK constraints
  // ==========================================================================

  test('mailbox FK rejects insert with non-existent to_worker', async () => {
    const sql = await getConnection();
    const ghostId = uuid();
    const senderId = uuid();
    await sql`
      INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, custom_name)
      VALUES (${senderId}, '%5', 's-5', 'spawning', '/tmp', now(), 'sender')
    `;
    await expect(
      sql`
        INSERT INTO mailbox (id, from_worker, to_worker, body, repo_path)
        VALUES (${`msg-${Date.now()}`}, ${senderId}, ${ghostId}, 'hi', '/tmp')
      `,
    ).rejects.toThrow(/fk_mailbox_to_worker|foreign key/i);
  });

  test('mailbox FK rejects insert with non-existent from_worker', async () => {
    const sql = await getConnection();
    const ghostId = uuid();
    const recipientId = uuid();
    await sql`
      INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, custom_name)
      VALUES (${recipientId}, '%6', 's-6', 'spawning', '/tmp', now(), 'recip')
    `;
    await expect(
      sql`
        INSERT INTO mailbox (id, from_worker, to_worker, body, repo_path)
        VALUES (${`msg-${Date.now()}`}, ${ghostId}, ${recipientId}, 'hi', '/tmp')
      `,
    ).rejects.toThrow(/fk_mailbox_from_worker|foreign key/i);
  });

  test('team_chat FK rejects insert with non-existent sender', async () => {
    const sql = await getConnection();
    const ghostId = uuid();
    await expect(
      sql`
        INSERT INTO team_chat (id, team, repo_path, sender, body)
        VALUES (${`tc-${Date.now()}`}, 'demo', '/tmp', ${ghostId}, 'hi')
      `,
    ).rejects.toThrow(/fk_team_chat_sender|foreign key/i);
  });

  test('teams.leader FK rejects non-existent agent reference', async () => {
    const sql = await getConnection();
    const ghostId = uuid();
    await expect(
      sql`
        INSERT INTO teams (name, repo, base_branch, worktree_path, leader)
        VALUES ('demo-team', '/tmp', 'main', '/tmp/wt', ${ghostId})
      `,
    ).rejects.toThrow(/fk_teams_leader|foreign key/i);
  });

  test('agents.reports_to FK rejects non-existent parent reference', async () => {
    const sql = await getConnection();
    const ghostId = uuid();
    const childId = uuid();
    await expect(
      sql`
        INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, custom_name, reports_to)
        VALUES (${childId}, '%7', 's-7', 'spawning', '/tmp', now(), 'child', ${ghostId})
      `,
    ).rejects.toThrow(/fk_agents_reports_to|foreign key/i);
  });

  test('FK ON DELETE CASCADE: deleting an agent purges their mailbox rows', async () => {
    const sql = await getConnection();
    const senderId = uuid();
    const recipId = uuid();
    await sql`
      INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, custom_name)
      VALUES
        (${senderId}, '%8', 's-8', 'spawning', '/tmp', now(), 'sender'),
        (${recipId}, '%9', 's-9', 'spawning', '/tmp', now(), 'recip')
    `;
    const msgId = `msg-${Date.now()}-cascade`;
    await sql`
      INSERT INTO mailbox (id, from_worker, to_worker, body, repo_path)
      VALUES (${msgId}, ${senderId}, ${recipId}, 'hi', '/tmp')
    `;
    await sql`DELETE FROM agents WHERE id = ${recipId}`;
    const rows = await sql<{ id: string }[]>`SELECT id FROM mailbox WHERE id = ${msgId}`;
    expect(rows.length).toBe(0);
  });

  test('FK ON DELETE SET NULL: deleting a leader nulls teams.leader', async () => {
    const sql = await getConnection();
    const leaderId = uuid();
    await sql`
      INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, custom_name)
      VALUES (${leaderId}, '%10', 's-10', 'spawning', '/tmp', now(), 'lead')
    `;
    await sql`
      INSERT INTO teams (name, repo, base_branch, worktree_path, leader)
      VALUES ('cascade-test', '/tmp', 'main', '/tmp/wt', ${leaderId})
    `;
    await sql`DELETE FROM agents WHERE id = ${leaderId}`;
    const rows = await sql<{ leader: string | null }[]>`
      SELECT leader FROM teams WHERE name = 'cascade-test'
    `;
    expect(rows[0].leader).toBeNull();
  });

  // ==========================================================================
  // (d): Backfill — bare-name → UUID via (custom_name, team)
  // ==========================================================================

  test('backfill rewrites mailbox.to_worker bare-name to UUID peer', async () => {
    const sql = await getConnection();
    const peerId = uuid();
    await dropMigrationArtifacts();
    await sql`
      INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, custom_name, team)
      VALUES (${peerId}, '%11', 's-11', 'spawning', '/tmp', now(), 'engineer', 'demo')
    `;
    const senderId = uuid();
    await sql`
      INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, custom_name)
      VALUES (${senderId}, '%13', 's-13', 'spawning', '/tmp', now(), 'sender')
    `;
    const msgId = `msg-${Date.now()}-bf1`;
    await sql`
      INSERT INTO mailbox (id, from_worker, to_worker, body, repo_path)
      VALUES (${msgId}, ${senderId}, 'engineer', 'hi', '/tmp')
    `;

    await applyMigration();

    const rows = await sql<{ to_worker: string }[]>`
      SELECT to_worker FROM mailbox WHERE id = ${msgId}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].to_worker).toBe(peerId);
  });

  test('backfill rewrites teams.leader bare-name to UUID peer', async () => {
    const sql = await getConnection();
    const peerId = uuid();
    await dropMigrationArtifacts();
    await sql`
      INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, custom_name, team)
      VALUES (${peerId}, '%14', 's-14', 'spawning', '/tmp', now(), 'felipe', 'felipe')
    `;
    await sql`
      INSERT INTO teams (name, repo, base_branch, worktree_path, leader)
      VALUES ('felipe', '/tmp', 'main', '/tmp/wt', 'felipe')
    `;

    await applyMigration();

    const rows = await sql<{ leader: string | null }[]>`
      SELECT leader FROM teams WHERE name = 'felipe'
    `;
    expect(rows[0].leader).toBe(peerId);
  });

  test('backfill rewrites agents.reports_to bare-name to UUID peer', async () => {
    const sql = await getConnection();
    const parentId = uuid();
    const childId = uuid();
    await dropMigrationArtifacts();
    await sql`
      INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, custom_name, team)
      VALUES (${parentId}, '%15', 's-15', 'spawning', '/tmp', now(), 'lead', 'demo')
    `;
    await sql`
      INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, custom_name, team, reports_to)
      VALUES (${childId}, '%16', 's-16', 'spawning', '/tmp', now(), 'child', 'demo', 'lead')
    `;

    await applyMigration();

    const rows = await sql<{ reports_to: string | null }[]>`
      SELECT reports_to FROM agents WHERE id = ${childId}
    `;
    expect(rows[0].reports_to).toBe(parentId);
  });

  test('backfill rewrites teams.members bare-name elements to UUIDs', async () => {
    const sql = await getConnection();
    const aliceId = uuid();
    const bobId = uuid();
    await dropMigrationArtifacts();
    await sql`
      INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, custom_name, team)
      VALUES
        (${aliceId}, '%17', 's-17', 'spawning', '/tmp', now(), 'alice', 'crew'),
        (${bobId},   '%18', 's-18', 'spawning', '/tmp', now(), 'bob',   'crew')
    `;
    await sql`
      INSERT INTO teams (name, repo, base_branch, worktree_path, members)
      VALUES ('crew', '/tmp', 'main', '/tmp/wt', '["alice", "bob"]'::jsonb)
    `;

    await applyMigration();

    const rows = await sql<{ members: string[] }[]>`
      SELECT members FROM teams WHERE name = 'crew'
    `;
    expect(rows[0].members.sort()).toEqual([aliceId, bobId].sort());
  });

  // ==========================================================================
  // (e): Heal-not-wipe — bare-name agent rows STAY (state='archived' + audit)
  // ==========================================================================

  test('legacy_barename_archived audit event captures identity columns; row stays', async () => {
    const sql = await getConnection();
    await dropMigrationArtifacts();
    await sql`
      INSERT INTO agents (id, role, custom_name, team, repo_path, pane_id, session,
                          state, started_at, auto_resume)
      VALUES ('felipe-trace-99', 'felipe', NULL, 'felipe', '/some/path',
              '%20', 's-20', 'idle', now(), true)
    `;

    await applyMigration();

    // Heal-not-wipe: row STAYS, but flipped to archived.
    const survivors = await sql<{ id: string; state: string | null; auto_resume: boolean | null }[]>`
      SELECT id, state, auto_resume FROM agents WHERE id = 'felipe-trace-99'
    `;
    expect(survivors.length).toBe(1);
    expect(survivors[0].state).toBe('archived');
    expect(survivors[0].auto_resume).toBe(false);

    // Audit row preserves identity columns for compliance.
    const archived = await sql<{ details: Record<string, unknown> }[]>`
      SELECT details FROM audit_events
       WHERE actor = 'migration:061_agents_id_invariant_and_fk_lockdown'
         AND event_type = 'legacy_barename_archived'
         AND entity_id = 'felipe-trace-99'
    `;
    expect(archived.length).toBe(1);
    expect(archived[0].details.role).toBe('felipe');
    expect(archived[0].details.team).toBe('felipe');
    expect(archived[0].details.repo_path).toBe('/some/path');
    expect(archived[0].details.reason).toBe('pre_check_constraint_archive');
  });

  test('CHECK is NOT VALID — pre-existing bare-name row survives, new bare-name insert blocked', async () => {
    const sql = await getConnection();
    await dropMigrationArtifacts();
    await sql`
      INSERT INTO agents (id, custom_name, team, repo_path, pane_id, session, started_at)
      VALUES ('legacy-bare', NULL, 'demo', '/tmp', '%22', 's-22', now())
    `;
    await applyMigration();

    // Legacy row grandfathered (NOT VALID skips existing-row validation).
    const legacy = await sql<{ id: string }[]>`SELECT id FROM agents WHERE id = 'legacy-bare'`;
    expect(legacy.length).toBe(1);

    // New bare-name insert still rejected.
    await expect(
      sql`
        INSERT INTO agents (id, custom_name, team, repo_path, pane_id, session, started_at)
        VALUES ('another-bare', NULL, 'demo', '/tmp', '%23', 's-23', now())
      `,
    ).rejects.toThrow(/agents_id_shape_check|check constraint/i);
  });

  // ==========================================================================
  // (f): agent_templates schema upgrade
  // ==========================================================================

  test('agent_templates id column is UUID after migration', async () => {
    const sql = await getConnection();
    const rows = await sql<{ data_type: string; column_default: string | null }[]>`
      SELECT data_type, column_default
        FROM information_schema.columns
       WHERE table_name = 'agent_templates'
         AND column_name = 'id'
         AND table_schema = current_schema()
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].data_type).toBe('uuid');
    expect(rows[0].column_default ?? '').toContain('gen_random_uuid');
  });

  test('agent_templates has name TEXT NOT NULL column', async () => {
    const sql = await getConnection();
    const rows = await sql<{ data_type: string; is_nullable: string }[]>`
      SELECT data_type, is_nullable
        FROM information_schema.columns
       WHERE table_name = 'agent_templates'
         AND column_name = 'name'
         AND table_schema = current_schema()
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].data_type).toBe('text');
    expect(rows[0].is_nullable).toBe('NO');
  });

  test('agent_templates idx_agent_templates_name_team unique partial index exists', async () => {
    const sql = await getConnection();
    const rows = await sql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
       WHERE tablename = 'agent_templates'
         AND indexname = 'idx_agent_templates_name_team'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].indexdef).toMatch(/UNIQUE/i);
    expect(rows[0].indexdef).toMatch(/\(name, team\)/);
  });

  // ==========================================================================
  // (g): teams.members CHECK constraint
  // ==========================================================================

  test('teams.members CHECK rejects bare-name array element', async () => {
    const sql = await getConnection();
    const leaderId = uuid();
    await sql`
      INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, custom_name)
      VALUES (${leaderId}, '%30', 's-30', 'spawning', '/tmp', now(), 'lead')
    `;
    await expect(
      sql`
        INSERT INTO teams (name, repo, base_branch, worktree_path, members)
        VALUES ('bad-team', '/tmp', 'main', '/tmp/wt', '["bare-name"]'::jsonb)
      `,
    ).rejects.toThrow(/teams_members_uuid_check|check constraint/i);
  });

  test('teams.members accepts UUID and dir:<name> elements', async () => {
    const sql = await getConnection();
    const u = uuid();
    await sql`
      INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, custom_name)
      VALUES (${u}, '%31', 's-31', 'spawning', '/tmp', now(), 'm1')
    `;
    await sql`
      INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, custom_name)
      VALUES ('dir:m2', '%32', 's-32', 'spawning', '/tmp', now(), 'm2')
    `;
    const membersJson = JSON.stringify([u, 'dir:m2']);
    await sql`
      INSERT INTO teams (name, repo, base_branch, worktree_path, members)
      VALUES ('ok-team', '/tmp', 'main', '/tmp/wt', ${membersJson}::jsonb)
    `;
    const rows = await sql<{ members: string[] }[]>`SELECT members FROM teams WHERE name = 'ok-team'`;
    expect(rows[0].members.sort()).toEqual([u, 'dir:m2'].sort());
  });

  // ==========================================================================
  // (h): Idempotency
  // ==========================================================================

  test('migration is idempotent: second apply is a no-op', async () => {
    const sql = await getConnection();
    const before = {
      agents: await sql<{ cnt: number }[]>`SELECT count(*)::int AS cnt FROM agents`,
      audit: await sql<{ cnt: number }[]>`
        SELECT count(*)::int AS cnt FROM audit_events
         WHERE actor = 'migration:061_agents_id_invariant_and_fk_lockdown'`,
    };

    await applyMigration();

    const after = {
      agents: await sql<{ cnt: number }[]>`SELECT count(*)::int AS cnt FROM agents`,
      audit: await sql<{ cnt: number }[]>`
        SELECT count(*)::int AS cnt FROM audit_events
         WHERE actor = 'migration:061_agents_id_invariant_and_fk_lockdown'`,
    };

    expect(after.agents[0].cnt).toBe(before.agents[0].cnt);
    expect(after.audit[0].cnt).toBe(before.audit[0].cnt);
  });

  test('every migration-installed constraint is still present after a second apply', async () => {
    await applyMigration();
    const sql = await getConnection();
    const conNames = [
      'fk_agents_reports_to',
      'fk_teams_leader',
      'fk_mailbox_from_worker',
      'fk_mailbox_to_worker',
      'fk_team_chat_sender',
      'agents_id_shape_check',
      'teams_members_uuid_check',
    ];
    const rows = await sql<{ conname: string }[]>`
      SELECT conname FROM pg_constraint WHERE conname = ANY(${conNames})
    `;
    expect(rows.length).toBe(conNames.length);
  });
});
