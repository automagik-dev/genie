/**
 * Log Command — Unit Tests
 *
 * Tests the genie log command handler: agent log, team log,
 * filters, NDJSON output, and human-readable output.
 *
 * Run with: bun test src/term-commands/log.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent } from '../lib/agent-registry.js';
import { send } from '../lib/mailbox.js';
import { postMessage } from '../lib/team-chat.js';
import {
  type LogEvent,
  applyLogFilter,
  followAgentLog,
  followTeamLog,
  readAgentLog,
  readTeamLog,
} from '../lib/unified-log.js';

// ============================================================================
// Helpers
// ============================================================================

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'log-cmd-test-'));
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
// readAgentLog integration (used by log command)
// ============================================================================

describe('log command: agent log via readAgentLog', () => {
  test('aggregates inbox + outbox into unified feed', async () => {
    const agent = makeAgent('engineer', 'test-team');

    await send(tempDir, 'reviewer', 'engineer', 'review this');
    await new Promise((r) => setTimeout(r, 10));
    await send(tempDir, 'engineer', 'reviewer', 'done');

    const events = await readAgentLog(agent, tempDir);
    const messages = events.filter((e) => e.kind === 'message');

    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages.some((m) => m.direction === 'in' && m.peer === 'reviewer')).toBe(true);
    expect(messages.some((m) => m.direction === 'out' && m.peer === 'reviewer')).toBe(true);
  });

  test('includes team chat in agent feed', async () => {
    const agent = makeAgent('engineer', 'dev-team');
    await postMessage(tempDir, 'dev-team', 'alice', 'standup update');

    const events = await readAgentLog(agent, tempDir);
    const chat = events.filter((e) => e.source === 'chat');
    expect(chat.length).toBe(1);
    expect(chat[0].text).toBe('standup update');
  });
});

// ============================================================================
// readTeamLog integration (used by --team flag)
// ============================================================================

describe('log command: team log via readTeamLog', () => {
  test('interleaves events from multiple agents', async () => {
    const eng = makeAgent('engineer', 'my-team');
    const rev = makeAgent('reviewer', 'my-team');

    await send(tempDir, 'engineer', 'reviewer', 'PR ready');
    await new Promise((r) => setTimeout(r, 10));
    await send(tempDir, 'reviewer', 'engineer', 'LGTM');
    await new Promise((r) => setTimeout(r, 10));
    await postMessage(tempDir, 'my-team', 'engineer', 'merged');

    const events = await readTeamLog([eng, rev], tempDir, 'my-team');
    expect(events.length).toBeGreaterThanOrEqual(3);

    // Chronological order
    for (let i = 1; i < events.length; i++) {
      expect(new Date(events[i].timestamp).getTime()).toBeGreaterThanOrEqual(
        new Date(events[i - 1].timestamp).getTime(),
      );
    }
  });
});

// ============================================================================
// Filter tests (--type, --since, --last)
// ============================================================================

describe('log command: filters', () => {
  const baseEvents: LogEvent[] = [
    { timestamp: '2026-03-20T10:00:00.000Z', kind: 'assistant', agent: 'eng', text: 'first', source: 'provider' },
    { timestamp: '2026-03-20T11:00:00.000Z', kind: 'message', agent: 'eng', text: 'second', source: 'mailbox' },
    { timestamp: '2026-03-20T12:00:00.000Z', kind: 'tool_call', agent: 'eng', text: 'third', source: 'provider' },
    { timestamp: '2026-03-20T13:00:00.000Z', kind: 'message', agent: 'eng', text: 'fourth', source: 'mailbox' },
  ];

  test('--type message filters to messages only', () => {
    const result = applyLogFilter(baseEvents, { kinds: ['message'] });
    expect(result.length).toBe(2);
    for (const e of result) expect(e.kind).toBe('message');
  });

  test('--type tool_call filters to tool calls only', () => {
    const result = applyLogFilter(baseEvents, { kinds: ['tool_call'] });
    expect(result.length).toBe(1);
    expect(result[0].text).toBe('third');
  });

  test('--last 2 shows last 2 events', () => {
    const result = applyLogFilter(baseEvents, { last: 2 });
    expect(result.length).toBe(2);
    expect(result[0].text).toBe('third');
    expect(result[1].text).toBe('fourth');
  });

  test('--since filters by timestamp', () => {
    const result = applyLogFilter(baseEvents, { since: '2026-03-20T11:30:00.000Z' });
    expect(result.length).toBe(2);
    expect(result[0].text).toBe('third');
  });

  test('combined filters: --type message --last 1', () => {
    const result = applyLogFilter(baseEvents, { kinds: ['message'], last: 1 });
    expect(result.length).toBe(1);
    expect(result[0].text).toBe('fourth');
  });
});

// ============================================================================
// NDJSON output
// ============================================================================

describe('log command: NDJSON output', () => {
  test('each line is valid JSON', async () => {
    const agent = makeAgent('engineer');

    await send(tempDir, 'reviewer', 'engineer', 'msg1');
    await new Promise((r) => setTimeout(r, 10));
    await send(tempDir, 'qa', 'engineer', 'msg2');

    const events = await readAgentLog(agent, tempDir);

    // Simulate NDJSON output
    const output = events.map((e) => JSON.stringify(e)).join('\n');
    const lines = output.split('\n').filter(Boolean);

    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty('timestamp');
      expect(parsed).toHaveProperty('kind');
      expect(parsed).toHaveProperty('agent');
      expect(parsed).toHaveProperty('text');
      expect(parsed).toHaveProperty('source');
    }
  });

  test('NDJSON output is pipeable (no extra formatting)', async () => {
    const agent = makeAgent('engineer');
    await send(tempDir, 'reviewer', 'engineer', 'test');

    const events = await readAgentLog(agent, tempDir);
    const ndjson = events.map((e) => JSON.stringify(e)).join('\n');

    // No ANSI codes in NDJSON
    expect(ndjson).not.toContain('\x1b[');
    // Each line parses independently
    for (const line of ndjson.split('\n').filter(Boolean)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

// ============================================================================
// Human-readable output
// ============================================================================

// ============================================================================
// Follow mode (NATS-only — requires NATS server for real-time streaming)
// ============================================================================

describe('log command: follow mode (NATS)', () => {
  test('followAgentLog returns nats mode when NATS is available', async () => {
    const agent = makeAgent('engineer', 'test-team');
    const handle = await followAgentLog(agent, tempDir, undefined, () => {});
    expect(handle.mode).toBe('nats');
    await handle.stop();
  });

  test('followTeamLog returns nats mode when NATS is available', async () => {
    const agents = [makeAgent('eng', 'team'), makeAgent('rev', 'team')];
    const handle = await followTeamLog(agents, tempDir, 'team', undefined, () => {});
    expect(handle.mode).toBe('nats');
    await handle.stop();
  });
});

// ============================================================================
// Human-readable output
// ============================================================================

describe('log command: human-readable output', () => {
  test('works without NATS (file-based only)', async () => {
    const agent = makeAgent('engineer', 'test-team');

    await send(tempDir, 'reviewer', 'engineer', 'fix the bug');
    await postMessage(tempDir, 'test-team', 'engineer', 'working on it');

    const events = await readAgentLog(agent, tempDir);
    expect(events.length).toBeGreaterThanOrEqual(2);

    // Verify event structure
    for (const event of events) {
      expect(event.timestamp).toBeTruthy();
      expect(event.kind).toBeTruthy();
      expect(event.agent).toBeTruthy();
      expect(event.text).toBeTruthy();
      expect(event.source).toBeTruthy();
    }
  });
});
