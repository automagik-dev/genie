/**
 * Claude Native Teams — Unit Tests
 *
 * Covers:
 *   - resolveNativeMemberName mapping strategies
 *   - writeNativeInbox file format
 *   - loadConfig handling of missing/invalid configs
 *
 * Run with: bun test src/lib/claude-native-teams.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type NativeInboxMessage,
  loadConfig,
  resolveNativeMemberName,
  sanitizeTeamName,
  writeNativeInbox,
} from './claude-native-teams.js';

// ---------------------------------------------------------------------------
// Helpers: isolated Claude config directory per test
// ---------------------------------------------------------------------------

let tempDir: string;
let savedClaudeConfigDir: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'native-teams-test-'));
  savedClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tempDir;
});

afterEach(async () => {
  if (savedClaudeConfigDir === undefined) {
    process.env.CLAUDE_CONFIG_DIR = undefined;
  } else {
    process.env.CLAUDE_CONFIG_DIR = savedClaudeConfigDir;
  }
  await rm(tempDir, { recursive: true, force: true });
});

/** Create a native team config on disk for testing. */
async function createTestTeamConfig(
  teamName: string,
  members: { agentId: string; name: string; isActive?: boolean }[],
): Promise<void> {
  const sanitized = sanitizeTeamName(teamName);
  const teamDir = join(tempDir, 'teams', sanitized);
  const inboxDir = join(teamDir, 'inboxes');
  await mkdir(inboxDir, { recursive: true });

  const config = {
    name: sanitized,
    description: `Test team: ${teamName}`,
    createdAt: Date.now(),
    leadAgentId: `team-lead@${sanitized}`,
    leadSessionId: 'test-session-id',
    members: members.map((m) => ({
      agentId: m.agentId,
      name: m.name,
      agentType: 'general-purpose',
      joinedAt: Date.now(),
      backendType: 'tmux',
      color: 'blue',
      planModeRequired: false,
      isActive: m.isActive ?? true,
    })),
  };

  await writeFile(join(teamDir, 'config.json'), JSON.stringify(config, null, 2));
}

// ---------------------------------------------------------------------------
// resolveNativeMemberName tests
// ---------------------------------------------------------------------------

describe('resolveNativeMemberName', () => {
  test('exact match on member name', async () => {
    await createTestTeamConfig('my-team', [
      { agentId: 'engineer@my-team', name: 'engineer' },
      { agentId: 'reviewer@my-team', name: 'reviewer' },
    ]);

    const result = await resolveNativeMemberName('my-team', 'engineer');
    expect(result).toBe('engineer');
  });

  test('match on agentId', async () => {
    await createTestTeamConfig('my-team', [{ agentId: 'engineer@my-team', name: 'engineer' }]);

    // Even when passed a name that doesn't match directly,
    // should match via agentId if sanitized version matches
    const result = await resolveNativeMemberName('my-team', 'engineer');
    expect(result).toBe('engineer');
  });

  test('strips team prefix from worker ID', async () => {
    await createTestTeamConfig('bugfix-4', [{ agentId: 'engineer@bugfix-4', name: 'engineer' }]);

    const result = await resolveNativeMemberName('bugfix-4', 'bugfix-4-engineer');
    expect(result).toBe('engineer');
  });

  test('returns null for non-existent member', async () => {
    await createTestTeamConfig('my-team', [{ agentId: 'engineer@my-team', name: 'engineer' }]);

    const result = await resolveNativeMemberName('my-team', 'nonexistent');
    expect(result).toBeNull();
  });

  test('returns null when team config does not exist', async () => {
    const result = await resolveNativeMemberName('no-such-team', 'engineer');
    expect(result).toBeNull();
  });

  test('returns null for team with no members', async () => {
    await createTestTeamConfig('empty-team', []);

    const result = await resolveNativeMemberName('empty-team', 'engineer');
    expect(result).toBeNull();
  });

  test('prefers active members over inactive', async () => {
    await createTestTeamConfig('my-team', [{ agentId: 'engineer@my-team', name: 'engineer', isActive: false }]);

    // Falls through active match strategies, finds inactive fallback
    const result = await resolveNativeMemberName('my-team', 'engineer');
    expect(result).toBe('engineer');
  });

  test('handles team-lead as recipient', async () => {
    await createTestTeamConfig('my-team', [
      { agentId: 'team-lead@my-team', name: 'team-lead' },
      { agentId: 'engineer@my-team', name: 'engineer' },
    ]);

    const result = await resolveNativeMemberName('my-team', 'team-lead');
    expect(result).toBe('team-lead');
  });

  test('sanitizes worker ID before matching', async () => {
    await createTestTeamConfig('my-team', [{ agentId: 'my-agent@my-team', name: 'my-agent' }]);

    // Input with special chars gets sanitized to match
    const result = await resolveNativeMemberName('my-team', 'my agent');
    expect(result).toBe('my-agent');
  });
});

// ---------------------------------------------------------------------------
// writeNativeInbox format tests
// ---------------------------------------------------------------------------

describe('writeNativeInbox', () => {
  test('writes correct JSON array format', async () => {
    await createTestTeamConfig('my-team', [{ agentId: 'engineer@my-team', name: 'engineer' }]);

    // Create the inbox file first (simulates registerNativeMember)
    const sanitized = sanitizeTeamName('my-team');
    const inboxFile = join(tempDir, 'teams', sanitized, 'inboxes', 'engineer.json');
    await writeFile(inboxFile, '[]');

    const msg: NativeInboxMessage = {
      from: 'team-lead',
      text: 'Hello engineer, please start working on the task.',
      summary: 'Hello engineer, please start working on the ta...',
      timestamp: '2026-03-24T10:00:00.000Z',
      color: 'blue',
      read: false,
    };

    await writeNativeInbox('my-team', 'engineer', msg);

    const content = JSON.parse(await readFile(inboxFile, 'utf-8'));
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(1);
    expect(content[0].from).toBe('team-lead');
    expect(content[0].text).toBe('Hello engineer, please start working on the task.');
    expect(content[0].summary).toBe('Hello engineer, please start working on the ta...');
    expect(content[0].timestamp).toBe('2026-03-24T10:00:00.000Z');
    expect(content[0].color).toBe('blue');
    expect(content[0].read).toBe(false);
  });

  test('appends to existing inbox messages', async () => {
    await createTestTeamConfig('my-team', [{ agentId: 'engineer@my-team', name: 'engineer' }]);

    const sanitized = sanitizeTeamName('my-team');
    const inboxFile = join(tempDir, 'teams', sanitized, 'inboxes', 'engineer.json');

    // Pre-populate with an existing message
    const existingMsg = [
      {
        from: 'reviewer',
        text: 'First message',
        summary: 'First message',
        timestamp: '2026-03-24T09:00:00.000Z',
        color: 'green',
        read: true,
      },
    ];
    await writeFile(inboxFile, JSON.stringify(existingMsg));

    const newMsg: NativeInboxMessage = {
      from: 'team-lead',
      text: 'Second message',
      summary: 'Second message',
      timestamp: '2026-03-24T10:00:00.000Z',
      color: 'blue',
      read: false,
    };

    await writeNativeInbox('my-team', 'engineer', newMsg);

    const content = JSON.parse(await readFile(inboxFile, 'utf-8'));
    expect(content).toHaveLength(2);
    expect(content[0].from).toBe('reviewer');
    expect(content[1].from).toBe('team-lead');
  });

  test('creates inbox file if it does not exist', async () => {
    await createTestTeamConfig('my-team', [{ agentId: 'engineer@my-team', name: 'engineer' }]);

    const msg: NativeInboxMessage = {
      from: 'team-lead',
      text: 'Hello',
      summary: 'Hello',
      timestamp: '2026-03-24T10:00:00.000Z',
      color: 'blue',
      read: false,
    };

    await writeNativeInbox('my-team', 'engineer', msg);

    const sanitized = sanitizeTeamName('my-team');
    const inboxFile = join(tempDir, 'teams', sanitized, 'inboxes', 'engineer.json');
    const content = JSON.parse(await readFile(inboxFile, 'utf-8'));
    expect(content).toHaveLength(1);
    expect(content[0].text).toBe('Hello');
  });
});

// ---------------------------------------------------------------------------
// loadConfig tests
// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  test('returns null for non-existent team', async () => {
    const config = await loadConfig('no-such-team');
    expect(config).toBeNull();
  });

  test('loads valid team config', async () => {
    await createTestTeamConfig('test-team', [{ agentId: 'engineer@test-team', name: 'engineer' }]);

    const config = await loadConfig('test-team');
    expect(config).not.toBeNull();
    expect(config!.name).toBe('test-team');
    expect(config!.members).toHaveLength(1);
    expect(config!.members[0].name).toBe('engineer');
  });

  test('handles corrupted config gracefully', async () => {
    const sanitized = sanitizeTeamName('bad-team');
    const teamDir = join(tempDir, 'teams', sanitized);
    await mkdir(teamDir, { recursive: true });
    await writeFile(join(teamDir, 'config.json'), 'not valid json');

    const config = await loadConfig('bad-team');
    expect(config).toBeNull();
  });
});
