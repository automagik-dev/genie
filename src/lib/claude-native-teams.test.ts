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
import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type NativeInboxMessage,
  discoverClaudeParentSessionId,
  discoverTeamName,
  ensureNativeTeamWithSessionId,
  findTeamsContainingAgent,
  listTeamsWithUnreadInbox,
  loadConfig,
  resolveNativeMemberName,
  sanitizeTeamName,
  unregisterNativeMember,
  writeNativeInbox,
} from './claude-native-teams.js';

// ---------------------------------------------------------------------------
// Helpers: isolated Claude config directory per test
// ---------------------------------------------------------------------------

let tempDir: string;
let savedClaudeConfigDir: string | undefined;
let savedClaudeSessionId: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'native-teams-test-'));
  savedClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  savedClaudeSessionId = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CONFIG_DIR = tempDir;
  process.env.CLAUDE_CODE_SESSION_ID = undefined;
});

afterEach(async () => {
  if (savedClaudeConfigDir === undefined) {
    process.env.CLAUDE_CONFIG_DIR = undefined;
  } else {
    process.env.CLAUDE_CONFIG_DIR = savedClaudeConfigDir;
  }
  if (savedClaudeSessionId === undefined) {
    process.env.CLAUDE_CODE_SESSION_ID = undefined;
  } else {
    process.env.CLAUDE_CODE_SESSION_ID = savedClaudeSessionId;
  }
  await rm(tempDir, { recursive: true, force: true });
});

/** Create a native team config on disk for testing. */
async function createTestTeamConfig(
  teamName: string,
  members: { agentId: string; name: string; isActive?: boolean }[],
  options?: { leadSessionId?: string },
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
    leadSessionId: options?.leadSessionId ?? 'test-session-id',
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

async function createSessionJsonl(cwd: string, sessionId: string, lines: unknown[], mtimeMs: number): Promise<void> {
  const projectDir = join(tempDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(projectDir, { recursive: true });
  const filePath = join(projectDir, `${sessionId}.jsonl`);
  await writeFile(filePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  const date = new Date(mtimeMs);
  await utimes(filePath, date, date);
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

describe('discoverClaudeParentSessionId', () => {
  test('returns env session when CLAUDE_CODE_SESSION_ID is set', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'env-session-id';
    const result = await discoverClaudeParentSessionId('/repo');
    expect(result).toBe('env-session-id');
  });

  test('prefers newest root session over newer worker session', async () => {
    const cwd = '/repo';

    await createSessionJsonl(
      cwd,
      'root-session',
      [
        {
          type: 'user',
          entrypoint: 'sdk-cli',
          cwd,
          sessionId: 'root-session',
        },
      ],
      1_000,
    );

    await createSessionJsonl(
      cwd,
      'worker-session',
      [
        {
          type: 'user',
          teamName: 'qa-probe',
          agentName: 'probe',
          cwd,
          sessionId: 'worker-session',
        },
      ],
      2_000,
    );

    const result = await discoverClaudeParentSessionId(cwd);
    expect(result).toBe('root-session');
  });

  test('falls back to newest team-lead session when no root session exists', async () => {
    const cwd = '/repo';

    await createSessionJsonl(
      cwd,
      'engineer-session',
      [
        {
          type: 'user',
          teamName: 'alpha',
          agentName: 'engineer',
          cwd,
          sessionId: 'engineer-session',
        },
      ],
      1_000,
    );

    await createSessionJsonl(
      cwd,
      'lead-session',
      [
        {
          type: 'user',
          teamName: 'alpha',
          agentName: 'team-lead',
          cwd,
          sessionId: 'lead-session',
        },
      ],
      2_000,
    );

    const result = await discoverClaudeParentSessionId(cwd);
    expect(result).toBe('lead-session');
  });

  test('prefers a historically reused lead session over a newer root candidate', async () => {
    const cwd = '/repo';

    await createTestTeamConfig('alpha', [{ agentId: 'team-lead@alpha', name: 'team-lead' }], {
      leadSessionId: 'historical-lead',
    });

    await createTestTeamConfig('beta', [{ agentId: 'team-lead@beta', name: 'team-lead' }], {
      leadSessionId: 'historical-lead',
    });

    await createSessionJsonl(
      cwd,
      'historical-lead',
      [
        {
          type: 'user',
          cwd,
          sessionId: 'historical-lead',
        },
      ],
      1_000,
    );

    await createSessionJsonl(
      cwd,
      'new-root',
      [
        {
          type: 'user',
          cwd,
          sessionId: 'new-root',
        },
      ],
      2_000,
    );

    const result = await discoverClaudeParentSessionId(cwd);
    expect(result).toBe('historical-lead');
  });
});

// ---------------------------------------------------------------------------
// unregisterNativeMember — removes entry from members array
// See automagik-dev/genie#1179: prior impl marked isActive=false and left
// stale entries in the config, which silently routed new spawns and messages
// to dead workers via resolveNativeMemberName and findTeamsContainingAgent.
// ---------------------------------------------------------------------------

describe('unregisterNativeMember', () => {
  test('removes the member entry entirely (not just isActive flip)', async () => {
    await createTestTeamConfig('my-team', [
      { agentId: 'engineer@my-team', name: 'engineer' },
      { agentId: 'reviewer@my-team', name: 'reviewer' },
    ]);

    await unregisterNativeMember('my-team', 'engineer');

    const config = await loadConfig('my-team');
    expect(config).not.toBeNull();
    expect(config!.members).toHaveLength(1);
    expect(config!.members[0].name).toBe('reviewer');
    expect(config!.members.some((m) => m.name === 'engineer')).toBe(false);
  });

  test('is a no-op when the member does not exist', async () => {
    await createTestTeamConfig('my-team', [{ agentId: 'engineer@my-team', name: 'engineer' }]);

    await unregisterNativeMember('my-team', 'nonexistent');

    const config = await loadConfig('my-team');
    expect(config!.members).toHaveLength(1);
    expect(config!.members[0].name).toBe('engineer');
  });

  test('is a no-op when the team does not exist', async () => {
    // Should not throw; should not create the config.
    await expect(unregisterNativeMember('nonexistent-team', 'engineer')).resolves.toBeUndefined();
    const config = await loadConfig('nonexistent-team');
    expect(config).toBeNull();
  });

  test('findTeamsContainingAgent stops matching after unregister (regression)', async () => {
    // Reproducer for #1179: before the fix, an unregistered member still
    // matched `findTeamsContainingAgent`, routing spawn-team resolution to
    // the wrong team.
    await createTestTeamConfig('team-a', [{ agentId: 'simone@team-a', name: 'simone' }]);
    await createTestTeamConfig('team-b', [{ agentId: 'simone@team-b', name: 'simone' }]);

    expect(await findTeamsContainingAgent('simone')).toEqual(expect.arrayContaining(['team-a', 'team-b']));

    await unregisterNativeMember('team-a', 'simone');

    const matches = await findTeamsContainingAgent('simone');
    expect(matches).toEqual(['team-b']);
  });

  test('resolveNativeMemberName stops resolving after unregister (regression)', async () => {
    // Before the fix, the active→inactive fallback in resolveNativeMemberName
    // would still return the unregistered member's name, causing messages
    // addressed to that name to be silently delivered to a dead worker.
    await createTestTeamConfig('my-team', [{ agentId: 'engineer@my-team', name: 'engineer' }]);

    expect(await resolveNativeMemberName('my-team', 'engineer')).toBe('engineer');

    await unregisterNativeMember('my-team', 'engineer');

    expect(await resolveNativeMemberName('my-team', 'engineer')).toBeNull();
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

// ---------------------------------------------------------------------------
// ensureNativeTeamWithSessionId tests (fix-ghost-approval-p0)
// ---------------------------------------------------------------------------

describe('ensureNativeTeamWithSessionId', () => {
  const FRESH_UUID = 'abcd1234-abcd-1234-abcd-1234abcd1234';

  test('creates a new team with the provided session UUID', async () => {
    const config = await ensureNativeTeamWithSessionId('new-team', 'Test', FRESH_UUID, 'new-team');
    expect(config.leadSessionId).toBe(FRESH_UUID);

    const loaded = await loadConfig('new-team');
    expect(loaded?.leadSessionId).toBe(FRESH_UUID);
  });

  test('leaves a healthy UUID alone on an existing config', async () => {
    const existingUuid = 'deadbeef-dead-beef-dead-beefdeadbeef';
    await createTestTeamConfig('healthy-team', [{ agentId: 'engineer@healthy-team', name: 'engineer' }], {
      leadSessionId: existingUuid,
    });

    const config = await ensureNativeTeamWithSessionId('healthy-team', 'Test', FRESH_UUID);
    expect(config.leadSessionId).toBe(existingUuid);

    const loaded = await loadConfig('healthy-team');
    expect(loaded?.leadSessionId).toBe(existingUuid);
  });

  test('upserts a stale "pending" literal in place', async () => {
    await createTestTeamConfig('stale-team', [{ agentId: 'engineer@stale-team', name: 'engineer' }], {
      leadSessionId: 'pending',
    });

    const config = await ensureNativeTeamWithSessionId('stale-team', 'Test', FRESH_UUID);
    expect(config.leadSessionId).toBe(FRESH_UUID);

    // Verify persisted to disk — this is the healing path for existing machines.
    const loaded = await loadConfig('stale-team');
    expect(loaded?.leadSessionId).toBe(FRESH_UUID);
  });

  test('upserts an empty-string leadSessionId in place', async () => {
    await createTestTeamConfig('empty-team', [{ agentId: 'engineer@empty-team', name: 'engineer' }], {
      leadSessionId: '',
    });

    const config = await ensureNativeTeamWithSessionId('empty-team', 'Test', FRESH_UUID);
    expect(config.leadSessionId).toBe(FRESH_UUID);
  });

  test('upserts a synthetic "genie-<team>" fallback in place', async () => {
    await createTestTeamConfig('synthetic-team', [{ agentId: 'engineer@synthetic-team', name: 'engineer' }], {
      leadSessionId: 'genie-synthetic-team',
    });

    const config = await ensureNativeTeamWithSessionId('synthetic-team', 'Test', FRESH_UUID);
    expect(config.leadSessionId).toBe(FRESH_UUID);
  });
});

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

describe('discoverTeamName', () => {
  let savedTmux: string | undefined;
  let savedGenieTeam: string | undefined;

  beforeEach(() => {
    savedTmux = process.env.TMUX;
    savedGenieTeam = process.env.GENIE_TEAM;
    process.env.TMUX = undefined;
    process.env.GENIE_TEAM = undefined;
  });

  afterEach(() => {
    if (savedTmux === undefined) process.env.TMUX = undefined;
    else process.env.TMUX = savedTmux;
    if (savedGenieTeam === undefined) process.env.GENIE_TEAM = undefined;
    else process.env.GENIE_TEAM = savedGenieTeam;
  });

  test('returns GENIE_TEAM env var when set', async () => {
    process.env.GENIE_TEAM = 'explicit-team';
    const result = await discoverTeamName('/repo');
    expect(result).toBe('explicit-team');
  });

  test('matches team by leadSessionId', async () => {
    const cwd = '/repo/x';
    await createTestTeamConfig('match-team', [{ agentId: 'a@match-team', name: 'a' }], {
      leadSessionId: 'session-xyz',
    });
    await createSessionJsonl(cwd, 'session-xyz', [{ type: 'user', cwd }], 1_000);

    const result = await discoverTeamName(cwd);
    expect(result).toBe('match-team');
  });

  test('returns null when no session and TMUX unset', async () => {
    // No matching JSONL, no TMUX — both discovery paths yield null.
    const result = await discoverTeamName('/repo/nonexistent');
    expect(result).toBeNull();
  });

  test('tmux fallback is skipped when TMUX env is absent', async () => {
    // Team config exists on disk with matching NAME, but there's no
    // leadSessionId match AND no TMUX env → fallback must not run,
    // so result stays null. Regression guard against spuriously
    // matching by name when not inside a tmux session.
    await createTestTeamConfig('standalone-team', [{ agentId: 'a@standalone-team', name: 'a' }], {
      leadSessionId: 'some-other-session',
    });
    const result = await discoverTeamName('/repo/no-jsonl-here');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findTeamsContainingAgent tests — the spawn-fallback scan relied on by
// `resolveTeamAndResume` when GENIE_TEAM and parent-session context are both
// missing. Guards against regressions in the agent-name vs agent-type match
// and the no-match path that must fail closed (so callers can decide whether
// to auto-create a team-of-one or surface the --team-is-required error).
// ---------------------------------------------------------------------------

describe('findTeamsContainingAgent', () => {
  test('returns an empty array when no team lists the agent', async () => {
    await createTestTeamConfig('team-alpha', [{ agentId: 'other@team-alpha', name: 'other' }]);
    const result = await findTeamsContainingAgent('khal-os');
    expect(result).toEqual([]);
  });

  test('returns the team when the agent is a member by name', async () => {
    await createTestTeamConfig('team-bravo', [{ agentId: 'khal-os@team-bravo', name: 'khal-os' }]);
    const result = await findTeamsContainingAgent('khal-os');
    expect(result).toEqual(['team-bravo']);
  });

  test('returns every team listing the agent when multiple ghost teams exist', async () => {
    await createTestTeamConfig('team-gamma', [{ agentId: 'khal-os@team-gamma', name: 'khal-os' }]);
    await createTestTeamConfig('team-delta', [{ agentId: 'khal-os@team-delta', name: 'khal-os' }]);
    const result = (await findTeamsContainingAgent('khal-os')).sort();
    expect(result).toEqual(['team-delta', 'team-gamma']);
  });

  test('returns empty array when teams dir does not exist', async () => {
    // Fresh tempDir with no teams/ subdir — mirrors a pristine server where
    // no team config has ever been written.
    const result = await findTeamsContainingAgent('khal-os');
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listTeamsWithUnreadInbox — workingDir resolution
//
// Regression coverage for the inbox-watcher spawn-blocker where
// council/solo teams that leave members[] empty (or without a distinct
// lead entry) emitted:
//   [inbox-watcher] Cannot spawn team-lead for "council-…" — no workingDir in config
// because `scanTeamInbox` only looked at `members[<lead>].cwd`. Fallback
// order is now: leadMember.cwd → config.worktreePath → config.repo.
// ---------------------------------------------------------------------------

/**
 * Write a team config with the exact fields we need to exercise the
 * workingDir-fallback chain in `scanTeamInbox`. The existing
 * `createTestTeamConfig` helper always populates members[] with a matching
 * lead — the bug we're guarding against requires the opposite.
 */
async function createRawTeamConfig(
  teamName: string,
  config: {
    leadAgentId?: string;
    members?: { agentId: string; name: string; cwd?: string }[];
    worktreePath?: string;
    repo?: string;
  },
  unreadMessage = 'hello lead',
): Promise<void> {
  const sanitized = sanitizeTeamName(teamName);
  const teamDir = join(tempDir, 'teams', sanitized);
  const inboxDir = join(teamDir, 'inboxes');
  await mkdir(inboxDir, { recursive: true });

  const leadAgentId = config.leadAgentId ?? `team-lead@${sanitized}`;
  const leadInboxName = leadAgentId.split('@')[0] ?? 'team-lead';

  await writeFile(
    join(teamDir, 'config.json'),
    JSON.stringify({
      name: sanitized,
      description: `Test team: ${teamName}`,
      createdAt: Date.now(),
      leadAgentId,
      leadSessionId: 'test-session-id',
      members: (config.members ?? []).map((m) => ({
        agentId: m.agentId,
        name: m.name,
        agentType: 'general-purpose',
        joinedAt: Date.now(),
        cwd: m.cwd,
        backendType: 'tmux',
        color: 'blue',
        planModeRequired: false,
        isActive: true,
      })),
      worktreePath: config.worktreePath,
      repo: config.repo,
    }),
  );

  const msg: NativeInboxMessage = {
    from: 'someone',
    text: unreadMessage,
    summary: 'test',
    timestamp: new Date().toISOString(),
    color: 'blue',
    read: false,
  };
  await writeFile(join(inboxDir, `${leadInboxName}.json`), JSON.stringify([msg]));
}

describe('listTeamsWithUnreadInbox workingDir fallback', () => {
  test('uses leadMember.cwd when the lead is in members[]', async () => {
    await createRawTeamConfig('team-alpha', {
      leadAgentId: 'team-lead@team-alpha',
      members: [{ agentId: 'team-lead@team-alpha', name: 'team-lead', cwd: '/tmp/alpha-cwd' }],
      worktreePath: '/tmp/alpha-worktree',
    });
    const rows = await listTeamsWithUnreadInbox();
    const row = rows.find((r) => r.teamName === 'team-alpha');
    expect(row?.workingDir).toBe('/tmp/alpha-cwd');
  });

  test('falls back to config.worktreePath when lead is not in members[]', async () => {
    // Ghost-lead scenario: the lead is the team itself (councils, solo
    // agents), so members[] is empty. Pre-fix this returned workingDir:null
    // and the inbox-watcher logged "no workingDir in config" + refused to
    // spawn. Post-fix we trust the team's own worktreePath.
    await createRawTeamConfig('council-1775707451', {
      leadAgentId: 'team-lead@council-1775707451',
      members: [],
      worktreePath: '/tmp/council-worktree',
    });
    const rows = await listTeamsWithUnreadInbox();
    const row = rows.find((r) => r.teamName === 'council-1775707451');
    expect(row?.workingDir).toBe('/tmp/council-worktree');
  });

  test('falls back to config.repo when both leadMember.cwd and worktreePath are absent', async () => {
    await createRawTeamConfig('team-bare', {
      leadAgentId: 'team-lead@team-bare',
      members: [],
      repo: '/tmp/bare-repo',
    });
    const rows = await listTeamsWithUnreadInbox();
    const row = rows.find((r) => r.teamName === 'team-bare');
    expect(row?.workingDir).toBe('/tmp/bare-repo');
  });

  test('falls back to any member.cwd when lead not in members[] and no worktreePath/repo', async () => {
    // Real-world council config (e.g. council-1775707451) observed with:
    //   - leadAgentId pointing at the council itself
    //   - members[] containing only worker council agents (architect, sentinel, …)
    //     with a matching cwd on the shared council worktree
    //   - worktreePath: null, repo: null
    // Before this tier the inbox-watcher silently refused to spawn the lead
    // despite unread messages. Any member.cwd recovers the intended path.
    await createRawTeamConfig('council-1775707451', {
      leadAgentId: 'council-1775707451@council-1775707451',
      members: [
        {
          agentId: 'council--questioner@council-1775707451',
          name: 'council--questioner',
          cwd: '/tmp/shared-council-worktree',
        },
        {
          agentId: 'council--sentinel@council-1775707451',
          name: 'council--sentinel',
          cwd: '/tmp/shared-council-worktree',
        },
      ],
    });
    const rows = await listTeamsWithUnreadInbox();
    const row = rows.find((r) => r.teamName === 'council-1775707451');
    expect(row?.workingDir).toBe('/tmp/shared-council-worktree');
  });

  test('member.cwd fallback skips entries with no cwd and picks the first populated one', async () => {
    await createRawTeamConfig('team-mixed-cwd', {
      leadAgentId: 'lead@team-mixed-cwd',
      members: [
        { agentId: 'worker-a@team-mixed-cwd', name: 'worker-a' },
        { agentId: 'worker-b@team-mixed-cwd', name: 'worker-b', cwd: '/tmp/first-populated' },
        { agentId: 'worker-c@team-mixed-cwd', name: 'worker-c', cwd: '/tmp/also-populated' },
      ],
    });
    const rows = await listTeamsWithUnreadInbox();
    const row = rows.find((r) => r.teamName === 'team-mixed-cwd');
    expect(row?.workingDir).toBe('/tmp/first-populated');
  });

  test('returns null when no fallback source is available', async () => {
    // Exercised explicitly so the inbox-watcher's "no workingDir in config"
    // rate-limited warning still fires for configs that have no usable path
    // — e.g. malformed configs whose members[] is empty AND lack
    // worktreePath/repo.
    await createRawTeamConfig('team-blank', {
      leadAgentId: 'team-lead@team-blank',
      members: [],
    });
    const rows = await listTeamsWithUnreadInbox();
    const row = rows.find((r) => r.teamName === 'team-blank');
    expect(row?.workingDir).toBeNull();
  });

  test('worktreePath still beats member.cwd when both are present (ordering invariant)', async () => {
    await createRawTeamConfig('team-order-invariant', {
      leadAgentId: 'lead@team-order-invariant',
      members: [{ agentId: 'worker@team-order-invariant', name: 'worker', cwd: '/tmp/worker-cwd' }],
      worktreePath: '/tmp/team-worktree',
    });
    const rows = await listTeamsWithUnreadInbox();
    const row = rows.find((r) => r.teamName === 'team-order-invariant');
    expect(row?.workingDir).toBe('/tmp/team-worktree');
  });

  test('prefers leadMember.cwd over worktreePath when both are present', async () => {
    await createRawTeamConfig('team-priority', {
      leadAgentId: 'team-lead@team-priority',
      members: [{ agentId: 'team-lead@team-priority', name: 'team-lead', cwd: '/tmp/priority-cwd' }],
      worktreePath: '/tmp/priority-worktree',
      repo: '/tmp/priority-repo',
    });
    const rows = await listTeamsWithUnreadInbox();
    const row = rows.find((r) => r.teamName === 'team-priority');
    expect(row?.workingDir).toBe('/tmp/priority-cwd');
  });
});
