import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  followRuntimeEvents,
  getLatestRuntimeEventId,
  listRuntimeEvents,
  publishRuntimeEvent,
  queryRuntimeEventThroughput,
  waitForRuntimeEvent,
} from './runtime-events.js';
import { DB_AVAILABLE, setupTestSchema } from './test-db.js';

let cleanup: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (!DB_AVAILABLE) return;
  cleanup = await setupTestSchema();
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

async function waitUntil(fn: () => boolean, timeoutMs = 1500): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for condition');
}

describe.skipIf(!DB_AVAILABLE)('runtime-events', () => {
  test('persists events and replays by cursor', async () => {
    const first = await publishRuntimeEvent({
      repoPath: '/tmp/runtime-events',
      kind: 'tool_call',
      agent: 'engineer',
      team: 'alpha',
      text: 'Read foo.ts',
      source: 'hook',
      data: { toolCall: { name: 'Read' } },
    });

    await publishRuntimeEvent({
      repoPath: '/tmp/runtime-events',
      kind: 'assistant',
      agent: 'engineer',
      team: 'alpha',
      text: 'Done',
      source: 'hook',
    });

    const replayed = await listRuntimeEvents({ afterId: first.id, repoPath: '/tmp/runtime-events' });
    expect(replayed).toHaveLength(1);
    expect(replayed[0].kind).toBe('assistant');
  });

  test('supports scopeMode any across team and agent filters', async () => {
    await publishRuntimeEvent({
      repoPath: '/tmp/runtime-scope',
      kind: 'state',
      agent: 'worker-a',
      text: 'spawned',
      source: 'registry',
      team: 'team-a',
    });
    await publishRuntimeEvent({
      repoPath: '/tmp/runtime-scope',
      kind: 'state',
      agent: 'worker-b',
      text: 'spawned',
      source: 'registry',
      team: 'team-b',
    });

    const events = await listRuntimeEvents({
      scopeMode: 'any',
      team: 'team-b',
      agentIds: ['worker-a'],
      repoPath: '/tmp/runtime-scope',
    });

    expect(events.map((event) => event.agent)).toEqual(['worker-a', 'worker-b']);
  });

  test('follows new events via pg event log', async () => {
    const received: string[] = [];
    const handle = await followRuntimeEvents(
      {
        repoPath: '/tmp/runtime-follow',
        team: 'qa-team',
      },
      (event) => received.push(event.text),
      { pollIntervalMs: 50 },
    );

    try {
      await publishRuntimeEvent({
        repoPath: '/tmp/runtime-follow',
        kind: 'qa',
        agent: 'qa',
        team: 'qa-team',
        text: 'qa:spec-started',
        source: 'hook',
      });

      await waitUntil(() => received.includes('qa:spec-started'));
      expect(received).toContain('qa:spec-started');
    } finally {
      await handle.stop();
    }
  });

  test('follow respects repoPath scoping', async () => {
    const received: string[] = [];
    const handle = await followRuntimeEvents(
      {
        repoPath: '/tmp/runtime-follow-scope-a',
        team: 'qa-team',
      },
      (event) => received.push(event.text),
      { pollIntervalMs: 50 },
    );

    try {
      await publishRuntimeEvent({
        repoPath: '/tmp/runtime-follow-scope-b',
        kind: 'qa',
        agent: 'qa',
        team: 'qa-team',
        text: 'wrong-repo',
        source: 'hook',
      });
      await publishRuntimeEvent({
        repoPath: '/tmp/runtime-follow-scope-a',
        kind: 'qa',
        agent: 'qa',
        team: 'qa-team',
        text: 'right-repo',
        source: 'hook',
      });

      await waitUntil(() => received.includes('right-repo'));
      expect(received).toContain('right-repo');
      expect(received).not.toContain('wrong-repo');
    } finally {
      await handle.stop();
    }
  });

  test('waits for the next matching event', async () => {
    const waitPromise = waitForRuntimeEvent(
      {
        subject: 'genie.qa.qa-team.result',
      },
      1000,
    );

    await publishRuntimeEvent({
      repoPath: '/tmp/runtime-wait',
      subject: 'genie.qa.qa-team.result',
      kind: 'qa',
      agent: 'qa',
      team: 'qa-team',
      text: 'qa-result',
      source: 'hook',
      data: { result: 'pass' },
    });

    const event = await waitPromise;
    expect(event?.subject).toBe('genie.qa.qa-team.result');
    expect(event?.data?.result).toBe('pass');
  });

  test('waitForRuntimeEvent respects repoPath scoping', async () => {
    const waitPromise = waitForRuntimeEvent(
      {
        repoPath: '/tmp/runtime-wait-scope-a',
        subject: 'genie.qa.qa-scope.result',
        team: 'qa-scope',
      },
      1000,
    );

    await publishRuntimeEvent({
      repoPath: '/tmp/runtime-wait-scope-b',
      subject: 'genie.qa.qa-scope.result',
      kind: 'qa',
      agent: 'qa',
      team: 'qa-scope',
      text: 'wrong-repo',
      source: 'hook',
      data: { result: 'fail' },
    });
    await publishRuntimeEvent({
      repoPath: '/tmp/runtime-wait-scope-a',
      subject: 'genie.qa.qa-scope.result',
      kind: 'qa',
      agent: 'qa',
      team: 'qa-scope',
      text: 'right-repo',
      source: 'hook',
      data: { result: 'pass' },
    });

    const event = await waitPromise;
    expect(event?.text).toBe('right-repo');
    expect(event?.data?.result).toBe('pass');
  });

  test('queryRuntimeEventThroughput counts recently-published events (regression: CLI reported 0)', async () => {
    // Before C3 the metrics CLI read a module-level `eventsEmitted` counter
    // from a fresh process → always 0. The fix reads this DB query instead.
    const baseline = await queryRuntimeEventThroughput(60);

    const marker = `throughput-${Date.now()}`;
    await publishRuntimeEvent({
      repoPath: `/tmp/${marker}-a`,
      kind: 'message',
      agent: 'agent-a',
      text: 'hello',
      source: 'mailbox',
    });
    await publishRuntimeEvent({
      repoPath: `/tmp/${marker}-b`,
      kind: 'message',
      agent: 'agent-b',
      text: 'world',
      source: 'mailbox',
    });

    const after = await queryRuntimeEventThroughput(60);
    expect(after.emitted).toBeGreaterThanOrEqual(baseline.emitted + 2);
  });

  test('queryRuntimeEventThroughput rejects non-positive windows', async () => {
    await expect(queryRuntimeEventThroughput(0)).rejects.toThrow(/positive/);
    await expect(queryRuntimeEventThroughput(-5)).rejects.toThrow(/positive/);
    await expect(queryRuntimeEventThroughput(Number.NaN)).rejects.toThrow(/positive/);
  });

  test('latest event id advances monotonically', async () => {
    const before = await getLatestRuntimeEventId();
    const event = await publishRuntimeEvent({
      repoPath: '/tmp/runtime-latest',
      kind: 'message',
      agent: 'alice',
      text: 'hello',
      source: 'mailbox',
    });
    const after = await getLatestRuntimeEventId();

    expect(after).toBeGreaterThanOrEqual(event.id);
    expect(after).toBeGreaterThan(before);
  });
});
