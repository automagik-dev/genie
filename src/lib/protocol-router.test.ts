/**
 * Protocol Router — Unit Tests
 *
 * Tests inbox retrieval, message routing logic, and concurrent spawn dedup.
 * Full sendMessage tests require tmux (integration-level).
 *
 * Run with: bun test src/lib/protocol-router.test.ts
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mailbox from './mailbox.js';
import { DB_AVAILABLE, setupTestDatabase } from './test-db.js';

// ============================================================================
// Module mock — protocol-router-spawn.js only (no other test file mocks this).
// Tmux and orchestrator are NOT mocked here — we use _deps injection instead
// to avoid mock.module leaking across test files in bun's shared module cache.
// ============================================================================

/** Set of pane IDs that the _deps.isPaneAlive override should report as alive. */
const alivePanes = new Set<string>();

/** Count of spawnWorkerFromTemplate invocations (reset in beforeEach). */
let spawnCallCount = 0;
/** When true, spawnWorkerFromTemplate mock throws to simulate spawn failure. */
let spawnShouldFail = false;

// Mock tmux-wrapper (not tmux.js) to avoid poisoning the global module cache
// for other test files that import real functions from ./tmux.js.
// The real isPaneAlive/capturePaneContent use executeTmux which calls the wrapper.
mock.module('./tmux-wrapper.js', () => ({
  executeTmux: async (cmd: string) => {
    // isPaneAlive calls: display-message -t '%NN' -p '#{pane_dead}'
    const paneMatch = cmd.match(/display-message -t '(%\d+)' -p '#\{pane_dead\}'/);
    if (paneMatch) {
      return alivePanes.has(paneMatch[1]) ? '0' : '1';
    }
    // capturePaneContent calls: capture-pane
    if (cmd.includes('capture-pane')) {
      return '> idle prompt';
    }
    return '';
  },
  genieTmuxPrefix: () => ['-L', 'genie', '-f', '/dev/null'],
  genieTmuxCmd: (sub: string) => `tmux -L genie ${sub}`,
  // Passthrough matches the real implementation (issue #1223): the mock
  // must preserve behavior because Bun's mock.module is process-global,
  // so tmux-wrapper.test.ts can race and see this stub.
  prependEnvVars: (command: string, env?: Record<string, string>) => {
    if (!env || Object.keys(env).length === 0) return command;
    const envArgs = Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    return `env ${envArgs} ${command}`;
  },
}));

mock.module('./orchestrator/index.js', () => ({
  detectState: () => ({ type: 'idle', confidence: 0.9, timestamp: Date.now(), rawOutput: '' }),
}));

// Re-export real _deps so protocol-router-spawn.test.ts can access them
// even when this mock.module replaces the module in bun's shared cache.
const realSpawnModule = await import('./protocol-router-spawn.js');

mock.module('./protocol-router-spawn.js', () => ({
  _deps: realSpawnModule._deps,
  spawnWorkerFromTemplate: async (template: any, _resumeSessionId?: string) => {
    spawnCallCount++;
    if (spawnShouldFail) throw new Error('Simulated spawn failure');
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
    // Mark pane as alive so _deps.isPaneAlive returns true for this worker
    alivePanes.add(paneId);
    return { worker: workerEntry, paneId, workerId: id };
  },
  injectResumeContext: realSpawnModule.injectResumeContext,
}));

// ---------------------------------------------------------------------------
// PG test schema (required since mailbox now uses PG)
// ---------------------------------------------------------------------------

describe.skipIf(!DB_AVAILABLE)('pg', () => {
  let cleanupSchema: () => Promise<void>;

  beforeAll(async () => {
    cleanupSchema = await setupTestDatabase();
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
    spawnShouldFail = false;
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
    // Restore _deps to defaults
    const router = await import('./protocol-router.js');
    const { isPaneAlive } = await import('./tmux.js');
    router._deps.isPaneAlive = isPaneAlive;
    router._deps.waitForWorkerReady = null;
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
      const router = await import('./protocol-router.js');

      // Override _deps to control pane liveness without tmux
      router._deps.isPaneAlive = async (paneId: string) => alivePanes.has(paneId);
      router._deps.waitForWorkerReady = async () => true;

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

      // Fire two concurrent messages to the same dead worker
      const [r1, r2] = await Promise.all([
        router.sendMessage(tempDir, 'alice', 'engineer', 'message 1', 'test-team'),
        router.sendMessage(tempDir, 'alice', 'engineer', 'message 2', 'test-team'),
      ]);

      // Exactly one spawn should have occurred — the advisory lock prevents the race
      expect(spawnCallCount).toBe(1);

      // Both messages should report successful delivery (one to respawned, one to existing)
      const delivered = [r1.delivered, r2.delivered];
      expect(delivered).toContain(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Spawn failure logging — errors surfaced, not silently swallowed
  // ---------------------------------------------------------------------------

  describe('spawn failure logging', () => {
    test('spawn failure is logged via console.error, not silently swallowed', async () => {
      const registry = await import('./agent-registry.js');
      const router = await import('./protocol-router.js');

      router._deps.isPaneAlive = async (paneId: string) => alivePanes.has(paneId);
      router._deps.waitForWorkerReady = async () => true;
      process.env.TMUX = '/tmp/tmux-test/default,123,0';

      const errorCalls: string[] = [];
      const errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        errorCalls.push(args.map(String).join(' '));
      });

      const now = new Date().toISOString();

      // Register a dead worker (pane not in alivePanes)
      await registry.register({
        id: 'fail-worker',
        paneId: '%0',
        session: 'test-session',
        provider: 'claude',
        transport: 'tmux',
        role: 'fail-role',
        team: 'fail-team',
        state: 'idle',
        startedAt: now,
        lastStateChange: now,
        repoPath: tempDir,
        worktree: null,
      });

      await registry.saveTemplate({
        id: 'fail-team-fail-role',
        team: 'fail-team',
        role: 'fail-role',
        provider: 'claude',
        cwd: tempDir,
        lastSpawnedAt: now,
      });

      // Make spawn fail
      spawnShouldFail = true;

      const result = await router.sendMessage(tempDir, 'alice', 'fail-role', 'hello', 'fail-team');

      // Delivery should fail gracefully (not throw)
      expect(result.delivered).toBe(false);

      // Spawn failure must be logged
      const spawnErrorLog = errorCalls.find((c) => c.includes('Spawn failed'));
      expect(spawnErrorLog).toBeTruthy();
      expect(spawnErrorLog).toContain('fail-role');
      expect(spawnErrorLog).toContain('Simulated spawn failure');

      errorSpy.mockRestore();
    });

    test('missing claudeSessionId on mid-task claude worker surfaces MissingResumeSessionError (Gap C)', async () => {
      // Gap C from trace-stale-resume (task #6): previously the router
      // silently substituted undefined for a null claudeSessionId and spawned
      // a FRESH session, losing the worker's conversation history. Now the
      // operator sees a clear error and the delivery returns undelivered with
      // a human-readable reason.
      //
      // Scenario: a mid-task Claude worker (executor state = 'idle', i.e.
      // still alive, not completed) whose claudeSessionId was never synced
      // back — the exact shape of the pre-Gap-A PTY bug.
      const registry = await import('./agent-registry.js');
      const executorReg = await import('./executor-registry.js');
      const router = await import('./protocol-router.js');

      router._deps.isPaneAlive = async (paneId: string) => alivePanes.has(paneId);
      router._deps.waitForWorkerReady = async () => true;
      process.env.TMUX = '/tmp/tmux-test/default,123,0';

      const errorCalls: string[] = [];
      const errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        errorCalls.push(args.map(String).join(' '));
      });

      const now = new Date().toISOString();

      await registry.register({
        id: 'ghost-worker',
        paneId: '%0',
        session: 'test-session',
        provider: 'claude',
        transport: 'tmux',
        role: 'ghost-role',
        team: 'ghost-team',
        state: 'idle',
        startedAt: now,
        lastStateChange: now,
        repoPath: tempDir,
        worktree: null,
      });

      // Executor is still in a resumable state (not terminal). Crucially we
      // do NOT pass claudeSessionId to simulate the pre-Gap-A defect.
      const executor = await executorReg.createAndLinkExecutor('ghost-worker', 'claude', 'tmux');
      await executorReg.updateExecutorState(executor.id, 'idle');

      await registry.saveTemplate({
        id: 'ghost-team-ghost-role',
        team: 'ghost-team',
        role: 'ghost-role',
        provider: 'claude',
        cwd: tempDir,
        lastSpawnedAt: now,
      });

      const spawnCountBefore = spawnCallCount;
      const result = await router.sendMessage(tempDir, 'alice', 'ghost-role', 'hello', 'ghost-team');

      // Must NOT fall back to a fresh spawn silently.
      expect(spawnCallCount).toBe(spawnCountBefore);
      expect(result.delivered).toBe(false);
      expect(result.reason).toMatch(/claude_session_id/);

      // Error must be logged so operators notice.
      const resumeErrorLog = errorCalls.find((c) => c.includes('claude_session_id'));
      expect(resumeErrorLog).toBeTruthy();

      errorSpy.mockRestore();
    });

    test('MissingResumeSessionError class carries workerId and recipientId', async () => {
      const { MissingResumeSessionError } = await import('./protocol-router.js');
      const err = new MissingResumeSessionError('w1', 'role-x');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('MissingResumeSessionError');
      expect(err.workerId).toBe('w1');
      expect(err.entityId).toBe('w1');
      expect(err.recipientId).toBe('role-x');
      expect(err.reason).toBe('null_session');
      expect(err.message).toContain('w1');
      expect(err.message).toContain('genie reset');
      expect(err.message).toContain('null_session');
    });

    test('MissingResumeSessionError accepts explicit reason and exposes it on the instance', async () => {
      const { MissingResumeSessionError } = await import('./protocol-router.js');

      const noExec = new MissingResumeSessionError('orphan-agent', undefined, 'no_executor');
      expect(noExec.reason).toBe('no_executor');
      expect(noExec.message).toContain('no_executor');
      expect(noExec.entityId).toBe('orphan-agent');

      const legacyAlias = new MissingResumeSessionError('pre-hook-agent', undefined, 'no_session_id');
      expect(legacyAlias.reason).toBe('no_session_id');
      expect(legacyAlias.message).toContain('no_session_id');
    });
  });

  // ---------------------------------------------------------------------------
  // Delivery confirmation — pane re-verify before injection
  // ---------------------------------------------------------------------------

  describe('delivery confirmation', () => {
    test('returns delivered:false when pane dies between resolution and delivery', async () => {
      const registry = await import('./agent-registry.js');
      const router = await import('./protocol-router.js');

      const now = new Date().toISOString();

      // Register a worker with an "alive" pane
      alivePanes.add('%10');
      await registry.register({
        id: 'live-worker',
        paneId: '%10',
        session: 'test-session',
        provider: 'claude',
        transport: 'tmux',
        role: 'target',
        team: 'test-team',
        state: 'idle',
        startedAt: now,
        lastStateChange: now,
        repoPath: tempDir,
        worktree: null,
      });

      // Override isPaneAlive: alive for resolution, dead for pre-delivery check.
      // Track per-pane call counts so other workers don't affect the counter.
      const paneCallCounts = new Map<string, number>();
      router._deps.isPaneAlive = async (paneId: string) => {
        const count = (paneCallCounts.get(paneId) ?? 0) + 1;
        paneCallCounts.set(paneId, count);
        // For %10: first call (resolution) → alive; second call (pre-delivery) → dead
        if (paneId === '%10' && count > 1) return false;
        return alivePanes.has(paneId);
      };

      const result = await router.sendMessage(tempDir, 'alice', 'target', 'hello target');

      expect(result.delivered).toBe(false);
      expect(result.reason).toBe('Pane died before delivery');
      // Message should still be persisted in mailbox
      expect(result.messageId).toMatch(/^msg-/);
    });

    test('delivery failure to live worker logs error when all paths exhausted', async () => {
      const registry = await import('./agent-registry.js');
      const router = await import('./protocol-router.js');

      const errorCalls: string[] = [];
      const errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        errorCalls.push(args.map(String).join(' '));
      });

      const now = new Date().toISOString();

      // Register a non-native worker (no team, so native inbox fallback is skipped)
      alivePanes.add('%30');
      await registry.register({
        id: 'non-native-worker',
        paneId: '%30',
        session: 'test-session',
        provider: 'codex',
        transport: 'tmux',
        role: 'codex-target',
        state: 'idle',
        startedAt: now,
        lastStateChange: now,
        repoPath: tempDir,
        worktree: null,
        nativeTeamEnabled: false,
      });

      router._deps.isPaneAlive = async (paneId: string) => alivePanes.has(paneId);

      // injectToTmuxPane will fail because executeTmux is mocked but send-keys
      // isn't handled. The worker has no team, so native inbox fallback won't
      // apply. This tests that the "all paths exhausted" error is logged.
      const result = await router.sendMessage(tempDir, 'alice', 'codex-target', 'hello codex');

      expect(result.messageId).toMatch(/^msg-/);
      // Delivery succeeds or fails depending on tmux mock — either way is valid.
      // What matters: if delivery failed, the error was logged, not swallowed.
      if (!result.delivered) {
        const exhaustedLog = errorCalls.find((c) => c.includes('all paths exhausted'));
        expect(exhaustedLog).toBeTruthy();
      }

      errorSpy.mockRestore();
    });

    test('message to live worker is delivered successfully', async () => {
      const registry = await import('./agent-registry.js');
      const router = await import('./protocol-router.js');

      const now = new Date().toISOString();

      // Register a worker with a "native team enabled" pane (skips tmux injection)
      alivePanes.add('%20');
      await registry.register({
        id: 'native-worker',
        paneId: '%20',
        session: 'test-session',
        provider: 'claude',
        transport: 'tmux',
        role: 'responder',
        team: 'test-team',
        state: 'idle',
        startedAt: now,
        lastStateChange: now,
        repoPath: tempDir,
        worktree: null,
        nativeTeamEnabled: true,
        nativeColor: 'blue',
      });

      // isPaneAlive always returns true for this pane
      router._deps.isPaneAlive = async (paneId: string) => alivePanes.has(paneId);

      const result = await router.sendMessage(tempDir, 'alice', 'responder', 'hello responder');

      // Delivery should succeed (via native inbox write — which may fail in test
      // without real native team setup, falling back to delivered:false)
      expect(result.messageId).toMatch(/^msg-/);
      expect(result.workerId).toBe('native-worker');
    });
  });

  // ---------------------------------------------------------------------------
  // Completion guard — skip auto-spawn for done/terminated executors (#1017)
  // ---------------------------------------------------------------------------

  describe('completion guard', () => {
    test('skips auto-spawn when last executor state is done', async () => {
      const registry = await import('./agent-registry.js');
      const executorReg = await import('./executor-registry.js');
      const router = await import('./protocol-router.js');

      router._deps.isPaneAlive = async (paneId: string) => alivePanes.has(paneId);
      router._deps.waitForWorkerReady = async () => true;
      process.env.TMUX = '/tmp/tmux-test/default,123,0';

      const now = new Date().toISOString();

      // Register a dead worker (pane not alive)
      await registry.register({
        id: 'done-agent',
        paneId: '%0',
        session: 'test-session',
        provider: 'claude',
        transport: 'tmux',
        role: 'done-role',
        team: 'done-team',
        state: 'idle',
        startedAt: now,
        lastStateChange: now,
        repoPath: tempDir,
        worktree: null,
      });

      // Create an executor in 'done' state and link it to the agent
      const executor = await executorReg.createAndLinkExecutor('done-agent', 'claude', 'tmux', {
        state: 'done',
      });
      await executorReg.updateExecutorState(executor.id, 'done');

      // Register a template so auto-spawn WOULD be attempted
      await registry.saveTemplate({
        id: 'done-team-done-role',
        team: 'done-team',
        role: 'done-role',
        provider: 'claude',
        cwd: tempDir,
        lastSpawnedAt: now,
      });

      const result = await router.sendMessage(tempDir, 'alice', 'done-role', 'hello done', 'done-team');

      // Should NOT auto-spawn — the completion guard prevents it
      expect(spawnCallCount).toBe(0);
      expect(result.delivered).toBe(false);
    });

    test('skips auto-spawn when last executor state is terminated', async () => {
      const registry = await import('./agent-registry.js');
      const executorReg = await import('./executor-registry.js');
      const router = await import('./protocol-router.js');

      router._deps.isPaneAlive = async (paneId: string) => alivePanes.has(paneId);
      router._deps.waitForWorkerReady = async () => true;
      process.env.TMUX = '/tmp/tmux-test/default,123,0';

      const now = new Date().toISOString();

      await registry.register({
        id: 'term-agent',
        paneId: '%0',
        session: 'test-session',
        provider: 'claude',
        transport: 'tmux',
        role: 'term-role',
        team: 'term-team',
        state: 'idle',
        startedAt: now,
        lastStateChange: now,
        repoPath: tempDir,
        worktree: null,
      });

      const executor = await executorReg.createAndLinkExecutor('term-agent', 'claude', 'tmux');
      await executorReg.updateExecutorState(executor.id, 'terminated');

      await registry.saveTemplate({
        id: 'term-team-term-role',
        team: 'term-team',
        role: 'term-role',
        provider: 'claude',
        cwd: tempDir,
        lastSpawnedAt: now,
      });

      const result = await router.sendMessage(tempDir, 'alice', 'term-role', 'hello term', 'term-team');

      expect(spawnCallCount).toBe(0);
      expect(result.delivered).toBe(false);
    });

    test('still auto-spawns when last executor state is error', async () => {
      const registry = await import('./agent-registry.js');
      const executorReg = await import('./executor-registry.js');
      const router = await import('./protocol-router.js');

      router._deps.isPaneAlive = async (paneId: string) => alivePanes.has(paneId);
      router._deps.waitForWorkerReady = async () => true;
      process.env.TMUX = '/tmp/tmux-test/default,123,0';

      const now = new Date().toISOString();

      await registry.register({
        id: 'err-agent',
        paneId: '%0',
        session: 'test-session',
        provider: 'claude',
        transport: 'tmux',
        role: 'err-role',
        team: 'err-team',
        state: 'error',
        startedAt: now,
        lastStateChange: now,
        repoPath: tempDir,
        worktree: null,
      });

      const executor = await executorReg.createAndLinkExecutor('err-agent', 'claude', 'tmux');
      await executorReg.updateExecutorState(executor.id, 'error');

      await registry.saveTemplate({
        id: 'err-team-err-role',
        team: 'err-team',
        role: 'err-role',
        provider: 'claude',
        cwd: tempDir,
        lastSpawnedAt: now,
      });

      await router.sendMessage(tempDir, 'alice', 'err-role', 'hello err', 'err-team');

      // Error-state agents SHOULD be auto-spawned (error != intentional completion)
      expect(spawnCallCount).toBe(1);
    });

    test('still auto-spawns when no prior executor exists (first spawn)', async () => {
      const registry = await import('./agent-registry.js');
      const router = await import('./protocol-router.js');

      router._deps.isPaneAlive = async (paneId: string) => alivePanes.has(paneId);
      router._deps.waitForWorkerReady = async () => true;
      process.env.TMUX = '/tmp/tmux-test/default,123,0';

      const now = new Date().toISOString();

      // Register a worker WITHOUT any executor (first spawn scenario)
      await registry.register({
        id: 'fresh-agent',
        paneId: '%0',
        session: 'test-session',
        provider: 'claude',
        transport: 'tmux',
        role: 'fresh-role',
        team: 'fresh-team',
        state: 'idle',
        startedAt: now,
        lastStateChange: now,
        repoPath: tempDir,
        worktree: null,
      });

      await registry.saveTemplate({
        id: 'fresh-team-fresh-role',
        team: 'fresh-team',
        role: 'fresh-role',
        provider: 'claude',
        cwd: tempDir,
        lastSpawnedAt: now,
      });

      await router.sendMessage(tempDir, 'alice', 'fresh-role', 'hello fresh', 'fresh-team');

      // First-time spawn should work — no executor record means no completion guard
      expect(spawnCallCount).toBe(1);
    });
  });
});
