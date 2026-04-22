/**
 * Tests for Team Manager — CRUD for team lifecycle with git clone --shared isolation.
 * Run with: bun test src/lib/team-manager.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, readlinkSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'bun';
import { getConnection } from './db.js';
import {
  createTeam,
  disbandTeam,
  ensureTeamRow,
  fireAgent,
  getTeam,
  hireAgent,
  listMembers,
  listTeams,
  resolveLeaderName,
  setTeamStatus,
  updateTeamConfig,
  validateBranchName,
} from './team-manager.js';
import { DB_AVAILABLE, setupTestDatabase } from './test-db.js';

// ============================================================================
// Test Setup
// ============================================================================

const TEST_DIR = '/tmp/team-manager-test';
const TEST_REPO = join(TEST_DIR, 'test-repo');
const TEST_GENIE_HOME = join(TEST_DIR, 'genie-home');

describe.skipIf(!DB_AVAILABLE)('pg', () => {
  let cleanupSchema: () => Promise<void>;

  async function setupTestRepo(): Promise<void> {
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      // Ignore
    }

    await mkdir(TEST_REPO, { recursive: true });
    await mkdir(TEST_GENIE_HOME, { recursive: true });
    await $`git -C ${TEST_REPO} init`.quiet();
    await $`git -C ${TEST_REPO} config user.email "test@test.com"`.quiet();
    await $`git -C ${TEST_REPO} config user.name "Test"`.quiet();

    // Create initial commit on a "dev" branch
    await writeFile(join(TEST_REPO, 'README.md'), '# Test Repo');
    await $`git -C ${TEST_REPO} add .`.quiet();
    await $`git -C ${TEST_REPO} commit -m "Initial commit"`.quiet();

    // Create dev branch (current branch acts as dev)
    await $`git -C ${TEST_REPO} branch dev`.quiet();

    // Point GENIE_HOME to test directory for worktree path resolution
    process.env.GENIE_HOME = TEST_GENIE_HOME;
  }

  async function cleanupTestRepo(): Promise<void> {
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      // Ignore
    }

    process.env.GENIE_HOME = undefined;
  }

  // ============================================================================
  // Tests
  // ============================================================================

  describe('Team Manager', () => {
    beforeAll(async () => {
      cleanupSchema = await setupTestDatabase();
      await setupTestRepo();
    });

    afterAll(async () => {
      await cleanupTestRepo();
      await cleanupSchema();
    });

    describe('validateBranchName', () => {
      test('accepts valid branch names', () => {
        expect(() => validateBranchName('feat/auth-bug')).not.toThrow();
        expect(() => validateBranchName('fix/thing')).not.toThrow();
        expect(() => validateBranchName('chore/cleanup')).not.toThrow();
      });

      test('rejects names with spaces', () => {
        expect(() => validateBranchName('spaces here')).toThrow('must be a valid git branch name');
        expect(() => validateBranchName('spaces here')).toThrow('contains spaces');
      });

      test('rejects names with ..', () => {
        expect(() => validateBranchName('feat..test')).toThrow('contains ".."');
      });

      test('rejects names starting with -', () => {
        expect(() => validateBranchName('-bad')).toThrow('starts with "-"');
      });

      test('rejects names ending with .lock', () => {
        expect(() => validateBranchName('feat/test.lock')).toThrow('ends with ".lock"');
      });
    });

    describe('createTeam', () => {
      test('creates team with shared clone', async () => {
        const config = await createTeam('feat/test-create', TEST_REPO, 'dev');

        expect(config.name).toBe('feat/test-create');
        expect(config.repo).toBe(TEST_REPO);
        expect(config.baseBranch).toBe('dev');
        expect(config.members).toEqual([]);
        expect(config.worktreePath).toContain('feat/test-create');
        expect(existsSync(config.worktreePath)).toBe(true);
      });

      test('is idempotent — re-running returns existing config', async () => {
        const first = await createTeam('feat/idempotent', TEST_REPO, 'dev');
        const second = await createTeam('feat/idempotent', TEST_REPO, 'dev');

        expect(second.name).toBe(first.name);
        expect(second.createdAt).toBe(first.createdAt);
      });

      test('creates branch from base branch', async () => {
        const config = await createTeam('feat/branched', TEST_REPO, 'dev');

        // Verify branch exists in worktree
        const result = await $`git -C ${config.worktreePath} branch --show-current`.quiet();
        expect(result.stdout.toString().trim()).toBe('feat/branched');
      });

      test('stores config in PG teams table', async () => {
        await createTeam('feat/pg-check', TEST_REPO, 'dev');
        const sql = await getConnection();
        const rows = await sql`SELECT * FROM teams WHERE name = ${'feat/pg-check'}`;
        expect(rows.length).toBe(1);
        expect(rows[0].repo).toBe(TEST_REPO);
        expect(rows[0].base_branch).toBe('dev');
      });

      test('rejects invalid branch names', async () => {
        await expect(createTeam('spaces here', TEST_REPO, 'dev')).rejects.toThrow('must be a valid git branch name');
      });

      test('symlinks node_modules from parent repo into worktree', async () => {
        // Create a fake node_modules in the test repo
        const parentNodeModules = join(TEST_REPO, 'node_modules');
        await mkdir(parentNodeModules, { recursive: true });
        await writeFile(join(parentNodeModules, '.package-lock.json'), '{}');

        const config = await createTeam('feat/symlink-nm', TEST_REPO, 'dev');
        const worktreeNodeModules = join(config.worktreePath, 'node_modules');

        expect(existsSync(worktreeNodeModules)).toBe(true);
        expect(lstatSync(worktreeNodeModules).isSymbolicLink()).toBe(true);
        expect(readlinkSync(worktreeNodeModules)).toBe(parentNodeModules);

        // Clean up
        await rm(parentNodeModules, { recursive: true, force: true });
      });

      test('skips node_modules symlink when parent has no node_modules', async () => {
        const config = await createTeam('feat/no-nm', TEST_REPO, 'dev');
        const worktreeNodeModules = join(config.worktreePath, 'node_modules');

        expect(existsSync(worktreeNodeModules)).toBe(false);
      });

      test('runs .genie/init.sh in worktree after clone', async () => {
        // Create a .genie/init.sh that writes a marker file
        const genieDir = join(TEST_REPO, '.genie');
        await mkdir(genieDir, { recursive: true });
        await writeFile(join(genieDir, 'init.sh'), '#!/bin/bash\necho "init-ran" > .init-marker');
        await chmod(join(genieDir, 'init.sh'), 0o755);

        const config = await createTeam('feat/init-sh', TEST_REPO, 'dev');
        const marker = join(config.worktreePath, '.init-marker');

        expect(existsSync(marker)).toBe(true);

        // Clean up
        await rm(join(genieDir, 'init.sh'));
        await rm(marker, { force: true });
      });
    });

    describe('getTeam', () => {
      test('returns team config for existing team', async () => {
        await createTeam('feat/get-test', TEST_REPO, 'dev');
        const config = await getTeam('feat/get-test');

        expect(config).not.toBeNull();
        expect(config!.name).toBe('feat/get-test');
      });

      test('returns null for non-existent team', async () => {
        const config = await getTeam('nonexistent');
        expect(config).toBeNull();
      });
    });

    describe('ensureTeamRow', () => {
      test('inserts a minimal row when no team exists in PG', async () => {
        const name = 'feat/ensure-new';
        // Confirm pre-state
        expect(await getTeam(name)).toBeNull();

        const result = await ensureTeamRow(name, { repo: TEST_REPO });
        expect(result).not.toBeNull();
        expect(result!.name).toBe(name);
        expect(result!.repo).toBe(TEST_REPO);
        expect(result!.worktreePath).toBe(TEST_REPO);
        expect(result!.nativeTeamsEnabled).toBe(true);
        expect(result!.status).toBe('in_progress');
      });

      test('is idempotent — returns existing row on re-run', async () => {
        const name = 'feat/ensure-idempotent';
        const first = await ensureTeamRow(name, { repo: TEST_REPO });
        const second = await ensureTeamRow(name, { repo: TEST_REPO });

        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        expect(second!.createdAt).toBe(first!.createdAt);
      });

      test('does not clobber a row created via createTeam', async () => {
        const name = 'feat/ensure-after-create';
        const created = await createTeam(name, TEST_REPO, 'dev');
        expect(created.worktreePath).toContain('feat/ensure-after-create');

        // Back-fill after createTeam should be a no-op — same worktreePath preserved
        const backfilled = await ensureTeamRow(name, { repo: TEST_REPO });
        expect(backfilled).not.toBeNull();
        expect(backfilled!.worktreePath).toBe(created.worktreePath);
      });

      test('returns null for invalid branch names', async () => {
        const result = await ensureTeamRow('spaces here', { repo: TEST_REPO });
        expect(result).toBeNull();
      });
    });

    describe('listTeams', () => {
      test('lists all teams globally', async () => {
        const teams = await listTeams();
        expect(teams.length).toBeGreaterThan(0);

        const names = teams.map((t) => t.name);
        expect(names).toContain('feat/test-create');
      });
    });

    describe('hireAgent', () => {
      test('adds agent to team members', async () => {
        await createTeam('feat/hire-test', TEST_REPO, 'dev');
        const added = await hireAgent('feat/hire-test', 'implementor');

        expect(added).toEqual(['implementor']);

        const config = await getTeam('feat/hire-test');
        expect(config!.members).toContain('implementor');
      });

      test('returns empty array for duplicate hire', async () => {
        await createTeam('feat/hire-dup', TEST_REPO, 'dev');
        await hireAgent('feat/hire-dup', 'tester');
        const added = await hireAgent('feat/hire-dup', 'tester');

        expect(added).toEqual([]);
      });

      test('hire council adds all 11 council members', async () => {
        await createTeam('feat/hire-council', TEST_REPO, 'dev');
        const added = await hireAgent('feat/hire-council', 'council');

        expect(added.length).toBe(11);
        expect(added).toContain('council--questioner');
        expect(added).toContain('council--architect');

        const config = await getTeam('feat/hire-council');
        expect(config!.members.length).toBe(11);
      });

      test('throws for non-existent team', async () => {
        expect(hireAgent('nonexistent', 'agent')).rejects.toThrow('not found');
      });
    });

    describe('fireAgent', () => {
      test('removes agent from team members', async () => {
        await createTeam('feat/fire-test', TEST_REPO, 'dev');
        await hireAgent('feat/fire-test', 'reviewer');

        const removed = await fireAgent('feat/fire-test', 'reviewer');
        expect(removed).toBe(true);

        const config = await getTeam('feat/fire-test');
        expect(config!.members).not.toContain('reviewer');
      });

      test('returns false for agent not in team', async () => {
        await createTeam('feat/fire-miss', TEST_REPO, 'dev');
        const removed = await fireAgent('feat/fire-miss', 'nobody');
        expect(removed).toBe(false);
      });

      test('throws for non-existent team', async () => {
        expect(fireAgent('nonexistent', 'agent')).rejects.toThrow('not found');
      });
    });

    describe('listMembers', () => {
      test('returns members of existing team', async () => {
        await createTeam('feat/list-members', TEST_REPO, 'dev');
        await hireAgent('feat/list-members', 'debugger');

        const members = await listMembers('feat/list-members');
        expect(members).toEqual(['debugger']);
      });

      test('returns null for non-existent team', async () => {
        const members = await listMembers('nonexistent');
        expect(members).toBeNull();
      });
    });

    describe('team status', () => {
      test('new team has in_progress status', async () => {
        const config = await createTeam('feat/status-default', TEST_REPO, 'dev');
        expect(config.status).toBe('in_progress');
      });

      test('setTeamStatus sets status to done', async () => {
        await createTeam('feat/status-done', TEST_REPO, 'dev');
        await setTeamStatus('feat/status-done', 'done');
        const config = await getTeam('feat/status-done');
        expect(config!.status).toBe('done');
      });

      test('setTeamStatus sets status to blocked', async () => {
        await createTeam('feat/status-blocked', TEST_REPO, 'dev');
        await setTeamStatus('feat/status-blocked', 'blocked');
        const config = await getTeam('feat/status-blocked');
        expect(config!.status).toBe('blocked');
      });

      test('setTeamStatus throws for non-existent team', async () => {
        expect(setTeamStatus('nonexistent', 'done')).rejects.toThrow('not found');
      });
    });

    describe('leader and spawner', () => {
      test('new team gets leader and spawner when set via updateTeamConfig', async () => {
        const config = await createTeam('feat/leader-test', TEST_REPO, 'dev');
        config.leader = 'fix-tmux-session-explosion';
        config.spawner = 'sofia';
        await updateTeamConfig(config.name, config);

        const updated = await getTeam('feat/leader-test');
        expect(updated!.leader).toBe('fix-tmux-session-explosion');
        expect(updated!.spawner).toBe('sofia');
      });

      test('resolveLeaderName returns leader for teams with leader set', async () => {
        const config = await createTeam('feat/leader-resolve', TEST_REPO, 'dev');
        config.leader = 'my-wish-slug';
        await updateTeamConfig(config.name, config);

        const name = await resolveLeaderName('feat/leader-resolve');
        expect(name).toBe('my-wish-slug');
      });

      test('resolveLeaderName falls back to teamName for legacy teams (never returns team-lead)', async () => {
        await createTeam('feat/legacy-leader', TEST_REPO, 'dev');
        // No leader set — legacy team, should return teamName not 'team-lead'
        const name = await resolveLeaderName('feat/legacy-leader');
        expect(name).toBe('feat/legacy-leader');
      });

      test('resolveLeaderName returns teamName for nonexistent team (never throws)', async () => {
        const name = await resolveLeaderName('nonexistent-team');
        expect(name).toBe('nonexistent-team');
      });

      test('resolveLeaderName skips leader if it equals team-lead', async () => {
        const config = await createTeam('feat/skip-team-lead', TEST_REPO, 'dev');
        config.leader = 'team-lead';
        await updateTeamConfig(config.name, config);
        const name = await resolveLeaderName('feat/skip-team-lead');
        // Should return teamName, not 'team-lead'
        expect(name).toBe('feat/skip-team-lead');
      });

      test('spawner persisted in PG teams table', async () => {
        const config = await createTeam('feat/spawner-pg', TEST_REPO, 'dev');
        config.spawner = 'genie-pm';
        await updateTeamConfig(config.name, config);

        const sql = await getConnection();
        const rows = await sql`SELECT spawner FROM teams WHERE name = ${'feat/spawner-pg'}`;
        expect(rows[0].spawner).toBe('genie-pm');
      });
    });

    describe('disbandTeam', () => {
      test('removes clone directory and config from PG', async () => {
        const config = await createTeam('feat/disband-test', TEST_REPO, 'dev');
        const worktreePath = config.worktreePath;

        const disbanded = await disbandTeam('feat/disband-test');
        expect(disbanded).toBe(true);

        // Worktree should be gone
        expect(existsSync(worktreePath)).toBe(false);

        // Team config should be gone from PG
        const team = await getTeam('feat/disband-test');
        expect(team).toBeNull();
      });

      test('returns false for non-existent team', async () => {
        const disbanded = await disbandTeam('nonexistent');
        expect(disbanded).toBe(false);
      });

      test('archives agent rows belonging to the disbanded team (issue #1215)', async () => {
        await createTeam('feat/archive-agents', TEST_REPO, 'dev');

        // Insert two agent rows directly: one for this team, one for an unrelated team
        const sql = await getConnection();
        const theirId = `test-${Date.now()}-their`;
        const otherId = `test-${Date.now()}-other`;
        await sql`
          INSERT INTO agents (id, pane_id, session, repo_path, state, team, role, started_at)
          VALUES
            (${theirId}, '', '', '', 'idle', ${'feat/archive-agents'}, 'engineer', now()),
            (${otherId}, '', '', '', 'idle', 'feat/other-team', 'engineer', now())
        `;

        await disbandTeam('feat/archive-agents');

        const theirRow = await sql`SELECT state FROM agents WHERE id = ${theirId}`;
        const otherRow = await sql`SELECT state FROM agents WHERE id = ${otherId}`;

        expect(theirRow[0].state).toBe('archived');
        // Other teams' agents must stay untouched
        expect(otherRow[0].state).toBe('idle');
      });

      test('cleans up Claude teams settings directory', async () => {
        const CLAUDE_DIR = join(TEST_DIR, 'claude-config');
        process.env.CLAUDE_CONFIG_DIR = CLAUDE_DIR;

        await createTeam('feat/claude-cleanup', TEST_REPO, 'dev');

        // Simulate hook injection: create ~/.claude/teams/<name>/settings.json
        const claudeTeamDir = join(CLAUDE_DIR, 'teams', 'feat-claude-cleanup');
        await mkdir(claudeTeamDir, { recursive: true });
        await writeFile(join(claudeTeamDir, 'settings.json'), '{"hooks":{}}');
        expect(existsSync(join(claudeTeamDir, 'settings.json'))).toBe(true);

        await disbandTeam('feat/claude-cleanup');

        // Claude team directory should be gone
        expect(existsSync(claudeTeamDir)).toBe(false);

        // Clean up
        process.env.CLAUDE_CONFIG_DIR = undefined;
      });
    });
  });
});
