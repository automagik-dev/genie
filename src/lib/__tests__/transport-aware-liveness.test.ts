/**
 * Regression tests for the v0.2 transport-aware-liveness sweep.
 *
 * Complements PR #1167 (`buildWorkerStatusMap` / `resolveWorkerLiveness`) by
 * covering the parallel callers that still called `isPaneAlive` blindly for
 * every worker — mis-reporting SDK/omni/inline agents (synthetic paneIds like
 * 'sdk', 'inline', '') as dead and triggering clobbers, dup-spawns, and
 * misrouted messages.
 *
 * Reference pattern: `scheduler-daemon.ts:countActiveWorkers` (PR #1181) and
 * `term-commands/agents.ts:resolveWorkerLiveness`. The shared helper lives in
 * `executor-registry.ts:resolveWorkerLivenessByTransport`.
 *
 * Site coverage:
 *   - Helper: `resolveWorkerLivenessByTransport` dispatch (unit, no DB).
 *   - Site 3: `resolveSpawnIdentity` with live SDK canonical → parallel, not
 *     canonical clobber (integration, DB).
 *   - Site 6: `isAgentAlive` with live SDK agent → true (integration, DB).
 *   - Site 2 + Site 7: covered transitively by the helper dispatch tests —
 *     both callers pass their registry row straight to
 *     `resolveWorkerLivenessByTransport`, so the helper contract is the fix.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as registry from '../agent-registry.js';
import { resolveWorkerLivenessByTransport } from '../executor-registry.js';
import { DB_AVAILABLE, setupTestDatabase } from '../test-db.js';

// ---------------------------------------------------------------------------
// Helper unit tests — exhaustive dispatch coverage without DB.
// ---------------------------------------------------------------------------

describe('resolveWorkerLivenessByTransport (shared helper)', () => {
  test('dispatches tmux paneIds (%N) to isPaneAliveFn', async () => {
    const paneCalls: string[] = [];
    const execCalls: string[] = [];
    const alive = await resolveWorkerLivenessByTransport(
      { id: 'alice', paneId: '%42' },
      {
        isPaneAliveFn: async (p) => {
          paneCalls.push(p);
          return true;
        },
        isExecutorAliveFn: async (id) => {
          execCalls.push(id);
          return false;
        },
      },
    );

    expect(alive).toBe(true);
    expect(paneCalls).toEqual(['%42']);
    expect(execCalls).toEqual([]); // never consulted
  });

  test('dispatches synthetic paneIds (sdk) to isExecutorAliveFn', async () => {
    const paneCalls: string[] = [];
    const execCalls: string[] = [];
    const alive = await resolveWorkerLivenessByTransport(
      { id: 'alice-sdk', paneId: 'sdk' },
      {
        isPaneAliveFn: async (p) => {
          paneCalls.push(p);
          return false;
        },
        isExecutorAliveFn: async (id) => {
          execCalls.push(id);
          return true;
        },
      },
    );

    expect(alive).toBe(true);
    expect(paneCalls).toEqual([]); // never consulted — would have returned false
    expect(execCalls).toEqual(['alice-sdk']);
  });

  test('dispatches empty paneId to isExecutorAliveFn', async () => {
    const execCalls: string[] = [];
    const alive = await resolveWorkerLivenessByTransport(
      { id: 'alice-inline', paneId: '' },
      {
        isPaneAliveFn: async () => {
          throw new Error('should not call tmux for empty paneId');
        },
        isExecutorAliveFn: async (id) => {
          execCalls.push(id);
          return true;
        },
      },
    );

    expect(alive).toBe(true);
    expect(execCalls).toEqual(['alice-inline']);
  });

  test('inline paneId routes to isExecutorAliveFn', async () => {
    const alive = await resolveWorkerLivenessByTransport(
      { id: 'alice-inline', paneId: 'inline' },
      {
        isPaneAliveFn: async () => {
          throw new Error('should not call tmux for inline paneId');
        },
        isExecutorAliveFn: async () => true,
      },
    );
    expect(alive).toBe(true);
  });

  test('dead synthetic worker → false (no tmux call)', async () => {
    let paneCalled = false;
    const alive = await resolveWorkerLivenessByTransport(
      { id: 'alice-sdk', paneId: 'sdk' },
      {
        isPaneAliveFn: async () => {
          paneCalled = true;
          return true;
        },
        isExecutorAliveFn: async () => false,
      },
    );
    expect(alive).toBe(false);
    expect(paneCalled).toBe(false);
  });

  test('%N with dead pane stays dead (no executor fallback)', async () => {
    // Regression: the tmux branch must NOT fall through to isExecutorAlive
    // when the pane is dead. Prevents false-alive for a tmux-transport agent
    // that orphaned its executor row.
    let execCalled = false;
    const alive = await resolveWorkerLivenessByTransport(
      { id: 'alice', paneId: '%99' },
      {
        isPaneAliveFn: async () => false,
        isExecutorAliveFn: async () => {
          execCalled = true;
          return true;
        },
      },
    );
    expect(alive).toBe(false);
    expect(execCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — DB-backed, exercises real executors rows.
// ---------------------------------------------------------------------------

describe.skipIf(!DB_AVAILABLE)('transport-aware liveness — integration', () => {
  let cleanupSchema: () => Promise<void>;

  beforeAll(async () => {
    cleanupSchema = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanupSchema();
  });

  beforeEach(async () => {
    const { getConnection } = await import('../db.js');
    const sql = await getConnection();
    await sql`TRUNCATE TABLE agents CASCADE`;
    await sql`TRUNCATE TABLE executors CASCADE`;
  });

  // ---------------------------------------------------------------------
  // Site 6 — `isAgentAlive` in team-auto-spawn.ts
  // Before: SDK agent with live executor → `isPaneAlive('sdk')` returned
  //   false → inbox-watcher misrouted messages as "agent dead".
  // After:  same scenario → transport-aware helper consults executors.state,
  //   returns true, routing proceeds normally.
  // ---------------------------------------------------------------------
  test('Site 6: isAgentAlive reports live SDK agent as alive', async () => {
    const { isAgentAlive } = await import('../team-auto-spawn.js');
    const { getConnection } = await import('../db.js');
    const sql = await getConnection();

    // Seed SDK agent row (synthetic paneId='sdk').
    await registry.register({
      id: 'alice-sdk',
      paneId: 'sdk',
      session: 'alice',
      worktree: null,
      startedAt: new Date().toISOString(),
      state: 'idle',
      lastStateChange: new Date().toISOString(),
      repoPath: '/tmp/alice-sdk',
      role: 'alice-sdk',
      team: 'alice',
      provider: 'claude-sdk',
    });
    // Seed live executor + FK link (running state is in the "alive" set).
    await sql`
      INSERT INTO executors (id, agent_id, provider, transport, state, started_at)
      VALUES ('exec-1', 'alice-sdk', 'claude-sdk', 'api', 'running', now())
    `;
    await sql`UPDATE agents SET current_executor_id = 'exec-1' WHERE id = 'alice-sdk'`;

    expect(await isAgentAlive('alice-sdk')).toBe(true);
  });

  test('Site 6: isAgentAlive reports dead SDK agent as dead', async () => {
    const { isAgentAlive } = await import('../team-auto-spawn.js');
    const { getConnection } = await import('../db.js');
    const sql = await getConnection();

    await registry.register({
      id: 'bob-sdk',
      paneId: 'sdk',
      session: 'bob',
      worktree: null,
      startedAt: new Date().toISOString(),
      state: 'done',
      lastStateChange: new Date().toISOString(),
      repoPath: '/tmp/bob-sdk',
      role: 'bob-sdk',
      team: 'bob',
      provider: 'claude-sdk',
    });
    // Seed terminated executor — getLiveExecutorState returns null.
    await sql`
      INSERT INTO executors (id, agent_id, provider, transport, state, started_at, ended_at)
      VALUES ('exec-2', 'bob-sdk', 'claude-sdk', 'api', 'terminated', now(), now())
    `;
    await sql`UPDATE agents SET current_executor_id = 'exec-2' WHERE id = 'bob-sdk'`;

    expect(await isAgentAlive('bob-sdk')).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Site 3 — `resolveSpawnIdentity` default liveness fn is transport-aware
  // Before: SDK canonical with paneId='sdk' → isPaneAlive('sdk')=false →
  //   resolveSpawnIdentity returned 'canonical' → ON CONFLICT UPDATE
  //   rewrote the live SDK row's session UUID (clobber).
  // After:  same scenario → resolveWorkerLivenessByTransport consults
  //   executors.state, returns true → 'parallel', live row preserved.
  // ---------------------------------------------------------------------
  test('Site 3: resolveSpawnIdentity routes live SDK canonical to parallel', async () => {
    const { resolveSpawnIdentity } = await import('../../term-commands/agents.js');
    const { getConnection } = await import('../db.js');
    const sql = await getConnection();

    // Seed SDK canonical + live executor. Post-migration-047 the session
    // UUID lives on the executor row.
    await registry.register({
      id: 'stefani',
      paneId: 'sdk',
      session: 'stefani',
      worktree: null,
      startedAt: new Date().toISOString(),
      state: 'working',
      lastStateChange: new Date().toISOString(),
      repoPath: '/tmp/stefani',
      role: 'stefani',
      team: 'stefani',
      provider: 'claude-sdk',
    });
    await sql`
      INSERT INTO executors (id, agent_id, provider, transport, state, claude_session_id, started_at)
      VALUES ('exec-stefani', 'stefani', 'claude-sdk', 'api', 'working', 'original-canonical-uuid-0000-000000000000', now())
    `;
    await sql`UPDATE agents SET current_executor_id = 'exec-stefani' WHERE id = 'stefani'`;

    const parallelUuid = 'feedface-1234-5678-9abc-abcdef012345';
    const identity = await resolveSpawnIdentity('stefani', 'stefani', () => parallelUuid);

    // Must route to parallel — canonical row is live and must not be rewritten.
    expect(identity.kind).toBe('parallel');
    if (identity.kind === 'parallel') {
      expect(identity.canonicalId).toBe('stefani');
      expect(identity.workerId).toBe('stefani-feed');
    }

    // Canonical row is byte-identical to the seed. Session UUID lives on the
    // executor (migration 047) — assert via the JOIN.
    const canonical = await registry.get('stefani');
    expect(canonical?.paneId).toBe('sdk');
    const sessionRows = await sql<{ claude_session_id: string | null }[]>`
      SELECT e.claude_session_id
      FROM agents a
      JOIN executors e ON e.id = a.current_executor_id
      WHERE a.id = 'stefani'
    `;
    expect(sessionRows[0]?.claude_session_id).toBe('original-canonical-uuid-0000-000000000000');
  });

  test('Site 3: resolveSpawnIdentity treats dead SDK canonical as dead', async () => {
    // Complementary regression: if the executor is terminated, the dead-row
    // branch must still fire (returns canonical for recovery).
    const { resolveSpawnIdentity } = await import('../../term-commands/agents.js');

    await registry.register({
      id: 'zombie',
      paneId: 'sdk',
      session: 'zombie',
      worktree: null,
      startedAt: new Date().toISOString(),
      state: 'error',
      lastStateChange: new Date().toISOString(),
      repoPath: '/tmp/zombie',
      role: 'zombie',
      team: 'zombie',
      provider: 'claude-sdk',
    });
    // No current_executor_id → getLiveExecutorState returns null → dead.
    // (Stale session UUIDs live on terminated executor rows, not on the agent.)

    const identity = await resolveSpawnIdentity('zombie', 'zombie', () => 'fresh-uuid');
    expect(identity.kind).toBe('canonical');
    expect(identity.workerId).toBe('zombie');
    expect(identity.sessionUuid).toBe('fresh-uuid');
  });
});
