/**
 * Unified Log — Unit Tests
 *
 * Tests LogEvent conversion, filtering, and aggregation from all sources.
 *
 * Run with: bun test src/lib/unified-log.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent } from './agent-registry.js';
import { send } from './mailbox.js';
import { postMessage } from './team-chat.js';
import type { TranscriptEntry } from './transcript.js';
import {
  type LogEvent,
  applyLogFilter,
  chatMessageToLogEvent,
  inboxMessageToLogEvent,
  outboxMessageToLogEvent,
  readAgentLog,
  readTeamLog,
  sortByTimestamp,
  transcriptToLogEvent,
} from './unified-log.js';

// ============================================================================
// Helpers
// ============================================================================

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'unified-log-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function makeAgent(id: string, team?: string): Agent {
  return {
    id,
    paneId: '%0',
    session: 'test',
    worktree: null,
    startedAt: new Date().toISOString(),
    state: 'working',
    lastStateChange: new Date().toISOString(),
    repoPath: tempDir,
    team,
  };
}

// ============================================================================
// Converter tests
// ============================================================================

describe('transcriptToLogEvent', () => {
  test('maps assistant entry to transcript kind', () => {
    const entry: TranscriptEntry = {
      role: 'assistant',
      timestamp: '2026-03-20T10:00:00.000Z',
      text: 'Hello, I can help with that.',
      provider: 'claude',
      model: 'claude-sonnet-4-20250514',
      raw: {},
    };

    const event = transcriptToLogEvent(entry, 'engineer', 'my-team');

    expect(event.kind).toBe('transcript');
    expect(event.agent).toBe('engineer');
    expect(event.team).toBe('my-team');
    expect(event.text).toBe('Hello, I can help with that.');
    expect(event.source).toBe('provider');
    expect(event.data?.role).toBe('assistant');
    expect(event.data?.model).toBe('claude-sonnet-4-20250514');
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

    expect(event.kind).toBe('tool_call');
    expect(event.data?.toolCall).toEqual({ id: 'tc-1', name: 'Read', input: { file_path: '/test.ts' } });
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
    expect(event.kind).toBe('tool_result');
    expect(event.source).toBe('provider');
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
    expect(event.kind).toBe('system');
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

    expect(event.kind).toBe('message');
    expect(event.direction).toBe('in');
    expect(event.peer).toBe('reviewer');
    expect(event.agent).toBe('engineer');
    expect(event.text).toBe('Please fix the tests');
    expect(event.source).toBe('mailbox');
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

    expect(event.kind).toBe('message');
    expect(event.direction).toBe('out');
    expect(event.peer).toBe('reviewer');
    expect(event.agent).toBe('engineer');
    expect(event.text).toBe('Tests are fixed');
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

    expect(event.kind).toBe('message');
    expect(event.agent).toBe('alice');
    expect(event.team).toBe('dev-team');
    expect(event.source).toBe('chat');
    expect(event.text).toBe('Starting implementation');
  });
});

// ============================================================================
// Filter tests
// ============================================================================

describe('applyLogFilter', () => {
  const events: LogEvent[] = [
    {
      timestamp: '2026-03-20T10:00:00.000Z',
      kind: 'transcript',
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
      kind: 'transcript',
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
    const result = applyLogFilter(events, { kinds: ['transcript', 'tool_call'] });
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
      kinds: ['transcript', 'tool_call'],
      last: 1,
    });
    expect(result.length).toBe(1);
    expect(result[0].text).toBe('fourth');
  });
});

describe('sortByTimestamp', () => {
  test('sorts events chronologically', () => {
    const events: LogEvent[] = [
      { timestamp: '2026-03-20T12:00:00.000Z', kind: 'transcript', agent: 'a', text: 'c', source: 'provider' },
      { timestamp: '2026-03-20T10:00:00.000Z', kind: 'transcript', agent: 'a', text: 'a', source: 'provider' },
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

describe('readAgentLog', () => {
  test('aggregates inbox and outbox messages', async () => {
    const agent = makeAgent('engineer', 'test-team');

    // Send messages to create inbox + outbox data
    await send(tempDir, 'reviewer', 'engineer', 'please fix tests');
    await new Promise((r) => setTimeout(r, 10));
    await send(tempDir, 'engineer', 'reviewer', 'tests fixed');

    const events = await readAgentLog(agent, tempDir);

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
    const agent = makeAgent('engineer', 'dev-team');

    await postMessage(tempDir, 'dev-team', 'alice', 'hello team');
    await postMessage(tempDir, 'dev-team', 'bob', 'hi alice');

    const events = await readAgentLog(agent, tempDir);
    const chatEvents = events.filter((e) => e.source === 'chat');
    expect(chatEvents.length).toBe(2);
    expect(chatEvents[0].text).toBe('hello team');
    expect(chatEvents[1].text).toBe('hi alice');
  });

  test('returns sorted events across sources', async () => {
    const agent = makeAgent('engineer', 'dev-team');

    await postMessage(tempDir, 'dev-team', 'alice', 'first');
    await new Promise((r) => setTimeout(r, 10));
    await send(tempDir, 'reviewer', 'engineer', 'second');
    await new Promise((r) => setTimeout(r, 10));
    await postMessage(tempDir, 'dev-team', 'bob', 'third');

    const events = await readAgentLog(agent, tempDir);
    // Verify chronological order
    for (let i = 1; i < events.length; i++) {
      expect(new Date(events[i].timestamp).getTime()).toBeGreaterThanOrEqual(
        new Date(events[i - 1].timestamp).getTime(),
      );
    }
  });

  test('applies filter to aggregated events', async () => {
    const agent = makeAgent('engineer');

    await send(tempDir, 'reviewer', 'engineer', 'msg1');
    await new Promise((r) => setTimeout(r, 10));
    await send(tempDir, 'qa', 'engineer', 'msg2');

    const events = await readAgentLog(agent, tempDir, { last: 1 });
    expect(events.length).toBe(1);
  });

  test('returns empty for agent with no activity', async () => {
    const agent = makeAgent('ghost');
    const events = await readAgentLog(agent, tempDir);
    expect(events).toEqual([]);
  });
});

describe('readTeamLog', () => {
  test('interleaves events from multiple agents', async () => {
    const engineer = makeAgent('engineer', 'my-team');
    const reviewer = makeAgent('reviewer', 'my-team');

    // Create cross-agent messages
    await send(tempDir, 'engineer', 'reviewer', 'PR ready for review');
    await new Promise((r) => setTimeout(r, 10));
    await send(tempDir, 'reviewer', 'engineer', 'LGTM');
    await new Promise((r) => setTimeout(r, 10));
    await postMessage(tempDir, 'my-team', 'engineer', 'merging now');

    const events = await readTeamLog([engineer, reviewer], tempDir, 'my-team');

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
    const engineer = makeAgent('engineer', 'my-team');
    const reviewer = makeAgent('reviewer', 'my-team');

    await postMessage(tempDir, 'my-team', 'engineer', 'team message');

    const events = await readTeamLog([engineer, reviewer], tempDir, 'my-team');
    const chatEvents = events.filter((e) => e.source === 'chat');
    // Team chat is read once (not per agent)
    expect(chatEvents.length).toBe(1);
  });

  test('applies filter across interleaved events', async () => {
    const eng = makeAgent('engineer', 'team');
    const rev = makeAgent('reviewer', 'team');

    await send(tempDir, 'engineer', 'reviewer', 'msg1');
    await new Promise((r) => setTimeout(r, 10));
    await send(tempDir, 'reviewer', 'engineer', 'msg2');

    const events = await readTeamLog([eng, rev], tempDir, 'team', { kinds: ['message'], last: 2 });
    expect(events.length).toBeLessThanOrEqual(2);
    for (const e of events) {
      expect(e.kind).toBe('message');
    }
  });

  test('returns empty for team with no activity', async () => {
    const agent = makeAgent('lonely', 'empty-team');
    const events = await readTeamLog([agent], tempDir, 'empty-team');
    expect(events).toEqual([]);
  });
});

// ============================================================================
// Mailbox outbox integration
// ============================================================================

describe('mailbox outbox', () => {
  test('send() creates outbox JSONL for sender', async () => {
    await send(tempDir, 'engineer', 'reviewer', 'hello');
    await send(tempDir, 'engineer', 'qa', 'world');

    const outboxPath = join(tempDir, '.genie', 'mailbox', 'engineer-sent.jsonl');
    const content = await readFile(outboxPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(2);

    const msg1 = JSON.parse(lines[0]);
    expect(msg1.from).toBe('engineer');
    expect(msg1.to).toBe('reviewer');
    expect(msg1.body).toBe('hello');

    const msg2 = JSON.parse(lines[1]);
    expect(msg2.to).toBe('qa');
    expect(msg2.body).toBe('world');
  });
});
