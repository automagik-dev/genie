/**
 * genie-hook — thin client for the daemon-side hook dispatcher.
 *
 * Compiled to a static binary via `bun build --compile`. Replaces the
 * fork-per-event execution of `genie hook dispatch` (~80–200 ms bun cold-start
 * + fresh PG connection) with a sub-millisecond UDS roundtrip to a long-lived
 * listener inside `genie serve --headless`.
 *
 *   stdin (CC hook payload, JSON)
 *      │
 *      ▼
 *   ┌──────────────────────────────┐
 *   │ length-prefixed JSON over UDS │ ──► ~/.genie/hook.sock
 *   └──────────────────────────────┘     │
 *      │                                 ├─ daemon dispatch()
 *      │                                 └─ length-prefixed reply
 *      ▼
 *   stdout (reply JSON or empty)
 *
 * F1 fallback: if the socket is missing, refused, or doesn't reply within the
 * timeout, emit an empty stdout (allow-by-default — operations never block on
 * a daemon outage), append a structured record to ~/.genie/hook-fallback.log,
 * and exit 0. The daemon and `genie doctor` tail this log to surface outages.
 *
 * Wire protocol matches src/serve/hook-socket.ts:
 *   ┌────────────┬────────────────────────┐
 *   │ 4 bytes BE │  N bytes UTF-8 JSON    │
 *   │ length=N   │                        │
 *   └────────────┴────────────────────────┘
 */

import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { type Socket, connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Default UDS path; identical resolver to the daemon side. */
function defaultSocketPath(): string {
  if (process.env.GENIE_HOOK_SOCK) return process.env.GENIE_HOOK_SOCK;
  const home = process.env.GENIE_HOME ?? join(homedir(), '.genie');
  return join(home, 'hook.sock');
}

function fallbackLogPath(): string {
  const home = process.env.GENIE_HOME ?? join(homedir(), '.genie');
  return join(home, 'hook-fallback.log');
}

/** 1 MB per-frame cap (matches the daemon). */
const MAX_FRAME_BYTES = 1_048_576;
/** 100 MB cap on the fallback log; older entries get truncated by rotation. */
const FALLBACK_LOG_MAX_BYTES = 100 * 1024 * 1024;
/** Hard ceiling on a single roundtrip; CC's hook timeout is 15 s. */
const DEFAULT_TIMEOUT_MS = 5_000;

interface FallbackRecord {
  ts: string;
  event: string | null;
  tool: string | null;
  command: string | null;
  agent_id: string | null;
  reason: string;
}

function readStdinSync(): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  const fd = 0;
  const buf = Buffer.alloc(65_536);
  // Synchronous read loop — Bun supports this via fs.readSync(0, ...).
  // We deliberately keep the client synchronous-feeling for low overhead.
  // If stdin is a TTY (no payload) the first read will return 0 immediately.
  while (true) {
    let n: number;
    try {
      const fsMod = require('node:fs') as typeof import('node:fs');
      n = fsMod.readSync(fd, buf, 0, buf.length, null);
    } catch {
      break;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
    total += n;
    if (total > MAX_FRAME_BYTES) break; // refuse oversized payload
  }
  return Buffer.concat(chunks, Math.min(total, MAX_FRAME_BYTES));
}

/** Parse-best-effort: peek at the JSON to extract enough for the fallback record. */
function summarizePayload(payload: Buffer): { event: string | null; tool: string | null; command: string | null } {
  try {
    const obj = JSON.parse(payload.toString('utf-8')) as Record<string, unknown>;
    const event = typeof obj.hook_event_name === 'string' ? obj.hook_event_name : null;
    const tool = typeof obj.tool_name === 'string' ? obj.tool_name : null;
    let command: string | null = null;
    const ti = obj.tool_input as Record<string, unknown> | undefined;
    if (ti && typeof ti.command === 'string') command = (ti.command as string).split('\n')[0].slice(0, 256);
    return { event, tool, command };
  } catch {
    return { event: null, tool: null, command: null };
  }
}

/**
 * Append a structured fallback record. Best effort: never throws — if the file
 * can't be written we silently fail so the hook doesn't break CC.
 */
function appendFallback(record: FallbackRecord): void {
  const path = fallbackLogPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Soft rotation: if we'd overflow the cap, truncate by overwriting with the new line.
    let writeFresh = false;
    try {
      const st = statSync(path);
      if (st.size >= FALLBACK_LOG_MAX_BYTES) writeFresh = true;
    } catch {
      // file doesn't exist yet — that's fine
    }
    const line = `${JSON.stringify(record)}\n`;
    if (writeFresh) {
      const fsMod = require('node:fs') as typeof import('node:fs');
      fsMod.writeFileSync(path, line);
    } else {
      appendFileSync(path, line);
    }
  } catch {
    // best effort — never let logging crash the client
  }
}

interface RoundtripResult {
  reply: string | null; // null = failed; caller emits fallback
  reason?: string;
}

function buildFrame(payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

type ParseStep =
  | { kind: 'incomplete'; length: number }
  | { kind: 'done'; body: Buffer }
  | { kind: 'error'; reason: string };

function parseStep(acc: Buffer, length: number): ParseStep {
  if (length === -1) {
    if (acc.length < 4) return { kind: 'incomplete', length: -1 };
    const declared = acc.readUInt32BE(0);
    if (declared > MAX_FRAME_BYTES) return { kind: 'error', reason: `oversized frame ${declared}` };
    if (declared === 0) return { kind: 'done', body: Buffer.alloc(0) };
    if (acc.length >= 4 + declared) return { kind: 'done', body: acc.subarray(4, 4 + declared) };
    return { kind: 'incomplete', length: declared };
  }
  if (acc.length >= 4 + length) return { kind: 'done', body: acc.subarray(4, 4 + length) };
  return { kind: 'incomplete', length };
}

async function roundtrip(socketPath: string, payload: Buffer, timeoutMs: number): Promise<RoundtripResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: RoundtripResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        sock.destroy();
      } catch {
        // already dead
      }
      finish({ reply: null, reason: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref();

    const sock: Socket = connect(socketPath);

    sock.once('connect', () => {
      sock.write(buildFrame(payload));
    });

    let acc = Buffer.alloc(0);
    let length = -1;
    sock.on('data', (chunk: Buffer) => {
      acc = acc.length === 0 ? Buffer.from(chunk) : Buffer.concat([acc, Buffer.from(chunk)], acc.length + chunk.length);
      const step = parseStep(acc, length);
      if (step.kind === 'incomplete') {
        length = step.length;
        return;
      }
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {
        // already dead
      }
      if (step.kind === 'done') finish({ reply: step.body.toString('utf-8') });
      else finish({ reply: null, reason: step.reason });
    });

    sock.once('error', (err) => {
      clearTimeout(timer);
      const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
      finish({ reply: null, reason: `connect error: ${code}` });
    });

    sock.once('end', () => {
      // If we get end before a complete frame parse, treat as truncated.
      if (!settled) {
        clearTimeout(timer);
        finish({ reply: null, reason: 'socket closed before reply' });
      }
    });
  });
}

export async function runDispatchClient(): Promise<number> {
  const payload = readStdinSync();
  if (payload.length === 0) {
    // No stdin → nothing to dispatch; preserve the legacy bun-side behavior of
    // exiting cleanly with no output.
    return 0;
  }

  const socketPath = process.env.GENIE_HOOK_SOCK ?? defaultSocketPath();
  const timeoutMs = Number.parseInt(process.env.GENIE_HOOK_TIMEOUT_MS ?? '', 10);
  const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  const result = await roundtrip(socketPath, payload, effectiveTimeout);
  if (result.reply !== null) {
    if (result.reply.length > 0) process.stdout.write(result.reply);
    return 0;
  }

  // F1 fallback: emit allow (empty stdout) + append audit record.
  const summary = summarizePayload(payload);
  appendFallback({
    ts: new Date().toISOString(),
    event: summary.event,
    tool: summary.tool,
    command: summary.command,
    agent_id: process.env.GENIE_AGENT_NAME ?? null,
    reason: result.reason ?? 'unknown',
  });
  return 0;
}

// Entry point — runs when this file is executed directly OR when the compiled
// binary is invoked. We guard so the module can also be imported by tests.
if (import.meta.main) {
  runDispatchClient()
    .then((code) => {
      process.exit(code);
    })
    .catch(() => {
      // Last-resort: never throw out of a hook client. Swallow + exit 0 (allow).
      process.exit(0);
    });
}
