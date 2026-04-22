/**
 * Log Command — Unit Tests
 *
 * Tests the genie log command handler: agent log, team log,
 * filters, NDJSON output, and human-readable output.
 *
 * Run with: bun test src/term-commands/log.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as registry from '../lib/agent-registry.js';
import type { Agent } from '../lib/agent-registry.js';
import { send } from '../lib/mailbox.js';
import { publishRuntimeEvent } from '../lib/runtime-events.js';
import { postMessage } from '../lib/team-chat.js';
import { setupTestSchema } from '../lib/test-db.js';
import {
  type LogEvent,
  applyLogFilter,
  followAgentLog,
  followTeamLog,
  readAgentLog,
  readTeamLog,
} from '../lib/unified-log.js';
import { findAgent } from './log.js';

// ============================================================================
// Helpers
// ============================================================================

const DB_AVAILABLE = process.env.GENIE_PG_AVAILABLE === 'true' || !process.env.CI;

let cleanup: () => Promise<void>;

beforeAll(async () => {
  if (!DB_AVAILABLE) return;
  cleanup = await setupTestSchema();
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
    repoPath: repoPath ?? '/tmp/log-cmd-test',
    team,
  };
}

// ============================================================================
// readAgentLog integration (used by log command)
// ============================================================================

describe.skipIf(!DB_AVAILABLE)('log command: agent log via readAgentLog', () => {
  test('aggregates inbox + outbox into unified feed', async () => {
    const repo = '/tmp/log-agent-agg';
    const agent = makeAgent('engineer', 'test-team', repo);

    await send(repo, 'reviewer', 'engineer', 'review this');
    await new Promise((r) => setTimeout(r, 10));
    await send(repo, 'engineer', 'reviewer', 'done');

    const events = await readAgentLog(agent, repo);
    const messages = events.filter((e) => e.kind === 'message');

    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages.some((m) => m.direction === 'in' && m.peer === 'reviewer')).toBe(true);
    expect(messages.some((m) => m.direction === 'out' && m.peer === 'reviewer')).toBe(true);
  });

  test('includes team chat in agent feed', async () => {
    const repo = '/tmp/log-agent-chat';
    const agent = makeAgent('engineer', 'dev-team', repo);
    await postMessage(repo, 'dev-team', 'alice', 'standup update');

    const events = await readAgentLog(agent, repo);
    const chat = events.filter((e) => e.source === 'chat');
    expect(chat.length).toBe(1);
    expect(chat[0].text).toBe('standup update');
  });
});

// ============================================================================
// readTeamLog integration (used by --team flag)
// ============================================================================

describe.skipIf(!DB_AVAILABLE)('log command: team log via readTeamLog', () => {
  test('interleaves events from multiple agents', async () => {
    const repo = '/tmp/log-team-interleave';
    const eng = makeAgent('engineer', 'my-team', repo);
    const rev = makeAgent('reviewer', 'my-team', repo);

    await send(repo, 'engineer', 'reviewer', 'PR ready');
    await new Promise((r) => setTimeout(r, 10));
    await send(repo, 'reviewer', 'engineer', 'LGTM');
    await new Promise((r) => setTimeout(r, 10));
    await postMessage(repo, 'my-team', 'engineer', 'merged');

    const events = await readTeamLog([eng, rev], repo, 'my-team');
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

describe.skipIf(!DB_AVAILABLE)('log command: filters', () => {
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

describe.skipIf(!DB_AVAILABLE)('log command: NDJSON output', () => {
  test('each line is valid JSON', async () => {
    const repo = '/tmp/log-ndjson';
    const agent = makeAgent('engineer', undefined, repo);

    await send(repo, 'reviewer', 'engineer', 'msg1');
    await new Promise((r) => setTimeout(r, 10));
    await send(repo, 'qa', 'engineer', 'msg2');

    const events = await readAgentLog(agent, repo);

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
    const repo = '/tmp/log-ndjson-pipe';
    const agent = makeAgent('engineer', undefined, repo);
    await send(repo, 'reviewer', 'engineer', 'test');

    const events = await readAgentLog(agent, repo);
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
// Follow mode (PG event log)
// ============================================================================

describe.skipIf(!DB_AVAILABLE)('log command: follow mode (PG)', () => {
  test('followAgentLog returns pg mode and streams events', async () => {
    const agent = makeAgent('engineer', 'test-team');
    const received: LogEvent[] = [];
    const handle = await followAgentLog(agent, '/tmp/log-follow', undefined, (event) => received.push(event));
    try {
      await publishRuntimeEvent({
        repoPath: '/tmp/log-follow',
        kind: 'assistant',
        agent: 'engineer',
        team: 'test-team',
        text: 'streamed-assistant',
        source: 'hook',
      });
      const started = Date.now();
      while (received.length === 0 && Date.now() - started < 1500) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(received[0]?.text).toBe('streamed-assistant');
      expect(handle.mode).toBe('pg');
    } finally {
      await handle.stop();
    }
  });

  test('followTeamLog returns pg mode and filters team events', async () => {
    const agents = [makeAgent('eng', 'team'), makeAgent('rev', 'team')];
    const received: LogEvent[] = [];
    const handle = await followTeamLog(agents, '/tmp/log-follow-team', 'team', undefined, (event) =>
      received.push(event),
    );
    try {
      await publishRuntimeEvent({
        repoPath: '/tmp/log-follow-team',
        kind: 'state',
        agent: 'eng',
        team: 'team',
        text: 'team-event',
        source: 'registry',
      });
      await publishRuntimeEvent({
        repoPath: '/tmp/log-follow-team',
        kind: 'state',
        agent: 'outsider',
        team: 'other',
        text: 'other-event',
        source: 'registry',
      });
      const started = Date.now();
      while (received.length === 0 && Date.now() - started < 1500) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(received.some((event) => event.text === 'team-event')).toBe(true);
      expect(received.some((event) => event.text === 'other-event')).toBe(false);
      expect(handle.mode).toBe('pg');
    } finally {
      await handle.stop();
    }
  });

  test('followTeamLog works even before any team agents are registered locally', async () => {
    const received: LogEvent[] = [];
    const handle = await followTeamLog([], '/tmp/log-follow-empty-team', 'empty-team', undefined, (event) =>
      received.push(event),
    );
    try {
      await publishRuntimeEvent({
        repoPath: '/tmp/log-follow-empty-team',
        kind: 'message',
        agent: 'late-joiner',
        team: 'empty-team',
        text: 'late-team-event',
        source: 'mailbox',
      });

      const started = Date.now();
      while (received.length === 0 && Date.now() - started < 1500) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      expect(received.some((event) => event.text === 'late-team-event')).toBe(true);
      expect(handle.mode).toBe('pg');
    } finally {
      await handle.stop();
    }
  });
});

// ============================================================================
// Human-readable output
// ============================================================================

describe.skipIf(!DB_AVAILABLE)('log command: human-readable output', () => {
  test('works with PG-only follow infrastructure', async () => {
    const repo = '/tmp/log-human-readable';
    const agent = makeAgent('engineer', 'test-team', repo);

    await send(repo, 'reviewer', 'engineer', 'fix the bug');
    await postMessage(repo, 'test-team', 'engineer', 'working on it');

    const events = await readAgentLog(agent, repo);
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

// ============================================================================
// findAgent — lookup parity with `genie send` (#1302)
// ============================================================================

describe.skipIf(!DB_AVAILABLE)('findAgent: resolver parity with send', () => {
  function registerAgent(overrides: Partial<Agent> & { id: string }): Promise<void> {
    const agent: Agent = {
      paneId: 'inline',
      session: 'test',
      worktree: null,
      startedAt: new Date().toISOString(),
      state: 'suspended',
      lastStateChange: new Date().toISOString(),
      repoPath: '/tmp/find-agent-test',
      ...overrides,
    };
    return registry.register(agent);
  }

  test('resolves a native-team agent by customName (the primary #1302 bug)', async () => {
    const id = `find-agent-native-${Date.now()}`;
    await registerAgent({ id, customName: 'engineer-77', role: 'engineer', team: 'native-team' });
    try {
      const found = await findAgent('engineer-77');
      expect(found).not.toBeNull();
      expect(found?.id).toBe(id);
    } finally {
      await registry.unregister(id);
    }
  });

  test('resolves by role when customName is absent', async () => {
    const id = `find-agent-role-${Date.now()}`;
    await registerAgent({ id, role: 'solo-reviewer', team: 'role-team' });
    try {
      const found = await findAgent('solo-reviewer');
      expect(found).not.toBeNull();
      expect(found?.id).toBe(id);
    } finally {
      await registry.unregister(id);
    }
  });

  test('ambiguous prefix throws with a "did you mean" hint instead of silently returning a wrong match', async () => {
    const ts = Date.now();
    const idA = `find-agent-amb-a-${ts}`;
    const idB = `find-agent-amb-b-${ts}`;
    await registerAgent({ id: idA, customName: `alpha-a-${ts}`, team: 'amb-team' });
    await registerAgent({ id: idB, customName: `alpha-b-${ts}`, team: 'amb-team' });
    try {
      await expect(findAgent('alpha-')).rejects.toThrow(/ambiguous/i);
    } finally {
      await registry.unregister(idA);
      await registry.unregister(idB);
    }
  });

  test('returns null for an unknown identifier (no substring accidental match)', async () => {
    const id = `find-agent-none-${Date.now()}`;
    await registerAgent({ id, customName: `unique-name-${id}`, team: 'none-team' });
    try {
      // Former behavior would .includes()-match against the UUID; verify we no
      // longer fuzzy-match on ids.
      const found = await findAgent('agent-none');
      expect(found).toBeNull();
    } finally {
      await registry.unregister(id);
    }
  });

  test('team-scoped exact match is preferred over global exact match', async () => {
    const ts = Date.now();
    const idTeam = `find-agent-scope-team-${ts}`;
    const idOther = `find-agent-scope-other-${ts}`;
    await registerAgent({ id: idTeam, role: 'engineer', team: `team-${ts}` });
    await registerAgent({ id: idOther, role: 'engineer', team: `other-${ts}` });
    try {
      const found = await findAgent('engineer', `team-${ts}`);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(idTeam);
    } finally {
      await registry.unregister(idTeam);
      await registry.unregister(idOther);
    }
  });
});
