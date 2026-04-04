import { beforeEach, describe, expect, it, mock } from 'bun:test';

// ============================================================================
// Mock PG — tagged template that captures calls and returns configurable rows
// ============================================================================

let mockRows: unknown[] = [];
let lastQuery: { strings: TemplateStringsArray; values: unknown[] } | null = null;

const mockSql = mock((strings: TemplateStringsArray, ...values: unknown[]) => {
  lastQuery = { strings, values };
  const result = [...mockRows] as unknown[] & { count: number };
  result.count = mockRows.length;
  return Promise.resolve(result);
});

mock.module('../../lib/db.js', () => ({
  getConnection: mock(async () => mockSql),
}));

const {
  upsertSession,
  getSession,
  listSessions,
  deleteSession,
  deleteByAgent,
  deleteByChatId,
  deleteAllByAgent,
  countSessions,
  touchSession,
} = await import('../omni-sessions.js');

// ============================================================================
// Helpers
// ============================================================================

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess-1',
    agent_name: 'agent-a',
    chat_id: 'chat-1',
    instance_id: 'inst-1',
    claude_session_id: null,
    created_at: '2026-01-01T00:00:00Z',
    last_activity_at: '2026-01-01T00:00:00Z',
    metadata: {},
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('omni-sessions CRUD', () => {
  beforeEach(() => {
    mockRows = [];
    lastQuery = null;
    mockSql.mockClear();
  });

  // --------------------------------------------------------------------------
  // upsertSession
  // --------------------------------------------------------------------------

  describe('upsertSession', () => {
    it('creates a new row and returns mapped record', async () => {
      const row = makeRow();
      mockRows = [row];

      const record = await upsertSession('sess-1', 'agent-a', 'chat-1', 'inst-1');

      expect(mockSql).toHaveBeenCalledTimes(1);
      expect(record).toEqual({
        id: 'sess-1',
        agentName: 'agent-a',
        chatId: 'chat-1',
        instanceId: 'inst-1',
        claudeSessionId: null,
        createdAt: '2026-01-01T00:00:00Z',
        lastActivityAt: '2026-01-01T00:00:00Z',
        metadata: {},
      });
    });

    it('updates existing row on conflict', async () => {
      const row = makeRow({ claude_session_id: 'cs-2', last_activity_at: '2026-01-02T00:00:00Z' });
      mockRows = [row];

      const record = await upsertSession('sess-1', 'agent-a', 'chat-1', 'inst-1', 'cs-2');

      expect(record.claudeSessionId).toBe('cs-2');
      expect(record.lastActivityAt).toBe('2026-01-02T00:00:00Z');
    });

    it('passes null when claudeSessionId omitted', async () => {
      mockRows = [makeRow()];

      await upsertSession('sess-1', 'agent-a', 'chat-1', 'inst-1');

      // The 5th value in the template should be null (claudeSessionId ?? null)
      expect(lastQuery!.values[4]).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // getSession
  // --------------------------------------------------------------------------

  describe('getSession', () => {
    it('returns record when found', async () => {
      mockRows = [makeRow()];
      const record = await getSession('sess-1');
      expect(record).not.toBeNull();
      expect(record!.id).toBe('sess-1');
    });

    it('returns null when not found', async () => {
      mockRows = [];
      const record = await getSession('nonexistent');
      expect(record).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // listSessions
  // --------------------------------------------------------------------------

  describe('listSessions', () => {
    it('returns all sessions with no filter', async () => {
      mockRows = [makeRow(), makeRow({ id: 'sess-2', agent_name: 'agent-b' })];
      const records = await listSessions();
      expect(records).toHaveLength(2);
    });

    it('filters by agentName', async () => {
      mockRows = [makeRow()];
      const records = await listSessions({ agentName: 'agent-a' });
      expect(records).toHaveLength(1);
      expect(lastQuery!.values).toContain('agent-a');
    });

    it('filters by instanceId', async () => {
      mockRows = [makeRow()];
      const records = await listSessions({ instanceId: 'inst-1' });
      expect(records).toHaveLength(1);
      expect(lastQuery!.values).toContain('inst-1');
    });

    it('filters by both agentName and instanceId', async () => {
      mockRows = [makeRow()];
      const records = await listSessions({ agentName: 'agent-a', instanceId: 'inst-1' });
      expect(records).toHaveLength(1);
      expect(lastQuery!.values).toContain('agent-a');
      expect(lastQuery!.values).toContain('inst-1');
    });

    it('returns empty array when no results', async () => {
      mockRows = [];
      const records = await listSessions();
      expect(records).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // deleteSession
  // --------------------------------------------------------------------------

  describe('deleteSession', () => {
    it('deletes by id', async () => {
      await deleteSession('sess-1');
      expect(mockSql).toHaveBeenCalledTimes(1);
      expect(lastQuery!.values).toContain('sess-1');
    });
  });

  // --------------------------------------------------------------------------
  // deleteByAgent
  // --------------------------------------------------------------------------

  describe('deleteByAgent', () => {
    it('deletes all sessions for agent', async () => {
      await deleteByAgent('agent-a');
      expect(mockSql).toHaveBeenCalledTimes(1);
      expect(lastQuery!.values).toContain('agent-a');
    });
  });

  // --------------------------------------------------------------------------
  // deleteByChatId
  // --------------------------------------------------------------------------

  describe('deleteByChatId', () => {
    it('deletes by chatId and returns count', async () => {
      mockRows = [makeRow(), makeRow({ id: 'sess-2' })];
      const count = await deleteByChatId('chat-1');
      expect(count).toBe(2);
      expect(lastQuery!.values).toContain('chat-1');
    });

    it('returns 0 when no rows match', async () => {
      mockRows = [];
      const count = await deleteByChatId('no-match');
      expect(count).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // deleteAllByAgent
  // --------------------------------------------------------------------------

  describe('deleteAllByAgent', () => {
    it('deletes all sessions for agent and returns count', async () => {
      mockRows = [makeRow(), makeRow({ id: 'sess-2' }), makeRow({ id: 'sess-3' })];
      const count = await deleteAllByAgent('agent-a');
      expect(count).toBe(3);
      expect(lastQuery!.values).toContain('agent-a');
    });
  });

  // --------------------------------------------------------------------------
  // touchSession
  // --------------------------------------------------------------------------

  describe('touchSession', () => {
    it('updates last_activity_at and claude_session_id', async () => {
      await touchSession('sess-1', 'cs-new');
      expect(mockSql).toHaveBeenCalledTimes(1);
      expect(lastQuery!.values).toContain('sess-1');
      expect(lastQuery!.values).toContain('cs-new');
    });

    it('updates only last_activity_at when no claudeSessionId', async () => {
      await touchSession('sess-1');
      expect(mockSql).toHaveBeenCalledTimes(1);
      expect(lastQuery!.values).toContain('sess-1');
      // Should not contain a claude session id value beyond the id
      expect(lastQuery!.values).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------------
  // countSessions
  // --------------------------------------------------------------------------

  describe('countSessions', () => {
    it('returns count from PG', async () => {
      mockRows = [{ count: 42 }];
      const count = await countSessions();
      expect(count).toBe(42);
    });

    it('returns 0 when empty', async () => {
      mockRows = [{ count: 0 }];
      const count = await countSessions();
      expect(count).toBe(0);
    });
  });
});
