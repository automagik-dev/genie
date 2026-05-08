/**
 * Hook Socket — daemon-side UDS listener for genie hook dispatch.
 *
 * Owned by `genie serve --headless`. Replaces the fork-per-event
 * `genie hook dispatch` execution model with a long-lived listener:
 *
 *   client (genie-hook binary or bun fallback)
 *     ─[length-prefixed JSON]─►  ~/.genie/hook.sock
 *                                   │
 *                                   ├─ reuses src/hooks/index.ts dispatch()
 *                                   ├─ handler caches retain state across events
 *                                   ├─ shared postgres.js pool (no per-event conn churn)
 *                                   └─ length-prefixed JSON reply
 *
 * Wire protocol (both directions):
 *   ┌────────────┬────────────────────────┐
 *   │ 4 bytes BE │  N bytes UTF-8 JSON    │
 *   │ length=N   │                        │
 *   └────────────┴────────────────────────┘
 *
 * A reply with N=0 means "empty response" (allow with no decision payload),
 * matching the contract dispatch() returns from in-process today.
 *
 * Concurrency: each connection is a single request/response pair. Server
 * accepts multiple concurrent clients; dispatch() is async-safe (each call
 * runs through Promise chains, not shared mutable state, except the handler
 * caches which are intentionally process-local).
 */

import { existsSync, unlinkSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { type Server, type Socket, createServer, connect as netConnect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { dispatch } from '../hooks/index.js';
import { type LoadStatus, loadExternalHooks } from '../hooks/loader.js';

export interface HookSocketHandle {
  /** Absolute path to the UDS file. */
  path: string;
  /** Stop the server and unlink the socket file. Idempotent. */
  stop: () => Promise<void>;
  /** Per-file outcome from the boot-time loader scan. Empty when no external hooks are present. */
  loaderOutcomes: ReadonlyArray<LoadStatus>;
}

/**
 * Options accepted by `startHookSocket()`. The defaults preserve the pre-loader
 * behavior — no external hooks discovered, no strict mode — so existing callers
 * that don't pass options keep working unchanged.
 */
export interface StartHookSocketOptions {
  /**
   * Run the boot-scan loader against the three S3 tiers before listening.
   * Defaults to `true` so daemons pick up trusted external hooks at startup.
   * Set `false` in tests / one-shot scripts that don't want side-effects from
   * the host's `~/.genie/hooks/` or `~/.claude/teams/<team>/hooks/` directories.
   */
  loadExternal?: boolean;
  /**
   * Repository root for the per-repo tier scan (`<repoRoot>/.genie/hooks/*.ts`).
   * When omitted, the per-repo tier is skipped — team and global tiers still
   * scanned. Pass the cwd of the running daemon.
   */
  repoRoot?: string;
  /**
   * Refuse to start when the loader finds two external hooks with the same
   * `name` (any tier). Wired up to the `genie serve --strict-hooks` CLI flag.
   */
  strict?: boolean;
}

/** 1 MB cap on a single hook payload. CC payloads are normally a few KB. */
const MAX_FRAME_BYTES = 1_048_576;

/** Default UDS path: `~/.genie/hook.sock` (overridable via GENIE_HOOK_SOCK). */
export function defaultHookSocketPath(): string {
  if (process.env.GENIE_HOOK_SOCK) return process.env.GENIE_HOOK_SOCK;
  const home = process.env.GENIE_HOME ?? join(homedir(), '.genie');
  return join(home, 'hook.sock');
}

/**
 * Detect a stale socket file: a path exists but no listener is attached to it.
 * Probe with a short connect attempt; if it fails fast we treat the file as a
 * leftover from an unclean shutdown and unlink it. If something IS listening,
 * we refuse to start (caller should fail loudly — two daemons would race).
 */
async function detectStaleAndCleanup(socketPath: string): Promise<'clean' | 'stale-removed' | 'live'> {
  if (!existsSync(socketPath)) return 'clean';

  // Try a 200ms connect probe.
  const live = await new Promise<boolean>((resolve) => {
    const probe: Socket = netConnect(socketPath);
    const finish = (alive: boolean): void => {
      try {
        probe.destroy();
      } catch {
        // already dead
      }
      resolve(alive);
    };
    probe.once('connect', () => finish(true));
    probe.once('error', () => finish(false));
    setTimeout(() => finish(false), 200).unref();
  });

  if (live) return 'live';

  // No one's listening — safe to unlink.
  try {
    unlinkSync(socketPath);
    return 'stale-removed';
  } catch (err) {
    throw new Error(`Failed to remove stale hook socket at ${socketPath}: ${(err as Error).message}`);
  }
}

type ParseResult =
  | { kind: 'incomplete'; length: number }
  | { kind: 'done'; body: Buffer }
  | { kind: 'error'; reason: string };

/** Pure frame-parser: given the accumulator and prior known length, decide. */
function parseFrame(acc: Buffer, length: number): ParseResult {
  if (length === -1) {
    if (acc.length < 4) return { kind: 'incomplete', length: -1 };
    const declared = acc.readUInt32BE(0);
    if (declared > MAX_FRAME_BYTES) {
      return { kind: 'error', reason: `frame length ${declared} exceeds MAX_FRAME_BYTES` };
    }
    if (declared === 0) return { kind: 'done', body: Buffer.alloc(0) };
    if (acc.length >= 4 + declared) return { kind: 'done', body: acc.subarray(4, 4 + declared) };
    return { kind: 'incomplete', length: declared };
  }
  if (acc.length >= 4 + length) return { kind: 'done', body: acc.subarray(4, 4 + length) };
  return { kind: 'incomplete', length };
}

/**
 * Read one length-prefixed frame from a socket. Resolves with the body buffer
 * (which may be empty for a 0-length frame) or rejects on protocol violation
 * or premature close.
 *
 * Uses a single accumulator so we don't have to worry about unshift-then-
 * relisten edge cases; one connection delivers exactly one frame in our
 * protocol so we can keep state simple.
 */
function readOneFrame(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let acc = Buffer.alloc(0);
    let length = -1;

    const cleanup = (): void => {
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onError);
    };

    const onData = (chunk: Buffer): void => {
      acc = acc.length === 0 ? Buffer.from(chunk) : Buffer.concat([acc, Buffer.from(chunk)], acc.length + chunk.length);
      const result = parseFrame(acc, length);
      if (result.kind === 'incomplete') {
        length = result.length;
        return;
      }
      cleanup();
      if (result.kind === 'done') resolve(result.body);
      else reject(new Error(result.reason));
    };
    const onEnd = (): void => {
      cleanup();
      reject(new Error(`socket closed after ${acc.length} bytes (expected ${length === -1 ? '4+' : 4 + length})`));
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };

    socket.on('data', onData);
    socket.on('end', onEnd);
    socket.on('error', onError);
  });
}

/** Send a length-prefixed JSON payload (or an empty 0-length frame). */
function writeFrame(socket: Socket, payload: string): void {
  const body = Buffer.from(payload, 'utf-8');
  if (body.length > MAX_FRAME_BYTES) {
    // Refuse to send oversized — caller treats as empty (allow).
    const empty = Buffer.alloc(4);
    socket.end(empty);
    return;
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  socket.end(Buffer.concat([header, body]));
}

/** Handle one client connection: read a frame, dispatch, write the reply. */
async function handleConnection(socket: Socket): Promise<void> {
  socket.setNoDelay(true);
  try {
    const body = await readOneFrame(socket);
    const stdin = body.length === 0 ? '' : body.toString('utf-8');
    const reply = await dispatch(stdin);
    writeFrame(socket, reply ?? '');
  } catch (err) {
    // Best effort: try to send empty so client unblocks; never throw out of here.
    try {
      writeFrame(socket, '');
    } catch {
      // socket already dead
    }
    if (process.env.GENIE_HOOK_SOCK_DEBUG === '1') {
      console.warn(`[hook-socket] connection error: ${(err as Error).message}`);
    }
  }
}

/**
 * Start the hook socket listener. Returns a handle with the path and a stop fn.
 * Throws if a live listener is already on the path (refusing to race).
 */
export async function startHookSocket(options: StartHookSocketOptions = {}): Promise<HookSocketHandle> {
  // Group 4 of hookify-perf-foundation: turn on the wide-emit flag for the
  // hook subsystem by default in daemon mode so per-handler timing spans land
  // in `genie_runtime_events` and feed the `hook_perf_baseline` view. If the
  // operator has set GENIE_WIDE_EMIT explicitly we honor their value.
  if (process.env.GENIE_WIDE_EMIT === undefined) {
    process.env.GENIE_WIDE_EMIT = '1';
  }

  // Group 1 of hookify-third-party-absorption (D5): boot-scan the three S3
  // tiers BEFORE the server listens so the registry is single-writer at boot.
  // Loader outcomes are surfaced through the returned handle for `genie doctor
  // --hooks` (Group 2) and the daemon stdout summary below.
  //
  // The loader is fail-soft on external hooks: untrusted / broken / shadowed
  // files are recorded in outcomes but the daemon ALWAYS starts. The only
  // failure mode that aborts boot is `strict: true` + a same-name collision,
  // wired up to `genie serve --strict-hooks`.
  let loaderOutcomes: LoadStatus[] = [];
  if (options.loadExternal !== false) {
    loaderOutcomes = await loadExternalHooks({
      repoRoot: options.repoRoot,
      strict: options.strict,
    });
    summarizeLoaderOutcomes(loaderOutcomes);
  }

  const socketPath = defaultHookSocketPath();
  await mkdir(dirname(socketPath), { recursive: true });

  const state = await detectStaleAndCleanup(socketPath);
  if (state === 'live') {
    throw new Error(
      `hook socket at ${socketPath} is already live — another genie serve daemon is running. Refusing to start.`,
    );
  }
  if (state === 'stale-removed') {
    console.log(`hook-socket: removed stale socket at ${socketPath}`);
  }

  const liveSockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    liveSockets.add(socket);
    socket.once('close', () => liveSockets.delete(socket));
    void handleConnection(socket);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });

  console.log(`hook-socket: listening at ${socketPath}`);

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    // Force-destroy any live connections so server.close() doesn't hang.
    for (const sock of liveSockets) {
      try {
        sock.destroy();
      } catch {
        // already dead
      }
    }
    liveSockets.clear();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        // best effort
      }
    }
  };

  return { path: socketPath, stop, loaderOutcomes };
}

/**
 * Print a one-line summary of loader outcomes to stdout so `genie serve` logs
 * make it obvious whether external hooks are participating. Detailed per-file
 * status is available via `genie hook list` (Group 2 surface).
 */
function summarizeLoaderOutcomes(outcomes: ReadonlyArray<LoadStatus>): void {
  if (outcomes.length === 0) return;
  let loaded = 0;
  let untrusted = 0;
  let broken = 0;
  let shadowed = 0;
  for (const outcome of outcomes) {
    if (outcome.kind === 'loaded') loaded += 1;
    else if (outcome.kind === 'untrusted') untrusted += 1;
    else if (outcome.kind === 'broken') broken += 1;
    else shadowed += 1;
  }
  const parts: string[] = [`hook-loader: ${loaded} loaded`];
  if (untrusted > 0) parts.push(`${untrusted} untrusted`);
  if (broken > 0) parts.push(`${broken} broken (quarantined)`);
  if (shadowed > 0) parts.push(`${shadowed} shadowed`);
  console.log(parts.join(', '));
}
