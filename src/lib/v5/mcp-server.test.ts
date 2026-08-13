/**
 * mcp-server — shared stdio loop SEAM tests (Group 1 of wish mcp-write-tools).
 *
 * Drives a stub server (stub tools + injected open) as a subprocess to prove
 * the two seam contracts this group owns:
 *   - the injected open is general — whatever handle `openDb` produces is
 *     validated and served (write-capable `genie mcp` / read-only ui-bridge);
 *   - the opt-in per-result error channel UNWRAPS tagged results before
 *     serialization — the wire payload is the inner value and the envelope
 *     sets `isError: true`, while every untagged result keeps `isError: false`
 *     (an `error`-keyed payload is DATA, never an implicit error channel).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isToolError, toolError, unwrapToolError } from './mcp-server.js';

let dir: string;
let harness: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genie-mcp-server-'));
  harness = join(dir, 'harness.ts');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a stub server whose `tagged` tool returns toolError(payloadJson). */
function writeHarness(payloadJson: string): void {
  writeFileSync(
    harness,
    `import { runMcpServerLoop, toolError } from ${JSON.stringify(join(import.meta.dir, 'mcp-server.ts'))};
const fakeDb = {
  query: () => ({ get: () => ({ user_version: 1 }) }),
  close: () => {},
};
await runMcpServerLoop({
  tools: [
    { name: 'tagged', description: 'd', inputSchema: {}, handler: () => toolError(${payloadJson}) },
    { name: 'plain', description: 'd', inputSchema: {}, handler: () => ({ error: 'not_found' }) },
  ],
  openDb: () => fakeDb,
  initialize: () => ({
    result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 't', version: '0' } },
  }),
});
`,
  );
}

/**
 * Write a stub server whose injected open serves DEGRADED (read-only) handles
 * for the first `degradedOpens` opens and a write-capable one after that — the
 * "filesystem repaired mid-session" shape. The `probe` tool reports what the
 * loop is currently holding.
 */
function writeDegradeHarness(degradedOpens: number): void {
  writeFileSync(
    harness,
    `import { runMcpServerLoop } from ${JSON.stringify(join(import.meta.dir, 'mcp-server.ts'))};
const degraded = new WeakSet();
let opens = 0;
let closes = 0;
await runMcpServerLoop({
  tools: [
    {
      name: 'probe',
      description: 'd',
      inputSchema: {},
      handler: (ctx) => ({ degraded: degraded.has(ctx.db), opens, closes }),
    },
  ],
  openDb: () => {
    opens += 1;
    const db = { query: () => ({ get: () => ({ user_version: 1 }) }), close: () => { closes += 1; } };
    if (opens <= ${degradedOpens}) degraded.add(db);
    return db;
  },
  isDegradedHandle: (db) => degraded.has(db),
  initialize: () => ({
    result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 't', version: '0' } },
  }),
});
`,
  );
}

interface RpcMessage {
  id?: number | string | null;
  result?: { content?: Array<{ type: string; text: string }>; isError?: boolean; structuredContent?: unknown };
  error?: { code: number };
}

async function drive(requests: Record<string, unknown>[]): Promise<RpcMessage[]> {
  const proc = Bun.spawn(['bun', harness], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1' },
  });
  proc.stdin.write(`${requests.map((r) => JSON.stringify(r)).join('\n')}\n`);
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RpcMessage);
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } },
};

function toolPayload<T>(res: RpcMessage): T {
  return JSON.parse((res.result?.content as Array<{ type: string; text: string }>)[0].text) as T;
}

describe('per-result error channel helpers', () => {
  test('toolError tags a value; isToolError/unwrapToolError round-trip it', () => {
    const tagged = toolError({ error: 'typed_failure', detail: 'x' });
    expect(isToolError(tagged)).toBe(true);
    expect(unwrapToolError(tagged)).toEqual({ error: 'typed_failure', detail: 'x' });
  });

  test('an error-KEYED payload is data, not a tagged error', () => {
    expect(isToolError({ error: 'not_found' })).toBe(false);
    expect(isToolError({ error: 'invalid_arguments', missing: ['worktree'] })).toBe(false);
    expect(isToolError(null)).toBe(false);
    expect(isToolError('string')).toBe(false);
  });
});

describe('runMcpServerLoop seam', () => {
  test('a tagged handler result is unwrapped before serialization: inner payload on the wire, isError true', async () => {
    writeHarness(JSON.stringify({ error: 'typed_failure', detail: 'x' }));
    const responses = await drive([
      INIT,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tagged', arguments: {} } },
    ]);
    const res = responses.find((r) => r.id === 2);
    expect(res?.error).toBeUndefined();
    expect(res?.result?.isError).toBe(true);
    // The wire payload is the INNER value — no tag key leaks, shapes unchanged.
    expect(toolPayload<Record<string, unknown>>(res!)).toEqual({ error: 'typed_failure', detail: 'x' });
    expect(res?.result?.structuredContent).toEqual({ error: 'typed_failure', detail: 'x' });
  });

  test('a degraded read-only handle is retried per call and promoted the moment the write open succeeds', async () => {
    // Opens 1 (session start) and 2 (the first retry) are degraded; open 3 is
    // write-capable — the filesystem was repaired between the two tool calls.
    writeDegradeHarness(2);
    const probe = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'probe' } });
    const responses = await drive([INIT, probe(2), probe(3)]);

    // Call 1: the retry is still degraded, so one degraded handle replaces
    // another (closed first, so it cannot hold the WAL index read-only) and
    // reads keep serving.
    const first = toolPayload<{ degraded: boolean; opens: number; closes: number }>(responses.find((r) => r.id === 2)!);
    expect(first).toEqual({ degraded: true, opens: 2, closes: 1 });

    // Call 2: the write open finally succeeds. The degrade never latched, and
    // the handle it replaced was closed (no leak).
    const second = toolPayload<{ degraded: boolean; opens: number; closes: number }>(
      responses.find((r) => r.id === 3)!,
    );
    expect(second).toEqual({ degraded: false, opens: 3, closes: 2 });
  });

  test('an untagged error-keyed handler result stays isError false', async () => {
    writeHarness(JSON.stringify({ error: 'typed_failure' }));
    const responses = await drive([
      INIT,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'plain', arguments: {} } },
    ]);
    const res = responses.find((r) => r.id === 2);
    expect(res?.error).toBeUndefined();
    expect(res?.result?.isError).toBe(false);
    expect(toolPayload<Record<string, unknown>>(res!)).toEqual({ error: 'not_found' });
  });
});
