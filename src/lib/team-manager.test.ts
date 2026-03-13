/**
 * Tests for Team Manager — CRUD for team lifecycle with git worktree integration.
 * Run with: bun test src/lib/team-manager.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'bun';
import {
  createTeam,
  disbandTeam,
  fireAgent,
  getTeam,
  hireAgent,
  listMembers,
  listTeams,
} from './team-manager.js';

// ============================================================================
// Test Setup
// ============================================================================

const TEST_DIR = '/tmp/team-manager-test';
const TEST_REPO = join(TEST_DIR, 'test-repo');

async function setupTestRepo(): Promise<void> {
  try {
    await rm(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore
  }

  await mkdir(TEST_REPO, { recursive: true });
  await $`git -C ${TEST_REPO} init`.quiet();
  await $`git -C ${TEST_REPO} config user.email "test@test.com"`.quiet();
  await $`git -C ${TEST_REPO} config user.name "Test"`.quiet();

  // Create initial commit on a "dev" branch
  await writeFile(join(TEST_REPO, 'README.md'), '# Test Repo');
  await $`git -C ${TEST_REPO} add .`.quiet();
  await $`git -C ${TEST_REPO} commit -m "Initial commit"`.quiet();

  // Create dev branch (current branch acts as dev)
  await $`git -C ${TEST_REPO} branch dev`.quiet();
}

async function cleanupTestRepo(): Promise<void> {
  try {
    // Remove all worktrees first
    const result = await $`git -C ${TEST_REPO} worktree list --porcelain`.quiet();
    const paths = result.stdout
      .toString()
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice(9))
      .filter((path) => path !== TEST_REPO);

    for (const p of paths) {
      try {
        await $`git -C ${TEST_REPO} worktree remove ${p} --force`.quiet();
      } catch {
        // Ignore
      }
    }
  } catch {
    // Ignore
  }

  try {
    await rm(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('Team Manager', () => {
  beforeAll(async () => {
    await setupTestRepo();
  });

  afterAll(async () => {
    await cleanupTestRepo();
  });

  describe('createTeam', () => {
    test('creates team with worktree', async () => {
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
  });

  describe('getTeam', () => {
    test('returns team config for existing team', async () => {
      await createTeam('feat/get-test', TEST_REPO, 'dev');
      const config = await getTeam(TEST_REPO, 'feat/get-test');

      expect(config).not.toBeNull();
      expect(config!.name).toBe('feat/get-test');
    });

    test('returns null for non-existent team', async () => {
      const config = await getTeam(TEST_REPO, 'nonexistent');
      expect(config).toBeNull();
    });
  });

  describe('listTeams', () => {
    test('lists all teams', async () => {
      const teams = await listTeams(TEST_REPO);
      expect(teams.length).toBeGreaterThan(0);

      const names = teams.map((t) => t.name);
      expect(names).toContain('feat/test-create');
    });
  });

  describe('hireAgent', () => {
    test('adds agent to team members', async () => {
      await createTeam('feat/hire-test', TEST_REPO, 'dev');
      const added = await hireAgent('feat/hire-test', 'implementor', TEST_REPO);

      expect(added).toEqual(['implementor']);

      const config = await getTeam(TEST_REPO, 'feat/hire-test');
      expect(config!.members).toContain('implementor');
    });

    test('returns empty array for duplicate hire', async () => {
      await createTeam('feat/hire-dup', TEST_REPO, 'dev');
      await hireAgent('feat/hire-dup', 'tester', TEST_REPO);
      const added = await hireAgent('feat/hire-dup', 'tester', TEST_REPO);

      expect(added).toEqual([]);
    });

    test('hire council adds all 10 council members', async () => {
      await createTeam('feat/hire-council', TEST_REPO, 'dev');
      const added = await hireAgent('feat/hire-council', 'council', TEST_REPO);

      expect(added.length).toBe(10);
      expect(added).toContain('council-questioner');
      expect(added).toContain('council-architect');

      const config = await getTeam(TEST_REPO, 'feat/hire-council');
      expect(config!.members.length).toBe(10);
    });

    test('throws for non-existent team', async () => {
      expect(hireAgent('nonexistent', 'agent', TEST_REPO)).rejects.toThrow('not found');
    });
  });

  describe('fireAgent', () => {
    test('removes agent from team members', async () => {
      await createTeam('feat/fire-test', TEST_REPO, 'dev');
      await hireAgent('feat/fire-test', 'reviewer', TEST_REPO);

      const removed = await fireAgent('feat/fire-test', 'reviewer', TEST_REPO);
      expect(removed).toBe(true);

      const config = await getTeam(TEST_REPO, 'feat/fire-test');
      expect(config!.members).not.toContain('reviewer');
    });

    test('returns false for agent not in team', async () => {
      await createTeam('feat/fire-miss', TEST_REPO, 'dev');
      const removed = await fireAgent('feat/fire-miss', 'nobody', TEST_REPO);
      expect(removed).toBe(false);
    });

    test('throws for non-existent team', async () => {
      expect(fireAgent('nonexistent', 'agent', TEST_REPO)).rejects.toThrow('not found');
    });
  });

  describe('listMembers', () => {
    test('returns members of existing team', async () => {
      await createTeam('feat/list-members', TEST_REPO, 'dev');
      await hireAgent('feat/list-members', 'debugger', TEST_REPO);

      const members = await listMembers(TEST_REPO, 'feat/list-members');
      expect(members).toEqual(['debugger']);
    });

    test('returns null for non-existent team', async () => {
      const members = await listMembers(TEST_REPO, 'nonexistent');
      expect(members).toBeNull();
    });
  });

  describe('disbandTeam', () => {
    test('removes worktree and config', async () => {
      const config = await createTeam('feat/disband-test', TEST_REPO, 'dev');
      const worktreePath = config.worktreePath;

      const disbanded = await disbandTeam(TEST_REPO, 'feat/disband-test');
      expect(disbanded).toBe(true);

      // Worktree should be gone
      expect(existsSync(worktreePath)).toBe(false);

      // Team config should be gone
      const team = await getTeam(TEST_REPO, 'feat/disband-test');
      expect(team).toBeNull();
    });

    test('returns false for non-existent team', async () => {
      const disbanded = await disbandTeam(TEST_REPO, 'nonexistent');
      expect(disbanded).toBe(false);
    });
  });
});
