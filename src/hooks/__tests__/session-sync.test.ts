import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _deps, _resetSyncedSessions, _setCacheFileForTest, sessionSync } from '../handlers/session-sync.js';
import type { HookPayload } from '../types.js';

/**
 * session-sync is fire-and-forget and must NEVER throw — PreToolUse is a
 * blocking event, so a crash would deny the tool use. These tests verify
 * the no-op paths (missing context, test env) return cleanly without I/O,
 * and that the `session.reconciled` audit event fires on — and only on —
 * the UUID-changed branch (Gap 2 of the loop-2 review).
 */
describe('session-sync handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    // G7 — parent shell exports GENIE_AGENT_ID when tests run inside a spawned
    // agent context. Clear it so legacy tests exercise the (name, team)
    // fallback path; new tests opt into the id path explicitly.
    process.env.GENIE_AGENT_ID = undefined;
    _resetSyncedSessions();
    _deps.getAgent = null;
    _deps.getAgentByName = null;
    _deps.getExecutor = null;
    _deps.updateClaudeSessionId = null;
    _deps.emitAuditEvent = null;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    _resetSyncedSessions();
    _deps.getAgent = null;
    _deps.getAgentByName = null;
    _deps.getExecutor = null;
    _deps.updateClaudeSessionId = null;
    _deps.emitAuditEvent = null;
  });

  test('no-op when session_id is missing', async () => {
    const payload: HookPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
    };
    const result = await sessionSync(payload);
    expect(result).toBeUndefined();
  });

  test('no-op in test env even with full payload', async () => {
    process.env.NODE_ENV = 'test';
    process.env.GENIE_AGENT_NAME = 'worker';
    process.env.GENIE_TEAM = 'alpha';
    const payload: HookPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      session_id: 'abc-123',
    };
    const result = await sessionSync(payload);
    expect(result).toBeUndefined();
  });

  test('no-op when agent name cannot be resolved', async () => {
    process.env.NODE_ENV = 'production';
    process.env.BUN_ENV = 'production';
    process.env.GENIE_AGENT_NAME = undefined;
    process.env.GENIE_TEAM = undefined;
    const payload: HookPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      session_id: 'abc-123',
    };
    const result = await sessionSync(payload);
    expect(result).toBeUndefined();
  });

  test('never throws on non-string session_id', async () => {
    process.env.GENIE_AGENT_NAME = 'worker';
    process.env.GENIE_TEAM = 'alpha';
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      session_id: 12345 as unknown as string,
    } as HookPayload;
    const result = await sessionSync(payload);
    expect(result).toBeUndefined();
  });

  describe('session.reconciled audit event (Gap 2)', () => {
    type Emission = { type: string; entityId: string; actor: string | null; details: Record<string, unknown> };

    function installMocks(options: {
      executorId: string;
      currentSessionId: string | null;
      executorState?: string | null;
      updates?: { id: string; sessionId: string }[];
      emissions?: Emission[];
    }) {
      const updates = options.updates ?? [];
      const emissions = options.emissions ?? [];
      _deps.getAgentByName = async () => ({ currentExecutorId: options.executorId });
      _deps.getExecutor = async () => ({
        claudeSessionId: options.currentSessionId,
        state: options.executorState ?? 'running',
      });
      _deps.updateClaudeSessionId = async (id, sid) => {
        updates.push({ id, sessionId: sid });
      };
      _deps.emitAuditEvent = async (_entityType, entityId, type, actor, details) => {
        emissions.push({ type, entityId, actor, details });
      };
      return { updates, emissions };
    }

    test('emits session.reconciled when stored UUID differs from payload UUID', async () => {
      process.env.GENIE_AGENT_NAME = 'worker';
      process.env.GENIE_TEAM = 'alpha';

      const { updates, emissions } = installMocks({
        executorId: 'exec-1',
        currentSessionId: 'old-uuid',
      });

      await sessionSync({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        session_id: 'new-uuid',
      });

      expect(updates).toEqual([{ id: 'exec-1', sessionId: 'new-uuid' }]);
      expect(emissions).toHaveLength(1);
      expect(emissions[0]?.type).toBe('session.reconciled');
      expect(emissions[0]?.entityId).toBe('exec-1');
      expect(emissions[0]?.actor).toBe('worker');
      expect(emissions[0]?.details.old_session_id).toBe('old-uuid');
      expect(emissions[0]?.details.new_session_id).toBe('new-uuid');
      expect(emissions[0]?.details.team).toBe('alpha');
    });

    test('emits session.reconciled when executor had no prior session', async () => {
      process.env.GENIE_AGENT_NAME = 'worker';
      process.env.GENIE_TEAM = 'alpha';

      const { emissions } = installMocks({
        executorId: 'exec-2',
        currentSessionId: null,
      });

      await sessionSync({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        session_id: 'first-uuid',
      });

      expect(emissions).toHaveLength(1);
      expect(emissions[0]?.type).toBe('session.reconciled');
      expect(emissions[0]?.details.old_session_id).toBeNull();
      expect(emissions[0]?.details.new_session_id).toBe('first-uuid');
    });

    test('does NOT emit when payload UUID matches stored UUID', async () => {
      process.env.GENIE_AGENT_NAME = 'worker';
      process.env.GENIE_TEAM = 'alpha';

      const { updates, emissions } = installMocks({
        executorId: 'exec-3',
        currentSessionId: 'same-uuid',
      });

      await sessionSync({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        session_id: 'same-uuid',
      });

      expect(updates).toHaveLength(0);
      expect(emissions).toHaveLength(0);
    });

    // ========================================================================
    // Gap 5 (2026-04-25 power-outage post-mortem): when the executor is in a
    // terminal state, its claude_session_id is a recovery anchor — overwriting
    // it with a divergent live session destroys the only DB-side handle to
    // the dormant session UUID. Regression tests below.
    // ========================================================================

    test('PRESERVES stored UUID when executor is terminated (recovery anchor)', async () => {
      process.env.GENIE_AGENT_NAME = 'worker';
      process.env.GENIE_TEAM = 'alpha';

      const { updates, emissions } = installMocks({
        executorId: 'exec-terminated',
        currentSessionId: '9623de43-cf19-4350-a970-770ef6382e29', // dormant pre-crash session
        executorState: 'terminated',
      });

      await sessionSync({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        session_id: '8b9b674e-9063-4f84-aada-5925eb7db1f4', // live post-crash session
      });

      // The original session_id MUST survive untouched.
      expect(updates).toHaveLength(0);
      // session.divergence_preserved emitted instead of session.reconciled.
      expect(emissions).toHaveLength(1);
      expect(emissions[0]?.type).toBe('session.divergence_preserved');
      expect(emissions[0]?.details.stored_session_id).toBe('9623de43-cf19-4350-a970-770ef6382e29');
      expect(emissions[0]?.details.live_session_id).toBe('8b9b674e-9063-4f84-aada-5925eb7db1f4');
      expect(emissions[0]?.details.executor_state).toBe('terminated');
      expect(emissions[0]?.details.reason).toBe('terminal_executor_is_recovery_anchor');
    });

    test('PRESERVES stored UUID when executor is in error state', async () => {
      process.env.GENIE_AGENT_NAME = 'worker';
      process.env.GENIE_TEAM = 'alpha';

      const { updates, emissions } = installMocks({
        executorId: 'exec-error',
        currentSessionId: 'dormant-uuid',
        executorState: 'error',
      });

      await sessionSync({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'live-uuid' });

      expect(updates).toHaveLength(0);
      expect(emissions[0]?.type).toBe('session.divergence_preserved');
      expect(emissions[0]?.details.executor_state).toBe('error');
    });

    test('PRESERVES stored UUID when executor is in done state', async () => {
      process.env.GENIE_AGENT_NAME = 'worker';
      process.env.GENIE_TEAM = 'alpha';

      const { updates, emissions } = installMocks({
        executorId: 'exec-done',
        currentSessionId: 'dormant-uuid',
        executorState: 'done',
      });

      await sessionSync({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'live-uuid' });

      expect(updates).toHaveLength(0);
      expect(emissions[0]?.type).toBe('session.divergence_preserved');
    });

    test('STILL overwrites when executor is in active state (UUID rotation, original purpose)', async () => {
      process.env.GENIE_AGENT_NAME = 'worker';
      process.env.GENIE_TEAM = 'alpha';

      const { updates, emissions } = installMocks({
        executorId: 'exec-running',
        currentSessionId: 'pre-rotation-uuid',
        executorState: 'running',
      });

      await sessionSync({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'post-rotation-uuid' });

      // Active-state divergence is genuine UUID rotation — handler's original
      // job. Overwrite + emit session.reconciled.
      expect(updates).toEqual([{ id: 'exec-running', sessionId: 'post-rotation-uuid' }]);
      expect(emissions[0]?.type).toBe('session.reconciled');
    });

    test('STILL writes on first capture when oldSessionId is null even if state is terminated', async () => {
      // Edge case: terminal-state executor with no session yet (synthesized
      // recovery row). First capture should still write — there's no
      // pre-existing UUID to preserve, only NULL.
      process.env.GENIE_AGENT_NAME = 'worker';
      process.env.GENIE_TEAM = 'alpha';

      const { updates, emissions } = installMocks({
        executorId: 'exec-fresh-terminal',
        currentSessionId: null,
        executorState: 'terminated',
      });

      await sessionSync({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'first-uuid' });

      expect(updates).toEqual([{ id: 'exec-fresh-terminal', sessionId: 'first-uuid' }]);
      expect(emissions[0]?.type).toBe('session.reconciled');
    });

    test('does NOT re-emit on repeated invocations with the same UUID (process cache)', async () => {
      process.env.GENIE_AGENT_NAME = 'worker';
      process.env.GENIE_TEAM = 'alpha';

      const { emissions } = installMocks({
        executorId: 'exec-4',
        currentSessionId: 'old-uuid',
      });

      await sessionSync({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'new-uuid' });
      await sessionSync({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'new-uuid' });

      expect(emissions).toHaveLength(1);
    });

    test('does NOT emit when agent has no current executor', async () => {
      process.env.GENIE_AGENT_NAME = 'worker';
      process.env.GENIE_TEAM = 'alpha';

      const emissions: Emission[] = [];
      _deps.getAgentByName = async () => ({ currentExecutorId: null });
      _deps.getExecutor = async () => ({ claudeSessionId: 'doesnt-matter' });
      _deps.updateClaudeSessionId = async () => {};
      _deps.emitAuditEvent = async (_t, entityId, type, actor, details) => {
        emissions.push({ type, entityId, actor, details });
      };

      await sessionSync({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'new-uuid' });

      expect(emissions).toHaveLength(0);
    });
  });

  // G7 — hook env consumer flip. Migration 061 introduced fk_mailbox_from_worker
  // → agents.id; the spawn flow exports both GENIE_AGENT_ID (UUID) and
  // GENIE_AGENT_NAME. Hooks that touch the registry must prefer the UUID so
  // `getAgent(id)` runs instead of an indirect `(name, team)` lookup.
  describe('G7 env id preference (GENIE_AGENT_ID first)', () => {
    const VALID_UUID = '11111111-2222-3333-4444-555555555555';

    test('uses _deps.getAgent when GENIE_AGENT_ID is a UUID; never calls getAgentByName', async () => {
      process.env.GENIE_AGENT_ID = VALID_UUID;
      process.env.GENIE_AGENT_NAME = 'engineer-g7';
      process.env.GENIE_TEAM = 'alpha';

      const calls: { fn: string; args: unknown[] }[] = [];
      _deps.getAgent = async (id) => {
        calls.push({ fn: 'getAgent', args: [id] });
        return { currentExecutorId: 'exec-via-id' };
      };
      _deps.getAgentByName = async (name, team) => {
        calls.push({ fn: 'getAgentByName', args: [name, team] });
        return { currentExecutorId: 'should-not-be-used' };
      };
      _deps.getExecutor = async () => ({ claudeSessionId: 'old-uuid', state: 'running' });
      _deps.updateClaudeSessionId = async () => {};
      _deps.emitAuditEvent = async () => {};

      await sessionSync({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'new-uuid' });

      expect(calls).toEqual([{ fn: 'getAgent', args: [VALID_UUID] }]);
    });

    test('falls back to getAgentByName when GENIE_AGENT_ID is unset', async () => {
      process.env.GENIE_AGENT_ID = undefined;
      process.env.GENIE_AGENT_NAME = 'engineer-g7';
      process.env.GENIE_TEAM = 'alpha';

      const calls: { fn: string; args: unknown[] }[] = [];
      _deps.getAgent = async (id) => {
        calls.push({ fn: 'getAgent', args: [id] });
        return null;
      };
      _deps.getAgentByName = async (name, team) => {
        calls.push({ fn: 'getAgentByName', args: [name, team] });
        return { currentExecutorId: 'exec-via-name' };
      };
      _deps.getExecutor = async () => ({ claudeSessionId: 'old', state: 'running' });
      _deps.updateClaudeSessionId = async () => {};
      _deps.emitAuditEvent = async () => {};

      await sessionSync({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'new' });

      expect(calls).toEqual([{ fn: 'getAgentByName', args: ['engineer-g7', 'alpha'] }]);
    });

    test('falls back to getAgentByName when GENIE_AGENT_ID is a non-UUID string', async () => {
      process.env.GENIE_AGENT_ID = 'not-a-uuid';
      process.env.GENIE_AGENT_NAME = 'engineer-g7';
      process.env.GENIE_TEAM = 'alpha';

      const calls: string[] = [];
      _deps.getAgent = async () => {
        calls.push('getAgent');
        return null;
      };
      _deps.getAgentByName = async () => {
        calls.push('getAgentByName');
        return { currentExecutorId: 'exec-via-name' };
      };
      _deps.getExecutor = async () => ({ claudeSessionId: 'old', state: 'running' });
      _deps.updateClaudeSessionId = async () => {};
      _deps.emitAuditEvent = async () => {};

      await sessionSync({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'new' });

      // Non-UUID env id is silently dropped (readEnvAgentId guard); only the
      // name path runs.
      expect(calls).toEqual(['getAgentByName']);
    });
  });

  // Mac-CPU fix E — disk-backed cache so cold-start hook forks skip DB calls
  describe('Mac-CPU fix E — disk-backed session cache', () => {
    let cacheDir: string;
    let cacheFile: string;

    beforeEach(() => {
      cacheDir = join(tmpdir(), `genie-session-sync-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(cacheDir, { recursive: true });
      cacheFile = join(cacheDir, 'session-sync.json');
      _setCacheFileForTest(cacheFile);
      _resetSyncedSessions();
    });

    afterEach(() => {
      _setCacheFileForTest(null);
      _resetSyncedSessions();
      try {
        rmSync(cacheDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    });

    test('writes cache file after a successful session.reconciled', async () => {
      process.env.GENIE_AGENT_NAME = 'worker';
      process.env.GENIE_TEAM = 'alpha';

      let updateCount = 0;
      _deps.getAgentByName = async () => ({ currentExecutorId: 'exec-disk-1' });
      _deps.getExecutor = async () => ({ claudeSessionId: 'old-uuid', state: 'running' });
      _deps.updateClaudeSessionId = async () => {
        updateCount += 1;
      };
      _deps.emitAuditEvent = async () => {};

      await sessionSync({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'new-uuid' });

      expect(updateCount).toBe(1);
      expect(existsSync(cacheFile)).toBe(true);
      const persisted = JSON.parse(readFileSync(cacheFile, 'utf-8'));
      expect(persisted['exec-disk-1']).toBe('new-uuid');
    });

    test('cold-start fork loads cache from disk and skips DB calls', async () => {
      process.env.GENIE_AGENT_NAME = 'worker';
      process.env.GENIE_TEAM = 'alpha';

      // Pre-seed the cache file as if a previous fork wrote it
      writeFileSync(cacheFile, JSON.stringify({ 'exec-disk-2': 'cached-uuid' }));

      let getAgentCalls = 0;
      let getExecutorCalls = 0;
      let updateCalls = 0;
      _deps.getAgentByName = async () => {
        getAgentCalls += 1;
        return { currentExecutorId: 'exec-disk-2' };
      };
      _deps.getExecutor = async () => {
        getExecutorCalls += 1;
        return { claudeSessionId: 'cached-uuid', state: 'running' };
      };
      _deps.updateClaudeSessionId = async () => {
        updateCalls += 1;
      };
      _deps.emitAuditEvent = async () => {};

      // Simulate fresh fork
      _resetSyncedSessions();
      await sessionSync({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'cached-uuid' });

      // getAgentByName still runs (handler needs to resolve executor id), but
      // getExecutor + updateClaudeSessionId should NOT (cache hit).
      expect(getAgentCalls).toBe(1);
      expect(getExecutorCalls).toBe(0);
      expect(updateCalls).toBe(0);
    });

    test('disk cache miss falls through to DB and persists result', async () => {
      process.env.GENIE_AGENT_NAME = 'worker';
      process.env.GENIE_TEAM = 'alpha';

      // Cache file exists but has DIFFERENT executor — current one is uncached
      writeFileSync(cacheFile, JSON.stringify({ 'other-exec': 'other-uuid' }));

      let getExecutorCalls = 0;
      _deps.getAgentByName = async () => ({ currentExecutorId: 'exec-disk-3' });
      _deps.getExecutor = async () => {
        getExecutorCalls += 1;
        return { claudeSessionId: 'live-uuid', state: 'running' };
      };
      _deps.updateClaudeSessionId = async () => {};
      _deps.emitAuditEvent = async () => {};

      _resetSyncedSessions();
      await sessionSync({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'live-uuid' });

      expect(getExecutorCalls).toBe(1); // cache miss → DB hit
      const persisted = JSON.parse(readFileSync(cacheFile, 'utf-8'));
      // Both entries should now be present (existing + new)
      expect(persisted['exec-disk-3']).toBe('live-uuid');
      expect(persisted['other-exec']).toBe('other-uuid');
    });

    test('corrupt cache file is tolerated — falls back to DB', async () => {
      process.env.GENIE_AGENT_NAME = 'worker';
      process.env.GENIE_TEAM = 'alpha';

      writeFileSync(cacheFile, 'not valid json {');

      let getExecutorCalls = 0;
      _deps.getAgentByName = async () => ({ currentExecutorId: 'exec-disk-4' });
      _deps.getExecutor = async () => {
        getExecutorCalls += 1;
        return { claudeSessionId: 'some-uuid', state: 'running' };
      };
      _deps.updateClaudeSessionId = async () => {};
      _deps.emitAuditEvent = async () => {};

      _resetSyncedSessions();
      const result = await sessionSync({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        session_id: 'some-uuid',
      });
      expect(result).toBeUndefined(); // never throws
      expect(getExecutorCalls).toBe(1); // corrupt cache → DB hit
    });
  });
});
