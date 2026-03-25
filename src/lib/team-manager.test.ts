/**
 * Tests for Team Manager — CRUD for team lifecycle with git clone --shared isolation.
 * Run with: bun test src/lib/team-manager.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'bun';
import { getConnection } from './db.js';
import {
  createTeam,
  disbandTeam,
  fireAgent,
  getTeam,
  hireAgent,
  listMembers,
  listTeams,
  setTeamStatus,
  validateBranchName,
} from './team-manager.js';
import { setupTestSchema } from './test-db.js';

// ============================================================================
// Test Setup
// ============================================================================

const TEST_DIR = '/tmp/team-manager-test';
const TEST_REPO = join(TEST_DIR, 'test-repo');
const TEST_GENIE_HOME = join(TEST_DIR, 'genie-home');

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
    cleanupSchema = await setupTestSchema();
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
