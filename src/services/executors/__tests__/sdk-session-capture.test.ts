import { beforeEach, describe, expect, it } from 'bun:test';
import { recordAuditEvent } from '../../../lib/audit-events.js';
import type { SafePgCallFn } from '../../../lib/safe-pg-call.js';
import { endSession, recordTurn, startSession, updateTurnCount } from '../sdk-session-capture.js';

// ============================================================================
// Mock safePgCall that captures SQL template calls
// ============================================================================

interface CapturedCall {
  op: string;
  /** The raw SQL strings array from the tagged template. */
  sqlStrings: string[];
  /** The interpolated values from the tagged template. */
  sqlValues: unknown[];
  ctx?: { executorId?: string; chatId?: string };
}

/**
 * Build a mock safePgCall that records every call and executes the fn with a
 * fake sql tagged-template function. Returns the captured calls array.
 */
function buildMockSafePgCall(): { safePgCall: SafePgCallFn; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];

  const safePgCall: SafePgCallFn = async <T>(
    op: string,
    fn: (sql: any) => Promise<T>,
    _fallback: T,
    ctx?: { executorId?: string; chatId?: string },
  ): Promise<T> => {
    // Fake sql tagged-template function — captures the template + values.
    const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({
        op,
        sqlStrings: [...strings],
        sqlValues: values,
        ctx,
      });
      // Return a result shaped like a postgres.js INSERT...RETURNING or UPDATE.
      // startSession expects a truthy result to extract the session ID.
      return [{ id: values[0] }];
    };
    return fn(fakeSql);
  };

  return { safePgCall, calls };
}

/**
 * Build a degraded safePgCall that always returns fallback (PG unavailable).
 */
function buildDegradedSafePgCall(): { safePgCall: SafePgCallFn; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const safePgCall: SafePgCallFn = async <T>(
    op: string,
    _fn: (sql: any) => Promise<T>,
    fallback: T,
    ctx?: { executorId?: string; chatId?: string },
  ): Promise<T> => {
    calls.push({ op, sqlStrings: [], sqlValues: [], ctx });
    return fallback;
  };
  return { safePgCall, calls };
}

// ============================================================================
// Tests
// ============================================================================

describe('sdk-session-capture', () => {
  let safePgCall: SafePgCallFn;
  let calls: CapturedCall[];

  beforeEach(() => {
    ({ safePgCall, calls } = buildMockSafePgCall());
  });

  // --------------------------------------------------------------------------
  // startSession
  // --------------------------------------------------------------------------

  describe('startSession', () => {
    it('creates a sessions row with correct columns', async () => {
      const sessionId = await startSession(
        safePgCall,
        'exec-1',
        'claude-sess-abc',
        'agent-1',
        'team-a',
        'engineer',
        'wish-1',
      );

      expect(sessionId).toBe('claude-sess-abc');
      expect(calls).toHaveLength(1);
      expect(calls[0].op).toBe('sdk-session-start');

      // The SQL should contain INSERT INTO sessions
      const sql = calls[0].sqlStrings.join('?');
      expect(sql).toContain('INSERT INTO sessions');
      expect(sql).toContain('session');

      // Values should include sessionId, agentId, executorId, team, role, wishSlug
      expect(calls[0].sqlValues).toContain('claude-sess-abc');
      expect(calls[0].sqlValues).toContain('agent-1');
      expect(calls[0].sqlValues).toContain('exec-1');
      expect(calls[0].sqlValues).toContain('team-a');
      expect(calls[0].sqlValues).toContain('engineer');
      expect(calls[0].sqlValues).toContain('wish-1');
    });

    it('generates synthetic session ID when claudeSessionId is undefined', async () => {
      const sessionId = await startSession(safePgCall, 'exec-2', undefined, 'agent-2');

      expect(sessionId).toMatch(/^sdk-exec-2-\d+$/);
      expect(calls[0].sqlValues[0]).toBe(sessionId);
    });

    it('returns null when safePgCall is in degraded mode', async () => {
      const { safePgCall: degraded } = buildDegradedSafePgCall();
      const sessionId = await startSession(degraded, 'exec-3', 'sess-x', 'agent-3');
      expect(sessionId).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // recordTurn
  // --------------------------------------------------------------------------

  describe('recordTurn', () => {
    it('inserts a session_content row with correct shape', async () => {
      await recordTurn(safePgCall, 'sess-1', 0, 'assistant', 'Hello world', undefined, '2026-01-01T00:00:00Z');

      expect(calls).toHaveLength(1);
      expect(calls[0].op).toBe('sdk-session-turn');

      const sql = calls[0].sqlStrings.join('?');
      expect(sql).toContain('INSERT INTO session_content');

      expect(calls[0].sqlValues).toContain('sess-1');
      expect(calls[0].sqlValues).toContain(0);
      expect(calls[0].sqlValues).toContain('assistant');
      expect(calls[0].sqlValues).toContain('Hello world');
      expect(calls[0].sqlValues).toContain('2026-01-01T00:00:00Z');
    });

    it('writes tool_name when provided', async () => {
      await recordTurn(safePgCall, 'sess-1', 1, 'tool_input', '{"cmd":"ls"}', 'Bash');

      expect(calls[0].sqlValues).toContain('Bash');
    });

    it('writes null tool_name when omitted', async () => {
      await recordTurn(safePgCall, 'sess-1', 2, 'user', 'hello');

      expect(calls[0].sqlValues).toContain(null);
    });

    it('mirrors session_content columns: session_id, turn_index, role, content, tool_name, timestamp', async () => {
      await recordTurn(safePgCall, 'sess-x', 5, 'tool_output', 'file list', 'Read', '2026-06-01T12:00:00Z');

      const vals = calls[0].sqlValues;
      // Positional match to INSERT column order
      expect(vals[0]).toBe('sess-x'); // session_id
      expect(vals[1]).toBe(5); // turn_index
      expect(vals[2]).toBe('tool_output'); // role
      expect(vals[3]).toBe('file list'); // content
      expect(vals[4]).toBe('Read'); // tool_name
      expect(vals[5]).toBe('2026-06-01T12:00:00Z'); // timestamp
    });
  });

  // --------------------------------------------------------------------------
  // updateTurnCount
  // --------------------------------------------------------------------------

  describe('updateTurnCount', () => {
    it('updates sessions.total_turns', async () => {
      await updateTurnCount(safePgCall, 'sess-1', 7);

      expect(calls).toHaveLength(1);
      expect(calls[0].op).toBe('sdk-session-turn-count');

      const sql = calls[0].sqlStrings.join('?');
      expect(sql).toContain('UPDATE sessions');
      expect(sql).toContain('total_turns');
      expect(calls[0].sqlValues).toContain(7);
      expect(calls[0].sqlValues).toContain('sess-1');
    });
  });

  // --------------------------------------------------------------------------
  // endSession
  // --------------------------------------------------------------------------

  describe('endSession', () => {
    it('updates sessions.ended_at and status', async () => {
      await endSession(safePgCall, 'sess-1', 'completed');

      expect(calls).toHaveLength(1);
      expect(calls[0].op).toBe('sdk-session-end');

      const sql = calls[0].sqlStrings.join('?');
      expect(sql).toContain('UPDATE sessions');
      expect(sql).toContain('ended_at');
      expect(sql).toContain('status');
      expect(calls[0].sqlValues).toContain('completed');
      expect(calls[0].sqlValues).toContain('sess-1');
    });

    it('accepts crashed status', async () => {
      await endSession(safePgCall, 'sess-2', 'crashed');
      expect(calls[0].sqlValues).toContain('crashed');
    });

    it('defaults to completed when status omitted', async () => {
      await endSession(safePgCall, 'sess-3');
      expect(calls[0].sqlValues).toContain('completed');
    });
  });

  // --------------------------------------------------------------------------
  // recordAuditEvent
  // --------------------------------------------------------------------------

  describe('recordAuditEvent', () => {
    it('writes to audit_events with correct schema columns', async () => {
      await recordAuditEvent(safePgCall, 'deliver.start', {
        executor_id: 'exec-1',
        agent_id: 'agent-1',
        chat_id: 'chat-1',
        instance_id: 'inst-1',
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].op).toBe('audit:deliver.start');

      const sql = calls[0].sqlStrings.join('?');
      expect(sql).toContain('INSERT INTO audit_events');
      expect(sql).toContain('entity_type');
      expect(sql).toContain('entity_id');
      expect(sql).toContain('event_type');
      expect(sql).toContain('actor');
      expect(sql).toContain('details');

      // entity_type defaults to 'executor'
      expect(calls[0].sqlValues).toContain('executor');
      // entity_id comes from executor_id
      expect(calls[0].sqlValues).toContain('exec-1');
      // event_type is the AuditEventType
      expect(calls[0].sqlValues).toContain('deliver.start');
      // actor comes from agent_id
      expect(calls[0].sqlValues).toContain('agent-1');
    });

    it('writes deliver.end with turn_count in details', async () => {
      await recordAuditEvent(safePgCall, 'deliver.end', {
        executor_id: 'exec-1',
        agent_id: 'agent-1',
        chat_id: 'chat-1',
        instance_id: 'inst-1',
        turn_count: 4,
      });

      expect(calls[0].op).toBe('audit:deliver.end');

      // details JSONB should include turn_count
      const detailsJson = calls[0].sqlValues.find((v) => typeof v === 'string' && v.includes('turn_count'));
      expect(detailsJson).toBeDefined();
      const details = JSON.parse(detailsJson as string);
      expect(details.turn_count).toBe(4);
      expect(details.chat_id).toBe('chat-1');
    });

    it('no-ops when safePgCall is in degraded mode', async () => {
      const { safePgCall: degraded, calls: degradedCalls } = buildDegradedSafePgCall();
      await recordAuditEvent(degraded, 'deliver.start', { executor_id: 'x' });

      // safePgCall was called (it returns fallback), but fn was never invoked
      expect(degradedCalls).toHaveLength(1);
      expect(degradedCalls[0].sqlStrings).toHaveLength(0); // fn was not called
    });
  });

  // --------------------------------------------------------------------------
  // Full lifecycle integration
  // --------------------------------------------------------------------------

  describe('full lifecycle', () => {
    it('start → recordTurn (user) → recordTurn (assistant) → updateTurnCount → end', async () => {
      const sessionId = await startSession(safePgCall, 'exec-lifecycle', 'claude-lc', 'agent-lc');
      expect(sessionId).toBe('claude-lc');

      await recordTurn(safePgCall, sessionId!, 0, 'user', 'What is 2+2?');
      await recordTurn(safePgCall, sessionId!, 1, 'assistant', '4');
      await updateTurnCount(safePgCall, sessionId!, 2);
      await endSession(safePgCall, sessionId!);

      // 5 total calls: startSession + 2 recordTurn + updateTurnCount + endSession
      expect(calls).toHaveLength(5);

      const ops = calls.map((c) => c.op);
      expect(ops).toEqual([
        'sdk-session-start',
        'sdk-session-turn',
        'sdk-session-turn',
        'sdk-session-turn-count',
        'sdk-session-end',
      ]);
    });
  });
});
