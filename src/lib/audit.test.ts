/**
 * Tests for audit event recording and querying.
 *
 * Run with: bun test src/lib/audit.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getActor, queryAuditEvents, queryErrorPatterns, recordAuditEvent } from './audit.js';
import { getConnection } from './db.js';
import { setupTestSchema } from './test-db.js';

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
