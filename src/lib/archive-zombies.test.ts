/**
 * Regression tests for TTL-archive of exhausted dead-pane zombies (issue #1293).
 *
 * Scenario:
 *   1. Reconciler flips a dead-pane agent to `state='error'` with audit
 *      `reason='dead_pane_zombie'`.
 *   2. Scheduler exhausts the 3-retry budget → persists `auto_resume=false`.
 *   3. The row is inert: it never resumes, but stays visible in `genie ls`
 *      forever. Without TTL archival, they accumulate and clutter the list.
 *
 * This suite asserts:
 *   - Rows younger than the TTL are NOT archived (false positive guard).
 *   - Rows older than the TTL ARE archived.
 *   - Rows without the `dead_pane_zombie` audit trail are NOT archived
 *     (we don't touch manually-errored rows).
 *   - Rows with `auto_resume=true` are NOT archived (still eligible).
 *   - `listExhaustedZombies` (dry-run view) does not mutate state.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { archiveExhaustedZombies, listExhaustedZombies } from './agent-registry.js';
import { getConnection } from './db.js';
import { DB_AVAILABLE, setupTestDatabase } from './test-db.js';

describe.skipIf(!DB_AVAILABLE)('archiveExhaustedZombies (issue #1293)', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    const sql = await getConnection();
    await sql`DELETE FROM audit_events`;
    await sql`DELETE FROM agents`;
  });

  /**
   * Helper: insert an agent row at a specific age (hours) with the requested
   * state / auto_resume / audit trail.
   */
  async function seedZombie(opts: {
    id: string;
    ageHours: number;
    state?: string;
    autoResume?: boolean;
    withDeadPaneAudit?: boolean;
  }): Promise<void> {
    const sql = await getConnection();
    const state = opts.state ?? 'error';
    const autoResume = opts.autoResume ?? false;
    await sql`
      INSERT INTO agents (id, pane_id, session, repo_path, started_at, state, last_state_change, auto_resume)
      VALUES (
        ${opts.id},
        ${`%${opts.id}`},
        ${'genie'},
        ${'/tmp/test'},
        now() - make_interval(hours => ${opts.ageHours}),
        ${state},
        now() - make_interval(hours => ${opts.ageHours}),
        ${autoResume}
      )
    `;
    if (opts.withDeadPaneAudit ?? true) {
      await sql`
        INSERT INTO audit_events (entity_type, entity_id, event_type, actor, details, created_at)
        VALUES (
          'worker',
          ${opts.id},
          'state_changed',
          'reconciler',
          ${sql.json({ state: 'error', reason: 'dead_pane_zombie' })},
          now() - make_interval(hours => ${opts.ageHours})
        )
      `;
    }
  }

  async function getAgentState(id: string): Promise<string | null> {
    const sql = await getConnection();
    const rows = await sql<{ state: string }[]>`SELECT state FROM agents WHERE id = ${id}`;
    return rows.length > 0 ? rows[0].state : null;
  }

  test('TTL not triggered at 23h (just under 24h default)', async () => {
    await seedZombie({ id: 'young-zombie', ageHours: 23 });

    const ids = await archiveExhaustedZombies();

    expect(ids).not.toContain('young-zombie');
    expect(await getAgentState('young-zombie')).toBe('error');
  });

  test('TTL triggered at 24h+1 (just over 24h default)', async () => {
    await seedZombie({ id: 'old-zombie', ageHours: 25 });

    const ids = await archiveExhaustedZombies();

    expect(ids).toContain('old-zombie');
    expect(await getAgentState('old-zombie')).toBe('archived');
  });

  test('custom ttlHours parameter is honoured', async () => {
    await seedZombie({ id: 'edge-zombie', ageHours: 2 });

    // Not archived with default 24h TTL
    expect(await archiveExhaustedZombies(24)).not.toContain('edge-zombie');
    expect(await getAgentState('edge-zombie')).toBe('error');

    // Archived with 1h TTL override
    expect(await archiveExhaustedZombies(1)).toContain('edge-zombie');
    expect(await getAgentState('edge-zombie')).toBe('archived');
  });

  test('does not archive rows with auto_resume=true (still recoverable)', async () => {
    await seedZombie({ id: 'recoverable', ageHours: 48, autoResume: true });

    const ids = await archiveExhaustedZombies();

    expect(ids).not.toContain('recoverable');
    expect(await getAgentState('recoverable')).toBe('error');
  });

  test('does not archive rows without dead_pane_zombie audit trail', async () => {
    // Manually-errored row: same state/auto_resume but no reconciler audit
    await seedZombie({ id: 'manual-error', ageHours: 48, withDeadPaneAudit: false });

    const ids = await archiveExhaustedZombies();

    expect(ids).not.toContain('manual-error');
    expect(await getAgentState('manual-error')).toBe('error');
  });

  test('does not touch rows already archived', async () => {
    await seedZombie({ id: 'pre-archived', ageHours: 48, state: 'archived' });

    const ids = await archiveExhaustedZombies();

    expect(ids).not.toContain('pre-archived');
    expect(await getAgentState('pre-archived')).toBe('archived');
  });

  test('archives many rows in a single pass', async () => {
    await seedZombie({ id: 'z1', ageHours: 48 });
    await seedZombie({ id: 'z2', ageHours: 48 });
    await seedZombie({ id: 'z3', ageHours: 48 });
    await seedZombie({ id: 'young', ageHours: 1 });

    const ids = await archiveExhaustedZombies();

    expect(ids.sort()).toEqual(['z1', 'z2', 'z3']);
    expect(await getAgentState('young')).toBe('error');
  });

  test('emits a state_changed audit event for each archived row', async () => {
    await seedZombie({ id: 'audit-me', ageHours: 48 });

    await archiveExhaustedZombies();

    const sql = await getConnection();
    const rows = await sql<{ reason: string; state: string }[]>`
      SELECT details->>'reason' AS reason, details->>'state' AS state
      FROM audit_events
      WHERE entity_type = 'worker'
        AND entity_id = 'audit-me'
        AND event_type = 'state_changed'
        AND details->>'state' = 'archived'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].reason).toBe('dead_pane_zombie_ttl_exhausted');
  });
});

describe.skipIf(!DB_AVAILABLE)('listExhaustedZombies — dry-run view (issue #1293)', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    const sql = await getConnection();
    await sql`DELETE FROM audit_events`;
    await sql`DELETE FROM agents`;
  });

  async function seedOldZombie(id: string, ageHours = 48): Promise<void> {
    const sql = await getConnection();
    await sql`
      INSERT INTO agents (id, pane_id, session, repo_path, started_at, state, last_state_change, auto_resume)
      VALUES (${id}, ${`%${id}`}, 'genie', '/tmp/test',
              now() - make_interval(hours => ${ageHours}),
              'error',
              now() - make_interval(hours => ${ageHours}),
              false)
    `;
    await sql`
      INSERT INTO audit_events (entity_type, entity_id, event_type, actor, details)
      VALUES ('worker', ${id}, 'state_changed', 'reconciler',
              ${sql.json({ state: 'error', reason: 'dead_pane_zombie' })})
    `;
  }

  test('dry-run returns candidates without mutating state', async () => {
    await seedOldZombie('dry-1');
    await seedOldZombie('dry-2');

    const listed = await listExhaustedZombies();
    expect(listed.map((z) => z.id).sort()).toEqual(['dry-1', 'dry-2']);

    // State must still be 'error' — dry-run does not archive
    const sql = await getConnection();
    const rows = await sql<{ state: string }[]>`
      SELECT state FROM agents WHERE id IN ('dry-1', 'dry-2')
    `;
    for (const r of rows) {
      expect(r.state).toBe('error');
    }
  });

  test('dry-run respects ttlHours threshold', async () => {
    await seedOldZombie('old', 48);
    await seedOldZombie('young', 1);

    const withDefaultTtl = await listExhaustedZombies(24);
    expect(withDefaultTtl.map((z) => z.id)).toEqual(['old']);

    const withTightTtl = await listExhaustedZombies(0);
    expect(withTightTtl.map((z) => z.id).sort()).toEqual(['old', 'young']);
  });
});
