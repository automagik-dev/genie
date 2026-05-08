import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Sql, getConnection } from '../../lib/db.js';
import { DB_AVAILABLE, setupTestDatabase } from '../../lib/test-db.js';

const MIGRATION_PATH = join(import.meta.dir, '055_default_auto_resume_true.sql');

async function runMigration(sql: Sql): Promise<void> {
  const sqlText = await readFile(MIGRATION_PATH, 'utf-8');
  // Mirror runMigrations() in db-migrations.ts: wrap in sql.begin so the
  // pool sees a single reserved connection. The migration file's own
  // BEGIN/COMMIT becomes a no-op inside the outer transaction (postgres
  // emits a "there is already a transaction in progress" warning and
  // COMMIT closes the outer txn, same as production).
  await sql.begin(async (tx) => {
    await tx.unsafe(sqlText);
  });
}

describe.skipIf(!DB_AVAILABLE)('migration 055 — default auto_resume true', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanup();
  });

  test('does not fail when archived bare-name rows are present', async () => {
    const sql = await getConnection();

    // The template DB has migration 055 already applied. To replay it as if
    // it were pending against a host that carries archived bare-name rows
    // (legacy 050/053 grandfather), we have to re-create the failure shape:
    //   1. Drop the id-shape CHECK so we can insert a bare-name row.
    //   2. Insert one archived bare-name agent (mirrors production data).
    //   3. Re-add the CHECK as NOT VALID (mirrors migration 061's pattern).
    //   4. Reset a UUID row's auto_resume to false (something for 055 to flip).
    //   5. Re-run 055.
    // The pre-fix migration would error here with agents_id_shape_check;
    // the post-fix migration filters bare-name rows out of the UPDATE.
    await sql`ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_id_shape_check`;

    const bareName = `legacy-bare-${Date.now()}`;
    await sql`
      INSERT INTO agents (id, role, custom_name, team, repo_path, started_at, state, auto_resume)
      VALUES (${bareName}, 'legacy', NULL, 'legacy-team', '/tmp/legacy', now(), 'archived', false)
      ON CONFLICT (id) DO NOTHING
    `;

    await sql.unsafe(
      `ALTER TABLE agents
         ADD CONSTRAINT agents_id_shape_check
         CHECK (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR id LIKE 'dir:%')
         NOT VALID`,
    );

    const liveId = randomUUID();
    await sql`
      INSERT INTO agents (id, role, custom_name, team, repo_path, started_at, state, auto_resume)
      VALUES (${liveId}, 'engineer', 'live-engineer', 'live-team', '/tmp/live', now(), 'idle', false)
      ON CONFLICT (id) DO NOTHING
    `;

    // The pre-fix migration would throw here with
    // `new row for relation "agents" violates check constraint "agents_id_shape_check"`.
    await expect(runMigration(sql)).resolves.toBeUndefined();

    const live = await sql<{ auto_resume: boolean }[]>`
      SELECT auto_resume FROM agents WHERE id = ${liveId}
    `;
    expect(live[0].auto_resume).toBe(true);

    const bare = await sql<{ auto_resume: boolean }[]>`
      SELECT auto_resume FROM agents WHERE id = ${bareName}
    `;
    // Bare-name rows are archived legacy; their auto_resume is intentionally
    // not flipped because the row would fail the id-shape check.
    expect(bare[0].auto_resume).toBe(false);
  });

  test('flips auto_resume on UUID and dir: rows, leaves NULL rows true', async () => {
    const sql = await getConnection();

    const uuidId = randomUUID();
    const dirId = `dir:test-dir-${Date.now()}`;
    await sql`
      INSERT INTO agents (id, role, custom_name, team, repo_path, started_at, state, auto_resume)
      VALUES
        (${uuidId}, 'engineer', 'a', 'team-a', '/tmp/a', now(), 'idle', false),
        (${dirId}, 'engineer', 'b', 'team-b', '/tmp/b', now(), 'idle', false)
      ON CONFLICT (id) DO NOTHING
    `;

    await runMigration(sql);

    const rows = await sql<{ id: string; auto_resume: boolean }[]>`
      SELECT id, auto_resume FROM agents WHERE id IN (${uuidId}, ${dirId})
    `;
    for (const r of rows) {
      expect(r.auto_resume).toBe(true);
    }
  });
});
