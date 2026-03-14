import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type GroupDefinition,
  completeGroup,
  createState,
  getGroupState,
  getState,
  resetGroup,
  startGroup,
} from './wish-state.js';

describe('wish-state', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'genie-wish-state-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
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
    test('creates state file with correct initial statuses', async () => {
      const state = await createState('test-wish', sampleGroups, cwd);

      expect(state.wish).toBe('test-wish');
      expect(state.groups['1'].status).toBe('ready');
      expect(state.groups['2'].status).toBe('blocked');
      expect(state.groups['3'].status).toBe('blocked');
      expect(state.groups['4'].status).toBe('blocked');
    });

    test('persists state file to disk', async () => {
      await createState('test-wish', sampleGroups, cwd);

      const filePath = join(cwd, '.genie', 'state', 'test-wish.json');
      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);

      expect(parsed.wish).toBe('test-wish');
      expect(parsed.groups['1'].status).toBe('ready');
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

    test('persists state change to disk', async () => {
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

    test('persists reset to disk', async () => {
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
});
