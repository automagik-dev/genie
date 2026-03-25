/**
 * NATS Integration Tests — Level 2
 *
 * Tests real NATS pub/sub, followAgentLog streaming, dedup, filtering,
 * and mailbox NATS publishing. Skipped when NATS is not running.
 *
 * Run with: bun test src/lib/nats-integration.test.ts
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent } from './agent-registry.js';
import { send } from './mailbox.js';
import { _resetForTesting, close, isAvailable, publish, subscribe } from './nats-client.js';
import { setupTestSchema } from './test-db.js';
import { type LogEvent, followAgentLog } from './unified-log.js';

// ============================================================================
// NATS availability check — skip entire suite if NATS is down
// ============================================================================

const NATS_AVAILABLE = await isAvailable();
await close();
_resetForTesting();

// ============================================================================
// PG test schema (required for mailbox.send() which uses PG)
// ============================================================================

let cleanupSchema: () => Promise<void>;

beforeAll(async () => {
  cleanupSchema = await setupTestSchema();
});

afterAll(async () => {
  await cleanupSchema();
});

// ============================================================================
// Helpers
// ============================================================================

let tempDir: string;

function makeAgent(id: string, team?: string): Agent {
  return {
    id,
    paneId: '%0',
    session: 'test',
    worktree: null,
    startedAt: new Date().toISOString(),
    state: 'working',
    lastStateChange: new Date().toISOString(),
    repoPath: tempDir,
    team,
  };
}

/** Wait for a condition with timeout. */
function waitFor(fn: () => boolean, ms = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (fn()) return resolve();
      if (Date.now() - start > ms) return reject(new Error(`waitFor timed out after ${ms}ms`));
      setTimeout(check, 20);
    };
    check();
  });
}

// ============================================================================
// Tests
// ============================================================================

describe.skipIf(!NATS_AVAILABLE)('NATS integration', () => {
  beforeEach(async () => {
    _resetForTesting();
    tempDir = await mkdtemp(join(tmpdir(), 'nats-integ-'));
  });

  afterEach(async () => {
    await close();
    _resetForTesting();
    await rm(tempDir, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // 1. Basic pub/sub
  // --------------------------------------------------------------------------

  test('publish → subscribe delivers message', async () => {
    const received: Array<{ subject: string; data: unknown }> = [];

    const sub = await subscribe('genie.tool.test.call', (subject, data) => {
      received.push({ subject, data });
    });

    // Small delay for subscription to be ready
    await new Promise((r) => setTimeout(r, 50));

    await publish('genie.tool.test.call', { kind: 'tool_call', text: 'Read foo.ts' });

    await waitFor(() => received.length >= 1);

    expect(received.length).toBe(1);
    expect(received[0].subject).toBe('genie.tool.test.call');
    expect((received[0].data as Record<string, unknown>).kind).toBe('tool_call');
    expect((received[0].data as Record<string, unknown>).text).toBe('Read foo.ts');

    sub.unsubscribe();
  }, 5000);

  // --------------------------------------------------------------------------
  // 2. followAgentLog receives events published via NATS
  // --------------------------------------------------------------------------

  test('followAgentLog receives NATS events in real-time', async () => {
    const agent = makeAgent('test-eng', 'test-team');
    const received: LogEvent[] = [];

    const handle = await followAgentLog(agent, tempDir, undefined, (event) => {
      received.push(event);
    });

    expect(handle.mode).toBe('nats');

    // Small delay for subscription to be ready
    await new Promise((r) => setTimeout(r, 50));

    // Simulate a hook emitting a tool_call event
    const toolEvent: LogEvent = {
      timestamp: new Date().toISOString(),
      kind: 'tool_call',
      agent: 'test-eng',
      team: 'test-team',
      text: 'Read src/index.ts',
      data: { toolCall: { name: 'Read', input: { file_path: '/src/index.ts' } } },
      source: 'hook',
    };

    await publish('genie.tool.test-eng.call', toolEvent);

    await waitFor(() => received.length >= 1);

    expect(received.length).toBe(1);
    expect(received[0].kind).toBe('tool_call');
    expect(received[0].agent).toBe('test-eng');
    expect(received[0].text).toBe('Read src/index.ts');
    expect(received[0].source).toBe('hook');

    await handle.stop();
  }, 5000);

  // --------------------------------------------------------------------------
  // 3. Dedup — same event published twice, callback receives only once
  // --------------------------------------------------------------------------

  test('dedup: duplicate event only delivered once', async () => {
    const agent = makeAgent('dedup-eng', 'dedup-team');
    const received: LogEvent[] = [];

    const handle = await followAgentLog(agent, tempDir, undefined, (event) => {
      received.push(event);
    });

    await new Promise((r) => setTimeout(r, 50));

    const event: LogEvent = {
      timestamp: '2026-03-22T10:00:00.000Z',
      kind: 'tool_call',
      agent: 'dedup-eng',
      team: 'dedup-team',
      text: 'Edit config.ts',
      source: 'hook',
    };

    // Publish the exact same event twice
    await publish('genie.tool.dedup-eng.call', event);
    await publish('genie.tool.dedup-eng.call', event);

    // Wait for at least one, then a bit more to ensure no second arrives
    await waitFor(() => received.length >= 1);
    await new Promise((r) => setTimeout(r, 200));

    expect(received.length).toBe(1);
    expect(received[0].text).toBe('Edit config.ts');

    await handle.stop();
  }, 5000);

  // --------------------------------------------------------------------------
  // 4. Kind filter — only matching kinds pass through
  // --------------------------------------------------------------------------

  test('filter by kind: only message events pass when filtered', async () => {
    const agent = makeAgent('filter-eng', 'filter-team');
    const received: LogEvent[] = [];

    const handle = await followAgentLog(agent, tempDir, { kinds: ['message'] }, (event) => {
      received.push(event);
    });

    await new Promise((r) => setTimeout(r, 50));

    // Publish a tool_call (should be filtered out)
    await publish('genie.tool.filter-eng.call', {
      timestamp: new Date().toISOString(),
      kind: 'tool_call',
      agent: 'filter-eng',
      text: 'Bash ls',
      source: 'hook',
    });

    // Publish a message (should pass through)
    await publish('genie.msg.filter-eng', {
      timestamp: new Date().toISOString(),
      kind: 'message',
      agent: 'filter-eng',
      peer: 'reviewer',
      direction: 'in',
      text: 'LGTM',
      source: 'mailbox',
    });

    await waitFor(() => received.length >= 1);
    // Wait a bit more to ensure tool_call doesn't sneak through
    await new Promise((r) => setTimeout(r, 200));

    expect(received.length).toBe(1);
    expect(received[0].kind).toBe('message');
    expect(received[0].text).toBe('LGTM');

    await handle.stop();
  }, 5000);

  // --------------------------------------------------------------------------
  // 5. mailbox send() publishes to NATS
  // --------------------------------------------------------------------------

  test('mailbox send() publishes message to NATS subject genie.msg.{to}', async () => {
    const received: Array<{ subject: string; data: unknown }> = [];

    const sub = await subscribe('genie.msg.target-agent', (subject, data) => {
      received.push({ subject, data });
    });

    await new Promise((r) => setTimeout(r, 50));

    // Send a mailbox message — should also publish to NATS
    await send(tempDir, 'sender-agent', 'target-agent', 'please review PR #42');

    await waitFor(() => received.length >= 1);

    expect(received.length).toBe(1);
    expect(received[0].subject).toBe('genie.msg.target-agent');

    const data = received[0].data as Record<string, unknown>;
    expect(data.kind).toBe('message');
    expect(data.agent).toBe('sender-agent');
    expect(data.peer).toBe('target-agent');
    expect(data.text).toBe('please review PR #42');
    expect(data.source).toBe('mailbox');

    sub.unsubscribe();
  }, 5000);
});
