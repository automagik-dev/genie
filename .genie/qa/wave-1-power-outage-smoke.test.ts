/**
 * Wave 1 Consolidated Smoke — power-outage recovery rehearsal.
 *
 * Verifies all three Wave 1 surfaces (Group 1 chokepoint extension, Group 2
 * recover verb, Group 3 heal-not-wipe guardrail) work together against an
 * isolated PG database. Models the wish's QA Criterion #2 ('end-to-end
 * recovery') without touching live infrastructure.
 *
 * Run via:
 *   bun test .genie/qa/wave-1-power-outage-smoke.test.ts
 * Or via the launcher:
 *   bash .genie/qa/wave-1-power-outage-smoke.sh
 *
 * Writes JSON evidence to /tmp/genie-recover/wave-1-consolidated-smoke-evidence.json
 * for the qa agent to attach as run artifacts.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as directory from '../../src/lib/agent-directory.js';
import { getConnection, resetConnection } from '../../src/lib/db.js';
import * as executorRegistry from '../../src/lib/executor-registry.js';
import { resolveResumeSessionId } from '../../src/lib/protocol-router.js';
import { DB_AVAILABLE, setupTestDatabase } from '../../src/lib/test-db.js';
import { recoverSurgery } from '../../src/term-commands/agents.js';

interface EvidenceRow {
  step: string;
  group: 1 | 2 | 3;
  pass: boolean;
  detail: unknown;
}

const evidence: EvidenceRow[] = [];
function record(step: string, group: 1 | 2 | 3, pass: boolean, detail: unknown): void {
  evidence.push({ step, group, pass, detail });
}

function templateFor(role: string, team: string): {
  id: string;
  team: string;
  role: string;
  provider: 'claude';
  cwd: string;
  lastSpawnedAt: string;
} {
  return {
    id: `${team}-${role}`,
    team,
    role,
    provider: 'claude',
    cwd: '/tmp',
    lastSpawnedAt: new Date().toISOString(),
  };
}

describe.skipIf(!DB_AVAILABLE)('Wave 1 Consolidated Smoke — power-outage recovery', () => {
  let cleanup: () => Promise<void>;
  let tempBase: string;

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
    tempBase = join(tmpdir(), `wave-1-smoke-${Date.now()}`);
    mkdirSync(tempBase, { recursive: true });
  });

  afterAll(async () => {
    try {
      mkdirSync('/tmp/genie-recover', { recursive: true });
      const summary = {
        when: new Date().toISOString(),
        suite: 'wave-1-consolidated-smoke',
        worktree: process.cwd(),
        total: evidence.length,
        passed: evidence.filter((e) => e.pass).length,
        failed: evidence.filter((e) => !e.pass).length,
        rows: evidence,
        verdict: evidence.every((e) => e.pass) ? 'GREEN' : 'RED',
      };
      writeFileSync(
        '/tmp/genie-recover/wave-1-consolidated-smoke-evidence.json',
        JSON.stringify(summary, null, 2),
      );
    } catch {
      /* best-effort */
    }
    try {
      rmSync(tempBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    await cleanup();
  });

  beforeEach(async () => {
    const sql = await getConnection();
    await sql`DELETE FROM agents`;
    await sql`DELETE FROM executors`;
    await sql`DELETE FROM audit_events WHERE created_at > now() - interval '1 hour'`;
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async function seedMasterDirRow(
    name: string,
    opts: { team: string; repoPath: string; autoResume?: boolean },
  ): Promise<void> {
    const sql = await getConnection();
    await sql`
      INSERT INTO agents (id, role, custom_name, team, repo_path, started_at, auto_resume, state)
      VALUES (
        ${`dir:${name}`}, ${name}, ${name}, ${opts.team}, ${opts.repoPath},
        now(), ${opts.autoResume ?? true}, ${null}
      )
    `;
  }

  async function seedExecutorWithSession(agentId: string, sessionId: string): Promise<string> {
    return await executorRegistry.createAndLinkExecutor(agentId, 'claude', 'tmux', {
      claudeSessionId: sessionId,
      state: 'idle',
    });
  }

  async function seedStaleSpawning(agentId: string, ageMin = 10): Promise<string> {
    const sql = await getConnection();
    const rows = await sql<{ id: string }[]>`
      INSERT INTO executors (id, agent_id, provider, transport, state, started_at, claude_session_id)
      VALUES (
        gen_random_uuid()::text, ${agentId}, 'claude', 'tmux', 'spawning',
        now() - (${ageMin} * interval '1 minute'), NULL
      )
      RETURNING id
    `;
    return rows[0].id;
  }

  // ---------------------------------------------------------------------------
  // Group 1 — chokepoint dir-fallback
  // ---------------------------------------------------------------------------

  describe('Group 1 — resolveResumeSessionId fallback', () => {
    test('master-with-uuid: dir:<name> + executor anchor → returns sessionId', async () => {
      const sessionId = 'aaaaaaaa-1111-1111-1111-111111111111';
      await seedMasterDirRow('test-master-with-uuid', {
        team: 'team-smoke',
        repoPath: tempBase,
      });
      await seedExecutorWithSession('dir:test-master-with-uuid', sessionId);

      const result = await resolveResumeSessionId(
        null,
        templateFor('test-master-with-uuid', 'team-smoke'),
        'test-master-with-uuid',
      );
      const pass = result === sessionId;
      record('group1.master_with_uuid_returns_session', 1, pass, { expected: sessionId, got: result });
      expect(result).toBe(sessionId);
    });

    test('master-jsonl-only: executor null, scanner returns UUID via injected dep', async () => {
      const recoveredSessionId = 'bbbbbbbb-2222-2222-2222-222222222222';
      const projectDir = join(tempBase, 'jsonl-only');
      mkdirSync(projectDir, { recursive: true });

      await seedMasterDirRow('test-master-jsonl-only', {
        team: 'team-smoke',
        repoPath: projectDir,
      });
      // No executor seeded — DB happy path misses; jsonl scanner takes over.
      executorRegistry._resumeJsonlScannerDeps.scanForSession = async (cwd, identity) => {
        if (
          cwd === projectDir &&
          identity?.team === 'team-smoke' &&
          identity?.customName === 'test-master-jsonl-only'
        ) {
          return recoveredSessionId;
        }
        return null;
      };

      try {
        const result = await resolveResumeSessionId(
          null,
          templateFor('test-master-jsonl-only', 'team-smoke'),
          'test-master-jsonl-only',
        );
        const pass = result === recoveredSessionId;
        record('group1.master_jsonl_only_returns_session', 1, pass, {
          expected: recoveredSessionId,
          got: result,
        });
        expect(result).toBe(recoveredSessionId);
      } finally {
        executorRegistry._resumeJsonlScannerDeps.scanForSession = null;
      }
    });

    test('master-empty: no executor, no jsonl → returns undefined (graceful fail)', async () => {
      await seedMasterDirRow('test-master-empty', {
        team: 'team-smoke',
        repoPath: join(tempBase, 'empty'),
      });

      const result = await resolveResumeSessionId(
        null,
        templateFor('test-master-empty', 'team-smoke'),
        'test-master-empty',
      );
      const pass = result === undefined;
      record('group1.master_empty_returns_undefined', 1, pass, { got: result });
      expect(result).toBeUndefined();
    });

    test('ephemeral: no dir:<name> row → returns undefined (no false-positive resume)', async () => {
      const result = await resolveResumeSessionId(
        null,
        templateFor('test-eph', 'team-smoke'),
        'test-eph',
      );
      const pass = result === undefined;
      record('group1.ephemeral_returns_undefined', 1, pass, { got: result });
      expect(result).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Group 3 — heal-not-wipe guardrail
  // ---------------------------------------------------------------------------

  describe('Group 3 — directory.rm guardrail', () => {
    test('refuses to delete kind=permanent + repo_path master row', async () => {
      await seedMasterDirRow('test-master-with-uuid', {
        team: 'team-smoke',
        repoPath: tempBase,
      });

      let threw = false;
      let message = '';
      try {
        await directory.rm('test-master-with-uuid');
      } catch (err) {
        threw = true;
        message = err instanceof Error ? err.message : String(err);
      }
      record('group3.rm_throws_on_master', 3, threw, { message });
      expect(threw).toBe(true);
      expect(message).toContain('Refused to delete master agent row');
      expect(message).toContain('genie agent recover');

      // Row still present.
      const sql = await getConnection();
      const rows = await sql`SELECT id FROM agents WHERE id = 'dir:test-master-with-uuid'`;
      const preserved = rows.length === 1;
      record('group3.row_preserved_after_throw', 3, preserved, { rowsAfter: rows.length });
      expect(preserved).toBe(true);
    });

    test('audit event directory.rm.refused lands with reason=protected_master_row', async () => {
      await seedMasterDirRow('audit-master', {
        team: 'team-smoke',
        repoPath: tempBase,
      });

      try {
        await directory.rm('audit-master');
      } catch {
        /* expected */
      }

      // Group 3 fix e18aa20e awaits the audit event before throwing — the
      // INSERT lands BEFORE control returns. No setTimeout grace window
      // needed here.
      const sql = await getConnection();
      const events = await sql<{ event_type: string; details: Record<string, unknown> }[]>`
        SELECT event_type, details FROM audit_events
        WHERE entity_id = 'dir:audit-master' AND event_type = 'directory.rm.refused'
        ORDER BY created_at DESC LIMIT 1
      `;
      const landed = events.length === 1 && events[0].details.reason === 'protected_master_row';
      record('group3.audit_event_lands_with_reason', 3, landed, { events });
      expect(landed).toBe(true);
    });

    test('explicitPermanent=true bypasses the guardrail', async () => {
      await seedMasterDirRow('escape-hatch', {
        team: 'team-smoke',
        repoPath: tempBase,
      });

      const result = await directory.rm('escape-hatch', { explicitPermanent: true });
      record('group3.escape_hatch_removes', 3, result.removed, result);
      expect(result.removed).toBe(true);

      const sql = await getConnection();
      const rows = await sql`SELECT id FROM agents WHERE id = 'dir:escape-hatch'`;
      expect(rows.length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Group 2 — recover verb (PG surgery half)
  // ---------------------------------------------------------------------------

  describe('Group 2 — recoverSurgery', () => {
    test('flips auto_resume + terminates stale spawning + surfaces session via DB anchor', async () => {
      const sessionId = 'cccccccc-3333-3333-3333-333333333333';
      await seedMasterDirRow('test-recover', {
        team: 'team-smoke',
        repoPath: tempBase,
        autoResume: false,
      });
      const staleId = await seedStaleSpawning('dir:test-recover', 10);
      await seedExecutorWithSession('dir:test-recover', sessionId);

      const surgery = await recoverSurgery('dir:test-recover');
      const pass =
        surgery.flippedAutoResume === true &&
        surgery.staleSpawningTerminated >= 1 &&
        surgery.sessionId === sessionId;
      record('group2.surgery_full_recovery', 2, pass, surgery);
      expect(surgery.flippedAutoResume).toBe(true);
      expect(surgery.staleSpawningTerminated).toBeGreaterThanOrEqual(1);
      expect(surgery.sessionId).toBe(sessionId);

      // Stale executor row updated to terminated + recovery_anchor.
      const sql = await getConnection();
      const stale = await sql<{ state: string; close_reason: string | null }[]>`
        SELECT state, close_reason FROM executors WHERE id = ${staleId}
      `;
      const staleProperlyTerminated =
        stale.length === 1 &&
        stale[0].state === 'terminated' &&
        stale[0].close_reason === 'recovery_anchor';
      record('group2.stale_terminated_with_recovery_anchor', 2, staleProperlyTerminated, stale);
      expect(staleProperlyTerminated).toBe(true);
    });

    test('idempotent: second call is a no-op (auto_resume already true, no spawning to kill)', async () => {
      const sessionId = 'dddddddd-4444-4444-4444-444444444444';
      await seedMasterDirRow('test-recover-idem', {
        team: 'team-smoke',
        repoPath: tempBase,
        autoResume: false,
      });
      await seedExecutorWithSession('dir:test-recover-idem', sessionId);

      // First call — flips auto_resume.
      await recoverSurgery('dir:test-recover-idem');

      // Second call — should be no-op.
      const second = await recoverSurgery('dir:test-recover-idem');
      const pass =
        second.flippedAutoResume === false &&
        second.staleSpawningTerminated === 0 &&
        second.sessionId === sessionId;
      record('group2.surgery_idempotent_second_call', 2, pass, second);
      expect(second.flippedAutoResume).toBe(false);
      expect(second.staleSpawningTerminated).toBe(0);
      expect(second.sessionId).toBe(sessionId);
    });
  });

  // ---------------------------------------------------------------------------
  // Cross-group integration: simulated power-outage rehearsal
  // ---------------------------------------------------------------------------

  describe('cross-group: simulated power-outage rehearsal', () => {
    test('full chain: seed master → simulate restart → surgery → spawn-path picks up UUID', async () => {
      const sessionId = 'eeeeeeee-5555-5555-5555-555555555555';

      // Seed: master with stale spawning, auto_resume=false (post-outage state).
      await seedMasterDirRow('rehearsal-master', {
        team: 'team-rehearsal',
        repoPath: join(tempBase, 'rehearsal'),
        autoResume: false,
      });
      await seedStaleSpawning('dir:rehearsal-master', 10);
      await seedExecutorWithSession('dir:rehearsal-master', sessionId);

      // Simulate process restart by resetting the in-memory connection pool.
      // Real serve restart re-builds the pool; this exercises the cold-start path.
      await resetConnection();

      // Operator runs `genie agent recover rehearsal-master`.
      const surgery = await recoverSurgery('dir:rehearsal-master');
      expect(surgery.flippedAutoResume).toBe(true);
      expect(surgery.sessionId).toBe(sessionId);

      // Team-lead "hires" the master — spawn-path consults chokepoint.
      const resumed = await resolveResumeSessionId(
        null,
        templateFor('rehearsal-master', 'team-rehearsal'),
        'rehearsal-master',
      );
      const pass = resumed === sessionId;
      record('rehearsal.full_chain_resumes_with_canonical_uuid', 1, pass, {
        surgery,
        resumed,
        expected: sessionId,
      });
      expect(resumed).toBe(sessionId);
    });
  });
});
