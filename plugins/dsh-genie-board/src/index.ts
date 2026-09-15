import type { IncomingMessage, ServerResponse } from 'node:http';
import sourcePackage from '../../../package.json';
declare const __GENIE_BUILD_VERSION__: string;
import { DEADLINE_MS, compatible, execute, hostEnvironment, resolveExecutable } from './process';
import { BoardService, type Registry } from './service';

interface Context {
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
}
export const inject = ['workspaceRegistry', 'webServer', 'connection'];
export const minimumGenieVersion =
  typeof __GENIE_BUILD_VERSION__ === 'undefined' ? sourcePackage.version : __GENIE_BUILD_VERSION__;
/**
 * The socket idle deadline MUST outlive the Genie budget the handler itself
 * enforces. Armed at or below it, Node's socket timer destroys the connection
 * before the handler can answer, so the deadline 400 is written to a dead
 * socket and the browser sees a network error instead of the message (F6).
 */
export const SOCKET_MARGIN_MS = 5_000;
export const SOCKET_DEADLINE_MS = DEADLINE_MS + SOCKET_MARGIN_MS;
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
async function body(req: IncomingMessage): Promise<unknown> {
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
function json(res: ServerResponse, code: number, value: unknown) {
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
export async function apply(ctx: Context): Promise<void> {
  let service: BoardService | undefined;
  let version = '';
  let executable = '';
  let error = '';
  try {
    executable = resolveExecutable();
    version = (
      await execute(executable, ['--version'], process.cwd(), hostEnvironment('dsh-host'), {
        expires: Date.now() + DEADLINE_MS,
        bytes: 0,
      })
    ).trim();
    if (!compatible(version, minimumGenieVersion)) throw new Error(`Genie ${minimumGenieVersion} or newer is required`);
    service = new BoardService(ctx.workspaceRegistry, executable);
  } catch (failure) {
    error = failure instanceof Error ? failure.message : 'Genie unavailable';
  }
  ctx.effect(() => {
    const disposers: (() => void)[] = [];
    // One fence, one error boundary, one shape of answer for every route: a
    // handler that throws must still answer, or the browser hangs (C1).
    const route = (path: string, method: string, handler: (req: IncomingMessage) => unknown, mutation = false) => {
      disposers.push(
        ctx.webServer.register({
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
                armSocketDeadline(req, res, SOCKET_DEADLINE_MS);
              }
              json(res, 200, await handler(req));
            } catch (failure) {
              const message = failure instanceof Error ? failure.message : 'Board request failed';
              // A route failure is the plugin's own fault and its message is not
              // a user-facing one, so only the vetted board path reports detail.
              json(res, mutation ? 400 : 500, { error: mutation ? message : 'Genie board route failed' });
            }
          },
        }),
      );
    };
    route('/api/genie-board/health', 'GET', () => ({
      compatible: !!service,
      version,
      executable,
      minimumGenieVersion,
      error,
    }));
    if (service) {
      const board = service;
      route('/api/genie-board/workspaces', 'GET', () => board.workspaces());
      route('/api/genie-board/action', 'POST', async (req) => board.request(await body(req)), true);
    }
    return () => {
      for (const dispose of disposers) dispose();
      service?.dispose();
    };
  }, 'Genie board routes');
}
