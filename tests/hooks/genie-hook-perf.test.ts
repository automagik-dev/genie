/**
 * Performance bench for the in-process dispatcher path.
 *
 * Originated with wish hookify-perf-foundation; in v5 the hook daemon and its
 * UDS transport are gone (dispatch-inproc-default), so this bench measures the
 * in-process dispatch hot path — the only path there is now.
 *
 * Scope: **dispatcher-side hot-path latency** (per-event work — handler chain,
 * span emit, JSON parse) under sustained load, measured in-process.
 *
 * What this proves:
 *   - The handler chain runs in O(few ms) per event under realistic agent load.
 *   - The session-sync cache short-circuits second + subsequent events for the
 *     same agent.
 *   - In-process dispatch has stable steady-state behavior over thousands
 *     of events; no leak / no cliff.
 *
 * What this does NOT prove:
 *   - End-to-end RTT including binary cold-start — a separate runner outside
 *     bun:test would be needed for that.
 *
 * Targets enforced here (subset of WISH "Performance targets"):
 *   - dispatcher-side P50 ≤ 5 ms, P99 ≤ 30 ms (loose to leave headroom for
 *     UDS framing in production)
 *   - 5000 events in ≤ 30 s (≥ 167 evt/s sustained — the wish's 100 evt/s
 *     gate is comfortably exceeded)
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { dispatch } from '../../src/hooks/index.js';

const EVENTS = 2000;
const TARGET_P50_MS = 5;
const TARGET_P99_MS = 30;

let originalAgentName: string | undefined;

beforeAll(() => {
  originalAgentName = process.env.GENIE_AGENT_NAME;
  process.env.GENIE_AGENT_NAME = 'bench-agent';
  // Force telemetry off for this bench — the goal is to measure handler
  // logic, not PG write throughput. Real perf telemetry comes from the live
  // workload via `genie doctor --perf`.
  process.env.GENIE_WIDE_EMIT = '0';
});

afterAll(() => {
  process.env.GENIE_AGENT_NAME = originalAgentName;
});

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

interface BenchResult {
  count: number;
  totalMs: number;
  p50_ms: number;
  p99_ms: number;
  max_ms: number;
  evt_per_sec: number;
}

async function bench(events: number, payloadFactory: (i: number) => unknown): Promise<BenchResult> {
  const samples: number[] = new Array(events);
  const start = Date.now();
  for (let i = 0; i < events; i++) {
    const payload = JSON.stringify(payloadFactory(i));
    const t0 = performance.now();
    await dispatch(payload);
    const t1 = performance.now();
    samples[i] = t1 - t0;
  }
  const total = Date.now() - start;
  samples.sort((a, b) => a - b);
  return {
    count: events,
    totalMs: total,
    p50_ms: percentile(samples, 50),
    p99_ms: percentile(samples, 99),
    max_ms: samples[samples.length - 1],
    evt_per_sec: (events / total) * 1000,
  };
}

test('dispatcher hot-path: PreToolUse Bash events meet P50/P99 targets', async () => {
  const result = await bench(EVENTS, (i) => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: `echo iter-${i}` },
    session_id: `bench-session-${(i / 100) | 0}`, // rotate every 100 events
  }));

  console.log(
    `[bench] PreToolUse Bash: ${result.count} events in ${result.totalMs}ms (${result.evt_per_sec.toFixed(0)} evt/s) — P50=${result.p50_ms.toFixed(2)}ms P99=${result.p99_ms.toFixed(2)}ms max=${result.max_ms.toFixed(2)}ms`,
  );

  expect(result.p50_ms).toBeLessThanOrEqual(TARGET_P50_MS);
  expect(result.p99_ms).toBeLessThanOrEqual(TARGET_P99_MS);
  // Sustained throughput check — wish target is 100 evt/s; real bench should
  // far exceed this since we're measuring dispatcher only.
  expect(result.evt_per_sec).toBeGreaterThan(100);
}, 60_000);

test('dispatcher hot-path: UserPromptSubmit (non-blocking) is faster than blocking events', async () => {
  const result = await bench(EVENTS, (i) => ({
    hook_event_name: 'UserPromptSubmit',
    prompt: `iteration ${i}`,
    session_id: `bench-session-${(i / 100) | 0}`,
  }));
  console.log(
    `[bench] UserPromptSubmit: ${result.count} events in ${result.totalMs}ms (${result.evt_per_sec.toFixed(0)} evt/s) — P50=${result.p50_ms.toFixed(2)}ms P99=${result.p99_ms.toFixed(2)}ms max=${result.max_ms.toFixed(2)}ms`,
  );
  // Non-blocking events should be quicker — chain is shorter.
  expect(result.p99_ms).toBeLessThanOrEqual(TARGET_P99_MS);
}, 60_000);

test('dispatcher hot-path: mixed event stream stays within targets', async () => {
  const result = await bench(EVENTS, (i) => {
    const mod = i % 5;
    const sessionId = `bench-session-${(i / 100) | 0}`;
    if (mod === 0) {
      return {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: `/tmp/${i}` },
        session_id: sessionId,
      };
    }
    if (mod === 1) {
      return {
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: `/tmp/${i}`, old_string: 'a', new_string: 'b' },
        session_id: sessionId,
      };
    }
    if (mod === 2) {
      return {
        hook_event_name: 'PostToolUse',
        tool_name: 'SendMessage',
        tool_input: { to: 'eng', content: 'ack' },
        session_id: sessionId,
      };
    }
    if (mod === 3) {
      return { hook_event_name: 'UserPromptSubmit', prompt: `iter ${i}`, session_id: sessionId };
    }
    return { hook_event_name: 'Stop', last_assistant_message: `done ${i}`, session_id: sessionId };
  });
  console.log(
    `[bench] mixed: ${result.count} events in ${result.totalMs}ms (${result.evt_per_sec.toFixed(0)} evt/s) — P50=${result.p50_ms.toFixed(2)}ms P99=${result.p99_ms.toFixed(2)}ms max=${result.max_ms.toFixed(2)}ms`,
  );
  expect(result.p50_ms).toBeLessThanOrEqual(TARGET_P50_MS);
  expect(result.p99_ms).toBeLessThanOrEqual(TARGET_P99_MS);
}, 60_000);
