import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type McpSessionSpawnRequest,
  type McpSessionSpawnResult,
  REQUIRED_GENIE_MCP_TOOLS,
  runBoundedCodexMcpSession,
} from './codex-mcp-health-session.js';

/** Newline-delimited JSON-RPC replies the healthy `genie mcp` server would emit. */
function healthyReplies(tools: readonly string[] = REQUIRED_GENIE_MCP_TOOLS, wishStatusIsError = false): string {
  return `${[
    { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'genie' } } },
    { jsonrpc: '2.0', id: 2, result: { tools: tools.map((name) => ({ name })) } },
    {
      jsonrpc: '2.0',
      id: 3,
      result: { isError: wishStatusIsError, structuredContent: { wish: '', groups: [], tasks: [] } },
    },
  ]
    .map((reply) => JSON.stringify(reply))
    .join('\n')}\n`;
}

function fakeSpawn(result: Partial<McpSessionSpawnResult>): (req: McpSessionSpawnRequest) => McpSessionSpawnResult {
  return () => ({ exitCode: 0, stdout: '', stderr: '', ...result });
}

describe('runBoundedCodexMcpSession', () => {
  const base = { launcherPath: '/fixture/root/scripts/mcp-launcher.cjs', cwd: '/tmp/isolated' };

  test('accepts a healthy initialize / tools-list / read-only wish_status session', () => {
    const result = runBoundedCodexMcpSession({ ...base, spawn: fakeSpawn({ stdout: healthyReplies() }) });
    expect(result.ok).toBe(true);
    expect(result.wishStatusReadOnly).toBe(true);
    expect(result.tools).toEqual([...REQUIRED_GENIE_MCP_TOOLS]);
  });

  test('rejects a timed-out session', () => {
    const result = runBoundedCodexMcpSession({ ...base, timeoutMs: 500, spawn: fakeSpawn({ timedOut: true }) });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('timed out after 500ms');
  });

  test('rejects an initialize protocol error', () => {
    const stdout = `${JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'boom' } })}\n`;
    const result = runBoundedCodexMcpSession({ ...base, spawn: fakeSpawn({ stdout }) });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('initialize returned a JSON-RPC error');
  });

  test('rejects a session that is missing one of the five Genie tools', () => {
    const partial = REQUIRED_GENIE_MCP_TOOLS.filter((name) => name !== 'genie_wish_status');
    const result = runBoundedCodexMcpSession({ ...base, spawn: fakeSpawn({ stdout: healthyReplies(partial) }) });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('missing required Genie tools: genie_wish_status');
  });

  test('rejects a wish_status that reports an error result (not read-only ok)', () => {
    const result = runBoundedCodexMcpSession({
      ...base,
      spawn: fakeSpawn({ stdout: healthyReplies(REQUIRED_GENIE_MCP_TOOLS, true) }),
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('read-only genie_wish_status did not return a non-error result');
  });

  test('rejects a session whose tools/list reply never arrived', () => {
    const stdout = `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05' } })}\n`;
    const result = runBoundedCodexMcpSession({ ...base, spawn: fakeSpawn({ stdout }) });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('tools/list response was missing');
  });
});

// ---------------------------------------------------------------------------
// A3: the REAL spawn path (through a node stub launcher speaking newline JSON-RPC
// and exiting on stdin EOF) must complete AND mutate nothing on disk.
// ---------------------------------------------------------------------------
function digestTree(dir: string): string {
  const digest = createHash('sha256');
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const abs = join(current, name);
      const stat = lstatSync(abs);
      digest.update(`${name}\0${stat.isDirectory() ? 'd' : 'f'}\0${stat.size}\0`);
      if (stat.isDirectory()) walk(abs);
    }
  };
  walk(dir);
  return digest.digest('hex');
}

describe('runBoundedCodexMcpSession — real spawn is side-effect-free (A3)', () => {
  test('drives a real newline-JSON-RPC launcher and leaves the isolated home byte-identical', () => {
    const home = mkdtempSync(join(tmpdir(), 'genie-mcp-real-'));
    const stub = join(home, 'stub-launcher.cjs');
    // A minimal launcher: read stdin lines, answer initialize/tools-list/wish_status,
    // ignore notifications, and exit on EOF — the same contract as genie mcp.
    writeFileSync(
      stub,
      [
        "const rl = require('node:readline').createInterface({ input: process.stdin });",
        `const tools = ${JSON.stringify([...REQUIRED_GENIE_MCP_TOOLS])}.map((name) => ({ name }));`,
        "rl.on('line', (line) => {",
        '  const t = line.trim(); if (!t) return;',
        '  let req; try { req = JSON.parse(t); } catch { return; }',
        '  if (req.id === undefined || req.id === null) return;',
        "  if (req.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05' } }) + '\\n');",
        "  else if (req.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { tools } }) + '\\n');",
        "  else if (req.method === 'tools/call') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { isError: false, structuredContent: { wish: '' } } }) + '\\n');",
        '});',
      ].join('\n'),
    );
    const cwd = mkdtempSync(join(tmpdir(), 'genie-mcp-cwd-'));
    const before = digestTree(home);
    try {
      const result = runBoundedCodexMcpSession({ launcherPath: stub, cwd, timeoutMs: 8_000 });
      expect(result.ok).toBe(true);
      expect(result.tools).toEqual([...REQUIRED_GENIE_MCP_TOOLS]);
      expect(digestTree(home)).toBe(before);
      expect(readdirSync(cwd)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
