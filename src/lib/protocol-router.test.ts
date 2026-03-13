/**
 * Protocol Router — Unit Tests
 *
 * Tests inbox retrieval and message routing logic.
 * Full sendMessage tests require tmux (integration-level).
 *
 * Run with: bun test src/lib/protocol-router.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mailbox from './mailbox.js';

// ---------------------------------------------------------------------------
// Environment isolation
// ---------------------------------------------------------------------------

const ENV_KEYS = ['GENIE_HOME', 'TMUX', 'TMUX_PANE'] as const;
let savedEnv: Record<string, string | undefined>;
let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'proto-router-test-'));
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
  }
  process.env.GENIE_HOME = join(tempDir, '.genie-home');
  // Disable tmux to prevent auto-spawn attempts
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
});

afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// getInbox tests (uses mailbox directly, no tmux dependency)
// ---------------------------------------------------------------------------

describe('getInbox', () => {
  test('returns empty inbox for unknown worker', async () => {
    const { getInbox } = await import('./protocol-router.js');
    const messages = await getInbox(tempDir, 'unknown-worker');
    expect(messages).toEqual([]);
  });

  test('returns messages after mailbox.send', async () => {
    const { getInbox } = await import('./protocol-router.js');

    // Directly write to mailbox (bypasses delivery which needs tmux)
    await mailbox.send(tempDir, 'alice', 'bob', 'hello bob');
    await mailbox.send(tempDir, 'alice', 'bob', 'follow up');

    const messages = await getInbox(tempDir, 'bob');
    expect(messages.length).toBe(2);
    expect(messages[0].from).toBe('alice');
    expect(messages[0].body).toBe('hello bob');
    expect(messages[1].body).toBe('follow up');
  });

  test('returns messages with correct metadata', async () => {
    const { getInbox } = await import('./protocol-router.js');

    await mailbox.send(tempDir, 'sender', 'receiver', 'test message');

    const messages = await getInbox(tempDir, 'receiver');
    expect(messages.length).toBe(1);

    const msg = messages[0];
    expect(msg.id).toMatch(/^msg-/);
    expect(msg.from).toBe('sender');
    expect(msg.to).toBe('receiver');
    expect(msg.body).toBe('test message');
    expect(msg.read).toBe(false);
    expect(msg.deliveredAt).toBeNull();
    expect(msg.createdAt).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// sendMessage — no-tmux fallback behavior
// ---------------------------------------------------------------------------

describe('sendMessage (no tmux)', () => {
  test('returns not-found when worker does not exist and no tmux', async () => {
    const { sendMessage } = await import('./protocol-router.js');

    const result = await sendMessage(tempDir, 'alice', 'nonexistent', 'hello');
    expect(result.delivered).toBe(false);
    expect(result.reason).toContain('not found');
  });
});
