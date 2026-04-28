/**
 * Messaging Commands — Regression Tests
 *
 * Covers:
 *   - detectSenderIdentity cascade
 *   - checkSendScope team enforcement
 *   - buildTeamLeadCommand shared module
 *   - provider-adapters GENIE_AGENT_NAME
 *
 * Run with: bun test src/term-commands/msg.test.ts
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { getConnection } from '../lib/db.js';
import { DB_AVAILABLE, setupTestDatabase } from '../lib/test-db.js';
import {
  checkSendScope,
  detectSenderIdentity,
  printBridgeSuggestion,
  registerSendInboxCommands,
  resolveSenderTeams,
  suggestRelayLeader,
} from './msg.js';

// ---------------------------------------------------------------------------
// PG test schema (required since team-manager now reads from PG)
// ---------------------------------------------------------------------------

let cleanupSchema: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (!DB_AVAILABLE) return;
  cleanupSchema = await setupTestDatabase();
});

afterAll(async () => {
  if (cleanupSchema) await cleanupSchema();
});

// ---------------------------------------------------------------------------
// Helper: insert team into PG
// ---------------------------------------------------------------------------

async function insertTeam(name: string, repo: string, members: string[], leader?: string): Promise<void> {
  const sql = await getConnection();
  await sql`
    INSERT INTO teams (name, repo, base_branch, worktree_path, leader, members, status, created_at)
    VALUES (${name}, ${repo}, 'dev', ${join(repo, '.worktrees', name)}, ${leader ?? null}, ${JSON.stringify(members)}, 'in_progress', now())
    ON CONFLICT (name) DO UPDATE SET members = ${JSON.stringify(members)}, leader = ${leader ?? null}
  `;
}

// ---------------------------------------------------------------------------
// Helpers: save/restore env vars
// ---------------------------------------------------------------------------

const ENV_KEYS = ['GENIE_AGENT_NAME', 'TMUX_PANE', 'CLAUDE_CONFIG_DIR', 'GENIE_HOME', 'GENIE_TEAM'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
  }
  // Isolate from global registry to prevent cross-test contamination
  process.env.GENIE_HOME = `/tmp/msg-test-isolated-${Date.now()}`;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
});

// ---------------------------------------------------------------------------
// detectSenderIdentity tests
// ---------------------------------------------------------------------------

describe.skipIf(!DB_AVAILABLE)('detectSenderIdentity', () => {
  // Scenario 1: Team-lead via Bash tool — GENIE_AGENT_NAME='team-lead'
  test('returns "team-lead" when GENIE_AGENT_NAME is set (team-lead via Bash tool)', async () => {
    process.env.GENIE_AGENT_NAME = 'team-lead';
    process.env.TMUX_PANE = undefined;

    const sender = await detectSenderIdentity('genie');
    expect(sender).toBe('team-lead');
  });

  // Scenario 2: Worker via CLI — GENIE_AGENT_NAME set by provider-adapters
  test('returns worker name when GENIE_AGENT_NAME is set (worker via provider-adapters)', async () => {
    process.env.GENIE_AGENT_NAME = 'implementor';
    process.env.TMUX_PANE = '%5';

    const sender = await detectSenderIdentity('genie');
    expect(sender).toBe('implementor');
  });

  // Scenario 3: External CLI — no env, no tmux → fallback to 'cli'
  test('returns "cli" when no GENIE_AGENT_NAME and no TMUX_PANE', async () => {
    process.env.GENIE_AGENT_NAME = undefined;
    process.env.TMUX_PANE = undefined;

    const sender = await detectSenderIdentity('genie');
    expect(sender).toBe('cli');
  });

  // Scenario 4: GENIE_AGENT_NAME always wins over TMUX_PANE
  test('GENIE_AGENT_NAME takes priority over TMUX_PANE lookup', async () => {
    process.env.GENIE_AGENT_NAME = 'custom-agent';
    process.env.TMUX_PANE = '%99';

    const sender = await detectSenderIdentity('genie');
    expect(sender).toBe('custom-agent');
  });

  // Scenario 5: TMUX_PANE set but no match → falls through to 'cli'
  test('returns "cli" when TMUX_PANE set but no match in registry or config', async () => {
    process.env.GENIE_AGENT_NAME = undefined;
    process.env.TMUX_PANE = '%999';
    process.env.CLAUDE_CONFIG_DIR = `/tmp/genie-test-no-config-${Date.now()}`;

    const sender = await detectSenderIdentity('nonexistent-team');
    expect(sender).toBe('cli');
  });

  // Scenario 6: Works with no teamName (optional parameter)
  test('works without teamName parameter', async () => {
    process.env.GENIE_AGENT_NAME = 'my-agent';

    const sender = await detectSenderIdentity();
    expect(sender).toBe('my-agent');
  });

  // Scenario 7: Falls back to GENIE_TEAM env when no teamName provided
  test('uses GENIE_TEAM env when teamName not provided', async () => {
    process.env.GENIE_AGENT_NAME = undefined;
    process.env.TMUX_PANE = undefined;
    process.env.GENIE_TEAM = 'test-team';

    const sender = await detectSenderIdentity();
    expect(sender).toBe('cli'); // No TMUX_PANE → still falls through to cli
  });
});

// ---------------------------------------------------------------------------
// checkSendScope tests
// ---------------------------------------------------------------------------

describe.skipIf(!DB_AVAILABLE)('checkSendScope', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'scope-test-'));
  });

  afterEach(async () => {
    // Clean up test teams from PG
    const sql = await getConnection();
    await sql`DELETE FROM teams WHERE name LIKE 'scope-test-%' OR name LIKE 'council-scope-test-%' OR name = 'leader-team' OR name = 'my-team'`;
    await rm(tempDir, { recursive: true, force: true });
  });

  test('cli sender has no scope restriction', async () => {
    const error = await checkSendScope(tempDir, 'cli', 'anyone');
    expect(error).toBeNull();
  });

  test('sender not in any team has no scope restriction', async () => {
    const error = await checkSendScope(tempDir, 'free-agent', 'anyone');
    expect(error).toBeNull();
  });

  test('allows sending within same team', async () => {
    await insertTeam('scope-test-team', tempDir, ['alice', 'bob']);

    const error = await checkSendScope(tempDir, 'alice', 'bob');
    expect(error).toBeNull();
  });

  test('rejects sending to non-team-member', async () => {
    await insertTeam('scope-test-reject', tempDir, ['alice']);

    const error = await checkSendScope(tempDir, 'alice', 'outsider');
    expect(error).not.toBeNull();
    expect(error).toContain('Scope violation');
    expect(error).toContain('outsider');
  });

  test('member can send to leader by name', async () => {
    await insertTeam('my-team', tempDir, ['implementor'], 'my-leader');

    // implementor (member) can send to the leader by name
    const error = await checkSendScope(tempDir, 'implementor', 'my-leader');
    expect(error).toBeNull();
  });

  test('leader uses GENIE_TEAM for team lookup', async () => {
    await insertTeam('leader-team', tempDir, ['worker-a', 'worker-b'], 'boss');

    process.env.GENIE_TEAM = 'leader-team';

    // leader can send to team member
    const error = await checkSendScope(tempDir, 'boss', 'worker-a');
    expect(error).toBeNull();
  });

  test('leader blocked from sending to non-member', async () => {
    await insertTeam('leader-team', tempDir, ['worker-a'], 'boss');

    process.env.GENIE_TEAM = 'leader-team';

    const error = await checkSendScope(tempDir, 'boss', 'outsider');
    expect(error).not.toBeNull();
    expect(error).toContain('Scope violation');
  });

  // ---- parentTeam chain walk ----

  async function insertTeamWithParent(
    name: string,
    repo: string,
    members: string[],
    parentTeam?: string,
    allowChildReachback?: string[],
  ): Promise<void> {
    const sql = await getConnection();
    await sql`
      INSERT INTO teams (
        name, repo, base_branch, worktree_path, leader, members, status,
        parent_team, allow_child_reachback, created_at
      ) VALUES (
        ${name}, ${repo}, 'dev', ${join(repo, '.worktrees', name)}, null,
        ${JSON.stringify(members)}, 'in_progress',
        ${parentTeam ?? null},
        ${allowChildReachback ? JSON.stringify(allowChildReachback) : null},
        now()
      )
      ON CONFLICT (name) DO UPDATE SET
        members = ${JSON.stringify(members)},
        parent_team = ${parentTeam ?? null},
        allow_child_reachback = ${allowChildReachback ? JSON.stringify(allowChildReachback) : null}
    `;
  }

  test('council-* child reachback to parent is allowed by default', async () => {
    await insertTeam('scope-test-parent-home', tempDir, ['felipe-3']);
    await insertTeamWithParent('council-scope-test-999', tempDir, ['council--architect'], 'scope-test-parent-home');

    const error = await checkSendScope(tempDir, 'council--architect', 'felipe-3');
    expect(error).toBeNull();
  });

  test('non-council child is blocked unless parent ALLOWLISTs its prefix', async () => {
    await insertTeam('scope-test-parent-closed', tempDir, ['felipe-3']);
    await insertTeamWithParent('scope-test-sub-1', tempDir, ['sub-agent'], 'scope-test-parent-closed');

    const error = await checkSendScope(tempDir, 'sub-agent', 'felipe-3');
    expect(error).not.toBeNull();
    expect(error).toContain('Scope violation');
  });

  test('ALLOWLIST on parent permits an arbitrary child prefix', async () => {
    await insertTeamWithParent('scope-test-parent-allow', tempDir, ['felipe-3'], undefined, ['scope-test-sub-']);
    await insertTeamWithParent('scope-test-sub-2', tempDir, ['sub-agent'], 'scope-test-parent-allow');

    const error = await checkSendScope(tempDir, 'sub-agent', 'felipe-3');
    expect(error).toBeNull();
  });

  // ---- parent → child reachback (issue #1205) ----

  test('parent member → child member allowed via parentTeam chain (council default prefix)', async () => {
    await insertTeam('scope-test-parent-1205a', tempDir, ['parent-pm']);
    await insertTeamWithParent('council-scope-test-1205a', tempDir, ['child-worker'], 'scope-test-parent-1205a');

    // Parent-team member reaches DOWN into an eligible child team.
    const error = await checkSendScope(tempDir, 'parent-pm', 'child-worker');
    expect(error).toBeNull();
  });

  test('parent leader → child team-name (team-lead alias) allowed via ALLOWLIST prefix', async () => {
    // Simulates the #1205 repro: a parent leader addresses a child by team
    // name (which `SendMessage` treats as the team-lead alias).
    await insertTeam('scope-test-parent-1205b', tempDir, ['parent-member'], 'parent-leader');
    await insertTeamWithParent('scope-test-sub-1205b', tempDir, ['child-lead'], 'scope-test-parent-1205b');
    // Parent ALLOWLIST permits the `scope-test-sub-` prefix (non-council child).
    const sql = await getConnection();
    await sql`
      UPDATE teams SET allow_child_reachback = ${JSON.stringify(['scope-test-sub-'])}
      WHERE name = 'scope-test-parent-1205b'
    `;

    const previousTeam = process.env.GENIE_TEAM;
    process.env.GENIE_TEAM = 'scope-test-parent-1205b';
    try {
      const error = await checkSendScope(tempDir, 'parent-leader', 'scope-test-sub-1205b');
      expect(error).toBeNull();
    } finally {
      if (previousTeam === undefined) Reflect.deleteProperty(process.env, 'GENIE_TEAM');
      else process.env.GENIE_TEAM = previousTeam;
    }
  });

  test('unrelated team recipient still triggers scope violation (not over-permissive)', async () => {
    // Regression: the DOWN-walk must only expose teams whose parentTeam chain
    // reaches the sender, not every team on the system.
    await insertTeam('scope-test-parent-1205c', tempDir, ['parent-member-c']);
    await insertTeam('scope-test-unrelated-1205c', tempDir, ['stranger']);

    const error = await checkSendScope(tempDir, 'parent-member-c', 'stranger');
    expect(error).not.toBeNull();
    expect(error).toContain('Scope violation');
  });

  test('child with blocked reachback (non-council, no ALLOWLIST) is NOT reachable from parent', async () => {
    await insertTeam('scope-test-parent-1205d', tempDir, ['parent-member-d']);
    await insertTeamWithParent('scope-test-blocked-1205d', tempDir, ['blocked-worker'], 'scope-test-parent-1205d');

    const error = await checkSendScope(tempDir, 'parent-member-d', 'blocked-worker');
    expect(error).not.toBeNull();
    expect(error).toContain('Scope violation');
  });
});

// ---------------------------------------------------------------------------
// resolveSenderTeams — pure-function chain-walk tests (no PG required)
// ---------------------------------------------------------------------------

type TeamFixture = {
  name: string;
  members: string[];
  parentTeam?: string;
  allowChildReachback?: string[];
  leader?: string;
};

function mkTeams(fixtures: TeamFixture[]): Parameters<typeof resolveSenderTeams>[0] {
  return fixtures.map((f) => ({
    name: f.name,
    repo: '/tmp/test-repo',
    baseBranch: 'dev',
    worktreePath: `/tmp/test-repo/.wt/${f.name}`,
    members: f.members,
    status: 'in_progress' as const,
    createdAt: '2026-04-16T00:00:00.000Z',
    leader: f.leader,
    parentTeam: f.parentTeam,
    allowChildReachback: f.allowChildReachback,
  }));
}

describe('resolveSenderTeams', () => {
  test('direct membership returns just the direct team', () => {
    const teams = mkTeams([{ name: 'team-a', members: ['alice'] }]);
    const result = resolveSenderTeams(teams, 'alice');
    expect(result.map((t) => t.name)).toEqual(['team-a']);
  });

  test('council-* child walks to parent by default (council reachback ON)', () => {
    const teams = mkTeams([
      { name: 'home', members: ['felipe-3'] },
      { name: 'council-1', members: ['council--architect'], parentTeam: 'home' },
    ]);
    const result = resolveSenderTeams(teams, 'council--architect');
    expect(result.map((t) => t.name).sort()).toEqual(['council-1', 'home']);
  });

  test('non-matching child prefix without ALLOWLIST stops at the child', () => {
    const teams = mkTeams([
      { name: 'home', members: ['felipe-3'] },
      { name: 'sprint-42', members: ['sub-worker'], parentTeam: 'home' },
    ]);
    const result = resolveSenderTeams(teams, 'sub-worker');
    expect(result.map((t) => t.name)).toEqual(['sprint-42']);
  });

  test('ALLOWLIST on parent enables arbitrary child prefix', () => {
    const teams = mkTeams([
      { name: 'home', members: ['felipe-3'], allowChildReachback: ['sprint-'] },
      { name: 'sprint-42', members: ['sub-worker'], parentTeam: 'home' },
    ]);
    const result = resolveSenderTeams(teams, 'sub-worker');
    expect(result.map((t) => t.name).sort()).toEqual(['home', 'sprint-42']);
  });

  test('chain walk is depth-bounded (max 3 ancestors)', () => {
    const teams = mkTeams([
      { name: 'root', members: ['root-user'] },
      { name: 'council-l1', members: [], parentTeam: 'root' },
      { name: 'council-l2', members: [], parentTeam: 'council-l1' },
      { name: 'council-l3', members: [], parentTeam: 'council-l2' },
      { name: 'council-l4', members: ['deep-worker'], parentTeam: 'council-l3' },
    ]);
    const result = resolveSenderTeams(teams, 'deep-worker');
    // deep-worker + 3 ancestors, NOT the 4th ancestor (root)
    const names = result.map((t) => t.name);
    expect(names).toContain('council-l4');
    expect(names).toContain('council-l3');
    expect(names).toContain('council-l2');
    expect(names).toContain('council-l1');
    expect(names).not.toContain('root');
  });

  test('cycle detection via visited set (self-pointing parent does not infinite-loop)', () => {
    const teams = mkTeams([
      { name: 'council-a', members: ['a-worker'], parentTeam: 'council-b' },
      { name: 'council-b', members: [], parentTeam: 'council-a' },
    ]);
    const result = resolveSenderTeams(teams, 'a-worker');
    const names = result.map((t) => t.name).sort();
    expect(names).toEqual(['council-a', 'council-b']);
  });

  test('missing parent stops the walk gracefully', () => {
    const teams = mkTeams([{ name: 'council-1', members: ['m'], parentTeam: 'nonexistent' }]);
    const result = resolveSenderTeams(teams, 'm');
    expect(result.map((t) => t.name)).toEqual(['council-1']);
  });
});

describe.skipIf(!DB_AVAILABLE)('send command registration', () => {
  test('send command accepts explicit --team context', () => {
    const program = new Command();
    registerSendInboxCommands(program);

    const sendCmd = program.commands.find((cmd) => cmd.name() === 'send');
    expect(sendCmd).toBeDefined();
    expect(sendCmd?.options.some((option) => option.long === '--team')).toBe(true);
  });

  test('send command exposes --bridge escape hatch', () => {
    const program = new Command();
    registerSendInboxCommands(program);

    const sendCmd = program.commands.find((cmd) => cmd.name() === 'send');
    expect(sendCmd?.options.some((option) => option.long === '--bridge')).toBe(true);
  });
});

describe.skipIf(!DB_AVAILABLE)('suggestRelayLeader', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'bridge-test-'));
  });

  afterEach(async () => {
    const sql = await getConnection();
    await sql`DELETE FROM teams WHERE name LIKE 'bridge-test-%' OR name LIKE 'council-bridge-test-%'`;
    await rm(tempDir, { recursive: true, force: true });
  });

  async function seed(name: string, members: string[], leader?: string, parentTeam?: string): Promise<void> {
    const sql = await getConnection();
    await sql`
      INSERT INTO teams (name, repo, base_branch, worktree_path, leader, members, status, parent_team, created_at)
      VALUES (
        ${name}, ${tempDir}, 'dev', ${join(tempDir, '.worktrees', name)},
        ${leader ?? null}, ${JSON.stringify(members)}, 'in_progress',
        ${parentTeam ?? null}, now()
      )
      ON CONFLICT (name) DO UPDATE SET members = ${JSON.stringify(members)}, leader = ${leader ?? null}, parent_team = ${parentTeam ?? null}
    `;
  }

  test('returns null for cli sender', async () => {
    const result = await suggestRelayLeader('cli');
    expect(result).toBeNull();
  });

  test('returns null when sender belongs to no team', async () => {
    const result = await suggestRelayLeader('unknown-agent');
    expect(result).toBeNull();
  });

  test('names the direct team leader for a team member', async () => {
    await seed('bridge-test-team', ['worker-one'], 'my-boss');
    const result = await suggestRelayLeader('worker-one');
    expect(result).toEqual({ leader: 'my-boss', team: 'bridge-test-team' });
  });

  test('falls back to team name when no leader is set', async () => {
    await seed('bridge-test-leaderless', ['solo']);
    const result = await suggestRelayLeader('solo');
    expect(result).toEqual({ leader: 'bridge-test-leaderless', team: 'bridge-test-leaderless' });
  });
});

// ---------------------------------------------------------------------------
// printBridgeSuggestion — --bridge hint output (issue #1205)
// ---------------------------------------------------------------------------

describe.skipIf(!DB_AVAILABLE)('printBridgeSuggestion', () => {
  let tempDir: string;
  let previousTeam: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hint-test-'));
    previousTeam = process.env.GENIE_TEAM;
  });

  afterEach(async () => {
    const sql = await getConnection();
    await sql`DELETE FROM teams WHERE name LIKE 'hint-test-%'`;
    await rm(tempDir, { recursive: true, force: true });
    if (previousTeam === undefined) Reflect.deleteProperty(process.env, 'GENIE_TEAM');
    else process.env.GENIE_TEAM = previousTeam;
  });

  async function seed(name: string, members: string[], leader?: string): Promise<void> {
    const sql = await getConnection();
    await sql`
      INSERT INTO teams (name, repo, base_branch, worktree_path, leader, members, status, created_at)
      VALUES (
        ${name}, ${tempDir}, 'dev', ${join(tempDir, '.worktrees', name)},
        ${leader ?? null}, ${JSON.stringify(members)}, 'in_progress', now()
      )
      ON CONFLICT (name) DO UPDATE SET
        members = ${JSON.stringify(members)}, leader = ${leader ?? null}
    `;
  }

  function captureStderr(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
    };
    const restore = () => {
      console.error = original;
    };
    return { lines, restore };
  }

  test('when leader equals sender, does NOT emit a looping relay command', async () => {
    await seed('hint-test-leader-loop', [], 'hint-test-leader');
    process.env.GENIE_TEAM = 'hint-test-leader-loop';

    const cap = captureStderr();
    try {
      await printBridgeSuggestion('hint-test-leader', 'outsider', 'hello', 'dummy error');
    } finally {
      cap.restore();
    }

    const output = cap.lines.join('\n');
    // Clear no-op-avoidance message
    expect(output).toContain('already the nearest reachable leader');
    // Crucially, no "Relay manually via" hint that would loop to sender
    expect(output).not.toContain('Relay manually via');
    expect(output).not.toMatch(/--to\s+hint-test-leader\b/);
  });

  test('when leader differs from sender, emits a valid relay command', async () => {
    await seed('hint-test-member-relay', ['hint-test-member'], 'hint-test-boss');

    const cap = captureStderr();
    try {
      await printBridgeSuggestion('hint-test-member', 'outsider', 'hello', 'dummy error');
    } finally {
      cap.restore();
    }

    const output = cap.lines.join('\n');
    expect(output).toContain('Nearest reachable leader: hint-test-boss@hint-test-member-relay');
    expect(output).toContain('Relay manually via:');
    expect(output).toContain('--to hint-test-boss');
  });
});

// ---------------------------------------------------------------------------
// Shared buildTeamLeadCommand — single source of truth
// ---------------------------------------------------------------------------

describe.skipIf(!DB_AVAILABLE)('buildTeamLeadCommand (shared module)', () => {
  test('sets GENIE_AGENT_NAME to folder name', async () => {
    const { basename } = await import('node:path');
    const { buildTeamLeadCommand } = await import('../lib/team-lead-command.js');
    const cmd = buildTeamLeadCommand('genie');
    const folderName = basename(process.cwd());
    expect(cmd).toContain(`GENIE_AGENT_NAME='${folderName}'`);
  });

  test('sets all required CC native team flags', async () => {
    const { buildTeamLeadCommand } = await import('../lib/team-lead-command.js');
    const cmd = buildTeamLeadCommand('genie');
    expect(cmd).toContain('--agent-id');
    expect(cmd).toContain('--agent-name');
    expect(cmd).toContain('--team-name');
    expect(cmd).toContain('--permission-mode auto');
    expect(cmd).toContain('CLAUDECODE=1');
    expect(cmd).toContain('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1');
  });

  test('includes --resume when sessionId + resume:true provided', async () => {
    const { buildTeamLeadCommand } = await import('../lib/team-lead-command.js');
    const cmd = buildTeamLeadCommand('genie', { sessionId: 'uuid-abc-123', resume: true });
    expect(cmd).toContain("--resume 'uuid-abc-123'");
    expect(cmd).not.toContain('--session-id');
  });

  test('includes --append-system-prompt-file when systemPromptFile provided (default promptMode)', async () => {
    const { buildTeamLeadCommand } = await import('../lib/team-lead-command.js');
    const cmd = buildTeamLeadCommand('genie', { systemPromptFile: '/tmp/test-agents.md', promptMode: 'append' });
    expect(cmd).toContain('--append-system-prompt-file');
    expect(cmd).toContain('/tmp/test-agents.md');
  });

  test('file path is passed directly, not copied', async () => {
    const { buildTeamLeadCommand } = await import('../lib/team-lead-command.js');
    const cmd = buildTeamLeadCommand('genie', { systemPromptFile: '/path/to/AGENTS.md', promptMode: 'append' });
    expect(cmd).toContain('--append-system-prompt-file');
    expect(cmd).toContain('/path/to/AGENTS.md');
  });

  test('uses --system-prompt-file flag when promptMode is "system"', async () => {
    const { buildTeamLeadCommand } = await import('../lib/team-lead-command.js');
    const cmd = buildTeamLeadCommand('genie', { systemPromptFile: '/tmp/test.md', promptMode: 'system' });
    expect(cmd).toContain('--system-prompt-file');
    expect(cmd).not.toContain('--append-system-prompt-file');
  });
});

// ---------------------------------------------------------------------------
// Verify session.ts delegates to shared module
// ---------------------------------------------------------------------------

describe.skipIf(!DB_AVAILABLE)('session.ts: delegates to shared buildTeamLeadCommand', () => {
  test('session buildClaudeCommand sets GENIE_AGENT_NAME to folder name', async () => {
    const { basename } = await import('node:path');
    const { buildClaudeCommand } = await import('../genie-commands/session.js');
    const cmd = buildClaudeCommand('genie');
    const folderName = basename(process.cwd());
    expect(cmd).toContain(`GENIE_AGENT_NAME='${folderName}'`);
  });
});

// ---------------------------------------------------------------------------
// Verify provider-adapters sets GENIE_AGENT_NAME for spawned workers
// ---------------------------------------------------------------------------

describe.skipIf(!DB_AVAILABLE)('provider-adapters: GENIE_AGENT_NAME for workers', () => {
  // Mock Bun.which to pretend claude is installed (hasBinary check)
  const originalWhich = (Bun as Record<string, unknown>).which;
  beforeEach(() => {
    (Bun as Record<string, unknown>).which = (name: string) =>
      name === 'claude' ? '/usr/local/bin/claude' : typeof originalWhich === 'function' ? originalWhich(name) : null;
  });
  afterEach(() => {
    (Bun as Record<string, unknown>).which = originalWhich;
  });

  test('buildClaudeCommand with nativeTeam sets GENIE_AGENT_NAME in env', async () => {
    const { buildClaudeCommand } = await import('../lib/provider-adapters.js');
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'genie',
      role: 'implementor',
      nativeTeam: {
        enabled: true,
        parentSessionId: 'fake-session-id',
        color: 'green',
        agentType: 'general-purpose',
        agentName: 'implementor',
      },
    });
    expect(result.env).toBeDefined();
    expect(result.env!.GENIE_AGENT_NAME).toBe('implementor');
  });

  test('buildClaudeCommand without nativeTeam still sets GENIE_AGENT_NAME from role', async () => {
    const { buildClaudeCommand } = await import('../lib/provider-adapters.js');
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'genie',
      role: 'implementor',
    });
    expect(result.env?.GENIE_AGENT_NAME).toBe('implementor');
  });
});
