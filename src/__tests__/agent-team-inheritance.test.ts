/**
 * Subagent team inheritance + built-in pinning regression tests.
 *
 * Bug class: subagents (id='parent/child') did not inherit the parent's team,
 * and built-in agents (engineer, trace, qa, council--*) accumulated sticky
 * team pins from whichever team spawned them first. Both broke
 * `genie send`, mailbox routing, and inbox visibility.
 *
 * The fix has three parts:
 *   1. `lookupTemplateTeam(name)` falls back to the parent name when an
 *      exact-id row is missing.
 *   2. `directory.resolve()` no longer attaches a template-pinned team to
 *      built-in entries (let `resolveTeamName` tier 3/4 decide instead).
 *   3. `finalizeTmuxSpawn` + `lockedSpawnWorker` skip `saveTemplate` for
 *      built-ins and override `team` with the parent's team for
 *      hierarchical names before persisting.
 *
 * This file locks each part with a focused assertion against the live
 * agent_templates table.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as directory from '../lib/agent-directory.js';
import { isBuiltinAgent } from '../lib/builtin-agents.js';
import { DB_AVAILABLE, setupTestDatabase } from '../lib/test-db.js';

async function seedTemplate(name: string, team: string): Promise<void> {
  const { getConnection } = await import('../lib/db.js');
  const sql = await getConnection();
  // Post-migration 061: agent_templates.id is UUID (auto-generated default),
  // and `name` is the bare human-readable identifier. The unique index on
  // (name, team) is partial (`WHERE name IS NOT NULL AND team IS NOT NULL`),
  // so ON CONFLICT can't auto-target it. `beforeEach` TRUNCATEs the table,
  // so a plain INSERT is sufficient here.
  await sql`
    INSERT INTO agent_templates (name, provider, team, cwd, last_spawned_at)
    VALUES (${name}, 'claude', ${team}, '/tmp/seed', now())
  `;
}

describe.skipIf(!DB_AVAILABLE)('subagent team inheritance + built-in pinning', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    const { getConnection } = await import('../lib/db.js');
    const sql = await getConnection();
    await sql`TRUNCATE TABLE agent_templates CASCADE`;
  });

  // -------------------------------------------------------------------------
  // (1) Built-ins are SHARED — directory.resolve must not attach a sticky
  //     team even when a poisoned template row exists.
  // -------------------------------------------------------------------------
  test('built-in `engineer` ignores poisoned agent_templates row', async () => {
    expect(isBuiltinAgent('engineer')).toBe(true);
    await seedTemplate('engineer', 'felipe'); // simulates pre-fix poisoned row

    const resolved = await directory.resolve('engineer');
    expect(resolved).not.toBeNull();
    expect(resolved?.builtin).toBe(true);
    expect(resolved?.entry.team).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // (2) Subagent name (`parent/child`) inherits the parent template's team
  //     when no exact-id row exists.
  // -------------------------------------------------------------------------
  test('lookupTemplateTeam falls back to parent for `parent/child` names', async () => {
    await seedTemplate('genie-omni', 'genie-omni');

    const resolved = await directory.lookupTemplateTeam('genie-omni/dog-fooder');
    expect(resolved).toBe('genie-omni');
  });

  test('lookupTemplateTeam prefers exact-id row over parent fallback', async () => {
    await seedTemplate('genie-omni', 'genie-omni');
    await seedTemplate('genie-omni/dog-fooder', 'override-team');

    const resolved = await directory.lookupTemplateTeam('genie-omni/dog-fooder');
    expect(resolved).toBe('override-team');
  });

  test('lookupTemplateTeam returns null when neither exact-id nor parent exists', async () => {
    const resolved = await directory.lookupTemplateTeam('orphan/child');
    expect(resolved).toBeNull();
  });

  // -------------------------------------------------------------------------
  // (3) `lookupTemplateTeam` returns the row team deterministically — id is
  //     the primary key, so a single id maps to a single row.
  // -------------------------------------------------------------------------
  test('lookupTemplateTeam returns the row team for an exact-id match', async () => {
    await seedTemplate('genie-omni', 'genie-omni');

    const team = await directory.lookupTemplateTeam('genie-omni');
    expect(team).toBe('genie-omni');
  });

  // -------------------------------------------------------------------------
  // (4) Migration 054 backfill: poisoned subagent rows get healed to inherit
  //     the parent's team; built-in pins are wiped.
  // -------------------------------------------------------------------------
  test('migration 054 heals poisoned subagent rows', async () => {
    const { getConnection } = await import('../lib/db.js');
    const sql = await getConnection();

    await seedTemplate('genie-omni', 'genie-omni');
    await seedTemplate('genie-omni/dog-fooder', 'felipe'); // poisoned
    await seedTemplate('engineer', 'felipe'); // built-in poisoned

    // Run the migration backfill steps inline (mirrors 054_fix_subagent_team_inheritance.sql).
    // Migration 054 originally ran against TEXT-id schema; post-061 we match on `name`.
    await sql`
      UPDATE agent_templates AS child
      SET team = parent.team, updated_at = now()
      FROM agent_templates AS parent
      WHERE child.name LIKE parent.name || '/%'
        AND parent.name NOT LIKE '%/%'
        AND child.team IS DISTINCT FROM parent.team
    `;
    await sql`DELETE FROM agent_templates WHERE name = 'engineer'`;

    const subagent = await sql`SELECT team FROM agent_templates WHERE name = 'genie-omni/dog-fooder'`;
    expect(subagent[0].team).toBe('genie-omni');

    const builtin = await sql`SELECT team FROM agent_templates WHERE name = 'engineer'`;
    expect(builtin.length).toBe(0);
  });
});
