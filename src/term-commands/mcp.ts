/**
 * genie mcp — a hand-rolled, zero-dependency stdio MCP server exposing the v5
 * `.genie/genie.db` state READ-ONLY.
 *
 * Transport (per SPIKE.md, verdict "hand-rolled"): newline-delimited JSON-RPC
 * 2.0 — one JSON object per line on stdin/stdout. NOT LSP `Content-Length`
 * framing. Speaks MCP protocol `2024-11-05`, confirmed against real Claude Code
 * and Warp's bundled schema. The transport loop itself now lives in the shared
 * `../lib/v5/mcp-server.js` (extracted so `genie ui-bridge` reuses it verbatim);
 * this command wires the read-only tools + the fixed initialize reply into it,
 * unchanged on the wire.
 *
 * LAZY-LOAD contract: this module statically imports ONLY commander types and
 * the version string. The `bun:sqlite` read-only open, the tool implementations,
 * and the server loop are `await import`-ed inside the command action — so
 * `genie board`/`task`/`--help` never load them. `mcp.test.ts` locks this via an
 * import-graph probe.
 *
 * The stdio protocol writes ARE the server's output by design — not stray
 * logging — so they satisfy biome's no-console rule.
 */

import type { Command } from 'commander';
import { VERSION } from '../lib/version.js';

const PROTOCOL_VERSION = '2024-11-05';

// ============================================================================
// Server run loop
// ============================================================================

/**
 * Drive the read-only stdio MCP server until stdin closes. Loads the read-only
 * tools + shared transport loop lazily (keeping them out of the genie startup
 * import graph) and configures the loop with the fixed, read-only initialize
 * reply and the five read tools — byte-for-byte the pre-extraction behavior.
 */
export async function runMcpServer(): Promise<void> {
  // Lazy: the read-only bun:sqlite open + tools load here, not at genie startup.
  const { MCP_TOOLS, openReadonlyDb, resolveProjectContext } = await import('../lib/v5/mcp-tools.js');
  const { runMcpServerLoop } = await import('../lib/v5/mcp-server.js');
  await runMcpServerLoop({
    tools: MCP_TOOLS,
    openReadonlyDb,
    // Fail-closed: missing repository context / genie.db / unsupported layouts
    // surface as a typed MCP error instead of a healthy-looking empty board.
    resolveContext: resolveProjectContext,
    // Fixed reply that ignores the client's declared version — read-only `genie
    // mcp` does NOT negotiate. Key order pinned for byte-identical output.
    initialize: () => ({
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'genie', version: VERSION },
      },
    }),
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
