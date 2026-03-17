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
import {
  INBOX_POLL_INTERVAL_MS,
  checkInboxes,
  clearInboxWatcherPid,
  getInboxPollIntervalMs,
  getInboxWatcherPidPath,
  isProcessAlive,
  readInboxWatcherPid,
  resetSpawnFailures,
  startInboxWatcher,
  stopInboxWatcher,
  writeInboxWatcherPid,
} from './inbox-watcher.js';

// ============================================================================
// Test helpers
// ============================================================================

/** Create a minimal deps object with sensible defaults. Override as needed. */
function makeDeps(overrides: Partial<InboxWatcherDeps> = {}): InboxWatcherDeps {
  return {
    listTeamsWithUnreadInbox: async () => [],
    isTeamActive: async () => false,
    ensureTeamLead: async () => ({ created: true }),
    warn: () => {},
    ...overrides,
  };
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
      listTeamsWithUnreadInbox: async () => [{ teamName: 'alpha', unreadCount: 3, workingDir: '/tmp/alpha' }],
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
      listTeamsWithUnreadInbox: async () => [{ teamName: 'beta', unreadCount: 1, workingDir: '/tmp/beta' }],
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
      listTeamsWithUnreadInbox: async () => [{ teamName: 'crash-team', unreadCount: 2, workingDir: '/tmp/crash' }],
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
    expect(warnings.some((w) => w.includes('Skipping team "crash-team"'))).toBe(true);
  });

  test('disabled via GENIE_INBOX_POLL_MS=0 → returns empty', async () => {
    process.env.GENIE_INBOX_POLL_MS = '0';
    let spawnCalled = false;
    const deps = makeDeps({
      listTeamsWithUnreadInbox: async () => [{ teamName: 'gamma', unreadCount: 5, workingDir: '/tmp/gamma' }],
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
      listTeamsWithUnreadInbox: async () => [{ teamName: 'no-cwd', unreadCount: 1, workingDir: null }],
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
        { teamName: 'active-team', unreadCount: 2, workingDir: '/tmp/active' },
        { teamName: 'dead-team', unreadCount: 1, workingDir: '/tmp/dead' },
        { teamName: 'another-dead', unreadCount: 3, workingDir: '/tmp/another' },
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
      listTeamsWithUnreadInbox: async () => [{ teamName: 'flaky', unreadCount: 1, workingDir: '/tmp/flaky' }],
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
});

describe('startInboxWatcher', () => {
  beforeEach(() => {
    process.env.GENIE_INBOX_POLL_MS = undefined;
  });

  afterEach(() => {
    process.env.GENIE_INBOX_POLL_MS = undefined;
  });

  test('returns null when polling is disabled', () => {
    process.env.GENIE_INBOX_POLL_MS = '0';

    const handle = startInboxWatcher(makeDeps());

    expect(handle).toBeNull();
  });

  test('runs an initial poll immediately', async () => {
    let polls = 0;
    const deps = makeDeps({
      listTeamsWithUnreadInbox: async () => {
        polls++;
        return [];
      },
    });

    const handle = startInboxWatcher(deps);
    await new Promise((resolve) => setTimeout(resolve, 0));
    stopInboxWatcher(handle);

    expect(handle).not.toBeNull();
    expect(polls).toBe(1);
  });
});

// ============================================================================
// getInboxPollIntervalMs tests
// ============================================================================

describe('getInboxPollIntervalMs', () => {
  let savedPollMs: string | undefined;

  beforeEach(() => {
    savedPollMs = process.env.GENIE_INBOX_POLL_MS;
  });

  afterEach(() => {
    if (savedPollMs === undefined) {
      process.env.GENIE_INBOX_POLL_MS = undefined as unknown as string;
    } else {
      process.env.GENIE_INBOX_POLL_MS = savedPollMs;
    }
  });

  test('returns default when env var is not set', () => {
    process.env.GENIE_INBOX_POLL_MS = undefined as unknown as string;
    expect(getInboxPollIntervalMs()).toBe(INBOX_POLL_INTERVAL_MS);
  });

  test('returns 0 when env var is "0"', () => {
    process.env.GENIE_INBOX_POLL_MS = '0';
    expect(getInboxPollIntervalMs()).toBe(0);
  });

  test('returns custom value from env', () => {
    process.env.GENIE_INBOX_POLL_MS = '5000';
    expect(getInboxPollIntervalMs()).toBe(5000);
  });

  test('returns default when env var is empty string', () => {
    process.env.GENIE_INBOX_POLL_MS = '';
    expect(getInboxPollIntervalMs()).toBe(INBOX_POLL_INTERVAL_MS);
  });

  test('returns default when env var is NaN', () => {
    process.env.GENIE_INBOX_POLL_MS = 'not-a-number';
    expect(getInboxPollIntervalMs()).toBe(INBOX_POLL_INTERVAL_MS);
  });

  test('returns default when env var is negative', () => {
    process.env.GENIE_INBOX_POLL_MS = '-100';
    expect(getInboxPollIntervalMs()).toBe(INBOX_POLL_INTERVAL_MS);
  });
});

// ============================================================================
// PID file management tests
// ============================================================================

describe('PID file management', () => {
  let savedHome: string | undefined;
  let tempDir: string;

  beforeEach(async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    tempDir = await mkdtemp(join(tmpdir(), 'inbox-watcher-pid-test-'));
    savedHome = process.env.GENIE_HOME;
    process.env.GENIE_HOME = join(tempDir, '.genie');
  });

  afterEach(async () => {
    if (savedHome === undefined) {
      process.env.GENIE_HOME = undefined as unknown as string;
    } else {
      process.env.GENIE_HOME = savedHome;
    }
    const { rm } = await import('node:fs/promises');
    await rm(tempDir, { recursive: true, force: true });
  });

  test('getInboxWatcherPidPath returns path under GENIE_HOME', () => {
    const pidPath = getInboxWatcherPidPath();
    expect(pidPath).toContain(tempDir);
    expect(pidPath).toEndWith('inbox-watcher.pid');
  });

  test('writeInboxWatcherPid creates the pid file', async () => {
    await writeInboxWatcherPid(12345);
    const pid = await readInboxWatcherPid();
    expect(pid).toBe(12345);
  });

  test('writeInboxWatcherPid defaults to process.pid', async () => {
    await writeInboxWatcherPid();
    const pid = await readInboxWatcherPid();
    expect(pid).toBe(process.pid);
  });

  test('readInboxWatcherPid returns null when file does not exist', async () => {
    const pid = await readInboxWatcherPid();
    expect(pid).toBeNull();
  });

  test('readInboxWatcherPid returns null for invalid content', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    const pidPath = getInboxWatcherPidPath();
    await mkdir(dirname(pidPath), { recursive: true });
    await writeFile(pidPath, 'not-a-pid\n');
    const pid = await readInboxWatcherPid();
    expect(pid).toBeNull();
  });

  test('clearInboxWatcherPid removes the file when pid matches', async () => {
    await writeInboxWatcherPid(99999);
    await clearInboxWatcherPid(99999);
    const pid = await readInboxWatcherPid();
    expect(pid).toBeNull();
  });

  test('clearInboxWatcherPid does not remove the file when pid does not match', async () => {
    await writeInboxWatcherPid(11111);
    await clearInboxWatcherPid(22222);
    const pid = await readInboxWatcherPid();
    expect(pid).toBe(11111);
  });

  test('clearInboxWatcherPid is safe when file does not exist', async () => {
    // Should not throw
    await clearInboxWatcherPid(12345);
  });
});

// ============================================================================
// isProcessAlive tests
// ============================================================================

describe('isProcessAlive', () => {
  test('returns true for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test('returns false for a non-existent PID', () => {
    // PID 2147483647 is max int32, very unlikely to be alive
    expect(isProcessAlive(2147483647)).toBe(false);
  });
});

// ============================================================================
// stopInboxWatcher edge cases
// ============================================================================

describe('stopInboxWatcher', () => {
  test('handles null handle gracefully', () => {
    // Should not throw
    stopInboxWatcher(null);
  });
});
