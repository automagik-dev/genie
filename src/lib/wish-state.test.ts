import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type GroupDefinition, completeGroup, createState, getGroupState, getState, startGroup } from './wish-state.js';

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

      await expect(completeGroup('test-wish', '1', cwd)).rejects.toThrow('already done');
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
        'Cannot complete group "2": it is blocked (dependencies not met)',
      );
    });

    test('allows completing a ready group (skip in_progress)', async () => {
      await createState('test-wish', sampleGroups, cwd);

      // Group 1 is ready, complete directly without starting
      const result = await completeGroup('test-wish', '1', cwd);
      expect(result.status).toBe('done');
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
  // Edge Cases — QA Plan P0 Tests (U-WS-*)
  // ============================================================================

  describe('edge cases', () => {
    // U-WS-01: Empty groups array
    test('createState() with empty groups array creates state with empty groups', async () => {
      const state = await createState('empty-wish', [], cwd);
      expect(state.wish).toBe('empty-wish');
      expect(state.groups).toEqual({});
      expect(state.createdAt).toBeTruthy();
    });

    // U-WS-02: Self-referential dep (A depends on A)
    test('createState() with self-referential dep stays blocked forever', async () => {
      const groups: GroupDefinition[] = [{ name: 'A', dependsOn: ['A'] }];
      const state = await createState('self-ref', groups, cwd);
      // Self-dep means group has deps, so it starts as blocked
      expect(state.groups.A.status).toBe('blocked');

      // Trying to start it should fail because dep "A" is not done
      await expect(startGroup('self-ref', 'A', 'agent', cwd)).rejects.toThrow('dependency "A" is blocked');
    });

    // U-WS-03: Circular dep (A->B->A)
    test('createState() with circular deps: both stay blocked forever', async () => {
      const groups: GroupDefinition[] = [
        { name: 'A', dependsOn: ['B'] },
        { name: 'B', dependsOn: ['A'] },
      ];
      const state = await createState('circular', groups, cwd);
      expect(state.groups.A.status).toBe('blocked');
      expect(state.groups.B.status).toBe('blocked');

      // Neither can be started
      await expect(startGroup('circular', 'A', 'agent', cwd)).rejects.toThrow('dependency "B" is blocked');
      await expect(startGroup('circular', 'B', 'agent', cwd)).rejects.toThrow('dependency "A" is blocked');
    });

    // U-WS-04: Dep on non-existent group
    test('startGroup() with dep on non-existent group throws', async () => {
      const groups: GroupDefinition[] = [{ name: '1', dependsOn: ['99'] }];
      await createState('dangling', groups, cwd);

      await expect(startGroup('dangling', '1', 'agent', cwd)).rejects.toThrow('Dependency "99" not found');
    });

    // U-WS-05: Diamond dep graph (A->B, A->C, B->D, C->D)
    test('diamond dep graph: D becomes ready only when both B and C are done', async () => {
      const groups: GroupDefinition[] = [
        { name: 'A', dependsOn: [] },
        { name: 'B', dependsOn: ['A'] },
        { name: 'C', dependsOn: ['A'] },
        { name: 'D', dependsOn: ['B', 'C'] },
      ];
      await createState('diamond', groups, cwd);

      // A is ready, B/C/D blocked
      let state = await getState('diamond', cwd);
      expect(state?.groups.A.status).toBe('ready');
      expect(state?.groups.D.status).toBe('blocked');

      // Complete A -> B and C become ready
      await startGroup('diamond', 'A', 'a', cwd);
      await completeGroup('diamond', 'A', cwd);
      state = await getState('diamond', cwd);
      expect(state?.groups.B.status).toBe('ready');
      expect(state?.groups.C.status).toBe('ready');
      expect(state?.groups.D.status).toBe('blocked');

      // Complete B only -> D still blocked (C not done)
      await startGroup('diamond', 'B', 'b', cwd);
      await completeGroup('diamond', 'B', cwd);
      state = await getState('diamond', cwd);
      expect(state?.groups.D.status).toBe('blocked');

      // Complete C -> D now ready
      await startGroup('diamond', 'C', 'c', cwd);
      await completeGroup('diamond', 'C', cwd);
      state = await getState('diamond', cwd);
      expect(state?.groups.D.status).toBe('ready');
    });

    // U-WS-06: Deep chain (1->2->3->...->20)
    test('deep chain of 20 groups: sequential unlock works', async () => {
      const groups: GroupDefinition[] = [];
      for (let i = 1; i <= 20; i++) {
        groups.push({ name: String(i), dependsOn: i === 1 ? [] : [String(i - 1)] });
      }
      await createState('deep-chain', groups, cwd);

      // Walk through all 20
      for (let i = 1; i <= 20; i++) {
        const g = await startGroup('deep-chain', String(i), `agent-${i}`, cwd);
        expect(g.status).toBe('in_progress');
        await completeGroup('deep-chain', String(i), cwd);
      }

      const state = await getState('deep-chain', cwd);
      for (const group of Object.values(state?.groups ?? {})) {
        expect(group.status).toBe('done');
      }
    });

    // U-WS-07: Wide fan-out (A -> B1..B10)
    test('wide fan-out: all 10 dependents become ready when A completes', async () => {
      const groups: GroupDefinition[] = [{ name: 'A', dependsOn: [] }];
      for (let i = 1; i <= 10; i++) {
        groups.push({ name: `B${i}`, dependsOn: ['A'] });
      }
      await createState('fan-out', groups, cwd);

      await startGroup('fan-out', 'A', 'agent', cwd);
      await completeGroup('fan-out', 'A', cwd);

      const state = await getState('fan-out', cwd);
      for (let i = 1; i <= 10; i++) {
        expect(state?.groups[`B${i}`].status).toBe('ready');
      }
    });

    // U-WS-08: Corrupted JSON on disk
    test('getState() with corrupted JSON returns null', async () => {
      const statePath = join(cwd, '.genie', 'state');
      await mkdir(statePath, { recursive: true });
      await writeFile(join(statePath, 'corrupt.json'), '{ this is not json }}}');

      const state = await getState('corrupt', cwd);
      expect(state).toBeNull();
    });

    // U-WS-09: startGroup() with empty assignee string
    test('startGroup() with empty assignee string is allowed (documents behavior)', async () => {
      await createState('empty-assignee', [{ name: '1', dependsOn: [] }], cwd);
      const result = await startGroup('empty-assignee', '1', '', cwd);
      expect(result.status).toBe('in_progress');
      expect(result.assignee).toBe('');
    });

    // U-WS-10: completeGroup() on ready state (skip in_progress)
    test('completeGroup() on ready group succeeds but has no startedAt', async () => {
      await createState('skip-start', [{ name: '1', dependsOn: [] }], cwd);

      // Group 1 is ready, complete it directly without starting
      const result = await completeGroup('skip-start', '1', cwd);
      expect(result.status).toBe('done');
      expect(result.completedAt).toBeTruthy();
      // No startedAt since we skipped in_progress
      expect(result.startedAt).toBeUndefined();
      // No assignee either
      expect(result.assignee).toBeUndefined();
    });

    // U-WS-11: createState() overwrites existing state
    test('createState() overwrites existing state (non-idempotent)', async () => {
      const groups1: GroupDefinition[] = [
        { name: '1', dependsOn: [] },
        { name: '2', dependsOn: ['1'] },
      ];
      await createState('overwrite-test', groups1, cwd);
      await startGroup('overwrite-test', '1', 'agent', cwd);

      // Overwrite with different groups
      const groups2: GroupDefinition[] = [{ name: 'A', dependsOn: [] }];
      const newState = await createState('overwrite-test', groups2, cwd);

      expect(newState.groups.A).toBeDefined();
      expect(newState.groups['1']).toBeUndefined();
      expect(newState.groups['2']).toBeUndefined();
    });

    // U-WS-12: startGroup() on done group
    test('startGroup() on done group throws "already done"', async () => {
      await createState('restart-done', [{ name: '1', dependsOn: [] }], cwd);
      await startGroup('restart-done', '1', 'agent', cwd);
      await completeGroup('restart-done', '1', cwd);

      await expect(startGroup('restart-done', '1', 'other', cwd)).rejects.toThrow('already done');
    });

    // U-WS-13: completeGroup() on blocked group
    test('completeGroup() on blocked group throws', async () => {
      await createState(
        'block-complete',
        [
          { name: '1', dependsOn: [] },
          { name: '2', dependsOn: ['1'] },
        ],
        cwd,
      );

      await expect(completeGroup('block-complete', '2', cwd)).rejects.toThrow('it is blocked (dependencies not met)');
    });

    // Additional: truncated JSON state file
    test('getState() with truncated JSON returns null', async () => {
      const statePath = join(cwd, '.genie', 'state');
      await mkdir(statePath, { recursive: true });
      await writeFile(join(statePath, 'truncated.json'), '{"wish":"test","groups":{"1":{"status":"rea');

      const state = await getState('truncated', cwd);
      expect(state).toBeNull();
    });

    // Additional: state file that is valid JSON but fails schema validation
    test('getState() with valid JSON but wrong schema returns null', async () => {
      const statePath = join(cwd, '.genie', 'state');
      await mkdir(statePath, { recursive: true });
      await writeFile(join(statePath, 'bad-schema.json'), '{"foo":"bar"}');

      const state = await getState('bad-schema', cwd);
      expect(state).toBeNull();
    });
  });
});
