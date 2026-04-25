/**
 * Executor Registry — Comprehensive Tests
 *
 * Covers: CRUD, state transitions, concurrent guard, pane/session lookup,
 * integration lifecycle (agent → executor → assignment → respawn), and edge cases.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { findOrCreateAgent, getAgent, getAgentEffectiveState, setCurrentExecutor } from './agent-registry.js';
import { completeAssignment, createAssignment, getActiveAssignment } from './assignment-registry.js';
import { getConnection } from './db.js';
import {
  type CreateExecutorOpts,
  _resumeJsonlScannerDeps,
  createAndLinkExecutor,
  createExecutor,
  findExecutorByPane,
  findExecutorBySession,
  getCurrentExecutor,
  getExecutor,
  getLiveExecutorState,
  getResumeSessionId,
  isExecutorAlive,
  listExecutors,
  recordResumeProviderRejected,
  terminateActiveExecutor,
  terminateExecutor,
  updateClaudeSessionId,
  updateExecutorState,
} from './executor-registry.js';
import type { ExecutorState } from './executor-types.js';
import { DB_AVAILABLE, setupTestDatabase } from './test-db.js';

describe.skipIf(!DB_AVAILABLE)('executor-registry', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    const sql = await getConnection();
    await sql`DELETE FROM assignments`;
    await sql`DELETE FROM executors`;
    await sql`DELETE FROM agents`;
    await sql`DELETE FROM audit_events WHERE event_type LIKE 'resume.%'`;
  });

  /** Helper: create an agent and return its ID. */
  async function seedAgent(name = 'eng', team = 'test-team', role = 'engineer') {
    const agent = await findOrCreateAgent(name, team, role);
    return agent.id;
  }

  // ==========================================================================
  // CRUD
  // ==========================================================================

  describe('createExecutor', () => {
    test('creates with minimal args and returns spawning state', async () => {
      const agentId = await seedAgent();
      const exec = await createExecutor(agentId, 'claude', 'tmux');

      expect(exec.id).toBeTruthy();
      expect(exec.agentId).toBe(agentId);
      expect(exec.provider).toBe('claude');
      expect(exec.transport).toBe('tmux');
      expect(exec.state).toBe('spawning');
      expect(exec.pid).toBeNull();
      expect(exec.tmuxSession).toBeNull();
      expect(exec.tmuxPaneId).toBeNull();
      expect(exec.endedAt).toBeNull();
      expect(exec.metadata).toEqual({});
    });

    test('creates with all optional fields populated', async () => {
      const agentId = await seedAgent();
      const opts: CreateExecutorOpts = {
        id: 'custom-exec-id',
        pid: 54321,
        tmuxSession: 'genie',
        tmuxPaneId: '%42',
        tmuxWindow: 'engineer',
        tmuxWindowId: '@7',
        claudeSessionId: 'session-abc-123',
        state: 'running',
        metadata: { model: 'opus', flags: ['--verbose'] },
        worktree: '/tmp/worktree',
        repoPath: '/home/genie/project',
        paneColor: '#ff5500',
      };

      const exec = await createExecutor(agentId, 'claude', 'tmux', opts);

      expect(exec.id).toBe('custom-exec-id');
      expect(exec.pid).toBe(54321);
      expect(exec.tmuxSession).toBe('genie');
      expect(exec.tmuxPaneId).toBe('%42');
      expect(exec.tmuxWindow).toBe('engineer');
      expect(exec.tmuxWindowId).toBe('@7');
      expect(exec.claudeSessionId).toBe('session-abc-123');
      expect(exec.state).toBe('running');
      expect(exec.metadata).toEqual({ model: 'opus', flags: ['--verbose'] });
      expect(exec.worktree).toBe('/tmp/worktree');
      expect(exec.repoPath).toBe('/home/genie/project');
      expect(exec.paneColor).toBe('#ff5500');
    });

    test('creates codex executor with api transport and null PID', async () => {
      const agentId = await seedAgent();
      const exec = await createExecutor(agentId, 'codex', 'api', {
        metadata: { sandbox_id: 'sb-123', task_url: 'https://api.codex.io/tasks/123' },
      });

      expect(exec.provider).toBe('codex');
      expect(exec.transport).toBe('api');
      expect(exec.pid).toBeNull();
      expect(exec.tmuxSession).toBeNull();
      expect(exec.metadata).toEqual({ sandbox_id: 'sb-123', task_url: 'https://api.codex.io/tasks/123' });
    });

    test('generates UUID if id not provided', async () => {
      const agentId = await seedAgent();
      const e1 = await createExecutor(agentId, 'claude', 'tmux');
      const e2 = await createExecutor(agentId, 'claude', 'tmux');
      expect(e1.id).not.toBe(e2.id);
      // UUID format
      expect(e1.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    test('metadata JSONB round-trips complex objects', async () => {
      const agentId = await seedAgent();
      const metadata = {
        model: 'opus',
        flags: ['--verbose', '--debug'],
        nested: { timeout: 30000, retries: 3 },
        tags: null,
      };
      const exec = await createExecutor(agentId, 'claude', 'tmux', { metadata });
      const fetched = await getExecutor(exec.id);
      expect(fetched!.metadata).toEqual(metadata);
    });

    test('sets timestamps on creation', async () => {
      const before = new Date().toISOString();
      const agentId = await seedAgent();
      const exec = await createExecutor(agentId, 'claude', 'tmux');
      const after = new Date().toISOString();

      expect(exec.startedAt >= before).toBe(true);
      expect(exec.startedAt <= after).toBe(true);
      expect(exec.createdAt >= before).toBe(true);
    });
  });

  describe('getExecutor', () => {
    test('returns executor by ID', async () => {
      const agentId = await seedAgent();
      const exec = await createExecutor(agentId, 'claude', 'tmux', { pid: 9999 });
      const fetched = await getExecutor(exec.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(exec.id);
      expect(fetched!.pid).toBe(9999);
    });

    test('returns null for nonexistent ID', async () => {
      expect(await getExecutor('does-not-exist')).toBeNull();
    });
  });

  describe('getCurrentExecutor', () => {
    test('returns current executor via agent FK', async () => {
      const agentId = await seedAgent();
      const exec = await createExecutor(agentId, 'claude', 'tmux');
      await setCurrentExecutor(agentId, exec.id);

      const current = await getCurrentExecutor(agentId);
      expect(current).not.toBeNull();
      expect(current!.id).toBe(exec.id);
    });

    test('returns null when agent has no current executor', async () => {
      const agentId = await seedAgent();
      expect(await getCurrentExecutor(agentId)).toBeNull();
    });

    test('returns null for nonexistent agent', async () => {
      expect(await getCurrentExecutor('ghost-agent')).toBeNull();
    });

    test('tracks executor switch correctly', async () => {
      const agentId = await seedAgent();
      const e1 = await createExecutor(agentId, 'claude', 'tmux');
      const e2 = await createExecutor(agentId, 'claude', 'tmux');

      await setCurrentExecutor(agentId, e1.id);
      expect((await getCurrentExecutor(agentId))!.id).toBe(e1.id);

      await setCurrentExecutor(agentId, e2.id);
      expect((await getCurrentExecutor(agentId))!.id).toBe(e2.id);
    });
  });

  describe('listExecutors', () => {
    test('lists all executors', async () => {
      const a1 = await seedAgent('eng1', 'team1');
      const a2 = await seedAgent('eng2', 'team1');
      await createExecutor(a1, 'claude', 'tmux');
      await createExecutor(a2, 'codex', 'api');

      const all = await listExecutors();
      expect(all.length).toBe(2);
    });

    test('filters by agent ID', async () => {
      const a1 = await seedAgent('eng1', 'team1');
      const a2 = await seedAgent('eng2', 'team1');
      await createExecutor(a1, 'claude', 'tmux');
      await createExecutor(a1, 'claude', 'tmux');
      await createExecutor(a2, 'codex', 'api');

      const filtered = await listExecutors(a1);
      expect(filtered.length).toBe(2);
      expect(filtered.every((e) => e.agentId === a1)).toBe(true);
    });

    test('returns empty array when no executors', async () => {
      expect(await listExecutors()).toEqual([]);
    });

    test('returns in descending started_at order', async () => {
      const agentId = await seedAgent();
      const e1 = await createExecutor(agentId, 'claude', 'tmux');
      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 10));
      const e2 = await createExecutor(agentId, 'claude', 'tmux');

      const list = await listExecutors(agentId);
      expect(list[0].id).toBe(e2.id); // Newest first
      expect(list[1].id).toBe(e1.id);
    });

    test('filters by metadata source', async () => {
      const a1 = await seedAgent('omni-agent', 'team1');
      const a2 = await seedAgent('cli-agent', 'team1');
      await createExecutor(a1, 'claude', 'api', { metadata: { source: 'omni', chat_id: 'c1' } });
      await createExecutor(a2, 'claude', 'tmux');
      await createExecutor(a2, 'claude', 'tmux', { metadata: { source: 'cli' } });

      const omniOnly = await listExecutors(undefined, 'omni');
      expect(omniOnly.length).toBe(1);
      expect(omniOnly[0].agentId).toBe(a1);
      expect(omniOnly[0].metadata).toEqual({ source: 'omni', chat_id: 'c1' });

      const cliOnly = await listExecutors(undefined, 'cli');
      expect(cliOnly.length).toBe(1);
      expect(cliOnly[0].agentId).toBe(a2);

      // No source returns all
      const all = await listExecutors();
      expect(all.length).toBe(3);
    });

    test('filters by both agent ID and source', async () => {
      const a1 = await seedAgent('multi-agent', 'team1');
      await createExecutor(a1, 'claude', 'api', { metadata: { source: 'omni', chat_id: 'c1' } });
      await createExecutor(a1, 'claude', 'tmux');

      const filtered = await listExecutors(a1, 'omni');
      expect(filtered.length).toBe(1);
      expect(filtered[0].metadata).toEqual({ source: 'omni', chat_id: 'c1' });

      // Agent filter alone returns both
      const allForAgent = await listExecutors(a1);
      expect(allForAgent.length).toBe(2);
    });
  });

  // ==========================================================================
  // Finder Functions
  // ==========================================================================

  describe('findExecutorByPane', () => {
    test('finds by exact pane ID', async () => {
      const agentId = await seedAgent();
      await createExecutor(agentId, 'claude', 'tmux', { tmuxPaneId: '%42' });

      const found = await findExecutorByPane('%42');
      expect(found).not.toBeNull();
      expect(found!.tmuxPaneId).toBe('%42');
    });

    test('normalizes pane ID without % prefix', async () => {
      const agentId = await seedAgent();
      await createExecutor(agentId, 'claude', 'tmux', { tmuxPaneId: '%42' });

      const found = await findExecutorByPane('42');
      expect(found).not.toBeNull();
      expect(found!.tmuxPaneId).toBe('%42');
    });

    test('returns null for nonexistent pane', async () => {
      expect(await findExecutorByPane('%999')).toBeNull();
    });
  });

  describe('findExecutorBySession', () => {
    test('finds by claude session ID', async () => {
      const agentId = await seedAgent();
      await createExecutor(agentId, 'claude', 'tmux', { claudeSessionId: 'sess-abc' });

      const found = await findExecutorBySession('sess-abc');
      expect(found).not.toBeNull();
      expect(found!.claudeSessionId).toBe('sess-abc');
    });

    test('returns null for nonexistent session', async () => {
      expect(await findExecutorBySession('sess-nonexistent')).toBeNull();
    });
  });

  // ==========================================================================
  // getResumeSessionId — single-reader chokepoint for resume decisions
  // ==========================================================================

  describe('getResumeSessionId', () => {
    async function latestAuditForAgent(agentId: string, eventType: string) {
      const sql = await getConnection();
      const rows = await sql<{ event_type: string; details: Record<string, unknown>; created_at: string }[]>`
        SELECT event_type, details, created_at
        FROM audit_events
        WHERE entity_type = 'agent' AND entity_id = ${agentId} AND event_type = ${eventType}
        ORDER BY id DESC
        LIMIT 1
      `;
      return rows[0] ?? null;
    }

    test('happy path: returns session from current executor and emits resume.found', async () => {
      const agentId = await seedAgent();
      const exec = await createExecutor(agentId, 'claude', 'tmux', { claudeSessionId: 'sess-happy' });
      await setCurrentExecutor(agentId, exec.id);

      const sessionId = await getResumeSessionId(agentId);
      expect(sessionId).toBe('sess-happy');

      const event = await latestAuditForAgent(agentId, 'resume.found');
      expect(event).not.toBeNull();
      expect(event!.details.executorId).toBe(exec.id);
      expect(event!.details.sessionId).toBe('sess-happy');
    });

    test('no current executor: returns null and emits resume.missing_session (no_executor)', async () => {
      const agentId = await seedAgent();
      // No executor assigned → current_executor_id is null

      const sessionId = await getResumeSessionId(agentId);
      expect(sessionId).toBeNull();

      const event = await latestAuditForAgent(agentId, 'resume.missing_session');
      expect(event).not.toBeNull();
      expect(event!.details.reason).toBe('no_executor');
    });

    test('executor without session: returns null and emits resume.missing_session (null_session)', async () => {
      const agentId = await seedAgent();
      const exec = await createExecutor(agentId, 'claude', 'tmux'); // no claudeSessionId
      await setCurrentExecutor(agentId, exec.id);

      const sessionId = await getResumeSessionId(agentId);
      expect(sessionId).toBeNull();

      const event = await latestAuditForAgent(agentId, 'resume.missing_session');
      expect(event).not.toBeNull();
      expect(event!.details.reason).toBe('null_session');
      expect(event!.details.executorId).toBe(exec.id);
    });

    test('multiple prior executors: only the current executor counts', async () => {
      const agentId = await seedAgent();

      // Three historical executors with different sessions
      const e1 = await createExecutor(agentId, 'claude', 'tmux', { claudeSessionId: 'sess-old-1' });
      await updateExecutorState(e1.id, 'terminated');
      const e2 = await createExecutor(agentId, 'claude', 'tmux', { claudeSessionId: 'sess-old-2' });
      await updateExecutorState(e2.id, 'done');

      // Current executor has its own session
      const eCurrent = await createExecutor(agentId, 'claude', 'tmux', {
        claudeSessionId: 'sess-current',
      });
      await setCurrentExecutor(agentId, eCurrent.id);

      const sessionId = await getResumeSessionId(agentId);
      expect(sessionId).toBe('sess-current');

      const event = await latestAuditForAgent(agentId, 'resume.found');
      expect(event!.details.executorId).toBe(eCurrent.id);
      expect(event!.details.sessionId).toBe('sess-current');
    });

    test('returns null for unknown agent and emits resume.missing_session', async () => {
      const sessionId = await getResumeSessionId('00000000-0000-0000-0000-000000000000');
      expect(sessionId).toBeNull();

      const event = await latestAuditForAgent('00000000-0000-0000-0000-000000000000', 'resume.missing_session');
      expect(event).not.toBeNull();
      expect(event!.details.reason).toBe('no_executor');
    });

    test('picks up session written after executor creation via updateClaudeSessionId', async () => {
      const agentId = await seedAgent();
      const exec = await createExecutor(agentId, 'claude', 'tmux');
      await setCurrentExecutor(agentId, exec.id);

      expect(await getResumeSessionId(agentId)).toBeNull();

      await updateClaudeSessionId(exec.id, 'sess-late');

      const sessionId = await getResumeSessionId(agentId);
      expect(sessionId).toBe('sess-late');
    });

    // ========================================================================
    // JSONL fallback — last-resort recovery after host crash / reconciler
    // nullified `current_executor_id`. The conversation JSONL on disk is the
    // durable artifact and `claude --resume <uuid>` works on it directly.
    // ========================================================================

    describe('JSONL fallback (post-crash recovery)', () => {
      async function seedAgentWithCwd(cwd: string, name = 'eng', team = 'test-team') {
        const agentId = await seedAgent(name, team);
        const sql = await getConnection();
        await sql`UPDATE agents SET repo_path = ${cwd} WHERE id = ${agentId}`;
        return agentId;
      }

      // Reset the scanner override after each fallback test so the rest of
      // the suite stays on the real-fs path (which yields null in CI cwds).
      const resetScanner = () => {
        _resumeJsonlScannerDeps.scanForSession = null;
      };

      test('no executor + JSONL exists: recovers session and emits resume.recovered_via_jsonl', async () => {
        const cwd = '/tmp/crash-recovery-fixture';
        const recoveredUuid = '11111111-2222-3333-4444-555555555555';

        try {
          const agentId = await seedAgentWithCwd(cwd, 'crash-eng', 'crash-team');
          // No executor assigned — simulates the post-host-crash state where
          // reconciler nulled current_executor_id.

          _resumeJsonlScannerDeps.scanForSession = async (scannedCwd, identity) => {
            expect(scannedCwd).toBe(cwd);
            expect(identity).not.toBeNull();
            expect(identity!.team).toBe('crash-team');
            expect(identity!.customName).toBe('crash-eng');
            return recoveredUuid;
          };

          const sessionId = await getResumeSessionId(agentId);
          expect(sessionId).toBe(recoveredUuid);

          const event = await latestAuditForAgent(agentId, 'resume.recovered_via_jsonl');
          expect(event).not.toBeNull();
          expect(event!.details.sessionId).toBe(recoveredUuid);
          expect(event!.details.cwd).toBe(cwd);
          expect(event!.details.team).toBe('crash-team');
          expect(event!.details.customName).toBe('crash-eng');
          expect(event!.details.recoveredFrom).toBe('no_executor');

          // The fallback path must NOT emit resume.missing_session.
          const miss = await latestAuditForAgent(agentId, 'resume.missing_session');
          expect(miss).toBeNull();
        } finally {
          resetScanner();
        }
      });

      test('null-session executor + JSONL exists: recovers and tags recoveredFrom=null_session', async () => {
        const cwd = '/tmp/null-session-fixture';
        const recoveredUuid = '99999999-aaaa-bbbb-cccc-dddddddddddd';
        _resumeJsonlScannerDeps.scanForSession = async () => recoveredUuid;

        try {
          const agentId = await seedAgentWithCwd(cwd, 'null-eng', 'null-team');
          const exec = await createExecutor(agentId, 'claude', 'tmux'); // no claudeSessionId
          await setCurrentExecutor(agentId, exec.id);

          const sessionId = await getResumeSessionId(agentId);
          expect(sessionId).toBe(recoveredUuid);

          const event = await latestAuditForAgent(agentId, 'resume.recovered_via_jsonl');
          expect(event).not.toBeNull();
          expect(event!.details.recoveredFrom).toBe('null_session');
          expect(event!.details.executorId).toBe(exec.id);
        } finally {
          resetScanner();
        }
      });

      test('no executor + no JSONL on disk: still emits resume.missing_session (no_executor)', async () => {
        const cwd = '/tmp/no-jsonl-fixture';
        _resumeJsonlScannerDeps.scanForSession = async () => null;

        try {
          const agentId = await seedAgentWithCwd(cwd, 'gone-eng', 'gone-team');

          const sessionId = await getResumeSessionId(agentId);
          expect(sessionId).toBeNull();

          const event = await latestAuditForAgent(agentId, 'resume.missing_session');
          expect(event).not.toBeNull();
          expect(event!.details.reason).toBe('no_executor');

          const recovered = await latestAuditForAgent(agentId, 'resume.recovered_via_jsonl');
          expect(recovered).toBeNull();
        } finally {
          resetScanner();
        }
      });

      test('agent with no repo_path: skips JSONL scan entirely', async () => {
        let scannerCalls = 0;
        _resumeJsonlScannerDeps.scanForSession = async () => {
          scannerCalls++;
          return 'should-never-be-returned';
        };

        try {
          // seedAgent does NOT set repo_path (findOrCreateAgent identity-only).
          const agentId = await seedAgent();

          const sessionId = await getResumeSessionId(agentId);
          expect(sessionId).toBeNull();
          expect(scannerCalls).toBe(0); // scanner never invoked when cwd is null

          const event = await latestAuditForAgent(agentId, 'resume.missing_session');
          expect(event).not.toBeNull();
          expect(event!.details.reason).toBe('no_executor');
        } finally {
          resetScanner();
        }
      });

      test('agent with cwd but null custom_name: scanner refuses (identity unknown)', async () => {
        // Legacy rows / partially-seeded agents where custom_name is NULL.
        // Returning newest JSONL would attach this agent to whatever
        // happened to be most-recent in the project dir — cross-agent
        // context corruption. Strict refusal is the right behavior; the
        // outer caller emits resume.missing_session.
        const cwd = '/tmp/null-customname-fixture';
        let scannerCalls = 0;
        _resumeJsonlScannerDeps.scanForSession = async () => {
          scannerCalls++;
          return 'never-returned';
        };

        try {
          const agentId = await seedAgent('legacy-eng', 'legacy-team');
          const sql = await getConnection();
          await sql`UPDATE agents SET repo_path = ${cwd}, custom_name = NULL WHERE id = ${agentId}`;

          const sessionId = await getResumeSessionId(agentId);
          expect(sessionId).toBeNull();
          expect(scannerCalls).toBe(0); // gate fired before reaching scanner

          const event = await latestAuditForAgent(agentId, 'resume.missing_session');
          expect(event).not.toBeNull();
        } finally {
          resetScanner();
        }
      });

      test('scanner receives team-prefixed identity match (genie-genie case)', async () => {
        // Regression: pre-fix code compared customTitle to bare custom_name,
        // missing the canonical "<team>-<role>" pattern Claude workers use.
        // The new contract passes structured (team, customName) to the
        // scanner so the scanner can match (teamName, agentName) pulled
        // from JSONL body lines correctly.
        const cwd = '/tmp/genie-genie-fixture';
        const captured: { team: string | null; customName: string | null } = {
          team: null,
          customName: null,
        };

        _resumeJsonlScannerDeps.scanForSession = async (_cwd, identity) => {
          captured.team = identity?.team ?? null;
          captured.customName = identity?.customName ?? null;
          return 'recovered-genie-uuid';
        };

        try {
          const agentId = await seedAgentWithCwd(cwd, 'genie', 'genie');

          const sessionId = await getResumeSessionId(agentId);
          expect(sessionId).toBe('recovered-genie-uuid');
          expect(captured.team).toBe('genie');
          expect(captured.customName).toBe('genie');
        } finally {
          resetScanner();
        }
      });
    });
  });

  describe('recordResumeProviderRejected', () => {
    test('emits resume.provider_rejected with sessionId and reason', async () => {
      const agentId = await seedAgent();

      await recordResumeProviderRejected(agentId, 'sess-rejected', 'provider_404');

      const sql = await getConnection();
      const rows = await sql<{ details: Record<string, unknown> }[]>`
        SELECT details FROM audit_events
        WHERE entity_type = 'agent'
          AND entity_id = ${agentId}
          AND event_type = 'resume.provider_rejected'
        ORDER BY id DESC
        LIMIT 1
      `;
      expect(rows.length).toBe(1);
      expect(rows[0].details.sessionId).toBe('sess-rejected');
      expect(rows[0].details.reason).toBe('provider_404');
    });
  });

  // ==========================================================================
  // State Transitions
  // ==========================================================================

  describe('updateExecutorState', () => {
    test('transitions through normal lifecycle', async () => {
      const agentId = await seedAgent();
      const exec = await createExecutor(agentId, 'claude', 'tmux');
      expect((await getExecutor(exec.id))!.state).toBe('spawning');

      await updateExecutorState(exec.id, 'running');
      expect((await getExecutor(exec.id))!.state).toBe('running');

      await updateExecutorState(exec.id, 'idle');
      expect((await getExecutor(exec.id))!.state).toBe('idle');

      await updateExecutorState(exec.id, 'working');
      expect((await getExecutor(exec.id))!.state).toBe('working');

      await updateExecutorState(exec.id, 'done');
      const done = (await getExecutor(exec.id))!;
      expect(done.state).toBe('done');
      expect(done.endedAt).not.toBeNull();
    });

    test('sets ended_at for terminal states: done, error, terminated', async () => {
      const agentId = await seedAgent();

      // done
      const e1 = await createExecutor(agentId, 'claude', 'tmux');
      await updateExecutorState(e1.id, 'done');
      expect((await getExecutor(e1.id))!.endedAt).not.toBeNull();

      // error
      const e2 = await createExecutor(agentId, 'claude', 'tmux');
      await updateExecutorState(e2.id, 'error');
      expect((await getExecutor(e2.id))!.endedAt).not.toBeNull();

      // terminated
      const e3 = await createExecutor(agentId, 'claude', 'tmux');
      await updateExecutorState(e3.id, 'terminated');
      expect((await getExecutor(e3.id))!.endedAt).not.toBeNull();
    });

    test('does NOT set ended_at for non-terminal states', async () => {
      const agentId = await seedAgent();
      const nonTerminal: ExecutorState[] = ['running', 'idle', 'working', 'permission', 'question'];

      for (const state of nonTerminal) {
        const exec = await createExecutor(agentId, 'claude', 'tmux');
        await updateExecutorState(exec.id, state);
        const updated = (await getExecutor(exec.id))!;
        expect(updated.endedAt).toBeNull();
      }
    });

    test('supports permission and question states', async () => {
      const agentId = await seedAgent();
      const exec = await createExecutor(agentId, 'claude', 'tmux');

      await updateExecutorState(exec.id, 'permission');
      expect((await getExecutor(exec.id))!.state).toBe('permission');

      await updateExecutorState(exec.id, 'question');
      expect((await getExecutor(exec.id))!.state).toBe('question');
    });
  });

  // ==========================================================================
  // Termination
  // ==========================================================================

  describe('terminateExecutor', () => {
    test('sets state to terminated and ended_at', async () => {
      const agentId = await seedAgent();
      const exec = await createExecutor(agentId, 'claude', 'tmux', { state: 'working' });

      await terminateExecutor(exec.id);
      const terminated = (await getExecutor(exec.id))!;
      expect(terminated.state).toBe('terminated');
      expect(terminated.endedAt).not.toBeNull();
    });

    test('is idempotent — no-op on already terminated', async () => {
      const agentId = await seedAgent();
      const exec = await createExecutor(agentId, 'claude', 'tmux', { state: 'working' });
      await terminateExecutor(exec.id);
      const firstEnd = (await getExecutor(exec.id))!.endedAt;

      // Second call — should not throw or change ended_at
      await terminateExecutor(exec.id);
      const secondEnd = (await getExecutor(exec.id))!.endedAt;
      expect(secondEnd).toBe(firstEnd);
    });

    test('skips executors already in done state', async () => {
      const agentId = await seedAgent();
      const exec = await createExecutor(agentId, 'claude', 'tmux', { state: 'working' });
      await updateExecutorState(exec.id, 'done');
      const doneEnd = (await getExecutor(exec.id))!.endedAt;

      await terminateExecutor(exec.id);
      // State should remain done, not switch to terminated
      const after = (await getExecutor(exec.id))!;
      expect(after.state).toBe('done');
      expect(after.endedAt).toBe(doneEnd);
    });
  });

  describe('terminateActiveExecutor', () => {
    test('terminates current executor and nulls FK', async () => {
      const agentId = await seedAgent();
      const exec = await createExecutor(agentId, 'claude', 'tmux', { state: 'working' });
      await setCurrentExecutor(agentId, exec.id);

      await terminateActiveExecutor(agentId);

      expect((await getExecutor(exec.id))!.state).toBe('terminated');
      expect((await getAgent(agentId))!.currentExecutorId).toBeNull();
    });

    test('no-op when agent has no current executor', async () => {
      const agentId = await seedAgent();
      await terminateActiveExecutor(agentId); // Should not throw
    });

    test('no-op for nonexistent agent', async () => {
      await terminateActiveExecutor('ghost-agent'); // Should not throw
    });
  });

  // ==========================================================================
  // Concurrent Executor Guard
  // ==========================================================================

  describe('concurrent executor guard', () => {
    test('terminate old → spawn new → same agent identity', async () => {
      const agentId = await seedAgent();

      // First executor
      const e1 = await createExecutor(agentId, 'claude', 'tmux', {
        pid: 1001,
        state: 'working',
      });
      await setCurrentExecutor(agentId, e1.id);

      // Guard: terminate before respawn
      await terminateActiveExecutor(agentId);
      expect((await getExecutor(e1.id))!.state).toBe('terminated');
      expect((await getAgent(agentId))!.currentExecutorId).toBeNull();

      // Second executor for same agent
      const e2 = await createExecutor(agentId, 'claude', 'tmux', {
        pid: 2002,
        state: 'spawning',
      });
      await setCurrentExecutor(agentId, e2.id);

      // Verify
      expect((await getCurrentExecutor(agentId))!.id).toBe(e2.id);
      expect((await getAgent(agentId))!.currentExecutorId).toBe(e2.id);

      // Both executors exist for the same agent
      const history = await listExecutors(agentId);
      expect(history.length).toBe(2);
    });

    test('no orphaned executors after concurrent spawn', async () => {
      const agentId = await seedAgent();

      // Simulate 3 rapid respawns
      for (let i = 0; i < 3; i++) {
        await terminateActiveExecutor(agentId);
        const exec = await createExecutor(agentId, 'claude', 'tmux', {
          pid: 1000 + i,
        });
        await setCurrentExecutor(agentId, exec.id);
      }

      const all = await listExecutors(agentId);
      expect(all.length).toBe(3);

      // Only one should be non-terminated
      const active = all.filter((e) => e.state !== 'terminated');
      expect(active.length).toBe(1);
      expect(active[0].pid).toBe(1002);
    });
  });

  // ==========================================================================
  // Agent Effective State
  // ==========================================================================

  describe('agent effective state', () => {
    test('derives state from current executor', async () => {
      const agentId = await seedAgent();
      const exec = await createExecutor(agentId, 'claude', 'tmux', { state: 'working' });
      await setCurrentExecutor(agentId, exec.id);

      expect(await getAgentEffectiveState(agentId)).toBe('working');
    });

    test('returns offline when no executor', async () => {
      const agentId = await seedAgent();
      expect(await getAgentEffectiveState(agentId)).toBe('offline');
    });

    test('updates as executor state changes', async () => {
      const agentId = await seedAgent();
      const exec = await createExecutor(agentId, 'claude', 'tmux');
      await setCurrentExecutor(agentId, exec.id);

      expect(await getAgentEffectiveState(agentId)).toBe('spawning');
      await updateExecutorState(exec.id, 'running');
      expect(await getAgentEffectiveState(agentId)).toBe('running');
      await updateExecutorState(exec.id, 'idle');
      expect(await getAgentEffectiveState(agentId)).toBe('idle');
    });

    test('returns executor state even when terminated', async () => {
      const agentId = await seedAgent();
      const exec = await createExecutor(agentId, 'claude', 'tmux');
      await setCurrentExecutor(agentId, exec.id);
      await updateExecutorState(exec.id, 'terminated');

      // Still returns the executor state (terminated), not offline
      // because the FK still points to the executor
      expect(await getAgentEffectiveState(agentId)).toBe('terminated');
    });

    test('returns offline after active executor nulled', async () => {
      const agentId = await seedAgent();
      const exec = await createExecutor(agentId, 'claude', 'tmux');
      await setCurrentExecutor(agentId, exec.id);
      await terminateActiveExecutor(agentId);

      // FK is now null → offline
      expect(await getAgentEffectiveState(agentId)).toBe('offline');
    });
  });

  // ==========================================================================
  // Integration: Full Lifecycle
  // ==========================================================================

  describe('integration: full lifecycle', () => {
    test('spawn → assign → complete → respawn → reassign → same agent', async () => {
      // 1. Create agent identity
      const agent = await findOrCreateAgent('engineer-1', 'alpha', 'engineer');
      expect(agent.currentExecutorId).toBeNull();

      // 2. First executor spawn
      const exec1 = await createExecutor(agent.id, 'claude', 'tmux', {
        pid: 5001,
        tmuxSession: 'genie',
        tmuxPaneId: '%10',
        state: 'spawning',
      });
      await setCurrentExecutor(agent.id, exec1.id);
      await updateExecutorState(exec1.id, 'running');

      // 3. Assign task
      const assignment1 = await createAssignment(exec1.id, 'task-101', 'my-wish', 1);
      expect(assignment1.executorId).toBe(exec1.id);

      // 4. Complete task
      await completeAssignment(assignment1.id, 'completed');
      await updateExecutorState(exec1.id, 'done');

      // Verify agent identity persists
      const agentAfterFirst = await getAgent(agent.id);
      expect(agentAfterFirst!.currentExecutorId).toBe(exec1.id);

      // 5. Respawn: terminate old, create new
      await terminateActiveExecutor(agent.id);
      const exec2 = await createExecutor(agent.id, 'claude', 'tmux', {
        pid: 5002,
        tmuxSession: 'genie',
        tmuxPaneId: '%11',
        state: 'spawning',
      });
      await setCurrentExecutor(agent.id, exec2.id);
      await updateExecutorState(exec2.id, 'working');

      // 6. Same agent, new executor
      expect((await getAgent(agent.id))!.currentExecutorId).toBe(exec2.id);
      expect(await getAgentEffectiveState(agent.id)).toBe('working');

      // 7. New assignment on new executor
      const assignment2 = await createAssignment(exec2.id, 'task-102', 'my-wish', 2);
      expect((await getActiveAssignment(exec2.id))!.id).toBe(assignment2.id);

      // 8. Verify executor history for agent
      const history = await listExecutors(agent.id);
      expect(history.length).toBe(2);

      // 9. Agent identity unchanged
      const finalAgent = await findOrCreateAgent('engineer-1', 'alpha');
      expect(finalAgent.id).toBe(agent.id);
    });

    test('codex spawn without tmux', async () => {
      const agent = await findOrCreateAgent('codex-worker', 'beta', 'engineer');

      // Codex has no PID, no tmux
      const exec = await createExecutor(agent.id, 'codex', 'api', {
        metadata: { sandbox_id: 'sb-456' },
      });
      await setCurrentExecutor(agent.id, exec.id);

      expect(exec.pid).toBeNull();
      expect(exec.tmuxSession).toBeNull();
      expect(exec.tmuxPaneId).toBeNull();
      expect(exec.transport).toBe('api');

      await updateExecutorState(exec.id, 'working');
      expect(await getAgentEffectiveState(agent.id)).toBe('working');
    });

    test('executor cascade delete cleans up assignments', async () => {
      const agentId = await seedAgent();
      const exec = await createExecutor(agentId, 'claude', 'tmux');
      const assignment = await createAssignment(exec.id, 'task-1');

      // Delete executor — assignments should cascade
      const sql = await getConnection();
      await sql`DELETE FROM executors WHERE id = ${exec.id}`;

      // Assignment should be gone due to ON DELETE CASCADE
      const sql2 = await getConnection();
      const rows = await sql2`SELECT * FROM assignments WHERE id = ${assignment.id}`;
      expect(rows.length).toBe(0);
    });

    test('agent cascade delete cleans up executors and assignments', async () => {
      const agent = await findOrCreateAgent('temp-agent', 'cleanup-team');
      const exec = await createExecutor(agent.id, 'claude', 'tmux');
      await createAssignment(exec.id, 'task-1');

      // Need to clear the FK before deleting
      await setCurrentExecutor(agent.id, null);

      const sql = await getConnection();
      await sql`DELETE FROM agents WHERE id = ${agent.id}`;

      // Executor and assignment should be gone via cascade
      expect(await getExecutor(exec.id)).toBeNull();
      expect(await listExecutors(agent.id)).toEqual([]);
    });
  });

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe('edge cases', () => {
    test('executor with empty metadata', async () => {
      const agentId = await seedAgent();
      const exec = await createExecutor(agentId, 'claude', 'tmux', { metadata: {} });
      expect((await getExecutor(exec.id))!.metadata).toEqual({});
    });

    test('multiple executors with same pane ID (reuse after termination)', async () => {
      const agentId = await seedAgent();
      const e1 = await createExecutor(agentId, 'claude', 'tmux', { tmuxPaneId: '%42' });
      await terminateExecutor(e1.id);

      // Re-use the same pane ID (new tmux pane got the same ID)
      const e2 = await createExecutor(agentId, 'claude', 'tmux', { tmuxPaneId: '%42' });

      // findExecutorByPane may return either — both have %42
      const found = await findExecutorByPane('%42');
      expect(found).not.toBeNull();
      // At least one exists
      expect([e1.id, e2.id]).toContain(found!.id);
    });

    test('process transport for future headless executors', async () => {
      const agentId = await seedAgent();
      const exec = await createExecutor(agentId, 'claude', 'process', {
        pid: 99999,
      });
      expect(exec.transport).toBe('process');
      expect(exec.pid).toBe(99999);
    });

    test('many executors for same agent (history grows)', async () => {
      const agentId = await seedAgent();
      for (let i = 0; i < 10; i++) {
        await createExecutor(agentId, 'claude', 'tmux', { pid: 3000 + i });
      }
      const all = await listExecutors(agentId);
      expect(all.length).toBe(10);
    });

    test('state transition from spawning directly to error', async () => {
      const agentId = await seedAgent();
      const exec = await createExecutor(agentId, 'claude', 'tmux');
      expect(exec.state).toBe('spawning');

      await updateExecutorState(exec.id, 'error');
      const errored = (await getExecutor(exec.id))!;
      expect(errored.state).toBe('error');
      expect(errored.endedAt).not.toBeNull();
    });

    test('create executor with pre-generated ID is deterministic', async () => {
      const agentId = await seedAgent();
      const exec = await createExecutor(agentId, 'claude', 'tmux', { id: 'fixed-id-123' });
      expect(exec.id).toBe('fixed-id-123');
      expect((await getExecutor('fixed-id-123'))!.provider).toBe('claude');
    });
  });

  // ==========================================================================
  // Migration Integrity
  // ==========================================================================

  describe('migration integrity', () => {
    /** Query columns for a table in the test DB's `public` schema. */
    async function getColumns(table: string, filter?: string) {
      const sql = await getConnection();
      if (filter) {
        return sql`
          SELECT column_name FROM information_schema.columns
          WHERE table_name = ${table} AND table_schema = 'public'
          AND column_name IN ${sql(filter.split(','))}
          ORDER BY column_name
        `;
      }
      return sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = ${table} AND table_schema = 'public'
        ORDER BY ordinal_position
      `;
    }

    test('executors table exists with correct columns', async () => {
      const cols = await getColumns('executors');
      const names = cols.map((c: { column_name: string }) => c.column_name);
      expect(names).toContain('id');
      expect(names).toContain('agent_id');
      expect(names).toContain('provider');
      expect(names).toContain('transport');
      expect(names).toContain('pid');
      expect(names).toContain('tmux_session');
      expect(names).toContain('tmux_pane_id');
      expect(names).toContain('state');
      expect(names).toContain('metadata');
      expect(names).toContain('started_at');
      expect(names).toContain('ended_at');
      expect(names).toContain('created_at');
      expect(names).toContain('updated_at');
    });

    test('assignments table exists with correct columns', async () => {
      const cols = await getColumns('assignments');
      const names = cols.map((c: { column_name: string }) => c.column_name);
      expect(names).toContain('id');
      expect(names).toContain('executor_id');
      expect(names).toContain('task_id');
      expect(names).toContain('wish_slug');
      expect(names).toContain('group_number');
      expect(names).toContain('outcome');
      expect(names).toContain('started_at');
      expect(names).toContain('ended_at');
    });

    test('agents table has current_executor_id FK', async () => {
      const cols = await getColumns('agents', 'current_executor_id');
      expect(cols.length).toBe(1);
    });

    test('agents table has reports_to and title columns', async () => {
      const cols = await getColumns('agents', 'reports_to,title');
      const names = cols.map((c: { column_name: string }) => c.column_name);
      expect(names).toContain('reports_to');
      expect(names).toContain('title');
    });

    test('executor state CHECK constraint enforced', async () => {
      const agentId = await seedAgent();
      const sql = await getConnection();

      try {
        await sql`INSERT INTO executors (id, agent_id, provider, transport, state)
                  VALUES ('bad-exec', ${agentId}, 'claude', 'tmux', 'invalid_state')`;
        // Should not reach here
        expect(true).toBe(false);
      } catch (e: unknown) {
        // Constraint violation expected
        expect((e as Error).message).toContain('check');
      }
    });

    test('transport CHECK constraint enforced', async () => {
      const agentId = await seedAgent();
      const sql = await getConnection();

      try {
        await sql`INSERT INTO executors (id, agent_id, provider, transport, state)
                  VALUES ('bad-exec', ${agentId}, 'claude', 'invalid_transport', 'spawning')`;
        expect(true).toBe(false);
      } catch (e: unknown) {
        expect((e as Error).message).toContain('check');
      }
    });

    test('assignment outcome CHECK constraint enforced', async () => {
      const agentId = await seedAgent();
      const exec = await createExecutor(agentId, 'claude', 'tmux');
      const sql = await getConnection();

      try {
        await sql`INSERT INTO assignments (id, executor_id, task_id, outcome)
                  VALUES ('bad-assign', ${exec.id}, 'task-1', 'invalid_outcome')`;
        expect(true).toBe(false);
      } catch (e: unknown) {
        expect((e as Error).message).toContain('check');
      }
    });

    test('indexes exist on executors table', async () => {
      const sql = await getConnection();
      const indexes = await sql`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'executors' AND schemaname = 'public'
      `;
      const names = indexes.map((i: { indexname: string }) => i.indexname);
      expect(names).toContain('idx_executors_agent_id');
      expect(names).toContain('idx_executors_state');
      expect(names).toContain('idx_executors_provider');
    });
  });

  // ==========================================================================
  // Atomic Create + Link (createAndLinkExecutor)
  // ==========================================================================

  describe('createAndLinkExecutor', () => {
    test('creates executor and sets current_executor_id atomically', async () => {
      const agentId = await seedAgent();
      const exec = await createAndLinkExecutor(agentId, 'claude', 'tmux', {
        pid: 7001,
        tmuxSession: 'genie',
        tmuxPaneId: '%50',
      });

      expect(exec.id).toBeTruthy();
      expect(exec.agentId).toBe(agentId);
      expect(exec.pid).toBe(7001);
      expect(exec.state).toBe('spawning');

      // FK should be set in the same transaction
      const agent = await getAgent(agentId);
      expect(agent!.currentExecutorId).toBe(exec.id);
    });

    test('linked executor is returned by getCurrentExecutor', async () => {
      const agentId = await seedAgent();
      const exec = await createAndLinkExecutor(agentId, 'claude', 'tmux');

      const current = await getCurrentExecutor(agentId);
      expect(current).not.toBeNull();
      expect(current!.id).toBe(exec.id);
    });

    test('replaces previous FK when called again', async () => {
      const agentId = await seedAgent();
      const e1 = await createAndLinkExecutor(agentId, 'claude', 'tmux', { pid: 8001 });
      const e2 = await createAndLinkExecutor(agentId, 'claude', 'tmux', { pid: 8002 });

      // FK now points to e2
      const agent = await getAgent(agentId);
      expect(agent!.currentExecutorId).toBe(e2.id);

      // Both executors exist in history
      const history = await listExecutors(agentId);
      expect(history.length).toBe(2);
      expect(history.map((e) => e.id)).toContain(e1.id);
      expect(history.map((e) => e.id)).toContain(e2.id);
    });

    test('accepts all CreateExecutorOpts', async () => {
      const agentId = await seedAgent();
      const exec = await createAndLinkExecutor(agentId, 'claude', 'tmux', {
        id: 'linked-exec-id',
        pid: 9001,
        tmuxSession: 'genie',
        tmuxPaneId: '%99',
        tmuxWindow: 'test-window',
        state: 'running',
        metadata: { key: 'value' },
        repoPath: '/tmp/repo',
      });

      expect(exec.id).toBe('linked-exec-id');
      expect(exec.state).toBe('running');
      expect(exec.metadata).toEqual({ key: 'value' });
    });

    test('no orphaned executor if agent does not exist', async () => {
      // Inserting an executor for a non-existent agent should fail the FK constraint
      // and the transaction should roll back both the INSERT and UPDATE
      try {
        await createAndLinkExecutor('nonexistent-agent', 'claude', 'tmux');
        expect(true).toBe(false); // Should not reach
      } catch {
        // Expected — FK violation
      }

      // No executor should have been created
      const all = await listExecutors();
      expect(all.length).toBe(0);
    });
  });

  // ==========================================================================
  // Atomic terminateActiveExecutor (WHERE current_executor_id = $id)
  // ==========================================================================

  describe('terminateActiveExecutor atomicity', () => {
    test('only nulls FK if still pointing to the same executor', async () => {
      const agentId = await seedAgent();
      const e1 = await createAndLinkExecutor(agentId, 'claude', 'tmux', { state: 'working' });

      // Simulate a concurrent spawn: e2 takes over the FK before terminate runs
      const e2 = await createAndLinkExecutor(agentId, 'claude', 'tmux', { state: 'spawning' });

      // Now terminate e1 — the FK should NOT be nulled since it points to e2
      const sql = await getConnection();
      await terminateExecutor(e1.id);
      await sql`UPDATE agents SET current_executor_id = NULL WHERE id = ${agentId} AND current_executor_id = ${e1.id}`;

      // FK should still point to e2
      const agent = await getAgent(agentId);
      expect(agent!.currentExecutorId).toBe(e2.id);
    });

    test('concurrent terminate + spawn does not orphan new executor', async () => {
      const agentId = await seedAgent();

      // Simulate rapid terminate + respawn cycles
      for (let i = 0; i < 5; i++) {
        await terminateActiveExecutor(agentId);
        await createAndLinkExecutor(agentId, 'claude', 'tmux', { pid: 2000 + i });
      }

      const all = await listExecutors(agentId);
      expect(all.length).toBe(5);

      // Only the last one should be non-terminated (previous 4 terminated by guard)
      const active = all.filter((e) => e.state !== 'terminated');
      expect(active.length).toBe(1);
      expect(active[0].pid).toBe(2004);

      // FK points to the last executor
      const agent = await getAgent(agentId);
      expect(agent!.currentExecutorId).toBe(active[0].id);
    });
  });

  // ==========================================================================
  // getLiveExecutorState / isExecutorAlive — liveness + display state for
  // non-tmux transports (SDK, omni, process).
  //
  // Regression for `genie ls` showing SDK/omni-bridge agents as 'offline' while
  // actively running. Tmux liveness (isPaneAlive) stays authoritative for tmux
  // agents; `executors.state` is the authoritative source for everything else,
  // and is returned directly so the display doesn't fall back to the stale
  // `agents.state` column.
  // ==========================================================================

  describe('getLiveExecutorState', () => {
    test('returns the executor state for each live state', async () => {
      const liveStates: ExecutorState[] = ['spawning', 'running', 'working', 'idle', 'permission', 'question'];
      for (const state of liveStates) {
        const agentId = await seedAgent(`state-${state}`, 'live-team');
        await createAndLinkExecutor(agentId, 'claude-sdk', 'process', { state });
        expect(await getLiveExecutorState(agentId)).toBe(state);
      }
    });

    test('returns null for terminal states (done / error / terminated)', async () => {
      const terminalStates: ExecutorState[] = ['done', 'error', 'terminated'];
      for (const terminal of terminalStates) {
        const agentId = await seedAgent(`terminal-${terminal}`, 'terminal-team');
        const exec = await createAndLinkExecutor(agentId, 'claude-sdk', 'process', { state: 'running' });
        await updateExecutorState(exec.id, terminal);
        expect(await getLiveExecutorState(agentId)).toBeNull();
      }
    });

    test('returns null when agent has no current executor', async () => {
      const agentId = await seedAgent();
      expect(await getLiveExecutorState(agentId)).toBeNull();
    });

    test('returns null for nonexistent agent', async () => {
      expect(await getLiveExecutorState('ghost-agent')).toBeNull();
    });

    test('tracks live → terminated transition', async () => {
      const agentId = await seedAgent();
      const exec = await createAndLinkExecutor(agentId, 'claude-sdk', 'process', { state: 'working' });
      expect(await getLiveExecutorState(agentId)).toBe('working');

      await updateExecutorState(exec.id, 'done');
      expect(await getLiveExecutorState(agentId)).toBeNull();
    });

    test('works for process transport (SDK) with null pane id', async () => {
      // Simulates the real bug: SDK agents register with paneId='sdk',
      // omni auto-spawn with paneId=''. Neither matches /^%\d+$/ so
      // isPaneAlive falsely reports offline. getLiveExecutorState bypasses that
      // and returns the authoritative executor state.
      const agentId = await seedAgent();
      await createAndLinkExecutor(agentId, 'claude-sdk', 'process', {
        state: 'working',
        tmuxPaneId: null,
      });
      expect(await getLiveExecutorState(agentId)).toBe('working');
    });
  });

  describe('isExecutorAlive', () => {
    test('returns true when current executor is running', async () => {
      const agentId = await seedAgent();
      await createAndLinkExecutor(agentId, 'claude-sdk', 'process', { state: 'running' });
      expect(await isExecutorAlive(agentId)).toBe(true);
    });

    test('returns true for each live state (working/idle/permission/question/spawning)', async () => {
      const liveStates: ExecutorState[] = ['spawning', 'running', 'working', 'idle', 'permission', 'question'];
      for (const state of liveStates) {
        const agentId = await seedAgent(`agent-${state}`, 'live-team');
        await createAndLinkExecutor(agentId, 'claude-sdk', 'process', { state });
        expect(await isExecutorAlive(agentId)).toBe(true);
      }
    });

    test('returns false when current executor is terminated', async () => {
      const agentId = await seedAgent();
      const exec = await createAndLinkExecutor(agentId, 'claude-sdk', 'process', { state: 'running' });
      await updateExecutorState(exec.id, 'terminated');
      expect(await isExecutorAlive(agentId)).toBe(false);
    });

    test('returns false for done / error terminal states', async () => {
      const agent1 = await seedAgent('done-agent', 'terminal-team');
      const e1 = await createAndLinkExecutor(agent1, 'claude-sdk', 'process', { state: 'running' });
      await updateExecutorState(e1.id, 'done');
      expect(await isExecutorAlive(agent1)).toBe(false);

      const agent2 = await seedAgent('error-agent', 'terminal-team');
      const e2 = await createAndLinkExecutor(agent2, 'claude-sdk', 'process', { state: 'running' });
      await updateExecutorState(e2.id, 'error');
      expect(await isExecutorAlive(agent2)).toBe(false);
    });

    test('returns false when agent has no current executor', async () => {
      const agentId = await seedAgent();
      expect(await isExecutorAlive(agentId)).toBe(false);
    });

    test('returns false for nonexistent agent', async () => {
      expect(await isExecutorAlive('ghost-agent')).toBe(false);
    });

    test('tracks live → terminated transition', async () => {
      const agentId = await seedAgent();
      const exec = await createAndLinkExecutor(agentId, 'claude-sdk', 'process', { state: 'working' });
      expect(await isExecutorAlive(agentId)).toBe(true);

      await updateExecutorState(exec.id, 'done');
      expect(await isExecutorAlive(agentId)).toBe(false);
    });

    test('works for process transport (SDK) with empty/synthetic pane ids', async () => {
      // Simulates the real bug: SDK agents register with paneId='sdk',
      // omni auto-spawn with paneId=''. Neither matches /^%\d+$/ so
      // isPaneAlive falsely reports offline. isExecutorAlive bypasses that.
      const agentId = await seedAgent();
      await createAndLinkExecutor(agentId, 'claude-sdk', 'process', {
        state: 'working',
        tmuxPaneId: null,
      });
      expect(await isExecutorAlive(agentId)).toBe(true);
    });
  });
});
