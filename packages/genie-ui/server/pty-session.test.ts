// Colocated bun:test for the PTY boundary: spawn/kill/restart + idle/running/exited
// status/exit events, and the shape of the replay path (mirror snapshot).
//
// SCOPE NOTE — byte-level rendering is manual QA, not a bun:test assertion. node-pty's
// status/exit EVENTS are deterministic here, but its raw onData BYTE delivery is flaky
// under the bun:test harness (a spawn's data channel is sometimes dead for that run —
// a node-pty/bun harness trait, not a product bug: the A/B prototypes rendered real TUIs
// fine in manual use). Per this wish's own acceptance framing ("subjective manual-QA
// acceptance on real TUI ... no deterministic render test"), the data->mirror->replay
// RENDER is verified in qa.md (real TUI + reattach replay), and the snapshot
// serialize/replay ROUND-TRIP is verified deterministically in TerminalMirror.test.ts.
// This file owns the deterministic lifecycle: spawn/kill/restart + status/exit events.

import { describe, expect, test } from 'bun:test';
import type { EventEmitter } from 'node:events';
import type { PaneSpec } from './fleet-config';
import { PtySession, PtySessionManager } from './pty-session';
import type { SessionStatus } from './transport';

function spec(overrides: Partial<PaneSpec>): PaneSpec {
  return {
    id: 't',
    name: 't',
    role: null,
    wishId: null,
    harness: null,
    command: 'bash',
    args: [],
    cwd: process.cwd(),
    env: {},
    cols: 80,
    rows: 24,
    ...overrides,
  };
}

function nextEvent<T extends unknown[]>(em: EventEmitter, ev: string): Promise<T> {
  return new Promise((resolve) => em.once(ev, (...args: unknown[]) => resolve(args as T)));
}

describe('PtySession', () => {
  test('replay() resolves to a string snapshot from the mirror (empty before any output)', async () => {
    const s = new PtySession(spec({ command: 'sleep', args: ['30'] }));
    const before = await s.replay();
    expect(typeof before).toBe('string');
    expect(before).toBe(''); // idle mirror is empty
    s.start();
    const running = await s.replay();
    expect(typeof running).toBe('string'); // serializes without throwing under bun
    s.kill();
    s.dispose();
  });

  test('idle -> running: synchronous status transitions + running event', () => {
    const s = new PtySession(spec({ command: 'sleep', args: ['30'] }));
    const statuses: SessionStatus[] = [];
    s.on('status', (st: SessionStatus) => statuses.push(st));

    expect(s.status).toBe('idle');
    s.start();
    expect(s.status).toBe('running');
    expect(statuses).toContain('running');

    s.kill();
    s.dispose();
  });

  test('kill terminates a running session (exited status + event)', async () => {
    // A pure `sleep` PTY leader reaps promptly on kill (SIGHUP), so the exit transition
    // is deterministic — this is the test that owns the `exited` status + event.
    const s = new PtySession(spec({ command: 'sleep', args: ['30'] }));
    const statuses: SessionStatus[] = [];
    s.on('status', (st: SessionStatus) => statuses.push(st));
    const exited = nextEvent<[number]>(s, 'exit');
    s.start();
    expect(s.status).toBe('running');
    s.kill();
    await exited;
    expect(s.status).toBe('exited');
    expect(statuses).toContain('running');
    expect(statuses).toContain('exited');
    s.dispose();
  });

  test('info() reflects spec + live status', () => {
    const s = new PtySession(spec({ id: 'x', name: 'X', role: 'coder', wishId: 'w1' }));
    const info = s.info();
    expect(info).toMatchObject({ id: 'x', name: 'X', role: 'coder', wishId: 'w1', status: 'idle', exitCode: null });
    s.dispose();
  });
});

describe('PtySessionManager', () => {
  test('startAll starts every session; list() reports running', () => {
    const mgr = new PtySessionManager([spec({ id: 'a', command: 'sleep', args: ['30'] })]);
    mgr.startAll();
    expect(mgr.get('a')?.status).toBe('running');
    expect(mgr.list().find((p) => p.id === 'a')?.status).toBe('running');
    mgr.killAll();
    mgr.disposeAll();
  });

  test('spawn re-starts an exited session', async () => {
    const mgr = new PtySessionManager([spec({ id: 'b', command: 'sleep', args: ['30'] })]);
    mgr.spawn('b');
    expect(mgr.get('b')?.status).toBe('running');
    const exited = nextEvent<[string, number]>(mgr, 'exit');
    mgr.kill('b');
    await exited;
    expect(mgr.get('b')?.status).toBe('exited');
    mgr.spawn('b');
    expect(mgr.get('b')?.status).toBe('running');
    mgr.killAll();
    mgr.disposeAll();
  });

  test('restart yields an ordered exited -> running status sequence', async () => {
    const mgr = new PtySessionManager([spec({ id: 'r', command: 'sleep', args: ['30'] })]);
    mgr.get('r')?.start();
    expect(mgr.get('r')?.status).toBe('running');

    const seq: SessionStatus[] = [];
    const backUp = new Promise<void>((resolve) => {
      mgr.on('status', (_id: string, st: SessionStatus) => {
        seq.push(st);
        if (st === 'exited') return; // wait for the follow-up running
        if (seq.includes('exited') && st === 'running') resolve();
      });
    });
    mgr.restart('r');
    await backUp;

    expect(seq.indexOf('exited')).toBeGreaterThanOrEqual(0);
    expect(seq.lastIndexOf('running')).toBeGreaterThan(seq.indexOf('exited'));
    expect(mgr.get('r')?.status).toBe('running');
    mgr.killAll();
    mgr.disposeAll();
  });

  test('replay() returns empty string for an unknown id', async () => {
    const mgr = new PtySessionManager([]);
    expect(await mgr.replay('nope')).toBe('');
  });
});
