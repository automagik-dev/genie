/**
 * OmniQueue tests — PG-backed request queue for SDK executor.
 *
 * Uses real pgserve (bun:test preload boots a RAM-backed instance)
 * to exercise the actual SQL queries: enqueue, claim, retry, recovery.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { getConnection } from '../../lib/db.js';
import type { Sql } from '../../lib/db.js';
import type { OmniMessage } from '../executor.js';
import { OmniQueue, type QueuedRequest } from '../omni-queue.js';

let sql: Sql;

beforeEach(async () => {
  sql = (await getConnection()) as Sql;
  // Ensure migration is applied
  await sql`
    CREATE TABLE IF NOT EXISTS omni_requests (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent         TEXT NOT NULL,
      chat_id       TEXT NOT NULL,
      instance_id   TEXT NOT NULL DEFAULT '',
      content       TEXT NOT NULL,
      sender        TEXT NOT NULL DEFAULT '',
      env           JSONB NOT NULL DEFAULT '{}',
      status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed')),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at    TIMESTAMPTZ,
      completed_at  TIMESTAMPTZ,
      attempts      INTEGER NOT NULL DEFAULT 0,
      max_attempts  INTEGER NOT NULL DEFAULT 3,
      next_retry_at TIMESTAMPTZ
    )
  `;
  // Clean slate
  await sql`DELETE FROM omni_requests`;
});

afterEach(async () => {
  await sql`DELETE FROM omni_requests`;
});

function makeMessage(overrides: Partial<OmniMessage> = {}): OmniMessage {
  return {
    content: 'hello',
    sender: 'user@test',
    instanceId: 'inst-1',
    chatId: 'chat-1',
    agent: 'test-agent',
    ...overrides,
  };
}

// ============================================================================
// Enqueue
// ============================================================================

describe('OmniQueue — enqueue', () => {
  it('persists a message and returns an id', async () => {
    const handler = async () => {};
    const queue = new OmniQueue(sql, handler);

    const id = await queue.enqueue(makeMessage());
    expect(id).toBeDefined();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const rows = await sql`SELECT * FROM omni_requests WHERE id = ${id}`;
    expect(rows.length).toBe(1);
    expect(rows[0].agent).toBe('test-agent');
    expect(rows[0].chat_id).toBe('chat-1');
    expect(rows[0].content).toBe('hello');
    expect(rows[0].status).toBe('pending');
    expect(rows[0].attempts).toBe(0);
  });

  it('stores env as JSONB', async () => {
    const handler = async () => {};
    const queue = new OmniQueue(sql, handler);

    const id = await queue.enqueue(makeMessage(), { OMNI_INSTANCE: 'inst-1', OMNI_CHAT: 'chat-1' });
    const rows = await sql`SELECT env FROM omni_requests WHERE id = ${id}`;
    // postgres.js may return JSONB as string depending on driver config — parse defensively
    const env = typeof rows[0].env === 'string' ? JSON.parse(rows[0].env) : rows[0].env;
    expect(env).toEqual({ OMNI_INSTANCE: 'inst-1', OMNI_CHAT: 'chat-1' });
  });
});

// ============================================================================
// Processing
// ============================================================================

describe('OmniQueue — processing', () => {
  it('processes a pending request via handler', async () => {
    const processed: QueuedRequest[] = [];
    const handler = async (req: QueuedRequest) => {
      processed.push(req);
    };
    const queue = new OmniQueue(sql, handler, { pollIntervalMs: 50 });

    await queue.enqueue(makeMessage({ content: 'test-msg' }));
    queue.start();

    // Wait for poll to pick it up
    await new Promise((r) => setTimeout(r, 200));
    queue.stop();

    expect(processed.length).toBe(1);
    expect(processed[0].content).toBe('test-msg');
    expect(processed[0].agent).toBe('test-agent');

    // Verify marked as done in PG
    const rows = await sql`SELECT status FROM omni_requests WHERE agent = 'test-agent'`;
    expect(rows[0].status).toBe('done');
  });

  it('retries failed requests with exponential backoff', async () => {
    let callCount = 0;
    const handler = async () => {
      callCount++;
      if (callCount <= 2) throw new Error('transient failure');
    };
    // Use very short poll + override backoff by setting next_retry_at to now after failure
    const queue = new OmniQueue(sql, handler, { pollIntervalMs: 50 });

    const id = await queue.enqueue(makeMessage());
    queue.start();

    // Wait for first attempt + failure
    await new Promise((r) => setTimeout(r, 200));

    // First attempt fails, gets scheduled for retry with backoff.
    // Force retry to be immediate for testing.
    await sql`UPDATE omni_requests SET next_retry_at = now() WHERE id = ${id}`;
    await new Promise((r) => setTimeout(r, 200));

    // Second attempt fails too.
    await sql`UPDATE omni_requests SET next_retry_at = now() WHERE id = ${id}`;
    await new Promise((r) => setTimeout(r, 200));

    queue.stop();

    // Third attempt should succeed
    expect(callCount).toBe(3);
    const rows = await sql`SELECT status, attempts FROM omni_requests WHERE id = ${id}`;
    expect(rows[0].status).toBe('done');
    expect(rows[0].attempts).toBe(3);
  });

  it('marks request as failed after max_attempts exhausted', async () => {
    const handler = async () => {
      throw new Error('permanent failure');
    };
    const queue = new OmniQueue(sql, handler, { pollIntervalMs: 50 });

    // Insert with max_attempts=1 so first failure is terminal
    await sql`
      INSERT INTO omni_requests (agent, chat_id, instance_id, content, sender, max_attempts)
      VALUES ('test-agent', 'chat-1', 'inst-1', 'doomed', 'user', 1)
    `;

    queue.start();
    await new Promise((r) => setTimeout(r, 200));
    queue.stop();

    const rows = await sql`SELECT status FROM omni_requests WHERE content = 'doomed'`;
    expect(rows[0].status).toBe('failed');
  });
});

// ============================================================================
// Rate limiting
// ============================================================================

describe('OmniQueue — rate limiting', () => {
  it('respects per-agent rate limit', async () => {
    const processed: string[] = [];
    const handler = async (req: QueuedRequest) => {
      processed.push(req.id);
    };
    // Rate limit: 2 per minute
    const queue = new OmniQueue(sql, handler, { pollIntervalMs: 50, maxPerMinute: 2 });

    // Enqueue 4 messages
    for (let i = 0; i < 4; i++) {
      await queue.enqueue(makeMessage({ content: `msg-${i}` }));
    }

    queue.start();
    await new Promise((r) => setTimeout(r, 500));
    queue.stop();

    // Only 2 should have been processed (rate limited)
    expect(processed.length).toBe(2);

    // Remaining 2 should still be pending
    const pending = await sql`SELECT count(*)::int as c FROM omni_requests WHERE status = 'pending'`;
    expect(pending[0].c).toBe(2);
  });
});

// ============================================================================
// Recovery
// ============================================================================

describe('OmniQueue — recovery', () => {
  it('recovers stale processing rows', async () => {
    const handler = async () => {};
    const queue = new OmniQueue(sql, handler, { staleTimeoutMs: 1_000 });

    // Insert a "processing" row that started 10 seconds ago (stale at 1s threshold)
    await sql`
      INSERT INTO omni_requests (agent, chat_id, instance_id, content, sender, status, started_at)
      VALUES ('test-agent', 'chat-1', 'inst-1', 'stale', 'user', 'processing', now() - interval '10 seconds')
    `;

    const recovered = await queue.recoverStale();
    expect(recovered).toBe(1);

    const rows = await sql`SELECT status, started_at FROM omni_requests WHERE content = 'stale'`;
    expect(rows[0].status).toBe('pending');
    expect(rows[0].started_at).toBeNull();
  });

  it('does not recover recently started processing rows', async () => {
    const handler = async () => {};
    const queue = new OmniQueue(sql, handler, { staleTimeoutMs: 60_000 });

    // Insert a "processing" row that just started
    await sql`
      INSERT INTO omni_requests (agent, chat_id, instance_id, content, sender, status, started_at)
      VALUES ('test-agent', 'chat-1', 'inst-1', 'fresh', 'user', 'processing', now())
    `;

    const recovered = await queue.recoverStale();
    expect(recovered).toBe(0);

    const rows = await sql`SELECT status FROM omni_requests WHERE content = 'fresh'`;
    expect(rows[0].status).toBe('processing');
  });
});

// ============================================================================
// Stats
// ============================================================================

describe('OmniQueue — stats', () => {
  it('returns correct counts per status', async () => {
    const handler = async () => {};
    const queue = new OmniQueue(sql, handler);

    // Insert various statuses
    await sql`INSERT INTO omni_requests (agent, chat_id, content, sender, status) VALUES ('a', 'c', 'x', 's', 'pending')`;
    await sql`INSERT INTO omni_requests (agent, chat_id, content, sender, status) VALUES ('a', 'c', 'x', 's', 'pending')`;
    await sql`INSERT INTO omni_requests (agent, chat_id, content, sender, status, started_at) VALUES ('a', 'c', 'x', 's', 'processing', now())`;
    await sql`INSERT INTO omni_requests (agent, chat_id, content, sender, status, completed_at) VALUES ('a', 'c', 'x', 's', 'done', now())`;
    await sql`INSERT INTO omni_requests (agent, chat_id, content, sender, status, completed_at) VALUES ('a', 'c', 'x', 's', 'failed', now())`;

    const stats = await queue.stats();
    expect(stats.pending).toBe(2);
    expect(stats.processing).toBe(1);
    expect(stats.done).toBe(1);
    expect(stats.failed).toBe(1);
  });

  it('returns zeros when queue is empty', async () => {
    const handler = async () => {};
    const queue = new OmniQueue(sql, handler);

    const stats = await queue.stats();
    expect(stats.pending).toBe(0);
    expect(stats.processing).toBe(0);
    expect(stats.done).toBe(0);
    expect(stats.failed).toBe(0);
  });
});
