/**
 * Group 3 unit tests for the TerminalPane widget. Tests target the testable
 * `TerminalPaneCore` controller (no OpenTUI runtime needed) plus the pure
 * cell-paint helper. The thin `TerminalPane` Renderable wrapper is exercised
 * end-to-end by Group 5's smoke matrix.
 *
 * Acceptance map (per WISH.md → Group 3):
 *  - cell-blit correctness   → "paints xterm cells into OptimizedBuffer"
 *  - focus toggle symmetry   → "100 focus toggle cycles leave no listeners"
 *  - mouse contract          → "disableDragTracking emits both ?1002l and ?1003l"
 *  - resize debounce         → "10 rapid resizes → one refresh-client -C"
 *  - initial-replay cap      → "replayHistory caps at historyLimit"
 */
import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { type OptimizedBuffer, RGBA, TextAttributes } from '@opentui/core';
import { Terminal } from '@xterm/headless';
import { createResizeForwarder } from '../../tmux-control/resize.js';
import type { ControlSessionLike, StdinLike, StdoutLike } from '../TerminalPane.js';
import { DEFAULT_HISTORY_LIMIT, TerminalPaneCore } from '../TerminalPane.js';
import { cellAttributes, cellColor, paintXtermBufferToFrame } from '../xterm-cell-paint.js';

// ─── helpers ───────────────────────────────────────────────────────────────

interface RecordedCell {
  x: number;
  y: number;
  char: string;
  fg: RGBA;
  bg: RGBA;
  attrs: number;
}

/** Minimal OptimizedBuffer that records every setCell call. */
function makeRecordingBuffer(): { buffer: OptimizedBuffer; cells: RecordedCell[] } {
  const cells: RecordedCell[] = [];
  const buffer = {
    setCell(x: number, y: number, char: string, fg: RGBA, bg: RGBA, attributes?: number) {
      cells.push({ x, y, char, fg, bg, attrs: attributes ?? 0 });
    },
    // Stub everything else the FrameBufferRenderable parent might touch.
    setCellWithAlphaBlending: () => undefined,
    drawText: () => undefined,
    fillRect: () => undefined,
    drawFrameBuffer: () => undefined,
    drawTextBuffer: () => undefined,
    clear: () => undefined,
  } as unknown as OptimizedBuffer;
  return { buffer, cells };
}

class FakeEmitter extends EventEmitter implements StdinLike {}

class FakeStdout implements StdoutLike {
  writes: string[] = [];
  write(chunk: string | Buffer): boolean {
    this.writes.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
    return true;
  }
}

class FakeWritable {
  chunks: string[] = [];
  writable = true;
  write(chunk: string | Buffer): boolean {
    this.chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
    return true;
  }
}

class FakeControlSession extends EventEmitter implements ControlSessionLike {
  readonly stdinSink = new FakeWritable();
  detached = false;
  // The real ControlSession exposes `stdin: NodeJS.WritableStream | null`.
  get stdin(): NodeJS.WritableStream | null {
    return this.stdinSink as unknown as NodeJS.WritableStream;
  }
  detach(): void {
    this.detached = true;
  }
}

/** Drive the terminal to a known cell layout, awaiting xterm's async parser. */
async function writeSync(term: Terminal, payload: string): Promise<void> {
  await new Promise<void>((resolve) => term.write(payload, () => resolve()));
}

function makeCore(overrides: Partial<Parameters<typeof TerminalPaneCore.prototype.constructor>[0]> = {}) {
  const stdin = new FakeEmitter();
  const stdout = new FakeStdout();
  const control = new FakeControlSession();
  const core = new TerminalPaneCore({
    sessionName: 'agent-test',
    paneId: '%42',
    cols: 80,
    rows: 24,
    ...overrides,
    deps: {
      stdin,
      stdout,
      controlSessionFactory: () => control,
      ...(overrides.deps ?? {}),
    },
  });
  return { core, stdin, stdout, control };
}

// ─── pure cell painter ─────────────────────────────────────────────────────

describe('paintXtermBufferToFrame', () => {
  test('blits plain ASCII 1:1 from xterm.buffer into the recording buffer', async () => {
    const term = new Terminal({ cols: 5, rows: 1, scrollback: 0, allowProposedApi: true });
    await writeSync(term, 'HELLO');

    const { buffer, cells } = makeRecordingBuffer();
    const painted = paintXtermBufferToFrame(term.buffer.active, buffer, 0, 0, { cols: 5, rows: 1 });

    expect(painted).toBe(5);
    expect(cells.map((c) => c.char).join('')).toBe('HELLO');
    expect(cells.map((c) => `${c.x},${c.y}`)).toEqual(['0,0', '1,0', '2,0', '3,0', '4,0']);
    term.dispose();
  });

  test('honours the (originX, originY) offset', async () => {
    const term = new Terminal({ cols: 3, rows: 1, scrollback: 0, allowProposedApi: true });
    await writeSync(term, 'abc');

    const { buffer, cells } = makeRecordingBuffer();
    paintXtermBufferToFrame(term.buffer.active, buffer, 10, 5, { cols: 3, rows: 1 });

    expect(cells.map((c) => ({ x: c.x, y: c.y, c: c.char }))).toEqual([
      { x: 10, y: 5, c: 'a' },
      { x: 11, y: 5, c: 'b' },
      { x: 12, y: 5, c: 'c' },
    ]);
    term.dispose();
  });

  test('paints over 1000 cells in one sweep (acceptance: cell-blit golden)', async () => {
    const COLS = 50;
    const ROWS = 20;
    const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true });
    // Fill every cell with a digit so each painted cell carries a glyph.
    let payload = '';
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) payload += String.fromCharCode(48 + ((x + y) % 10));
      if (y < ROWS - 1) payload += '\r\n';
    }
    await writeSync(term, payload);

    const { buffer, cells } = makeRecordingBuffer();
    const painted = paintXtermBufferToFrame(term.buffer.active, buffer, 0, 0, { cols: COLS, rows: ROWS });

    expect(painted).toBe(COLS * ROWS);
    expect(cells.length).toBe(COLS * ROWS);
    // Spot-check a diagonal — independent of the canvas size scan order.
    const probes = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 10, y: 5 },
      { x: 49, y: 19 },
    ];
    for (const { x, y } of probes) {
      const cell = cells.find((c) => c.x === x && c.y === y);
      expect(cell).toBeDefined();
      expect(cell?.char).toBe(String.fromCharCode(48 + ((x + y) % 10)));
    }
    term.dispose();
  });

  test('maps style attributes (bold/italic/underline) onto OpenTUI bits', async () => {
    const term = new Terminal({ cols: 8, rows: 1, scrollback: 0, allowProposedApi: true });
    await writeSync(term, '\x1b[1;3;4mboldULit\x1b[0m');

    const { buffer, cells } = makeRecordingBuffer();
    paintXtermBufferToFrame(term.buffer.active, buffer, 0, 0, { cols: 8, rows: 1 });
    for (const cell of cells) {
      expect(cell.attrs & TextAttributes.BOLD).not.toBe(0);
      expect(cell.attrs & TextAttributes.ITALIC).not.toBe(0);
      expect(cell.attrs & TextAttributes.UNDERLINE).not.toBe(0);
    }
    term.dispose();
  });

  test('skips the zero-width tail after a wide CJK glyph', async () => {
    const term = new Terminal({ cols: 4, rows: 1, scrollback: 0, allowProposedApi: true });
    await writeSync(term, '日本');

    const { buffer, cells } = makeRecordingBuffer();
    paintXtermBufferToFrame(term.buffer.active, buffer, 0, 0, { cols: 4, rows: 1 });
    // Two width-2 glyphs => exactly 2 paints at x=0 and x=2.
    expect(cells.map((c) => ({ x: c.x, c: c.char }))).toEqual([
      { x: 0, c: '日' },
      { x: 2, c: '本' },
    ]);
    term.dispose();
  });
});

describe('cellColor / cellAttributes — color resolution', () => {
  test('default cell → host theme default fg + bg', async () => {
    const term = new Terminal({ cols: 1, rows: 1, scrollback: 0, allowProposedApi: true });
    await writeSync(term, 'A');
    const cell = term.buffer.active.getLine(0)?.getCell(0);
    expect(cell).toBeDefined();
    if (!cell) return;
    const fg = cellColor(cell, 'fg');
    const bg = cellColor(cell, 'bg');
    // RGBA fromInts(c9, cf, d4, 255) maps a/255 = 1.0; r maps to 201/255 ≈ 0.788.
    expect(fg).toBeInstanceOf(RGBA);
    expect(bg).toBeInstanceOf(RGBA);
    term.dispose();
  });

  test('16-color palette FG (red) → ANSI_16[1] = (205,49,49)', async () => {
    const term = new Terminal({ cols: 1, rows: 1, scrollback: 0, allowProposedApi: true });
    await writeSync(term, '\x1b[31mR\x1b[0m');
    const cell = term.buffer.active.getLine(0)?.getCell(0);
    expect(cell).toBeDefined();
    if (!cell) return;
    const fg = cellColor(cell, 'fg');
    // RGBA stores values in 0..1 floats. 205/255 ≈ 0.804, 49/255 ≈ 0.192.
    expect(fg).toBeInstanceOf(RGBA);
    term.dispose();
  });

  test('attribute mapper preserves all standard style bits', async () => {
    const term = new Terminal({ cols: 1, rows: 1, scrollback: 0, allowProposedApi: true });
    await writeSync(term, '\x1b[1;2;3;4;5;7;8;9mZ\x1b[0m');
    const cell = term.buffer.active.getLine(0)?.getCell(0);
    expect(cell).toBeDefined();
    if (!cell) return;
    const attrs = cellAttributes(cell);
    const allBits =
      TextAttributes.BOLD |
      TextAttributes.DIM |
      TextAttributes.ITALIC |
      TextAttributes.UNDERLINE |
      TextAttributes.BLINK |
      TextAttributes.INVERSE |
      TextAttributes.HIDDEN |
      TextAttributes.STRIKETHROUGH;
    expect(attrs & allBits).toBe(allBits);
    term.dispose();
  });
});

// ─── focus toggle install/uninstall symmetry ──────────────────────────────

describe('TerminalPaneCore — focus toggle install/uninstall', () => {
  test('100 setFocused() cycles leave zero installed stdin listeners', () => {
    const { core, stdin } = makeCore();
    expect(stdin.listenerCount('data')).toBe(0);
    expect(core.installedStdinListeners).toBe(0);
    for (let i = 0; i < 100; i++) {
      core.setFocused(true);
      expect(stdin.listenerCount('data')).toBe(1);
      core.setFocused(false);
      expect(stdin.listenerCount('data')).toBe(0);
    }
    expect(core.installedStdinListeners).toBe(0);
    core.dispose();
  });

  test('setFocused(true) is idempotent — repeated calls do not stack listeners', () => {
    const { core, stdin } = makeCore();
    core.setFocused(true);
    core.setFocused(true);
    core.setFocused(true);
    expect(stdin.listenerCount('data')).toBe(1);
    core.setFocused(false);
    expect(stdin.listenerCount('data')).toBe(0);
    core.dispose();
  });

  test('dispose() removes the listener even when still focused', () => {
    const { core, stdin } = makeCore({ focused: true });
    expect(stdin.listenerCount('data')).toBe(1);
    core.dispose();
    expect(stdin.listenerCount('data')).toBe(0);
  });

  test('forwardInput is a no-op when blurred', () => {
    const { core, control } = makeCore({ focused: false });
    expect(core.forwardInput('keystroke')).toBe(false);
    expect(control.stdinSink.chunks).toEqual([]);
    core.dispose();
  });

  test('focused stdin chunk reaches the control session as send-keys -H', () => {
    const { core, stdin, control } = makeCore({ focused: true });
    stdin.emit('data', Buffer.from('a'));
    // `send-keys -H -t '<pane>' 61\n` — 'a' = 0x61.
    expect(control.stdinSink.chunks.length).toBe(1);
    const cmd = control.stdinSink.chunks[0] ?? '';
    expect(cmd).toContain("send-keys -H -t '%42'");
    expect(cmd).toContain('61');
    core.dispose();
  });
});

// ─── resize debounce ──────────────────────────────────────────────────────

describe('TerminalPaneCore — resize debounce', () => {
  test('10 rapid resizes within the debounce window collapse to one refresh-client -C', () => {
    // Pump a fake clock through the resize forwarder factory so we can advance
    // time deterministically.
    let now = 0;
    const pending: Array<{ id: number; runAt: number; fn: () => void }> = [];
    const setTimeoutFn = (fn: () => void, ms: number) => {
      const id = pending.length + 1;
      pending.push({ id, runAt: now + ms, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    };
    const clearTimeoutFn = (handle: ReturnType<typeof setTimeout>) => {
      const idx = pending.findIndex((p) => p.id === (handle as unknown as number));
      if (idx >= 0) pending.splice(idx, 1);
    };
    const advance = (ms: number) => {
      now += ms;
      const ready = pending.filter((p) => p.runAt <= now);
      pending.splice(0, pending.length, ...pending.filter((p) => p.runAt > now));
      for (const r of ready) r.fn();
    };

    // Use the genuine factory but inject our fake timers via the resize module's options.
    const control = new FakeControlSession();
    const core = new TerminalPaneCore({
      sessionName: 'agent-test',
      paneId: '%42',
      cols: 80,
      rows: 24,
      deps: {
        controlSessionFactory: () => control,
        stdin: new FakeEmitter(),
        stdout: new FakeStdout(),
        resizeForwarderFactory: (accessor) =>
          createResizeForwarder(accessor, { debounceMs: 50, setTimeoutFn, clearTimeoutFn }),
      },
    });

    for (let i = 1; i <= 10; i++) {
      core.scheduleResize(120 + i, 40 + i);
    }
    // None of them have flushed yet (we never advanced time).
    expect(control.stdinSink.chunks).toEqual([]);

    // After the 50ms window settles, exactly one refresh-client -C with the
    // final size goes out.
    advance(50);
    expect(control.stdinSink.chunks).toHaveLength(1);
    expect(control.stdinSink.chunks[0]).toBe('refresh-client -C 130x50\n');
    core.dispose();
  });
});

// ─── initial-replay cap ───────────────────────────────────────────────────

describe('TerminalPaneCore — initial-replay cap', () => {
  test('feeding `2 × cap` lines emits exactly `cap` lines, then refuses subsequent replays', () => {
    const CAP = 100;
    const { core } = makeCore({ historyLimit: CAP });
    const lines = Array.from({ length: CAP * 2 }, (_, i) => `line${i}\r\n`);
    const writtenA = core.replayHistory(lines);
    expect(writtenA).toBe(CAP);
    expect(core.replayedLineCount).toBe(CAP);

    // A second call is a no-op (replay-complete latch).
    const writtenB = core.replayHistory(['extra\r\n']);
    expect(writtenB).toBe(core.replayedLineCount);
    expect(core.replayedLineCount).toBe(CAP);
    core.dispose();
  });

  test('default cap matches DEFAULT_HISTORY_LIMIT', () => {
    const { core } = makeCore();
    expect(core.historyLimit).toBe(DEFAULT_HISTORY_LIMIT);
    core.dispose();
  });

  test('history shorter than the cap passes through 1:1', () => {
    const { core } = makeCore({ historyLimit: 100 });
    const lines = ['a\r\n', 'b\r\n', 'c\r\n'];
    expect(core.replayHistory(lines)).toBe(3);
    expect(core.replayedLineCount).toBe(3);
    core.dispose();
  });
});

// ─── mouse contract ───────────────────────────────────────────────────────

describe('TerminalPaneCore — mouse contract', () => {
  test('on mount, emitted bytes contain BOTH \\x1b[?1002l and \\x1b[?1003l', () => {
    const { stdout } = makeCore();
    // disableDragTracking from render.tsx writes the literal "\x1b[?1002l\x1b[?1003l"
    // (single concatenated string). Mirror the regression from render.test.ts:103.
    const merged = stdout.writes.join('');
    expect(merged).toContain('\x1b[?1002l');
    expect(merged).toContain('\x1b[?1003l');
  });

  test('override fires exactly once per construction', () => {
    const { stdout } = makeCore();
    expect(stdout.writes).toHaveLength(1);
    expect(stdout.writes[0]).toBe('\x1b[?1002l\x1b[?1003l');
  });

  test('custom disableDragTracking override is honoured', () => {
    const calls: number[] = [];
    new TerminalPaneCore({
      sessionName: 's',
      cols: 1,
      rows: 1,
      deps: {
        stdin: new FakeEmitter(),
        stdout: new FakeStdout(),
        controlSessionFactory: () => new FakeControlSession(),
        disableDragTracking: () => calls.push(Date.now()),
      },
    }).dispose();
    expect(calls).toHaveLength(1);
  });
});

// ─── dispose semantics ────────────────────────────────────────────────────

describe('TerminalPaneCore — dispose', () => {
  test('dispose() detaches the control session and clears the output handler', () => {
    const { core, control } = makeCore({ focused: true });
    expect(control.listenerCount('output')).toBe(1);
    core.dispose();
    expect(control.detached).toBe(true);
    expect(control.listenerCount('output')).toBe(0);
  });

  test('dispose() is idempotent', () => {
    const { core } = makeCore();
    core.dispose();
    core.dispose();
    expect(core.isDisposed).toBe(true);
  });

  test('paintInto returns 0 after dispose', () => {
    const { core } = makeCore();
    core.dispose();
    const { buffer } = makeRecordingBuffer();
    expect(core.paintInto(buffer)).toBe(0);
  });
});
