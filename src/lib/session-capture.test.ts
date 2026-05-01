/**
 * Tests for session-capture module.
 *
 * Focus: defenses added to keep backfill ingestion healthy and complete.
 *   1. extractSubTool() — truncate to fit Postgres btree row limit (idx_te_sub_tool).
 *   2. ensureSession() — when parent session missing, insert with NULL rather
 *      than crashing on sessions_parent_session_id_fkey.
 *   3. reconcileSubagentParents() SQL — surface shape, no throw.
 *   4. reconcileSubagentParents() metadata inheritance — subagent rows captured
 *      before their parent worker registered should pick up agent_id/team/
 *      wish_slug/task_id/role from their parent session.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConnection, resetConnection } from './db.js';
import { buildWorkerMap, extractSubTool, ingestFile, reconcileSubagentParents } from './session-capture.js';
import { DB_AVAILABLE, setupTestDatabase } from './test-db.js';

/**
 * Warm up the SQL connection and retry once on `CONNECTION_ENDED`. The race
 * is documented at issue #1207: when an emit-queue background flush against
 * a pool whose database was just swapped by `setupTestDatabase` lands on the
 * test runner's `await sql\`...\`` path, the first query throws with
 * `code: "CONNECTION_ENDED"`. The fix is to discard the stale singleton and
 * grab a fresh one. Any test in this file that does a SELECT/INSERT against
 * `sessions` / `agents` / `executors` should call this in `beforeEach` so
 * the underlying pool is healthy before the test body runs.
 */
async function warmConnection(): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const sql = await getConnection();
      await sql`SELECT 1`;
      return;
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === 'CONNECTION_ENDED' && attempt === 0) {
        await resetConnection();
        continue;
      }
      throw err;
    }
  }
}

describe('extractSubTool — truncation for btree row size', () => {
  test('Bash: first line of command, trimmed, capped at 2000 chars', () => {
    const longLine = 'a'.repeat(5000);
    const result = extractSubTool('Bash', { command: longLine });
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2000);
    expect(result?.startsWith('aaaa')).toBe(true);
  });

  test('Bash: short command returned intact', () => {
    expect(extractSubTool('Bash', { command: 'ls -la' })).toBe('ls -la');
  });

  test('Bash: multi-line HEREDOC — only first line captured', () => {
    const cmd = `git commit -m "$(cat <<'EOF'\n${'x'.repeat(10000)}\nEOF\n)"`;
    const result = extractSubTool('Bash', { command: cmd });
    expect(result).not.toBeNull();
    expect(result?.length).toBeLessThanOrEqual(2000);
    expect(result).toBe("git commit -m \"$(cat <<'EOF'");
  });

  test('Read/Write/Edit: file_path capped at 2000', () => {
    const longPath = `/tmp/${'nested/'.repeat(400)}file.ts`;
    for (const tool of ['Read', 'Write', 'Edit'] as const) {
      const r = extractSubTool(tool, { file_path: longPath });
      expect(r).not.toBeNull();
      expect(r?.length).toBeLessThanOrEqual(2000);
    }
  });

  test('Grep/Glob: pattern capped at 2000', () => {
    const big = 'x'.repeat(10000);
    expect(extractSubTool('Grep', { pattern: big })?.length).toBe(2000);
    expect(extractSubTool('Glob', { pattern: big })?.length).toBe(2000);
  });

  test('Agent/Skill: identifiers returned as-is', () => {
    expect(extractSubTool('Agent', { subagent_type: 'Explore' })).toBe('Explore');
    expect(extractSubTool('Skill', { skill: 'brain-search' })).toBe('brain-search');
  });

  test('unknown tool returns null', () => {
    expect(extractSubTool('SomeNewTool', { whatever: 1 })).toBeNull();
  });

  test('empty/missing input returns null', () => {
    expect(extractSubTool('Bash', { command: '' })).toBeNull();
    expect(extractSubTool('Bash', {})).toBeNull();
    expect(extractSubTool('Bash', null)).toBeNull();
  });
});

describe.skipIf(!DB_AVAILABLE)('reconcileSubagentParents — metadata inheritance', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
  });

  beforeEach(async () => {
    // Guard against the issue-#1207 emit-queue race that occasionally
    // surfaces CONNECTION_ENDED on the first SQL of this describe block
    // when other test files in the shard finish flushing background work
    // moments before this test starts. See `warmConnection` doc.
    await warmConnection();
  });

  afterAll(async () => {
    await cleanup();
  });

  test('backfills agent_id/team/wish_slug/task_id/role/executor_id from parent', async () => {
    const sql = await getConnection();
    const parentId = 'parent-sess-1';
    const childId = 'agent-child-1';

    // Real executor row so the FK constraint holds when we inherit executor_id.
    await sql`
      INSERT INTO agents (id, role, started_at)
      VALUES ('agent-foo', 'engineer', now())
      ON CONFLICT DO NOTHING
    `;
    await sql`
      INSERT INTO executors (id, agent_id, provider, transport)
      VALUES ('exec-foo', 'agent-foo', 'claude', 'process')
      ON CONFLICT DO NOTHING
    `;

    // Parent session — fully populated (simulates a real genie-spawned worker).
    await sql`
      INSERT INTO sessions (
        id, agent_id, executor_id, team, wish_slug, task_id, role,
        project_path, jsonl_path, status, is_subagent
      ) VALUES (
        ${parentId}, 'agent-foo', 'exec-foo', 'team-alpha',
        'wish-x', 'task-42', 'engineer',
        '/tmp/proj', '/tmp/proj/parent.jsonl', 'active', false
      )
    `;

    // Subagent row — parent_session_id already set (captured after
    // reconcileSubagentParents ran once to backfill the link) but
    // metadata is NULL because no worker was registered for it.
    await sql`
      INSERT INTO sessions (
        id, agent_id, executor_id, team, wish_slug, task_id, role,
        project_path, jsonl_path, status, is_subagent, parent_session_id
      ) VALUES (
        ${childId}, NULL, NULL, NULL, NULL, NULL, NULL,
        '/tmp/proj', ${`/tmp/proj/${parentId}/subagents/${childId}.jsonl`},
        'orphaned', true, ${parentId}
      )
    `;

    await reconcileSubagentParents(sql);

    const [row] = await sql`SELECT * FROM sessions WHERE id = ${childId}`;
    expect(row.agent_id).toBe('agent-foo');
    expect(row.executor_id).toBe('exec-foo');
    expect(row.team).toBe('team-alpha');
    expect(row.wish_slug).toBe('wish-x');
    expect(row.task_id).toBe('task-42');
    expect(row.role).toBe('engineer');
    // Status stays 'orphaned' — the subagent has no direct worker of its own.
    // The inheritance is metadata-only; status transitions are out of scope.
    expect(row.status).toBe('orphaned');
  });

  test('never overwrites existing non-null child values', async () => {
    const sql = await getConnection();
    const parentId = 'parent-sess-2';
    const childId = 'agent-child-2';

    await sql`
      INSERT INTO sessions (
        id, agent_id, team, wish_slug, task_id, role,
        project_path, jsonl_path, status, is_subagent
      ) VALUES (
        ${parentId}, 'parent-agent', 'parent-team', 'parent-wish',
        'parent-task', 'parent-role',
        '/tmp/proj2', '/tmp/proj2/parent.jsonl', 'active', false
      )
    `;

    // Child has its own agent_id + team already; other fields NULL.
    await sql`
      INSERT INTO sessions (
        id, agent_id, team, wish_slug, task_id, role,
        project_path, jsonl_path, status, is_subagent, parent_session_id
      ) VALUES (
        ${childId}, 'child-agent', 'child-team', NULL, NULL, NULL,
        '/tmp/proj2', ${`/tmp/proj2/${parentId}/subagents/${childId}.jsonl`},
        'orphaned', true, ${parentId}
      )
    `;

    await reconcileSubagentParents(sql);

    const [row] = await sql`SELECT * FROM sessions WHERE id = ${childId}`;
    // Pre-existing values preserved (COALESCE takes the non-null child value).
    expect(row.agent_id).toBe('child-agent');
    expect(row.team).toBe('child-team');
    // Previously-null fields filled from parent.
    expect(row.wish_slug).toBe('parent-wish');
    expect(row.task_id).toBe('parent-task');
    expect(row.role).toBe('parent-role');
  });

  test('no-op when parent also has NULL fields', async () => {
    const sql = await getConnection();
    const parentId = 'parent-sess-3';
    const childId = 'agent-child-3';

    await sql`
      INSERT INTO sessions (id, project_path, jsonl_path, status, is_subagent)
      VALUES (${parentId}, '/tmp/proj3', '/tmp/proj3/parent.jsonl', 'orphaned', false)
    `;
    await sql`
      INSERT INTO sessions (id, project_path, jsonl_path, status, is_subagent, parent_session_id)
      VALUES (${childId}, '/tmp/proj3',
              ${`/tmp/proj3/${parentId}/subagents/${childId}.jsonl`},
              'orphaned', true, ${parentId})
    `;

    // Should not throw even when both rows are metadata-free.
    const result = await reconcileSubagentParents(sql);
    expect(result.linked).toBe(0);
    expect(result.metadataFilled).toBe(0);

    const [row] = await sql`SELECT agent_id, team FROM sessions WHERE id = ${childId}`;
    expect(row.agent_id).toBeNull();
    expect(row.team).toBeNull();
  });

  test('does NOT inherit executor_id when child agent differs from parent (codex review)', async () => {
    // Scenario: child has its own agent_id that differs from parent's.
    // Naively inheriting executor_id would link the child to an executor
    // row that belongs to a different agent, breaking the executor→agent
    // identity invariant used by `sessions → executors → agents` joins.
    const sql = await getConnection();
    const parentId = 'parent-sess-4';
    const childId = 'agent-child-4';

    await sql`
      INSERT INTO agents (id, role, started_at)
      VALUES ('agent-parent-x', 'engineer', now())
      ON CONFLICT DO NOTHING
    `;
    await sql`
      INSERT INTO executors (id, agent_id, provider, transport)
      VALUES ('exec-parent-x', 'agent-parent-x', 'claude', 'process')
      ON CONFLICT DO NOTHING
    `;
    await sql`
      INSERT INTO sessions (
        id, agent_id, executor_id, team,
        project_path, jsonl_path, status, is_subagent
      ) VALUES (
        ${parentId}, 'agent-parent-x', 'exec-parent-x', 'team-parent-x',
        '/tmp/proj4', '/tmp/proj4/parent.jsonl', 'active', false
      )
    `;
    // Child has a DIFFERENT agent_id but no executor_id.
    await sql`
      INSERT INTO sessions (
        id, agent_id, executor_id, team,
        project_path, jsonl_path, status, is_subagent, parent_session_id
      ) VALUES (
        ${childId}, 'agent-child-distinct', NULL, NULL,
        '/tmp/proj4', ${`/tmp/proj4/${parentId}/subagents/${childId}.jsonl`},
        'orphaned', true, ${parentId}
      )
    `;

    await reconcileSubagentParents(sql);

    const [row] = await sql`SELECT * FROM sessions WHERE id = ${childId}`;
    // Child's own agent preserved (COALESCE).
    expect(row.agent_id).toBe('agent-child-distinct');
    // CRITICAL: executor NOT inherited — would have paired the child with
    // an executor row pointing at 'agent-parent-x'.
    expect(row.executor_id).toBeNull();
    // Safe fields still inherited from parent.
    expect(row.team).toBe('team-parent-x');
  });

  test('returns structured counts for linked and metadataFilled', async () => {
    const sql = await getConnection();
    const parentId = 'parent-sess-5';
    const childId = 'agent-child-5';

    await sql`
      INSERT INTO sessions (id, agent_id, team, project_path, jsonl_path, status, is_subagent)
      VALUES (${parentId}, 'agent-p5', 'team-5',
              '/tmp/proj5', '/tmp/proj5/parent.jsonl', 'active', false)
    `;
    await sql`
      INSERT INTO sessions (id, project_path, jsonl_path, status, is_subagent, parent_session_id)
      VALUES (${childId}, '/tmp/proj5',
              ${`/tmp/proj5/${parentId}/subagents/${childId}.jsonl`},
              'orphaned', true, ${parentId})
    `;

    const result = await reconcileSubagentParents(sql);
    // Parent link was already set, so linked=0 for this child.
    // Metadata should have been filled for this one row.
    expect(result.linked).toBeGreaterThanOrEqual(0);
    expect(result.metadataFilled).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// Group 1 (fix-agent-session-linkage wish): orphan-upgrade reproduction
//
// Bug signature on the live `felipe` DB and locally:
//   - sessions.id == executors.claude_session_id
//   - sessions.executor_id IS NULL, status='orphaned'
//
// Root cause (this test asserts the symptom — the fix lands in Group 2):
//   ensureSession() in session-capture.ts SELECTs the existing orphan row
//   and early-returns. It never UPDATEs the orphan with the now-known
//   worker context, so the row stays orphaned for the lifetime of the row.
//
// Expected after Group 2:
//   ingestFile() upgrades sessions.executor_id, agent_id, team, wish_slug,
//   task_id, role from the workerMap when the row already exists with NULLs.
// ============================================================================

describe.skipIf(!DB_AVAILABLE)(
  'ingestion upgrades existing orphan sessions when executor context appears later',
  () => {
    let cleanup: () => Promise<void>;
    let workDir: string;

    beforeAll(async () => {
      cleanup = await setupTestDatabase();
      workDir = await mkdtemp(join(tmpdir(), 'session-link-repro-'));
    });

    beforeEach(async () => {
      await warmConnection();
    });

    afterAll(async () => {
      await cleanup();
      try {
        await rm(workDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    });

    test('orphan session matching executors.claude_session_id is linked after ingestion', async () => {
      const sql = await getConnection();
      const agentId = 'agent-orphan-upgrade';
      const executorId = 'exec-orphan-upgrade';
      const sessionId = 'sess-orphan-upgrade';
      const projectPath = '/tmp/proj-orphan-upgrade';
      const jsonlPath = join(workDir, `${sessionId}.jsonl`);

      // Empty JSONL is enough — ingestFile still runs ensureSession() before
      // returning when the file is 0 bytes, which is exactly the path we want
      // to exercise. (No assistant turns to parse, so no extra writes.)
      await writeFile(jsonlPath, '');

      await sql`
      INSERT INTO agents (id, role, started_at, team, wish_slug, task_id)
      VALUES (${agentId}, 'engineer', now(), 'team-link-x', 'wish-link-x', 'task-link-x')
      ON CONFLICT DO NOTHING
    `;
      await sql`
      INSERT INTO executors (id, agent_id, provider, transport, claude_session_id)
      VALUES (${executorId}, ${agentId}, 'claude', 'process', ${sessionId})
      ON CONFLICT DO NOTHING
    `;
      // Pre-existing orphan row — this is the row Genie failed to upgrade.
      await sql`
      INSERT INTO sessions (id, executor_id, agent_id, team, role, wish_slug, task_id,
                            project_path, jsonl_path, status, last_ingested_offset, total_turns)
      VALUES (${sessionId}, NULL, NULL, NULL, NULL, NULL, NULL,
              ${projectPath}, ${jsonlPath}, 'orphaned', 0, 0)
    `;

      // Build a fresh worker map so the in-module 5-minute cache from prior
      // tests in this file cannot mask the new executor row.
      const workerMap = await buildWorkerMap(sql);

      await ingestFile(sql, sessionId, jsonlPath, projectPath, 0, { workerMap });

      const [row] =
        await sql`SELECT executor_id, agent_id, team, wish_slug, task_id, role, status FROM sessions WHERE id = ${sessionId}`;

      // The four assertions a fix in Group 2 must satisfy:
      expect(row.executor_id).toBe(executorId);
      expect(row.agent_id).toBe(agentId);
      expect(row.team).toBe('team-link-x');
      expect(row.wish_slug).toBe('wish-link-x');
      expect(row.task_id).toBe('task-link-x');
      // Status transitioning out of 'orphaned' is the user-visible signal.
      expect(row.status).not.toBe('orphaned');
    });

    test('ingestion does NOT downgrade an existing fully-linked session (stays linked)', async () => {
      // Counterpart to the upgrade test: a session that is already linked to
      // the right executor/agent must keep its values. Group 2 must use
      // COALESCE-style upgrades, never blanket overwrites.
      const sql = await getConnection();
      const agentId = 'agent-keep-linked';
      const executorId = 'exec-keep-linked';
      const sessionId = 'sess-keep-linked';
      const projectPath = '/tmp/proj-keep-linked';
      const jsonlPath = join(workDir, `${sessionId}.jsonl`);
      await writeFile(jsonlPath, '');

      await sql`
      INSERT INTO agents (id, role, started_at, team, wish_slug)
      VALUES (${agentId}, 'engineer', now(), 'team-keep', 'wish-keep')
      ON CONFLICT DO NOTHING
    `;
      await sql`
      INSERT INTO executors (id, agent_id, provider, transport, claude_session_id)
      VALUES (${executorId}, ${agentId}, 'claude', 'process', ${sessionId})
      ON CONFLICT DO NOTHING
    `;
      await sql`
      INSERT INTO sessions (id, executor_id, agent_id, team, wish_slug,
                            project_path, jsonl_path, status, last_ingested_offset, total_turns)
      VALUES (${sessionId}, ${executorId}, ${agentId}, 'team-keep', 'wish-keep',
              ${projectPath}, ${jsonlPath}, 'active', 0, 0)
    `;

      const workerMap = await buildWorkerMap(sql);
      await ingestFile(sql, sessionId, jsonlPath, projectPath, 0, { workerMap });

      const [row] =
        await sql`SELECT executor_id, agent_id, team, wish_slug, status FROM sessions WHERE id = ${sessionId}`;
      expect(row.executor_id).toBe(executorId);
      expect(row.agent_id).toBe(agentId);
      expect(row.team).toBe('team-keep');
      expect(row.wish_slug).toBe('wish-keep');
      expect(row.status).toBe('active');
    });
  },
);
