/**
 * Omni bridge pidfile IPC tests.
 *
 * Exercises the Group 1 wish deliverables:
 *   - Pidfile is written with O_EXCL so two concurrent starts cannot both
 *     claim it; the loser throws a "pidfile locked" error.
 *   - Pidfile is removed deterministically on stop().
 *
 * Uses fake NATS (no socket) and skips PG entirely — tests are hermetic.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import type { NatsConnection, Subscription } from 'nats';
import { getBridgePidfilePath } from '../../lib/bridge-status.js';
import { OmniBridge } from '../omni-bridge.js';

function makeFakeNats(): NatsConnection {
  const fakeSub: Partial<Subscription> & AsyncIterable<never> = {
    unsubscribe: () => {},
    [Symbol.asyncIterator]: async function* () {
      /* empty */
    },
  };
  return {
    info: undefined,
    closed: async () => undefined,
    close: async () => undefined,
    drain: async () => undefined,
    publish: () => {},
    subscribe: () => fakeSub as Subscription,
  } as unknown as NatsConnection;
}

describe('OmniBridge pidfile IPC', () => {
  let tmp: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'omni-bridge-pid-'));
    origHome = process.env.GENIE_HOME;
    process.env.GENIE_HOME = tmp;
  });

  afterEach(() => {
    if (origHome === undefined) process.env.GENIE_HOME = undefined;
    else process.env.GENIE_HOME = origHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeBridge(): OmniBridge {
    return new OmniBridge({
      executorType: 'sdk',
      pgProvider: async () => {
        const err = new Error('connect ECONNREFUSED 127.0.0.1:1') as NodeJS.ErrnoException;
        err.code = 'ECONNREFUSED';
        throw err;
      },
      natsConnectFn: (async () => makeFakeNats()) as never,
    });
  }

  test('writes pidfile on start and removes it on stop', async () => {
    const bridge = makeBridge();
    const path = getBridgePidfilePath();
    expect(existsSync(path)).toBe(false);
    await bridge.start();
    expect(existsSync(path)).toBe(true);
    await bridge.stop();
    expect(existsSync(path)).toBe(false);
  });

  test('stale pidfile (dead PID) is reclaimed — start() succeeds', async () => {
    // Seed a pidfile referencing a PID that cannot exist. Pick a value well
    // above the kernel's pid_max ceiling so process.kill(pid, 0) reliably
    // returns ESRCH regardless of whatever else is running on the host.
    const path = getBridgePidfilePath();
    mkdirSync(dirname(path), { recursive: true });
    const deadPid = 2_147_483_646; // INT32_MAX - 1; guaranteed absent
    writeFileSync(
      path,
      JSON.stringify({
        pid: deadPid,
        startedAt: Date.now() - 60_000,
        subjects: ['omni.message.>'],
        natsUrl: 'localhost:4222',
      }),
    );
    expect(existsSync(path)).toBe(true);

    const bridge = makeBridge();
    await bridge.start();

    // File must exist and contain OUR pid, not the stale one.
    expect(existsSync(path)).toBe(true);
    const payload = JSON.parse(readFileSync(path, 'utf8')) as { pid: number };
    expect(payload.pid).toBe(process.pid);
    expect(payload.pid).not.toBe(deadPid);

    await bridge.stop();
  });

  test('live pidfile (current PID) blocks start — fails fast', async () => {
    const path = getBridgePidfilePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        pid: process.pid, // guaranteed alive
        startedAt: Date.now(),
        subjects: ['omni.message.>'],
        natsUrl: 'localhost:4222',
      }),
    );
    const bridge = makeBridge();
    await expect(bridge.start()).rejects.toThrow(/pidfile locked by PID/);
  });

  test('concurrent start: exactly one wins, the other throws pidfile locked', async () => {
    const a = makeBridge();
    const b = makeBridge();
    const results = await Promise.allSettled([a.start(), b.start()]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    expect(String(reason)).toMatch(/pidfile locked/);
    // Clean up the winner.
    await a.stop().catch(() => {});
    await b.stop().catch(() => {});
  });
});
