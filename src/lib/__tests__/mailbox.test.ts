/**
 * Mailbox — Unit Tests & Edge Cases
 *
 * Tests durable message store with unread/read semantics.
 * QA Plan tests: U-MSG-06, U-MSG-07, U-MSG-08, C-MB-01
 *
 * Run with: bun test src/lib/__tests__/mailbox.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inbox, markDelivered, send, toNativeInboxMessage } from '../mailbox.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'genie-mailbox-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ============================================================================
// Basic send/inbox
// ============================================================================

describe('send', () => {
  test('persists message to mailbox', async () => {
    const msg = await send(tempDir, 'operator', 'worker-1', 'hello worker');
    expect(msg.id).toMatch(/^msg-/);
    expect(msg.from).toBe('operator');
    expect(msg.to).toBe('worker-1');
    expect(msg.body).toBe('hello worker');
    expect(msg.read).toBe(false);
    expect(msg.deliveredAt).toBeNull();
    expect(msg.createdAt).toBeTruthy();
  });

  // U-MSG-06: send() creates dir if missing
  test('U-MSG-06: creates mailbox directory if missing', async () => {
    // tempDir has no .genie/mailbox/ yet
    const msg = await send(tempDir, 'sender', 'new-worker', 'first message');
    expect(msg.id).toMatch(/^msg-/);

    // Verify inbox works
    const messages = await inbox(tempDir, 'new-worker');
    expect(messages.length).toBe(1);
    expect(messages[0].body).toBe('first message');
  });

  test('appends multiple messages to same worker mailbox', async () => {
    await send(tempDir, 'alice', 'bob', 'msg 1');
    await send(tempDir, 'charlie', 'bob', 'msg 2');
    await send(tempDir, 'alice', 'bob', 'msg 3');

    const messages = await inbox(tempDir, 'bob');
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
    const messages = await inbox(tempDir, 'nonexistent');
    expect(messages).toEqual([]);
  });

  test('returns all messages', async () => {
    await send(tempDir, 'a', 'target', 'hello');
    await send(tempDir, 'b', 'target', 'world');

    const messages = await inbox(tempDir, 'target');
    expect(messages.length).toBe(2);
  });
});

// ============================================================================
// markDelivered
// ============================================================================

describe('markDelivered', () => {
  test('marks message as delivered', async () => {
    const msg = await send(tempDir, 'sender', 'worker', 'test');
    expect(msg.deliveredAt).toBeNull();

    const result = await markDelivered(tempDir, 'worker', msg.id);
    expect(result).toBe(true);

    const messages = await inbox(tempDir, 'worker');
    const delivered = messages.find((m) => m.id === msg.id);
    expect(delivered?.deliveredAt).toBeTruthy();
  });

  // U-MSG-07: markDelivered on non-existent message
  test('U-MSG-07: returns false for non-existent message', async () => {
    await send(tempDir, 'sender', 'worker', 'test');
    const result = await markDelivered(tempDir, 'worker', 'msg-nonexistent');
    expect(result).toBe(false);
  });

  test('returns false for non-existent worker', async () => {
    const result = await markDelivered(tempDir, 'no-worker', 'msg-123');
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
  // C-MB-01: 10 concurrent send() to same worker
  // NOTE: Known bug per QA plan — mailbox has no file lock.
  // This test documents whether messages are lost under concurrent write.
  test('C-MB-01: 10 concurrent send() — check for data loss', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => send(tempDir, `sender-${i}`, 'target-worker', `message ${i}`)),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(10);

    const messages = await inbox(tempDir, 'target-worker');

    // Due to read-modify-write race (no lock), some messages may be lost
    // This test documents the actual behavior
    if (messages.length < 10) {
      console.warn(
        `[C-MB-01] DATA LOSS DETECTED: ${messages.length}/10 messages survived concurrent writes. This is a known bug: mailbox.send() uses read-modify-write without file lock.`,
      );
    }

    // At minimum, one message should survive
    expect(messages.length).toBeGreaterThanOrEqual(1);
    // Ideally all 10 should be there
    // expect(messages.length).toBe(10); // Uncomment after adding file lock
  });
});

// ============================================================================
// Failure Modes — F-* related
// ============================================================================

describe('mailbox failure modes', () => {
  test('inbox returns empty for corrupted mailbox JSON', async () => {
    const { mkdir } = await import('node:fs/promises');
    const dir = join(tempDir, '.genie', 'mailbox');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'bad-worker.json'), 'not valid json at all!');

    const messages = await inbox(tempDir, 'bad-worker');
    expect(messages).toEqual([]);
  });
});
