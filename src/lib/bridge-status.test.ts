import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringCodec } from 'nats';
import {
  BRIDGE_PING_SUBJECT,
  getBridgePidfilePath,
  getBridgeStatus,
  isPidAlive,
  readBridgePidfile,
} from './bridge-status.js';

describe('bridge-status', () => {
  let tmpDir: string;
  let pidfilePath: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bridge-status-'));
    origHome = process.env.GENIE_HOME;
    process.env.GENIE_HOME = tmpDir;
    mkdirSync(join(tmpDir, 'state'), { recursive: true });
    pidfilePath = join(tmpDir, 'state', 'omni-bridge.json');
  });

  afterEach(() => {
    if (origHome === undefined) process.env.GENIE_HOME = undefined;
    else process.env.GENIE_HOME = origHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('getBridgePidfilePath honors GENIE_HOME', () => {
    expect(getBridgePidfilePath()).toBe(pidfilePath);
  });

  test('returns stopped when no pidfile present', async () => {
    const res = await getBridgeStatus(pidfilePath);
    expect(res.state).toBe('stopped');
    expect(res.detail).toMatch(/no pidfile/);
  });

  test('readBridgePidfile returns null for malformed json', () => {
    writeFileSync(pidfilePath, '{not-json');
    expect(readBridgePidfile(pidfilePath)).toBeNull();
  });

  test('returns stale when pid is not alive', async () => {
    // 2^31-1 is the max pid_max ceiling on Linux; allocated pids are sparse
    // long before this, so kill(pid, 0) reliably returns ESRCH.
    writeFileSync(
      pidfilePath,
      JSON.stringify({
        pid: 2147483646,
        startedAt: Date.now(),
        subjects: ['omni.bridge.ping'],
        natsUrl: 'localhost:4222',
      }),
    );
    const res = await getBridgeStatus(pidfilePath);
    expect(res.state).toBe('stale');
    expect(res.detail).toMatch(/not running/);
  });

  test('isPidAlive returns true for current process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test('returns stale when pid alive but ping times out', async () => {
    writeFileSync(
      pidfilePath,
      JSON.stringify({
        pid: process.pid,
        startedAt: Date.now(),
        subjects: ['omni.bridge.ping'],
        natsUrl: 'localhost:4222',
      }),
    );
    const res = await getBridgeStatus(pidfilePath, {
      timeoutMs: 50,
      natsConnectFn: (async () => ({
        request: async () => {
          throw new Error('TIMEOUT');
        },
        close: async () => {},
      })) as never,
    });
    expect(res.state).toBe('stale');
    expect(res.detail).toMatch(/ping failed/);
  });

  test('returns running when ping responds with pong', async () => {
    const sc = StringCodec();
    writeFileSync(
      pidfilePath,
      JSON.stringify({
        pid: process.pid,
        startedAt: Date.now() - 1000,
        subjects: [BRIDGE_PING_SUBJECT],
        natsUrl: 'localhost:4222',
      }),
    );
    const pong = { ok: true as const, pid: process.pid, uptimeMs: 1234, subjects: [BRIDGE_PING_SUBJECT] };
    const res = await getBridgeStatus(pidfilePath, {
      natsConnectFn: (async () => ({
        request: async () => ({ data: sc.encode(JSON.stringify(pong)) }),
        close: async () => {},
      })) as never,
    });
    expect(res.state).toBe('running');
    expect(res.pong?.pid).toBe(process.pid);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
