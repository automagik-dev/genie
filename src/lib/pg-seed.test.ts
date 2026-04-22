import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConnection } from './db.js';
import { needsSeed, runSeed } from './pg-seed.js';
import { DB_AVAILABLE, setupTestDatabase } from './test-db.js';

describe.skipIf(!DB_AVAILABLE)('pg', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanup();
  });

  // ============================================================================
  // Migration: 005_pg_state.sql creates all tables
  // ============================================================================

  describe('migration 005_pg_state', () => {
    test('agents table exists with correct columns', async () => {
      const sql = await getConnection();
      const result = await sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'agents'
        ORDER BY ordinal_position
      `;
      const columns = result.map((r: { column_name: string }) => r.column_name);
      expect(columns).toContain('id');
      expect(columns).toContain('pane_id');
      expect(columns).toContain('session');
      expect(columns).toContain('state');
      expect(columns).toContain('repo_path');
      expect(columns).toContain('pane_color');
      expect(columns).toContain('team');
      expect(columns).toContain('role');
      expect(columns).toContain('auto_resume');
      expect(columns).toContain('resume_attempts');
      expect(columns).toContain('wish_slug');
      expect(columns).toContain('group_number');
    });

    test('agent_templates table exists', async () => {
      const sql = await getConnection();
      const result = await sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'agent_templates'
        ORDER BY ordinal_position
      `;
      const columns = result.map((r: { column_name: string }) => r.column_name);
      expect(columns).toContain('id');
      expect(columns).toContain('provider');
      expect(columns).toContain('team');
      expect(columns).toContain('cwd');
      expect(columns).toContain('last_spawned_at');
    });

    test('teams table exists', async () => {
      const sql = await getConnection();
      const result = await sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'teams'
        ORDER BY ordinal_position
      `;
      const columns = result.map((r: { column_name: string }) => r.column_name);
      expect(columns).toContain('name');
      expect(columns).toContain('repo');
      expect(columns).toContain('members');
      expect(columns).toContain('status');
      expect(columns).toContain('wish_slug');
    });

    test('mailbox table exists', async () => {
      const sql = await getConnection();
      const result = await sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'mailbox'
        ORDER BY ordinal_position
      `;
      const columns = result.map((r: { column_name: string }) => r.column_name);
      expect(columns).toContain('id');
      expect(columns).toContain('from_worker');
      expect(columns).toContain('to_worker');
      expect(columns).toContain('body');
      expect(columns).toContain('repo_path');
      expect(columns).toContain('read');
      expect(columns).toContain('delivered_at');
    });

    test('team_chat table exists', async () => {
      const sql = await getConnection();
      const result = await sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'team_chat'
        ORDER BY ordinal_position
      `;
      const columns = result.map((r: { column_name: string }) => r.column_name);
      expect(columns).toContain('id');
      expect(columns).toContain('team');
      expect(columns).toContain('repo_path');
      expect(columns).toContain('sender');
      expect(columns).toContain('body');
    });

    test('all 5 tables created', async () => {
      const sql = await getConnection();
      const tables = ['agents', 'agent_templates', 'teams', 'mailbox', 'team_chat'];
      for (const table of tables) {
        const result = await sql`
          SELECT EXISTS (
            SELECT 1 FROM information_schema.tables WHERE table_name = ${table}
          ) AS exists
        `;
        expect(result[0].exists).toBe(true);
      }
    });

    test('agents state check constraint works', async () => {
      const sql = await getConnection();
      // Valid state should succeed
      await sql`
        INSERT INTO agents (id, pane_id, session, state, started_at, last_state_change, repo_path)
        VALUES ('test-check-1', '%99', 'test-sess', 'idle', now(), now(), '/tmp/test')
      `;
      // Invalid state should fail
      let threw = false;
      try {
        await sql`
          INSERT INTO agents (id, pane_id, session, state, started_at, last_state_change, repo_path)
          VALUES ('test-check-2', '%100', 'test-sess', 'invalid_state', now(), now(), '/tmp/test')
        `;
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      // Cleanup
      await sql`DELETE FROM agents WHERE id LIKE 'test-check-%'`;
    });

    test('LISTEN/NOTIFY triggers exist', async () => {
      const sql = await getConnection();
      const triggers = await sql`
        SELECT trigger_name FROM information_schema.triggers
        WHERE event_object_table IN ('agents', 'mailbox')
        ORDER BY trigger_name
      `;
      const names = triggers.map((t: { trigger_name: string }) => t.trigger_name);
      expect(names).toContain('trg_notify_agent_state');
      expect(names).toContain('trg_notify_mailbox');
    });
  });

  // ============================================================================
  // Seed: JSON → PG
  // ============================================================================

  describe('seed', () => {
    let testHome: string;
    let testRepo: string;
    let testClaudeDir: string;
    let origGenieHome: string | undefined;
    let origClaudeConfigDir: string | undefined;

    beforeAll(() => {
      testHome = join(tmpdir(), `genie-seed-test-${Date.now()}`);
      testRepo = join(tmpdir(), `genie-seed-repo-${Date.now()}`);
      testClaudeDir = join(tmpdir(), `genie-seed-claude-${Date.now()}`);
      origGenieHome = process.env.GENIE_HOME;
      origClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
      process.env.GENIE_HOME = testHome;
      // Point Claude-native team layout to a test-local dir so the seed's
      // team path reads only what each test explicitly writes. See Bug A.
      process.env.CLAUDE_CONFIG_DIR = testClaudeDir;
      mkdirSync(testHome, { recursive: true });
      mkdirSync(testRepo, { recursive: true });
      mkdirSync(join(testClaudeDir, 'teams'), { recursive: true });
    });

    afterAll(async () => {
      process.env.GENIE_HOME = origGenieHome;
      process.env.CLAUDE_CONFIG_DIR = origClaudeConfigDir;
      const { rmSync } = require('node:fs');
      try {
        rmSync(testHome, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(testRepo, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(testClaudeDir, { recursive: true, force: true });
      } catch {}
      // Clean up seeded data
      const sql = await getConnection();
      await sql`DELETE FROM agents WHERE id LIKE 'seed-test-%'`;
      await sql`DELETE FROM agent_templates WHERE id LIKE 'seed-tpl-%'`;
      await sql`DELETE FROM teams WHERE name LIKE 'seed-team-%'`;
      await sql`DELETE FROM mailbox WHERE id LIKE 'seed-msg-%'`;
      await sql`DELETE FROM team_chat WHERE id LIKE 'seed-chat-%'`;
    });

    test('needsSeed detects workers.json', () => {
      const workersPath = join(testHome, 'workers.json');
      writeFileSync(
        workersPath,
        JSON.stringify({
          workers: {
            'seed-test-1': {
              id: 'seed-test-1',
              paneId: '%1',
              session: 's',
              state: 'idle',
              startedAt: new Date().toISOString(),
              lastStateChange: new Date().toISOString(),
              repoPath: '/tmp',
            },
          },
          templates: {},
          lastUpdated: new Date().toISOString(),
        }),
      );
      expect(needsSeed()).toBe(true);
    });

    test('seed imports workers.json into agents table', async () => {
      const sql = await getConnection();
      const now = new Date().toISOString();
      const workersPath = join(testHome, 'workers.json');
      writeFileSync(
        workersPath,
        JSON.stringify({
          workers: {
            'seed-test-agent': {
              id: 'seed-test-agent',
              paneId: '%42',
              session: 'test-session',
              worktree: null,
              state: 'working',
              startedAt: now,
              lastStateChange: now,
              repoPath: '/tmp/test-repo',
              role: 'engineer',
              team: 'seed-team-alpha',
              provider: 'claude',
              transport: 'tmux',
              autoResume: true,
              resumeAttempts: 0,
            },
          },
          templates: {
            'seed-tpl-1': {
              id: 'seed-tpl-1',
              provider: 'claude',
              team: 'seed-team-alpha',
              role: 'engineer',
              cwd: '/tmp/test-repo',
              lastSpawnedAt: now,
            },
          },
          lastUpdated: now,
        }),
      );

      const result = await runSeed(sql, testRepo);
      expect(result.agents).toBe(1);
      expect(result.templates).toBe(1);

      // Verify agent in PG
      const agents = await sql`SELECT * FROM agents WHERE id = 'seed-test-agent'`;
      expect(agents.length).toBe(1);
      expect(agents[0].pane_id).toBe('%42');
      expect(agents[0].state).toBe('working');
      expect(agents[0].role).toBe('engineer');
      expect(agents[0].team).toBe('seed-team-alpha');

      // Verify template in PG
      const templates = await sql`SELECT * FROM agent_templates WHERE id = 'seed-tpl-1'`;
      expect(templates.length).toBe(1);
      expect(templates[0].provider).toBe('claude');

      // Verify source file renamed to .migrated
      expect(existsSync(workersPath)).toBe(false);
      expect(existsSync(`${workersPath}.migrated`)).toBe(true);
    });

    test('seed imports ~/.claude/teams/<name>/config.json into teams table', async () => {
      const sql = await getConnection();
      const teamDir = join(testClaudeDir, 'teams', 'seed-team-beta');
      mkdirSync(teamDir, { recursive: true });
      // Write a Claude-native config.json — the shape emitted by
      // `ensureNativeTeam` (rich NativeTeamMember[] in members).
      writeFileSync(
        join(teamDir, 'config.json'),
        JSON.stringify({
          name: 'seed-team-beta',
          description: 'Seed test team',
          createdAt: Date.now(),
          leadAgentId: 'engineer@seed-team-beta',
          leadSessionId: 'test-session',
          members: [
            {
              agentId: 'engineer@seed-team-beta',
              name: 'engineer',
              agentType: 'engineer',
              joinedAt: Date.now(),
              backendType: 'tmux',
              color: 'blue',
              planModeRequired: false,
              isActive: true,
            },
            {
              agentId: 'reviewer@seed-team-beta',
              name: 'reviewer',
              agentType: 'reviewer',
              joinedAt: Date.now(),
              backendType: 'tmux',
              color: 'red',
              planModeRequired: false,
              isActive: true,
            },
          ],
          repo: '/tmp/test-repo',
          worktreePath: '/tmp/worktree/seed-team-beta',
          baseBranch: 'dev',
          status: 'in_progress',
        }),
      );

      const result = await runSeed(sql, testRepo);
      expect(result.teams).toBe(1);

      const teams = await sql`SELECT * FROM teams WHERE name = 'seed-team-beta'`;
      expect(teams.length).toBe(1);
      expect(teams[0].repo).toBe('/tmp/test-repo');
      expect(teams[0].worktree_path).toBe('/tmp/worktree/seed-team-beta');
      expect(teams[0].leader).toBe('engineer');

      // Members must be a proper jsonb array (Bug D regression guard) and
      // must be the bare name strings (rich members mapped to names).
      const typeRow = await sql`SELECT jsonb_typeof(members) AS t FROM teams WHERE name = 'seed-team-beta'`;
      expect(typeRow[0].t).toBe('array');
      expect(teams[0].members).toEqual(['engineer', 'reviewer']);

      // Claude-native configs must NOT be renamed to .migrated (authoritative).
      expect(existsSync(join(teamDir, 'config.json'))).toBe(true);
      expect(existsSync(join(teamDir, 'config.json.migrated'))).toBe(false);
    });

    test('seed imports mailbox/*.json into mailbox table', async () => {
      const sql = await getConnection();
      const mailDir = join(testRepo, '.genie', 'mailbox');
      mkdirSync(mailDir, { recursive: true });
      writeFileSync(
        join(mailDir, 'engineer-1.json'),
        JSON.stringify({
          workerId: 'engineer-1',
          messages: [
            {
              id: 'seed-msg-1',
              from: 'team-lead',
              to: 'engineer-1',
              body: 'Start working on Group 1',
              createdAt: new Date().toISOString(),
              read: false,
              deliveredAt: null,
            },
          ],
          lastUpdated: new Date().toISOString(),
        }),
      );

      const result = await runSeed(sql, testRepo);
      expect(result.mailboxMessages).toBe(1);

      const msgs = await sql`SELECT * FROM mailbox WHERE id = 'seed-msg-1'`;
      expect(msgs.length).toBe(1);
      expect(msgs[0].from_worker).toBe('team-lead');
      expect(msgs[0].to_worker).toBe('engineer-1');
      expect(msgs[0].body).toBe('Start working on Group 1');
      expect(msgs[0].repo_path).toBe(testRepo);

      // Verify source file renamed
      expect(existsSync(join(mailDir, 'engineer-1.json'))).toBe(false);
      expect(existsSync(join(mailDir, 'engineer-1.json.migrated'))).toBe(true);
    });

    test('seed imports chat/*.jsonl into team_chat table', async () => {
      const sql = await getConnection();
      const chatDir = join(testRepo, '.genie', 'chat');
      mkdirSync(chatDir, { recursive: true });
      const lines = [
        JSON.stringify({
          id: 'seed-chat-1',
          sender: 'engineer',
          body: 'Starting task',
          timestamp: new Date().toISOString(),
        }),
        JSON.stringify({ id: 'seed-chat-2', sender: 'reviewer', body: 'LGTM', timestamp: new Date().toISOString() }),
      ].join('\n');
      writeFileSync(join(chatDir, 'seed-team-gamma.jsonl'), lines);

      const result = await runSeed(sql, testRepo);
      expect(result.chatMessages).toBe(2);

      const msgs = await sql`SELECT * FROM team_chat WHERE team = 'seed-team-gamma' ORDER BY created_at`;
      expect(msgs.length).toBe(2);
      expect(msgs[0].sender).toBe('engineer');
      expect(msgs[1].sender).toBe('reviewer');
      expect(msgs[0].repo_path).toBe(testRepo);

      // Verify source file renamed
      expect(existsSync(join(chatDir, 'seed-team-gamma.jsonl'))).toBe(false);
      expect(existsSync(join(chatDir, 'seed-team-gamma.jsonl.migrated'))).toBe(true);
    });

    test('seed is idempotent — running twice produces no errors or duplicates', async () => {
      const sql = await getConnection();

      // Re-create a workers.json (since previous test renamed it)
      const workersPath = join(testHome, 'workers.json');
      // Remove .migrated to allow seed to run again
      try {
        require('node:fs').unlinkSync(`${workersPath}.migrated`);
      } catch {}

      writeFileSync(
        workersPath,
        JSON.stringify({
          workers: {
            'seed-test-idempotent': {
              id: 'seed-test-idempotent',
              paneId: '%77',
              session: 'idem-sess',
              state: 'idle',
              startedAt: new Date().toISOString(),
              lastStateChange: new Date().toISOString(),
              repoPath: '/tmp/idem',
            },
          },
          templates: {},
          lastUpdated: new Date().toISOString(),
        }),
      );

      // First run
      await runSeed(sql);
      const after1 = await sql`SELECT count(*)::int AS cnt FROM agents WHERE id = 'seed-test-idempotent'`;
      expect(after1[0].cnt).toBe(1);

      // Restore file for second run
      try {
        require('node:fs').unlinkSync(`${workersPath}.migrated`);
      } catch {}
      writeFileSync(
        workersPath,
        JSON.stringify({
          workers: {
            'seed-test-idempotent': {
              id: 'seed-test-idempotent',
              paneId: '%77',
              session: 'idem-sess',
              state: 'idle',
              startedAt: new Date().toISOString(),
              lastStateChange: new Date().toISOString(),
              repoPath: '/tmp/idem',
            },
          },
          templates: {},
          lastUpdated: new Date().toISOString(),
        }),
      );

      // Second run — should NOT throw and NOT create duplicates
      await runSeed(sql);
      const after2 = await sql`SELECT count(*)::int AS cnt FROM agents WHERE id = 'seed-test-idempotent'`;
      expect(after2[0].cnt).toBe(1);

      // Cleanup
      await sql`DELETE FROM agents WHERE id = 'seed-test-idempotent'`;
    });

    test('needsSeed returns false after migration (no workers.json, no claude teams)', () => {
      // Workers.json should be .migrated now, so that branch returns false.
      const workersPath = join(testHome, 'workers.json');
      if (existsSync(workersPath)) {
        require('node:fs').renameSync(workersPath, `${workersPath}.migrated`);
      }
      // Remove any test-local Claude-native team dirs so the disk-check branch
      // returns false. (Previously-seeded team dirs from this describe block
      // must be torn down before this assertion.)
      const { rmSync } = require('node:fs');
      try {
        rmSync(join(testClaudeDir, 'teams'), { recursive: true, force: true });
      } catch {}
      expect(needsSeed()).toBe(false);
    });
  });
});
