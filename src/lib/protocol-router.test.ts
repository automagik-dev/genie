/**
 * Protocol Router — Unit Tests
 *
 * Tests inbox retrieval, message routing logic, and concurrent spawn dedup.
 * Full sendMessage tests require tmux (integration-level).
 *
 * Run with: bun test src/lib/protocol-router.test.ts
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mailbox from './mailbox.js';
import { DB_AVAILABLE, setupTestSchema } from './test-db.js';

// ============================================================================
// Module mocks — hoisted by bun:test, must be declared before describe blocks.
// These only affect code paths that use tmux/auto-spawn; existing non-tmux
// tests are unaffected because they never register workers or set TMUX.
// ============================================================================

/** Set of pane IDs that isPaneAlive should report as alive. */
const alivePanes = new Set<string>();

/** Count of spawnWorkerFromTemplate invocations (reset in beforeEach). */
let spawnCallCount = 0;

mock.module('./tmux.js', () => ({
  isPaneAlive: async (paneId: string) => alivePanes.has(paneId),
  capturePaneContent: async () => '> idle prompt',
  executeTmux: async () => '',
}));

mock.module('./orchestrator/index.js', () => ({
  detectState: () => ({ type: 'idle', confidence: 0.9, timestamp: Date.now(), rawOutput: '' }),
}));

mock.module('./protocol-router-spawn.js', () => ({
  spawnWorkerFromTemplate: async (template: any, _resumeSessionId?: string) => {
    spawnCallCount++;
    // Simulate spawn latency to widen the race window
    await new Promise((r) => setTimeout(r, 50));
    const id = `spawned-${template.role ?? 'worker'}-${spawnCallCount}`;
    const paneId = `%${900 + spawnCallCount}`;
    const now = new Date().toISOString();
    const workerEntry = {
      id,
      paneId,
      session: 'test-session',
      provider: template.provider ?? 'claude',
      transport: 'tmux' as const,
      role: template.role,
      team: template.team,
      state: 'spawning' as const,
      startedAt: now,
      lastStateChange: now,
      repoPath: template.cwd ?? '/tmp',
      worktree: null,
      nativeTeamEnabled: false,
    };
    // Register in real PG registry so the double-check after lock can find it
    const reg = await import('./agent-registry.js');
    await reg.register(workerEntry);
    // Mark pane as alive so isPaneAlive returns true for this worker
    alivePanes.add(paneId);
    return { worker: workerEntry, paneId, workerId: id };
  },
  injectResumeContext: async () => {},
}));

// ---------------------------------------------------------------------------
// PG test schema (required since mailbox now uses PG)
// ---------------------------------------------------------------------------

describe.skipIf(!DB_AVAILABLE)('pg', () => {
  let cleanupSchema: () => Promise<void>;

  beforeAll(async () => {
    cleanupSchema = await setupTestSchema();
  });

  afterAll(async () => {
    await cleanupSchema();
  });

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
    process.env.TMUX = undefined as unknown as string;
    process.env.TMUX_PANE = undefined as unknown as string;

    // Reset mock state
    spawnCallCount = 0;
    alivePanes.clear();
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
      const repo = '/tmp/proto-router-metadata';
      const { getInbox } = await import('./protocol-router.js');

      await mailbox.send(repo, 'sender', 'receiver', 'test message');

      const messages = await getInbox(repo, 'receiver');
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

    test('suppresses self-delivery when from === to (#818)', async () => {
      const { sendMessage } = await import('./protocol-router.js');

      const result = await sendMessage(tempDir, 'team-lead', 'team-lead', 'hello self');
      expect(result.delivered).toBe(true);
      expect(result.reason).toBe('Self-delivery suppressed');
      expect(result.messageId).toBe('');

      // Verify no message was persisted in mailbox
      const { getInbox } = await import('./protocol-router.js');
      const inbox = await getInbox(tempDir, 'team-lead');
      expect(inbox).toEqual([]);
    });

    test('allows delivery when from !== to', async () => {
      const { sendMessage } = await import('./protocol-router.js');

      // Without tmux, this will fall through to "not found", but it should NOT
      // be suppressed as a self-delivery
      const result = await sendMessage(tempDir, 'alice', 'bob', 'hello bob');
      expect(result.reason).not.toBe('Self-delivery suppressed');
    });
  });

  // ---------------------------------------------------------------------------
  // Concurrent spawn dedup — advisory lock prevents duplicate workers
  // ---------------------------------------------------------------------------

  describe('concurrent spawn dedup', () => {
    test('two concurrent messages to dead worker produce exactly one spawn', async () => {
      const registry = await import('./agent-registry.js');

      // Enable tmux path so auto-spawn is attempted
      process.env.TMUX = '/tmp/tmux-test/default,123,0';

      const now = new Date().toISOString();

      // Register a dead worker (pane not in alivePanes → isPaneAlive returns false)
      await registry.register({
        id: 'dead-engineer',
        paneId: '%0',
        session: 'test-session',
        provider: 'claude',
        transport: 'tmux',
        role: 'engineer',
        team: 'test-team',
        state: 'idle',
        startedAt: now,
        lastStateChange: now,
        repoPath: tempDir,
        worktree: null,
      });

      // Register a template so auto-spawn can find it
      await registry.saveTemplate({
        id: 'test-team-engineer',
        team: 'test-team',
        role: 'engineer',
        provider: 'claude',
        cwd: tempDir,
        lastSpawnedAt: now,
      });

      const { sendMessage } = await import('./protocol-router.js');

      // Fire two concurrent messages to the same dead worker
      const [r1, r2] = await Promise.all([
        sendMessage(tempDir, 'alice', 'engineer', 'message 1', 'test-team'),
        sendMessage(tempDir, 'alice', 'engineer', 'message 2', 'test-team'),
      ]);

      // Exactly one spawn should have occurred — the advisory lock prevents the race
      expect(spawnCallCount).toBe(1);

      // Both messages should report successful delivery (one to respawned, one to existing)
      const delivered = [r1.delivered, r2.delivered];
      expect(delivered).toContain(true);
    });
  });
});
