import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { listRuntimeEvents, publishRuntimeEvent } from './runtime-events.js';
import { DB_AVAILABLE, setupTestDatabase } from './test-db.js';

let cleanup: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (!DB_AVAILABLE) return;
  cleanup = await setupTestDatabase();
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

describe.skipIf(!DB_AVAILABLE)('runtime-events thread_id', () => {
  test('defaults thread_id to agent:<agent> when not provided', async () => {
    const event = await publishRuntimeEvent({
      repoPath: '/tmp/thread-default',
      kind: 'tool_call',
      agent: 'engineer-3',
      text: 'Read foo.ts',
      source: 'hook',
    });

    expect(event.threadId).toBe('agent:engineer-3');
  });

  test('uses explicit threadId when provided', async () => {
    const event = await publishRuntimeEvent({
      repoPath: '/tmp/thread-explicit',
      kind: 'system',
      agent: 'system',
      text: 'Task updated',
      source: 'hook',
      threadId: 'task:task-189',
    });

    expect(event.threadId).toBe('task:task-189');
  });

  test('filters events by threadId', async () => {
    const repoPath = '/tmp/thread-filter';

    await publishRuntimeEvent({
      repoPath,
      kind: 'tool_call',
      agent: 'eng-a',
      text: 'action on task 1',
      source: 'hook',
      threadId: 'task:task-1',
    });
    await publishRuntimeEvent({
      repoPath,
      kind: 'tool_call',
      agent: 'eng-b',
      text: 'action on task 2',
      source: 'hook',
      threadId: 'task:task-2',
    });
    await publishRuntimeEvent({
      repoPath,
      kind: 'tool_call',
      agent: 'eng-a',
      text: 'another action on task 1',
      source: 'hook',
      threadId: 'task:task-1',
    });

    const task1Events = await listRuntimeEvents({ repoPath, threadId: 'task:task-1' });
    expect(task1Events).toHaveLength(2);
    expect(task1Events.every((e) => e.threadId === 'task:task-1')).toBe(true);

    const task2Events = await listRuntimeEvents({ repoPath, threadId: 'task:task-2' });
    expect(task2Events).toHaveLength(1);
    expect(task2Events[0].text).toBe('action on task 2');
  });

  test('team-scoped thread_id', async () => {
    const repoPath = '/tmp/thread-team';

    await publishRuntimeEvent({
      repoPath,
      kind: 'state',
      agent: 'team-lead',
      team: 'alpha',
      text: 'team event',
      source: 'registry',
      threadId: 'team:alpha',
    });

    const events = await listRuntimeEvents({ repoPath, threadId: 'team:alpha' });
    expect(events).toHaveLength(1);
    expect(events[0].threadId).toBe('team:alpha');
  });
});
