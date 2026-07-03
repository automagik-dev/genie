/**
 * genie mcp — a hand-rolled, zero-dependency stdio MCP server exposing the v5
 * `.genie/genie.db` state READ-ONLY.
 *
 * Transport (per SPIKE.md, verdict "hand-rolled"): newline-delimited JSON-RPC
 * 2.0 — one JSON object per line on stdin/stdout. NOT LSP `Content-Length`
 * framing. Speaks MCP protocol `2024-11-05`, confirmed against real Claude Code
 * and Warp's bundled schema.
 *
 * LAZY-LOAD contract: this module statically imports ONLY commander types and
 * the version string. The `bun:sqlite` read-only open and the tool
 * implementations live in `../lib/v5/mcp-tools.js`, which is `await import`-ed
 * inside the command action — so `genie board`/`task`/`--help` never load it.
 * `mcp.test.ts` locks this via an import-graph probe.
 *
 * The stdio protocol writes (`process.stdout.write`) ARE the server's output by
 * design — not stray logging — so they satisfy biome's no-console rule.
 */

import { createInterface } from 'node:readline';
import type { Command } from 'commander';
// Type-only import: erased at compile time, so it does NOT load mcp-tools (and
// its bun:sqlite open) at genie startup — the runtime load stays in the action.
import type { ToolContext } from '../lib/v5/mcp-tools.js';
import { VERSION } from '../lib/version.js';

// ============================================================================
// JSON-RPC 2.0 message shapes
// ============================================================================

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

const PROTOCOL_VERSION = '2024-11-05';

// JSON-RPC standard error codes.
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

function writeMessage(msg: JsonRpcResponse): void {
  // Newline-delimited: exactly one JSON object per line, no embedded newlines.
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function ok(id: number | string | null, result: unknown): void {
  writeMessage({ jsonrpc: '2.0', id, result });
}

function err(id: number | string | null, code: number, message: string): void {
  writeMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

// ============================================================================
// Server run loop
// ============================================================================

/**
 * Drive the stdio MCP server until stdin closes. Opens a NET-NEW read-only db
 * handle (degrading to an empty board when the file is absent) and dispatches
 * each newline-delimited JSON-RPC message.
 */
export async function runMcpServer(): Promise<void> {
  // Lazy: the read-only bun:sqlite open + tools load here, not at genie startup.
  const { MCP_TOOLS, openReadonlyDb } = await import('../lib/v5/mcp-tools.js');
  const cwd = process.cwd();
  const db = openReadonlyDb(cwd);
  const ctx: ToolContext = { db, cwd };

  const toolByName = new Map(MCP_TOOLS.map((t) => [t.name, t] as const));

  function handleToolsCall(id: number | string | null, params: Record<string, unknown> | undefined): void {
    const name = typeof params?.name === 'string' ? params.name : '';
    const args = (params?.arguments as Record<string, unknown> | undefined) ?? {};
    const tool = toolByName.get(name);
    if (!tool) {
      // Surface as an isError tool result (not a protocol error) per MCP.
      ok(id, {
        content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_tool', name }) }],
        isError: true,
      });
      return;
    }
    const payload = tool.handler(ctx, args);
    ok(id, {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: false,
    });
  }

  function dispatch(req: JsonRpcRequest): void {
    // A message with no id (or null id) is a notification: process side effects
    // but send NO reply (e.g. notifications/initialized).
    const isNotification = req.id === undefined || req.id === null;
    const id = req.id ?? null;

    switch (req.method) {
      case 'initialize':
        ok(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'genie', version: VERSION },
        });
        return;
      case 'ping':
        if (!isNotification) ok(id, {});
        return;
      case 'tools/list':
        if (!isNotification) {
          ok(id, {
            tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
          });
        }
        return;
      case 'tools/call':
        if (!isNotification) handleToolsCall(id, req.params);
        return;
      default:
        // Notifications (e.g. notifications/initialized, notifications/*) get no
        // reply. An unknown method WITH an id is a JSON-RPC method-not-found.
        if (!isNotification) err(id, METHOD_NOT_FOUND, `Method not found: ${req.method}`);
        return;
    }
  }

  function handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      // Unparseable line → cannot attribute an id; drop it (no id to reply to).
      return;
    }
    try {
      dispatch(req);
    } catch (e) {
      const id = req.id ?? null;
      if (id !== null) err(id, INTERNAL_ERROR, e instanceof Error ? e.message : String(e));
    }
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  rl.on('line', handleLine);

  await new Promise<void>((resolve) => {
    rl.on('close', () => {
      db?.close();
      // Flush stdout BEFORE exiting: the empty-write callback fires after the
      // stream's buffer (including all prior response writes) drains to the OS,
      // so the final response is never truncated. See SPIKE.md flush note.
      process.stdout.write('', () => resolve());
    });
  });
}

// ============================================================================
// Registration (the single line in genie.ts calls this)
// ============================================================================

export function registerMcpCommand(program: Command): void {
  program
    .command('mcp')
    .description('Run a read-only stdio MCP server exposing genie.db task/board state')
    .action(async () => {
      await runMcpServer();
    });
}
