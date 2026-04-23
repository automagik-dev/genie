/**
 * Executor Read Endpoint tests — response shape, 404, method guard, DB lookup.
 *
 * These exercise the HTTP surface that omni scope-enforcer consumes (boundary
 * contract from `turn-session-contract` WISH.md). A shape regression here is a
 * cross-repo breaking change.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { findOrCreateAgent } from './agent-registry.js';
import { getConnection } from './db.js';
import {
  getExecutorReadPort,
  isExecutorReadEndpointRunning,
  readExecutorState,
  startExecutorReadEndpoint,
  stopExecutorReadEndpoint,
} from './executor-read.js';
import { createExecutor } from './executor-registry.js';
import { DB_AVAILABLE, setupTestDatabase } from './test-db.js';

describe.skipIf(!DB_AVAILABLE)('executor-read', () => {
  let cleanup: () => Promise<void>;
  let origPort: string | undefined;

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    const sql = await getConnection();
    await sql`DELETE FROM audit_events`;
    await sql`DELETE FROM assignments`;
    await sql`DELETE FROM executors`;
    await sql`DELETE FROM agents`;

    origPort = process.env.GENIE_EXECUTOR_READ_PORT;
    // High random port — avoids collisions with pgserve, OTel receiver, and parallel tests.
    process.env.GENIE_EXECUTOR_READ_PORT = String(50000 + Math.floor(Math.random() * 6000));
  });

  afterEach(async () => {
    await stopExecutorReadEndpoint();
    if (origPort !== undefined) process.env.GENIE_EXECUTOR_READ_PORT = origPort;
    else process.env.GENIE_EXECUTOR_READ_PORT = undefined;
  });

  async function seedExecutor(overrides: Partial<{ state: string; outcome: string; closeReason: string }> = {}) {
    const agent = await findOrCreateAgent('eng-read', 'test-team', 'engineer');
    const exec = await createExecutor(agent.id, 'claude', 'tmux', {
      state: (overrides.state as never) ?? 'working',
    });
    if (overrides.outcome) {
      const sql = await getConnection();
      await sql`
        UPDATE executors
        SET outcome = ${overrides.outcome},
            closed_at = now(),
            close_reason = ${overrides.closeReason ?? null},
            state = 'done',
            ended_at = now()
        WHERE id = ${exec.id}
      `;
    }
    return exec.id;
  }

  test('getExecutorReadPort respects GENIE_EXECUTOR_READ_PORT env', () => {
    process.env.GENIE_EXECUTOR_READ_PORT = '54321';
    expect(getExecutorReadPort()).toBe(54321);
  });

  test('startExecutorReadEndpoint is idempotent', async () => {
    expect(isExecutorReadEndpointRunning()).toBe(false);
    expect(await startExecutorReadEndpoint()).toBe(true);
    expect(isExecutorReadEndpointRunning()).toBe(true);
    expect(await startExecutorReadEndpoint()).toBe(true);
    expect(isExecutorReadEndpointRunning()).toBe(true);
  });

  test('readExecutorState returns null for unknown id', async () => {
    const reply = await readExecutorState('00000000-0000-0000-0000-000000000000');
    expect(reply).toBeNull();
  });

  test('readExecutorState returns state + outcome + closed_at for open turn', async () => {
    const id = await seedExecutor({ state: 'working' });
    const reply = await readExecutorState(id);
    expect(reply).not.toBeNull();
    expect(reply!.state).toBe('working');
    expect(reply!.outcome).toBeNull();
    expect(reply!.closed_at).toBeNull();
  });

  test('readExecutorState surfaces closed outcome after turn close', async () => {
    const id = await seedExecutor({ state: 'working', outcome: 'done' });
    const reply = await readExecutorState(id);
    expect(reply!.state).toBe('done');
    expect(reply!.outcome).toBe('done');
    expect(reply!.closed_at).not.toBeNull();
    // ISO-8601 string, not a Date instance — the contract says string.
    expect(typeof reply!.closed_at).toBe('string');
  });

  test('GET /executors/:id/state returns 200 + JSON body for known executor', async () => {
    const id = await seedExecutor({ state: 'working', outcome: 'done' });
    await startExecutorReadEndpoint();
    const port = getExecutorReadPort();

    const res = await fetch(`http://127.0.0.1:${port}/executors/${id}/state`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.state).toBe('done');
    expect(body.outcome).toBe('done');
    expect(typeof body.closed_at).toBe('string');
    // Boundary contract — only these three fields are promised to omni.
    expect(Object.keys(body).sort()).toEqual(['closed_at', 'outcome', 'state']);
  });

  test('GET /executors/:id/state returns 404 for unknown id', async () => {
    await startExecutorReadEndpoint();
    const port = getExecutorReadPort();
    const res = await fetch(`http://127.0.0.1:${port}/executors/00000000-0000-0000-0000-000000000000/state`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not found');
  });

  test('GET /executors/:id/state rejects non-UUID ids with 400', async () => {
    await startExecutorReadEndpoint();
    const port = getExecutorReadPort();
    const res = await fetch(`http://127.0.0.1:${port}/executors/not-a-uuid/state`);
    expect(res.status).toBe(400);
  });

  test('non-GET methods return 405', async () => {
    await startExecutorReadEndpoint();
    const port = getExecutorReadPort();
    const res = await fetch(`http://127.0.0.1:${port}/executors/00000000-0000-0000-0000-000000000000/state`, {
      method: 'POST',
    });
    expect(res.status).toBe(405);
  });

  test('unknown routes return 404', async () => {
    await startExecutorReadEndpoint();
    const port = getExecutorReadPort();
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
  });

  test('GET /health is reachable', async () => {
    await startExecutorReadEndpoint();
    const port = getExecutorReadPort();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; port: number };
    expect(body.status).toBe('ok');
    expect(body.port).toBe(port);
  });

  test('read latency p99 is under the budget across 50 samples', async () => {
    // Guard against O(N) regressions on the primary-key SELECT. We sample
    // 50 round-trips and assert the p99 stays well under budget — a single-
    // shot timing test tripped on CI noise. One hardened threshold; no
    // CI/local branching.
    const id = await seedExecutor({ state: 'working' });
    await startExecutorReadEndpoint();
    const port = getExecutorReadPort();
    const url = `http://127.0.0.1:${port}/executors/${id}/state`;

    // Warm pool + routes.
    await fetch(url);

    const samples: number[] = [];
    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      const res = await fetch(url);
      const elapsedMs = performance.now() - start;
      expect(res.status).toBe(200);
      samples.push(elapsedMs);
    }

    samples.sort((a, b) => a - b);
    const p99 = samples[Math.floor(samples.length * 0.99)];
    expect(p99).toBeLessThan(250);
  });
});
