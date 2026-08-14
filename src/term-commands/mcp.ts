/**
 * genie mcp — a hand-rolled, zero-dependency stdio MCP server exposing the v5
 * `.genie/genie.db` state with 5 read tools + 12 operative write tools.
 *
 * Transport (per SPIKE.md, verdict "hand-rolled"): newline-delimited JSON-RPC
 * 2.0 — one JSON object per line on stdin/stdout. NOT LSP `Content-Length`
 * framing. Speaks MCP protocol `2024-11-05`, confirmed against real Claude Code
 * and Warp's bundled schema. The transport loop itself now lives in the shared
 * `../lib/v5/mcp-server.js` (extracted so `genie ui-bridge` reuses it verbatim);
 * this command wires the read + write tools + the fixed initialize reply into it,
 * unchanged on the wire.
 *
 * LAZY-LOAD contract: this module statically imports ONLY commander types and
 * the version string. The write-capable `bun:sqlite` open, the tool
 * implementations, and the server loop are `await import`-ed inside the command
 * action — so `genie board`/`task`/`--help` never load them. `mcp.test.ts`
 * locks this via an import-graph probe.
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
 * Drive the stdio MCP server until stdin closes. Loads the tools + shared
 * transport loop lazily (keeping them out of the genie startup import graph)
 * and configures the loop with the fixed initialize reply and the five read +
 * twelve write tools.
 */
export async function runMcpServer(): Promise<void> {
  // Lazy: the write-capable bun:sqlite open + tools load here, not at genie startup.
  const mcpTools = await import('../lib/v5/mcp-tools.js');
  const {
    isCurrentGenieDb,
    isDegradedReadonlyDb,
    MCP_TOOLS,
    MCP_WRITE_TOOLS,
    openDegradedReadonlyDb,
    openWriteableDb,
    resolveProjectContext,
  } = mcpTools;
  const { runMcpServerLoop } = await import('../lib/v5/mcp-server.js');
  await runMcpServerLoop({
    // MCP_TOOLS stays the read registry ui-bridge splices; the operative write
    // tools are a separate export so the two surfaces never drift together.
    tools: [...MCP_TOOLS, ...MCP_WRITE_TOOLS],
    // Write-capable open through the standard hardened CLI write path
    // (binding revalidation → openDb): the server now mutates .genie/genie.db
    // exactly like `genie task`. Every throw is translated to the loop's null
    // contract; when the write is impossible (write-protected file/filesystem),
    // openWriteableDb degrades to the readonly healing open and the strict
    // validator below adjudicates — a fully-current db keeps serving reads.
    openDb: openWriteableDb,
    openReadonlyDb: openDegradedReadonlyDb,
    validateReadonlyDb: isCurrentGenieDb,
    // A degrade must not outlive the condition that caused it: while the held
    // handle is read-only the loop retries the write open per call and promotes
    // the moment it succeeds, so repairing the filesystem restores the write
    // tools without restarting the server.
    isDegradedHandle: isDegradedReadonlyDb,
    // Fail-closed: missing repository context / genie.db / unsupported layouts
    // surface as a typed MCP error instead of a healthy-looking empty board.
    resolveContext: resolveProjectContext,
    // Fixed reply that ignores the client's declared version — `genie mcp` does
    // NOT negotiate. Key order pinned for byte-identical output.
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
    .description('Run a stdio MCP server exposing genie.db task/board state (read + write tools)')
    .action(async () => {
      await runMcpServer();
    });
}
