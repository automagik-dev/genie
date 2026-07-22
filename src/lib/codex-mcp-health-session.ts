/**
 * Bounded, side-effect-free JSON-RPC health probe through the active Codex
 * plugin's own MCP launcher.
 *
 * The `genie mcp` server (src/term-commands/mcp.ts) speaks NEWLINE-DELIMITED
 * JSON-RPC 2.0 — one JSON object per line — and exits when stdin closes. That
 * lets a single synchronous `spawnSync` drive a full handshake: we write every
 * request up front, close stdin, let the server answer each request in order and
 * exit on EOF, then parse the newline-delimited replies. No async ripple into
 * the otherwise synchronous integration state machines, and a hard `timeout`
 * bounds the whole session.
 *
 * The server opens `.genie/genie.db` READ-ONLY and only writes to stdout, so the
 * probe never mutates disk. Callers still hand it an isolated throwaway `cwd`
 * that is not a project: the fail-closed server returns a typed "no project
 * context" wish_status there rather than fabricating an empty board (never
 * creating -wal/-shm siblings in real home/state trees), and this probe treats
 * that typed refusal as read-only-healthy. runtime-integrations proves the
 * zero-mutation guarantee with a digest-around-session test.
 */

export const MCP_HEALTH_PROTOCOL_VERSION = '2024-11-05';
export const DEFAULT_HEALTH_SESSION_TIMEOUT_MS = 10_000;

/**
 * The fail-closed project-context error kinds the read-only `genie mcp` server
 * returns (structuredContent `{ error, detail }`, `isError: true`) instead of a
 * fabricated empty board when the cwd is not a resolvable project. Source of
 * truth: `ProjectContextKind` in `src/lib/v5/genie-db.ts`. The health probe runs
 * in a throwaway non-project cwd, so one of these is the EXPECTED wish_status
 * outcome and proves the read-only path works — it is not a failure.
 */
const NO_PROJECT_CONTEXT_ERROR_KINDS = new Set<string>([
  'project-context-unavailable',
  'project-database-unavailable',
  'unsupported-project-layout',
]);

/** The five read-only Genie tools every healthy plugin launcher must expose. */
export const REQUIRED_GENIE_MCP_TOOLS = [
  'genie_board',
  'genie_wish_status',
  'genie_worktree_context',
  'genie_task',
  'genie_active',
] as const;

export interface McpSessionSpawnRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Full newline-delimited request stream; the child exits when it is consumed. */
  stdin: string;
}

export interface McpSessionSpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type McpSessionSpawn = (request: McpSessionSpawnRequest) => McpSessionSpawnResult;

export interface BoundedCodexMcpSessionOptions {
  /** Physical plugin-local launcher: `<activePluginRoot>/scripts/mcp-launcher.cjs`. */
  launcherPath: string;
  /** Isolated throwaway working directory (side-effect containment). */
  cwd: string;
  /** Node command that runs the `.cjs` launcher; the plugin manifest declares `node`. */
  nodePath?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  requiredTools?: readonly string[];
  /** Deterministic test seam; production spawns the launcher through `Bun.spawnSync`. */
  spawn?: McpSessionSpawn;
}

export interface McpSessionResult {
  ok: boolean;
  detail: string;
  tools?: readonly string[];
  wishStatusReadOnly?: boolean;
}

interface JsonRpcReply {
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string };
}

function defaultSessionSpawn(request: McpSessionSpawnRequest): McpSessionSpawnResult {
  const spawned = Bun.spawnSync([request.command, ...request.args], {
    cwd: request.cwd,
    env: request.env,
    stdin: Buffer.from(request.stdin, 'utf8'),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: request.timeoutMs,
  });
  return {
    exitCode: spawned.exitCode,
    stdout: spawned.stdout.toString(),
    stderr: spawned.stderr.toString(),
    timedOut: spawned.exitedDueToTimeout === true,
  };
}

function buildRequestStream(): string {
  const requests = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_HEALTH_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'genie-plugin-health', version: '1' },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'genie_wish_status', arguments: {} } },
  ];
  return `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`;
}

function indexRepliesById(stdout: string): Map<number | string, JsonRpcReply> {
  const byId = new Map<number | string, JsonRpcReply>();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let reply: JsonRpcReply;
    try {
      reply = JSON.parse(trimmed) as JsonRpcReply;
    } catch {
      continue; // ignore any non-JSON framing noise the launcher may interleave
    }
    if (reply && typeof reply === 'object' && (typeof reply.id === 'number' || typeof reply.id === 'string')) {
      byId.set(reply.id, reply);
    }
  }
  return byId;
}

function replyError(reply: JsonRpcReply | undefined, label: string): string | null {
  if (reply === undefined) return `${label} response was missing from the bounded MCP session`;
  if (reply.error) return `${label} returned a JSON-RPC error: ${reply.error.message ?? reply.error.code ?? 'unknown'}`;
  if (reply.result === undefined || reply.result === null || typeof reply.result !== 'object') {
    return `${label} returned no structured result`;
  }
  return null;
}

/**
 * A read-only wish_status is healthy when it either returns a non-error board
 * (`isError === false`) OR a well-formed fail-closed "no project context" typed
 * error. The health probe deliberately runs in a throwaway non-project cwd where
 * the latter is expected: the server correctly refuses to serve an empty board
 * without mutating disk. Any other `isError: true` (an unrecognized/real tool
 * failure) is still rejected.
 */
function wishStatusIsReadOnlyHealthy(result: { isError?: unknown; structuredContent?: unknown }): boolean {
  if (result.isError === false) return true;
  if (result.isError !== true) return false;
  const structured = result.structuredContent;
  const kind = structured && typeof structured === 'object' ? (structured as { error?: unknown }).error : undefined;
  return typeof kind === 'string' && NO_PROJECT_CONTEXT_ERROR_KINDS.has(kind);
}

function listedToolNames(reply: JsonRpcReply): string[] {
  const result = reply.result as { tools?: unknown };
  if (!Array.isArray(result.tools)) return [];
  const names: string[] = [];
  for (const tool of result.tools) {
    if (tool && typeof tool === 'object' && typeof (tool as { name?: unknown }).name === 'string') {
      names.push((tool as { name: string }).name);
    }
  }
  return names;
}

/**
 * Drive `initialize` → `tools/list` → read-only `genie_wish_status` through the
 * plugin launcher and reject on any timeout, protocol error, missing tool, or a
 * `wish_status` that errors or is not read-only.
 */
export function runBoundedCodexMcpSession(options: BoundedCodexMcpSessionOptions): McpSessionResult {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HEALTH_SESSION_TIMEOUT_MS;
  const requiredTools = options.requiredTools ?? REQUIRED_GENIE_MCP_TOOLS;
  const spawn = options.spawn ?? defaultSessionSpawn;

  let spawned: McpSessionSpawnResult;
  try {
    spawned = spawn({
      command: options.nodePath ?? 'node',
      args: [options.launcherPath],
      cwd: options.cwd,
      env: options.env,
      timeoutMs,
      stdin: buildRequestStream(),
    });
  } catch (error) {
    return {
      ok: false,
      detail: `bounded MCP session failed to start: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (spawned.timedOut) {
    return { ok: false, detail: `bounded MCP session timed out after ${timeoutMs}ms` };
  }

  const byId = indexRepliesById(spawned.stdout);

  const initError = replyError(byId.get(1), 'initialize');
  if (initError !== null) {
    return { ok: false, detail: `${initError}${spawned.stderr ? `; launcher stderr: ${spawned.stderr.trim()}` : ''}` };
  }

  const listReply = byId.get(2);
  const listError = replyError(listReply, 'tools/list');
  if (listError !== null) return { ok: false, detail: listError };
  const tools = listedToolNames(listReply as JsonRpcReply);
  const missing = requiredTools.filter((name) => !tools.includes(name));
  if (missing.length > 0) {
    return { ok: false, detail: `bounded MCP session missing required Genie tools: ${missing.join(', ')}` };
  }

  const callReply = byId.get(3);
  const callError = replyError(callReply, 'genie_wish_status');
  if (callError !== null) return { ok: false, detail: callError };
  const callResult = (callReply as JsonRpcReply).result as { isError?: unknown; structuredContent?: unknown };
  if (!wishStatusIsReadOnlyHealthy(callResult)) {
    return { ok: false, detail: 'read-only genie_wish_status did not return a non-error result' };
  }

  return {
    ok: true,
    detail: 'bounded MCP session completed initialize, tools/list, and read-only wish_status',
    tools,
    wishStatusReadOnly: true,
  };
}
