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
import { DB_AVAILABLE, setupTestSchema } from '../lib/test-db.js';
import * as wishState from '../lib/wish-state.js';
import {
  buildInitialSplitWindowCommand,
  buildResumeContext,
  resolveAgentWorkingDir,
  resolveTeamName,
} from './agents.js';

let cwd: string;

describe.skipIf(!DB_AVAILABLE)('pg', () => {
  let cleanupSchema: () => Promise<void>;

  beforeAll(async () => {
    cleanupSchema = await setupTestSchema();
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
    cleanupSchema = await setupTestSchema();
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
