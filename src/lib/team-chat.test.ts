/**
 * Team Chat — Unit Tests
 *
 * Tests JSONL-based group chat channel for teams.
 *
 * Run with: bun test src/lib/team-chat.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
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
