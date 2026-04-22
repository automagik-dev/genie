/**
 * tui-spawn-dx — End-to-End Integration Tests (Group 8)
 *
 * Locks the wish's whole-system invariants end-to-end, composing the pieces
 * that each earlier Wave shipped in isolation:
 *
 *   - Wave 1 (Group 1): four-tier team precedence (`resolveTeamName`)
 *   - Wave 2 (Group 2): state-gated spawn state machine (`resolveSpawnIdentity`,
 *     `pickParallelShortId`), parallels off the auto-resume path (`findDeadResumable`)
 *   - Wave 3 (Groups 3-6): TUI surfaces — covered by their own component tests
 *
 * This file proves the whole chain holds together — it deliberately avoids
 * calling `handleWorkerSpawn` (which needs a live tmux + real pane creation)
 * and instead composes the exact same primitives `handleWorkerSpawn` uses,
 * in the same order, with pane liveness controlled by the `paneId` sentinel
 * values `isPaneAlive` already honours (`'inline'` → dead without tmux call).
 *
 * Authority: tui-spawn-dx wish Group 8. Locks the canonical-UUID-per-agent
 * invariant established by PR #1134 (perfect-spawn-hierarchy merge 69215743).
 *
 * Run with: bun test src/__tests__/tui-spawn-dx.integration.test.ts
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as directory from '../lib/agent-directory.js';
import * as registry from '../lib/agent-registry.js';
import { DB_AVAILABLE, setupTestSchema } from '../lib/test-db.js';
import {
  findDeadResumable,
  pickParallelShortId,
  resolveSpawnIdentity,
  resolveTeamName,
} from '../term-commands/agents.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Seed an `agent_templates` row the same way the first real spawn would.
 * Template-pinned team is tier 2 of `resolveTeamName` and is what keeps
 * `genie spawn simone` resolving to team=simone even when invoked from the
 * `genie` tmux session.
 */
async function seedTemplate(id: string, team: string): Promise<void> {
  const { getConnection } = await import('../lib/db.js');
  const sql = await getConnection();
  await sql`
    INSERT INTO agent_templates (id, provider, team, cwd, last_spawned_at)
    VALUES (${id}, 'claude', ${team}, '/tmp/seed', now())
    ON CONFLICT (id) DO UPDATE SET team = EXCLUDED.team
  `;
}

/**
 * Seed a `dir:*` row so that `directory.resolve(name)` finds the agent
 * (mirrors what `genie dir add` does).
 */
async function seedDirectoryAgent(name: string): Promise<void> {
  const { getConnection } = await import('../lib/db.js');
  const sql = await getConnection();
  await sql`
    INSERT INTO agents (id, role, custom_name, started_at, metadata, repo_path)
    VALUES (${`dir:${name}`}, ${name}, ${name}, now(), ${sql.json({ dir: `/tmp/agents/${name}` })}, ${`/tmp/agents/${name}`})
    ON CONFLICT (id) DO UPDATE SET metadata = EXCLUDED.metadata
  `;
}

/**
 * Persist a worker row the way `handleWorkerSpawn` does after it picks
 * an identity. Post-migration-047 the session lives on the current executor,
 * so this helper also creates+links an executor carrying `claudeSessionId`.
 */
async function registerWorker(opts: {
  id: string;
  role: string;
  team: string;
  paneId: string;
  claudeSessionId: string;
  provider?: 'claude' | 'codex' | 'claude-sdk';
  session?: string;
  repoPath?: string;
}): Promise<void> {
  const provider = opts.provider ?? 'claude';
  await registry.register({
    id: opts.id,
    paneId: opts.paneId,
    session: opts.session ?? opts.team,
    worktree: null,
    startedAt: new Date().toISOString(),
    state: 'idle',
    lastStateChange: new Date().toISOString(),
    repoPath: opts.repoPath ?? `/tmp/integ-${opts.id}-${Date.now()}`,
    role: opts.role,
    team: opts.team,
    provider,
  });
  const executorRegistry = await import('../lib/executor-registry.js');
  await executorRegistry.createAndLinkExecutor(opts.id, provider, 'tmux', {
    claudeSessionId: opts.claudeSessionId,
    tmuxPaneId: opts.paneId,
    tmuxSession: opts.session ?? opts.team,
  });
}

/** Read the session UUID from the agent's current executor (migration 047). */
async function agentSessionId(id: string): Promise<string | null> {
  const executorRegistry = await import('../lib/executor-registry.js');
  const executor = await executorRegistry.getCurrentExecutor(id);
  return executor?.claudeSessionId ?? null;
}

/** Flip a worker's pane to "inline" — isPaneAlive returns false without a tmux call. */
async function killPane(id: string): Promise<void> {
  const { getConnection } = await import('../lib/db.js');
  const sql = await getConnection();
  await sql`UPDATE agents SET pane_id = 'inline' WHERE id = ${id}`;
}

/** Controllable isAliveFn — returns true for any paneId seeded in the alive set. */
function alivePanes(...alive: string[]): (agent: { id: string; paneId: string }) => Promise<boolean> {
  const set = new Set(alive);
  return async (agent: { id: string; paneId: string }) => set.has(agent.paneId);
}

/** Stub crypto.randomUUID in a scoped fashion — restore after each test. */
function stubRandomUuid(values: string[]): () => void {
  const original = crypto.randomUUID.bind(crypto);
  let i = 0;
  const stub = (crypto as unknown as { randomUUID: () => string }).randomUUID;
  (crypto as unknown as { randomUUID: () => string }).randomUUID = () => {
    const v = values[i++];
    if (!v) throw new Error(`stubRandomUuid: ran out of values (index ${i - 1})`);
    return v;
  };
  void stub; // keep original reference above for the TS checker
  return () => {
    (crypto as unknown as { randomUUID: () => string }).randomUUID = original;
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!DB_AVAILABLE)('tui-spawn-dx integration (Group 8)', () => {
  let cleanupSchema: () => Promise<void>;
  let tempClaudeDir: string;
  let savedClaudeConfigDir: string | undefined;
  let savedTmux: string | undefined;
  let savedGenieTeam: string | undefined;

  beforeAll(async () => {
    cleanupSchema = await setupTestSchema();
  });

  afterAll(async () => {
    await cleanupSchema();
  });

  beforeEach(async () => {
    // Hermetic agents table per test — registry.register's ON CONFLICT UPDATE
    // only rewrites a subset of columns, so leftover rows carry stale
    // claude_session_id / role / team into new tests.
    const { getConnection } = await import('../lib/db.js');
    const sql = await getConnection();
    await sql`TRUNCATE TABLE agents CASCADE`;
    await sql`TRUNCATE TABLE agent_templates CASCADE`;

    // Isolated Claude config dir — never touch the dev's real ~/.claude.
    tempClaudeDir = await mkdtemp(join(tmpdir(), 'tui-spawn-dx-integ-'));
    savedClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    savedTmux = process.env.TMUX;
    savedGenieTeam = process.env.GENIE_TEAM;
    process.env.CLAUDE_CONFIG_DIR = tempClaudeDir;
    process.env.TMUX = undefined;
    process.env.GENIE_TEAM = undefined;
  });

  afterEach(async () => {
    if (savedClaudeConfigDir === undefined) process.env.CLAUDE_CONFIG_DIR = undefined;
    else process.env.CLAUDE_CONFIG_DIR = savedClaudeConfigDir;
    if (savedTmux === undefined) process.env.TMUX = undefined;
    else process.env.TMUX = savedTmux;
    if (savedGenieTeam === undefined) process.env.GENIE_TEAM = undefined;
    else process.env.GENIE_TEAM = savedGenieTeam;
    await rm(tempClaudeDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // (a) Canonical UUID stable across three dead/alive cycles
  //
  // Compose the exact sequence handleWorkerSpawn uses for each of three
  // spawns of the same canonical:
  //   1. findDeadResumable(team, name) — returns the dead row when it exists
  //   2. resolveSpawnIdentity(name, team) — only if the row is gone
  //   3. registry.register(...) — UPSERT with the session UUID
  //
  // Invariant: the canonical's claude_session_id is byte-identical across
  // all three cycles, and only ONE row exists (id='alice').
  // -----------------------------------------------------------------------
  test('(a) canonical UUID is stable across three dead/alive cycles', async () => {
    const team = 'alice';
    const name = 'alice';
    await seedTemplate(name, team);

    let canonicalUuid: string | null = null;

    for (let cycle = 1; cycle <= 3; cycle++) {
      // Step 1: probe for a dead resumable row (the real handleWorkerSpawn path).
      const dead = await findDeadResumable(team, name);

      if (dead) {
        // Resume path: canonical already exists, session UUID is reused.
        // handleWorkerSpawn would call resumeAgent here, which does NOT rewrite
        // claude_session_id on the executor. Simulate by re-registering with
        // the same UUID and a fresh paneId (as resumeAgent's update does).
        expect(dead.id).toBe('alice');
        const deadSession = await agentSessionId('alice');
        expect(deadSession).toBe(canonicalUuid as string);
        await registerWorker({
          id: 'alice',
          role: 'alice',
          team,
          paneId: '%100', // "new" pane from resume
          claudeSessionId: deadSession as string,
        });
      } else {
        // Fresh canonical creation path.
        // findDeadResumable returned null (no row OR row had no claudeSessionId
        // OR pane was alive). For the very first cycle, there is no row yet.
        const identity = await resolveSpawnIdentity(name, team);
        expect(identity.kind).toBe('canonical');
        expect(identity.workerId).toBe('alice');
        canonicalUuid = identity.sessionUuid;
        await registerWorker({
          id: identity.workerId,
          role: identity.workerId,
          team,
          paneId: '%1', // alive on spawn
          claudeSessionId: identity.sessionUuid,
        });
      }

      // Simulate "pane dies" between cycles.
      await killPane('alice');
    }

    // Final invariants: exactly one agent row, and the UUID on its current
    // executor is unchanged since cycle 1. Post-migration-047 the session
    // lives on the executor, so the assertion traverses the JOIN.
    const { getConnection } = await import('../lib/db.js');
    const sql = await getConnection();
    const rows = await sql<{ id: string; claude_session_id: string | null }[]>`
      SELECT a.id, e.claude_session_id
      FROM agents a
      LEFT JOIN executors e ON e.id = a.current_executor_id
      WHERE a.team = ${team} AND a.id NOT LIKE 'dir:%'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('alice');
    expect(rows[0].claude_session_id).toBe(canonicalUuid);
  });

  // -----------------------------------------------------------------------
  // (b) Parallel creation when canonical is alive — canonical never clobbered.
  // -----------------------------------------------------------------------
  test('(b) parallel creation keeps canonical row byte-identical', async () => {
    const team = 'alice';
    const name = 'alice';
    await seedTemplate(name, team);

    // First spawn: canonical. Pane '%42' will be "alive" for the next probe.
    const first = await resolveSpawnIdentity(name, team, undefined, alivePanes('%42'));
    expect(first.kind).toBe('canonical');
    const canonicalUuid = first.sessionUuid;
    await registerWorker({
      id: 'alice',
      role: 'alice',
      team,
      paneId: '%42',
      claudeSessionId: canonicalUuid,
    });

    // Snapshot the canonical row bytes BEFORE the second spawn. Session
    // UUID is joined from the current executor (migration 047).
    const { getConnection } = await import('../lib/db.js');
    const sql = await getConnection();
    const before = await sql<{ id: string; claude_session_id: string; pane_id: string }[]>`
      SELECT a.id, e.claude_session_id, a.pane_id
      FROM agents a
      LEFT JOIN executors e ON e.id = a.current_executor_id
      WHERE a.id = 'alice'
    `;
    expect(before).toHaveLength(1);
    expect(before[0].claude_session_id).toBe(canonicalUuid);

    // Second spawn: canonical alive → parallel. Force the parallel's UUID.
    const parallelUuid = 'b00b1e5f-1234-4567-89ab-cdef01234567';
    const second = await resolveSpawnIdentity(name, team, () => parallelUuid, alivePanes('%42'));
    expect(second.kind).toBe('parallel');
    expect(second.workerId).toBe('alice-b00b');
    if (second.kind === 'parallel') {
      expect(second.canonicalId).toBe('alice');
    }
    // Persist the parallel row (as handleWorkerSpawn does).
    await registerWorker({
      id: second.workerId,
      role: second.workerId, // parallels register role = id — keeps them off findDeadResumable(<name>)
      team,
      paneId: '%43',
      claudeSessionId: second.sessionUuid,
    });

    // Canonical must be byte-identical to the snapshot (executor-joined).
    const after = await sql<{ id: string; claude_session_id: string; pane_id: string }[]>`
      SELECT a.id, e.claude_session_id, a.pane_id
      FROM agents a
      LEFT JOIN executors e ON e.id = a.current_executor_id
      WHERE a.id = 'alice'
    `;
    expect(after).toHaveLength(1);
    expect(after[0].claude_session_id).toBe(canonicalUuid);
    expect(after[0].pane_id).toBe(before[0].pane_id);

    // Parallel row exists with its own UUID (stored on its executor).
    const parallel = await registry.get('alice-b00b');
    expect(parallel).not.toBeNull();
    expect(parallel?.role).toBe('alice-b00b');
    expect(await agentSessionId('alice-b00b')).toBe(parallelUuid);
  });

  // -----------------------------------------------------------------------
  // (c) Short-id collision extends to s5 of the SAME UUID.
  // -----------------------------------------------------------------------
  test('(c) <sN> collision extends to s5 of the parallel UUID', async () => {
    const team = 'alice';
    const name = 'alice';
    await seedTemplate(name, team);

    // Seed alive canonical + a pre-existing parallel with short-id 'a3f7'.
    await registerWorker({
      id: 'alice',
      role: 'alice',
      team,
      paneId: '%10',
      claudeSessionId: '11111111-2222-3333-4444-555555555555',
    });
    await registerWorker({
      id: 'alice-a3f7',
      role: 'alice-a3f7',
      team,
      paneId: '%11',
      claudeSessionId: '22222222-3333-4444-5555-666666666666',
    });

    // Stub crypto.randomUUID so the next parallel UUID starts with "a3f7..."
    // (collision at s4 forces extension to s5).
    const forcedUuid = 'a3f7abcd-ef01-2345-6789-abcdef012345';
    const restore = stubRandomUuid([forcedUuid]);
    try {
      const identity = await resolveSpawnIdentity(name, team, undefined, alivePanes('%10', '%11'));
      expect(identity.kind).toBe('parallel');
      // s5 slice: first 5 hex chars of 'a3f7abcd' → 'a3f7a'
      expect(identity.workerId).toBe('alice-a3f7a');
      expect(identity.sessionUuid).toBe(forcedUuid);
      expect(identity.sessionUuid.startsWith('a3f7a')).toBe(true);

      // Persist the s5 parallel and verify both parallels coexist.
      await registerWorker({
        id: identity.workerId,
        role: identity.workerId,
        team,
        paneId: '%12',
        claudeSessionId: identity.sessionUuid,
      });
    } finally {
      restore();
    }

    const s4 = await registry.get('alice-a3f7');
    const s5 = await registry.get('alice-a3f7a');
    expect(s4?.id).toBe('alice-a3f7');
    expect(s5?.id).toBe('alice-a3f7a');
    const s4Session = await agentSessionId('alice-a3f7');
    const s5Session = await agentSessionId('alice-a3f7a');
    expect(s4Session).not.toBe(s5Session);
  });

  // -----------------------------------------------------------------------
  // (d) Parallels off the auto-resume path.
  //
  // findDeadResumable('alice') must NOT match a parallel row — parallels
  // register role = '<name>-<sN>', so the role-equality filter blocks them.
  // findDeadResumable('alice-a3f7') MUST match that row (full-id resume works).
  // -----------------------------------------------------------------------
  test('(d) findDeadResumable: parallels resumable only by full id', async () => {
    const team = 'alice';
    await seedTemplate('alice', team);

    await registerWorker({
      id: 'alice-a3f7',
      role: 'alice-a3f7',
      team,
      paneId: 'inline', // dead
      claudeSessionId: 'dead-parallel-uuid-0000000000000000aaaa',
    });

    const byCanonical = await findDeadResumable(team, 'alice');
    expect(byCanonical).toBeNull();

    const byFullId = await findDeadResumable(team, 'alice-a3f7');
    expect(byFullId).not.toBeNull();
    expect(byFullId?.id).toBe('alice-a3f7');
    expect(await agentSessionId('alice-a3f7')).toBe('dead-parallel-uuid-0000000000000000aaaa');
  });

  // -----------------------------------------------------------------------
  // (e) Reproducer — spawning `simone` from inside the `genie` tmux session
  //     must resolve to team=simone, NOT team=genie. This is the bug the
  //     four-tier precedence (PR #1134) fixes, now in an integration test.
  //
  // Setup mirrors production:
  //   - agent_templates rows for both `simone` (team=simone) and `genie` (team=genie)
  //   - A stale `~/.claude/teams/genie/config.json` with leadSessionId (the PR #1164
  //     tmux-session-name fallback would otherwise map the caller's genie-tmux
  //     context to team=genie).
  //   - process.env.TMUX set to a genie-named tmux path.
  //
  // Assert: resolveTeamName + resolveSpawnIdentity + registerWorker together
  // produce an agents row with team='simone' and worker name 'simone-simone'.
  // -----------------------------------------------------------------------
  test('(e) reproducer: spawn simone from genie tmux session → team=simone', async () => {
    // Seed both template rows — production carries one per agent after its first spawn.
    await seedDirectoryAgent('simone');
    await seedDirectoryAgent('genie');
    await seedTemplate('simone', 'simone');
    await seedTemplate('genie', 'genie');

    // Seed a stale Claude config that maps session 'stale-genie' → team 'genie'.
    // This is exactly the shape that would drive `discoverTeamName` to return
    // 'genie' if tier 2 (template-pinned team) were skipped.
    const genieTeamDir = join(tempClaudeDir, 'teams', 'genie');
    await mkdir(join(genieTeamDir, 'inboxes'), { recursive: true });
    await writeFile(
      join(genieTeamDir, 'config.json'),
      JSON.stringify({
        name: 'genie',
        description: 'Genie team',
        createdAt: Date.now(),
        leadAgentId: 'team-lead@genie',
        leadSessionId: 'stale-genie-session-id',
        members: [
          {
            agentId: 'team-lead@genie',
            name: 'team-lead',
            agentType: 'general-purpose',
            joinedAt: Date.now(),
            backendType: 'tmux',
            color: 'red',
            planModeRequired: false,
            isActive: true,
          },
        ],
      }),
    );

    // Simulate being inside the genie tmux session.
    process.env.TMUX = '/tmp/tmux-test/genie,1,0';

    // Resolve the agent the way handleWorkerSpawn does.
    const resolved = await directory.resolve('simone');
    expect(resolved).not.toBeNull();
    expect(resolved?.entry.team).toBe('simone'); // template-pinned tier 2

    // Resolve team with NO --team option (no explicit flag). Tier 2 must win
    // over the discover() fallback that would otherwise say 'genie'.
    const team = await resolveTeamName({
      entryTeam: resolved?.entry.team,
      // Real discover would return 'genie' via the PR #1164 tmux-session-name
      // fallback; we pass an explicit stub to prove tier 2 short-circuits it.
      discover: async () => 'genie',
    });
    expect(team).toBe('simone');

    // Run the state machine — no existing row → canonical for simone.
    const identity = await resolveSpawnIdentity('simone', team as string);
    expect(identity.kind).toBe('canonical');
    expect(identity.workerId).toBe('simone');

    // Persist the worker row the way handleWorkerSpawn would.
    await registerWorker({
      id: identity.workerId,
      role: identity.workerId,
      team: team as string,
      paneId: '%1',
      claudeSessionId: identity.sessionUuid,
    });

    // The worker name handleWorkerSpawn assembles: `${team}-${effectiveRole}`.
    const workerName = `${team}-${identity.workerId}`;
    expect(workerName).toBe('simone-simone');

    // Verify the row landed with team='simone'.
    const row = await registry.get('simone');
    expect(row?.team).toBe('simone');
    expect(row?.id).toBe('simone');
  });
});

// ---------------------------------------------------------------------------
// pickParallelShortId — direct invariant coverage (sanity layer on top of
// resolveSpawnIdentity integration above). Covers the s4→s5→s6 cascade from
// a PG-backed collision table, complementing (c) by exercising the helper
// without going through resolveSpawnIdentity's read.
// ---------------------------------------------------------------------------
describe.skipIf(!DB_AVAILABLE)('tui-spawn-dx integration — pickParallelShortId cascade', () => {
  let cleanupSchema: () => Promise<void>;

  beforeAll(async () => {
    cleanupSchema = await setupTestSchema();
  });

  afterAll(async () => {
    await cleanupSchema();
  });

  beforeEach(async () => {
    const { getConnection } = await import('../lib/db.js');
    const sql = await getConnection();
    await sql`TRUNCATE TABLE agents CASCADE`;
  });

  test('cascade s4 → s5 → s6 when both collide', async () => {
    const team = 'cascade-team';
    // Seed canonical + two parallels that collide at s4 AND s5.
    await registry.register({
      id: 'alice',
      paneId: '%1',
      session: team,
      worktree: null,
      startedAt: new Date().toISOString(),
      state: 'idle',
      lastStateChange: new Date().toISOString(),
      repoPath: `/tmp/cascade-${Date.now()}`,
      role: 'alice',
      team,
      provider: 'claude',
    });
    await registry.register({
      id: 'alice-dead',
      paneId: '%2',
      session: team,
      worktree: null,
      startedAt: new Date().toISOString(),
      state: 'idle',
      lastStateChange: new Date().toISOString(),
      repoPath: `/tmp/cascade-s4-${Date.now()}`,
      role: 'alice-dead',
      team,
      provider: 'claude',
    });
    await registry.register({
      id: 'alice-deadb',
      paneId: '%3',
      session: team,
      worktree: null,
      startedAt: new Date().toISOString(),
      state: 'idle',
      lastStateChange: new Date().toISOString(),
      repoPath: `/tmp/cascade-s5-${Date.now()}`,
      role: 'alice-deadb',
      team,
      provider: 'claude',
    });

    const shortId = await pickParallelShortId('alice', team, 'deadbeef-1234-5678-9abc-def012345678');
    expect(shortId).toBe('deadbe');
  });
});
