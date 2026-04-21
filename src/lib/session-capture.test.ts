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

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getConnection } from './db.js';
import { extractSubTool, reconcileSubagentParents } from './session-capture.js';
import { DB_AVAILABLE, setupTestSchema } from './test-db.js';

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
    cleanup = await setupTestSchema();
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
    await expect(reconcileSubagentParents(sql)).resolves.toBeDefined();

    const [row] = await sql`SELECT agent_id, team FROM sessions WHERE id = ${childId}`;
    expect(row.agent_id).toBeNull();
    expect(row.team).toBeNull();
  });
});
