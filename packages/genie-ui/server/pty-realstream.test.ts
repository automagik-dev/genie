// pty-realstream.test.ts — the regression test that would have caught the bun/node-pty
// bug (node-pty's `onData` never fires under bun 1.3.14: identical btop spawn streams
// ~38k bytes under node, 0 under bun). The G1 lifecycle test (pty-session.test.ts)
// only exercises status/exit EVENTS and scripted exits, so it stayed green while real
// PTY byte delivery was dead — this test closes that gap.
//
// WHY IT SHELLS OUT TO NODE: the server runs under **node** (bun builds, node runs —
// see README "Runtime split"). Byte delivery is runtime-dependent, so the assertion
// MUST run under the server's runtime. This bun:test drives the pty leg by (1) bundling
// the real `PtySession` with Bun.build (bun = the builder) and (2) spawning `node` on a
// driver that streams a real command through it (node = the runtime). Run under bun the
// same PtySession yields 0 bytes; run under node it streams — this test asserts the node
// behavior and so guards the runtime decision at the gate (`bun test`).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SERVER_DIR = import.meta.dir;
const OUT = resolve(SERVER_DIR, '..', 'dist', 'regress');
const DRIVER = resolve(OUT, 'driver.mjs');
const SENTINEL = 'REGRESS';

// The driver streams `printf START; sleep; printf END` through the REAL PtySession and
// reports byte/event counts + whether the live data and the TerminalMirror replay both
// contain the sentinels. It runs under node (the server runtime).
const DRIVER_SRC = `
import { PtySession } from './pty-session.js';
const S = ${JSON.stringify(SENTINEL)};
const s = new PtySession({
  id: 'regress', name: 'regress', role: null, wishId: null,
  command: 'sh', args: ['-c', 'printf "' + S + '_START"; sleep 0.2; printf "' + S + '_END"'],
  cwd: process.cwd(), env: {}, cols: 80, rows: 24,
});
let bytes = 0, events = 0, buf = '';
s.on('data', (d) => { bytes += Buffer.byteLength(d, 'utf8'); events++; buf += d; });
s.on('exit', async () => {
  const replay = await s.replay();
  process.stdout.write(JSON.stringify({
    bytes, events,
    dataHasStart: buf.includes(S + '_START'),
    dataHasEnd: buf.includes(S + '_END'),
    replayHasStart: replay.includes(S + '_START'),
    replayHasEnd: replay.includes(S + '_END'),
    replayBytes: Buffer.byteLength(replay, 'utf8'),
  }));
  s.dispose();
  process.exit(0);
});
s.start();
setTimeout(() => { process.stdout.write(JSON.stringify({ error: 'timeout', bytes, events })); process.exit(1); }, 8000);
`;

interface Report {
  bytes: number;
  events: number;
  dataHasStart: boolean;
  dataHasEnd: boolean;
  replayHasStart: boolean;
  replayHasEnd: boolean;
  replayBytes: number;
  error?: string;
}

let report: Report;

beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  // bun = the builder: bundle the real PtySession for the node runtime, keeping the
  // native addon + CJS @xterm packages external so node loads them from node_modules.
  const built = await Bun.build({
    entrypoints: [resolve(SERVER_DIR, 'pty-session.ts')],
    target: 'node',
    outdir: OUT,
    external: ['node-pty', 'ws', '@xterm/headless', '@xterm/addon-serialize', '@xterm/xterm'],
  });
  if (!built.success) throw new AggregateError(built.logs, 'pty-session bundle failed');
  writeFileSync(DRIVER, DRIVER_SRC);
  // node = the runtime: drive the real PTY under node and capture the report.
  const out = execFileSync('node', [DRIVER], { cwd: OUT, encoding: 'utf8', timeout: 30_000 });
  report = JSON.parse(out) as Report;
});

afterAll(() => rmSync(OUT, { recursive: true, force: true }));

describe('real-PTY streaming under the node runtime', () => {
  test('node-pty onData delivers bytes (the bug: 0 under bun)', () => {
    expect(report.error).toBeUndefined();
    expect(report.events).toBeGreaterThan(0);
    expect(report.bytes).toBeGreaterThan(0);
  });

  test('live data carries the streamed sentinels', () => {
    expect(report.dataHasStart).toBe(true);
    expect(report.dataHasEnd).toBe(true);
  });

  test('TerminalMirror replay reconstructs the streamed screen', () => {
    expect(report.replayBytes).toBeGreaterThan(0);
    expect(report.replayHasStart).toBe(true);
    expect(report.replayHasEnd).toBe(true);
  });
});
