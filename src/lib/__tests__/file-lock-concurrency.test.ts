/**
 * File Lock Concurrency Tests — QA Plan P0 Tests (C-FL-*)
 *
 * Tests concurrent access patterns across agent-directory, agent-registry,
 * and wish-state modules. All three use the same file-lock pattern.
 *
 * Run with: bun test src/lib/__tests__/file-lock-concurrency.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as directory from '../agent-directory.js';
import * as registry from '../agent-registry.js';
import type { Agent } from '../agent-registry.js';
import * as wishState from '../wish-state.js';

// ============================================================================
// Setup
// ============================================================================

let testDir: string;
let agentDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'genie-lock-test-'));
  process.env.GENIE_HOME = testDir;

  // Create a fake agent dir with AGENTS.md for directory tests
  agentDir = join(testDir, 'test-agent-home');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'AGENTS.md'), '# Test Agent\nYou are a test agent.');
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  process.env.GENIE_HOME = undefined;
});

// ============================================================================
// Helpers
// ============================================================================

function makeAgent(id: string): Agent {
  return {
    id,
    paneId: `%${id}`,
    session: 'test-session',
    worktree: null,
    startedAt: new Date().toISOString(),
    state: 'idle',
    lastStateChange: new Date().toISOString(),
    repoPath: testDir,
  };
}

// ============================================================================
// C-FL-01: 10 concurrent add() to agent-directory
// ============================================================================

describe('concurrent agent-directory operations', () => {
  test('C-FL-01: 10 concurrent add() — all 10 registered, no data loss', async () => {
    // Create 10 separate agent dirs with AGENTS.md
    const dirs: string[] = [];
    for (let i = 0; i < 10; i++) {
      const dir = join(testDir, `agent-${i}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'AGENTS.md'), `# Agent ${i}`);
      dirs.push(dir);
    }

    const results = await Promise.allSettled(
      dirs.map((dir, i) =>
        directory.add({
          name: `concurrent-agent-${i}`,
          dir,
          promptMode: 'append',
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(10);

    // Verify all 10 are persisted
    const entries = await directory.ls();
    expect(entries.length).toBe(10);
  });

  // C-FL-04: Concurrent add() and rm() on same entry
  test('C-FL-04: concurrent add() and rm() — final state is consistent', async () => {
    // First add the entry
    await directory.add({ name: 'contended', dir: agentDir, promptMode: 'append' });

    // Now race: rm it while trying to add a different one
    const results = await Promise.allSettled([
      directory.rm('contended'),
      directory.add({ name: 'safe-new', dir: agentDir, promptMode: 'append' }),
    ]);

    // Both should succeed (operating on different keys)
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(2);

    // contended should be removed
    const contended = await directory.get('contended');
    expect(contended).toBeNull();

    // safe-new should exist
    const safeNew = await directory.get('safe-new');
    expect(safeNew).not.toBeNull();
  });
});

// ============================================================================
// C-FL-02: 10 concurrent register() to agent-registry
// ============================================================================

describe('concurrent agent-registry operations', () => {
  test('C-FL-02: 10 concurrent register() — all 10 in final JSON', async () => {
    const agents = Array.from({ length: 10 }, (_, i) => makeAgent(`worker-${i}`));

    const results = await Promise.allSettled(agents.map((a) => registry.register(a)));

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(10);

    // Verify all 10 are in registry
    const all = await registry.list();
    expect(all.length).toBe(10);
    const ids = all.map((a) => a.id).sort();
    expect(ids).toEqual(agents.map((a) => a.id).sort());
  });
});

// ============================================================================
// C-FL-03: 5 concurrent startGroup() on same group
// ============================================================================

describe('concurrent wish-state operations', () => {
  test('C-FL-03: 5 concurrent startGroup() — exactly 1 succeeds, 4 throw', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'genie-ws-conc-'));
    try {
      await wishState.createState('conc-wish', [{ name: '1', dependsOn: [] }], cwd);

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, (_, i) => wishState.startGroup('conc-wish', '1', `agent-${i}`, cwd)),
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      // Exactly 1 should succeed (first to acquire lock)
      expect(fulfilled.length).toBe(1);
      // The other 4 should fail with "already in progress"
      expect(rejected.length).toBe(4);
      for (const r of rejected) {
        if (r.status === 'rejected') {
          expect(String(r.reason)).toContain('already in progress');
        }
      }

      // Verify final state has exactly one assignee
      const state = await wishState.getState('conc-wish', cwd);
      expect(state?.groups['1'].status).toBe('in_progress');
      expect(state?.groups['1'].assignee).toBeTruthy();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  // C-WS-01: Parallel completeGroup() for independent groups
  test('C-WS-01: parallel completeGroup() for independent groups both succeed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'genie-ws-par-'));
    try {
      await wishState.createState(
        'par-wish',
        [
          { name: '1', dependsOn: [] },
          { name: '2', dependsOn: [] },
          { name: '3', dependsOn: ['1', '2'] },
        ],
        cwd,
      );

      // Start both groups
      await wishState.startGroup('par-wish', '1', 'a', cwd);
      await wishState.startGroup('par-wish', '2', 'b', cwd);

      // Complete both in parallel
      const results = await Promise.allSettled([
        wishState.completeGroup('par-wish', '1', cwd),
        wishState.completeGroup('par-wish', '2', cwd),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled').length).toBe(2);

      // Group 3 should be ready (both deps done)
      const state = await wishState.getState('par-wish', cwd);
      expect(state?.groups['3'].status).toBe('ready');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// C-FL-05: Stale lock detection
// ============================================================================

describe('stale lock handling', () => {
  test('C-FL-05: stale lock (mtime > 10s) is cleaned and operation proceeds', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'genie-stale-'));
    try {
      // Create initial state
      await wishState.createState('stale-test', [{ name: '1', dependsOn: [] }], cwd);

      // Manually create a stale lock file with old mtime
      const statePath = join(cwd, '.genie', 'state', 'stale-test.json');
      const lockPath = `${statePath}.lock`;
      await writeFile(lockPath, 'stale-pid');

      // Set mtime to 15 seconds ago (> LOCK_STALE_MS of 10s)
      const past = new Date(Date.now() - 15000);
      await utimes(lockPath, past, past);

      // Operation should succeed after cleaning stale lock
      const result = await wishState.startGroup('stale-test', '1', 'agent', cwd);
      expect(result.status).toBe('in_progress');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  // C-FL-08: Orphaned lock file after crash
  test('C-FL-08: orphaned lock file after crash is cleaned via stale detection', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'genie-orphan-'));
    try {
      await wishState.createState(
        'orphan-test',
        [
          { name: '1', dependsOn: [] },
          { name: '2', dependsOn: ['1'] },
        ],
        cwd,
      );

      // Simulate crash: create orphaned lock with old timestamp
      const statePath = join(cwd, '.genie', 'state', 'orphan-test.json');
      const lockPath = `${statePath}.lock`;
      await writeFile(lockPath, '99999'); // fake PID

      // Set mtime to 20 seconds ago
      const past = new Date(Date.now() - 20000);
      await utimes(lockPath, past, past);

      // Should be able to proceed after stale lock cleanup
      const result = await wishState.startGroup('orphan-test', '1', 'agent', cwd);
      expect(result.status).toBe('in_progress');

      // And further operations should work too
      await wishState.completeGroup('orphan-test', '1', cwd);
      const state = await wishState.getState('orphan-test', cwd);
      expect(state?.groups['2'].status).toBe('ready');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// C-FL-07: Cross-module locks are independent
// ============================================================================

describe('cross-module lock independence', () => {
  test('C-FL-07: directory lock does not block registry lock', async () => {
    // Run directory add and registry register in parallel — they use different lock files
    const dir = join(testDir, 'cross-module');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'AGENTS.md'), '# Cross Module Agent');

    const results = await Promise.allSettled([
      directory.add({ name: 'dir-agent', dir, promptMode: 'append' }),
      registry.register(makeAgent('reg-agent')),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(2);

    // Both should be persisted
    const dirEntry = await directory.get('dir-agent');
    expect(dirEntry).not.toBeNull();

    const regEntry = await registry.get('reg-agent');
    expect(regEntry).not.toBeNull();
  });
});

// ============================================================================
// C-WS-03: Operations on different wishes don't block each other
// ============================================================================

describe('cross-wish independence', () => {
  test('C-WS-03: operations on different wishes use different lock files', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'genie-cross-wish-'));
    try {
      // Create two separate wishes
      await wishState.createState('wish-alpha', [{ name: '1', dependsOn: [] }], cwd);
      await wishState.createState('wish-beta', [{ name: '1', dependsOn: [] }], cwd);

      // Start groups on both wishes in parallel — they should not contend
      const results = await Promise.allSettled([
        wishState.startGroup('wish-alpha', '1', 'agent-a', cwd),
        wishState.startGroup('wish-beta', '1', 'agent-b', cwd),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled').length).toBe(2);

      // Both should be in_progress with correct assignees
      const stateA = await wishState.getState('wish-alpha', cwd);
      const stateB = await wishState.getState('wish-beta', cwd);
      expect(stateA?.groups['1'].status).toBe('in_progress');
      expect(stateA?.groups['1'].assignee).toBe('agent-a');
      expect(stateB?.groups['1'].status).toBe('in_progress');
      expect(stateB?.groups['1'].assignee).toBe('agent-b');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
