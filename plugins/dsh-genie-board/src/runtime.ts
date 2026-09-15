import type { IncomingMessage, ServerResponse } from 'node:http';
import { type ManagerConfig, SOCKET_MARGIN_MS, socketDeadlineOf } from './config';
import type { Budget } from './process';
import type { Registry } from './service';

/**
 * The one trust fence, owned by the manager row and handed to the sub-rows as
 * a cordis service.
 *
 * Three copies of a fence drift. The first sub-row that forgets Origin-on-POST
 * reopens CSRF against a loopback service that can spawn the Genie binary, so
 * `route()` below is the ONLY way a Genie route reaches DSH's web server, and a
 * sub-row that cannot resolve this service registers nothing at all rather
 * than resolving an executable of its own.
 */

export interface HostContext {
  workspaceRegistry: Registry;
  connection: { requestRejection(req: IncomingMessage): 401 | 403 | undefined };
  webServer: {
    register(route: {
      kind: 'exact';
      path: string;
      handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
    }): () => void;
  };
  effect(effect: () => () => void, label?: string): void;
  provide(name: string, value?: unknown): () => void;
  get(name: string): unknown;
}

/** The sub-rows this package ships, in panel order. */
export const SUB_ROWS = ['board', 'skills', 'workflows'] as const;
export type SubRow = (typeof SUB_ROWS)[number];

export interface GenieRuntime {
  /** The single executable this Host will run, resolved once at manager assembly. */
  readonly executable: string;
  /** Its reported version, empty when it could not be run. */
  readonly version: string;
  /** The compatibility verdict; `false` withholds every mutating route. */
  readonly compatible: boolean;
  /** Why the verdict is `false`, empty when it is `true`. */
  readonly error: string;
  readonly config: ManagerConfig;
  readonly registry: Registry;
  /** A fresh shared deadline/output budget for one browser request. */
  budget(): Budget;
  /** Register one route behind the whole fence. Returns its disposer. */
  route(path: string, method: string, handler: (req: IncomingMessage) => unknown, mutation?: boolean): () => void;
  /** The `workspaceId` query parameter of a catalog request, vetted. */
  workspaceOf(req: IncomingMessage): string;
  /** Record that a sub-row registered; the disposer un-records it. */
  mount(row: SubRow, config: Record<string, unknown>): () => void;
  /** Which sub-rows are registered right now — what the browser gates its panels on. */
  mounted(): Record<SubRow, boolean>;
  /** The resolved config of each mounted sub-row. */
  rows(): Partial<Record<SubRow, Record<string, unknown>>>;
}

/**
 * Validate a required host service once, at assembly, with a named error.
 * A missing service must fail loudly here instead of surfacing later as a
 * silent 503 from a route nobody registered.
 */
export function requireService<T>(ctx: HostContext, key: keyof HostContext & string, method: string): T {
  const service = ctx[key] as unknown;
  if (
    service === null ||
    typeof service !== 'object' ||
    typeof (service as Record<string, unknown>)[method] !== 'function'
  )
    throw new Error(`@automagik/genie-dsh-board requires the host service "${key}.${method}"`);
  return service as T;
}

/** Resolve the manager service from a sub-row's context, or explain its absence. */
export function requireRuntime(ctx: Pick<HostContext, 'get'>): GenieRuntime {
  const runtime = ctx.get('genieRuntime') as GenieRuntime | undefined;
  if (!runtime || typeof runtime.route !== 'function')
    throw new Error('@automagik/genie-dsh-board sub-rows require the "genieRuntime" service from the manager row');
  return runtime;
}

export function trusted(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '')) return false;
  const host = req.headers.host;
  if (!host || !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) return false;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${host}`) return false;
  if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') return false;
  // A mutation still demands an exact Origin. A read does not: a same-origin
  // `fetch` sends no Origin at all, and older Safari/Firefox and embedded
  // WebViews send no Sec-Fetch-Site either, so requiring one of them here
  // would be a stricter floor than DSH's own fence applies (P1).
  return req.method !== 'POST' || origin === `http://${host}`;
}

export async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const data of req) {
    const chunk = Buffer.from(data);
    size += chunk.length;
    if (size > 16_384) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function json(res: ServerResponse, code: number, value: unknown) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(code, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}

/**
 * Answer, then abandon the socket — never the other way round.
 *
 * The deadline is the handler's own timer, not the socket's: once the request
 * body has been consumed Node's `socketOnTimeout` emits nothing (the request is
 * `complete`) and destroys the connection silently, so a handler that waits on
 * a hung Genie child would lose its answer to a dead socket. The socket's idle
 * timer is still armed, strictly later, as a last-resort backstop.
 */
export function armSocketDeadline(req: IncomingMessage, res: ServerResponse, ms: number): void {
  const timer = setTimeout(() => {
    if (!res.headersSent && !res.writableEnded) {
      res.once('finish', () => req.destroy());
      json(res, 504, { error: 'Genie board request timed out' });
      return;
    }
    req.destroy();
  }, ms);
  timer.unref?.();
  res.once('close', () => clearTimeout(timer));
  req.setTimeout(ms + SOCKET_MARGIN_MS);
}

export interface RuntimeVerdict {
  executable: string;
  version: string;
  compatible: boolean;
  error: string;
}

/** Build the manager service over an already-resolved executable verdict. */
export function createRuntime(ctx: HostContext, config: ManagerConfig, verdict: RuntimeVerdict): GenieRuntime {
  const registered = new Map<SubRow, Record<string, unknown>>();
  const socketDeadlineMs = socketDeadlineOf(config);
  return {
    executable: verdict.executable,
    version: verdict.version,
    compatible: verdict.compatible,
    error: verdict.error,
    config,
    registry: ctx.workspaceRegistry,
    budget: () => ({ expires: Date.now() + config.deadlineMs, bytes: 0, limit: config.outputBudgetBytes }),
    // One fence, one error boundary, one shape of answer for every route: a
    // handler that throws must still answer, or the browser hangs (C1).
    route(path, method, handler, mutation = false) {
      return ctx.webServer.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          try {
            if (req.method !== method) return json(res, 405, { error: 'Method not allowed' });
            const rejection = ctx.connection.requestRejection(req);
            if (rejection) return json(res, rejection, { error: 'DSH browser authentication required' });
            if (!trusted(req)) return json(res, 403, { error: 'Same-origin loopback request required' });
            if (mutation) {
              if (req.headers['content-type'] !== 'application/json')
                return json(res, 415, { error: 'application/json required' });
              armSocketDeadline(req, res, socketDeadlineMs);
            }
            json(res, 200, await handler(req));
          } catch (failure) {
            const message = failure instanceof Error ? failure.message : 'Board request failed';
            // A route failure is the plugin's own fault and its message is not
            // a user-facing one, so only the vetted board path reports detail.
            json(res, mutation ? 400 : 500, { error: mutation ? message : 'Genie board route failed' });
          }
        },
      });
    },
    workspaceOf(req) {
      const id = new URL(req.url ?? '/', 'http://localhost').searchParams.get('workspaceId') ?? '';
      if (!id || id.length > 200) throw new Error('workspaceId required');
      return id;
    },
    mount(row, rowConfig) {
      registered.set(row, rowConfig);
      return () => registered.delete(row);
    },
    mounted: () => ({
      board: registered.has('board'),
      skills: registered.has('skills'),
      workflows: registered.has('workflows'),
    }),
    rows: () => Object.fromEntries(registered) as Partial<Record<SubRow, Record<string, unknown>>>,
  };
}
