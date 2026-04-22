import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { addDependency, checkoutTask, createTask, getBlockingDependencies, markDone } from './task-service.js';
import { DB_AVAILABLE, setupTestDatabase } from './test-db.js';

let cleanup: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (!DB_AVAILABLE) return;
  cleanup = await setupTestDatabase();
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

describe.skipIf(!DB_AVAILABLE)('task checkout dependency gate', () => {
  const repoPath = '/tmp/test-checkout-deps';

  test('allows checkout when no dependencies exist', async () => {
    const task = await createTask({ title: 'Independent task' }, repoPath);
    const result = await checkoutTask(task.id, 'run-1', repoPath);
    expect(result.status).toBe('in_progress');
    expect(result.checkoutRunId).toBe('run-1');
  });

  test('blocks checkout when dependencies are unsatisfied', async () => {
    const blocker = await createTask({ title: 'Blocker task' }, repoPath);
    const blocked = await createTask({ title: 'Blocked task' }, repoPath);

    await addDependency(blocked.id, blocker.id, 'depends_on', repoPath);

    expect(checkoutTask(blocked.id, 'run-2', repoPath)).rejects.toThrow(/blocked by/i);
  });

  test('allows checkout when all dependencies are done', async () => {
    const dep1 = await createTask({ title: 'Dep 1' }, repoPath);
    const dep2 = await createTask({ title: 'Dep 2' }, repoPath);
    const task = await createTask({ title: 'Task with deps' }, repoPath);

    await addDependency(task.id, dep1.id, 'depends_on', repoPath);
    await addDependency(task.id, dep2.id, 'depends_on', repoPath);

    // Mark both deps as done
    await markDone(dep1.id, undefined, undefined, repoPath);
    await markDone(dep2.id, undefined, undefined, repoPath);

    const result = await checkoutTask(task.id, 'run-3', repoPath);
    expect(result.status).toBe('in_progress');
  });

  test('blocks checkout when some dependencies are unsatisfied', async () => {
    const done = await createTask({ title: 'Done dep' }, repoPath);
    const inProgress = await createTask({ title: 'In-progress dep' }, repoPath);
    const task = await createTask({ title: 'Partially blocked' }, repoPath);

    await addDependency(task.id, done.id, 'depends_on', repoPath);
    await addDependency(task.id, inProgress.id, 'depends_on', repoPath);

    await markDone(done.id, undefined, undefined, repoPath);

    expect(checkoutTask(task.id, 'run-4', repoPath)).rejects.toThrow(/blocked by/i);
  });

  test('getBlockingDependencies returns unsatisfied deps', async () => {
    const blocker1 = await createTask({ title: 'Unsatisfied A' }, repoPath);
    const blocker2 = await createTask({ title: 'Unsatisfied B' }, repoPath);
    const done = await createTask({ title: 'Satisfied' }, repoPath);
    const task = await createTask({ title: 'Task to check' }, repoPath);

    await addDependency(task.id, blocker1.id, 'depends_on', repoPath);
    await addDependency(task.id, blocker2.id, 'depends_on', repoPath);
    await addDependency(task.id, done.id, 'depends_on', repoPath);

    await markDone(done.id, undefined, undefined, repoPath);

    const blockers = await getBlockingDependencies(task.id, repoPath);
    expect(blockers).toHaveLength(2);
    expect(blockers.map((b) => b.title)).toContain('Unsatisfied A');
    expect(blockers.map((b) => b.title)).toContain('Unsatisfied B');
  });

  test('relates_to dependencies do not block checkout', async () => {
    const related = await createTask({ title: 'Related task' }, repoPath);
    const task = await createTask({ title: 'Task with relates_to' }, repoPath);

    await addDependency(task.id, related.id, 'relates_to', repoPath);

    // Should not block even though related task is not done
    const result = await checkoutTask(task.id, 'run-5', repoPath);
    expect(result.status).toBe('in_progress');
  });
});
