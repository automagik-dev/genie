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
export function trusted(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '')) return false;
  const host = req.headers.host;
  if (!host || !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) return false;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${host}`) return false;
  if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') return false;
  return req.method === 'POST'
    ? origin === `http://${host}`
    : origin === `http://${host}` || req.headers['sec-fetch-site'] === 'same-origin';
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
  res.writeHead(code, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}
export async function apply(ctx: Context): Promise<void> {
  let service: BoardService | undefined;
  let version = '';
  let error = '';
  try {
    const binary = resolveExecutable();
    version = (
      await execute(binary, ['--version'], process.cwd(), hostEnvironment('dsh-host'), {
        expires: Date.now() + DEADLINE_MS,
        bytes: 0,
      })
    ).trim();
    if (!compatible(version, minimumGenieVersion)) throw new Error(`Genie ${minimumGenieVersion} or newer is required`);
    service = new BoardService(ctx.workspaceRegistry, binary);
  } catch (failure) {
    error = failure instanceof Error ? failure.message : 'Genie unavailable';
  }
  ctx.effect(() => {
    const disposers: (() => void)[] = [];
    const route = (path: string, method: string, handler: () => unknown) => {
      disposers.push(
        ctx.webServer.register({
          kind: 'exact',
          path,
          handler: async (req, res) => {
            if (req.method !== method) return json(res, 405, { error: 'Method not allowed' });
            const rejection = ctx.connection.requestRejection(req);
            if (rejection) return json(res, rejection, { error: 'DSH browser authentication required' });
            if (!trusted(req)) return json(res, 403, { error: 'Same-origin loopback request required' });
            json(res, 200, handler());
          },
        }),
      );
    };
    route('/api/genie-board/health', 'GET', () => ({ compatible: !!service, version, minimumGenieVersion, error }));
    if (service) {
      route('/api/genie-board/workspaces', 'GET', () => service?.workspaces());
      disposers.push(
        ctx.webServer.register({
          kind: 'exact',
          path: '/api/genie-board/action',
          handler: async (req, res) => {
            if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
            const rejection = ctx.connection.requestRejection(req);
            if (rejection) return json(res, rejection, { error: 'DSH browser authentication required' });
            if (!trusted(req)) return json(res, 403, { error: 'Same-origin loopback request required' });
            if (req.headers['content-type'] !== 'application/json')
              return json(res, 415, { error: 'application/json required' });
            req.setTimeout(DEADLINE_MS, () => req.destroy());
            try {
              json(res, 200, await service?.request(await body(req)));
            } catch (failure) {
              json(res, 400, { error: failure instanceof Error ? failure.message : 'Board request failed' });
            }
          },
        }),
      );
    }
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, 'Genie board routes');
}
