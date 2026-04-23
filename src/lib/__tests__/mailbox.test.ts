/**
 * Mailbox — Unit Tests & Edge Cases (PG backend)
 *
 * Tests durable message store with unread/read semantics against PostgreSQL.
 * QA Plan tests: U-MSG-06, U-MSG-07, U-MSG-08, C-MB-01
 *
 * Run with: bun test src/lib/__tests__/mailbox.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getUnread, inbox, markDelivered, markRead, readOutbox, send, toNativeInboxMessage } from '../mailbox.js';
import { DB_AVAILABLE, setupTestDatabase } from '../test-db.js';

describe.skipIf(!DB_AVAILABLE)('pg', () => {
  let cleanup: () => Promise<void>;
  const REPO = '/tmp/mailbox-test-repo';

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanup();
  });

  // ============================================================================
  // Basic send/inbox
  // ============================================================================

  describe('send', () => {
    test('persists message to mailbox', async () => {
      const msg = await send(REPO, 'operator', 'worker-1', 'hello worker');
      expect(msg.id).toMatch(/^msg-/);
      expect(msg.from).toBe('operator');
      expect(msg.to).toBe('worker-1');
      expect(msg.body).toBe('hello worker');
      expect(msg.read).toBe(false);
      expect(msg.deliveredAt).toBeNull();
      expect(msg.createdAt).toBeTruthy();
    });

    // U-MSG-06: send() works without any prior setup (PG handles it)
    test('U-MSG-06: sends to new worker without prior setup', async () => {
      const msg = await send(REPO, 'sender', 'new-worker', 'first message');
      expect(msg.id).toMatch(/^msg-/);

      const messages = await inbox(REPO, 'new-worker');
      expect(messages.length).toBe(1);
      expect(messages[0].body).toBe('first message');
    });

    test('appends multiple messages to same worker mailbox', async () => {
      const repo = '/tmp/multi-msg-test';
      await send(repo, 'alice', 'bob', 'msg 1');
      await send(repo, 'charlie', 'bob', 'msg 2');
      await send(repo, 'alice', 'bob', 'msg 3');

      const messages = await inbox(repo, 'bob');
      expect(messages.length).toBe(3);
      expect(messages[0].from).toBe('alice');
      expect(messages[1].from).toBe('charlie');
      expect(messages[2].from).toBe('alice');
    });
  });

  // ============================================================================
  // inbox
  // ============================================================================

  describe('inbox', () => {
    test('returns empty for non-existent worker', async () => {
      const messages = await inbox(REPO, 'nonexistent');
      expect(messages).toEqual([]);
    });

    test('returns all messages', async () => {
      const repo = '/tmp/inbox-test';
      await send(repo, 'a', 'target', 'hello');
      await send(repo, 'b', 'target', 'world');

      const messages = await inbox(repo, 'target');
      expect(messages.length).toBe(2);
    });
  });

  // ============================================================================
  // readOutbox
  // ============================================================================

  describe('readOutbox', () => {
    test('returns messages sent by a worker', async () => {
      const repo = '/tmp/outbox-test';
      await send(repo, 'sender-agent', 'recipient-1', 'msg A');
      await send(repo, 'sender-agent', 'recipient-2', 'msg B');
      await send(repo, 'other-agent', 'recipient-1', 'msg C');

      const outbox = await readOutbox(repo, 'sender-agent');
      expect(outbox.length).toBe(2);
      expect(outbox[0].body).toBe('msg A');
      expect(outbox[1].body).toBe('msg B');
    });

    test('returns empty for non-existent worker', async () => {
      const outbox = await readOutbox(REPO, 'no-such-sender');
      expect(outbox).toEqual([]);
    });
  });

  // ============================================================================
  // markDelivered
  // ============================================================================

  describe('markDelivered', () => {
    test('marks message as delivered', async () => {
      const repo = '/tmp/deliver-test';
      const msg = await send(repo, 'sender', 'worker', 'test');
      expect(msg.deliveredAt).toBeNull();

      const result = await markDelivered(repo, 'worker', msg.id);
      expect(result).toBe(true);

      const messages = await inbox(repo, 'worker');
      const delivered = messages.find((m) => m.id === msg.id);
      expect(delivered?.deliveredAt).toBeTruthy();
    });

    // U-MSG-07: markDelivered on non-existent message
    test('U-MSG-07: returns false for non-existent message', async () => {
      const repo = '/tmp/deliver-notfound-test';
      await send(repo, 'sender', 'worker', 'test');
      const result = await markDelivered(repo, 'worker', 'msg-nonexistent');
      expect(result).toBe(false);
    });

    test('returns false for non-existent worker', async () => {
      const result = await markDelivered(REPO, 'no-worker', 'msg-123');
      expect(result).toBe(false);
    });
  });

  // ============================================================================
  // getUnread / markRead
  // ============================================================================

  describe('getUnread / markRead', () => {
    test('getUnread returns only unread messages', async () => {
      const repo = '/tmp/unread-test';
      const msg1 = await send(repo, 'a', 'reader', 'unread msg');
      const msg2 = await send(repo, 'b', 'reader', 'also unread');

      // Mark one as read
      await markRead(msg1.id);

      const unread = await getUnread(repo, 'reader');
      expect(unread.length).toBe(1);
      expect(unread[0].id).toBe(msg2.id);
    });

    test('markRead returns false for non-existent message', async () => {
      const result = await markRead('msg-no-such');
      expect(result).toBe(false);
    });
  });

  // ============================================================================
  // toNativeInboxMessage
  // ============================================================================

  describe('toNativeInboxMessage', () => {
    // U-MSG-08: Body truncation > 8 words
    test('U-MSG-08: truncates body > 8 words with ... suffix', () => {
      const msg = {
        id: 'msg-test',
        from: 'sender',
        to: 'worker',
        body: 'one two three four five six seven eight nine ten',
        createdAt: '2026-01-01T00:00:00.000Z',
        read: false,
        deliveredAt: null,
      };

      const native = toNativeInboxMessage(msg);
      expect(native.summary).toBe('one two three four five six seven eight...');
      expect(native.text).toBe(msg.body); // full body preserved
      expect(native.from).toBe('sender');
      expect(native.color).toBe('blue'); // default color
    });

    test('does not truncate body <= 8 words', () => {
      const msg = {
        id: 'msg-test',
        from: 'sender',
        to: 'worker',
        body: 'short message here',
        createdAt: '2026-01-01T00:00:00.000Z',
        read: false,
        deliveredAt: null,
      };

      const native = toNativeInboxMessage(msg);
      expect(native.summary).toBe('short message here');
      expect(native.summary).not.toContain('...');
    });

    test('respects custom color', () => {
      const msg = {
        id: 'msg-test',
        from: 'sender',
        to: 'worker',
        body: 'test',
        createdAt: '2026-01-01T00:00:00.000Z',
        read: false,
        deliveredAt: null,
      };

      const native = toNativeInboxMessage(msg, 'red');
      expect(native.color).toBe('red');
    });
  });

  // ============================================================================
  // Concurrency — C-MB-01
  // ============================================================================

  describe('concurrent mailbox writes', () => {
    // C-MB-01: 10 concurrent send() to same worker — PG handles concurrency
    test('C-MB-01: 10 concurrent send() — no data loss with PG', async () => {
      const repo = '/tmp/concurrent-test';
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) => send(repo, `sender-${i}`, 'target-worker', `message ${i}`)),
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled.length).toBe(10);

      const messages = await inbox(repo, 'target-worker');
      // PG guarantees no data loss under concurrent writes
      expect(messages.length).toBe(10);
    });
  });

  // ============================================================================
  // Repo scoping
  // ============================================================================

  describe('repo scoping', () => {
    test('messages are scoped to repo_path', async () => {
      const repo1 = '/tmp/repo-scope-1';
      const repo2 = '/tmp/repo-scope-2';

      await send(repo1, 'a', 'worker', 'repo1 msg');
      await send(repo2, 'b', 'worker', 'repo2 msg');

      const inbox1 = await inbox(repo1, 'worker');
      const inbox2 = await inbox(repo2, 'worker');

      expect(inbox1.length).toBe(1);
      expect(inbox1[0].body).toBe('repo1 msg');
      expect(inbox2.length).toBe(1);
      expect(inbox2[0].body).toBe('repo2 msg');
    });
  });
});
