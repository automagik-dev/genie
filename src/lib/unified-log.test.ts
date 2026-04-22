/**
 * Unified Log — Unit Tests
 *
 * Tests LogEvent conversion, filtering, and aggregation from all sources.
 *
 * Run with: bun test src/lib/unified-log.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Agent } from './agent-registry.js';
import { recordAuditEvent } from './audit.js';
import { readOutbox, send } from './mailbox.js';
import { publishRuntimeEvent } from './runtime-events.js';
import { postMessage } from './team-chat.js';
import { setupTestDatabase } from './test-db.js';
import type { TranscriptEntry } from './transcript.js';
import {
  type LogEvent,
  applyLogFilter,
  chatMessageToLogEvent,
  followAgentLog,
  followTeamLog,
  inboxMessageToLogEvent,
  outboxMessageToLogEvent,
  readAgentLog,
  readTeamLog,
  sdkAuditRowToLogEvent,
  sortByTimestamp,
  transcriptToLogEvent,
} from './unified-log.js';

// ============================================================================
// Helpers
// ============================================================================

const DB_AVAILABLE = process.env.GENIE_PG_AVAILABLE === 'true' || !process.env.CI;

let cleanup: (() => Promise<void>) | undefined;
const BASE_REPO = '/tmp/unified-log-test';

beforeAll(async () => {
  if (!DB_AVAILABLE) return;
  cleanup = await setupTestDatabase();
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

function makeAgent(id: string, team?: string, repoPath?: string): Agent {
  return {
    id,
    paneId: '%0',
    session: 'test',
    worktree: null,
    startedAt: new Date().toISOString(),
    state: 'working',
    lastStateChange: new Date().toISOString(),
    repoPath: repoPath ?? BASE_REPO,
    team,
  };
}

// ============================================================================
// Converter tests
// ============================================================================

describe('transcriptToLogEvent', () => {
  test('maps assistant entry to assistant kind', () => {
    const entry: TranscriptEntry = {
      role: 'assistant',
      timestamp: '2026-03-20T10:00:00.000Z',
      text: 'Hello, I can help with that.',
      provider: 'claude',
      model: 'claude-sonnet-4-20250514',
      raw: {},
    };

    const event = transcriptToLogEvent(entry, 'engineer', 'my-team');

    expect(event!.kind).toBe('assistant');
    expect(event!.agent).toBe('engineer');
    expect(event!.team).toBe('my-team');
    expect(event!.text).toBe('Hello, I can help with that.');
    expect(event!.source).toBe('provider');
    expect(event!.data?.role).toBe('assistant');
    expect(event!.data?.model).toBe('claude-sonnet-4-20250514');
  });

  test('maps tool_call entry to tool_call kind', () => {
    const entry: TranscriptEntry = {
      role: 'tool_call',
      timestamp: '2026-03-20T10:01:00.000Z',
      text: 'Read file.ts',
      toolCall: { id: 'tc-1', name: 'Read', input: { file_path: '/test.ts' } },
      provider: 'claude',
      raw: {},
    };

    const event = transcriptToLogEvent(entry, 'engineer');

    expect(event!.kind).toBe('tool_call');
    expect(event!.data?.toolCall).toEqual({ id: 'tc-1', name: 'Read', input: { file_path: '/test.ts' } });
  });

  test('maps tool_result entry to tool_result kind', () => {
    const entry: TranscriptEntry = {
      role: 'tool_result',
      timestamp: '2026-03-20T10:02:00.000Z',
      text: 'file contents...',
      provider: 'codex',
      raw: {},
    };

    const event = transcriptToLogEvent(entry, 'coder');
    expect(event!.kind).toBe('tool_result');
    expect(event!.source).toBe('provider');
  });

  test('maps system entry to system kind', () => {
    const entry: TranscriptEntry = {
      role: 'system',
      timestamp: '2026-03-20T10:00:00.000Z',
      text: 'Session started',
      provider: 'claude',
      raw: {},
    };

    const event = transcriptToLogEvent(entry, 'engineer');
    expect(event!.kind).toBe('system');
  });
});

describe('inboxMessageToLogEvent', () => {
  test('converts inbox message with direction=in', () => {
    const event = inboxMessageToLogEvent(
      {
        id: 'msg-1',
        from: 'reviewer',
        to: 'engineer',
        body: 'Please fix the tests',
        createdAt: '2026-03-20T10:00:00.000Z',
        read: false,
        deliveredAt: null,
      },
      'engineer',
      'my-team',
    );

    expect(event!.kind).toBe('message');
    expect(event!.direction).toBe('in');
    expect(event!.peer).toBe('reviewer');
    expect(event!.agent).toBe('engineer');
    expect(event!.text).toBe('Please fix the tests');
    expect(event!.source).toBe('mailbox');
  });
});

describe('outboxMessageToLogEvent', () => {
  test('converts outbox message with direction=out', () => {
    const event = outboxMessageToLogEvent(
      {
        id: 'msg-2',
        from: 'engineer',
        to: 'reviewer',
        body: 'Tests are fixed',
        createdAt: '2026-03-20T11:00:00.000Z',
        read: false,
        deliveredAt: null,
      },
      'engineer',
    );

    expect(event!.kind).toBe('message');
    expect(event!.direction).toBe('out');
    expect(event!.peer).toBe('reviewer');
    expect(event!.agent).toBe('engineer');
    expect(event!.text).toBe('Tests are fixed');
  });
});

describe('chatMessageToLogEvent', () => {
  test('converts team chat message', () => {
    const event = chatMessageToLogEvent(
      {
        id: 'chat-1',
        sender: 'alice',
        body: 'Starting implementation',
        timestamp: '2026-03-20T10:00:00.000Z',
      },
      'dev-team',
    );

    expect(event!.kind).toBe('message');
    expect(event!.agent).toBe('alice');
    expect(event!.team).toBe('dev-team');
    expect(event!.source).toBe('chat');
    expect(event!.text).toBe('Starting implementation');
  });
});

// ============================================================================
// Filter tests
// ============================================================================

describe('applyLogFilter', () => {
  const events: LogEvent[] = [
    {
      timestamp: '2026-03-20T10:00:00.000Z',
      kind: 'assistant',
      agent: 'eng',
      text: 'first',
      source: 'provider',
    },
    {
      timestamp: '2026-03-20T11:00:00.000Z',
      kind: 'message',
      agent: 'eng',
      text: 'second',
      source: 'mailbox',
    },
    {
      timestamp: '2026-03-20T12:00:00.000Z',
      kind: 'tool_call',
      agent: 'eng',
      text: 'third',
      source: 'provider',
    },
    {
      timestamp: '2026-03-20T13:00:00.000Z',
      kind: 'assistant',
      agent: 'eng',
      text: 'fourth',
      source: 'provider',
    },
  ];

  test('returns all events with no filter', () => {
    expect(applyLogFilter(events)).toEqual(events);
    expect(applyLogFilter(events, {})).toEqual(events);
  });

  test('filters by since', () => {
    const result = applyLogFilter(events, { since: '2026-03-20T11:30:00.000Z' });
    expect(result.length).toBe(2);
    expect(result[0].text).toBe('third');
    expect(result[1].text).toBe('fourth');
  });

  test('filters by kinds', () => {
    const result = applyLogFilter(events, { kinds: ['message'] });
    expect(result.length).toBe(1);
    expect(result[0].text).toBe('second');
  });

  test('filters by multiple kinds', () => {
    const result = applyLogFilter(events, { kinds: ['assistant', 'tool_call'] });
    expect(result.length).toBe(3);
  });

  test('limits by last', () => {
    const result = applyLogFilter(events, { last: 2 });
    expect(result.length).toBe(2);
    expect(result[0].text).toBe('third');
    expect(result[1].text).toBe('fourth');
  });

  test('applies filters in order: since → kinds → last', () => {
    const result = applyLogFilter(events, {
      since: '2026-03-20T10:30:00.000Z',
      kinds: ['assistant', 'tool_call'],
      last: 1,
    });
    expect(result.length).toBe(1);
    expect(result[0].text).toBe('fourth');
  });
});

describe('sortByTimestamp', () => {
  test('sorts events chronologically', () => {
    const events: LogEvent[] = [
      { timestamp: '2026-03-20T12:00:00.000Z', kind: 'assistant', agent: 'a', text: 'c', source: 'provider' },
      { timestamp: '2026-03-20T10:00:00.000Z', kind: 'assistant', agent: 'a', text: 'a', source: 'provider' },
      { timestamp: '2026-03-20T11:00:00.000Z', kind: 'message', agent: 'a', text: 'b', source: 'mailbox' },
    ];

    const sorted = sortByTimestamp(events);
    expect(sorted[0].text).toBe('a');
    expect(sorted[1].text).toBe('b');
    expect(sorted[2].text).toBe('c');
  });
});

// ============================================================================
// Aggregator integration tests
// ============================================================================

describe.skipIf(!DB_AVAILABLE)('readAgentLog', () => {
  test('aggregates inbox and outbox messages', async () => {
    const repo = '/tmp/ulog-agent-agg';
    const agent = makeAgent('engineer', 'test-team', repo);

    // Send messages to create inbox + outbox data
    await send(repo, 'reviewer', 'engineer', 'please fix tests');
    await new Promise((r) => setTimeout(r, 10));
    await send(repo, 'engineer', 'reviewer', 'tests fixed');

    const events = await readAgentLog(agent, repo);

    // Should have inbox (1 received) + outbox (1 sent) messages
    const messages = events.filter((e) => e.kind === 'message');
    expect(messages.length).toBeGreaterThanOrEqual(2);

    const inbound = messages.find((e) => e.direction === 'in');
    expect(inbound).toBeTruthy();
    expect(inbound!.peer).toBe('reviewer');
    expect(inbound!.text).toBe('please fix tests');

    const outbound = messages.find((e) => e.direction === 'out');
    expect(outbound).toBeTruthy();
    expect(outbound!.peer).toBe('reviewer');
    expect(outbound!.text).toBe('tests fixed');
  });

  test('includes team chat messages', async () => {
    const repo = '/tmp/ulog-agent-chat';
    const agent = makeAgent('engineer', 'dev-team', repo);

    await postMessage(repo, 'dev-team', 'alice', 'hello team');
    await postMessage(repo, 'dev-team', 'bob', 'hi alice');

    const events = await readAgentLog(agent, repo);
    const chatEvents = events.filter((e) => e.source === 'chat');
    expect(chatEvents.length).toBe(2);
    expect(chatEvents[0].text).toBe('hello team');
    expect(chatEvents[1].text).toBe('hi alice');
  });

  test('returns sorted events across sources', async () => {
    const repo = '/tmp/ulog-agent-sorted';
    const agent = makeAgent('engineer', 'dev-team', repo);

    await postMessage(repo, 'dev-team', 'alice', 'first');
    await new Promise((r) => setTimeout(r, 10));
    await send(repo, 'reviewer', 'engineer', 'second');
    await new Promise((r) => setTimeout(r, 10));
    await postMessage(repo, 'dev-team', 'bob', 'third');

    const events = await readAgentLog(agent, repo);
    // Verify chronological order
    for (let i = 1; i < events.length; i++) {
      expect(new Date(events[i].timestamp).getTime()).toBeGreaterThanOrEqual(
        new Date(events[i - 1].timestamp).getTime(),
      );
    }
  });

  test('applies filter to aggregated events', async () => {
    const repo = '/tmp/ulog-agent-filter';
    const agent = makeAgent('engineer', undefined, repo);

    await send(repo, 'reviewer', 'engineer', 'msg1');
    await new Promise((r) => setTimeout(r, 10));
    await send(repo, 'qa', 'engineer', 'msg2');

    const events = await readAgentLog(agent, repo, { last: 1 });
    expect(events.length).toBe(1);
  });

  test('returns empty for agent with no activity', async () => {
    const repo = '/tmp/ulog-agent-empty';
    const agent = makeAgent('ghost', undefined, repo);
    const events = await readAgentLog(agent, repo);
    expect(events).toEqual([]);
  });

  test('matches mailbox entries written with role aliases', async () => {
    const repo = '/tmp/ulog-agent-role-alias';
    const agent: Agent = {
      ...makeAgent('qa-role-team-engineer', 'qa-role-team', repo),
      role: 'engineer',
    };

    await send(repo, 'team-lead', 'engineer', 'role-addressed message');

    const events = await readAgentLog(agent, repo, { kinds: ['message'] });
    expect(events.some((event) => event.direction === 'in' && event.peer === 'team-lead')).toBe(true);
    expect(events.some((event) => event.text.includes('role-addressed message'))).toBe(true);
  });
});

describe.skipIf(!DB_AVAILABLE)('readTeamLog', () => {
  test('interleaves events from multiple agents', async () => {
    const repo = '/tmp/ulog-team-interleave';
    const engineer = makeAgent('engineer', 'my-team', repo);
    const reviewer = makeAgent('reviewer', 'my-team', repo);

    // Create cross-agent messages
    await send(repo, 'engineer', 'reviewer', 'PR ready for review');
    await new Promise((r) => setTimeout(r, 10));
    await send(repo, 'reviewer', 'engineer', 'LGTM');
    await new Promise((r) => setTimeout(r, 10));
    await postMessage(repo, 'my-team', 'engineer', 'merging now');

    const events = await readTeamLog([engineer, reviewer], repo, 'my-team');

    // Should have events from both agents + team chat
    expect(events.length).toBeGreaterThanOrEqual(3);

    // Verify sorted
    for (let i = 1; i < events.length; i++) {
      expect(new Date(events[i].timestamp).getTime()).toBeGreaterThanOrEqual(
        new Date(events[i - 1].timestamp).getTime(),
      );
    }
  });

  test('team chat appears once, not duplicated per agent', async () => {
    const repo = '/tmp/ulog-team-dedup';
    const engineer = makeAgent('engineer', 'my-team', repo);
    const reviewer = makeAgent('reviewer', 'my-team', repo);

    await postMessage(repo, 'my-team', 'engineer', 'team message');

    const events = await readTeamLog([engineer, reviewer], repo, 'my-team');
    const chatEvents = events.filter((e) => e.source === 'chat');
    // Team chat is read once (not per agent)
    expect(chatEvents.length).toBe(1);
  });

  test('applies filter across interleaved events', async () => {
    const repo = '/tmp/ulog-team-filter';
    const eng = makeAgent('engineer', 'team', repo);
    const rev = makeAgent('reviewer', 'team', repo);

    await send(repo, 'engineer', 'reviewer', 'msg1');
    await new Promise((r) => setTimeout(r, 10));
    await send(repo, 'reviewer', 'engineer', 'msg2');

    const events = await readTeamLog([eng, rev], repo, 'team', { kinds: ['message'], last: 2 });
    expect(events.length).toBeLessThanOrEqual(2);
    for (const e of events) {
      expect(e.kind).toBe('message');
    }
  });

  test('returns empty for team with no activity', async () => {
    const repo = '/tmp/ulog-team-empty';
    const agent = makeAgent('lonely', 'empty-team', repo);
    const events = await readTeamLog([agent], repo, 'empty-team');
    expect(events).toEqual([]);
  });

  test('includes mailbox events when mailbox rows use agent roles', async () => {
    const repo = '/tmp/ulog-team-role-alias';
    const teamLead: Agent = {
      ...makeAgent('qa-role-team-team-lead', 'qa-role-team', repo),
      role: 'team-lead',
    };
    const reviewer: Agent = {
      ...makeAgent('qa-role-team-reviewer', 'qa-role-team', repo),
      role: 'reviewer',
    };

    await send(repo, 'team-lead', 'reviewer', 'please review PR #42');

    const events = await readTeamLog([teamLead, reviewer], repo, 'qa-role-team', { kinds: ['message'] });
    expect(
      events.some((event) => event.direction === 'out' && event.agent === teamLead.id && event.peer === 'reviewer'),
    ).toBe(true);
    expect(
      events.some((event) => event.direction === 'in' && event.agent === reviewer.id && event.peer === 'team-lead'),
    ).toBe(true);
  });
});

describe.skipIf(!DB_AVAILABLE)('follow mode', () => {
  test('followAgentLog streams PG runtime events for one agent', async () => {
    const agent = makeAgent('agent-follow', 'team-follow');
    const received: LogEvent[] = [];
    const handle = await followAgentLog(agent, BASE_REPO, { kinds: ['assistant'] }, (event) => received.push(event));

    try {
      await publishRuntimeEvent({
        repoPath: BASE_REPO,
        kind: 'assistant',
        agent: 'agent-follow',
        team: 'team-follow',
        text: 'follow-agent-ok',
        source: 'hook',
      });

      const started = Date.now();
      while (received.length === 0 && Date.now() - started < 1500) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      expect(handle.mode).toBe('pg');
      expect(received[0]?.text).toBe('follow-agent-ok');
    } finally {
      await handle.stop();
    }
  });

  test('followTeamLog filters by team scope', async () => {
    const repo = '/tmp/unified-log-follow-team';
    const agents = [makeAgent('eng-follow', 'scope-team', repo), makeAgent('rev-follow', 'scope-team', repo)];
    const received: LogEvent[] = [];
    const handle = await followTeamLog(agents, repo, 'scope-team', undefined, (event) => received.push(event));

    try {
      await publishRuntimeEvent({
        repoPath: repo,
        kind: 'state',
        agent: 'eng-follow',
        team: 'scope-team',
        text: 'allowed',
        source: 'registry',
      });
      await publishRuntimeEvent({
        repoPath: repo,
        kind: 'state',
        agent: 'outsider',
        team: 'other-team',
        text: 'blocked',
        source: 'registry',
      });

      const started = Date.now();
      while (received.length === 0 && Date.now() - started < 1500) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      expect(received.some((event) => event.text === 'allowed')).toBe(true);
      expect(received.some((event) => event.text === 'blocked')).toBe(false);
    } finally {
      await handle.stop();
    }
  });

  test('followTeamLog ignores matching events from other repos', async () => {
    const repoA = '/tmp/unified-log-follow-repo-a';
    const repoB = '/tmp/unified-log-follow-repo-b';
    const agents = [makeAgent('eng-shared', 'scope-team', repoA), makeAgent('rev-shared', 'scope-team', repoA)];
    const received: LogEvent[] = [];
    const handle = await followTeamLog(agents, repoA, 'scope-team', undefined, (event) => received.push(event));

    try {
      await publishRuntimeEvent({
        repoPath: repoB,
        kind: 'state',
        agent: 'eng-shared',
        team: 'scope-team',
        text: 'wrong-repo',
        source: 'registry',
      });
      await publishRuntimeEvent({
        repoPath: repoA,
        kind: 'state',
        agent: 'eng-shared',
        team: 'scope-team',
        text: 'right-repo',
        source: 'registry',
      });

      const started = Date.now();
      while (!received.some((event) => event.text === 'right-repo') && Date.now() - started < 1500) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      expect(received.some((event) => event.text === 'right-repo')).toBe(true);
      expect(received.some((event) => event.text === 'wrong-repo')).toBe(false);
    } finally {
      await handle.stop();
    }
  });
});

// ============================================================================
// Mailbox outbox integration
// ============================================================================

describe.skipIf(!DB_AVAILABLE)('mailbox outbox', () => {
  test('readOutbox returns sent messages from PG', async () => {
    const repo = '/tmp/ulog-outbox';
    await send(repo, 'engineer', 'reviewer', 'hello');
    await send(repo, 'engineer', 'qa', 'world');

    const outbox = await readOutbox(repo, 'engineer');
    expect(outbox.length).toBe(2);
    expect(outbox[0].from).toBe('engineer');
    expect(outbox[0].to).toBe('reviewer');
    expect(outbox[0].body).toBe('hello');
    expect(outbox[1].to).toBe('qa');
    expect(outbox[1].body).toBe('world');
  });
});

// ============================================================================
// SDK audit event tests
// ============================================================================

describe('sdkAuditRowToLogEvent', () => {
  test('maps sdk.assistant.message to assistant kind with sdk source', () => {
    const event = sdkAuditRowToLogEvent({
      id: 1,
      entity_type: 'sdk_message',
      entity_id: 'executor-123',
      event_type: 'sdk.assistant.message',
      actor: 'my-agent',
      details: { textPreview: 'Hello from SDK agent' },
      created_at: '2026-04-09T10:00:00.000Z',
    });

    expect(event.kind).toBe('assistant');
    expect(event.agent).toBe('my-agent');
    expect(event.text).toBe('Hello from SDK agent');
    expect(event.source).toBe('sdk');
  });

  test('maps sdk.user.message to user kind', () => {
    const event = sdkAuditRowToLogEvent({
      id: 2,
      entity_type: 'sdk_message',
      entity_id: 'executor-123',
      event_type: 'sdk.user.message',
      actor: 'my-agent',
      details: { textPreview: 'User said hello' },
      created_at: '2026-04-09T10:01:00.000Z',
    });

    expect(event.kind).toBe('user');
    expect(event.text).toBe('User said hello');
  });

  test('maps sdk.tool.summary to tool_call kind', () => {
    const event = sdkAuditRowToLogEvent({
      id: 3,
      entity_type: 'sdk_message',
      entity_id: 'executor-123',
      event_type: 'sdk.tool.summary',
      actor: 'my-agent',
      details: { textPreview: 'Read /tmp/file.ts' },
      created_at: '2026-04-09T10:02:00.000Z',
    });

    expect(event.kind).toBe('tool_call');
  });

  test('maps sdk.system to system kind', () => {
    const event = sdkAuditRowToLogEvent({
      id: 4,
      entity_type: 'sdk_message',
      entity_id: 'executor-123',
      event_type: 'sdk.system',
      actor: 'my-agent',
      details: { textPreview: 'Session initialized' },
      created_at: '2026-04-09T10:03:00.000Z',
    });

    expect(event.kind).toBe('system');
  });

  test('maps sdk.result.success to system kind', () => {
    const event = sdkAuditRowToLogEvent({
      id: 5,
      entity_type: 'sdk_message',
      entity_id: 'executor-123',
      event_type: 'sdk.result.success',
      actor: 'my-agent',
      details: { textPreview: 'Task completed' },
      created_at: '2026-04-09T10:04:00.000Z',
    });

    expect(event.kind).toBe('system');
  });

  test('maps sdk.rate_limit to system kind', () => {
    const event = sdkAuditRowToLogEvent({
      id: 6,
      entity_type: 'sdk_message',
      entity_id: 'executor-123',
      event_type: 'sdk.rate_limit',
      actor: 'my-agent',
      details: {},
      created_at: '2026-04-09T10:05:00.000Z',
    });

    expect(event.kind).toBe('system');
    expect(event.text).toBe('sdk.rate_limit');
  });

  test('falls back to event_type as text when no textPreview', () => {
    const event = sdkAuditRowToLogEvent({
      id: 7,
      entity_type: 'sdk_message',
      entity_id: 'executor-123',
      event_type: 'sdk.hook.started',
      actor: 'my-agent',
      details: {},
      created_at: '2026-04-09T10:06:00.000Z',
    });

    expect(event.kind).toBe('system');
    expect(event.text).toBe('sdk.hook.started');
  });

  test('unmapped event types default to system kind', () => {
    const event = sdkAuditRowToLogEvent({
      id: 8,
      entity_type: 'sdk_message',
      entity_id: 'executor-123',
      event_type: 'sdk.unknown.future',
      actor: 'my-agent',
      details: { textPreview: 'something new' },
      created_at: '2026-04-09T10:07:00.000Z',
    });

    expect(event.kind).toBe('system');
    expect(event.text).toBe('something new');
  });

  test('handles null actor gracefully', () => {
    const event = sdkAuditRowToLogEvent({
      id: 9,
      entity_type: 'sdk_message',
      entity_id: 'executor-123',
      event_type: 'sdk.assistant.message',
      actor: null,
      details: { textPreview: 'hello' },
      created_at: '2026-04-09T10:08:00.000Z',
    });

    expect(event.agent).toBe('unknown');
  });
});

describe.skipIf(!DB_AVAILABLE)('SDK events in readAgentLog', () => {
  test('includes SDK audit events in agent log', async () => {
    const repo = '/tmp/ulog-sdk-agent';
    const agent = makeAgent('sdk-test-agent', 'sdk-team', repo);

    // Insert SDK audit events
    await recordAuditEvent('sdk_message', 'executor-1', 'sdk.assistant.message', 'sdk-test-agent', {
      textPreview: 'SDK assistant response',
    });
    await recordAuditEvent('sdk_message', 'executor-1', 'sdk.user.message', 'sdk-test-agent', {
      textPreview: 'SDK user input',
    });

    const events = await readAgentLog(agent, repo);
    const sdkEvents = events.filter((e) => e.source === 'sdk');

    expect(sdkEvents.length).toBeGreaterThanOrEqual(2);
    expect(sdkEvents.some((e) => e.kind === 'assistant' && e.text === 'SDK assistant response')).toBe(true);
    expect(sdkEvents.some((e) => e.kind === 'user' && e.text === 'SDK user input')).toBe(true);
  });

  test('SDK events are sorted with other sources by timestamp', async () => {
    const repo = '/tmp/ulog-sdk-sorted';
    const agent = makeAgent('sdk-sort-agent', undefined, repo);

    // Insert an SDK event
    await recordAuditEvent('sdk_message', 'executor-2', 'sdk.assistant.message', 'sdk-sort-agent', {
      textPreview: 'SDK msg',
    });
    // Insert a mailbox event
    await send(repo, 'reviewer', 'sdk-sort-agent', 'mailbox msg');

    const events = await readAgentLog(agent, repo);

    // Verify chronological order is maintained across sources
    for (let i = 1; i < events.length; i++) {
      expect(new Date(events[i].timestamp).getTime()).toBeGreaterThanOrEqual(
        new Date(events[i - 1].timestamp).getTime(),
      );
    }
  });

  test('--type filter works with SDK event kinds', async () => {
    const repo = '/tmp/ulog-sdk-filter';
    const agent = makeAgent('sdk-filter-agent', undefined, repo);

    await recordAuditEvent('sdk_message', 'executor-3', 'sdk.assistant.message', 'sdk-filter-agent', {
      textPreview: 'assistant msg',
    });
    await recordAuditEvent('sdk_message', 'executor-3', 'sdk.system', 'sdk-filter-agent', {
      textPreview: 'system msg',
    });

    const events = await readAgentLog(agent, repo, { kinds: ['assistant'] });
    const sdkEvents = events.filter((e) => e.source === 'sdk');

    for (const e of sdkEvents) {
      expect(e.kind).toBe('assistant');
    }
  });
});

describe.skipIf(!DB_AVAILABLE)('SDK events in readTeamLog', () => {
  test('includes SDK events from multiple agents interleaved', async () => {
    const repo = '/tmp/ulog-sdk-team';
    const eng = makeAgent('sdk-team-eng', 'sdk-log-team', repo);
    const rev = makeAgent('sdk-team-rev', 'sdk-log-team', repo);

    await recordAuditEvent('sdk_message', 'executor-4', 'sdk.assistant.message', 'sdk-team-eng', {
      textPreview: 'eng SDK response',
    });
    await recordAuditEvent('sdk_message', 'executor-5', 'sdk.assistant.message', 'sdk-team-rev', {
      textPreview: 'rev SDK response',
    });

    const events = await readTeamLog([eng, rev], repo, 'sdk-log-team');
    const sdkEvents = events.filter((e) => e.source === 'sdk');

    expect(sdkEvents.some((e) => e.agent === 'sdk-team-eng')).toBe(true);
    expect(sdkEvents.some((e) => e.agent === 'sdk-team-rev')).toBe(true);
  });
});
