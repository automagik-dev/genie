// Verifies the salvaged TerminalMirror snapshot engine serializes + replays under
// bun (design R4) — the load-bearing check before it replaces fresh's raw-byte ring.

import { describe, expect, test } from 'bun:test';
import { TerminalMirror } from './TerminalMirror';

describe('TerminalMirror (salvaged, under bun)', () => {
  test('serialize round-trips written screen content', async () => {
    const m = new TerminalMirror(80, 24);
    m.write('hello-world\r\n');
    const snap = await m.serialize();
    expect(snap).toContain('hello-world');
    m.dispose();
  });

  test('serialize preserves ANSI styling (SGR)', async () => {
    const m = new TerminalMirror(80, 24);
    m.write('plain-[32mgreen[0m-text');
    const snap = await m.serialize();
    expect(snap).toContain('green');
    // SerializeAddon re-emits the SGR color code for styled cells.
    expect(snap).toContain('[');
    expect(snap).toContain('32');
    m.dispose();
  });

  test('reports and applies dimensions on resize', () => {
    const m = new TerminalMirror(80, 24);
    expect(m.dims()).toEqual({ cols: 80, rows: 24 });
    m.resize(120, 40);
    expect(m.dims()).toEqual({ cols: 120, rows: 40 });
    m.dispose();
  });

  test('serializeNow returns synchronously without flushing', () => {
    const m = new TerminalMirror(80, 24);
    m.write('sync-snapshot\r\n');
    const snap = m.serializeNow();
    expect(typeof snap).toBe('string');
    m.dispose();
  });

  test('replays the latest screen after many writes (bounded buffer holds)', async () => {
    const m = new TerminalMirror(80, 24);
    for (let i = 0; i < 200; i++) m.write(`line-${i}\r\n`);
    const snap = await m.serialize();
    expect(snap).toContain('line-199');
    m.dispose();
  });
});
