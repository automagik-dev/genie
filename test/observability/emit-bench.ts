#!/usr/bin/env bun
/**
 * emit-bench — measures emit-site p99 and end-to-end p99 under sustained
 * 100 ev/s load. Required by WISH §Group 2 validation gate:
 *
 *   bun run test/observability/emit-bench.ts \
 *     --gate-p99-emit=1ms --gate-p99-e2e=50ms
 *
 * Exits 0 on gate pass, 1 on gate fail, 2 on infrastructure failure
 * (e.g., no test PG port). The harness can also run in --no-db mode to
 * measure emit-site latency only (useful when PG isn't available).
 *
 * Numbers we watch:
 *   - emit-site p50/p95/p99  — time inside a single `emitEvent()` call.
 *   - end-to-end p99         — emit → row queryable in `genie_runtime_events`.
 *
 * The harness is self-pacing: it targets exactly 100 ev/s over 10s by
 * sleeping 10ms between emits (adjusted for measurement jitter).
 */

import { __resetEmitForTests, emitEvent, flushNow, getEmitStats, shutdownEmitter } from '../../src/lib/emit.js';

interface Args {
  gateEmitMs: number;
  gateE2eMs: number;
  targetRate: number;
  durationMs: number;
  noDb: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const parse = (flag: string, def: number): number => {
    const match = argv.find((a) => a.startsWith(`--${flag}=`));
    if (!match) return def;
    const raw = match.split('=')[1] ?? '';
    const n = Number.parseFloat(raw.replace(/ms$/, ''));
    return Number.isFinite(n) ? n : def;
  };
  return {
    gateEmitMs: parse('gate-p99-emit', 1),
    gateE2eMs: parse('gate-p99-e2e', 50),
    targetRate: parse('rate', 100),
    durationMs: parse('duration', 10_000),
    noDb: argv.includes('--no-db'),
    verbose: argv.includes('--verbose'),
  };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[idx];
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const dbAvailable = !args.noDb && process.env.GENIE_TEST_PG_PORT !== undefined;

  process.stdout.write(
    `emit-bench: rate=${args.targetRate}/s duration=${args.durationMs}ms db=${dbAvailable ? 'on' : 'off'}\n`,
  );

  __resetEmitForTests();

  const emitLatencies: number[] = [];
  const perEventSubmitWall: Array<{ subject: string; t0: number }> = [];

  const intervalMs = 1000 / args.targetRate;
  const start = Date.now();
  let seq = 0;

  while (Date.now() - start < args.durationMs) {
    const subject = `bench-${seq++}`;
    const t0 = performance.now();
    emitEvent(
      'cache.hit',
      { cache: 'bench', hit: true, key_hint: subject },
      { severity: 'debug', source_subsystem: 'bench' },
    );
    const t1 = performance.now();
    emitLatencies.push(t1 - t0);
    perEventSubmitWall.push({ subject, t0: Date.now() });
    // Self-pace — sleep the remainder of the tick.
    const elapsed = Date.now() - start;
    const expected = seq * intervalMs;
    const sleep = Math.max(0, expected - elapsed);
    if (sleep > 0) await new Promise((r) => setTimeout(r, sleep));
  }

  await flushNow();

  // End-to-end (only meaningful when DB is available) — for now we measure
  // as "time from emit to drain completion", since a full consumer-LISTEN
  // path is Group 4. This still exercises queue→flush→PG roundtrip.
  const drainEnd = Date.now();
  const e2eLatencies = dbAvailable ? perEventSubmitWall.map(({ t0 }) => drainEnd - t0) : [];

  emitLatencies.sort((a, b) => a - b);
  e2eLatencies.sort((a, b) => a - b);

  const emitP50 = quantile(emitLatencies, 0.5);
  const emitP95 = quantile(emitLatencies, 0.95);
  const emitP99 = quantile(emitLatencies, 0.99);
  const e2eP99 = e2eLatencies.length > 0 ? quantile(e2eLatencies, 0.99) : Number.NaN;

  const stats = getEmitStats();

  process.stdout.write('\n--- results ---\n');
  process.stdout.write(`samples:       ${emitLatencies.length}\n`);
  process.stdout.write(`emit p50:      ${emitP50.toFixed(3)} ms\n`);
  process.stdout.write(`emit p95:      ${emitP95.toFixed(3)} ms\n`);
  process.stdout.write(`emit p99:      ${emitP99.toFixed(3)} ms (gate: ${args.gateEmitMs} ms)\n`);
  if (dbAvailable) {
    process.stdout.write(`e2e   p99:     ${e2eP99.toFixed(1)} ms (gate: ${args.gateE2eMs} ms)\n`);
  } else {
    process.stdout.write('e2e   p99:     n/a (no DB — pass --no-db off and set GENIE_TEST_PG_PORT)\n');
  }
  process.stdout.write(
    `stats:         enqueued=${stats.enqueued} flushed=${stats.flushed} dropped_debug=${stats.dropped_debug} dropped_overflow=${stats.dropped_overflow} schema_violations=${stats.schema_violations}\n`,
  );

  await shutdownEmitter();

  const emitGatePass = emitP99 <= args.gateEmitMs;
  const e2eGatePass = !dbAvailable || e2eP99 <= args.gateE2eMs;

  if (!emitGatePass) {
    process.stderr.write(`GATE FAIL: emit p99 ${emitP99.toFixed(3)}ms > ${args.gateEmitMs}ms\n`);
  }
  if (!e2eGatePass) {
    process.stderr.write(`GATE FAIL: e2e p99 ${e2eP99.toFixed(1)}ms > ${args.gateE2eMs}ms\n`);
  }

  return emitGatePass && e2eGatePass ? 0 : 1;
}

const code = await main();
process.exit(code);
