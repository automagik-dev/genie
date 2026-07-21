// index.ts — composition root. Wires fleet-config -> PtySessionManager -> ws transport,
// and serves the browser client with NO Vite (design deliverable 4).
//
// Serve path (the pinned G1 decision, amended — see README "Runtime split"): ONE
// `http` server both (a) serves the client assets — index.html, styles.css, the
// salvaged xterm CSS, and the client bundle (`dist/main.js`, produced ahead of time
// by `Bun.build` in `build.ts`) — and (b) upgrades to the bare `ws` PTY protocol on
// the SAME port. No second port, no import-map juggling. This process is the PTY host,
// so it runs under **node** (bun's node-pty `onData` never fires — see README); `bun`
// remains the builder (`build.ts` bundles both client and this server into `dist/`).
//
// Deliberately thin: every real concern lives in a single-purpose module beside it.
// No `Bun.*` at runtime — this file must run under plain node.

import { readFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type WebSocket, WebSocketServer } from 'ws';
import { CONFIG_PATH, loadFleet } from './fleet-config';
import { listWishes, wishContext } from './genie-lane';
import { PtySessionManager } from './pty-session';
import { type ClientMsg, MSG, type ServerMsg, type WishContextMsg, type WishRow, decode, encode } from './transport';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
const PORT = Number(process.env.PORT ?? 8787);

// Trust boundary (see README "Trust boundary" decision). MSG.INPUT feeds arbitrary
// keystrokes into live login shells, so the ws upgrade is a remote-control surface.
// Two guards keep it closed by default:
//   1. Bind loopback unless HOST is set — the fleet is a single-operator tool; LAN
//      reach (mac + phone) is opt-in via HOST=0.0.0.0 (or a specific interface).
//   2. Origin allowlist on the ws upgrade — browsers always send Origin, so a
//      same-origin check defeats a cross-origin drive-by (any open website could
//      otherwise `new WebSocket('ws://localhost:PORT')` and type into the shells).
const HOST = process.env.HOST ?? '127.0.0.1';
const ALLOWED_ORIGINS = (process.env.GENIE_UI_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Accept a ws upgrade only from a trusted Origin. Non-browser clients (CLI, tests)
 * send no Origin and are gated by the loopback bind; browsers must be same-origin
 * (the page's own host) or on the explicit GENIE_UI_ALLOWED_ORIGINS allowlist.
 */
export function verifyClient(info: { origin?: string; req: http.IncomingMessage }): boolean {
  const { origin } = info;
  if (!origin) return true;
  const host = info.req.headers.host;
  try {
    if (host && new URL(origin).host === host) return true;
  } catch {
    return false;
  }
  return ALLOWED_ORIGINS.includes(origin);
}

interface Asset {
  type: string;
  body: string;
}

/**
 * Precompute the static asset table once at boot. The client bundle (`main.js`) is
 * produced ahead of time by `build.ts` (Bun.build) and sits next to this file in
 * `dist/`; everything else is read from the source tree. Plain node `fs` only — this
 * process is the PTY host and runs under node, where `Bun.file`/`Bun.build` do not exist.
 */
function loadAssets(): Map<string, Asset> {
  const xtermCss = require.resolve('@xterm/xterm/css/xterm.css');
  const read = (p: string) => readFileSync(p, 'utf8');
  const assets = new Map<string, Asset>();
  assets.set('/', { type: 'text/html; charset=utf-8', body: read(resolve(PKG_ROOT, 'index.html')) });
  assets.set('/client/main.js', { type: 'text/javascript; charset=utf-8', body: read(resolve(HERE, 'main.js')) });
  assets.set('/client/styles.css', {
    type: 'text/css; charset=utf-8',
    body: read(resolve(PKG_ROOT, 'client', 'styles.css')),
  });
  assets.set('/xterm.css', { type: 'text/css; charset=utf-8', body: read(xtermCss) });
  return assets;
}

function serveAsset(assets: Map<string, Asset>, req: http.IncomingMessage, res: http.ServerResponse): void {
  const path = (req.url ?? '/').split('?')[0];
  const asset = assets.get(path);
  if (!asset) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found\n');
    return;
  }
  res.writeHead(200, { 'content-type': asset.type });
  res.end(asset.body);
}

/**
 * The genie lane (G2): the left menu's wishes, read from `.genie/wishes` markdown + the
 * read-only `.genie/genie.db`. Best-effort — a lane failure (no genie state on the box)
 * must never take down the fleet floor, so it degrades to an empty menu.
 */
function loadWishRows(): WishRow[] {
  try {
    return listWishes().map((w) => ({ slug: w.slug, title: w.title, status: w.status }));
  } catch {
    return [];
  }
}

/**
 * Open a wish's worktree-bound context: its group + task state, read READ-ONLY from
 * `.genie/genie.db` (degrade-to-empty when absent). Best-effort — a lane read failure must
 * never take down the fleet floor, so it degrades to an empty context.
 */
function openWishContext(slug: string): WishContextMsg {
  try {
    const ctx = wishContext(slug);
    return {
      slug,
      groups: ctx.groups.map((g) => ({ name: g.name, status: g.status, assignee: g.assignee })),
      taskCount: ctx.tasks.length,
    };
  } catch {
    return { slug, groups: [], taskCount: 0 };
  }
}

/** On attach: send the wish menu + roster, then replay each pane's snapshot from its TerminalMirror. */
async function attachClient(ws: WebSocket, manager: PtySessionManager): Promise<void> {
  const send = (m: ServerMsg) => ws.send(encode(m));
  send({ t: MSG.WISHES, wishes: loadWishRows() });
  send({ t: MSG.FLEET, panes: manager.list() });
  for (const p of manager.list()) {
    const data = await manager.replay(p.id);
    if (data) send({ t: MSG.REPLAY, id: p.id, data });
  }
}

function handleClientMsg(manager: PtySessionManager, m: ClientMsg, ws: WebSocket): void {
  switch (m.t) {
    case MSG.INPUT:
      manager.write(m.id, m.data);
      break;
    case MSG.RESIZE:
      manager.resize(m.id, m.cols, m.rows);
      break;
    case MSG.SPAWN:
      manager.spawn(m.id);
      break;
    case MSG.KILL:
      manager.kill(m.id);
      break;
    case MSG.RESTART:
      manager.restart(m.id);
      break;
    case MSG.LIST:
      ws.send(encode({ t: MSG.FLEET, panes: manager.list() }));
      break;
    case MSG.WISH_OPEN:
      ws.send(encode({ t: MSG.WISH_CONTEXT, context: openWishContext(m.slug) }));
      break;
  }
}

async function main(): Promise<void> {
  const fleet = loadFleet();
  const manager = new PtySessionManager(fleet);
  manager.startAll();

  console.log(`[genie-ui] fleet loaded from ${CONFIG_PATH}`);
  for (const p of manager.list()) {
    console.log(`  - ${p.id.padEnd(16)} ${p.command} ${p.args.join(' ')}`);
  }

  const assets = loadAssets();
  const server = http.createServer((req, res) => serveAsset(assets, req, res));
  const wss = new WebSocketServer({ server, verifyClient });
  const clients = new Set<WebSocket>();

  const broadcast = (m: ServerMsg) => {
    const raw = encode(m);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(raw);
    }
  };

  // Fan manager events out to every connected browser; a single broadcast keeps
  // every tab (and every device) rendering the whole fleet in sync.
  manager.on('data', (id: string, data: string) => broadcast({ t: MSG.DATA, id, data }));
  manager.on('exit', (id: string, code: number) => broadcast({ t: MSG.EXIT, id, code }));
  manager.on('status', (id: string, status) => broadcast({ t: MSG.STATUS, id, status }));

  wss.on('connection', (ws) => {
    clients.add(ws);
    void attachClient(ws, manager);
    ws.on('message', (raw: Buffer) => {
      const m = decode(raw.toString());
      if (m?.t) handleClientMsg(manager, m, ws);
    });
    ws.on('close', () => clients.delete(ws));
  });

  server.listen(PORT, HOST, () => {
    const reach = HOST === '127.0.0.1' || HOST === 'localhost' ? 'loopback only' : `bound ${HOST} (LAN)`;
    console.log(`[genie-ui] serving client + ws on http://localhost:${PORT} — ${reach}`);
  });

  const shutdown = () => {
    console.log('\n[genie-ui] shutting down, killing sessions...');
    manager.killAll();
    manager.disposeAll();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('[genie-ui] fatal:', err);
    process.exit(1);
  });
}
