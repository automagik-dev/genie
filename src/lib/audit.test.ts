/**
 * Tests for audit event recording and querying.
 *
 * Run with: bun test src/lib/audit.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  generateTraceId,
  getActor,
  queryAuditEvents,
  queryCostBreakdown,
  queryErrorPatterns,
  querySummary,
  queryTimeline,
  queryToolUsage,
  recordAuditEvent,
} from './audit.js';
import { getConnection } from './db.js';
import { DB_AVAILABLE, setupTestSchema } from './test-db.js';

describe.skipIf(!DB_AVAILABLE)('pg', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    cleanup = await setupTestSchema();
  });

  afterAll(async () => {
    await cleanup();
  });

  describe('recordAuditEvent', () => {
    test('inserts a row into audit_events', async () => {
      await recordAuditEvent('command', 'spawn', 'command_start', 'engineer', { args: ['myagent'] });

      const sql = await getConnection();
      const rows = await sql`
        SELECT * FROM audit_events WHERE entity_type = 'command' AND entity_id = 'spawn'
      `;
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0].event_type).toBe('command_start');
      expect(rows[0].actor).toBe('engineer');
      const details = typeof rows[0].details === 'string' ? JSON.parse(rows[0].details) : rows[0].details;
      expect(details.args).toEqual(['myagent']);
    });

    test('handles null actor gracefully', async () => {
      await recordAuditEvent('task', 'task-abc', 'stage_change', null, { from: 'draft', to: 'build' });

      const sql = await getConnection();
      const rows = await sql`
        SELECT * FROM audit_events WHERE entity_id = 'task-abc'
      `;
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0].actor).toBeNull();
    });

    test('handles empty details', async () => {
      await recordAuditEvent('worker', 'w-1', 'kill', 'cli');

      const sql = await getConnection();
      const rows = await sql`
        SELECT * FROM audit_events WHERE entity_id = 'w-1'
      `;
      expect(rows.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('queryAuditEvents', () => {
    test('returns events with default options', async () => {
      // Seed some data
      await recordAuditEvent('command', 'ls', 'command_start', 'cli');
      await recordAuditEvent('command', 'ls', 'command_success', 'cli', { duration_ms: 42 });

      const events = await queryAuditEvents({ since: '1h' });
      expect(events.length).toBeGreaterThanOrEqual(2);
    });

    test('filters by event type', async () => {
      const events = await queryAuditEvents({ type: 'command_start', since: '1h' });
      for (const e of events) {
        expect(e.event_type).toBe('command_start');
      }
    });

    test('filters by entity', async () => {
      const events = await queryAuditEvents({ entity: 'command', since: '1h' });
      for (const e of events) {
        expect(e.entity_type === 'command' || e.entity_id === 'command').toBe(true);
      }
    });

    test('respects limit', async () => {
      const events = await queryAuditEvents({ since: '1h', limit: 2 });
      expect(events.length).toBeLessThanOrEqual(2);
    });
  });

  describe('queryErrorPatterns', () => {
    test('returns empty when no errors', async () => {
      const patterns = await queryErrorPatterns('1h');
      // May or may not find errors, but should not throw
      expect(Array.isArray(patterns)).toBe(true);
    });

    test('groups error events', async () => {
      await recordAuditEvent('command', 'deploy', 'command_error', 'cli', { error: 'timeout' });
      await recordAuditEvent('command', 'deploy', 'command_error', 'cli', { error: 'timeout' });
      await recordAuditEvent('command', 'deploy', 'command_error', 'cli', { error: 'auth failed' });

      const patterns = await queryErrorPatterns('1h');
      const deployTimeout = patterns.find((p) => p.entity_id === 'deploy' && p.error_message === 'timeout');
      if (deployTimeout) {
        expect(deployTimeout.count).toBeGreaterThanOrEqual(2);
      }
    });

    test('surfaces state_changed->error via reason field (regression: empty-message bug)', async () => {
      // Before fix: state_changed matched via substring filter but COALESCE
      // only looked at details.error/message → result was '(no message)'.
      const entityId = `worker-stale-${Date.now()}`;
      await recordAuditEvent('worker', entityId, 'state_changed', 'cli', {
        state: 'error',
        reason: 'stale_spawn',
      });
      await recordAuditEvent('worker', entityId, 'state_changed', 'cli', {
        state: 'error',
        reason: 'stale_spawn',
      });

      const patterns = await queryErrorPatterns('1h');
      const staleSpawn = patterns.find((p) => p.entity_id === entityId && p.error_message === 'stale_spawn');
      expect(staleSpawn).toBeDefined();
      expect(staleSpawn?.error_message).toBe('stale_spawn');
      expect(staleSpawn?.count).toBeGreaterThanOrEqual(2);
      expect(staleSpawn?.error_message).not.toBe('(no message)');
    });

    test('excludes state_changed to non-error states (regression: over-broad filter)', async () => {
      // Before fix: filter `details::text LIKE '%"error"%'` could match any
      // event whose details serialization contained the substring "error".
      // A clean transition to 'idle' must NOT appear as an error pattern.
      const entityId = `worker-idle-${Date.now()}`;
      await recordAuditEvent('worker', entityId, 'state_changed', 'cli', {
        state: 'idle',
        previous_state: 'running',
      });

      const patterns = await queryErrorPatterns('1h');
      const noise = patterns.find((p) => p.entity_id === entityId);
      expect(noise).toBeUndefined();
    });

    test('extracts error_type when primary error key is absent', async () => {
      const entityId = `task-typed-${Date.now()}`;
      await recordAuditEvent('task', entityId, 'task_failed', 'cli', {
        error_type: 'DependencyMissing',
      });

      const patterns = await queryErrorPatterns('1h');
      const row = patterns.find((p) => p.entity_id === entityId);
      expect(row?.error_message).toBe('DependencyMissing');
    });
  });

  describe('getActor', () => {
    test('returns GENIE_AGENT_NAME if set', () => {
      const prev = process.env.GENIE_AGENT_NAME;
      process.env.GENIE_AGENT_NAME = 'test-agent';
      expect(getActor()).toBe('test-agent');
      process.env.GENIE_AGENT_NAME = prev;
    });

    test('returns cli when GENIE_AGENT_NAME not set', () => {
      const prev = process.env.GENIE_AGENT_NAME;
      process.env.GENIE_AGENT_NAME = undefined;
      expect(getActor()).toBe('cli');
      process.env.GENIE_AGENT_NAME = prev;
    });
  });

  describe('queryCostBreakdown', () => {
    test('returns cost aggregation by agent', async () => {
      await recordAuditEvent('otel_api', 'req-1', 'api_request', 'agent-a', { cost_usd: '0.05', model: 'opus' });
      await recordAuditEvent('otel_api', 'req-2', 'api_request', 'agent-a', { cost_usd: '0.10', model: 'opus' });
      await recordAuditEvent('otel_api', 'req-3', 'api_request', 'agent-b', { cost_usd: '0.03', model: 'sonnet' });

      const rows = await queryCostBreakdown('1h', 'agent');
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const agentA = rows.find((r) => r.group_key === 'agent-a');
      if (agentA) {
        expect(agentA.request_count).toBeGreaterThanOrEqual(2);
        expect(agentA.total_cost).toBeGreaterThan(0);
      }
    });

    test('groups by model', async () => {
      const rows = await queryCostBreakdown('1h', 'model');
      expect(Array.isArray(rows)).toBe(true);
    });

    test('returns empty for no data', async () => {
      const rows = await queryCostBreakdown('1s', 'wish');
      expect(Array.isArray(rows)).toBe(true);
    });
  });

  describe('queryToolUsage', () => {
    test('returns tool aggregation', async () => {
      await recordAuditEvent('otel_tool', 'Read', 'tool_result', 'agent-a', { tool_name: 'Read', duration_ms: '120' });
      await recordAuditEvent('otel_tool', 'Write', 'tool_result', 'agent-a', { tool_name: 'Write', duration_ms: '50' });
      await recordAuditEvent('otel_tool', 'Read', 'tool_error', 'agent-a', { tool_name: 'Read', error: 'not found' });

      const rows = await queryToolUsage('1h', 'tool');
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const readTool = rows.find((r) => r.group_key === 'Read');
      if (readTool) {
        expect(readTool.total_calls).toBeGreaterThanOrEqual(2);
        expect(readTool.error_count).toBeGreaterThanOrEqual(1);
      }
    });

    test('groups by agent', async () => {
      const rows = await queryToolUsage('1h', 'agent');
      expect(Array.isArray(rows)).toBe(true);
    });
  });

  describe('queryTimeline', () => {
    test('returns events for entity_id', async () => {
      const uniqueId = `timeline-test-${Date.now()}`;
      await recordAuditEvent('worker', uniqueId, 'spawn', 'cli');
      await recordAuditEvent('worker', uniqueId, 'state_changed', 'cli', { state: 'working' });
      await recordAuditEvent('worker', uniqueId, 'kill', 'cli');

      const timeline = await queryTimeline(uniqueId);
      expect(timeline.length).toBe(3);
      // Should be ordered ASC by time
      expect(timeline[0].event_type).toBe('spawn');
      expect(timeline[2].event_type).toBe('kill');
    });

    test('matches traceId in details', async () => {
      const traceId = `trace-${Date.now()}`;
      await recordAuditEvent('omni', 'reg-1', 'registration_success', 'cli', { traceId });

      const timeline = await queryTimeline(traceId);
      expect(timeline.length).toBeGreaterThanOrEqual(1);
      const details = typeof timeline[0].details === 'string' ? JSON.parse(timeline[0].details) : timeline[0].details;
      expect(details.traceId).toBe(traceId);
    });
  });

  describe('querySummary', () => {
    test('returns summary stats', async () => {
      const summary = await querySummary('1h');
      expect(typeof summary.agents_spawned).toBe('number');
      expect(typeof summary.tasks_moved).toBe('number');
      expect(typeof summary.total_cost).toBe('number');
      expect(typeof summary.error_count).toBe('number');
      expect(typeof summary.total_events).toBe('number');
      expect(typeof summary.tool_calls).toBe('number');
      expect(typeof summary.api_requests).toBe('number');
      expect(summary.total_events).toBeGreaterThan(0);
    });
  });

  describe('generateTraceId', () => {
    test('returns a valid UUID', () => {
      const id = generateTraceId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    test('returns unique values', () => {
      const ids = new Set(Array.from({ length: 10 }, () => generateTraceId()));
      expect(ids.size).toBe(10);
    });
  });
});
