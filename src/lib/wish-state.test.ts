/**
 * Tests for wish-state.ts — PG-backed state machine for wish execution groups.
 *
 * Requires pgserve (auto-started via getConnection).
 * Each test uses a unique repo_path for isolation.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupTestSchema } from './test-db.js';
import {
  type GroupDefinition,
  completeGroup,
  createState,
  findAnyGroupByAssignee,
  findGroupByAssignee,
  getGroupState,
  getOrCreateState,
  getState,
  isWishComplete,
  resetGroup,
  resetInProgressGroups,
  resolveRepoPath,
  startGroup,
} from './wish-state.js';

let cwd: string;
let cleanupSchema: () => Promise<void>;

beforeAll(async () => {
  cleanupSchema = await setupTestSchema();
});

afterAll(async () => {
  await cleanupSchema();
});

beforeEach(() => {
  // Unique repo path per test for isolation
  cwd = `/tmp/genie-wish-state-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
});

const sampleGroups: GroupDefinition[] = [
  { name: '1', dependsOn: [] },
  { name: '2', dependsOn: ['1'] },
  { name: '3', dependsOn: ['1'] },
  { name: '4', dependsOn: ['2', '3'] },
];

// ============================================================================
// createState
// ============================================================================

describe('createState', () => {
  test('creates state with correct initial statuses', async () => {
    const state = await createState('test-wish', sampleGroups, cwd);

    expect(state.wish).toBe('test-wish');
    expect(state.groups['1'].status).toBe('ready');
    expect(state.groups['2'].status).toBe('blocked');
    expect(state.groups['3'].status).toBe('blocked');
    expect(state.groups['4'].status).toBe('blocked');
  });

  test('persists state to PG', async () => {
    await createState('test-wish', sampleGroups, cwd);

    const state = await getState('test-wish', cwd);
    expect(state).not.toBeNull();
    expect(state?.wish).toBe('test-wish');
    expect(state?.groups['1'].status).toBe('ready');
  });

  test('groups with no deps are ready', async () => {
    const groups: GroupDefinition[] = [{ name: 'a' }, { name: 'b' }];
    const state = await createState('no-deps', groups, cwd);

    expect(state.groups.a.status).toBe('ready');
    expect(state.groups.b.status).toBe('ready');
  });

  test('sets dependsOn array correctly', async () => {
    const state = await createState('test-wish', sampleGroups, cwd);

    expect(state.groups['1'].dependsOn).toEqual([]);
    expect(state.groups['2'].dependsOn).toEqual(['1']);
    expect(state.groups['4'].dependsOn).toEqual(['2', '3']);
  });
});

// ============================================================================
// startGroup
// ============================================================================

describe('startGroup', () => {
  test('sets in_progress with assignee and timestamp', async () => {
    await createState('test-wish', sampleGroups, cwd);

    const result = await startGroup('test-wish', '1', 'agent-a', cwd);

    expect(result.status).toBe('in_progress');
    expect(result.assignee).toBe('agent-a');
    expect(result.startedAt).toBeTruthy();
  });

  test('persists state change to PG', async () => {
    await createState('test-wish', sampleGroups, cwd);
    await startGroup('test-wish', '1', 'agent-a', cwd);

    const state = await getState('test-wish', cwd);
    expect(state?.groups['1'].status).toBe('in_progress');
    expect(state?.groups['1'].assignee).toBe('agent-a');
  });

  test('refuses when dependencies not met', async () => {
    await createState('test-wish', sampleGroups, cwd);

    await expect(startGroup('test-wish', '2', 'agent-b', cwd)).rejects.toThrow(
      'dependency "1" is ready (must be done)',
    );
  });

  test('refuses when group already in progress', async () => {
    await createState('test-wish', sampleGroups, cwd);
    await startGroup('test-wish', '1', 'agent-a', cwd);

    await expect(startGroup('test-wish', '1', 'agent-b', cwd)).rejects.toThrow('already in progress');
  });

  test('refuses when group already done', async () => {
    await createState('test-wish', sampleGroups, cwd);
    await startGroup('test-wish', '1', 'agent-a', cwd);
    await completeGroup('test-wish', '1', cwd);

    await expect(startGroup('test-wish', '1', 'agent-b', cwd)).rejects.toThrow('already done');
  });

  test('refuses when group not found', async () => {
    await createState('test-wish', sampleGroups, cwd);

    await expect(startGroup('test-wish', 'nonexistent', 'agent-a', cwd)).rejects.toThrow('not found');
  });

  test('allows start when all deps are done', async () => {
    await createState('test-wish', sampleGroups, cwd);

    await startGroup('test-wish', '1', 'agent-a', cwd);
    await completeGroup('test-wish', '1', cwd);
    const result = await startGroup('test-wish', '2', 'agent-b', cwd);

    expect(result.status).toBe('in_progress');
  });
});

// ============================================================================
// completeGroup
// ============================================================================

describe('completeGroup', () => {
  test('sets done with timestamp', async () => {
    await createState('test-wish', sampleGroups, cwd);
    await startGroup('test-wish', '1', 'agent-a', cwd);

    const result = await completeGroup('test-wish', '1', cwd);

    expect(result.status).toBe('done');
    expect(result.completedAt).toBeTruthy();
  });

  test('recalculates dependent groups (blocked → ready)', async () => {
    await createState('test-wish', sampleGroups, cwd);
    await startGroup('test-wish', '1', 'agent-a', cwd);
    await completeGroup('test-wish', '1', cwd);

    const state = await getState('test-wish', cwd);
    expect(state?.groups['2'].status).toBe('ready');
    expect(state?.groups['3'].status).toBe('ready');
    // Group 4 depends on 2 AND 3, so still blocked
    expect(state?.groups['4'].status).toBe('blocked');
  });

  test('unblocks multi-dependency group when all deps done', async () => {
    await createState('test-wish', sampleGroups, cwd);

    // Complete group 1
    await startGroup('test-wish', '1', 'a', cwd);
    await completeGroup('test-wish', '1', cwd);

    // Complete group 2
    await startGroup('test-wish', '2', 'b', cwd);
    await completeGroup('test-wish', '2', cwd);

    // Complete group 3
    await startGroup('test-wish', '3', 'c', cwd);
    await completeGroup('test-wish', '3', cwd);

    // Group 4 should now be ready
    const state = await getState('test-wish', cwd);
    expect(state?.groups['4'].status).toBe('ready');
  });

  test('refuses when group already done', async () => {
    await createState('test-wish', sampleGroups, cwd);
    await startGroup('test-wish', '1', 'agent-a', cwd);
    await completeGroup('test-wish', '1', cwd);

    await expect(completeGroup('test-wish', '1', cwd)).rejects.toThrow(
      'Cannot complete group "1": must be in_progress (currently done)',
    );
  });

  test('refuses when group not found', async () => {
    await createState('test-wish', sampleGroups, cwd);

    await expect(completeGroup('test-wish', 'nonexistent', cwd)).rejects.toThrow('not found');
  });

  test('rejects blocked groups', async () => {
    await createState('test-wish', sampleGroups, cwd);

    // Group 2 depends on group 1 and should be blocked
    const groupState = await getGroupState('test-wish', '2', cwd);
    expect(groupState?.status).toBe('blocked');

    await expect(completeGroup('test-wish', '2', cwd)).rejects.toThrow(
      'Cannot complete group "2": must be in_progress (currently blocked)',
    );
  });

  test('rejects ready groups (must be in_progress)', async () => {
    await createState('test-wish', sampleGroups, cwd);

    // Group 1 is ready but not in_progress
    await expect(completeGroup('test-wish', '1', cwd)).rejects.toThrow(
      'Cannot complete group "1": must be in_progress (currently ready)',
    );
  });
});

// ============================================================================
// getState / getGroupState
// ============================================================================

describe('getState', () => {
  test('returns null for nonexistent slug', async () => {
    const state = await getState('nonexistent', cwd);
    expect(state).toBeNull();
  });

  test('returns full state', async () => {
    await createState('test-wish', sampleGroups, cwd);
    const state = await getState('test-wish', cwd);

    expect(state).not.toBeNull();
    expect(state?.wish).toBe('test-wish');
    expect(Object.keys(state?.groups ?? {})).toEqual(['1', '2', '3', '4']);
  });
});

describe('getGroupState', () => {
  test('returns null for nonexistent slug', async () => {
    const group = await getGroupState('nonexistent', '1', cwd);
    expect(group).toBeNull();
  });

  test('returns null for nonexistent group', async () => {
    await createState('test-wish', sampleGroups, cwd);
    const group = await getGroupState('test-wish', 'nonexistent', cwd);
    expect(group).toBeNull();
  });

  test('returns single group state', async () => {
    await createState('test-wish', sampleGroups, cwd);
    const group = await getGroupState('test-wish', '1', cwd);

    expect(group).not.toBeNull();
    expect(group?.status).toBe('ready');
  });
});

// ============================================================================
// getOrCreateState
// ============================================================================

describe('getOrCreateState', () => {
  test('creates state when none exists', async () => {
    const state = await getOrCreateState('new-wish', sampleGroups, cwd);

    expect(state.wish).toBe('new-wish');
    expect(state.groups['1'].status).toBe('ready');
    expect(state.groups['2'].status).toBe('blocked');
  });

  test('returns existing state without overwriting', async () => {
    await createState('existing-wish', sampleGroups, cwd);
    await startGroup('existing-wish', '1', 'agent-a', cwd);

    // Call getOrCreateState — should return existing state, not reset it
    const state = await getOrCreateState('existing-wish', sampleGroups, cwd);

    expect(state.groups['1'].status).toBe('in_progress');
    expect(state.groups['1'].assignee).toBe('agent-a');
  });

  test('is idempotent — multiple calls return same state', async () => {
    const first = await getOrCreateState('idem-wish', sampleGroups, cwd);
    const second = await getOrCreateState('idem-wish', sampleGroups, cwd);

    expect(first.wish).toBe(second.wish);
    expect(Object.keys(first.groups)).toEqual(Object.keys(second.groups));
  });
});

// ============================================================================
// Full lifecycle
// ============================================================================

describe('full lifecycle', () => {
  test('walks complete dependency chain', async () => {
    await createState('test-wish', sampleGroups, cwd);

    // Group 1: ready → in_progress → done
    await startGroup('test-wish', '1', 'impl-1', cwd);
    await completeGroup('test-wish', '1', cwd);

    // Groups 2 and 3 now ready (parallel)
    await startGroup('test-wish', '2', 'impl-2', cwd);
    await startGroup('test-wish', '3', 'impl-3', cwd);

    await completeGroup('test-wish', '2', cwd);
    await completeGroup('test-wish', '3', cwd);

    // Group 4 now ready
    await startGroup('test-wish', '4', 'impl-4', cwd);
    await completeGroup('test-wish', '4', cwd);

    // All done
    const state = await getState('test-wish', cwd);
    for (const group of Object.values(state?.groups ?? {})) {
      expect(group.status).toBe('done');
    }
  });
});

// ============================================================================
// Validation: cycle detection, dangling deps, self-deps
// ============================================================================

describe('createState validation', () => {
  test('rejects self-dependency', async () => {
    const groups: GroupDefinition[] = [{ name: 'a', dependsOn: ['a'] }];
    await expect(createState('self-dep', groups, cwd)).rejects.toThrow('Group "a" depends on itself');
  });

  test('rejects dangling dependency', async () => {
    const groups: GroupDefinition[] = [{ name: 'a', dependsOn: ['nonexistent'] }];
    await expect(createState('dangling', groups, cwd)).rejects.toThrow(
      'Group "a" depends on non-existent group "nonexistent"',
    );
  });

  test('rejects cyclic dependencies (A→B→A)', async () => {
    const groups: GroupDefinition[] = [
      { name: 'a', dependsOn: ['b'] },
      { name: 'b', dependsOn: ['a'] },
    ];
    await expect(createState('cycle', groups, cwd)).rejects.toThrow('Dependency cycle detected');
  });

  test('rejects larger cycle (A→B→C→A)', async () => {
    const groups: GroupDefinition[] = [
      { name: 'a', dependsOn: ['c'] },
      { name: 'b', dependsOn: ['a'] },
      { name: 'c', dependsOn: ['b'] },
    ];
    await expect(createState('big-cycle', groups, cwd)).rejects.toThrow('Dependency cycle detected');
  });

  test('allows valid DAG', async () => {
    const groups: GroupDefinition[] = [
      { name: 'a' },
      { name: 'b', dependsOn: ['a'] },
      { name: 'c', dependsOn: ['a'] },
      { name: 'd', dependsOn: ['b', 'c'] },
    ];
    const state = await createState('valid-dag', groups, cwd);
    expect(state.groups.a.status).toBe('ready');
    expect(state.groups.d.status).toBe('blocked');
  });
});

// ============================================================================
// resetGroup
// ============================================================================

describe('resetGroup', () => {
  test('resets in_progress group to ready', async () => {
    await createState('test-wish', sampleGroups, cwd);
    await startGroup('test-wish', '1', 'agent-a', cwd);

    const result = await resetGroup('test-wish', '1', cwd);

    expect(result.status).toBe('ready');
    expect(result.assignee).toBeUndefined();
    expect(result.startedAt).toBeUndefined();
  });

  test('persists reset to PG', async () => {
    await createState('test-wish', sampleGroups, cwd);
    await startGroup('test-wish', '1', 'agent-a', cwd);
    await resetGroup('test-wish', '1', cwd);

    const state = await getState('test-wish', cwd);
    expect(state?.groups['1'].status).toBe('ready');
    expect(state?.groups['1'].assignee).toBeUndefined();
  });

  test('rejects reset of ready group', async () => {
    await createState('test-wish', sampleGroups, cwd);

    await expect(resetGroup('test-wish', '1', cwd)).rejects.toThrow(
      'Cannot reset: must be in_progress (currently ready)',
    );
  });

  test('rejects reset of blocked group', async () => {
    await createState('test-wish', sampleGroups, cwd);

    await expect(resetGroup('test-wish', '2', cwd)).rejects.toThrow(
      'Cannot reset: must be in_progress (currently blocked)',
    );
  });

  test('rejects reset of done group', async () => {
    await createState('test-wish', sampleGroups, cwd);
    await startGroup('test-wish', '1', 'agent-a', cwd);
    await completeGroup('test-wish', '1', cwd);

    await expect(resetGroup('test-wish', '1', cwd)).rejects.toThrow(
      'Cannot reset: must be in_progress (currently done)',
    );
  });

  test('rejects reset of nonexistent group', async () => {
    await createState('test-wish', sampleGroups, cwd);

    await expect(resetGroup('test-wish', 'nonexistent', cwd)).rejects.toThrow('not found');
  });

  test('allows re-start after reset', async () => {
    await createState('test-wish', sampleGroups, cwd);
    await startGroup('test-wish', '1', 'agent-a', cwd);
    await resetGroup('test-wish', '1', cwd);

    const result = await startGroup('test-wish', '1', 'agent-b', cwd);
    expect(result.status).toBe('in_progress');
    expect(result.assignee).toBe('agent-b');
  });
});

// ============================================================================
// findGroupByAssignee
// ============================================================================

describe('findGroupByAssignee', () => {
  test('finds group by exact assignee match', async () => {
    await createState('test-wish', sampleGroups, cwd);
    await startGroup('test-wish', '1', 'agent-a', cwd);

    const result = await findGroupByAssignee('test-wish', 'agent-a', cwd);

    expect(result).not.toBeNull();
    expect(result?.groupName).toBe('1');
    expect(result?.group.status).toBe('in_progress');
    expect(result?.group.assignee).toBe('agent-a');
  });

  test('finds group by team-prefixed workerId', async () => {
    await createState('test-wish', sampleGroups, cwd);
    await startGroup('test-wish', '1', 'engineer', cwd);

    const result = await findGroupByAssignee('test-wish', 'fire-and-forget-engineer', cwd);

    expect(result).not.toBeNull();
    expect(result?.groupName).toBe('1');
    expect(result?.group.assignee).toBe('engineer');
  });

  test('returns null when no matching assignee', async () => {
    await createState('test-wish', sampleGroups, cwd);
    await startGroup('test-wish', '1', 'agent-a', cwd);

    const result = await findGroupByAssignee('test-wish', 'agent-b', cwd);

    expect(result).toBeNull();
  });

  test('returns null for nonexistent slug', async () => {
    const result = await findGroupByAssignee('nonexistent', 'agent-a', cwd);
    expect(result).toBeNull();
  });

  test('ignores done groups', async () => {
    await createState('test-wish', sampleGroups, cwd);
    await startGroup('test-wish', '1', 'agent-a', cwd);
    await completeGroup('test-wish', '1', cwd);

    const result = await findGroupByAssignee('test-wish', 'agent-a', cwd);

    expect(result).toBeNull();
  });

  test('ignores ready groups', async () => {
    await createState('test-wish', sampleGroups, cwd);

    const result = await findGroupByAssignee('test-wish', 'agent-a', cwd);

    expect(result).toBeNull();
  });

  test('returns first matching in_progress group', async () => {
    const groups: GroupDefinition[] = [{ name: 'a' }, { name: 'b' }];
    await createState('multi', groups, cwd);
    await startGroup('multi', 'a', 'agent-a', cwd);
    await startGroup('multi', 'b', 'agent-a', cwd);

    const result = await findGroupByAssignee('multi', 'agent-a', cwd);

    expect(result).not.toBeNull();
    expect(result?.group.status).toBe('in_progress');
  });
});

// ============================================================================
// findAnyGroupByAssignee
// ============================================================================

describe('findAnyGroupByAssignee', () => {
  test('finds group across all wishes', async () => {
    await createState('wish-a', sampleGroups, cwd);
    await startGroup('wish-a', '1', 'agent-x', cwd);

    const result = await findAnyGroupByAssignee('agent-x', cwd);

    expect(result).not.toBeNull();
    expect(result?.slug).toBe('wish-a');
    expect(result?.groupName).toBe('1');
  });

  test('matches team-prefixed worker IDs', async () => {
    await createState('wish-b', [{ name: '1' }], cwd);
    await startGroup('wish-b', '1', 'engineer', cwd);

    const result = await findAnyGroupByAssignee('team-name-engineer', cwd);

    expect(result).not.toBeNull();
    expect(result?.slug).toBe('wish-b');
    expect(result?.group.assignee).toBe('engineer');
  });

  test('returns null when no match', async () => {
    await createState('wish-c', sampleGroups, cwd);

    const result = await findAnyGroupByAssignee('nobody', cwd);
    expect(result).toBeNull();
  });
});

// ============================================================================
// isWishComplete
// ============================================================================

describe('isWishComplete', () => {
  test('returns false when no state exists', async () => {
    expect(await isWishComplete('nonexistent', cwd)).toBe(false);
  });

  test('returns false when some groups are not done', async () => {
    await createState('test-wish', sampleGroups, cwd);
    await startGroup('test-wish', '1', 'agent-a', cwd);
    await completeGroup('test-wish', '1', cwd);

    expect(await isWishComplete('test-wish', cwd)).toBe(false);
  });

  test('returns true when all groups are done', async () => {
    await createState('test-wish', sampleGroups, cwd);

    await startGroup('test-wish', '1', 'a', cwd);
    await completeGroup('test-wish', '1', cwd);

    await startGroup('test-wish', '2', 'b', cwd);
    await completeGroup('test-wish', '2', cwd);

    await startGroup('test-wish', '3', 'c', cwd);
    await completeGroup('test-wish', '3', cwd);

    await startGroup('test-wish', '4', 'd', cwd);
    await completeGroup('test-wish', '4', cwd);

    expect(await isWishComplete('test-wish', cwd)).toBe(true);
  });

  test('returns false when groups are in_progress', async () => {
    await createState('test-wish', [{ name: '1' }], cwd);
    await startGroup('test-wish', '1', 'agent-a', cwd);

    expect(await isWishComplete('test-wish', cwd)).toBe(false);
  });
});

// ============================================================================
// resetInProgressGroups
// ============================================================================

describe('resetInProgressGroups', () => {
  test('returns 0 for nonexistent wish', async () => {
    expect(await resetInProgressGroups('nonexistent', cwd)).toBe(0);
  });

  test('resets all in_progress groups to ready', async () => {
    const groups: GroupDefinition[] = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    await createState('reset-all', groups, cwd);
    await startGroup('reset-all', 'a', 'agent-1', cwd);
    await startGroup('reset-all', 'b', 'agent-2', cwd);

    const count = await resetInProgressGroups('reset-all', cwd);
    expect(count).toBe(2);

    const state = await getState('reset-all', cwd);
    expect(state?.groups.a.status).toBe('ready');
    expect(state?.groups.a.assignee).toBeUndefined();
    expect(state?.groups.b.status).toBe('ready');
    expect(state?.groups.b.assignee).toBeUndefined();
    expect(state?.groups.c.status).toBe('ready'); // was already ready
  });

  test('does not touch done groups', async () => {
    await createState('reset-done', sampleGroups, cwd);
    await startGroup('reset-done', '1', 'a', cwd);
    await completeGroup('reset-done', '1', cwd);
    await startGroup('reset-done', '2', 'b', cwd);

    const count = await resetInProgressGroups('reset-done', cwd);
    expect(count).toBe(1); // only group 2

    const state = await getState('reset-done', cwd);
    expect(state?.groups['1'].status).toBe('done');
    expect(state?.groups['2'].status).toBe('ready');
  });

  test('returns 0 when no groups are in_progress', async () => {
    await createState('reset-none', [{ name: '1' }], cwd);
    const count = await resetInProgressGroups('reset-none', cwd);
    expect(count).toBe(0);
  });
});

// ============================================================================
// resolveRepoPath — worktree normalization
// ============================================================================

describe('resolveRepoPath', () => {
  let mainRepo: string;
  let worktreePath: string;
  let originalCwd: string;

  beforeAll(() => {
    originalCwd = process.cwd();

    // Create a real git repo
    mainRepo = mkdtempSync(join(tmpdir(), 'genie-resolve-test-'));
    execSync('git init', { cwd: mainRepo, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: mainRepo, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: mainRepo, stdio: 'pipe' });
    execSync('git commit --allow-empty -m "init"', { cwd: mainRepo, stdio: 'pipe' });

    // Create a worktree
    worktreePath = `${mainRepo}-worktree`;
    execSync(`git worktree add ${worktreePath} -b test-branch`, { cwd: mainRepo, stdio: 'pipe' });
  });

  afterAll(() => {
    process.chdir(originalCwd);
    try {
      execSync(`git worktree remove ${worktreePath} --force`, { cwd: mainRepo, stdio: 'pipe' });
    } catch {
      /* already cleaned up */
    }
    rmSync(mainRepo, { recursive: true, force: true });
    rmSync(worktreePath, { recursive: true, force: true });
  });

  test('returns cwd when cwd is explicitly provided', () => {
    const result = resolveRepoPath('/some/explicit/path');
    expect(result).toBe('/some/explicit/path');
  });

  test('returns main repo path from main repo', () => {
    process.chdir(mainRepo);
    const result = resolveRepoPath();
    expect(result).toBe(mainRepo);
  });

  test('returns main repo path from worktree (not worktree path)', () => {
    process.chdir(worktreePath);
    const result = resolveRepoPath();
    // Key assertion: from worktree, resolveRepoPath returns the main repo
    expect(result).toBe(mainRepo);
  });

  test('main repo and worktree resolve to the same path', () => {
    process.chdir(mainRepo);
    const fromMain = resolveRepoPath();

    process.chdir(worktreePath);
    const fromWorktree = resolveRepoPath();

    expect(fromMain).toBe(fromWorktree);
  });

  test('falls back to cwd when not in a git repo', () => {
    // Use /var/tmp to avoid /tmp/.git which may exist on some machines
    const base = existsSync('/var/tmp') ? '/var/tmp' : tmpdir();
    const nonGitDir = mkdtempSync(join(base, 'genie-non-git-'));
    process.chdir(nonGitDir);

    const result = resolveRepoPath();
    expect(result).toBe(nonGitDir);

    rmSync(nonGitDir, { recursive: true, force: true });
  });
});
