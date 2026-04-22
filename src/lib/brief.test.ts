import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Brief, formatBrief } from './brief.js';
import { DB_AVAILABLE, setupTestDatabase } from './test-db.js';

let cleanup: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (!DB_AVAILABLE) return;
  cleanup = await setupTestDatabase();
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

describe('formatBrief', () => {
  test('formats an empty brief', () => {
    const brief: Brief = {
      team: 'test-team',
      agent: 'engineer-1',
      since: '2026-03-28T00:00:00.000Z',
      unreadMessages: [],
      taskMessages: [],
      recentEvents: [],
      pendingRequests: [],
      teamRoster: [],
    };

    const output = formatBrief(brief);
    expect(output).toContain('# BRIEF — test-team engineer-1');
    expect(output).toContain('No activity since last session');
  });

  test('formats brief with unread messages', () => {
    const brief: Brief = {
      team: 'test-team',
      agent: 'team-lead',
      since: '2026-03-28T00:00:00.000Z',
      unreadMessages: [
        {
          id: 'msg-1',
          from: 'engineer-3',
          to: 'team-lead',
          body: 'Group 3 complete — types defined',
          createdAt: '2026-03-28T14:26:00.000Z',
          read: false,
          deliveredAt: null,
        },
        {
          id: 'msg-2',
          from: 'engineer-5',
          to: 'team-lead',
          body: 'Group 5 blocked — needs env var',
          createdAt: '2026-03-28T14:30:00.000Z',
          read: false,
          deliveredAt: null,
        },
      ],
      taskMessages: [],
      recentEvents: [],
      pendingRequests: [],
      teamRoster: [],
    };

    const output = formatBrief(brief);
    expect(output).toContain('## Unread Messages (2)');
    expect(output).toContain('**engineer-3**');
    expect(output).toContain('Group 3 complete');
  });

  test('formats brief with pending requests', () => {
    const brief: Brief = {
      team: 'test-team',
      agent: null,
      since: '2026-03-28T00:00:00.000Z',
      unreadMessages: [],
      taskMessages: [],
      recentEvents: [],
      pendingRequests: [
        {
          id: 'req-1',
          requestType: 'env',
          senderId: 'engineer-3',
          body: 'Need STRIPE_API_KEY for payment processing',
          createdAt: '2026-03-28T14:25:00.000Z',
        },
      ],
      teamRoster: [],
    };

    const output = formatBrief(brief);
    expect(output).toContain('## Pending Requests (1)');
    expect(output).toContain('[env]');
    expect(output).toContain('engineer-3');
  });

  test('formats brief with team roster', () => {
    const brief: Brief = {
      team: 'test-team',
      agent: null,
      since: '2026-03-28T00:00:00.000Z',
      unreadMessages: [],
      taskMessages: [],
      recentEvents: [],
      pendingRequests: [],
      teamRoster: [
        { agentId: 'engineer-3', role: 'engineer', executorState: 'idle', executorStartedAt: '2026-03-28T14:00:00Z' },
        { agentId: 'engineer-5', role: 'engineer', executorState: 'error', executorStartedAt: '2026-03-28T14:00:00Z' },
        {
          agentId: 'engineer-7',
          role: 'engineer',
          executorState: 'working',
          executorStartedAt: '2026-03-28T14:10:00Z',
        },
        { agentId: 'reviewer', role: 'reviewer', executorState: null, executorStartedAt: null },
      ],
    };

    const output = formatBrief(brief);
    expect(output).toContain('## Team Roster (4)');
    expect(output).toContain('○ **engineer-3**');
    expect(output).toContain('✘ **engineer-5**');
    expect(output).toContain('● **engineer-7**');
    expect(output).toContain('◌ **reviewer**');
  });

  test('formats brief with recent events (truncated to last 10)', () => {
    const events = Array.from({ length: 15 }, (_, i) => ({
      id: i + 1,
      repoPath: '/tmp/test',
      timestamp: `2026-03-28T14:${String(i).padStart(2, '0')}:00.000Z`,
      kind: 'tool_call' as const,
      agent: `eng-${i}`,
      text: `Event number ${i}`,
      source: 'hook' as const,
    }));

    const brief: Brief = {
      team: 'test-team',
      agent: null,
      since: '2026-03-28T00:00:00.000Z',
      unreadMessages: [],
      taskMessages: [],
      recentEvents: events,
      pendingRequests: [],
      teamRoster: [],
    };

    const output = formatBrief(brief);
    expect(output).toContain('## Recent Events (15)');
    expect(output).toContain('5 more events');
    expect(output).toContain('Event number 14'); // last event shown
  });
});
