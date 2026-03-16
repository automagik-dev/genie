/**
 * Stress Tests — Scale, Performance, Resource Exhaustion
 *
 * QA Plan tests: S-01 (500 agents), S-04 (100 concurrent chat), S-05 (50-group wish)
 *
 * Run with: bun test src/__tests__/stress/scale.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as directory from '../../lib/agent-directory.js';
import * as teamChat from '../../lib/team-chat.js';
import * as wishState from '../../lib/wish-state.js';

// ============================================================================
// S-01: Register 500 agents sequentially
// ============================================================================

describe('S-01: 500 agents sequential registration', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'genie-stress-dir-'));
    process.env.GENIE_HOME = testDir;
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    process.env.GENIE_HOME = undefined;
  });

  test('registers 500 agents sequentially and retrieves all', async () => {
    // Create a shared agent dir with AGENTS.md
    const agentDir = join(testDir, 'stress-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'AGENTS.md'), '# Stress Agent');

    const start = Date.now();

    for (let i = 0; i < 500; i++) {
      await directory.add({
        name: `stress-agent-${i}`,
        dir: agentDir,
        promptMode: 'append',
      });
    }

    const registerTime = Date.now() - start;

    // Verify all 500 persisted
    const parseStart = Date.now();
    const entries = await directory.ls();
    const parseTime = Date.now() - parseStart;

    expect(entries.length).toBe(500);
    expect(parseTime).toBeLessThan(1000); // Parse time < 1s

    console.log(`[S-01] 500 agents: register=${registerTime}ms, parse=${parseTime}ms`);
  }, 30000); // 30s timeout for this test
});

// ============================================================================
// S-04: 100 concurrent chat messages
// ============================================================================

describe('S-04: 100 concurrent chat messages', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'genie-stress-chat-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('100 concurrent postMessage — all present, no corruption', async () => {
    const start = Date.now();

    const results = await Promise.allSettled(
      Array.from({ length: 100 }, (_, i) =>
        teamChat.postMessage(tempDir, 'stress-channel', `agent-${i}`, `stress message ${i}`),
      ),
    );

    const writeTime = Date.now() - start;
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(100);

    // Read all messages back
    const readStart = Date.now();
    const messages = await teamChat.readMessages(tempDir, 'stress-channel');
    const readTime = Date.now() - readStart;

    expect(messages.length).toBe(100);

    // Verify no corruption — all messages valid
    for (const msg of messages) {
      expect(msg.id).toMatch(/^chat-/);
      expect(msg.sender).toBeTruthy();
      expect(msg.body).toBeTruthy();
    }

    expect(readTime).toBeLessThan(500); // Read < 500ms

    console.log(`[S-04] 100 concurrent chat: write=${writeTime}ms, read=${readTime}ms`);
  }, 15000); // 15s timeout
});

// ============================================================================
// S-05: Wish with 50 groups, deep chain
// ============================================================================

describe('S-05: 50-group wish deep chain lifecycle', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'genie-stress-wish-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  test('50-group serial chain: full lifecycle completes', async () => {
    // Build a 50-deep serial chain: 1 -> 2 -> 3 -> ... -> 50
    const groups: wishState.GroupDefinition[] = [];
    for (let i = 1; i <= 50; i++) {
      groups.push({ name: String(i), dependsOn: i === 1 ? [] : [String(i - 1)] });
    }

    const createStart = Date.now();
    await wishState.createState('stress-wish', groups, cwd);
    const createTime = Date.now() - createStart;

    // Walk through all 50 groups
    const lifecycleStart = Date.now();
    for (let i = 1; i <= 50; i++) {
      const g = await wishState.startGroup('stress-wish', String(i), `agent-${i}`, cwd);
      expect(g.status).toBe('in_progress');
      await wishState.completeGroup('stress-wish', String(i), cwd);
    }
    const lifecycleTime = Date.now() - lifecycleStart;

    // Verify all done
    const state = await wishState.getState('stress-wish', cwd);
    expect(state).not.toBeNull();
    for (const group of Object.values(state!.groups)) {
      expect(group.status).toBe('done');
    }

    // recalculateDependents should be performant
    expect(lifecycleTime).toBeLessThan(10000); // < 10s for 50 groups

    console.log(`[S-05] 50-group wish: create=${createTime}ms, lifecycle=${lifecycleTime}ms`);
  }, 30000); // 30s timeout

  test('50-group wide fan: all dependents unblock correctly', async () => {
    // Build: A -> B1..B50 (fan-out)
    const groups: wishState.GroupDefinition[] = [{ name: 'root', dependsOn: [] }];
    for (let i = 1; i <= 50; i++) {
      groups.push({ name: `leaf-${i}`, dependsOn: ['root'] });
    }

    await wishState.createState('fan-wish', groups, cwd);

    // Complete root -> all 50 leaves should be ready
    await wishState.startGroup('fan-wish', 'root', 'agent', cwd);
    await wishState.completeGroup('fan-wish', 'root', cwd);

    const state = await wishState.getState('fan-wish', cwd);
    for (let i = 1; i <= 50; i++) {
      expect(state?.groups[`leaf-${i}`].status).toBe('ready');
    }
  }, 15000);
});
