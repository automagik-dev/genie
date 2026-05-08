import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Sql, getConnection } from '../../lib/db.js';
import { DB_AVAILABLE, setupTestDatabase } from '../../lib/test-db.js';

const MIGRATION_PATH = join(import.meta.dir, '054_fix_subagent_team_inheritance.sql');

async function applyMigration(): Promise<void> {
  const sql = await getConnection();
  const migration = await readFile(MIGRATION_PATH, 'utf-8');
  await sql.begin(async (tx: Sql) => {
    await tx.unsafe(migration);
  });
}

describe.skipIf(!DB_AVAILABLE)('migration 054 — subagent team inheritance', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    const sql = await getConnection();
    await sql`DROP TABLE IF EXISTS agent_templates CASCADE`;
  });

  test('heals pre-061 text-id schema during fresh install ordering', async () => {
    const sql = await getConnection();
    await sql`
      CREATE TABLE agent_templates (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL DEFAULT 'claude',
        team TEXT NOT NULL,
        cwd TEXT NOT NULL DEFAULT '/tmp',
        last_spawned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await sql`
      INSERT INTO agent_templates (id, team)
      VALUES
        ('genie-omni', 'genie'),
        ('genie-omni/dog-fooder', 'felipe'),
        ('engineer', 'felipe')
    `;

    await applyMigration();

    const child = await sql<{ team: string }[]>`
      SELECT team FROM agent_templates WHERE id = 'genie-omni/dog-fooder'
    `;
    expect(child[0].team).toBe('genie');

    const builtin = await sql`SELECT 1 FROM agent_templates WHERE id = 'engineer'`;
    expect(builtin.length).toBe(0);
  });

  test('heals post-061 UUID-id schema via template name', async () => {
    const sql = await getConnection();
    await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`;
    await sql`
      CREATE TABLE agent_templates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'claude',
        team TEXT NOT NULL,
        cwd TEXT NOT NULL DEFAULT '/tmp',
        last_spawned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await sql`
      INSERT INTO agent_templates (name, team)
      VALUES
        ('genie-omni', 'genie'),
        ('genie-omni/dog-fooder', 'felipe'),
        ('engineer', 'felipe')
    `;

    await applyMigration();

    const child = await sql<{ team: string }[]>`
      SELECT team FROM agent_templates WHERE name = 'genie-omni/dog-fooder'
    `;
    expect(child[0].team).toBe('genie');

    const builtin = await sql`SELECT 1 FROM agent_templates WHERE name = 'engineer'`;
    expect(builtin.length).toBe(0);
  });
});
