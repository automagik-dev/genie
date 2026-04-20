/**
 * Executor Read Endpoint — read-only HTTP surface over `executors` state.
 *
 * Cross-repo contract: omni scope-enforcer (and other external consumers) call
 *   GET /executors/:id/state
 * to obtain ground-truth turn state before authorizing a request. The response
 * shape `{state, outcome, closed_at}` is the stable boundary surface; adding
 * fields is backwards-compatible, removing/renaming is a breaking change that
 * must be coordinated with the omni wish (see `turn-session-contract` WISH.md).
 *
 * Authz: none. Executor IDs are random UUIDs; the endpoint exposes no secrets.
 * Alternate path: a readonly PG role `executors_reader` (migration 043) can be
 * used by consumers that prefer direct SQL over HTTP.
 */

import { type Sql, getActivePort, getConnection } from './db.js';
import type { ExecutorState, TurnOutcome } from './executor-types.js';

interface ExecutorStateReply {
  state: ExecutorState;
  outcome: TurnOutcome | null;
  closed_at: string | null;
}

/**
 * Read the state triple for an executor. Returns `null` when the ID is unknown.
 * Single indexed SELECT on the executors primary key — p99 well below 10ms.
 */
export async function readExecutorState(id: string, sql?: Sql): Promise<ExecutorStateReply | null> {
  const conn = sql ?? (await getConnection());
  const rows = await conn<
    { state: ExecutorState; outcome: TurnOutcome | null; closed_at: Date | string | null }[]
  >`SELECT state, outcome, closed_at FROM executors WHERE id = ${id} LIMIT 1`;
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    state: row.state,
    outcome: row.outcome ?? null,
    closed_at:
      row.closed_at == null ? null : row.closed_at instanceof Date ? row.closed_at.toISOString() : row.closed_at,
  };
}

let server: ReturnType<typeof Bun.serve> | null = null;

/**
 * Port for the executor read endpoint.
 *
 * Defaults to `getActivePort() + 2` so it sits beside pgserve (+0) and the OTel
 * receiver (+1) without colliding. Override via `GENIE_EXECUTOR_READ_PORT`.
 */
export function getExecutorReadPort(): number {
  const envPort = process.env.GENIE_EXECUTOR_READ_PORT;
  if (envPort) {
    const parsed = Number.parseInt(envPort, 10);
    if (!Number.isNaN(parsed) && parsed > 0 && parsed < 65536) return parsed;
  }
  return getActivePort() + 2;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROUTE_RE = /^\/executors\/([^/]+)\/state\/?$/;

async function handleStateRoute(id: string): Promise<Response> {
  if (!UUID_RE.test(id)) {
    return Response.json({ error: 'invalid executor id' }, { status: 400 });
  }
  try {
    const reply = await readExecutorState(id);
    if (!reply) return Response.json({ error: 'not found' }, { status: 404 });
    return Response.json(reply, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 500 });
  }
}

async function routeRequest(req: Request, port: number): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === 'GET' && url.pathname === '/health') {
    return Response.json({ status: 'ok', port });
  }
  if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
  const match = ROUTE_RE.exec(url.pathname);
  if (!match) return new Response('Not Found', { status: 404 });
  return handleStateRoute(match[1]);
}

/**
 * Start the executor read HTTP server. Idempotent — subsequent calls are no-ops
 * while the server is already running. Returns `true` on success (including
 * idempotent re-calls), `false` when the port was busy or another error was
 * logged. Non-fatal: genie serve keeps running either way.
 */
export async function startExecutorReadEndpoint(): Promise<boolean> {
  if (server) return true;
  const port = getExecutorReadPort();
  try {
    server = Bun.serve({
      port,
      hostname: '127.0.0.1',
      fetch: (req) => routeRequest(req, port),
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('EADDRINUSE') || message.includes('address already in use')) {
      console.warn(`Executor read endpoint: port ${port} already in use — skipping`);
    } else {
      console.warn(`Executor read endpoint: failed to start on port ${port}: ${message}`);
    }
    return false;
  }
}

/** Stop the endpoint. Awaits full socket release so tests can restart on the same port. */
export async function stopExecutorReadEndpoint(): Promise<void> {
  if (server) {
    await server.stop(true);
    server = null;
  }
}

/** Whether the endpoint is currently running. */
export function isExecutorReadEndpointRunning(): boolean {
  return server !== null;
}
