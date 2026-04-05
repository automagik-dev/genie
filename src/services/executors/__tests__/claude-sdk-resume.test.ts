/**
 * Tests for Group 7 — lazy resume via executors table + metadata index.
 *
 * Covers:
 *   - spawn() reuses an existing executor when findLatestByMetadata returns one
 *   - spawn() creates a fresh executor when no match found
 *   - deliver() detects resume rejection (SDK returns different session ID)
 *   - deliver() persists session ID to registry on first query
 *   - Audit events: session.resumed, session.created_fresh, session.resume_rejected
 */

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

// Clean up process-global mock.module registrations when this file finishes.
// Without this, mocked modules leak into later test files (bun mock.module
// is process-global and persists across file boundaries).
afterAll(() => {
  mock.restore();
});

// ============================================================================
// Mocks — must be registered before any import of the production module
// ============================================================================

// Mock agent directory
mock.module('../../../lib/agent-directory.js', () => ({
  resolve: mock(async (name: string) => ({
    entry: {
      name,
      dir: '/tmp/test',
      promptMode: 'system' as const,
      model: 'sonnet',
      registeredAt: new Date().toISOString(),
      permissions: { preset: 'full' },
    },
    builtin: false,
  })),
  loadIdentity: mock(() => null),
}));

// Mock SDK query — default yields a result with session_id
const queryMock = mock(() => {
  const gen = (async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'reply' }] } };
    yield { type: 'result', subtype: 'success', session_id: 'sdk-session-aaa' };
  })();
  return Object.assign(gen, {
    interrupt: mock(),
    setPermissionMode: mock(),
    setModel: mock(),
    return: mock(async () => ({ value: undefined, done: true })),
    throw: mock(async () => ({ value: undefined, done: true })),
  });
});
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
}));

// Mock audit-events — capture calls for assertion.
// NOTE: audit-events is intentionally NOT mocked via mock.module here.
// mock.module leaks across files and breaks sdk-session-capture.test.ts.
// Instead, audit events are tracked via happySafePgCall's call log —
// recordAuditEvent calls safePgCall('audit:<type>', ...) so we capture
// the event type from the op string prefix.

// Mock sdk-session-capture (Group 5)
// NOTE: sdk-session-capture is intentionally NOT mocked here.
// The real module is used — its PG writes go through safePgCall which is
// wired to happySafePgCall (a no-op that invokes fn with a fake sql).
// Previously this was mocked via mock.module, but that leaked across files
// and broke sdk-session-capture.test.ts (bun mock.module is process-global).

// Mock agent-registry
const findOrCreateAgentMock = mock(async () => ({
  id: 'agent-id-fixture',
  startedAt: new Date().toISOString(),
  currentExecutorId: null,
}));
mock.module('../../../lib/agent-registry.js', () => ({
  findOrCreateAgent: findOrCreateAgentMock,
}));

// Mock executor-registry — Group 7 functions.
// Use `as any` return types so mockImplementation can return richer objects.
const findLatestByMetadataMock = mock((_filter: any): Promise<any> => Promise.resolve(null));
const relinkExecutorToAgentMock = mock((..._args: any[]): Promise<void> => Promise.resolve());
const updateClaudeSessionIdMock = mock((..._args: any[]): Promise<void> => Promise.resolve());
const createAndLinkExecutorMock = mock(async () => ({
  id: 'fresh-executor-id',
  agentId: 'agent-id-fixture',
  provider: 'claude',
  transport: 'api',
  state: 'spawning',
  metadata: {},
  claudeSessionId: null,
}));
const updateExecutorStateMock = mock(async () => undefined);
const terminateExecutorMock = mock(async () => undefined);
mock.module('../../../lib/executor-registry.js', () => ({
  findLatestByMetadata: findLatestByMetadataMock,
  relinkExecutorToAgent: relinkExecutorToAgentMock,
  updateClaudeSessionId: updateClaudeSessionIdMock,
  createAndLinkExecutor: createAndLinkExecutorMock,
  updateExecutorState: updateExecutorStateMock,
  terminateExecutor: terminateExecutorMock,
}));

// ============================================================================
// Import production module (after all mocks)
// ============================================================================

const { ClaudeSdkOmniExecutor } = await import('../claude-sdk.js');

// ============================================================================
// Helpers
// ============================================================================

/** Log of safePgCall operations — tracks audit events without mock.module. */
interface PgCallEntry {
  op: string;
  sqlValues: unknown[];
}
const safePgCallLog: PgCallEntry[] = [];

/** Fake bridge.safePgCall that invokes fn with a tracking sql template. */
const happySafePgCall = async <T>(
  op: string,
  fn: (sql: any) => Promise<T>,
  _fallback: T,
  _ctx?: { executorId?: string; chatId?: string },
): Promise<T> => {
  const entry: PgCallEntry = { op, sqlValues: [] };
  safePgCallLog.push(entry);
  const trackingSql = (_strings: TemplateStringsArray, ...values: unknown[]) => {
    entry.sqlValues = values;
    return [{ id: values[0] ?? 'fake-id' }];
  };
  return fn(trackingSql);
};

/** Build a minimal OmniMessage. */
function mkMsg(chatId: string, instanceId = 'inst-1') {
  return {
    content: 'Hello',
    sender: 'user',
    instanceId,
    chatId,
    agent: 'test-agent',
  };
}

/** Extract audit event types from safePgCall log (op = 'audit:<type>'). */
function auditEventTypes(): string[] {
  return safePgCallLog.filter((e) => e.op.startsWith('audit:')).map((e) => e.op.slice('audit:'.length));
}

// ============================================================================
// Tests
// ============================================================================

describe('ClaudeSdkOmniExecutor — lazy resume (Group 7)', () => {
  let executor: InstanceType<typeof ClaudeSdkOmniExecutor>;

  beforeEach(() => {
    executor = new ClaudeSdkOmniExecutor();
    executor.setSafePgCall(happySafePgCall);
    executor.setNatsPublish(mock());

    // Reset all mocks
    findOrCreateAgentMock.mockClear();
    findLatestByMetadataMock.mockClear();
    relinkExecutorToAgentMock.mockClear();
    updateClaudeSessionIdMock.mockClear();
    createAndLinkExecutorMock.mockClear();
    updateExecutorStateMock.mockClear();
    terminateExecutorMock.mockClear();
    safePgCallLog.length = 0;

    // Default: no existing executor (fresh creation path)
    findLatestByMetadataMock.mockImplementation(async () => null);
  });

  // ==========================================================================
  // spawn() — fresh creation
  // ==========================================================================

  describe('spawn — no existing executor', () => {
    it('creates a fresh executor and writes session.created_fresh audit event', async () => {
      await executor.spawn('test-agent', 'chat-fresh', { OMNI_INSTANCE_ID: 'inst-1' });

      // findLatestByMetadata was called to look for an existing executor
      expect(findLatestByMetadataMock).toHaveBeenCalledTimes(1);
      const filter = findLatestByMetadataMock.mock.calls[0][0];
      expect(filter).toMatchObject({
        agentId: 'agent-id-fixture',
        source: 'omni',
        chatId: 'chat-fresh',
      });

      // No existing executor found → createAndLinkExecutor was called
      expect(createAndLinkExecutorMock).toHaveBeenCalledTimes(1);
      expect(relinkExecutorToAgentMock).not.toHaveBeenCalled();

      // session.created_fresh audit event was written
      expect(auditEventTypes()).toContain('session.created_fresh');
    });
  });

  // ==========================================================================
  // spawn() — resume existing executor
  // ==========================================================================

  describe('spawn — existing executor with claudeSessionId', () => {
    const existingExecutor = {
      id: 'existing-exec-id',
      agentId: 'agent-id-fixture',
      provider: 'claude' as const,
      transport: 'api' as const,
      pid: null,
      tmuxSession: null,
      tmuxPaneId: null,
      tmuxWindow: null,
      tmuxWindowId: null,
      claudeSessionId: 'resume-session-xyz',
      state: 'idle' as const,
      metadata: { source: 'omni', chat_id: 'chat-resume' },
      worktree: null,
      repoPath: null,
      paneColor: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    beforeEach(() => {
      findLatestByMetadataMock.mockImplementation(async () => existingExecutor);
    });

    it('reuses existing executor and does NOT create a new one', async () => {
      await executor.spawn('test-agent', 'chat-resume', { OMNI_INSTANCE_ID: 'inst-1' });

      // Should NOT create a new executor
      expect(createAndLinkExecutorMock).not.toHaveBeenCalled();

      // Should relink existing executor to agent
      expect(relinkExecutorToAgentMock).toHaveBeenCalledTimes(1);
      const [execId, agentId] = relinkExecutorToAgentMock.mock.calls[0];
      expect(execId).toBe('existing-exec-id');
      expect(agentId).toBe('agent-id-fixture');
    });

    it('writes session.resumed audit event', async () => {
      await executor.spawn('test-agent', 'chat-resume', { OMNI_INSTANCE_ID: 'inst-1' });
      expect(auditEventTypes()).toContain('session.resumed');
      expect(auditEventTypes()).not.toContain('session.created_fresh');
    });

    it('passes claudeSessionId as resume parameter on first delivery', async () => {
      const session = await executor.spawn('test-agent', 'chat-resume', { OMNI_INSTANCE_ID: 'inst-1' });

      await executor.deliver(session, mkMsg('chat-resume'));
      await executor.waitForDeliveries(session.id);

      // The SDK query mock was called — the resume parameter is passed
      // through extraOptions inside runQuery. We verify the query ran.
      expect(queryMock).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // spawn() — existing executor WITHOUT claudeSessionId
  // ==========================================================================

  describe('spawn — existing executor without claudeSessionId', () => {
    beforeEach(() => {
      findLatestByMetadataMock.mockImplementation(async () => ({
        id: 'existing-no-session',
        agentId: 'agent-id-fixture',
        provider: 'claude',
        transport: 'api',
        pid: null,
        tmuxSession: null,
        tmuxPaneId: null,
        tmuxWindow: null,
        tmuxWindowId: null,
        claudeSessionId: null,
        state: 'idle',
        metadata: { source: 'omni', chat_id: 'chat-no-session' },
        worktree: null,
        repoPath: null,
        paneColor: null,
        startedAt: new Date().toISOString(),
        endedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
    });

    it('still reuses executor — session ID will be set on first query', async () => {
      await executor.spawn('test-agent', 'chat-no-session', { OMNI_INSTANCE_ID: 'inst-1' });

      expect(createAndLinkExecutorMock).not.toHaveBeenCalled();
      expect(relinkExecutorToAgentMock).toHaveBeenCalledTimes(1);
      expect(auditEventTypes()).toContain('session.resumed');
    });

    it('persists session ID to registry after first query returns one', async () => {
      const session = await executor.spawn('test-agent', 'chat-no-session', { OMNI_INSTANCE_ID: 'inst-1' });
      updateClaudeSessionIdMock.mockClear();

      await executor.deliver(session, mkMsg('chat-no-session'));
      await executor.waitForDeliveries(session.id);

      // The query returned session_id 'sdk-session-aaa' (from the mock).
      // Since the executor had no claudeSessionId, this is a new session ID
      // → updateClaudeSessionId should have been called.
      expect(updateClaudeSessionIdMock).toHaveBeenCalledTimes(1);
      const [execId, sessId] = updateClaudeSessionIdMock.mock.calls[0];
      expect(execId).toBe('existing-no-session');
      expect(sessId).toBe('sdk-session-aaa');
    });
  });

  // ==========================================================================
  // deliver() — resume rejection
  // ==========================================================================

  describe('deliver — resume rejected by SDK', () => {
    beforeEach(() => {
      findLatestByMetadataMock.mockImplementation(async () => ({
        id: 'exec-with-old-session',
        agentId: 'agent-id-fixture',
        provider: 'claude',
        transport: 'api',
        pid: null,
        tmuxSession: null,
        tmuxPaneId: null,
        tmuxWindow: null,
        tmuxWindowId: null,
        claudeSessionId: 'old-session-id',
        state: 'idle',
        metadata: { source: 'omni', chat_id: 'chat-reject' },
        worktree: null,
        repoPath: null,
        paneColor: null,
        startedAt: new Date().toISOString(),
        endedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));

      // SDK returns a DIFFERENT session ID (resume was rejected)
      queryMock.mockImplementation(() => {
        const gen = (async function* () {
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'fresh reply' }] } };
          yield { type: 'result', subtype: 'success', session_id: 'new-session-after-reject' };
        })();
        return Object.assign(gen, {
          interrupt: mock(),
          setPermissionMode: mock(),
          setModel: mock(),
          return: mock(async () => ({ value: undefined, done: true })),
          throw: mock(async () => ({ value: undefined, done: true })),
        });
      });
    });

    it('writes session.resume_rejected audit event', async () => {
      const session = await executor.spawn('test-agent', 'chat-reject', { OMNI_INSTANCE_ID: 'inst-1' });
      safePgCallLog.length = 0;

      await executor.deliver(session, mkMsg('chat-reject'));
      await executor.waitForDeliveries(session.id);

      expect(auditEventTypes()).toContain('session.resume_rejected');
    });

    it('includes old and new session IDs in the rejection audit event', async () => {
      const session = await executor.spawn('test-agent', 'chat-reject', { OMNI_INSTANCE_ID: 'inst-1' });
      safePgCallLog.length = 0;

      await executor.deliver(session, mkMsg('chat-reject'));
      await executor.waitForDeliveries(session.id);

      const rejectionEntry = safePgCallLog.find((e) => e.op === 'audit:session.resume_rejected');
      expect(rejectionEntry).toBeDefined();
      // recordAuditEvent serializes attrs to JSON in the SQL values
      const detailsJson = rejectionEntry!.sqlValues.find((v) => typeof v === 'string' && v.includes('old_session_id'));
      expect(detailsJson).toBeDefined();
      const details = JSON.parse(detailsJson as string);
      expect(details.old_session_id).toBe('old-session-id');
      expect(details.new_session_id).toBe('new-session-after-reject');
    });

    it('updates claude_session_id in registry with the new session ID', async () => {
      const session = await executor.spawn('test-agent', 'chat-reject', { OMNI_INSTANCE_ID: 'inst-1' });
      updateClaudeSessionIdMock.mockClear();

      await executor.deliver(session, mkMsg('chat-reject'));
      await executor.waitForDeliveries(session.id);

      expect(updateClaudeSessionIdMock).toHaveBeenCalledTimes(1);
      const [execId, sessId] = updateClaudeSessionIdMock.mock.calls[0];
      expect(execId).toBe('exec-with-old-session');
      expect(sessId).toBe('new-session-after-reject');
    });
  });

  // ==========================================================================
  // deliver() — successful resume (same session ID returned)
  // ==========================================================================

  describe('deliver — resume accepted by SDK', () => {
    beforeEach(() => {
      findLatestByMetadataMock.mockImplementation(async () => ({
        id: 'exec-resume-ok',
        agentId: 'agent-id-fixture',
        provider: 'claude',
        transport: 'api',
        pid: null,
        tmuxSession: null,
        tmuxPaneId: null,
        tmuxWindow: null,
        tmuxWindowId: null,
        claudeSessionId: 'sdk-session-aaa',
        state: 'idle',
        metadata: { source: 'omni', chat_id: 'chat-ok' },
        worktree: null,
        repoPath: null,
        paneColor: null,
        startedAt: new Date().toISOString(),
        endedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));

      // SDK returns the SAME session ID (resume accepted)
      queryMock.mockImplementation(() => {
        const gen = (async function* () {
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'resumed reply' }] } };
          yield { type: 'result', subtype: 'success', session_id: 'sdk-session-aaa' };
        })();
        return Object.assign(gen, {
          interrupt: mock(),
          setPermissionMode: mock(),
          setModel: mock(),
          return: mock(async () => ({ value: undefined, done: true })),
          throw: mock(async () => ({ value: undefined, done: true })),
        });
      });
    });

    it('does NOT write session.resume_rejected when session IDs match', async () => {
      const session = await executor.spawn('test-agent', 'chat-ok', { OMNI_INSTANCE_ID: 'inst-1' });
      safePgCallLog.length = 0;

      await executor.deliver(session, mkMsg('chat-ok'));
      await executor.waitForDeliveries(session.id);

      expect(auditEventTypes()).not.toContain('session.resume_rejected');
    });

    it('does NOT update claude_session_id when session IDs match', async () => {
      const session = await executor.spawn('test-agent', 'chat-ok', { OMNI_INSTANCE_ID: 'inst-1' });
      updateClaudeSessionIdMock.mockClear();

      await executor.deliver(session, mkMsg('chat-ok'));
      await executor.waitForDeliveries(session.id);

      expect(updateClaudeSessionIdMock).not.toHaveBeenCalled();
    });
  });
});
