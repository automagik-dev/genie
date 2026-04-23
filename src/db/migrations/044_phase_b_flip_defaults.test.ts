/**
 * Integration tests for migration 044 — turn-session-contract Phase B.
 *
 * Covers the three acceptance shapes from the wish (C16 / C17):
 *   1. Fresh DB: `auto_resume` column default is `false`, so brand-new
 *      INSERTs opt out of auto-resume unless the caller overrides.
 *   2. Live rows (last_state_change within 1 hour, non-terminal state)
 *      are preserved as `auto_resume=true` across the migration.
 *   3. Closed/stale rows — executor closed, terminal state, or
 *      `last_state_change` older than 1 hour — end up `auto_resume=false`
 *      and pane-sentinel orphans in non-terminal state are terminalized
 *      with a `reconcile.terminalize` audit event.
 *
 * The migration runner applies every migration under the test schema in
 * `setupTestDatabase`, so by the time a test body runs the schema is already
 * in its Phase B shape. To model "live/stale rows at migration time" we
 * INSERT rows in the test body and then re-apply the migration as an
 * idempotent second pass; the write statements (UPDATE + CTE) are
 * predicate-guarded and safe to re-run.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConnection } from '../../lib/db.js';
import { DB_AVAILABLE, setupTestDatabase } from '../../lib/test-db.js';

const MIGRATION_PATH = join(import.meta.dir, '044_phase_b_flip_defaults.sql');

function loadMigration(): string {
  return readFileSync(MIGRATION_PATH, 'utf-8');
}

describe.skipIf(!DB_AVAILABLE)('migration 044 — Phase B: flip auto_resume + reconciler defaults', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanup();
  });

  test('fresh DB: agents.auto_resume column default is false after migration 044', async () => {
    const sql = await getConnection();
    const rows = await sql<{ column_default: string | null }[]>`
      SELECT column_default
        FROM information_schema.columns
       WHERE table_name = 'agents'
         AND column_name = 'auto_resume'
         AND table_schema = current_schema()
    `;
    expect(rows.length).toBe(1);
    // Postgres reports boolean defaults as 'true' / 'false' literal strings.
    expect(rows[0].column_default).toBe('false');
  });

  test('fresh-INSERT agent row inherits auto_resume=false', async () => {
    const sql = await getConnection();
    const id = `test-fresh-${Date.now()}`;
    await sql`
      INSERT INTO agents (id, pane_id, session, state, repo_path, started_at)
      VALUES (${id}, '%99', 'sess-fresh', 'spawning', '/tmp/test', now())
    `;
    const rows = await sql<{ auto_resume: boolean | null }[]>`
      SELECT auto_resume FROM agents WHERE id = ${id}
    `;
    expect(rows[0].auto_resume).toBe(false);
  });

  test('live row (last_state_change < 1h, non-terminal state) preserves auto_resume=true', async () => {
    const sql = await getConnection();
    const id = `test-live-${Date.now()}`;
    // Seed a row that "looks like" a currently-active agent: short-ago
    // state-change, non-terminal state, auto_resume null (pre-backfill).
    await sql`
      INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, last_state_change, auto_resume)
      VALUES (${id}, '%10', 'sess-live', 'working', '/tmp/test', now(), now() - interval '2 minutes', NULL)
    `;
    // Re-apply the migration — idempotent predicates re-exec the backfill.
    await sql.unsafe(loadMigration());

    const rows = await sql<{ auto_resume: boolean | null }[]>`
      SELECT auto_resume FROM agents WHERE id = ${id}
    `;
    expect(rows[0].auto_resume).toBe(true);
  });

  test('stale row (last_state_change older than 1h) is flipped to auto_resume=false', async () => {
    const sql = await getConnection();
    const id = `test-stale-${Date.now()}`;
    await sql`
      INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, last_state_change, auto_resume)
      VALUES (${id}, '%11', 'sess-stale', 'idle', '/tmp/test', now() - interval '3 hours',
              now() - interval '2 hours', true)
    `;
    await sql.unsafe(loadMigration());

    const rows = await sql<{ auto_resume: boolean | null }[]>`
      SELECT auto_resume FROM agents WHERE id = ${id}
    `;
    expect(rows[0].auto_resume).toBe(false);
  });

  test('terminal-state row (done/error/suspended) is flipped to auto_resume=false', async () => {
    const sql = await getConnection();
    const rowsToSeed = ['done', 'error', 'suspended'] as const;
    const ids: string[] = [];
    for (const state of rowsToSeed) {
      const id = `test-terminal-${state}-${Date.now()}`;
      ids.push(id);
      await sql`
        INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, last_state_change, auto_resume)
        VALUES (${id}, '%12', 'sess-terminal', ${state}, '/tmp/test', now(), now() - interval '2 minutes', true)
      `;
    }
    await sql.unsafe(loadMigration());

    const rows = await sql<{ id: string; auto_resume: boolean | null }[]>`
      SELECT id, auto_resume FROM agents WHERE id = ANY(${ids})
    `;
    for (const r of rows) expect(r.auto_resume).toBe(false);
  });

  test('row with a closed executor is flipped to auto_resume=false via executors JOIN', async () => {
    const sql = await getConnection();
    const agentId = `test-closed-exec-${Date.now()}`;
    const execId = `exec-closed-${Date.now()}`;
    await sql`
      INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, last_state_change, auto_resume)
      VALUES (${agentId}, '%13', 'sess-ce', 'working', '/tmp/test', now(), now() - interval '2 minutes', true)
    `;
    await sql`
      INSERT INTO executors (id, agent_id, provider, transport, state, started_at, closed_at, ended_at, outcome, close_reason)
      VALUES (${execId}, ${agentId}, 'claude', 'tmux', 'error', now() - interval '10 minutes',
              now() - interval '5 minutes', now() - interval '5 minutes', 'done', 'test')
    `;
    await sql`UPDATE agents SET current_executor_id = ${execId} WHERE id = ${agentId}`;

    await sql.unsafe(loadMigration());

    const rows = await sql<{ auto_resume: boolean | null }[]>`
      SELECT auto_resume FROM agents WHERE id = ${agentId}
    `;
    expect(rows[0].auto_resume).toBe(false);
  });

  test('orphan terminalization: stale row with dead-pane sentinel → state=error + audit event', async () => {
    const sql = await getConnection();
    const id = `test-orphan-${Date.now()}`;
    // pane_id='' + stale last_state_change + non-terminal state matches
    // the SQL orphan predicate (CTE `orphans` in migration 044).
    await sql`
      INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, last_state_change, auto_resume)
      VALUES (${id}, '', 'sess-orphan', 'working', '/tmp/test', now() - interval '3 hours',
              now() - interval '2 hours', true)
    `;
    await sql.unsafe(loadMigration());

    const rows = await sql<{ state: string; auto_resume: boolean | null }[]>`
      SELECT state, auto_resume FROM agents WHERE id = ${id}
    `;
    expect(rows[0].state).toBe('error');
    expect(rows[0].auto_resume).toBe(false);

    const audit = await sql<{ actor: string; details: unknown }[]>`
      SELECT actor, details FROM audit_events
       WHERE entity_type = 'agent' AND entity_id = ${id}
         AND event_type = 'reconcile.terminalize'
    `;
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0].actor).toBe('migration-044');
    const details = audit[0].details as { state_before: string; pane_id: string; reason: string };
    expect(details.state_before).toBe('working');
    expect(details.reason).toBe('migration_044_phase_b');
  });

  test('live row with a dead-pane sentinel is NOT terminalized (freshness wins)', async () => {
    const sql = await getConnection();
    const id = `test-live-sentinel-${Date.now()}`;
    // Dead-pane sentinel BUT last_state_change within the 1h window →
    // orphan CTE excludes it; state stays as-is.
    await sql`
      INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, last_state_change, auto_resume)
      VALUES (${id}, 'inline', 'sess-live-sentinel', 'idle', '/tmp/test', now(),
              now() - interval '2 minutes', true)
    `;
    await sql.unsafe(loadMigration());

    const rows = await sql<{ state: string; auto_resume: boolean | null }[]>`
      SELECT state, auto_resume FROM agents WHERE id = ${id}
    `;
    expect(rows[0].state).toBe('idle');
    expect(rows[0].auto_resume).toBe(true);
  });

  test('migration is idempotent: second apply is a no-op', async () => {
    const sql = await getConnection();
    // Snapshot agent counts + audit count, apply again, compare.
    const [before] = await sql<{ cnt: number }[]>`SELECT count(*)::int AS cnt FROM agents`;
    const [auditBefore] = await sql<{ cnt: number }[]>`
      SELECT count(*)::int AS cnt FROM audit_events WHERE actor = 'migration-044'
    `;
    await sql.unsafe(loadMigration());
    const [after] = await sql<{ cnt: number }[]>`SELECT count(*)::int AS cnt FROM agents`;
    const [auditAfter] = await sql<{ cnt: number }[]>`
      SELECT count(*)::int AS cnt FROM audit_events WHERE actor = 'migration-044'
    `;
    expect(after.cnt).toBe(before.cnt);
    // Orphan CTE matches zero rows on the second apply (all have been
    // flipped to state='error' already), so the audit count should not
    // grow.
    expect(auditAfter.cnt).toBe(auditBefore.cnt);
  });
});
