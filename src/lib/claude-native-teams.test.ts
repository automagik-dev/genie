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
  loadConfig,
  resolveNativeMemberName,
  resolveOrMintLeadSessionId,
  sanitizeTeamName,
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
// resolveOrMintLeadSessionId tests (fix-ghost-approval-p0)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('resolveOrMintLeadSessionId', () => {
  test('mints a fresh UUID when no prior JSONL exists', async () => {
    const cwd = '/tmp/fresh-team-cwd';
    const { sessionId, shouldResume } = await resolveOrMintLeadSessionId('fresh-team', cwd);

    expect(shouldResume).toBe(false);
    expect(sessionId).toMatch(UUID_RE);
  });

  test('returns the UUID from a matching prior JSONL with shouldResume: true', async () => {
    const cwd = '/tmp/resume-team-cwd';
    const priorUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    await createSessionJsonl(
      cwd,
      priorUuid,
      [
        { type: 'custom-title', customTitle: 'resume-team' },
        { type: 'user', cwd, sessionId: priorUuid },
      ],
      5_000,
    );

    const { sessionId, shouldResume } = await resolveOrMintLeadSessionId('resume-team', cwd);
    expect(shouldResume).toBe(true);
    expect(sessionId).toBe(priorUuid);
  });

  test('returns the newest JSONL when multiple match the team title', async () => {
    const cwd = '/tmp/multi-team-cwd';
    const olderUuid = '11111111-2222-3333-4444-555555555555';
    const newerUuid = '99999999-8888-7777-6666-555555555555';

    await createSessionJsonl(cwd, olderUuid, [{ type: 'custom-title', customTitle: 'multi-team' }], 1_000);
    await createSessionJsonl(cwd, newerUuid, [{ type: 'custom-title', customTitle: 'multi-team' }], 9_000);

    const { sessionId, shouldResume } = await resolveOrMintLeadSessionId('multi-team', cwd);
    expect(shouldResume).toBe(true);
    expect(sessionId).toBe(newerUuid);
  });

  test('also matches the {team}-{team} custom-title form CC sometimes writes', async () => {
    const cwd = '/tmp/doubled-team-cwd';
    const priorUuid = 'cafebabe-dead-beef-cafe-babedeadbeef';

    await createSessionJsonl(
      cwd,
      priorUuid,
      [{ type: 'custom-title', customTitle: 'doubled-team-doubled-team' }],
      5_000,
    );

    const { sessionId, shouldResume } = await resolveOrMintLeadSessionId('doubled-team', cwd);
    expect(shouldResume).toBe(true);
    expect(sessionId).toBe(priorUuid);
  });

  test('ignores JSONL without a custom-title matching the team', async () => {
    const cwd = '/tmp/unrelated-cwd';
    const unrelatedUuid = '12345678-1234-1234-1234-123456789012';

    await createSessionJsonl(cwd, unrelatedUuid, [{ type: 'custom-title', customTitle: 'some-other-team' }], 5_000);

    const { sessionId, shouldResume } = await resolveOrMintLeadSessionId('fresh-team', cwd);
    expect(shouldResume).toBe(false);
    expect(sessionId).toMatch(UUID_RE);
    expect(sessionId).not.toBe(unrelatedUuid);
  });
});

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
