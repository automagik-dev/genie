import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { DEFAULT_DEBOUNCE_MS, createResizeForwarder } from '../resize.js';

interface FakeClock {
  now: number;
  pending: Array<{ id: number; runAt: number; fn: () => void }>;
  setTimeoutFn: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => void;
  advance(ms: number): void;
}

function makeFakeClock(): FakeClock {
  const clock: FakeClock = {
    now: 0,
    pending: [],
    setTimeoutFn: (fn, ms) => {
      const id = clock.pending.length + 1;
      clock.pending.push({ id, runAt: clock.now + ms, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeoutFn: (handle) => {
      const idx = clock.pending.findIndex((p) => p.id === (handle as unknown as number));
      if (idx >= 0) clock.pending.splice(idx, 1);
    },
    advance: (ms) => {
      clock.now += ms;
      const ready = clock.pending.filter((p) => p.runAt <= clock.now);
      clock.pending = clock.pending.filter((p) => p.runAt > clock.now);
      for (const item of ready) item.fn();
    },
  };
  return clock;
}

function collectSync(stream: PassThrough): { reads: string[] } {
  const reads: string[] = [];
  stream.on('data', (chunk: Buffer | string) => {
    reads.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
  });
  return { reads };
}

describe('createResizeForwarder — debounce', () => {
  test('emits exactly one refresh-client -C after the window settles', () => {
    const stdin = new PassThrough();
    const sink = collectSync(stdin);
    const clock = makeFakeClock();
    const forwarder = createResizeForwarder(() => stdin, {
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    forwarder.schedule({ cols: 80, rows: 24 });
    forwarder.schedule({ cols: 100, rows: 30 });
    forwarder.schedule({ cols: 120, rows: 40 });

    // Before window elapses, nothing emitted
    clock.advance(DEFAULT_DEBOUNCE_MS - 1);
    expect(sink.reads).toEqual([]);

    clock.advance(1);
    expect(sink.reads).toEqual(['refresh-client -C 120x40\n']);
  });

  test('final-value-wins across 10 rapid resizes', () => {
    const stdin = new PassThrough();
    const sink = collectSync(stdin);
    const clock = makeFakeClock();
    const forwarder = createResizeForwarder(() => stdin, {
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    for (let i = 0; i < 10; i++) {
      forwarder.schedule({ cols: 80 + i, rows: 24 + i });
    }
    clock.advance(DEFAULT_DEBOUNCE_MS);

    expect(sink.reads).toEqual(['refresh-client -C 89x33\n']);
  });

  test('separate bursts emit separate commands', () => {
    const stdin = new PassThrough();
    const sink = collectSync(stdin);
    const clock = makeFakeClock();
    const forwarder = createResizeForwarder(() => stdin, {
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    forwarder.schedule({ cols: 80, rows: 24 });
    clock.advance(DEFAULT_DEBOUNCE_MS);
    forwarder.schedule({ cols: 100, rows: 30 });
    clock.advance(DEFAULT_DEBOUNCE_MS);

    expect(sink.reads).toEqual(['refresh-client -C 80x24\n', 'refresh-client -C 100x30\n']);
  });
});

describe('createResizeForwarder — flush / cancel / dispose', () => {
  test('flush emits pending immediately', () => {
    const stdin = new PassThrough();
    const sink = collectSync(stdin);
    const clock = makeFakeClock();
    const forwarder = createResizeForwarder(() => stdin, {
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    forwarder.schedule({ cols: 50, rows: 20 });
    expect(forwarder.flush()).toEqual({ cols: 50, rows: 20 });
    expect(sink.reads).toEqual(['refresh-client -C 50x20\n']);
    // No further emission when the debounce timer would have fired
    clock.advance(DEFAULT_DEBOUNCE_MS * 2);
    expect(sink.reads).toEqual(['refresh-client -C 50x20\n']);
  });

  test('flush returns null when nothing is pending', () => {
    const stdin = new PassThrough();
    const clock = makeFakeClock();
    const forwarder = createResizeForwarder(() => stdin, {
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });
    expect(forwarder.flush()).toBeNull();
  });

  test('cancel drops a pending emission', () => {
    const stdin = new PassThrough();
    const sink = collectSync(stdin);
    const clock = makeFakeClock();
    const forwarder = createResizeForwarder(() => stdin, {
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    forwarder.schedule({ cols: 50, rows: 20 });
    forwarder.cancel();
    clock.advance(DEFAULT_DEBOUNCE_MS);
    expect(sink.reads).toEqual([]);
    expect(forwarder.pending()).toBeNull();
  });

  test('dispose discards pending + ignores subsequent schedule', () => {
    const stdin = new PassThrough();
    const sink = collectSync(stdin);
    const clock = makeFakeClock();
    const forwarder = createResizeForwarder(() => stdin, {
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    forwarder.schedule({ cols: 50, rows: 20 });
    forwarder.dispose();
    forwarder.schedule({ cols: 99, rows: 99 });
    clock.advance(DEFAULT_DEBOUNCE_MS * 5);
    expect(sink.reads).toEqual([]);
    expect(forwarder.pending()).toBeNull();
  });
});

describe('createResizeForwarder — stdin handling', () => {
  test('skips write when stdin accessor returns null at flush time', () => {
    let stream: PassThrough | null = new PassThrough();
    const clock = makeFakeClock();
    const forwarder = createResizeForwarder(() => stream, {
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    forwarder.schedule({ cols: 80, rows: 24 });
    stream = null; // simulate reconnect mid-debounce
    expect(() => clock.advance(DEFAULT_DEBOUNCE_MS)).not.toThrow();
  });

  test('survives a stdin write error', () => {
    const stdin = new PassThrough();
    stdin.write = () => {
      throw new Error('EPIPE');
    };
    const clock = makeFakeClock();
    const forwarder = createResizeForwarder(() => stdin, {
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });
    forwarder.schedule({ cols: 80, rows: 24 });
    expect(() => clock.advance(DEFAULT_DEBOUNCE_MS)).not.toThrow();
  });

  test('uses WxH format (not W,H — collides with inline cmd separator)', () => {
    const stdin = new PassThrough();
    const sink = collectSync(stdin);
    const clock = makeFakeClock();
    const forwarder = createResizeForwarder(() => stdin, {
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });
    forwarder.schedule({ cols: 80, rows: 24 });
    clock.advance(DEFAULT_DEBOUNCE_MS);
    expect(sink.reads.join('')).toMatch(/refresh-client -C 80x24/);
    expect(sink.reads.join('')).not.toMatch(/refresh-client -C 80,24/);
  });
});
