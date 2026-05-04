/**
 * Wish retire-session-names-id-only Group 3 — Spawn writes ONE row.
 *
 * Asserts the post-G3 invariants:
 *   1. `register()` rejects bare-name ids loudly (UUID OR `dir:<name>` only).
 *   2. The legitimate spawn path (`findOrCreateAgent` → `register`) lands a
 *      single UUID-keyed agents row — no bare-name shadow twin.
 *   3. `register()` accepts `dir:<name>` master-row ids.
 *
 * The bare-name shadow rejection is mirrored in migration 061's
 * `agents_id_shape_check`; this test covers the application-level guard so
 * the failure message is "loud throw at the call site" instead of a deep
 * SQL CHECK violation.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { findOrCreateAgent, list, register, unregister } from '../agent-registry.js';
import { getConnection } from '../db.js';
import { DB_AVAILABLE, setupTestDatabase } from '../test-db.js';

describe.skipIf(!DB_AVAILABLE)('spawn-single-row — wish retire-session-names-id-only G3', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanup();
  });

  afterEach(async () => {
    const sql = await getConnection();
    await sql`DELETE FROM executors`;
    await sql`DELETE FROM agents`;
  });

  function makeRuntimeAgent(id: string, customName: string, team: string) {
    return {
      id,
      paneId: '%17',
      session: team,
      worktree: null,
      customName,
      role: customName,
      team,
      startedAt: new Date().toISOString(),
      state: 'spawning' as const,
      lastStateChange: new Date().toISOString(),
      repoPath: '/tmp/test',
      provider: 'claude' as const,
      transport: 'tmux' as const,
    };
  }

  test('register rejects bare-name id with a useful error', async () => {
    const bareName = makeRuntimeAgent('engineer-4d48', 'engineer-4d48', 'genie');
    let caught: Error | null = null;
    try {
      await register(bareName);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain('non-UUID/non-dir agent id');
    expect(caught!.message).toContain('findOrCreateAgent');
  });

  test('register accepts dir: master-row id', async () => {
    const master = makeRuntimeAgent('dir:engineer', 'engineer', 'genie');
    await register(master);
    const sql = await getConnection();
    const rows = await sql<{ id: string }[]>`SELECT id FROM agents WHERE id = 'dir:engineer'`;
    expect(rows.length).toBe(1);
    await unregister('dir:engineer');
  });

  test('full spawn path lands ONE UUID-keyed row (no bare-name shadow)', async () => {
    // Step 1 (mirroring agents.ts:resolveSpawnIdentity → findOrCreateAgent):
    // resolve the durable identity row keyed by (custom_name, team).
    const identity = await findOrCreateAgent('engineer', 'genie', 'engineer');
    expect(identity.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    // Step 2 (mirroring agents.ts:registerSpawnWorker): register runtime fields
    // under the SAME UUID. workerId carries the human-readable label only.
    const workerId = 'engineer-4d48';
    const runtime = makeRuntimeAgent(identity.id, workerId, 'genie');
    await register(runtime);

    // Assertion 1: exactly ONE row exists for this (custom_name, team).
    const all = await list();
    const matching = all.filter((a) => a.team === 'genie' && (a.customName === 'engineer' || a.id === identity.id));
    expect(matching.length).toBe(1);

    // Assertion 2: the row is UUID-keyed (no bare-name shadow twin).
    const sql = await getConnection();
    const shadowRows = await sql<{ id: string }[]>`
      SELECT id FROM agents
      WHERE id NOT LIKE 'dir:%'
        AND id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    `;
    expect(shadowRows.length).toBe(0);

    // Assertion 3: runtime fields landed on the identity row (single-source).
    const refreshed = matching[0];
    expect(refreshed.paneId).toBe('%17');
    expect(refreshed.state).toBe('spawning');
    expect(refreshed.id).toBe(identity.id);
  });

  test('repeated register() against same identity is idempotent (no shadow twin)', async () => {
    const identity = await findOrCreateAgent('reviewer', 'genie', 'reviewer');
    const runtime1 = makeRuntimeAgent(identity.id, 'reviewer-aaaa', 'genie');
    const runtime2 = makeRuntimeAgent(identity.id, 'reviewer-bbbb', 'genie');
    await register(runtime1);
    await register(runtime2); // ON CONFLICT (id) DO UPDATE merges runtime fields

    const all = await list();
    const matching = all.filter((a) => a.team === 'genie' && a.customName === 'reviewer');
    // Single row — register's ON CONFLICT (id) DO UPDATE is the upsert.
    // custom_name stays 'reviewer' from findOrCreateAgent (COALESCE preserves
    // the existing non-null value).
    expect(matching.length).toBe(1);
    expect(matching[0].id).toBe(identity.id);
  });
});
