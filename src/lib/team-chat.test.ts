/**
 * Team Chat — Unit Tests
 *
 * Tests JSONL-based group chat channel for teams.
 *
 * Run with: bun test src/lib/team-chat.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postMessage, readMessages } from './team-chat.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'team-chat-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('postMessage', () => {
  test('creates JSONL file and appends message', async () => {
    const msg = await postMessage(tempDir, 'feat/auth', 'implementor', 'hello team');

    expect(msg.id).toMatch(/^chat-/);
    expect(msg.sender).toBe('implementor');
    expect(msg.body).toBe('hello team');
    expect(msg.timestamp).toBeTruthy();

    // Verify file contents
    const filePath = join(tempDir, '.genie', 'chat', 'feat--auth.jsonl');
    const content = await readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.sender).toBe('implementor');
    expect(parsed.body).toBe('hello team');
  });

  test('appends multiple messages to same channel', async () => {
    await postMessage(tempDir, 'dev-team', 'alice', 'first message');
    await postMessage(tempDir, 'dev-team', 'bob', 'second message');
    await postMessage(tempDir, 'dev-team', 'alice', 'third message');

    const filePath = join(tempDir, '.genie', 'chat', 'dev-team.jsonl');
    const content = await readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(3);

    const messages = lines.map((l) => JSON.parse(l));
    expect(messages[0].sender).toBe('alice');
    expect(messages[1].sender).toBe('bob');
    expect(messages[2].sender).toBe('alice');
  });

  test('generates unique IDs for each message', async () => {
    const msg1 = await postMessage(tempDir, 'team', 'agent', 'msg1');
    const msg2 = await postMessage(tempDir, 'team', 'agent', 'msg2');

    expect(msg1.id).not.toBe(msg2.id);
  });

  test('sanitizes team name with slashes for filename', async () => {
    await postMessage(tempDir, 'feat/my-feature', 'agent', 'hello');

    const filePath = join(tempDir, '.genie', 'chat', 'feat--my-feature.jsonl');
    const content = await readFile(filePath, 'utf-8');
    expect(content.trim()).toBeTruthy();
  });
});

describe('readMessages', () => {
  test('returns empty array for non-existent channel', async () => {
    const messages = await readMessages(tempDir, 'no-such-team');
    expect(messages).toEqual([]);
  });

  test('returns all posted messages', async () => {
    await postMessage(tempDir, 'team', 'alice', 'hello');
    await postMessage(tempDir, 'team', 'bob', 'world');

    const messages = await readMessages(tempDir, 'team');
    expect(messages.length).toBe(2);
    expect(messages[0].sender).toBe('alice');
    expect(messages[0].body).toBe('hello');
    expect(messages[1].sender).toBe('bob');
    expect(messages[1].body).toBe('world');
  });

  test('filters by since timestamp', async () => {
    await postMessage(tempDir, 'team', 'alice', 'old message');

    // Small delay to ensure timestamp difference
    await new Promise((r) => setTimeout(r, 10));
    const midpoint = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 10));

    await postMessage(tempDir, 'team', 'bob', 'new message');

    const filtered = await readMessages(tempDir, 'team', midpoint);
    expect(filtered.length).toBe(1);
    expect(filtered[0].sender).toBe('bob');
    expect(filtered[0].body).toBe('new message');
  });

  test('returns all messages when since is before all messages', async () => {
    const longAgo = '2020-01-01T00:00:00.000Z';
    await postMessage(tempDir, 'team', 'alice', 'msg1');
    await postMessage(tempDir, 'team', 'bob', 'msg2');

    const messages = await readMessages(tempDir, 'team', longAgo);
    expect(messages.length).toBe(2);
  });

  test('returns empty when since is in the future', async () => {
    await postMessage(tempDir, 'team', 'alice', 'msg1');

    const future = '2099-01-01T00:00:00.000Z';
    const messages = await readMessages(tempDir, 'team', future);
    expect(messages.length).toBe(0);
  });
});

// ============================================================================
// Edge Cases — QA Plan P0 Tests (U-MSG-*)
// ============================================================================

describe('postMessage edge cases', () => {
  // U-MSG-01: Newlines in body — JSONL integrity
  test('U-MSG-01: newlines in body are JSON-escaped, roundtrip works', async () => {
    const bodyWithNewlines = 'line 1\nline 2\nline 3';
    await postMessage(tempDir, 'team', 'agent', bodyWithNewlines);

    // Verify raw file has single JSONL line (no unescaped newlines)
    const filePath = join(tempDir, '.genie', 'chat', 'team.jsonl');
    const raw = await readFile(filePath, 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines.length).toBe(1);

    // Roundtrip: read back and verify body preserved
    const messages = await readMessages(tempDir, 'team');
    expect(messages.length).toBe(1);
    expect(messages[0].body).toBe(bodyWithNewlines);
  });

  // U-MSG-05: chatFilePath replaces / with -- in team name
  test('U-MSG-05: team name with multiple slashes sanitized correctly', async () => {
    await postMessage(tempDir, 'feat/my/deep/feature', 'agent', 'test');

    const filePath = join(tempDir, '.genie', 'chat', 'feat--my--deep--feature.jsonl');
    const content = await readFile(filePath, 'utf-8');
    expect(content.trim()).toBeTruthy();
    const parsed = JSON.parse(content.trim());
    expect(parsed.body).toBe('test');
  });
});

describe('readMessages edge cases', () => {
  // U-MSG-02: Malformed JSONL lines
  test('U-MSG-02: skips malformed JSONL lines, returns valid ones', async () => {
    const chatDir = join(tempDir, '.genie', 'chat');
    await mkdir(chatDir, { recursive: true });
    const filePath = join(chatDir, 'team.jsonl');

    // Write mix of valid and invalid lines
    const validMsg = JSON.stringify({
      id: 'chat-valid',
      sender: 'alice',
      body: 'hello',
      timestamp: new Date().toISOString(),
    });
    await appendFile(filePath, `${validMsg}\n`);
    await appendFile(filePath, 'THIS IS NOT JSON\n');
    await appendFile(filePath, '{"incomplete": true\n');
    const validMsg2 = JSON.stringify({
      id: 'chat-valid-2',
      sender: 'bob',
      body: 'world',
      timestamp: new Date().toISOString(),
    });
    await appendFile(filePath, `${validMsg2}\n`);

    const messages = await readMessages(tempDir, 'team');
    expect(messages.length).toBe(2);
    expect(messages[0].sender).toBe('alice');
    expect(messages[1].sender).toBe('bob');
  });

  // U-MSG-03: Empty file
  test('U-MSG-03: empty file returns empty array', async () => {
    const chatDir = join(tempDir, '.genie', 'chat');
    await mkdir(chatDir, { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(chatDir, 'empty.jsonl'), '');

    const messages = await readMessages(tempDir, 'empty');
    expect(messages).toEqual([]);
  });

  // U-MSG-04: Non-existent file returns []
  test('U-MSG-04: non-existent file returns empty array', async () => {
    const messages = await readMessages(tempDir, 'nonexistent-channel');
    expect(messages).toEqual([]);
  });

  // U-MSG-09: since filter
  test('U-MSG-09: since filter only returns messages >= since timestamp', async () => {
    // Post messages at different times
    await postMessage(tempDir, 'timed', 'agent', 'msg-1');
    await new Promise((r) => setTimeout(r, 15));
    const midpoint = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 15));
    await postMessage(tempDir, 'timed', 'agent', 'msg-2');
    await postMessage(tempDir, 'timed', 'agent', 'msg-3');

    const filtered = await readMessages(tempDir, 'timed', midpoint);
    expect(filtered.length).toBe(2);
    expect(filtered[0].body).toBe('msg-2');
    expect(filtered[1].body).toBe('msg-3');
  });
});

// ============================================================================
// Concurrency — C-TC-01
// ============================================================================

describe('concurrent chat operations', () => {
  // C-TC-01: 20 concurrent postMessage() to same channel
  test('C-TC-01: 20 concurrent postMessage() — all 20 present, no corruption', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => postMessage(tempDir, 'concurrent', `agent-${i}`, `message ${i}`)),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(20);

    const messages = await readMessages(tempDir, 'concurrent');
    expect(messages.length).toBe(20);

    // All messages should be valid (no partial lines)
    for (const msg of messages) {
      expect(msg.id).toMatch(/^chat-/);
      expect(msg.sender).toBeTruthy();
      expect(msg.body).toBeTruthy();
    }
  });

  // C-TC-02: postMessage() during readMessages() — read returns valid subset
  test('C-TC-02: postMessage during readMessages returns valid data', async () => {
    // Seed some initial messages
    for (let i = 0; i < 5; i++) {
      await postMessage(tempDir, 'race-channel', 'seed', `initial-${i}`);
    }

    // Race: read and write simultaneously
    const [readResult, writeResult] = await Promise.allSettled([
      readMessages(tempDir, 'race-channel'),
      postMessage(tempDir, 'race-channel', 'racer', 'concurrent-write'),
    ]);

    expect(readResult.status).toBe('fulfilled');
    expect(writeResult.status).toBe('fulfilled');

    if (readResult.status === 'fulfilled') {
      // Read should return at least the 5 initial messages (may or may not include the concurrent one)
      expect(readResult.value.length).toBeGreaterThanOrEqual(5);
      // All returned messages should be valid (no partial JSON lines)
      for (const msg of readResult.value) {
        expect(msg.id).toMatch(/^chat-/);
        expect(msg.body).toBeTruthy();
      }
    }
  });
});
