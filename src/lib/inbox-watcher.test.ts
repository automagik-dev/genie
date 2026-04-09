/**
 * Tests for inbox-watcher module
 *
 * Tests the inbox polling logic using dependency injection —
 * no real tmux, filesystem, or Claude Code sessions required.
 *
 * Run with: bun test src/lib/inbox-watcher.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { InboxWatcherDeps } from './inbox-watcher.js';
import { checkInboxes, resetSpawnFailures } from './inbox-watcher.js';

// ============================================================================
// Test helpers
// ============================================================================

/** Create a minimal deps object with sensible defaults. Override as needed. */
function makeDeps(overrides: Partial<InboxWatcherDeps> = {}): InboxWatcherDeps {
  return {
    listTeamsWithUnreadInbox: async () => [],
    isTeamActive: async () => false,
    isAgentAlive: async () => false,
    ensureTeamLead: async () => ({ created: true }),
    warn: () => {},
    ...overrides,
  } as InboxWatcherDeps;
}

// ============================================================================
// checkInboxes tests
// ============================================================================

describe('checkInboxes', () => {
  beforeEach(() => {
    resetSpawnFailures();
    process.env.GENIE_INBOX_POLL_MS = undefined;
  });

  afterEach(() => {
    process.env.GENIE_INBOX_POLL_MS = undefined;
  });

  test('no teams → returns empty', async () => {
    const deps = makeDeps();
    const result = await checkInboxes(deps);
    expect(result).toEqual([]);
  });

  test('team with unread messages + active team-lead → no spawn triggered', async () => {
    let spawnCalled = false;
    const deps = makeDeps({
      listTeamsWithUnreadInbox: async () => [
        { teamName: 'alpha', unreadCount: 3, workingDir: '/tmp/alpha', firstUnreadText: null },
      ],
      isTeamActive: async () => true,
      ensureTeamLead: async () => {
        spawnCalled = true;
        return { created: true };
      },
    });
    const result = await checkInboxes(deps);
    expect(result).toEqual([]);
    expect(spawnCalled).toBe(false);
  });

  test('team with unread messages + inactive team-lead → spawn triggered', async () => {
    let spawnedTeam = '';
    let spawnedDir = '';
    const deps = makeDeps({
      listTeamsWithUnreadInbox: async () => [
        { teamName: 'beta', unreadCount: 1, workingDir: '/tmp/beta', firstUnreadText: null },
      ],
      isTeamActive: async () => false,
      ensureTeamLead: async (teamName, workingDir) => {
        spawnedTeam = teamName;
        spawnedDir = workingDir;
        return { created: true };
      },
    });
    const result = await checkInboxes(deps);
    expect(result).toEqual(['beta']);
    expect(spawnedTeam).toBe('beta');
    expect(spawnedDir).toBe('/tmp/beta');
  });

  test('3 consecutive spawn failures → team skipped with warning', async () => {
    const warnings: string[] = [];
    let spawnAttempts = 0;
    const deps = makeDeps({
      listTeamsWithUnreadInbox: async () => [
        { teamName: 'crash-team', unreadCount: 2, workingDir: '/tmp/crash', firstUnreadText: null },
      ],
      isTeamActive: async () => false,
      ensureTeamLead: async () => {
        spawnAttempts++;
        throw new Error('spawn failed');
      },
      warn: (msg) => warnings.push(msg),
    });

    // First 3 calls: each triggers a spawn attempt that fails
    await checkInboxes(deps);
    expect(spawnAttempts).toBe(1);

    await checkInboxes(deps);
    expect(spawnAttempts).toBe(2);

    await checkInboxes(deps);
    expect(spawnAttempts).toBe(3);

    // 4th call: team is skipped (no more spawn attempts)
    const result = await checkInboxes(deps);
    expect(spawnAttempts).toBe(3); // No new attempt
    expect(result).toEqual([]);
    expect(warnings.some((w) => w.includes('Skipping "crash-team"'))).toBe(true);
  });

  test('disabled via GENIE_INBOX_POLL_MS=0 → returns empty', async () => {
    process.env.GENIE_INBOX_POLL_MS = '0';
    let spawnCalled = false;
    const deps = makeDeps({
      listTeamsWithUnreadInbox: async () => [
        { teamName: 'gamma', unreadCount: 5, workingDir: '/tmp/gamma', firstUnreadText: null },
      ],
      ensureTeamLead: async () => {
        spawnCalled = true;
        return { created: true };
      },
    });
    const result = await checkInboxes(deps);
    expect(result).toEqual([]);
    expect(spawnCalled).toBe(false);
  });

  test('team with no workingDir → skipped with warning', async () => {
    const warnings: string[] = [];
    const deps = makeDeps({
      listTeamsWithUnreadInbox: async () => [
        { teamName: 'no-cwd', unreadCount: 1, workingDir: null, firstUnreadText: null },
      ],
      isTeamActive: async () => false,
      warn: (msg) => warnings.push(msg),
    });
    const result = await checkInboxes(deps);
    expect(result).toEqual([]);
    expect(warnings.some((w) => w.includes('no workingDir'))).toBe(true);
  });

  test('multiple teams — spawns only inactive ones', async () => {
    const spawned: string[] = [];
    const deps = makeDeps({
      listTeamsWithUnreadInbox: async () => [
        { teamName: 'active-team', unreadCount: 2, workingDir: '/tmp/active', firstUnreadText: null },
        { teamName: 'dead-team', unreadCount: 1, workingDir: '/tmp/dead', firstUnreadText: null },
        { teamName: 'another-dead', unreadCount: 3, workingDir: '/tmp/another', firstUnreadText: null },
      ],
      isTeamActive: async (teamName) => teamName === 'active-team',
      ensureTeamLead: async (teamName) => {
        spawned.push(teamName);
        return { created: true };
      },
    });
    const result = await checkInboxes(deps);
    expect(result).toEqual(['dead-team', 'another-dead']);
    expect(spawned).toEqual(['dead-team', 'another-dead']);
  });

  test('successful spawn resets failure count', async () => {
    let attempt = 0;
    const deps = makeDeps({
      listTeamsWithUnreadInbox: async () => [
        { teamName: 'flaky', unreadCount: 1, workingDir: '/tmp/flaky', firstUnreadText: null },
      ],
      isTeamActive: async () => false,
      ensureTeamLead: async () => {
        attempt++;
        if (attempt <= 2) throw new Error('transient failure');
        return { created: true };
      },
      warn: () => {},
    });

    // Two failures
    await checkInboxes(deps);
    await checkInboxes(deps);

    // Third attempt succeeds — count resets
    const result = await checkInboxes(deps);
    expect(result).toEqual(['flaky']);

    // Next failure starts fresh (not at 2+1=3)
    await checkInboxes(deps);
    // Should still try (only 1 failure after reset)
    expect(attempt).toBe(4);
  });

  test('routing header in message → session key used for backoff tracking', async () => {
    const warnings: string[] = [];
    let spawnAttempts = 0;
    const routingHeader =
      '[channel:whatsapp-baileys instance:inst1 chat:5511999@s.whatsapp.net msg:msg1 from:John type:dm]';
    const deps = makeDeps({
      listTeamsWithUnreadInbox: async () => [
        {
          teamName: 'routed-team',
          unreadCount: 1,
          workingDir: '/tmp/routed',
          firstUnreadText: `${routingHeader}\nHello world`,
        },
      ],
      isTeamActive: async () => false,
      ensureTeamLead: async () => {
        spawnAttempts++;
        throw new Error('spawn failed');
      },
      warn: (msg) => warnings.push(msg),
    });

    // Fail 3 times
    await checkInboxes(deps);
    await checkInboxes(deps);
    await checkInboxes(deps);
    expect(spawnAttempts).toBe(3);

    // 4th call should be skipped — the session key (not raw team name) is tracked
    await checkInboxes(deps);
    expect(spawnAttempts).toBe(3);
    // Warning should reference the session key, not just the team name
    expect(warnings.some((w) => w.includes('Skipping "routed-team-'))).toBe(true);
  });

  test('message without routing header → falls back to team name', async () => {
    let spawnedTeam = '';
    const deps = makeDeps({
      listTeamsWithUnreadInbox: async () => [
        {
          teamName: 'plain-team',
          unreadCount: 1,
          workingDir: '/tmp/plain',
          firstUnreadText: 'Just a regular message without routing header',
        },
      ],
      isTeamActive: async () => false,
      ensureTeamLead: async (teamName) => {
        spawnedTeam = teamName;
        return { created: true };
      },
    });
    const result = await checkInboxes(deps);
    expect(result).toEqual(['plain-team']);
    expect(spawnedTeam).toBe('plain-team');
  });
});
