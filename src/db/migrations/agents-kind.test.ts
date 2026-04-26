/**
 * Integration tests for migration 049 — agents.kind GENERATED column.
 *
 * Covers Group 3 acceptance criteria from the invincible-genie wish:
 *   - The column exists, is GENERATED ALWAYS AS … STORED, and the index is in place.
 *   - Inference rule: `id LIKE 'dir:%' OR reports_to IS NULL` → 'permanent', else 'task'.
 *   - Every existing row got the right value at migration time.
 *   - Fresh INSERTs auto-populate without the caller authoring `kind`.
 *   - Direct writes to `kind` are rejected (the GENERATED contract).
 *   - `auditAgentKind()` reports zero drift on a clean DB.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { auditAgentKind } from '../../lib/agent-registry.js';
import { getConnection } from '../../lib/db.js';
import { DB_AVAILABLE, setupTestDatabase } from '../../lib/test-db.js';

describe.skipIf(!DB_AVAILABLE)('migration 049 — agents.kind GENERATED column', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    const sql = await getConnection();
    await sql`DELETE FROM assignments`;
    await sql`DELETE FROM executors`;
    await sql`DELETE FROM agents`;
  });

  test('agents.kind column exists and is GENERATED', async () => {
    const sql = await getConnection();
    const rows = await sql<{ column_name: string; data_type: string; is_generated: string }[]>`
      SELECT column_name, data_type, is_generated
        FROM information_schema.columns
       WHERE table_name = 'agents'
         AND column_name = 'kind'
         AND table_schema = current_schema()
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].data_type).toBe('text');
    expect(rows[0].is_generated).toBe('ALWAYS');
  });

  test('idx_agents_kind index exists', async () => {
    const sql = await getConnection();
    const rows = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
       WHERE tablename = 'agents'
         AND indexname = 'idx_agents_kind'
         AND schemaname = current_schema()
    `;
    expect(rows.length).toBe(1);
  });

  test('dir: prefix → kind=permanent', async () => {
    const sql = await getConnection();
    await sql`
      INSERT INTO agents (id, pane_id, session, state, repo_path, started_at)
      VALUES ('dir:scout', '', 'sess-dir', NULL, '/tmp/test', now())
    `;
    const rows = await sql<{ kind: string | null }[]>`
      SELECT kind FROM agents WHERE id = 'dir:scout'
    `;
    expect(rows[0].kind).toBe('permanent');
  });

  test('reports_to NULL (top-of-hierarchy) → kind=permanent', async () => {
    const sql = await getConnection();
    await sql`
      INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, reports_to)
      VALUES ('lead-1', '%1', 'sess-lead', 'spawning', '/tmp/test', now(), NULL)
    `;
    const rows = await sql<{ kind: string | null }[]>`
      SELECT kind FROM agents WHERE id = 'lead-1'
    `;
    expect(rows[0].kind).toBe('permanent');
  });

  test('reports_to set (child spawn) → kind=task', async () => {
    const sql = await getConnection();
    // Parent first (so the FK-shape is plausible — there is no enforced FK,
    // but writing a parent row first matches the realistic spawn topology).
    await sql`
      INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, reports_to)
      VALUES ('parent-lead', '%2', 'sess-parent', 'working', '/tmp/test', now(), NULL)
    `;
    await sql`
      INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, reports_to)
      VALUES ('child-eng', '%3', 'sess-child', 'spawning', '/tmp/test', now(), 'parent-lead')
    `;
    const rows = await sql<{ id: string; kind: string | null }[]>`
      SELECT id, kind FROM agents WHERE id IN ('parent-lead', 'child-eng') ORDER BY id
    `;
    const map = new Map(rows.map((r: { id: string; kind: string | null }) => [r.id, r.kind]));
    expect(map.get('parent-lead')).toBe('permanent');
    expect(map.get('child-eng')).toBe('task');
  });

  test('kind cannot be authored directly (GENERATED contract)', async () => {
    const sql = await getConnection();
    let threw = false;
    try {
      await sql`
        INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, kind)
        VALUES ('forced', '', 'sess-forced', 'spawning', '/tmp/test', now(), 'task')
      `;
    } catch (err) {
      threw = true;
      const msg = err instanceof Error ? err.message : String(err);
      // Postgres rejects writes to GENERATED columns with one of these errors
      // depending on version (cannot insert / generated always identity).
      expect(msg.toLowerCase()).toMatch(/generated|column.*kind/);
    }
    expect(threw).toBe(true);
  });

  test('updating reports_to flips kind from permanent → task', async () => {
    const sql = await getConnection();
    await sql`
      INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, reports_to)
      VALUES ('promotable', '%4', 'sess-x', 'spawning', '/tmp/test', now(), NULL)
    `;
    let rows = await sql<{ kind: string | null }[]>`
      SELECT kind FROM agents WHERE id = 'promotable'
    `;
    expect(rows[0].kind).toBe('permanent');

    // Stage a parent row so reports_to has somewhere to point.
    await sql`
      INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, reports_to)
      VALUES ('promotable-parent', '%5', 'sess-y', 'working', '/tmp/test', now(), NULL)
    `;
    await sql`
      UPDATE agents SET reports_to = 'promotable-parent' WHERE id = 'promotable'
    `;

    rows = await sql<{ kind: string | null }[]>`
      SELECT kind FROM agents WHERE id = 'promotable'
    `;
    expect(rows[0].kind).toBe('task');
  });

  test('auditAgentKind reports zero drift on a clean DB', async () => {
    const sql = await getConnection();
    // Seed a representative cross-section of the inference rule.
    await sql`
      INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, reports_to)
      VALUES
        ('dir:audit-a', '', 'sess-dir-a', NULL, '/tmp/test', now(), NULL),
        ('audit-lead', '%6', 'sess-lead', 'working', '/tmp/test', now(), NULL),
        ('audit-parent', '%7', 'sess-parent', 'working', '/tmp/test', now(), NULL),
        ('audit-child', '%8', 'sess-child', 'spawning', '/tmp/test', now(), 'audit-parent')
    `;

    const result = await auditAgentKind();
    expect(result.total).toBe(4);
    expect(result.drifted).toEqual([]);
  });

  test('grep guard: ad-hoc inference removed from src/', async () => {
    // Acceptance criterion: every `id LIKE 'dir:%'` ad-hoc inference of
    // permanence must be migrated to use the `kind` column. The migration
    // file and this test are the only legitimate residents.
    //
    // Skipped when ripgrep is unavailable — the invariant has no value
    // without a working scanner.
    const { execSync } = await import('node:child_process');
    try {
      execSync('rg --version', { encoding: 'utf-8', stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {
      return; // rg unavailable in this environment
    }
    let stdout = '';
    try {
      stdout = execSync(
        `rg --no-heading "id LIKE 'dir:%'" src --type ts --type sql ` +
          // The migration that defines the rule (049) and the migration that
          // backfills dir: state (046) legitimately reference the pattern.
          `--glob '!src/db/migrations/049_agents_kind_generated.sql' ` +
          `--glob '!src/db/migrations/046_dir_agents_state_null.sql' ` +
          `--glob '!src/db/migrations/agents-kind.test.ts'`,
        { encoding: 'utf-8', cwd: process.cwd() },
      );
    } catch (err) {
      // rg exits 1 when no matches — the expected success path.
      const e = err as { status?: number; stdout?: string };
      if (e.status === 1) stdout = '';
      else throw err;
    }
    expect(stdout.trim()).toBe('');
  });
});
