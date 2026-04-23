/**
 * Team Chat — Unit Tests (PG backend)
 *
 * Tests PG-backed group chat channel for teams.
 *
 * Run with: bun test src/lib/team-chat.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { postMessage, readMessages } from './team-chat.js';
import { DB_AVAILABLE, setupTestDatabase } from './test-db.js';

describe.skipIf(!DB_AVAILABLE)('pg', () => {
  let cleanup: () => Promise<void>;
  const REPO = '/tmp/team-chat-test-repo';

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanup();
  });

  describe('postMessage', () => {
    test('inserts message and returns it', async () => {
      const msg = await postMessage(REPO, 'feat/auth', 'implementor', 'hello team');

      expect(msg.id).toMatch(/^chat-/);
      expect(msg.sender).toBe('implementor');
      expect(msg.body).toBe('hello team');
      expect(msg.timestamp).toBeTruthy();
    });

    test('stores multiple messages in same channel', async () => {
      const repo = '/tmp/multi-chat-test';
      await postMessage(repo, 'dev-team', 'alice', 'first message');
      await postMessage(repo, 'dev-team', 'bob', 'second message');
      await postMessage(repo, 'dev-team', 'alice', 'third message');

      const messages = await readMessages(repo, 'dev-team');
      expect(messages.length).toBe(3);
      expect(messages[0].sender).toBe('alice');
      expect(messages[1].sender).toBe('bob');
      expect(messages[2].sender).toBe('alice');
    });

    test('generates unique IDs for each message', async () => {
      const repo = '/tmp/unique-id-test';
      const msg1 = await postMessage(repo, 'team', 'agent', 'msg1');
      const msg2 = await postMessage(repo, 'team', 'agent', 'msg2');

      expect(msg1.id).not.toBe(msg2.id);
    });

    test('handles team names with slashes', async () => {
      const repo = '/tmp/slash-team-test';
      await postMessage(repo, 'feat/my-feature', 'agent', 'hello');

      const messages = await readMessages(repo, 'feat/my-feature');
      expect(messages.length).toBe(1);
      expect(messages[0].body).toBe('hello');
    });
  });

  describe('readMessages', () => {
    test('returns empty array for non-existent channel', async () => {
      const messages = await readMessages(REPO, 'no-such-team');
      expect(messages).toEqual([]);
    });

    test('returns all posted messages', async () => {
      const repo = '/tmp/read-all-test';
      await postMessage(repo, 'team', 'alice', 'hello');
      await postMessage(repo, 'team', 'bob', 'world');

      const messages = await readMessages(repo, 'team');
      expect(messages.length).toBe(2);
      expect(messages[0].sender).toBe('alice');
      expect(messages[0].body).toBe('hello');
      expect(messages[1].sender).toBe('bob');
      expect(messages[1].body).toBe('world');
    });

    test('filters by since timestamp', async () => {
      const repo = '/tmp/since-filter-test';
      await postMessage(repo, 'team', 'alice', 'old message');

      // Small delay to ensure timestamp difference
      await new Promise((r) => setTimeout(r, 10));
      const midpoint = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 10));

      await postMessage(repo, 'team', 'bob', 'new message');

      const filtered = await readMessages(repo, 'team', midpoint);
      expect(filtered.length).toBe(1);
      expect(filtered[0].sender).toBe('bob');
      expect(filtered[0].body).toBe('new message');
    });

    test('returns all messages when since is before all messages', async () => {
      const repo = '/tmp/since-old-test';
      const longAgo = '2020-01-01T00:00:00.000Z';
      await postMessage(repo, 'team', 'alice', 'msg1');
      await postMessage(repo, 'team', 'bob', 'msg2');

      const messages = await readMessages(repo, 'team', longAgo);
      expect(messages.length).toBe(2);
    });

    test('returns empty when since is in the future', async () => {
      const repo = '/tmp/since-future-test';
      await postMessage(repo, 'team', 'alice', 'msg1');

      const future = '2099-01-01T00:00:00.000Z';
      const messages = await readMessages(repo, 'team', future);
      expect(messages.length).toBe(0);
    });
  });

  describe('repo scoping', () => {
    test('messages are scoped to repo_path', async () => {
      const repo1 = '/tmp/chat-scope-1';
      const repo2 = '/tmp/chat-scope-2';

      await postMessage(repo1, 'shared-team', 'alice', 'repo1 msg');
      await postMessage(repo2, 'shared-team', 'bob', 'repo2 msg');

      const msgs1 = await readMessages(repo1, 'shared-team');
      const msgs2 = await readMessages(repo2, 'shared-team');

      expect(msgs1.length).toBe(1);
      expect(msgs1[0].body).toBe('repo1 msg');
      expect(msgs2.length).toBe(1);
      expect(msgs2[0].body).toBe('repo2 msg');
    });
  });

  describe('concurrent writes', () => {
    test('10 concurrent postMessage — no data loss with PG', async () => {
      const repo = '/tmp/concurrent-chat-test';
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) => postMessage(repo, 'team', `agent-${i}`, `message ${i}`)),
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled.length).toBe(10);

      const messages = await readMessages(repo, 'team');
      expect(messages.length).toBe(10);
    });
  });
});
