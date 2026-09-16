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
  /**
   * cordis' deferred-dependency shorthand for `ctx.plugin({ inject, apply })`:
   * the callback runs in a CHILD fiber once every named service exists, and is
   * disposed again when one goes away. Optional on the interface because the
   * row must still mount on a host that does not expose it.
   */
  inject?(deps: string[], callback: (scope: HostContext) => void): unknown;
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

/** The manager service if this Host has one, `undefined` when the manager row is off. */
function optionalRuntime(ctx: Pick<HostContext, 'get'>): GenieRuntime | undefined {
  const runtime = ctx.get('genieRuntime') as GenieRuntime | undefined;
  return runtime && typeof runtime.route === 'function' ? runtime : undefined;
}

/**
 * Mount a sub-row's surface once `genieRuntime` exists — and never abort a boot
 * because it does not.
 *
 * A row-level `export const inject = ['genieRuntime']` is a HARD dependency:
 * cordis parks the row's own fiber in PENDING while the service is absent, and
 * DSH's boot audit turns every pending enabled loader entry into a fatal
 * `N entries did not activate`. So disabling ONLY the manager row by its id in
 * a profile patch — `- id: genie-dsh-board` / `disabled: true`, a supported DSH
 * gesture — killed the whole Host with three
 * `pending (waiting for service: genieRuntime)` lines instead of simply
 * dropping the Genie panels.
 *
 * `ctx.inject(deps, callback)` is the cordis idiom for the optional form. The
 * row itself activates immediately; the callback runs in a child fiber if and
 * when the manager provides the service, and that child is not a loader entry,
 * so it is invisible to the boot audit. With the manager off, each sub-row
 * registers nothing, `/api/genie-board/health` is absent along with every other
 * Genie route, and DSH boots.
 */
export function whenRuntime(ctx: HostContext, mount: (runtime: GenieRuntime, scope: HostContext) => void): void {
  const defer = ctx.inject;
  if (typeof defer !== 'function') {
    const runtime = optionalRuntime(ctx);
    if (runtime) mount(runtime, ctx);
    return;
  }
  defer.call(ctx, ['genieRuntime'], (scope) => {
    const runtime = optionalRuntime(scope);
    if (runtime) mount(runtime, scope);
  });
}

/**
 * Mark a failure as the CALLER's fault, with a message vetted for display.
 *
 * Without this tag a read route can only answer an opaque 500, so an invalid
 * name, an unknown document and an unknown workspace all arrive at the browser
 * as the same "Genie board route failed" a genuine server fault produces, and
 * neither the panel nor an operator can tell them apart (Z5). The tag is a
 * plain property rather than an Error subclass on purpose: the manager row's
 * `route()` catches failures thrown inside a SUB-ROW's own bundle, and
 * `instanceof` does not survive that boundary.
 */
export function clientError(message: string, status = 400): Error {
  return Object.assign(new Error(message), { clientStatus: status });
}

/** The 4xx status a failure carries, or `undefined` when it is not a caller's fault. */
export function clientStatusOf(failure: unknown): number | undefined {
  if (typeof failure !== 'object' || failure === null) return undefined;
  const status = (failure as { clientStatus?: unknown }).clientStatus;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 499) return undefined;
  return status;
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
            // A tagged failure is the caller's, and its message is a vetted
            // constant, so it is reported verbatim with its own 4xx on every
            // route, read ones included.
            const status = clientStatusOf(failure);
            if (status !== undefined) return json(res, status, { error: message });
            // Anything else is the plugin's own fault and its message is not a
            // user-facing one, so only the vetted board path reports detail.
            json(res, mutation ? 400 : 500, { error: mutation ? message : 'Genie board route failed' });
          }
        },
      });
    },
    workspaceOf(req) {
      const id = new URL(req.url ?? '/', 'http://localhost').searchParams.get('workspaceId') ?? '';
      if (!id || id.length > 200) throw clientError('workspaceId required');
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
