/**
 * Tests for buildResumeContext — resume context injection for agents.
 *
 * Requires pgserve (auto-started via getConnection).
 * Each test uses a unique repo_path for isolation.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as directory from '../lib/agent-directory.js';
import type { DirectoryEntry } from '../lib/agent-directory.js';
import type { Agent } from '../lib/agent-registry.js';
import * as registry from '../lib/agent-registry.js';
// biome-ignore lint/correctness/noUnusedImports: setupTestSchema used by merge-preview new test at :826
import { DB_AVAILABLE, setupTestDatabase, setupTestSchema } from '../lib/test-db.js';
import * as wishState from '../lib/wish-state.js';
import {
  buildInitialSplitWindowCommand,
  buildResumeContext,
  findDeadResumable,
  pickParallelShortId,
  resolveAgentWorkingDir,
  resolveSpawnIdentity,
  resolveTeamName,
} from './agents.js';

let cwd: string;

describe.skipIf(!DB_AVAILABLE)('pg', () => {
  let cleanupSchema: () => Promise<void>;

  beforeAll(async () => {
    cleanupSchema = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanupSchema();
  });

  beforeEach(() => {
    cwd = `/tmp/genie-resume-ctx-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  });

  function makeAgent(overrides: Partial<Agent> = {}): Agent {
    return {
      id: 'test-agent',
      paneId: '%42',
      session: 'genie',
      worktree: null,
      startedAt: '2026-03-24T00:00:00Z',
      state: 'suspended',
      lastStateChange: '2026-03-24T00:00:00Z',
      repoPath: cwd,
      ...overrides,
    };
  }

  describe('buildResumeContext', () => {
    test('team-lead with wish state includes group statuses', async () => {
      await wishState.createState(
        'resume-test',
        [{ name: '1' }, { name: '2', dependsOn: ['1'] }, { name: '3', dependsOn: ['1'] }],
        cwd,
      );
      await wishState.startGroup('resume-test', '1', 'engineer', cwd);
      await wishState.completeGroup('resume-test', '1', cwd);

      const agent = makeAgent({
        role: 'team-lead',
        wishSlug: 'resume-test',
        team: 'test-team',
      });

      const context = await buildResumeContext(agent);

      expect(context).toBeDefined();
      expect(context).toContain('You were resumed after a crash');
      expect(context).toContain('Wish: resume-test');
      expect(context).toContain('Group 1: done');
      expect(context).toContain('Group 2: ready');
      expect(context).toContain('Group 3: ready');
      expect(context).toContain('Continue from where you left off');
      expect(context).toContain('genie status resume-test');
    });

    test('team-lead with in_progress group shows started timestamp', async () => {
      await wishState.createState('ts-test', [{ name: '1' }, { name: '2', dependsOn: ['1'] }], cwd);
      await wishState.startGroup('ts-test', '1', 'engineer', cwd);

      const agent = makeAgent({
        role: 'team-lead',
        wishSlug: 'ts-test',
        team: 'test-team',
      });

      const context = await buildResumeContext(agent);

      expect(context).toBeDefined();
      expect(context).toContain('Group 1: in_progress (started at');
      expect(context).toContain('Group 2: blocked (depends on 1)');
    });

    test('team-lead without wish state returns undefined', async () => {
      const agent = makeAgent({
        role: 'team-lead',
        wishSlug: 'nonexistent-wish',
      });

      const context = await buildResumeContext(agent);

      expect(context).toBeUndefined();
    });

    test('non-team-lead with team gets simple message', async () => {
      const agent = makeAgent({
        role: 'engineer',
        team: 'test-team',
      });

      const context = await buildResumeContext(agent);

      expect(context).toBe("You were resumed. Check your team's current state with `genie status`.");
    });

    test('agent without team or wish returns undefined', async () => {
      const agent = makeAgent({
        role: 'engineer',
      });

      const context = await buildResumeContext(agent);

      expect(context).toBeUndefined();
    });

    test('team-lead with wish slug but no state falls back to simple message', async () => {
      const agent = makeAgent({
        role: 'team-lead',
        wishSlug: 'no-such-wish',
        team: 'test-team',
      });

      const context = await buildResumeContext(agent);

      // No wish state found, but has team — falls through to simple message
      expect(context).toBe("You were resumed. Check your team's current state with `genie status`.");
    });
  });
});

describe('buildInitialSplitWindowCommand', () => {
  test('uses split-window with shell-quoted cwd and full command', () => {
    const command = buildInitialSplitWindowCommand(
      '@42',
      "/tmp/genie qa/test's",
      "claude --append-system-prompt-file '/tmp/prompt file.md' 'Execute the QA spec'",
    );

    expect(command).toContain('tmux -L genie');
    expect(command).toContain('split-window -d');
    expect(command).toContain("-t '@42'");
    expect(command).toContain("-c '/tmp/genie qa/test'\\''s'");
    expect(command).toContain("-P -F '#{pane_id}'");
    expect(command).toContain(
      "'claude --append-system-prompt-file '\\''/tmp/prompt file.md'\\'' '\\''Execute the QA spec'\\'''",
    );
    expect(command).not.toContain('send-keys');
    expect(command).not.toContain('respawn-pane');
  });
});

describe('resolveAgentWorkingDir', () => {
  test('prefers explicit cwd over directory metadata', () => {
    const entry: DirectoryEntry = {
      name: 'genie',
      dir: '/tmp/agents/genie',
      repo: 'automagik-dev/genie',
      promptMode: 'append',
      registeredAt: new Date().toISOString(),
    };

    expect(resolveAgentWorkingDir(entry, '/tmp/override')).toBe('/tmp/override');
  });

  test('prefers the agent directory over non-path repo metadata', () => {
    const entry: DirectoryEntry = {
      name: 'genie',
      dir: '/tmp/agents/genie',
      repo: 'automagik-dev/genie',
      promptMode: 'append',
      registeredAt: new Date().toISOString(),
    };

    expect(resolveAgentWorkingDir(entry)).toBe('/tmp/agents/genie');
  });
});

// ============================================================================
// resolveTeamName — four-tier precedence
//
// Authority: perfect-spawn-hierarchy wish (PR #1133 merge 8a783460,
//   PR #1134 merge 69215743), tui-spawn-dx Group 1.
//
// Precedence, highest wins:
//   1. options.team (the --team flag).
//   2. agent.entry.team (template-pinned row in agent_templates PG table).
//   3. process.env.GENIE_TEAM.
//   4. discoverTeamName() — retained PR #1164 fallback (tmux-session-name +
//      Claude Code JSONL leadSessionId match). Fires only when nothing else
//      resolves.
// ============================================================================
describe('resolveTeamName', () => {
  const noEnv = { GENIE_TEAM: undefined };
  const neverDiscover = async () => null;

  test('tier 1: options.team wins over entry.team, env, and discover', async () => {
    const team = await resolveTeamName({
      explicitTeam: 'cli-flag',
      entryTeam: 'template-team',
      env: { GENIE_TEAM: 'env-team' },
      discover: async () => 'discover-team',
    });
    expect(team).toBe('cli-flag');
  });

  test('tier 2: entry.team wins over GENIE_TEAM and discover', async () => {
    const team = await resolveTeamName({
      entryTeam: 'template-team',
      env: { GENIE_TEAM: 'env-team' },
      discover: async () => 'discover-team',
    });
    expect(team).toBe('template-team');
  });

  test('tier 3: GENIE_TEAM wins over discover', async () => {
    const team = await resolveTeamName({
      env: { GENIE_TEAM: 'env-team' },
      discover: async () => 'discover-team',
    });
    expect(team).toBe('env-team');
  });

  test('tier 4: discoverTeamName fires only when every earlier tier is empty', async () => {
    const team = await resolveTeamName({
      env: noEnv,
      discover: async () => 'discover-team',
    });
    expect(team).toBe('discover-team');
  });

  test('returns null when every tier is empty', async () => {
    const team = await resolveTeamName({
      env: noEnv,
      discover: neverDiscover,
    });
    expect(team).toBeNull();
  });

  test('empty-string explicitTeam falls through to entry.team (treated as absent)', async () => {
    const team = await resolveTeamName({
      explicitTeam: '',
      entryTeam: 'template-team',
      env: noEnv,
      discover: neverDiscover,
    });
    expect(team).toBe('template-team');
  });

  // Regression for the reproducer from the wish: spawning `simone` from inside
  // the `genie` tmux session (where discoverTeamName would return 'genie' via
  // PR #1164's tmux fallback) MUST resolve to 'simone' because the template
  // pins it. This asserts that tier 2 is consulted BEFORE tier 4 — the exact
  // bug the four-tier precedence fixes.
  test('regression: template-pinned simone resolves to simone even when tmux fallback would say genie', async () => {
    const team = await resolveTeamName({
      entryTeam: 'simone',
      env: noEnv,
      discover: async () => 'genie', // simulates PR #1164 tmux-session-name fallback in the `genie` tmux session
    });
    expect(team).toBe('simone');
  });
});

// ============================================================================
// directory.resolve populates entry.team from agent_templates
// ============================================================================
describe.skipIf(!DB_AVAILABLE)('directory.resolve team population', () => {
  let cleanupSchema: () => Promise<void>;

  beforeAll(async () => {
    cleanupSchema = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanupSchema();
  });

  async function seedDirectoryAgent(name: string): Promise<void> {
    const { getConnection } = await import('../lib/db.js');
    const sql = await getConnection();
    // Mirror what `genie dir add` does — minimal metadata so roleToEntry has something to hydrate.
    await sql`
      INSERT INTO agents (id, role, custom_name, started_at, metadata, repo_path)
      VALUES (${`dir:${name}`}, ${name}, ${name}, now(), ${sql.json({ dir: `/tmp/agents/${name}` })}, ${`/tmp/agents/${name}`})
      ON CONFLICT (id) DO UPDATE SET metadata = EXCLUDED.metadata
    `;
  }

  async function seedTemplate(id: string, team: string): Promise<void> {
    const { getConnection } = await import('../lib/db.js');
    const sql = await getConnection();
    await sql`
      INSERT INTO agent_templates (id, provider, team, cwd, last_spawned_at)
      VALUES (${id}, 'claude', ${team}, '/tmp/seed', now())
      ON CONFLICT (id) DO UPDATE SET team = EXCLUDED.team
    `;
  }

  test('reproducer: resolve("simone") exposes entry.team="simone" from agent_templates row', async () => {
    await seedDirectoryAgent('simone');
    await seedTemplate('simone', 'simone');

    const resolved = await directory.resolve('simone');
    expect(resolved).not.toBeNull();
    expect(resolved?.entry.team).toBe('simone');
  });

  test('resolve returns entry.team=undefined when no template row exists', async () => {
    // Use a built-in role (engineer) with no seeded agent_templates row.
    const resolved = await directory.resolve('engineer');
    expect(resolved).not.toBeNull();
    expect(resolved?.entry.team).toBeUndefined();
  });

  test('end-to-end: simone from a "genie" tmux context still resolves to team=simone', async () => {
    // Seed both rows the way production carries them — a `dir:simone` agents
    // row (from `genie dir add`) and a matching `agent_templates` row (from
    // the first spawn).
    await seedDirectoryAgent('simone');
    await seedTemplate('simone', 'simone');

    // Fetch the entry the way handleWorkerSpawn does.
    const resolved = await directory.resolve('simone');
    expect(resolved?.entry.team).toBe('simone');

    // Feed into the real resolver with env + discover simulating "inside the
    // genie tmux session" — pre-PR-#1134 this resolved to 'genie'.
    const team = await resolveTeamName({
      entryTeam: resolved?.entry.team,
      env: { GENIE_TEAM: undefined },
      discover: async () => 'genie',
    });

    expect(team).toBe('simone');
  });
});

// ============================================================================
// Spawn state machine — `genie spawn <name>` branches on canonical liveness.
//
// Authority: tui-spawn-dx wish, Group 2. Builds on Wave 1
// (feat/tui-spawn-dx merge 9321dd65; commits 79cbe066, 898c219d).
// Upholds the perfect-spawn-hierarchy canonical-UUID invariant
// (PR #1133/#1134 merge 69215743).
//
// Branches:
//   1. No row             → canonical (id=<name>, fresh UUID)
//   2. Canonical dead     → canonical (auto-resume path already handled it)
//   3. Canonical alive    → parallel (id=<name>-<sN>, fresh UUID starting with <sN>)
//
// Invariants:
//   - Canonical's UUID is NEVER clobbered by parallel creation.
//   - Parallel's <sN> is a prefix of the parallel's OWN fresh UUID
//     (deterministic slice, never a random mint).
//   - On <sN> collision, extend to s5/s6/... of the SAME UUID until unique.
//   - findDeadResumable(<name>) never matches a parallel row (parallels only
//     resumable via their full id).
// ============================================================================
describe.skipIf(!DB_AVAILABLE)('spawn state machine', () => {
  let cleanupSchema: () => Promise<void>;

  beforeAll(async () => {
    cleanupSchema = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanupSchema();
  });

  // Each test gets a clean agents table — registry.register's ON CONFLICT DO UPDATE
  // only rewrites a subset of columns (pane_id, session, state, last_state_change),
  // so leftover rows from prior tests carry stale claude_session_id/role/team into
  // new tests and break id-based probes. TRUNCATE keeps each test hermetic.
  beforeEach(async () => {
    const { getConnection } = await import('../lib/db.js');
    const sql = await getConnection();
    await sql`TRUNCATE TABLE agents CASCADE`;
  });

  /** Seed a canonical-shaped agents row. */
  async function seedCanonical(id: string, team: string, overrides: Partial<registry.Agent> = {}): Promise<void> {
    await registry.register({
      id,
      paneId: overrides.paneId ?? 'inline',
      session: overrides.session ?? team,
      worktree: null,
      startedAt: new Date().toISOString(),
      state: overrides.state ?? 'idle',
      lastStateChange: new Date().toISOString(),
      repoPath: overrides.repoPath ?? `/tmp/spawn-state-${id}-${Date.now()}`,
      claudeSessionId: overrides.claudeSessionId,
      role: overrides.role ?? id,
      team,
      provider: overrides.provider ?? 'claude',
      ...overrides,
    });
  }

  /** Stub transport-aware liveness — always-alive / always-dead. */
  const alwaysAlive = async () => true;
  const alwaysDead = async () => false;

  describe('resolveSpawnIdentity', () => {
    test('branch: no row → create canonical (id=<name>, fresh UUID)', async () => {
      const team = `team-no-row-${Date.now()}`;
      const uuids = ['11111111-2222-3333-4444-555555555555'];
      const identity = await resolveSpawnIdentity('alice', team, () => uuids.shift() ?? 'fallback', alwaysDead);
      expect(identity.kind).toBe('canonical');
      expect(identity.workerId).toBe('alice');
      expect(identity.sessionUuid).toBe('11111111-2222-3333-4444-555555555555');
    });

    test('branch: dead canonical → canonical (auto-resume handled upstream)', async () => {
      const team = `team-dead-${Date.now()}`;
      await seedCanonical('alice', team, {
        paneId: 'inline', // isPaneAlive('inline') → false
        claudeSessionId: 'old-canonical-uuid-aaaa-bbbb-cccccccccccc',
      });

      const identity = await resolveSpawnIdentity(
        'alice',
        team,
        () => 'fresh-uuid-1111-2222-3333-444444444444',
        alwaysDead,
      );
      // State machine signals canonical (the upstream findDeadResumable path
      // would have resumed if it could; if we're here, treat as canonical).
      expect(identity.kind).toBe('canonical');
      expect(identity.workerId).toBe('alice');
    });

    test('branch: alive canonical → create parallel (id=<name>-<s4>, UUID prefix matches)', async () => {
      const team = `team-alive-${Date.now()}`;
      await seedCanonical('alice', team, {
        paneId: '%99',
        claudeSessionId: 'canonical-uuid-dead-beef-000000000000',
      });

      const uuid = 'abcd1234-ef01-2345-6789-abcdef012345';
      const identity = await resolveSpawnIdentity('alice', team, () => uuid, alwaysAlive);

      expect(identity.kind).toBe('parallel');
      expect(identity.workerId).toBe('alice-abcd');
      expect(identity.sessionUuid).toBe(uuid);
      expect(identity.sessionUuid.startsWith('abcd')).toBe(true);
      if (identity.kind === 'parallel') {
        expect(identity.canonicalId).toBe('alice');
      }
    });

    test('branch: cross-team canonical → create parallel in requested team (PK-safe)', async () => {
      // Regression for PR #1172 review (gemini HIGH at agents.ts:1750).
      // `agents.id` is PRIMARY KEY. If `alice` already lives in a different
      // team, re-canonicalizing in the requested team would violate the PK.
      // The state machine must route to parallel creation instead, regardless
      // of the existing row's pane liveness.
      const homeTeam = `team-home-${Date.now()}`;
      const requestedTeam = `team-other-${Date.now()}`;
      // Seed the canonical in its HOME team (dead pane — would otherwise trigger
      // the same-team canonical-recovery branch in the state machine).
      await seedCanonical('alice', homeTeam, {
        paneId: '%cross-team',
        claudeSessionId: 'home-team-canonical-uuid-000000000000',
      });

      const parallelUuid = 'feedface-1234-5678-9abc-abcdef012345';
      const identity = await resolveSpawnIdentity('alice', requestedTeam, () => parallelUuid, alwaysDead);

      // Must be a parallel — same-team canonical-recovery is NOT valid across
      // teams because it would PK-conflict at insert time.
      expect(identity.kind).toBe('parallel');
      expect(identity.workerId).toBe('alice-feed');
      expect(identity.sessionUuid).toBe(parallelUuid);
      if (identity.kind === 'parallel') {
        expect(identity.canonicalId).toBe('alice');
      }

      // Home-team canonical row must NOT have been touched.
      const homeRow = await registry.get('alice');
      expect(homeRow?.team).toBe(homeTeam);
      expect(homeRow?.claudeSessionId).toBe('home-team-canonical-uuid-000000000000');
    });

    test('invariant: parallel creation does NOT clobber canonical row', async () => {
      const team = `team-no-clobber-${Date.now()}`;
      const canonicalUuid = 'c0c0c0c0-b2c3-d4e5-f6a7-b8c9d0e1f2a3';
      await seedCanonical('alice', team, {
        paneId: '%42',
        claudeSessionId: canonicalUuid,
      });

      // Snapshot canonical before parallel resolution.
      const before = await registry.get('alice');
      expect(before?.claudeSessionId).toBe(canonicalUuid);

      // Resolve spawn identity (alive canonical → parallel).
      const parallelUuid = 'ba110000-aaaa-bbbb-cccc-dddddddddddd';
      const identity = await resolveSpawnIdentity('alice', team, () => parallelUuid, alwaysAlive);
      expect(identity.kind).toBe('parallel');

      // Canonical row untouched — resolveSpawnIdentity is read-only. Persist
      // the parallel row manually (as handleWorkerSpawn would) and verify the
      // canonical still carries its original UUID.
      await seedCanonical(identity.workerId, team, {
        paneId: '%100',
        claudeSessionId: identity.sessionUuid,
        role: identity.workerId,
      });

      const after = await registry.get('alice');
      expect(after?.claudeSessionId).toBe(canonicalUuid);
      expect(after?.id).toBe('alice');

      const parallel = await registry.get(identity.workerId);
      expect(parallel?.claudeSessionId).toBe(parallelUuid);
    });

    test('invariant: <sN> collision extends to s5 of the SAME UUID', async () => {
      const team = `team-collision-${Date.now()}`;
      // Seed alive canonical + a pre-existing parallel at s4.
      await seedCanonical('alice', team, { paneId: '%50' });
      await seedCanonical('alice-a3f7', team, {
        paneId: '%51',
        role: 'alice-a3f7',
        claudeSessionId: 'preexisting-parallel-uuid-0000000000',
      });

      // Stub UUID factory to return a UUID starting with "a3f7" (collides at s4).
      const forcedUuid = 'a3f7abcd-ef01-2345-6789-abcdef012345';
      const identity = await resolveSpawnIdentity('alice', team, () => forcedUuid, alwaysAlive);

      expect(identity.kind).toBe('parallel');
      expect(identity.workerId).toBe('alice-a3f7a'); // extended to s5
      expect(identity.sessionUuid).toBe(forcedUuid);
      // Parallel's UUID starts with <s5> — deterministic slice contract.
      expect(identity.sessionUuid.startsWith('a3f7a')).toBe(true);

      // Both parallels coexist — persist the new one and verify.
      await seedCanonical(identity.workerId, team, {
        paneId: '%52',
        claudeSessionId: identity.sessionUuid,
        role: identity.workerId,
      });
      const s4 = await registry.get('alice-a3f7');
      const s5 = await registry.get('alice-a3f7a');
      expect(s4?.id).toBe('alice-a3f7');
      expect(s5?.id).toBe('alice-a3f7a');
    });

    test('branch: tmux unreachable during liveness probe → treat as dead, create canonical', async () => {
      // Regression: stale tmux socket (zombie socket file, no server) caused
      // `genie agent spawn` to crash with raw tmux stderr because
      // `isPaneAlive` (routed via `isAliveFn` → `resolveWorkerLivenessByTransport`)
      // throws `TmuxUnreachableError` and the error escaped the spawn path.
      // Expected behaviour: treat the worker as dead for spawn purposes so
      // the CLI proceeds to canonical-recovery instead of failing the user.
      const team = `team-tmux-down-${Date.now()}`;
      await seedCanonical('alice', team, { paneId: '%999' });

      const { TmuxUnreachableError } = await import('../lib/tmux.js');
      const tmuxDown = async () => {
        throw new TmuxUnreachableError('no server running on /tmp/tmux-1000/genie');
      };

      const identity = await resolveSpawnIdentity(
        'alice',
        team,
        () => 'recovery-uuid-0000-1111-2222-333333333333',
        tmuxDown,
      );

      expect(identity.kind).toBe('canonical');
      expect(identity.workerId).toBe('alice');
      expect(identity.sessionUuid).toBe('recovery-uuid-0000-1111-2222-333333333333');
    });

    test('branch: "no server running" string (non-class error) also treated as dead', async () => {
      // Defense in depth: some code paths raise a plain Error with the tmux
      // stderr in the message rather than a typed `TmuxUnreachableError`
      // (legacy wrappers, third-party tmux bins). We still don't want to
      // leak that to the user as a spawn failure.
      const team = `team-tmux-str-${Date.now()}`;
      await seedCanonical('alice', team, { paneId: '%998' });

      const plainError = async () => {
        throw new Error('Failed to execute tmux command: no server running on /tmp/tmux-1000/genie');
      };

      const identity = await resolveSpawnIdentity(
        'alice',
        team,
        () => 'plain-uuid-0000-1111-2222-333333333333',
        plainError,
      );

      expect(identity.kind).toBe('canonical');
      expect(identity.workerId).toBe('alice');
    });

    test("branch: non-tmux error during probe → rethrow (don't silently mask bugs)", async () => {
      const team = `team-probe-bug-${Date.now()}`;
      await seedCanonical('alice', team, { paneId: '%997' });

      const unexpectedError = async () => {
        throw new Error('ECONNRESET on postgres query');
      };

      await expect(resolveSpawnIdentity('alice', team, () => 'x', unexpectedError)).rejects.toThrow('ECONNRESET');
    });
  });
  describe('pickParallelShortId', () => {
    test('returns s4 when no collision', async () => {
      const team = `team-pick-s4-${Date.now()}`;
      const shortId = await pickParallelShortId('alice', team, 'deadbeef-1234-5678-9abc-def012345678');
      expect(shortId).toBe('dead');
    });

    test('extends to s5 when s4 collides', async () => {
      const team = `team-pick-s5-${Date.now()}`;
      await seedCanonical('alice-dead', team, { paneId: '%60', role: 'alice-dead' });
      const shortId = await pickParallelShortId('alice', team, 'deadbeef-1234-5678-9abc-def012345678');
      expect(shortId).toBe('deadb');
    });

    test('extends to s6 when s4 AND s5 collide', async () => {
      const team = `team-pick-s6-${Date.now()}`;
      await seedCanonical('alice-dead', team, { paneId: '%70', role: 'alice-dead' });
      await seedCanonical('alice-deadb', team, { paneId: '%71', role: 'alice-deadb' });
      const shortId = await pickParallelShortId('alice', team, 'deadbeef-1234-5678-9abc-def012345678');
      expect(shortId).toBe('deadbe');
    });

    test('collision in a DIFFERENT team DOES extend (global PK)', async () => {
      // Regression for PR #1172 review (gemini HIGH): `agents.id` is PRIMARY
      // KEY in the `agents` table, so uniqueness is global, not per-team.
      // A collision on `<baseName>-<slice>` in any team forces the slice to
      // extend — otherwise the INSERT would fail with a PK violation.
      const otherTeam = `team-pick-other-${Date.now()}`;
      const team = `team-pick-same-${Date.now()}`;
      await seedCanonical('alice-dead', otherTeam, { paneId: '%80', role: 'alice-dead' });
      const shortId = await pickParallelShortId('alice', team, 'deadbeef-1234-5678-9abc-def012345678');
      expect(shortId).toBe('deadb');
    });

    test('rejects non-UUID input: "not-a-uuid"', async () => {
      await expect(pickParallelShortId('alice', 'team', 'not-a-uuid')).rejects.toThrow(/well-formed UUID/);
    });

    test('rejects non-UUID input: empty string', async () => {
      await expect(pickParallelShortId('alice', 'team', '')).rejects.toThrow(/well-formed UUID/);
    });

    test('rejects non-UUID input: hex-only no dashes', async () => {
      // Matches hex chars but wrong format (no dashes) — must be rejected.
      await expect(pickParallelShortId('alice', 'team', 'abc12345678901234567890123456789ab')).rejects.toThrow(
        /well-formed UUID/,
      );
    });

    test('rejects non-UUID input: too short', async () => {
      await expect(pickParallelShortId('alice', 'team', 'abc')).rejects.toThrow(/well-formed UUID/);
    });
  });

  describe('findDeadResumable: parallels off auto-resume path', () => {
    test('findDeadResumable(<name>) does NOT match a parallel row', async () => {
      const team = `team-parallels-off-${Date.now()}`;
      // Seed a dead parallel row (role=<name>-<sN>, not <name>).
      await seedCanonical('alice-a3f7', team, {
        paneId: 'inline', // dead
        role: 'alice-a3f7',
        claudeSessionId: 'parallel-uuid-a3f7abcd-0000-0000-000000000000',
        provider: 'claude',
      });

      // findDeadResumable('alice') must NOT return the parallel — the parallel's
      // role is 'alice-a3f7', not 'alice'.
      const found = await findDeadResumable(team, 'alice');
      expect(found).toBeNull();
    });

    test('findDeadResumable(<name>-<sN>) DOES match the parallel row (resume by full id works)', async () => {
      const team = `team-parallel-resume-${Date.now()}`;
      await seedCanonical('alice-b1c2', team, {
        paneId: 'inline', // dead
        role: 'alice-b1c2',
        claudeSessionId: 'parallel-uuid-b1c2abcd-0000-0000-000000000000',
        provider: 'claude',
      });

      const found = await findDeadResumable(team, 'alice-b1c2');
      expect(found).not.toBeNull();
      expect(found?.id).toBe('alice-b1c2');
      expect(found?.claudeSessionId).toBe('parallel-uuid-b1c2abcd-0000-0000-000000000000');
    });
  });

  // Regression for cross-team resurrection (2026-04-19):
  // Team A has a dead engineer-2 anchor. Team B spawns engineer-2. The spawn
  // must NOT resume team A's anchor and must NOT silently adopt team A's row.
  describe('cross-team resume isolation', () => {
    test('findDeadResumable in team B does not match a dead anchor in team A', async () => {
      const teamA = `docs-drift-omni-v2-${Date.now()}`;
      const teamB = `genie-serve-obs-${Date.now()}`;

      // Seed a dead Claude anchor for engineer-2 in team A.
      await seedCanonical('engineer-2', teamA, {
        paneId: 'inline', // dead
        role: 'engineer-2',
        claudeSessionId: 'teamA-session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        provider: 'claude',
      });

      // Team B asking for its own engineer-2 must see "no resumable in my
      // team" — the team A row is out of scope.
      const found = await findDeadResumable(teamB, 'engineer-2');
      expect(found).toBeNull();
    });

    test('register rejects a team B spawn that would clobber a team A anchor', async () => {
      const teamA = `docs-drift-omni-v2-${Date.now()}`;
      const teamB = `genie-serve-obs-${Date.now()}`;

      await seedCanonical('engineer-2', teamA, {
        paneId: '%67', // pretend-live pane from team A
        role: 'engineer-2',
        claudeSessionId: 'teamA-session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        provider: 'claude',
      });

      let threw = false;
      try {
        await registry.register({
          id: 'engineer-2',
          paneId: '%99',
          session: teamB,
          worktree: null,
          startedAt: new Date().toISOString(),
          state: 'spawning',
          lastStateChange: new Date().toISOString(),
          repoPath: '/tmp/genie-serve-obs-wt',
          role: 'engineer-2',
          team: teamB,
          provider: 'claude',
        });
      } catch (err) {
        threw = true;
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).toMatch(/cross-team|already exists/i);
      }
      expect(threw).toBe(true);

      // Team A's row must be untouched.
      const a = await registry.get('engineer-2');
      expect(a?.team).toBe(teamA);
      expect(a?.paneId).toBe('%67');
    });
  });
});
