/**
 * Regression tests for the shared team-lead predicate (issues #1296 / #1298).
 *
 * Both detectors historically used `WHERE role = 'team-lead'` which matched
 * zero rows because `agents.role` stores the agent's identity (e.g.,
 * `'brain'`, `'engineer'`) rather than a role-type. The fix moves the
 * signal onto the `reports_to` parentage FK.
 *
 * These tests seed real PG rows (via `setupTestDatabase`) with roles that
 * are NOT the literal string `'team-lead'`, and assert the detectors
 * still classify them correctly based on parentage — proving the broken
 * role-based predicate is gone and the parentage-based one is in place.
 *
 * The tests run the detectors' default (non-injected) queries so the
 * assertions exercise the actual SQL that ships in production, not a
 * stub.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { getConnection } from '../../../lib/db.js';
import { DB_AVAILABLE, setupTestDatabase } from '../../../lib/test-db.js';
import { createZombieTeamLeadDetector } from '../../pattern-5-zombie-team-lead.js';
import { createTeamUnpushedOrphanedWorktreeDetector } from '../../pattern-9-team-unpushed-orphaned-worktree.js';

describe.skipIf(!DB_AVAILABLE)('shared team-lead predicate (#1296, #1298)', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    const sql = await getConnection();
    await sql`DELETE FROM executors`;
    await sql`DELETE FROM agents`;
    await sql`DELETE FROM teams`;
  });

  async function seedTeamWithLead(params: {
    leadId: string;
    childId: string;
    team: string;
    leadRole?: string;
    leadState?: string;
  }): Promise<void> {
    const sql = await getConnection();
    const leadRole = params.leadRole ?? 'brain';
    const leadState = params.leadState ?? 'idle';
    // `role` is seeded with a realistic identity (NOT the literal
    // 'team-lead') so the assertion demonstrates the predicate does
    // not look at this column.
    await sql`
      INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, team, role)
      VALUES (${params.leadId}, '%1', 'sess', ${leadState}, '/tmp/test', now(), ${params.team}, ${leadRole})
    `;
    await sql`
      INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, team, role, reports_to)
      VALUES (${params.childId}, '%2', 'sess', 'working', '/tmp/test', now(), ${params.team}, 'engineer', ${params.leadId})
    `;
  }

  test('pattern-5 fires on lead identified via reports_to parentage (role="brain", not "team-lead")', async () => {
    await seedTeamWithLead({
      leadId: 'lead-p5',
      childId: 'child-p5',
      team: 'team-p5',
      leadRole: 'brain',
      leadState: 'idle',
    });

    // Default query path — no override. The shared predicate must classify
    // the seeded row as a team-lead via the `reports_to` FK despite
    // `role != 'team-lead'`. No runtime events means last_activity_ms is
    // null, which pattern-5 treats as zombie.
    const detector = createZombieTeamLeadDetector({ idleMinutes: 5 });
    const state = await detector.query();

    expect(state.zombies.length).toBe(1);
    expect(state.zombies[0].lead_agent_id).toBe('lead-p5');
    expect(state.zombies[0].team).toBe('team-p5');
    expect(state.zombies[0].lead_state).toBe('idle');
  });

  test('pattern-5 ignores a lone agent with role="team-lead" but no children via reports_to', async () => {
    const sql = await getConnection();
    // Seed the exact shape the broken predicate used to match: an agent
    // whose `role` column literally equals 'team-lead' but has no
    // children pointing at it via `reports_to`. The fix must exclude it.
    await sql`
      INSERT INTO agents (id, pane_id, session, state, repo_path, started_at, team, role)
      VALUES ('solo-lead', '%3', 'sess', 'idle', '/tmp/test', now(), 'solo-team', 'team-lead')
    `;

    const detector = createZombieTeamLeadDetector({ idleMinutes: 5 });
    const state = await detector.query();

    expect(state.zombies.length).toBe(0);
  });

  test('pattern-9 emits non-null lead_agent_id/lead_state via reports_to parentage', async () => {
    const sql = await getConnection();
    await seedTeamWithLead({
      leadId: 'lead-p9',
      childId: 'child-p9',
      team: 'team-p9',
      leadRole: 'felipe-alpha',
      leadState: 'working',
    });
    await sql`
      INSERT INTO teams (name, repo, base_branch, worktree_path, status)
      VALUES ('team-p9', '/tmp/repo', 'dev', '/tmp/worktree-p9', 'in_progress')
    `;

    // No executor row → last_executor_active_ms is null → treated as idle
    // past threshold. Stub git probe so the detector classifies the row
    // as stalled and we can observe the joined lead_agent_id/lead_state.
    const detector = createTeamUnpushedOrphanedWorktreeDetector({
      idleMinutes: 10,
      gitProbe: async () => ({ ok: true, branch_ahead_count: 3, last_commit_ms: Date.now() - 60_000 }),
    });
    const state = await detector.query();

    expect(state.stalled.length).toBe(1);
    expect(state.stalled[0].row.team_name).toBe('team-p9');
    expect(state.stalled[0].row.lead_agent_id).toBe('lead-p9');
    expect(state.stalled[0].row.lead_state).toBe('working');
  });
});
