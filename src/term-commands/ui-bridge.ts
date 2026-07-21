/**
 * genie ui-bridge — the UI-owned stdio channel into CLI-only genie.
 *
 * A long-lived stdio MCP server the separate-repo genie UI (the dash fork)
 * spawns and OWNS: it reuses `genie mcp`'s newline-JSON-RPC transport + five
 * read tools, and ADDS the net-new surface — a version-negotiating `initialize`
 * handshake, two roster write tools (`roster_hire` / `roster_unhire`) calling
 * genie's own `task-state.ts` code, and change-push notifications driven by an
 * in-child watcher. Genie stays zero-daemon: the child lives and dies with the
 * UI (stdin EOF exit + ppid backstop) and NEVER opens a socket or port.
 *
 * Contract: `src/lib/v5/UI-BRIDGE.md` (protocol version, tools, notifications,
 * skew policy, lifetime).
 *
 * LAZY-LOAD contract: like `genie mcp`, the read-only `bun:sqlite` open +
 * read-tool registry are `await import`-ed inside the action, so they never
 * enter the genie startup import graph. The transport loop, watcher, and state
 * ops are ordinary static imports (none pulls in `mcp-tools.ts`).
 */

import type { Command } from 'commander';
import { startChangeWatcher, startPpidBackstop } from '../lib/v5/bridge-watcher.js';
import { openDb, resolveDbPath } from '../lib/v5/genie-db.js';
import {
  type InitializeOutcome,
  type JsonRpcError,
  PROTOCOL_VERSION,
  notify,
  runMcpServerLoop,
} from '../lib/v5/mcp-server.js';
import type { McpTool } from '../lib/v5/mcp-tools.js';
import { hireAgent, unhireAgent } from '../lib/v5/task-state.js';
import { VERSION } from '../lib/version.js';

// ============================================================================
// Protocol constants (documented in UI-BRIDGE.md)
// ============================================================================

/**
 * The genie ui-bridge protocol version reported by the handshake. Distinct from
 * the MCP wire version (`2024-11-05`): this versions the bridge CONTRACT (tool
 * set, notification semantics, write surface) so the UI and genie can release on
 * separate cadences. `major.minor`; compatibility is by MAJOR.
 */
export const BRIDGE_PROTOCOL_VERSION = '1.0';

/** The id-less notification method emitted when the db changed. */
export const CHANGE_NOTIFICATION_METHOD = 'notifications/genie/changed';

/** JSON-RPC error code (server-defined range) for a declared-incompatible client. */
export const INCOMPATIBLE_VERSION_CODE = -32001;

// ============================================================================
// Version negotiation
// ============================================================================

/** MAJOR component of a `major[.minor…]` version string, or null when unparseable. */
function majorOf(version: string): number | null {
  const m = /^(\d+)/.exec(version.trim());
  return m ? Number.parseInt(m[1], 10) : null;
}

/** Same-MAJOR compatibility against {@link BRIDGE_PROTOCOL_VERSION}. */
function isCompatibleBridgeVersion(declared: string): boolean {
  const declaredMajor = majorOf(declared);
  const serverMajor = majorOf(BRIDGE_PROTOCOL_VERSION);
  return declaredMajor !== null && declaredMajor === serverMajor;
}

/**
 * Build the `initialize` reply. A client that declares
 * `params.bridgeProtocolVersion` with an incompatible MAJOR receives a
 * structured JSON-RPC error (never silence). A client that declares nothing is
 * accepted best-effort and left to decide from the server's reported versions.
 */
export function bridgeInitialize(params: Record<string, unknown> | undefined): InitializeOutcome {
  const declared = typeof params?.bridgeProtocolVersion === 'string' ? params.bridgeProtocolVersion : undefined;
  if (declared !== undefined && !isCompatibleBridgeVersion(declared)) {
    const error: JsonRpcError = {
      code: INCOMPATIBLE_VERSION_CODE,
      message: `Incompatible genie ui-bridge protocol version: client declared "${declared}", server speaks "${BRIDGE_PROTOCOL_VERSION}"`,
      data: { serverBridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION, clientBridgeProtocolVersion: declared },
    };
    return { error };
  }
  return {
    result: {
      protocolVersion: PROTOCOL_VERSION,
      bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
      genieVersion: VERSION,
      capabilities: { tools: {}, experimental: { genieChangeNotifications: true } },
      serverInfo: { name: 'genie-ui-bridge', version: VERSION },
    },
  };
}

// ============================================================================
// Roster write tools (the bridge's only write surface)
// ============================================================================

function nonEmptyString(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * The two roster write tools, over a lazily-opened WRITE-capable handle. They
 * call `task-state.ts` ops exclusively (never raw SQL) so writer invariants stay
 * in one codebase. `worktree` is REQUIRED on hire — a worktree is always known at
 * hire time (dash binds the genie-launch worktree when hiring), confirming the
 * `hire_roster.worktree NOT NULL` design.
 */
export function buildRosterTools(getWriteDb: () => import('bun:sqlite').Database): McpTool[] {
  return [
    {
      name: 'roster_hire',
      description: 'Hire an agent adapter into a wish (idempotent upsert on (wish, agentAdapterId)).',
      inputSchema: {
        type: 'object',
        properties: {
          wish: { type: 'string', description: 'wish slug' },
          agentAdapterId: { type: 'string', description: 'agent adapter id (runtime/provider slot)' },
          worktree: { type: 'string', description: 'worktree binding (required — bound at hire time)' },
          profile: { type: 'string', description: 'optional provider profile' },
          state: { type: 'string', description: 'optional lifecycle state (defaults to "hired")' },
        },
        required: ['wish', 'agentAdapterId', 'worktree'],
      },
      handler: (_ctx, args) => {
        const wish = nonEmptyString(args, 'wish');
        const agentAdapterId = nonEmptyString(args, 'agentAdapterId');
        const worktree = nonEmptyString(args, 'worktree');
        if (!wish || !agentAdapterId || !worktree) {
          return {
            error: 'invalid_arguments',
            missing: [
              ...(wish ? [] : ['wish']),
              ...(agentAdapterId ? [] : ['agentAdapterId']),
              ...(worktree ? [] : ['worktree']),
            ],
          };
        }
        return hireAgent(getWriteDb(), {
          wish,
          agentAdapterId,
          worktree,
          profile: optionalString(args, 'profile'),
          state: optionalString(args, 'state'),
        });
      },
    },
    {
      name: 'roster_unhire',
      description: 'Remove an agent adapter from a wish (idempotent; removed=false when absent).',
      inputSchema: {
        type: 'object',
        properties: {
          wish: { type: 'string', description: 'wish slug' },
          agentAdapterId: { type: 'string', description: 'agent adapter id' },
        },
        required: ['wish', 'agentAdapterId'],
      },
      handler: (_ctx, args) => {
        const wish = nonEmptyString(args, 'wish');
        const agentAdapterId = nonEmptyString(args, 'agentAdapterId');
        if (!wish || !agentAdapterId) {
          return {
            error: 'invalid_arguments',
            missing: [...(wish ? [] : ['wish']), ...(agentAdapterId ? [] : ['agentAdapterId'])],
          };
        }
        const removed = unhireAgent(getWriteDb(), wish, agentAdapterId);
        return { wish, agentAdapterId, removed };
      },
    },
  ];
}

// ============================================================================
// Watch reader (dedicated read connection for PRAGMA data_version polling)
// ============================================================================

interface WatchReader {
  readDataVersion: () => number | null;
  close: () => void;
}

/**
 * A long-lived read connection whose `PRAGMA data_version` increments whenever
 * ANY other connection commits — the honest daemon-free change signal. Reopens
 * lazily so a db created mid-session (first bridge write, or a fresh `genie
 * init`) is picked up instead of polling `null` forever.
 */
function openWatchReader(
  openReadonlyDb: (cwd: string) => import('bun:sqlite').Database | null,
  cwd: string,
): WatchReader {
  let handle = openReadonlyDb(cwd);
  return {
    readDataVersion(): number | null {
      if (!handle) handle = openReadonlyDb(cwd);
      if (!handle) return null;
      try {
        const row = handle.query('PRAGMA data_version').get() as { data_version: number } | null;
        return row?.data_version ?? null;
      } catch {
        return null;
      }
    },
    close(): void {
      handle?.close();
      handle = null;
    },
  };
}

// ============================================================================
// Runner
// ============================================================================

/**
 * Run the ui-bridge stdio server until stdin EOF (or the ppid backstop fires).
 * Composes the reused read tools + roster write tools + change watcher + ppid
 * backstop over the shared transport loop, then exits promptly.
 */
export async function runUiBridge(): Promise<void> {
  // Lazy: keep the read-only bun:sqlite open + read tools out of genie startup.
  const { MCP_TOOLS, openReadonlyDb } = await import('../lib/v5/mcp-tools.js');
  const cwd = process.cwd();

  // Lazily-opened WRITE handle — the bridge stays non-mutating until an actual
  // roster write is requested. One canonical open path (genie-db → sqlite-open),
  // never a second raw `new Database`.
  let writeDb: import('bun:sqlite').Database | null = null;
  const getWriteDb = (): import('bun:sqlite').Database => {
    if (!writeDb) writeDb = openDb({ cwd });
    return writeDb;
  };

  const reader = openWatchReader(openReadonlyDb, cwd);
  const watcher = startChangeWatcher({
    dbPath: resolveDbPath(cwd),
    readDataVersion: reader.readDataVersion,
    onChange: (dataVersion) => notify(CHANGE_NOTIFICATION_METHOD, { dataVersion }),
  });
  const backstop = startPpidBackstop({
    originalPpid: process.ppid,
    onOrphaned: () => shutdown(true),
  });

  let stopped = false;
  function shutdown(exit: boolean): void {
    if (!stopped) {
      stopped = true;
      watcher.stop();
      backstop.stop();
      reader.close();
      writeDb?.close();
      writeDb = null;
    }
    // Orphaned path: stdin EOF will never arrive, so force a prompt exit.
    if (exit) process.exit(0);
  }

  await runMcpServerLoop({
    tools: [...MCP_TOOLS, ...buildRosterTools(getWriteDb)],
    openReadonlyDb,
    initialize: bridgeInitialize,
    onClose: () => shutdown(false),
  });

  // stdin EOF path: the loop resolved after cleanup + flush. Exit promptly and
  // deterministically (well within the 2 s lifetime bound) rather than waiting
  // for the event loop to drain.
  process.exit(0);
}

// ============================================================================
// Registration
// ============================================================================

export function registerUiBridgeCommand(program: Command): void {
  program
    .command('ui-bridge')
    .description('Run the UI-owned stdio MCP bridge (reads + roster writes + change-push) into genie.db')
    .action(async () => {
      await runUiBridge();
    });
}
