#!/usr/bin/env bun
import { type OptimizedBuffer, RGBA } from '@opentui/core';
/**
 * Group 3 microbenchmark fixture — surfaces emit→render latency for the
 * TerminalPane hot path. Group 5 runs this on Linux + macOS hosts and pastes
 * the result into `.genie/runbooks/tui-host/perf-baseline.md`.
 *
 * Methodology:
 *   1. Spin up an `@xterm/headless` Terminal sized to 200 cols × 50 rows
 *      (typical embed viewport for the smoke matrix).
 *   2. Drive 10 000 styled lines into the parser at the configured pacing.
 *   3. After every `linesPerFrame` emit, walk the cell buffer with
 *      `paintXtermBufferToFrame` into a recording stub buffer.
 *      The walk time + xterm parse-flush time is the "emit→render" latency.
 *   4. Surface p50 / p95 / max — both as ms-per-frame and lines/sec throughput.
 *
 * Output is two parts:
 *   - A machine-grep-able block (`^p50 emit_render=…`, etc.) that Group 5's
 *     validation gate consumes.
 *   - A human summary table.
 *
 * Default budget: ≤100 ms p95 on Linux, ≤150 ms p95 on macOS (wish decision #10).
 *
 * Override knobs:
 *   LINES=10000      total lines to emit
 *   LINES_PER_FRAME  lines parsed before each cell-walk (default 30)
 *   COLS=200         viewport columns
 *   ROWS=50          viewport rows
 *   STYLED=1         whether to wrap each line in a fresh SGR run
 */
import { Terminal } from '@xterm/headless';
import type { IBuffer } from '@xterm/headless';
import { paintXtermBufferToFrame } from '../xterm-cell-paint.js';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const v = Number.parseInt(raw, 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

const LINES = envInt('LINES', 10_000);
const LINES_PER_FRAME = envInt('LINES_PER_FRAME', 30);
const COLS = envInt('COLS', 200);
const ROWS = envInt('ROWS', 50);
const STYLED = envBool('STYLED', true);

/** Recording OptimizedBuffer stub — counts setCell calls without allocating. */
function makeRecordingBuffer(): OptimizedBuffer {
  let count = 0;
  const inst = {
    setCell: () => {
      count++;
    },
    setCellWithAlphaBlending: () => undefined,
    drawText: () => undefined,
    fillRect: () => undefined,
    drawFrameBuffer: () => undefined,
    drawTextBuffer: () => undefined,
    clear: () => undefined,
    cellCount: () => count,
  };
  return inst as unknown as OptimizedBuffer;
}

/** Generate a styled line payload — colors + bold/underline cycles. */
function makeLine(index: number): string {
  if (!STYLED) return `line ${index.toString().padStart(6, ' ')} | the quick brown fox jumps over the lazy dog\r\n`;
  const fgColor = 31 + (index % 7); // ANSI 31..37
  const bgColor = 40 + (index % 8); // ANSI 40..47
  const attrs = (index % 4) + 1; // 1=bold, 2=dim, 3=italic, 4=underline
  return `\x1b[${attrs};${fgColor};${bgColor}mline ${index
    .toString()
    .padStart(6, ' ')} | the quick brown fox jumps over the lazy dog\x1b[0m\r\n`;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (base + 1 < sorted.length) {
    return (sorted[base] ?? 0) + rest * ((sorted[base + 1] ?? 0) - (sorted[base] ?? 0));
  }
  return sorted[base] ?? 0;
}

async function writeAndWait(term: Terminal, payload: string): Promise<void> {
  await new Promise<void>((resolve) => term.write(payload, () => resolve()));
}

async function main(): Promise<void> {
  const term = new Terminal({
    cols: COLS,
    rows: ROWS,
    scrollback: LINES,
    allowProposedApi: true,
  });
  // Warm: paint once to JIT the hot path.
  const warmBuf = makeRecordingBuffer();
  paintXtermBufferToFrame(term.buffer.active as IBuffer, warmBuf, 0, 0, { cols: COLS, rows: ROWS });

  const frameLatencies: number[] = [];
  const frames = Math.max(1, Math.floor(LINES / LINES_PER_FRAME));

  const wallStart = performance.now();
  for (let f = 0; f < frames; f++) {
    const tStart = performance.now();
    // Emit a frame's worth of lines.
    let chunk = '';
    for (let i = 0; i < LINES_PER_FRAME; i++) {
      chunk += makeLine(f * LINES_PER_FRAME + i);
    }
    await writeAndWait(term, chunk);
    // Walk the cell buffer (this is what TerminalPane.renderSelf does each frame).
    const buf = makeRecordingBuffer();
    paintXtermBufferToFrame(term.buffer.active as IBuffer, buf, 0, 0, { cols: COLS, rows: ROWS });
    const tEnd = performance.now();
    frameLatencies.push(tEnd - tStart);
  }
  const wallEnd = performance.now();

  frameLatencies.sort((a, b) => a - b);
  const p50 = quantile(frameLatencies, 0.5);
  const p95 = quantile(frameLatencies, 0.95);
  const p99 = quantile(frameLatencies, 0.99);
  const max = frameLatencies[frameLatencies.length - 1] ?? 0;
  const totalMs = wallEnd - wallStart;
  const linesPerSec = (LINES / totalMs) * 1000;

  // ── Machine-grep block (matches Group 5's validation grep `^p95.*emit_render`). ──
  const fmt = (n: number) => n.toFixed(3);
  process.stdout.write('# TerminalPane microbenchmark — emit → render\n');
  process.stdout.write(
    `config: lines=${LINES} linesPerFrame=${LINES_PER_FRAME} cols=${COLS} rows=${ROWS} styled=${STYLED}\n`,
  );
  process.stdout.write(`platform: ${process.platform} arch=${process.arch} bun=${Bun.version}\n`);
  process.stdout.write(`frames: ${frames}\n`);
  process.stdout.write(`wall_total_ms: ${fmt(totalMs)}\n`);
  process.stdout.write(`lines_per_sec: ${fmt(linesPerSec)}\n`);
  process.stdout.write(`p50 emit_render_ms=${fmt(p50)}\n`);
  process.stdout.write(`p95 emit_render_ms=${fmt(p95)}\n`);
  process.stdout.write(`p99 emit_render_ms=${fmt(p99)}\n`);
  process.stdout.write(`max emit_render_ms=${fmt(max)}\n`);

  // ── Idle CPU sample stub — Group 5 captures a real `top` sample alongside this. ──
  // We surface a placeholder line so the perf-baseline grep matrix can pattern
  // off the same prefix; Group 5 replaces it with the live measurement.
  process.stdout.write('p95 idle_cpu_pct=PENDING_OPERATOR_SAMPLE\n');

  // ── Human summary table ──
  process.stdout.write('\n| Stat | Value |\n|------|-------|\n');
  process.stdout.write(`| p50 emit→render | ${fmt(p50)} ms |\n`);
  process.stdout.write(`| p95 emit→render | ${fmt(p95)} ms |\n`);
  process.stdout.write(`| p99 emit→render | ${fmt(p99)} ms |\n`);
  process.stdout.write(`| max emit→render | ${fmt(max)} ms |\n`);
  process.stdout.write(`| lines/sec       | ${fmt(linesPerSec)} |\n`);

  // Use a generic RGBA reference so the import isn't dropped by the bundler.
  // (Also keeps the bench tree-shake-friendly — the type re-export survives.)
  void RGBA.fromInts(0, 0, 0, 255);

  term.dispose();

  // Linux budget enforcement (Group 5 gate). macOS gate is soft (≤150ms).
  if (p95 > 100 && process.platform === 'linux') {
    process.exitCode = 2;
    process.stdout.write(`\nFAIL: linux p95 ${fmt(p95)}ms > 100ms budget\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
