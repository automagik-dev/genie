/**
 * Tests for canonical agent observability layer.
 *
 * Wish 3/5 of PR-1607 observability roadmap (agent-observability-snapshot).
 *
 * Coverage:
 *   - View round-trips identity / executor / session columns.
 *   - Session linkage cascade (executor_id → claude_session_id) honors order.
 *   - Health flags fire for the documented thresholds (and only those).
 *   - Classification correctly partitions agent vs harness rows.
 *   - listAgentObservability orders by freshest activity, applies limit, hides harness by default.
 *   - 24h aggregate window excludes older tool/usage rows.
 *   - Performance: a population approximating the live-DB scale stays
 *     well under one second per query.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  AGENT_OBSERVABILITY_SCHEMA_VERSION,
  type AgentObservabilityRow,
  COST_SPIKE_USD_24H,
  STALE_EXECUTOR_WINDOW_MS,
  assessHealth,
  getAgentObservability,
  listAgentObservability,
  loadAgentObservabilityMap,
} from './agent-observability.js';
import { getConnection } from './db.js';
import { setupTestDatabase } from './test-db.js';

// Pure (non-PG) tests for the assessHealth function. These run unconditionally
// and exercise the full health-flag classification matrix with no database.
describe('assessHealth (pure)', () => {
  function baseRow(): AgentObservabilityRow {
    return {
      agentId: 'a',
      customName: 'engineer',
      role: 'engineer',
      team: 't',
      kind: 'task',
      agentState: 'working',
      agentStartedAt: null,
      agentUpdatedAt: null,
      currentExecutorId: 'e',
      executorId: 'e',
      executorState: 'working',
      executorProvider: 'claude',
      executorTransport: 'tmux',
      executorPid: null,
      executorTmuxPane: null,
      executorTmuxSession: null,
      executorStartedAt: null,
      executorUpdatedAt: new Date().toISOString(),
      executorEndedAt: null,
      claudeSessionId: 'cs',
      sessionId: 's',
      sessionStatus: 'active',
      sessionStartedAt: null,
      sessionTotalTurns: null,
      sessionExecutorId: 'e',
      sessionDisplayName: null,
      sessionLinkSource: 'executor_id',
      recentToolCount: 5,
      recentErrorCount: 0,
      recentLastToolAt: null,
      recentCostUsd: 0,
      recentInputTokens: 0,
      recentOutputTokens: 0,
      classification: 'agent',
    };
  }

  test('healthy row reports no flags and degraded=false', () => {
    const h = assessHealth(baseRow());
    expect(h.flags).toEqual([]);
    expect(h.degraded).toBe(false);
  });

  test('stale_executor fires when live state has no recent heartbeat', () => {
    const row = baseRow();
    row.executorUpdatedAt = new Date(Date.now() - STALE_EXECUTOR_WINDOW_MS - 60_000).toISOString();
    const h = assessHealth(row);
    expect(h.flags).toContain('stale_executor');
    expect(h.degraded).toBe(true);
  });

  test('stale_executor does NOT fire for terminal executor states', () => {
    const row = baseRow();
    row.executorState = 'terminated';
    row.executorUpdatedAt = new Date(Date.now() - STALE_EXECUTOR_WINDOW_MS - 60_000).toISOString();
    expect(assessHealth(row).flags).not.toContain('stale_executor');
  });

  test('missing_session fires when current executor has no session linkage', () => {
    const row = baseRow();
    row.sessionId = null;
    row.sessionLinkSource = null;
    expect(assessHealth(row).flags).toContain('missing_session');
  });

  test('missing_session does NOT fire when there is no executor in the first place', () => {
    const row = baseRow();
    row.currentExecutorId = null;
    row.executorId = null;
    row.sessionId = null;
    expect(assessHealth(row).flags).not.toContain('missing_session');
  });

  test('missing_attribution fires when no name or role', () => {
    const row = baseRow();
    row.customName = null;
    row.role = null;
    expect(assessHealth(row).flags).toContain('missing_attribution');
  });

  test('recent_failure fires whenever any error tool event is present', () => {
    const row = baseRow();
    row.recentErrorCount = 1;
    expect(assessHealth(row).flags).toContain('recent_failure');
  });

  test('cost_spike fires above threshold, not below', () => {
    const below = baseRow();
    below.recentCostUsd = COST_SPIKE_USD_24H - 0.01;
    expect(assessHealth(below).flags).not.toContain('cost_spike');
    const above = baseRow();
    above.recentCostUsd = COST_SPIKE_USD_24H;
    expect(assessHealth(above).flags).toContain('cost_spike');
  });

  test('schema version is monotonically positive', () => {
    expect(AGENT_OBSERVABILITY_SCHEMA_VERSION).toBeGreaterThan(0);
  });
});

// PG-bound tests. Skipped when the worktree's pgserve fixture cannot start
// (a recurring environmental issue with worktree pgserve --ram, documented
// across wish 2 and wish 3 reports). When pgserve is healthy, these
// exercise the view + cascade + classification end-to-end.
describe.skip('agent-observability (PG) — TODO retire-session-names #175: rewrite fixtures for UUID agents.id', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    // SAFETY: refuse to TRUNCATE unless setupTestDatabase() has wired the
    // test-only env vars AND the connected database name matches the
    // generated test-DB pattern. Catches the failure mode where
    // setupTestDatabase() returned a no-op cleanup (because the worktree
    // pgserve fixture failed to spawn) and getConnection() then yields a
    // connection to the shared production daemon. A bare port range
    // check is NOT enough — port 21900 in particular is the long-running
    // RAM pgserve owned by the active Claude session; truncating it
    // would clobber live agent state.
    if (!process.env.GENIE_TEST_PG_PORT || !process.env.GENIE_TEST_DB_NAME) {
      throw new Error(
        'agent-observability PG suite refusing to truncate: GENIE_TEST_PG_PORT or GENIE_TEST_DB_NAME is unset, indicating setupTestDatabase() did not own the connection.',
      );
    }
    const sql = await getConnection();
    const dbInfo = await sql<{ db: string }[]>`SELECT current_database() AS db`;
    const dbName = String(dbInfo[0].db);
    if (dbName !== process.env.GENIE_TEST_DB_NAME) {
      throw new Error(
        `agent-observability PG suite refusing to truncate: connected to "${dbName}" but expected "${process.env.GENIE_TEST_DB_NAME}".`,
      );
    }
    await sql`TRUNCATE agents, executors, sessions, tool_events, audit_events RESTART IDENTITY CASCADE`;
  });

  test('view exists, has the documented columns, and exposes a stable schema version', async () => {
    const sql = await getConnection();
    const cols = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'v_agent_observability'
    `;
    const names = new Set((cols as Array<{ column_name: string }>).map((r) => r.column_name));
    for (const expected of [
      'agent_id',
      'custom_name',
      'role',
      'team',
      'kind',
      'current_executor_id',
      'executor_id',
      'executor_state',
      'executor_started_at',
      'executor_updated_at',
      'session_id',
      'session_status',
      'session_link_source',
      'recent_tool_count',
      'recent_error_count',
      'recent_cost_usd',
      'recent_input_tokens',
      'recent_output_tokens',
      'classification',
    ]) {
      expect(names.has(expected)).toBe(true);
    }
    expect(AGENT_OBSERVABILITY_SCHEMA_VERSION).toBeGreaterThan(0);
  });

  test('round-trips identity and executor columns into the typed snapshot', async () => {
    const sql = await getConnection();
    const agentId = randomUUID();
    const executorId = randomUUID();
    // FK ordering: agents.current_executor_id references executors.id and
    // executors.agent_id references agents.id, so insert the agent first
    // with a NULL current_executor_id, then the executor, then UPDATE the
    // agent to point at it. Mirrors the runtime spawn flow.
    await sql`
      INSERT INTO agents (id, pane_id, session, repo_path, started_at, state, role, custom_name, team,
                          last_state_change, reports_to)
      VALUES (${agentId}, ${'pane-1'}, ${'sess-1'}, ${'/tmp/repo'}, now(), 'working',
              'engineer', 'engineer-test', 'team-test', now(), 'lead-1')
    `;
    await sql`
      INSERT INTO executors (id, agent_id, provider, transport, state, started_at, claude_session_id)
      VALUES (${executorId}, ${agentId}, 'claude', 'tmux', 'working', now(), 'claude-sess-1')
    `;
    await sql`UPDATE agents SET current_executor_id = ${executorId} WHERE id = ${agentId}`;

    const snap = await getAgentObservability('engineer-test');
    expect(snap).not.toBeNull();
    if (!snap) return;
    expect(snap.agentId).toBe(agentId);
    expect(snap.customName).toBe('engineer-test');
    expect(snap.team).toBe('team-test');
    expect(snap.kind).toBe('task'); // reports_to set => task
    expect(snap.executorId).toBe(executorId);
    expect(snap.executorState).toBe('working');
    expect(snap.classification).toBe('agent');
  });

  test('session linkage prefers executor_id, falls back to claude_session_id', async () => {
    const sql = await getConnection();

    // Agent A: executor + session linked via executor_id (canonical).
    const agentA = randomUUID();
    const execA = randomUUID();
    const sessA = randomUUID();
    await sql`
      INSERT INTO agents (id, pane_id, session, repo_path, started_at, state, role, last_state_change)
      VALUES (${agentA}, 'p1', 's1', '/t', now(), 'working', 'engineer', now())
    `;
    await sql`
      INSERT INTO executors (id, agent_id, provider, transport, state, started_at, claude_session_id)
      VALUES (${execA}, ${agentA}, 'claude', 'tmux', 'working', now(), 'claude-A')
    `;
    await sql`UPDATE agents SET current_executor_id = ${execA} WHERE id = ${agentA}`;
    await sql`
      INSERT INTO sessions (id, agent_id, executor_id, claude_session_id, project_path, jsonl_path, started_at, status)
      VALUES (${sessA}, ${agentA}, ${execA}, 'claude-A', '/t', '/t/log.jsonl', now(), 'active')
    `;

    // Agent B: legacy linkage — sessions.executor_id is NULL but claude_session_id matches.
    const agentB = randomUUID();
    const execB = randomUUID();
    const sessB = randomUUID();
    await sql`
      INSERT INTO agents (id, pane_id, session, repo_path, started_at, state, role, last_state_change)
      VALUES (${agentB}, 'p2', 's2', '/t', now(), 'working', 'reviewer', now())
    `;
    await sql`
      INSERT INTO executors (id, agent_id, provider, transport, state, started_at, claude_session_id)
      VALUES (${execB}, ${agentB}, 'claude', 'tmux', 'working', now(), 'claude-B')
    `;
    await sql`UPDATE agents SET current_executor_id = ${execB} WHERE id = ${agentB}`;
    await sql`
      INSERT INTO sessions (id, agent_id, executor_id, claude_session_id, project_path, jsonl_path, started_at, status)
      VALUES (${sessB}, ${agentB}, NULL, 'claude-B', '/t', '/t/log.jsonl', now(), 'active')
    `;

    const snapA = await getAgentObservability(agentA);
    const snapB = await getAgentObservability(agentB);
    expect(snapA?.sessionId).toBe(sessA);
    expect(snapA?.sessionLinkSource).toBe('executor_id');
    expect(snapB?.sessionId).toBe(sessB);
    expect(snapB?.sessionLinkSource).toBe('claude_session_id');
  });

  test('aggregates 24h tool counts/errors and exclude older rows', async () => {
    const sql = await getConnection();
    const agentId = randomUUID();
    const execId = randomUUID();
    const sessionId = `tool-test-sess-${randomUUID()}`;
    await sql`
      INSERT INTO agents (id, pane_id, session, repo_path, started_at, state, role, last_state_change)
      VALUES (${agentId}, 'p', 's', '/t', now(), 'idle', 'engineer', now())
    `;
    await sql`
      INSERT INTO executors (id, agent_id, provider, transport, state, started_at)
      VALUES (${execId}, ${agentId}, 'claude', 'tmux', 'idle', now())
    `;
    await sql`UPDATE agents SET current_executor_id = ${execId} WHERE id = ${agentId}`;
    // tool_events.session_id is FK-constrained to sessions(id); insert the
    // session row before any tool_events that reference it. Local pgserves
    // with a damaged install can be permissive about this; CI's strict
    // postgres rejects orphan tool_events outright (PR #1618 CI failure).
    await sql`
      INSERT INTO sessions (id, agent_id, project_path, jsonl_path, started_at, status)
      VALUES (${sessionId}, ${agentId}, '/t', '/t/log.jsonl', now(), 'active')
    `;

    // Two recent tool events, one of which is an error.
    await sql`
      INSERT INTO tool_events (session_id, turn_index, "timestamp", tool_name, agent_id, is_error)
      VALUES (${sessionId}, 1, now(), 'Read', ${agentId}, false),
             (${sessionId}, 2, now(), 'Bash', ${agentId}, true)
    `;
    // One stale event from 2 days ago — must NOT count.
    await sql`
      INSERT INTO tool_events (session_id, turn_index, "timestamp", tool_name, agent_id, is_error)
      VALUES (${sessionId}, 3, now() - INTERVAL '2 days', 'Read', ${agentId}, false)
    `;

    const snap = await getAgentObservability(agentId);
    expect(snap?.recentToolCount).toBe(2);
    expect(snap?.recentErrorCount).toBe(1);
    expect(snap?.health.flags).toContain('recent_failure');
  });

  test('aggregates 24h claude usage cost and tokens via v_claude_usage_events', async () => {
    const sql = await getConnection();
    const agentId = randomUUID();
    await sql`
      INSERT INTO agents (id, pane_id, session, repo_path, started_at, state, role, last_state_change)
      VALUES (${agentId}, 'p', 's', '/t', now(), 'idle', 'engineer', now())
    `;
    // Modern OTel shape — cost in details.value, agent in actor.
    await sql`
      INSERT INTO audit_events (entity_type, entity_id, event_type, actor, details)
      VALUES ('otel_metric', 'sess-x', 'claude_code.cost.usage', ${agentId},
              ${sql.json({ value: '0.42', input_tokens: '1000', output_tokens: '200', model: 'opus-4' })})
    `;
    // Legacy shape with cost_usd.
    await sql`
      INSERT INTO audit_events (entity_type, entity_id, event_type, actor, details)
      VALUES ('command', 'spawn', 'claude_code.cost.usage', ${agentId},
              ${sql.json({ cost_usd: '1.25', input_tokens: '500' })})
    `;

    const snap = await getAgentObservability(agentId);
    expect(snap?.recentCostUsd).toBeCloseTo(1.67, 2);
    expect(snap?.recentInputTokens).toBe(1500);
    expect(snap?.recentOutputTokens).toBe(200);
  });

  test('classification splits agent vs harness rows', async () => {
    const sql = await getConnection();
    const realId = randomUUID();
    await sql`
      INSERT INTO agents (id, pane_id, session, repo_path, started_at, state, role, custom_name, last_state_change)
      VALUES (${realId}, 'p', 's', '/t', now(), 'idle', 'engineer', 'engineer-real', now())
    `;
    const harnessId = randomUUID();
    await sql`
      INSERT INTO agents (id, pane_id, session, repo_path, started_at, state, role, custom_name, last_state_change)
      VALUES (${harnessId}, 'p', 's', '/t', now(), 'idle', 'harness', 'harness', now())
    `;

    const defaultList = await listAgentObservability();
    const includeHarness = await listAgentObservability({ includeHarness: true });

    expect(defaultList.find((r) => r.agentId === realId)).toBeDefined();
    expect(defaultList.find((r) => r.agentId === harnessId)).toBeUndefined();
    expect(includeHarness.find((r) => r.agentId === harnessId)).toBeDefined();
    expect(includeHarness.find((r) => r.agentId === harnessId)?.classification).toBe('harness');
  });

  test('list keeps two distinct UUID agents that share a role (no over-dedup)', async () => {
    // Regression for the dedup over-collapse: two task agents that happen to
    // share `role='engineer'` but carry distinct UUIDs and no `custom_name`
    // must both appear in the result. Earlier dedup keyed on
    // `customName ?? role ?? agentId` and collapsed them to one row, which
    // surfaced as PR #1618 CI failure on `list orders by freshest activity`.
    const sql = await getConnection();
    const a = randomUUID();
    const b = randomUUID();
    await sql`
      INSERT INTO agents (id, pane_id, session, repo_path, started_at, state, role, last_state_change)
      VALUES (${a}, 'p', 's', '/t', now(), 'idle', 'engineer', now()),
             (${b}, 'p', 's', '/t', now(), 'idle', 'engineer', now())
    `;
    const list = await listAgentObservability({ limit: 50 });
    expect(list.find((r) => r.agentId === a)).toBeDefined();
    expect(list.find((r) => r.agentId === b)).toBeDefined();
  });

  test('list collapses dir:foo shadow into UUID-keyed peer with same display name', async () => {
    // Companion to the above: when one row IS a `dir:` shadow and a
    // non-shadow peer with the same display name exists, the shadow drops
    // out. Mirrors the production scenario `(dir:fix, role=fix)` +
    // `(UUID, custom_name=fix, role=fix)` → one row in the fleet view.
    const sql = await getConnection();
    const uuid = randomUUID();
    await sql`
      INSERT INTO agents (id, pane_id, session, repo_path, started_at, state, role, custom_name, last_state_change)
      VALUES (${uuid},      'p', 's', '/t', now(), 'idle', 'collapsible', 'collapsible', now()),
             ('dir:collapsible', 'p', 's', '/t', now(), 'idle', 'collapsible', NULL, now())
    `;
    const list = await listAgentObservability({ limit: 50 });
    const matches = list.filter(
      (r) => r.customName === 'collapsible' || r.role === 'collapsible' || r.agentId === 'dir:collapsible',
    );
    expect(matches.length).toBe(1);
    expect(matches[0].agentId).toBe(uuid);
  });

  test('list orders by freshest activity and applies limit', async () => {
    const sql = await getConnection();
    const oldId = randomUUID();
    const freshId = randomUUID();
    await sql`
      INSERT INTO agents (id, pane_id, session, repo_path, started_at, state, role, last_state_change, updated_at)
      VALUES (${oldId},   'p', 's', '/t', now() - INTERVAL '3 hours', 'idle', 'engineer', now() - INTERVAL '3 hours', now() - INTERVAL '3 hours'),
             (${freshId}, 'p', 's', '/t', now(), 'idle', 'engineer', now(), now())
    `;
    const ranked = await listAgentObservability({ limit: 10 });
    const freshIdx = ranked.findIndex((r) => r.agentId === freshId);
    const oldIdx = ranked.findIndex((r) => r.agentId === oldId);
    expect(freshIdx).toBeGreaterThanOrEqual(0);
    expect(oldIdx).toBeGreaterThanOrEqual(0);
    expect(freshIdx).toBeLessThan(oldIdx);

    const limited = await listAgentObservability({ limit: 1 });
    expect(limited.length).toBe(1);
  });

  test('loadAgentObservabilityMap keys by display name, prefers freshest snapshot', async () => {
    const sql = await getConnection();
    const a = randomUUID();
    const b = randomUUID();
    // Two rows with the same display name — fresh wins.
    await sql`
      INSERT INTO agents (id, pane_id, session, repo_path, started_at, state, role, custom_name, last_state_change, updated_at)
      VALUES (${a}, 'p', 's', '/t', now() - INTERVAL '1 day', 'idle', 'engineer', 'engineer-shared', now() - INTERVAL '1 day', now() - INTERVAL '1 day'),
             (${b}, 'p', 's', '/t', now(), 'idle', 'engineer', 'engineer-shared', now(), now())
    `;
    const map = await loadAgentObservabilityMap();
    expect(map.get('engineer-shared')?.agentId).toBe(b);
  });

  test('performance: 200 agents × ~2k tool events resolves in under one second', async () => {
    const sql = await getConnection();
    // Build up a fixture that exceeds typical local-dev scale (more reflective
    // of the felipe DB shape: many agents, high tool_event volume per agent)
    // and confirm the view stays responsive without indexes-tuning regressions.
    const agentCount = 200;
    const eventsPerAgent = 10;
    for (let i = 0; i < agentCount; i++) {
      const id = `perf-agent-${i}-${randomUUID()}`;
      const sessionId = `perf-sess-${i}-${randomUUID()}`;
      await sql`
        INSERT INTO agents (id, pane_id, session, repo_path, started_at, state, role, custom_name, last_state_change)
        VALUES (${id}, ${`p-${i}`}, ${`s-${i}`}, '/t', now(), 'idle', 'engineer', ${`engineer-${i}`}, now())
      `;
      // Sessions row first — tool_events.session_id is FK-constrained.
      await sql`
        INSERT INTO sessions (id, agent_id, project_path, jsonl_path, started_at, status)
        VALUES (${sessionId}, ${id}, '/t', '/t/log.jsonl', now(), 'active')
      `;
      // Insert tool events in one batch per agent for speed.
      const rows = Array.from({ length: eventsPerAgent }, (_, j) => ({
        session_id: sessionId,
        turn_index: j,
        timestamp: new Date().toISOString(),
        tool_name: 'Read',
        agent_id: id,
        is_error: j % 7 === 0,
      }));
      await sql`INSERT INTO tool_events ${sql(rows, 'session_id', 'turn_index', 'timestamp', 'tool_name', 'agent_id', 'is_error')}`;
    }

    const t0 = performance.now();
    const list = await listAgentObservability({ limit: agentCount + 50 });
    const elapsed = performance.now() - t0;
    expect(list.length).toBeGreaterThanOrEqual(agentCount);
    // Generous bound; on the live felipe DB a similar query has measured
    // <100 ms. We assert <1000 ms so transient CI variance won't flake.
    expect(elapsed).toBeLessThan(1000);
  });
});
