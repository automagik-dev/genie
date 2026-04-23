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
import { getConnection } from './db.js';
import { DB_AVAILABLE, setupTestDatabase } from './test-db.js';
import {
  type GroupDefinition,
  WishStateMismatchError,
  completeGroup,
  computeGroupsSignature,
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
  wipeState,
} from './wish-state.js';

let cwd: string;

describe.skipIf(!DB_AVAILABLE)('pg', () => {
  let cleanupSchema: () => Promise<void>;

  beforeAll(async () => {
    cleanupSchema = await setupTestDatabase();
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

    test('idempotent when group already done (issue #1214)', async () => {
      // Previously threw `must be in_progress (currently done)`. That caused
      // `genie done` to exit 1 when an engineer called it twice (e.g. retry),
      // which the orchestrator couldn't distinguish from a real failure.
      // Now: return the existing done state without throwing.
      await createState('test-wish', sampleGroups, cwd);
      await startGroup('test-wish', '1', 'agent-a', cwd);
      await completeGroup('test-wish', '1', cwd);

      const result = await completeGroup('test-wish', '1', cwd);
      expect(result.status).toBe('done');
      expect(result.completedAt).toBeDefined();
    });

    test('refuses when group not found', async () => {
      await createState('test-wish', sampleGroups, cwd);

      await expect(completeGroup('test-wish', 'nonexistent', cwd)).rejects.toThrow('not found');
    });

    test('rejects blocked groups with clear unmet-dep message (issue #1214)', async () => {
      await createState('test-wish', sampleGroups, cwd);

      // Group 2 depends on group 1 and should be blocked
      const groupState = await getGroupState('test-wish', '2', cwd);
      expect(groupState?.status).toBe('blocked');

      await expect(completeGroup('test-wish', '2', cwd)).rejects.toThrow(/blocked on unmet dependencies/);
    });

    test('auto-recovers ready groups from dispatch-bypass (issue #1214)', async () => {
      // Previously threw `must be in_progress (currently ready)` when a
      // sidechannel-spawned engineer called `genie done` without first going
      // through runWorkDispatch → startGroup. The orchestrator couldn't see
      // the failure (agent loop doesn't inspect exit codes), so every wave
      // progressed by prose inference. Fix: auto-transition ready → in_progress
      // before completing, and keep going.
      await createState('test-wish', sampleGroups, cwd);

      const result = await completeGroup('test-wish', '1', cwd);
      expect(result.status).toBe('done');
      expect(result.completedAt).toBeDefined();
      // startedAt must be populated — callers using GroupState for timing
      // (dashboards, duration reports) would otherwise see undefined.
      expect(result.startedAt).toBeDefined();
      expect(typeof result.startedAt).toBe('string');

      const state = await getGroupState('test-wish', '1', cwd);
      expect(state?.status).toBe('done');
      expect(state?.startedAt).toBeDefined();
    });
  });

  // ============================================================================
  // findParent diagnostics — issue #1234 repo_path drift warnings
  // ============================================================================

  describe('findParent state-partition warning (issue #1234)', () => {
    test('warns when wish has parents at other repo_paths', async () => {
      // Simulate the real-world bug: the same wish slug gets a parent row
      // in repo_path A (e.g. a worktree), then someone runs from repo_path B
      // (e.g. the main repo) and silently forks a NEW parent with fresh
      // ready/blocked children, so status reads reflect nothing.
      const cwdA = `${cwd}-A`;
      const cwdB = `${cwd}-B`;

      await createState('drift-wish', sampleGroups, cwdA);

      // Capture console.warn from the getState call made against cwdB.
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (msg: string) => warnings.push(msg);

      try {
        const stateB = await getState('drift-wish', cwdB);
        expect(stateB).toBeNull();
      } finally {
        console.warn = originalWarn;
      }

      const partitionWarning = warnings.find((w) => w.includes('partitioned across repo_paths'));
      expect(partitionWarning).toBeDefined();
      expect(partitionWarning).toContain(cwdA);
      expect(partitionWarning).toContain(cwdB);
      expect(partitionWarning).toContain('drift-wish');
    });

    test('does NOT warn when no other repo_paths own this wish', async () => {
      // Genuinely-new wish — no partition, no noise. A `genie wish status` on
      // an uncreated wish should still feel clean, not yell about drift.
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (msg: string) => warnings.push(msg);

      try {
        const state = await getState('totally-new-wish', cwd);
        expect(state).toBeNull();
      } finally {
        console.warn = originalWarn;
      }

      const partitionWarning = warnings.find((w) => w.includes('partitioned across repo_paths'));
      expect(partitionWarning).toBeUndefined();
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
  // computeGroupsSignature + getOrCreateState invalidation
  // ============================================================================

  describe('computeGroupsSignature', () => {
    test('is stable across calls for the same input', () => {
      const sig1 = computeGroupsSignature(sampleGroups);
      const sig2 = computeGroupsSignature(sampleGroups);
      expect(sig1).toBe(sig2);
      expect(sig1).toMatch(/^[0-9a-f]{64}$/);
    });

    test('is order-insensitive on dependsOn', () => {
      const a: GroupDefinition[] = [{ name: '4', dependsOn: ['2', '3'] }, { name: '2' }, { name: '3' }];
      const b: GroupDefinition[] = [{ name: '2' }, { name: '3' }, { name: '4', dependsOn: ['3', '2'] }];
      expect(computeGroupsSignature(a)).toBe(computeGroupsSignature(b));
    });

    test('changes when a group is added', () => {
      const before: GroupDefinition[] = [{ name: '1' }];
      const after: GroupDefinition[] = [{ name: '1' }, { name: '2', dependsOn: ['1'] }];
      expect(computeGroupsSignature(before)).not.toBe(computeGroupsSignature(after));
    });

    test('changes when a dep is changed', () => {
      const before: GroupDefinition[] = [{ name: '1' }, { name: '2', dependsOn: ['1'] }];
      const after: GroupDefinition[] = [{ name: '1' }, { name: '2', dependsOn: [] }];
      expect(computeGroupsSignature(before)).not.toBe(computeGroupsSignature(after));
    });
  });

  describe('getOrCreateState invalidation', () => {
    test('writes groupsSignature to parent metadata on createState', async () => {
      await createState('sig-write', sampleGroups, cwd);
      const sql = await getConnection();
      const rows = await sql`
        SELECT metadata FROM tasks
        WHERE wish_file = ${'.genie/wishes/sig-write/WISH.md'} AND repo_path = ${cwd} AND parent_id IS NULL
      `;
      expect(rows.length).toBe(1);
      const metadata = typeof rows[0].metadata === 'string' ? JSON.parse(rows[0].metadata) : rows[0].metadata;
      expect(metadata.groupsSignature).toBe(computeGroupsSignature(sampleGroups));
    });

    test('returns existing state when signature matches', async () => {
      await createState('sig-match', sampleGroups, cwd);
      const state = await getOrCreateState('sig-match', sampleGroups, cwd);
      expect(state.wish).toBe('sig-match');
      expect(Object.keys(state.groups)).toEqual(['1', '2', '3', '4']);
    });

    test('throws WishStateMismatchError when a group is added', async () => {
      await createState('sig-add', sampleGroups, cwd);
      const edited: GroupDefinition[] = [...sampleGroups, { name: '5', dependsOn: ['4'] }];

      let caught: unknown;
      try {
        await getOrCreateState('sig-add', edited, cwd);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(WishStateMismatchError);
      const err = caught as WishStateMismatchError;
      expect(err.added).toEqual(['5']);
      expect(err.removed).toEqual([]);
      expect(err.changed).toEqual([]);
      expect(err.message).toContain('genie reset sig-add');
    });

    test('throws WishStateMismatchError when a group is removed', async () => {
      await createState('sig-remove', sampleGroups, cwd);
      const edited: GroupDefinition[] = [
        { name: '1' },
        { name: '2', dependsOn: ['1'] },
        { name: '3', dependsOn: ['1'] },
      ];

      let caught: unknown;
      try {
        await getOrCreateState('sig-remove', edited, cwd);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(WishStateMismatchError);
      expect((caught as WishStateMismatchError).removed).toEqual(['4']);
    });

    test('throws WishStateMismatchError when a dep changes', async () => {
      await createState('sig-change', sampleGroups, cwd);
      const edited: GroupDefinition[] = [
        { name: '1' },
        { name: '2', dependsOn: ['1'] },
        { name: '3', dependsOn: ['1'] },
        { name: '4', dependsOn: ['2'] }, // dropped '3'
      ];

      let caught: unknown;
      try {
        await getOrCreateState('sig-change', edited, cwd);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(WishStateMismatchError);
      expect((caught as WishStateMismatchError).changed).toEqual(['4']);
    });

    test('does NOT throw when group structure is unchanged (prose-only edit)', async () => {
      await createState('sig-prose', sampleGroups, cwd);
      // Same group definitions — represents WISH.md prose edits that don't touch
      // group structure (Summary, Decisions, etc.).
      const state = await getOrCreateState('sig-prose', sampleGroups, cwd);
      expect(state.wish).toBe('sig-prose');
    });

    test('does NOT throw when state exists without signature (backfill-free)', async () => {
      // Simulate pre-existing state from before this feature landed
      await createState('sig-backfill', sampleGroups, cwd);
      const sql = await getConnection();
      await sql`
        UPDATE tasks
        SET metadata = '{}'::jsonb
        WHERE wish_file = ${'.genie/wishes/sig-backfill/WISH.md'} AND parent_id IS NULL
      `;

      // Even with structurally different groups, no throw — we treat absent
      // signature as "valid, never validated".
      const edited: GroupDefinition[] = [{ name: 'totally-different' }];
      const state = await getOrCreateState('sig-backfill', edited, cwd);
      expect(state.wish).toBe('sig-backfill');
      // Returns the existing (stale) state — backfill-free path
      expect(Object.keys(state.groups)).toEqual(['1', '2', '3', '4']);
    });
  });

  describe('wipeState + reset recovery', () => {
    test('wipeState returns false when no state exists', async () => {
      expect(await wipeState('never-existed', cwd)).toBe(false);
    });

    test('wipeState deletes parent and cascades to children', async () => {
      await createState('wipe-me', sampleGroups, cwd);
      expect(await getState('wipe-me', cwd)).not.toBeNull();

      const wiped = await wipeState('wipe-me', cwd);
      expect(wiped).toBe(true);
      expect(await getState('wipe-me', cwd)).toBeNull();
    });

    test('reset flow: invalidation → wipe → recreate produces fresh state', async () => {
      await createState('reset-flow', sampleGroups, cwd);

      const edited: GroupDefinition[] = [...sampleGroups, { name: '5', dependsOn: ['4'] }];

      // 1. Invalidation fires
      await expect(getOrCreateState('reset-flow', edited, cwd)).rejects.toBeInstanceOf(WishStateMismatchError);

      // 2. Wipe + recreate (what `genie reset <slug>` does)
      await wipeState('reset-flow', cwd);
      const recreated = await createState('reset-flow', edited, cwd);

      expect(Object.keys(recreated.groups)).toEqual(['1', '2', '3', '4', '5']);

      // 3. getOrCreateState now succeeds against the new structure
      const state = await getOrCreateState('reset-flow', edited, cwd);
      expect(state.groups['5'].status).toBe('blocked');
    });
  });

  // ============================================================================
  // resolveRepoPath — worktree normalization
  // ============================================================================

  describe('resolveRepoPath', () => {
    let mainRepo: string;
    let worktreePath: string;
    let originalCwd: string;
    let worktreeReady = false;

    beforeAll(() => {
      originalCwd = process.cwd();

      // Create a real git repo
      mainRepo = mkdtempSync(join(tmpdir(), 'genie-resolve-test-'));
      execSync('git init', { cwd: mainRepo, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: mainRepo, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: mainRepo, stdio: 'pipe' });
      execSync('git commit --allow-empty -m "init"', { cwd: mainRepo, stdio: 'pipe' });

      // Create a worktree — may fail in CI (shallow clones, restricted /tmp)
      worktreePath = `${mainRepo}-worktree`;
      try {
        execSync(`git worktree add ${worktreePath} -b test-branch`, { cwd: mainRepo, stdio: 'pipe' });
      } catch {
        /* git worktree may not be available in all CI environments */
      }
      worktreeReady = existsSync(worktreePath);
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
      if (!worktreeReady) return; // skip in CI when git worktree is unavailable
      process.chdir(worktreePath);
      const result = resolveRepoPath();
      // Key assertion: from worktree, resolveRepoPath returns the main repo
      expect(result).toBe(mainRepo);
    });

    test('main repo and worktree resolve to the same path', () => {
      if (!worktreeReady) return; // skip in CI when git worktree is unavailable
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
});
