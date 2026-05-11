import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ChildProcess, SpawnOptionsWithoutStdio } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ControlSession, decodeOctalEscapes } from '../control.js';

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    this.emit('close', 0);
    return true;
  }
}

type FakeSpawn = (() => FakeChild) & { instances: FakeChild[]; calls: string[][] };

function makeFakeSpawn(): FakeSpawn {
  const fn = ((cmd: string, args: ReadonlyArray<string>, _opts: SpawnOptionsWithoutStdio) => {
    const child = new FakeChild();
    fn.instances.push(child);
    fn.calls.push([cmd, ...args]);
    return child as unknown as ChildProcess;
  }) as unknown as FakeSpawn;
  fn.instances = [];
  fn.calls = [];
  return fn;
}

describe('decodeOctalEscapes', () => {
  test('passes plain ASCII through', () => {
    expect(decodeOctalEscapes('hello').toString('utf-8')).toBe('hello');
  });

  test('handles a literal double backslash', () => {
    expect(decodeOctalEscapes('a\\\\b').toString('utf-8')).toBe('a\\b');
  });

  test('decodes three-digit octal escapes', () => {
    // \033 → ESC, \012 → LF
    const out = decodeOctalEscapes('\\033[31mX\\012');
    expect(out).toEqual(Buffer.from([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x58, 0x0a]));
  });

  test('decodes octal UTF-8 multibyte (日 = e6 97 a5)', () => {
    const out = decodeOctalEscapes('\\346\\227\\245');
    expect(out.toString('utf-8')).toBe('日');
  });

  test('round-trips emoji 🚀 through octal encoding', () => {
    const out = decodeOctalEscapes('\\360\\237\\232\\200');
    expect(out.toString('utf-8')).toBe('🚀');
  });

  test('passes non-octal-escape backslash through verbatim', () => {
    expect(decodeOctalEscapes('\\xff').toString('utf-8')).toBe('\\xff');
  });

  test('UTF-8 codepoint mid-stream passes through', () => {
    expect(decodeOctalEscapes('a日b').toString('utf-8')).toBe('a日b');
  });

  test('handles empty string', () => {
    expect(decodeOctalEscapes('').length).toBe(0);
  });
});

describe('ControlSession spawn arguments', () => {
  let fakeSpawn: FakeSpawn;
  let session: ControlSession;

  beforeEach(() => {
    fakeSpawn = makeFakeSpawn();
  });

  afterEach(() => {
    session?.detach();
  });

  test('spawns tmux -L genie -C attach-session -t <name>', () => {
    session = new ControlSession('agent-foo', { autoReconnect: false, spawnFn: fakeSpawn });
    expect(fakeSpawn.calls[0]).toEqual(['tmux', '-L', 'genie', '-C', 'attach-session', '-t', 'agent-foo']);
  });

  test('honors custom socket override', () => {
    session = new ControlSession('agent-foo', {
      socketName: 'genie-staging',
      autoReconnect: false,
      spawnFn: fakeSpawn,
    });
    expect(fakeSpawn.calls[0][2]).toBe('genie-staging');
  });

  test('honors custom tmux binary override', () => {
    session = new ControlSession('agent-foo', {
      tmuxBin: '/opt/tmux/bin/tmux',
      autoReconnect: false,
      spawnFn: fakeSpawn,
    });
    expect(fakeSpawn.calls[0][0]).toBe('/opt/tmux/bin/tmux');
  });
});

describe('ControlSession line parsing', () => {
  let fakeSpawn: FakeSpawn;
  let session: ControlSession;

  beforeEach(() => {
    fakeSpawn = makeFakeSpawn();
  });

  afterEach(() => {
    session?.detach();
  });

  test('emits output (paneId, data) for %output lines', async () => {
    const events: Array<{ paneId: string; data: Buffer }> = [];
    session = new ControlSession('s', { autoReconnect: false, spawnFn: fakeSpawn });
    session.on('output', (paneId: string, data: Buffer) => {
      events.push({ paneId, data });
    });

    const child = fakeSpawn.instances[0];
    child.stdout.write('%output %1 hello\\012world\n');
    await new Promise((r) => setImmediate(r));

    expect(events).toHaveLength(1);
    expect(events[0].paneId).toBe('%1');
    expect(events[0].data).toEqual(Buffer.from('hello\nworld'));
  });

  test('emits exit on %exit', async () => {
    const exits: string[] = [];
    session = new ControlSession('s', { autoReconnect: false, spawnFn: fakeSpawn });
    session.on('exit', (status: string) => exits.push(status));

    const child = fakeSpawn.instances[0];
    child.stdout.write('%exit\n');
    await new Promise((r) => setImmediate(r));
    expect(exits).toEqual(['']);
    expect(session.connected).toBe(false);
  });

  test('emits exit with status text on `%exit 1`', async () => {
    const exits: string[] = [];
    session = new ControlSession('s', { autoReconnect: false, spawnFn: fakeSpawn });
    session.on('exit', (status: string) => exits.push(status));

    const child = fakeSpawn.instances[0];
    child.stdout.write('%exit 1\n');
    await new Promise((r) => setImmediate(r));
    expect(exits).toEqual(['1']);
  });

  test('emits error on %error', async () => {
    const errors: Error[] = [];
    session = new ControlSession('s', { autoReconnect: false, spawnFn: fakeSpawn });
    session.on('error', (err: Error) => errors.push(err));

    const child = fakeSpawn.instances[0];
    child.stdout.write('%error session not found\n');
    await new Promise((r) => setImmediate(r));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('session not found');
  });

  test('ignores %begin/%end/%session-changed/non-% lines', async () => {
    const outputs: unknown[] = [];
    const exits: unknown[] = [];
    const errors: unknown[] = [];
    session = new ControlSession('s', { autoReconnect: false, spawnFn: fakeSpawn });
    session.on('output', (...a) => outputs.push(a));
    session.on('exit', (...a) => exits.push(a));
    session.on('error', (...a) => errors.push(a));

    const child = fakeSpawn.instances[0];
    child.stdout.write('%begin 123 456 0\n');
    child.stdout.write('%end 123 456 0\n');
    child.stdout.write('%session-changed $0 main\n');
    child.stdout.write('plain text not prefixed\n');
    await new Promise((r) => setImmediate(r));

    expect(outputs).toEqual([]);
    expect(exits).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('handles partial frames split across reads (newline arrives later)', async () => {
    const events: Array<{ paneId: string; data: Buffer }> = [];
    session = new ControlSession('s', { autoReconnect: false, spawnFn: fakeSpawn });
    session.on('output', (paneId: string, data: Buffer) => {
      events.push({ paneId, data });
    });

    const child = fakeSpawn.instances[0];
    child.stdout.write('%output %2 par');
    await new Promise((r) => setImmediate(r));
    expect(events).toHaveLength(0); // no newline yet
    child.stdout.write('tial\n');
    await new Promise((r) => setImmediate(r));
    expect(events).toHaveLength(1);
    expect(events[0].data.toString('utf-8')).toBe('partial');
  });

  test('handles multiple %output frames in one chunk', async () => {
    const events: Array<{ paneId: string; data: Buffer }> = [];
    session = new ControlSession('s', { autoReconnect: false, spawnFn: fakeSpawn });
    session.on('output', (paneId: string, data: Buffer) => {
      events.push({ paneId, data });
    });

    const child = fakeSpawn.instances[0];
    child.stdout.write('%output %1 a\n%output %2 b\n%output %1 c\n');
    await new Promise((r) => setImmediate(r));
    expect(events.map((e) => `${e.paneId}=${e.data.toString('utf-8')}`)).toEqual(['%1=a', '%2=b', '%1=c']);
  });
});

describe('ControlSession lifecycle', () => {
  let fakeSpawn: FakeSpawn;

  beforeEach(() => {
    fakeSpawn = makeFakeSpawn();
  });

  test('detach kills the child process exactly once', () => {
    const session = new ControlSession('s', { autoReconnect: false, spawnFn: fakeSpawn });
    const child = fakeSpawn.instances[0];
    session.detach();
    session.detach(); // idempotent
    expect(child.killed).toBe(true);
    expect(session.detached).toBe(true);
    expect(session.connected).toBe(false);
  });

  test('auto-reconnect retries after process close', async () => {
    const fakeSpawnLocal = makeFakeSpawn();
    const setTimeoutOrig = global.setTimeout;
    const queued: Array<() => void> = [];
    (global as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void, _ms: number) => {
      queued.push(fn);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    try {
      const session = new ControlSession('s', { autoReconnect: true, spawnFn: fakeSpawnLocal });
      expect(fakeSpawnLocal.instances).toHaveLength(1);
      const first = fakeSpawnLocal.instances[0];
      first.emit('close', 0);
      // reconnect timer queued
      expect(queued).toHaveLength(1);
      queued[0]();
      expect(fakeSpawnLocal.instances).toHaveLength(2);
      session.detach();
    } finally {
      (global as { setTimeout: typeof setTimeout }).setTimeout = setTimeoutOrig;
    }
  });

  test('detach() prevents auto-reconnect from firing', async () => {
    const fakeSpawnLocal = makeFakeSpawn();
    const setTimeoutOrig = global.setTimeout;
    const queued: Array<() => void> = [];
    (global as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void, _ms: number) => {
      queued.push(fn);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    try {
      const session = new ControlSession('s', { autoReconnect: true, spawnFn: fakeSpawnLocal });
      const child = fakeSpawnLocal.instances[0];
      session.detach();
      child.emit('close', 0);
      // No reconnect should have been scheduled after detach
      for (const fn of queued) fn();
      expect(fakeSpawnLocal.instances).toHaveLength(1);
    } finally {
      (global as { setTimeout: typeof setTimeout }).setTimeout = setTimeoutOrig;
    }
  });

  test('swallows stdin EPIPE error', () => {
    const session = new ControlSession('s', { autoReconnect: false, spawnFn: fakeSpawn });
    const child = fakeSpawn.instances[0];
    // Should NOT throw or crash the process
    expect(() => child.stdin.emit('error', new Error('EPIPE'))).not.toThrow();
    session.detach();
  });

  test('stdin getter exposes the child process stdin', () => {
    const session = new ControlSession('s', { autoReconnect: false, spawnFn: fakeSpawn });
    const child = fakeSpawn.instances[0];
    expect(session.stdin).toBe(child.stdin);
    session.detach();
    expect(session.stdin).toBeNull();
  });
});
