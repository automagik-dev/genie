/**
 * Tests for `genie recover-orphans` — the JSONL backfill scanner.
 *
 * Pure-function coverage runs unconditionally (filename pattern + first-message
 * preview parsing). The DB-touching paths are gated on DB_AVAILABLE so the
 * suite is skippable on hosts without pgserve.
 *
 * Run with: bun test src/genie-commands/__tests__/recover-orphans.test.ts
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findOrCreateAgent } from '../../lib/agent-registry.js';
import { getConnection } from '../../lib/db.js';
import { findExecutorBySession } from '../../lib/executor-registry.js';
import { DB_AVAILABLE, setupTestDatabase } from '../../lib/test-db.js';
import { _internal, recoverOrphansCommand, scanOrphans } from '../recover-orphans.js';

// ============================================================================
// Pure helpers — no DB
// ============================================================================

describe('recover-orphans helpers', () => {
  test('encodeCwdForClaudeProjects matches Claude Code projects-dir naming', () => {
    expect(_internal.encodeCwdForClaudeProjects('/tmp/myagent')).toBe('-tmp-myagent');
    expect(_internal.encodeCwdForClaudeProjects('/home/genie/workspace/repos/genie')).toBe(
      '-home-genie-workspace-repos-genie',
    );
  });

  test('isSessionJsonl accepts uuid.jsonl, rejects backups and trimmed copies', () => {
    expect(_internal.isSessionJsonl('1ee92ab4-9fec-4839-99b5-1a90e5899e70.jsonl')).toBe(true);
    expect(_internal.isSessionJsonl('1ee92ab4-9fec-4839-99b5-1a90e5899e70.jsonl.bak')).toBe(false);
    expect(_internal.isSessionJsonl('1ee92ab4-9fec-4839-99b5-1a90e5899e70.trimmed.jsonl')).toBe(false);
    expect(_internal.isSessionJsonl('not-a-uuid.jsonl')).toBe(false);
    expect(_internal.isSessionJsonl('README.md')).toBe(false);
  });

  test('readFirstUserMessagePreview extracts the first user text turn', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recover-orphans-'));
    const path = join(dir, 'fixture.jsonl');
    const lines = [
      JSON.stringify({ type: 'agent-name', agentName: 'genie' }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'hello world from felipe' }] },
      }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'hi' } }),
    ];
    writeFileSync(path, `${lines.join('\n')}\n`);
    expect(_internal.readFirstUserMessagePreview(path)).toBe('hello world from felipe');
    rmSync(dir, { recursive: true, force: true });
  });

  test('readFirstUserMessagePreview tolerates malformed JSON and returns null on no match', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recover-orphans-'));
    const path = join(dir, 'fixture.jsonl');
    writeFileSync(path, 'not json at all\n{"type":"system","content":"x"}\n');
    expect(_internal.readFirstUserMessagePreview(path)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test('pickCanonicalAgent prefers dir:* master, then lex-smallest UUID', () => {
    const rows = [
      {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        repo_path: '/x',
        team: null,
        custom_name: null,
        current_executor_id: null,
      },
      { id: 'dir:my-cwd', repo_path: '/x', team: null, custom_name: null, current_executor_id: null },
    ];
    expect(_internal.pickCanonicalAgent(rows)?.id).toBe('dir:my-cwd');

    const noDir = [
      {
        id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        repo_path: '/x',
        team: null,
        custom_name: null,
        current_executor_id: null,
      },
      {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        repo_path: '/x',
        team: null,
        custom_name: null,
        current_executor_id: null,
      },
    ];
    expect(_internal.pickCanonicalAgent(noDir)?.id).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

    expect(_internal.pickCanonicalAgent([])).toBeNull();
  });
});

// ============================================================================
// DB-backed integration
// ============================================================================

describe.skipIf(!DB_AVAILABLE)('recover-orphans integration', () => {
  let cleanup: () => Promise<void>;
  let claudeRoot: string;
  let projectsRoot: string;
  let origConfigDir: string | undefined;

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    // Each test gets its own CLAUDE_CONFIG_DIR so projects/ scans are
    // hermetic and don't pick up the developer's real ~/.claude state.
    claudeRoot = mkdtempSync(join(tmpdir(), 'claude-cfg-'));
    projectsRoot = join(claudeRoot, 'projects');
    mkdirSync(projectsRoot, { recursive: true });
    origConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeRoot;

    const sql = await getConnection();
    await sql`DELETE FROM audit_events`;
    await sql`DELETE FROM executors`;
    await sql`DELETE FROM agents`;
  });

  afterEach(() => {
    rmSync(claudeRoot, { recursive: true, force: true });
    process.env.CLAUDE_CONFIG_DIR = origConfigDir;
  });

  async function seedAgentWithRepoPath(name: string, team: string, repoPath: string): Promise<string> {
    const identity = await findOrCreateAgent(name, team, 'engineer');
    const sql = await getConnection();
    await sql`UPDATE agents SET repo_path = ${repoPath} WHERE id = ${identity.id}`;
    return identity.id;
  }

  function writeJsonlFixture(encodedDir: string, sessionId: string, opts: { mtime?: Date } = {}): string {
    const dir = join(projectsRoot, encodedDir);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: 'summary', summary: 'Test session' }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'do the work' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: 'on it' },
      }),
    ];
    writeFileSync(file, `${lines.join('\n')}\n`);
    if (opts.mtime) {
      const { utimesSync } = require('node:fs');
      utimesSync(file, opts.mtime, opts.mtime);
    }
    return file;
  }

  test('scan + parse: detects orphan JSONL and maps it to the right agent', async () => {
    const repoPath = '/tmp/recover-orphans-fixture-a';
    await seedAgentWithRepoPath('engineer', 'fixture-a', repoPath);
    const sessionId = '11111111-1111-4111-8111-111111111111';
    writeJsonlFixture('-tmp-recover-orphans-fixture-a', sessionId);

    const summaries = await scanOrphans({ dir: repoPath });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].agent?.team).toBe('fixture-a');
    expect(summaries[0].agent?.customName).toBe('engineer');
    expect(summaries[0].orphans).toHaveLength(1);
    expect(summaries[0].orphans[0].sessionId).toBe(sessionId);
    expect(summaries[0].orphans[0].firstMessagePreview).toBe('do the work');
    expect(summaries[0].agentHasLiveExecutor).toBe(false);
  });

  test('--apply --newest attaches the newest orphan and links it as current_executor', async () => {
    const repoPath = '/tmp/recover-orphans-fixture-b';
    const agentId = await seedAgentWithRepoPath('engineer', 'fixture-b', repoPath);

    const newestId = '22222222-2222-4222-8222-222222222222';
    const olderId = '22222222-2222-4222-8222-222222222221';
    writeJsonlFixture('-tmp-recover-orphans-fixture-b', olderId, { mtime: new Date(Date.now() - 86400_000) });
    writeJsonlFixture('-tmp-recover-orphans-fixture-b', newestId);

    await recoverOrphansCommand({ dir: repoPath, apply: true, newest: true });

    const linked = await findExecutorBySession(newestId);
    expect(linked).not.toBeNull();
    expect(linked?.agentId).toBe(agentId);
    expect(linked?.claudeSessionId).toBe(newestId);

    const sql = await getConnection();
    const agentRows = await sql<{ current_executor_id: string | null }[]>`
      SELECT current_executor_id FROM agents WHERE id = ${agentId} LIMIT 1
    `;
    expect(agentRows[0].current_executor_id).toBe(linked?.id ?? '');
  });

  test('idempotent: running --apply --newest twice does not duplicate the executor row', async () => {
    const repoPath = '/tmp/recover-orphans-fixture-c';
    const agentId = await seedAgentWithRepoPath('engineer', 'fixture-c', repoPath);
    const sessionId = '33333333-3333-4333-8333-333333333333';
    writeJsonlFixture('-tmp-recover-orphans-fixture-c', sessionId);

    await recoverOrphansCommand({ dir: repoPath, apply: true, newest: true });
    await recoverOrphansCommand({ dir: repoPath, apply: true, newest: true });

    const sql = await getConnection();
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM executors WHERE agent_id = ${agentId} AND claude_session_id = ${sessionId}
    `;
    expect(rows).toHaveLength(1);
  });

  test('refuses to overwrite a live executor', async () => {
    const repoPath = '/tmp/recover-orphans-fixture-d';
    const agentId = await seedAgentWithRepoPath('engineer', 'fixture-d', repoPath);
    const sql = await getConnection();
    // Seed a LIVE executor (no ended_at) and link it as current.
    const liveExecId = '44444444-4444-4444-4444-444444444411';
    await sql`
      INSERT INTO executors (id, agent_id, provider, transport, state, started_at)
      VALUES (${liveExecId}, ${agentId}, 'claude', 'tmux', 'running', now())
    `;
    await sql`UPDATE agents SET current_executor_id = ${liveExecId} WHERE id = ${agentId}`;

    const orphanId = '44444444-4444-4444-8444-444444444444';
    writeJsonlFixture('-tmp-recover-orphans-fixture-d', orphanId);

    await recoverOrphansCommand({ dir: repoPath, apply: true, newest: true });

    // The orphan must NOT have been attached.
    const found = await findExecutorBySession(orphanId);
    expect(found).toBeNull();
    // The live executor stays current.
    const agentRows = await sql<{ current_executor_id: string | null }[]>`
      SELECT current_executor_id FROM agents WHERE id = ${agentId} LIMIT 1
    `;
    expect(agentRows[0].current_executor_id).toBe(liveExecId);
  });

  test('--list never mutates', async () => {
    const repoPath = '/tmp/recover-orphans-fixture-e';
    await seedAgentWithRepoPath('engineer', 'fixture-e', repoPath);
    const sessionId = '55555555-5555-4555-8555-555555555555';
    writeJsonlFixture('-tmp-recover-orphans-fixture-e', sessionId);

    await recoverOrphansCommand({ dir: repoPath, list: true });

    const found = await findExecutorBySession(sessionId);
    expect(found).toBeNull();
  });
});
