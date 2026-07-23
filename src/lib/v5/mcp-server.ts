/**
 * Genie v5 shared stdio MCP server loop — the newline-delimited JSON-RPC 2.0
 * transport extracted verbatim from `src/term-commands/mcp.ts` so that both
 * `genie mcp` (read-only) and `genie ui-bridge` (read + roster writes + push)
 * ride ONE transport with zero copy-paste drift.
 *
 * Transport: one JSON object per line on stdin/stdout — NOT LSP
 * `Content-Length` framing. Speaks MCP protocol `2024-11-05`.
 *
 * The stdio writes (`process.stdout.write`) ARE the server's protocol output by
 * design — not stray logging — so they satisfy biome's no-console rule.
 *
 * LAZY-LOAD contract: this module imports the read-tool types and `Database`
 * TYPE-ONLY (erased at compile time), and takes the runtime `openReadonlyDb` +
 * tool registry via {@link McpServerConfig}. It therefore pulls NEITHER
 * `bun:sqlite` NOR `mcp-tools.ts` into any static import graph — callers
 * dynamic-import their heavy deps and inject them here. `mcp.test.ts`'s
 * import-graph probe locks that contract.
 */

import type { Database } from 'bun:sqlite';
import { createInterface } from 'node:readline';
import type { ProjectContext, ProjectDatabaseBinding } from './genie-db.js';
import type { McpTool, ToolContext } from './mcp-tools.js';

// ============================================================================
// JSON-RPC 2.0 message shapes
// ============================================================================

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** MCP wire protocol version — unchanged from the original `genie mcp`. */
export const PROTOCOL_VERSION = '2024-11-05';

// JSON-RPC standard error codes.
export const METHOD_NOT_FOUND = -32601;
export const INTERNAL_ERROR = -32603;

// ============================================================================
// Low-level writers (the protocol channel)
// ============================================================================

/** Newline-delimited: exactly one JSON object per line, no embedded newlines. */
export function writeMessage(msg: object): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

export function ok(id: number | string | null, result: unknown): void {
  writeMessage({ jsonrpc: '2.0', id, result });
}

export function err(id: number | string | null, code: number, message: string): void {
  writeMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

/** Write a full JSON-RPC error object (with optional `data`). */
export function writeError(id: number | string | null, error: JsonRpcError): void {
  writeMessage({ jsonrpc: '2.0', id, error });
}

/**
 * Emit an id-less JSON-RPC notification line. Used by the bridge's change
 * watcher to push `notifications/genie/changed` out of band. Each write is a
 * complete line, so it never interleaves mid-response.
 */
export function notify(method: string, params?: Record<string, unknown>): void {
  writeMessage(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });
}

// ============================================================================
// Server configuration
// ============================================================================

/** The result of an `initialize` request: an MCP result, or a structured error. */
export type InitializeOutcome = { result: unknown } | { error: JsonRpcError };

export interface McpServerConfig {
  /** The tool registry surfaced by `tools/list` and dispatched by `tools/call`. */
  tools: McpTool[];
  /**
   * Read-only DB open (net-new; returns `null` when the file is absent or cannot
   * be opened). A fail-closed consumer with `resolveContext` turns null into
   * `project-database-unavailable`; legacy consumers may still degrade to an
   * empty projection. Injected so this module never statically imports
   * `bun:sqlite` / `mcp-tools`.
   */
  openReadonlyDb: (target: string | ProjectDatabaseBinding) => Database | null;
  /**
   * Optional pure read-only schema validator. The fail-closed MCP command
   * supplies the per-repo Genie validator; legacy consumers may omit it.
   */
  validateReadonlyDb?: (db: Database) => boolean;
  /**
   * OPT-IN fail-closed resolver (net-new). When provided, the loop resolves the
   * project context once per `tools/call` and, on any non-`ok` kind, returns a
   * typed structured error (`{ error, detail }`, `isError: true`) instead of
   * dispatching the tool against an outer/cache-root empty board. Consumers that
   * omit it (e.g. `genie ui-bridge`) keep the legacy cwd-based degrade-to-empty.
   */
  resolveContext?: (cwd: string) => ProjectContext;
  /** Build the `initialize` reply from the client's declared params. */
  initialize: (params: Record<string, unknown> | undefined) => InitializeOutcome;
  /**
   * Optional cleanup run once when stdin closes, BEFORE the read handle is
   * closed and stdout flushed — the bridge stops its watcher + ppid backstop
   * and closes its write handle here so the event loop can drain.
   */
  onClose?: () => void;
}

// ============================================================================
// Server run loop
// ============================================================================

/**
 * Drive the stdio MCP server until stdin closes. Opens a NET-NEW read-only db
 * handle and dispatches each newline-delimited JSON-RPC message per
 * {@link McpServerConfig}. With a project resolver, a null open fails closed.
 */
export async function runMcpServerLoop(config: McpServerConfig): Promise<void> {
  const cwd = process.cwd();
  // Resolve the fail-closed context up front when a resolver is injected; only an
  // `ok` context may hold a read handle. Without a resolver, keep the legacy open.
  const initialContext = config.resolveContext?.(cwd);
  const openValidatedReadonlyDb = (context?: ProjectContext): Database | null => {
    let target: string | ProjectDatabaseBinding = cwd;
    if (context !== undefined) {
      if (context.kind !== 'ok' || context.databaseBinding === undefined) return null;
      target = context.databaseBinding;
    }
    const db = config.openReadonlyDb(target);
    if (db === null) return null;
    try {
      // Bun may construct a handle for malformed bytes and fail only on the
      // first statement. Validate version + schema before any tool handler can
      // see the handle. Legacy consumers retain the lightweight readability
      // probe when they do not opt into a schema validator.
      let valid = true;
      if (config.validateReadonlyDb) valid = config.validateReadonlyDb(db);
      else db.query('PRAGMA user_version').get();
      if (!valid) {
        db.close();
        return null;
      }
      return db;
    } catch {
      db.close();
      return null;
    }
  };
  const openHandle = (context: ProjectContext | undefined): Database | null => openValidatedReadonlyDb(context);
  // Single source of truth for the read handle: the per-call reopen below writes
  // back to ctx.db, and close() reads ctx.db — so a mid-session reopen is always
  // the one that gets closed (no stale/leaked handle).
  const ctx: ToolContext = { db: openHandle(initialContext), cwd, context: initialContext };
  const toolByName = new Map(config.tools.map((t) => [t.name, t] as const));

  /**
   * Serialize a non-`ok` project context as a stable structured MCP error. This
   * is the ONE place the read-only server refuses to serve an empty board when
   * repository context or the genie.db is missing/unsupported.
   */
  function failClosed(id: number | string | null, context: ProjectContext): void {
    const payload = { error: context.kind, detail: (context as { detail?: string }).detail ?? context.kind };
    ok(id, { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: true });
  }

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
    // Fail-closed gate (opt-in). Re-resolve ONLY while not yet `ok` so a db/context
    // created mid-session (e.g. a fresh `genie init`) is picked up without spending
    // git probes on every call once the context is settled. Any non-`ok` state
    // becomes a typed error rather than an outer/cache-root empty board.
    if (config.resolveContext) {
      const context = ctx.context?.kind === 'ok' ? ctx.context : config.resolveContext(cwd);
      ctx.context = context;
      if (context.kind !== 'ok') {
        if (ctx.db) {
          ctx.db.close();
          ctx.db = null;
        }
        failClosed(id, context);
        return;
      }
    }
    // The db may have been absent when the server started. Re-attempt the
    // read-only open per call so a db created mid-session (e.g. a fresh
    // `genie init` or a bridge write) is picked up.
    if (!ctx.db) ctx.db = openValidatedReadonlyDb(ctx.context);
    // Existence is not openability: a directory, malformed file, unreadable
    // path, or failed readonly open can still arrive with an `ok` path context.
    // Never dispatch a fail-closed MCP tool with a null handle, because every
    // read tool interprets null as a healthy empty projection.
    if (config.resolveContext && !ctx.db && ctx.context?.kind === 'ok') {
      const unavailable: ProjectContext = {
        ...ctx.context,
        kind: 'project-database-unavailable',
        detail: `unable to open Genie database at ${ctx.context.dbPath}`,
      };
      // Preserve retry behavior: a later call re-resolves this non-ok context
      // and may recover after the path is repaired.
      ctx.context = unavailable;
      failClosed(id, unavailable);
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
      case 'initialize': {
        const outcome = config.initialize(req.params);
        if ('error' in outcome) writeError(id, outcome.error);
        else ok(id, outcome.result);
        return;
      }
      case 'ping':
        if (!isNotification) ok(id, {});
        return;
      case 'tools/list':
        if (!isNotification) {
          ok(id, {
            tools: config.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
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
    // A JSON-RPC request must be a non-null object. `JSON.parse('null')` and bare
    // primitives are valid JSON but carry no id to attribute — drop them like an
    // unparseable line. Without this, `dispatch(null)` (and the catch below) throw
    // on `null.id`, and the uncaught error crashes the server on a `null` line.
    if (req === null || typeof req !== 'object') return;
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
      config.onClose?.();
      ctx.db?.close();
      // Flush stdout BEFORE exiting: the empty-write callback fires after the
      // stream's buffer (including all prior response writes) drains to the OS,
      // so the final response is never truncated.
      process.stdout.write('', () => resolve());
    });
  });
}
