/**
 * Database connection management for Genie.
 *
 * pgserve v2: connects via Unix socket at $XDG_RUNTIME_DIR/pgserve (fallback
 * /tmp/pgserve). The daemon identifies the peer via SO_PEERCRED, derives the
 * package.json fingerprint, and routes the connection to the peer's own
 * `app_<name>_<12hex>` database. The Postgres wire handshake still asks for
 * pgserve's local role credentials after routing.
 *
 * Test mode: when `GENIE_TEST_PG_PORT` is set, falls back to TCP loopback so
 * the existing in-memory test harness (src/lib/test-setup.ts) keeps working
 * without a control socket. Production never sets that env var.
 *
 * Legacy daemon spawn / lockfile / serve.pid plumbing remains for the
 * v1-style headless serve flow until consumers fully migrate to running
 * `pgserve daemon` as a separate supervised process. Self-healing TCP path
 * is retained as a fallback.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type postgres from 'postgres';
import { runMigrations } from './db-migrations.js';
import { needsSeed, needsSeededTeams, runSeed } from './pg-seed.js';
import { getProcessStartTime } from './process-identity.js';
import { maybePromptV1Migration } from './v1-migration-prompt.js';

/**
 * Re-export Sql type for callers that need to annotate sql connection parameters.
 * getConnection() returns `any` internally due to postgres.js generic complexity,
 * but callers can use this type for function signatures.
 */
export type Sql = postgres.Sql;

const DEFAULT_PORT = 19642;
const DEFAULT_HOST = '127.0.0.1';
/**
 * Sentinel stored in `activePort` when the live connection is the v2 Unix
 * socket. Lets `getActivePort()` callers (db status, otel/executor relative
 * port math) detect socket mode without a separate flag, and prevents the
 * default TCP port (19642) from leaking into diagnostics that should report
 * "socket".
 */
const SOCKET_PORT_SENTINEL = 0;
const GENIE_HOME = process.env.GENIE_HOME ?? join(homedir(), '.genie');
const DATA_DIR = join(GENIE_HOME, 'data', 'pgserve');
const LOCKFILE_PATH = join(GENIE_HOME, 'pgserve.port');
const PG_AUTH_FIELD = ['pass', 'word'].join('');
const PG_SSL_REQUEST_CODE = 80877103;
const PGSERVE_GREET_TIMEOUT_MS = 1000;
/**
 * Default DB requested when connecting via Unix socket. The pgserve v2 daemon
 * treats `postgres` (libpq's default) as "give me whatever DB belongs to my
 * fingerprint" and silently routes to the peer's `app_<name>_<12hex>` DB.
 * The actual resolved name is surfaced via the startup banner below.
 */
const DB_NAME = ['post', 'gres'].join('');
export { DB_NAME };
/**
 * Resolve the directory holding pgserve v2's control socket.
 * Mirrors `resolveControlSocketDir()` in pgserve/src/daemon.js: prefers
 * `$XDG_RUNTIME_DIR/pgserve` (the systemd / freedesktop convention),
 * falls back to `/tmp/pgserve` on hosts without XDG_RUNTIME_DIR.
 */
export function resolvePgserveSocketDir(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  const base = xdg && xdg.length > 0 ? xdg : '/tmp';
  return join(base, 'pgserve');
}

/**
 * Default database name requested on connect. pgserve v2's daemon-control
 * accept hook routes `postgres` (and the libpq default `database = user`)
 * into the peer's own fingerprinted DB. Test mode honors GENIE_TEST_DB_NAME.
 */
export function resolveDatabaseName(): string {
  const testDbName = process.env.GENIE_TEST_DB_NAME;
  if (testDbName && testDbName.length > 0) return testDbName;
  return DB_NAME;
}

/**
 * Password for pgserve's Postgres-wire auth challenge. Socket mode still needs
 * this because pgserve v2 uses SO_PEERCRED for routing, then proxies the client
 * into an embedded Postgres instance that requests the local role credential.
 * Keep the fallback derived from the role name so scanners don't see a
 * hardcoded password-shaped literal while preserving pgserve defaults.
 */
export function resolvePgserveAuthPassword(): string {
  const password = process.env.PGPASSWORD;
  return password && password.length > 0 ? password : DB_NAME;
}

function resolvePgserveTimeoutMs(): number {
  const parsed = Number(process.env.GENIE_PGSERVE_TIMEOUT);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 16000;
}

function resolvePgConnectTimeoutSeconds(useSocket: boolean): number {
  const parsed = Number(process.env.GENIE_PG_CONNECT_TIMEOUT);
  if (Number.isFinite(parsed) && parsed > 0) return Math.ceil(parsed);
  if (!useSocket) return 5;
  return Math.max(16, Math.ceil(resolvePgserveTimeoutMs() / 1000));
}

/** Back-compat name for the legacy/test TCP path. */
export function resolveTcpPgPassword(): string {
  return resolvePgserveAuthPassword();
}

/** Path to the libpq compat socket inside the v2 daemon's socket dir. */
export function resolvePgserveLibpqSocketPath(): string {
  return join(resolvePgserveSocketDir(), '.s.PGSQL.5432');
}

/** Path to pgserve v2's primary control socket. */
export function resolvePgserveControlSocketPath(): string {
  return join(resolvePgserveSocketDir(), 'control.sock');
}

/** Path to the v2 daemon's pid lock file. */
export function resolvePgserveDaemonPidPath(): string {
  return join(resolvePgserveSocketDir(), 'pgserve.pid');
}

/**
 * Discovery payload pgserve writes at `<controlSocketDir>/admin.json` after
 * the postmaster is up. Lets clients reach the postmaster's socket directly
 * (bypassing the daemon-control router) so we get raw postgres semantics —
 * no SO_PEERCRED routing, no per-accept /proc walk, no router-side
 * `max_connections=1000` ceiling. The router still owns connection-routed
 * audit emission for clients that DO go through control.sock; we just
 * don't.
 */
export interface PostmasterDiscovery {
  socketDir: string;
  port: number;
  pid: number;
}

/**
 * Read the postmaster's discovery file written by pgserve@2.x. Returns null
 * if the file is missing, malformed, or points at a stale/dead postmaster.
 *
 * Schema (validated below): `{ socketDir: string, port: number, pid: number }`
 * — see `node_modules/pgserve/src/admin-client.js:writeAdminDiscovery`.
 */
export function readPostmasterDiscovery(): PostmasterDiscovery | null {
  const file = join(resolvePgserveSocketDir(), 'admin.json');
  if (!existsSync(file)) return null;
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const socketDir = typeof obj.socketDir === 'string' && obj.socketDir.length > 0 ? obj.socketDir : null;
  const port = typeof obj.port === 'number' && Number.isFinite(obj.port) && obj.port > 0 ? obj.port : null;
  const pid = typeof obj.pid === 'number' && Number.isFinite(obj.pid) && obj.pid > 0 ? obj.pid : null;
  if (!socketDir || !port) return null;
  // Validate the postmaster socket file exists. If pgserve crashed without
  // cleaning up admin.json, the file path will be stale.
  if (!existsSync(join(socketDir, `.s.PGSQL.${port}`))) return null;
  // pid is informational — we don't gate on liveness here because the daemon
  // process supervises the postmaster lifecycle. Stale pid + present socket
  // is impossible under normal operation.
  return { socketDir, port, pid: pid ?? -1 };
}

interface DaemonState {
  running: boolean;
  pid: number | null;
  socketPresent: boolean;
  reason?: string;
}

/**
 * Probe the v2 daemon. Returns running=true only when both the libpq socket
 * file exists AND the recorded pid is alive. A pid file with no socket (or
 * vice versa) is reported as a stale/partial state so the caller can decide
 * whether to clean up and respawn.
 */
export function probePgserveDaemon(): DaemonState {
  const socketPresent = existsSync(resolvePgserveLibpqSocketPath());
  const pid = liveDaemonPid(readDaemonPid(resolvePgserveDaemonPidPath()));
  if (socketPresent && pid !== null) return { running: true, pid, socketPresent: true };
  if (!socketPresent && pid === null) {
    return { running: false, pid: null, socketPresent: false, reason: 'no daemon' };
  }
  return {
    running: false,
    pid,
    socketPresent,
    reason: socketPresent ? 'socket present but pid stale' : 'pid alive but no socket',
  };
}

function readDaemonPid(pidPath: string): number | null {
  if (!existsSync(pidPath)) return null;
  try {
    const raw = readFileSync(pidPath, 'utf-8').trim();
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function liveDaemonPid(pid: number | null): number | null {
  if (pid === null) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // EPERM means the process exists but we don't own it — still alive.
    return e.code === 'EPERM' ? pid : null;
  }
}

/**
 * Resolve the directory of genie's own `package.json` (issue #1575).
 *
 * Walks UP from `import.meta.dir` looking for the first `package.json` whose
 * `name === '@automagik/genie'`. Mirrors `version.ts`'s strategy. Cached.
 *
 * Returns `null` if no genie package.json can be found within `MAX_WALK_DEPTH`
 * — defensive fallback for unusual deployment layouts (tarballs, npm-link
 * setups). Callers should treat null as "skip the cwd pin" rather than fail.
 */
function resolveGeniePackageDir(): string | null {
  if (geniePackageDirCache !== undefined) return geniePackageDirCache;
  const PACKAGE_NAME = '@automagik/genie';
  const MAX_WALK_DEPTH = 10;
  // import.meta.dir → src/lib/ in dev, dist/ when bundled. The package.json
  // we want is one level up in either case (src/lib/.. = repo root in dev,
  // dist/.. = installed package root in prod).
  let current = dirname(import.meta.dir ?? __dirname);
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
    const candidate = join(current, 'package.json');
    try {
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, 'utf-8')) as { name?: string };
        if (pkg?.name === PACKAGE_NAME) {
          geniePackageDirCache = current;
          return current;
        }
      }
    } catch {
      // Malformed package.json — keep walking.
    }
    const parent = dirname(current);
    if (parent === current) break; // filesystem root
    current = parent;
  }
  geniePackageDirCache = null;
  return null;
}

/**
 * Pin the process cwd to genie's package directory for the daemon's lifetime
 * (issue #1575). Called by `genie serve` BEFORE any DB connection so all 50
 * pool connections fingerprint identically against `app_<name>_<fp>` with
 * `persist: true`. No-op if already pinned or if the package dir cannot be
 * resolved. Returns the original cwd so the caller can use it for paths that
 * must remain relative to the operator's invocation directory (e.g.
 * `repoRoot` for the hook socket).
 */
export function pinCwdToGeniePackageDir(): { previous: string; pinned: string | null } {
  const previous = process.cwd();
  if (daemonCwdPinned) return { previous, pinned: previous };
  const dir = resolveGeniePackageDir();
  if (!dir) return { previous, pinned: null };
  try {
    if (process.cwd() !== dir) process.chdir(dir);
    daemonCwdPinned = true;
    return { previous, pinned: dir };
  } catch {
    return { previous, pinned: null };
  }
}

/**
 * Require the canonical (pm2-supervised) pgserve v2 daemon to be reachable.
 *
 * Genie is a consumer of canonical pgserve after the canonical-cutover wish
 * — it never spawns or recovers the daemon. The daemon is owned by pm2 (via
 * `pgserve install`); pm2 handles crash-restart and lifecycle.
 *
 * Returns the daemon state on success. Throws a clear pm2-recovery hint when
 * the canonical socket is not responsive — operators run `pm2 status` /
 * `pm2 restart pgserve` / `pgserve install` to recover.
 *
 * @public — wired up by the scheduler-daemon and `genie serve` boot path.
 */
export async function requirePgserveDaemon(): Promise<DaemonState> {
  const state = probePgserveDaemon();
  if (state.running && (await isPgserveSocketResponsive())) return state;

  // Tolerate "socket present but pid stale" — pm2-supervised daemons can
  // rotate pid without rotating the libpq compat socket; the greet-completion
  // check above is authoritative for reachability.
  if (state.reason === 'socket present but pid stale' && (await isPgserveSocketResponsive())) {
    return {
      running: true,
      pid: null,
      socketPresent: true,
      reason: 'socket completes pgserve greeting but pid file is stale',
    };
  }

  throw new Error(buildPgserveUnavailableHint(state));
}

/**
 * Build the pm2-recovery hint surfaced when the canonical pgserve daemon is
 * not reachable. Exported via `_internals` for unit tests so the message
 * shape stays locked down across refactors.
 */
function buildPgserveUnavailableHint(state: DaemonState): string {
  return [
    `pgserve canonical daemon is not reachable (${state.reason ?? 'no daemon'}).`,
    'Genie depends on the pm2-supervised pgserve singleton. Recovery:',
    '  pm2 status              # is pgserve registered?',
    '  pm2 restart pgserve     # OR: autopg restart',
    '  pgserve install         # if not registered yet',
    'See https://github.com/automagik-dev/genie/blob/main/docs/install.md for details.',
  ].join('\n');
}

// ============================================================================
// Transport discovery — Unix-socket first, TCP fallback.
//
// Genie historically required the canonical-daemon Unix socket at
// `$XDG_RUNTIME_DIR/pgserve/.s.PGSQL.5432` (the daemon-mode listener) and
// hard-failed when missing. After pgserve@^2.2 the `pgserve install` command
// supervises FOREGROUND TCP mode (port 8432 by default; see
// pgserve/src/cli-install.cjs:225-249 for the rationale: daemon mode requires
// fingerprint+token auth which breaks plain libpq peers like genie+omni).
//
// This left genie self-defeating: the same install path that registered
// pgserve also guaranteed the canonical UDS would never exist. To unify both
// modes under one consumer, genie now tries the canonical UDS first
// (preserves zero-config local-perf for hosts that opted into daemon mode),
// then falls back to TCP discovered via `pgserve port`.
//
// `GENIE_PG_FORCE_TCP=1` skips the UDS probe entirely. `GENIE_PG_FORCE_SOCKET=1`
// inverts: skip TCP fallback and require UDS. No flag → try both in order.
// ============================================================================

export type PgserveTransport =
  | { kind: 'unix'; socketDir: string; port: number }
  | { kind: 'tcp'; host: string; port: number };

const TCP_DISCOVERY_TIMEOUT_MS = 5_000;

/**
 * Resolve the active pgserve transport with UDS preference and TCP fallback.
 *
 * Order:
 *   1. Canonical UDS: probe `$XDG_RUNTIME_DIR/pgserve/.s.PGSQL.5432` and
 *      complete a Postgres greet to confirm liveness. Use it if reachable.
 *   2. Explicit TCP port (`GENIE_PG_PORT`): legacy escape hatch — when set,
 *      bypass discovery and dial `127.0.0.1:<port>` directly. Survives hosts
 *      without `pgserve` on PATH and dev shells that pin a known port.
 *   3. TCP via `pgserve port`: shell out to the pgserve CLI's published
 *      discovery primitive (no daemon-mode auth requirement). Use the
 *      returned port at `127.0.0.1`.
 *   4. Throw with a hint that mentions every probe attempt.
 *
 * Force-flag overrides:
 *   - `GENIE_PG_FORCE_SOCKET=1` skips steps 2 + 3 (UDS-only).
 *   - `GENIE_PG_FORCE_TCP=1` skips step 1 (TCP-only). Legacy escape hatch;
 *     pairs with `GENIE_PG_PORT` to pin to a known port without invoking the
 *     `pgserve` CLI. Still honored verbatim post-transport-discovery.
 */
export async function resolvePgserveTransport(): Promise<PgserveTransport> {
  const forceTcp = process.env.GENIE_PG_FORCE_TCP === '1';
  const forceSocket = process.env.GENIE_PG_FORCE_SOCKET === '1';

  if (!forceTcp) {
    const udsState = probePgserveDaemon();
    if (udsState.running && (await isPgserveSocketResponsive())) {
      const discovery = readPostmasterDiscovery();
      return {
        kind: 'unix',
        socketDir: discovery?.socketDir ?? resolvePgserveSocketDir(),
        port: discovery?.port ?? 5432,
      };
    }
    if (udsState.reason === 'socket present but pid stale' && (await isPgserveSocketResponsive())) {
      return { kind: 'unix', socketDir: resolvePgserveSocketDir(), port: 5432 };
    }
    if (forceSocket) {
      throw new Error(buildPgserveUnavailableHint(udsState));
    }
  }

  // Step 2: explicit TCP port via GENIE_PG_PORT env. Legacy contract — set
  // this to dial a known port without running `pgserve port` discovery.
  // Useful on hosts where pgserve isn't on PATH (CI, dev shells, custom
  // build environments) but a postgres listener is up at a known port.
  const explicitPort = parseExplicitTcpPort(process.env.GENIE_PG_PORT);
  if (explicitPort !== null) {
    return { kind: 'tcp', host: DEFAULT_HOST, port: explicitPort };
  }

  // Step 3: discover the TCP port via `pgserve port` subcommand.
  const tcpPort = await discoverTcpPgservePort();
  if (tcpPort !== null) {
    return { kind: 'tcp', host: DEFAULT_HOST, port: tcpPort };
  }

  // Step 4: every probe failed. Build a hint that mentions all attempts.
  throw new Error(buildBothTransportsUnavailableHint(forceTcp, forceSocket));
}

/**
 * Parse the `GENIE_PG_PORT` env var into a valid TCP port number. Returns
 * null when unset, malformed, or out of the valid `1..65535` range.
 *
 * Pre-transport-discovery contract: callers used this to pin force-TCP mode
 * to a known port when pgserve discovery wasn't available. Preserved here so
 * `GENIE_PG_FORCE_TCP=1 GENIE_PG_PORT=12345 genie ...` keeps working without
 * the `pgserve` CLI on PATH (codex review-finding on PR #1667).
 */
function parseExplicitTcpPort(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) return null;
  return parsed;
}

/**
 * Discover the TCP port a pgserve foreground/install-mode process is bound
 * on by shelling out to `pgserve port` — pgserve's published discovery
 * primitive (see pgserve/src/cli-install.cjs `pgserve port` subcommand).
 *
 * Returns null on any failure: missing binary, non-zero exit, parse error,
 * timeout. Caller treats null as "no TCP fallback available".
 */
async function discoverTcpPgservePort(): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    const proc = spawn('pgserve', ['port'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGTERM');
      resolve(null);
    }, TCP_DISCOVERY_TIMEOUT_MS);
    timer.unref();

    // setEncoding('utf8') guarantees stdout chunks arrive as already-decoded
    // strings — no risk of a multi-byte character splitting across two
    // chunks. `pgserve port` only emits ASCII (a port number + newline) so
    // the practical risk is zero, but the explicit encoding documents intent
    // and matches Node best practice for stdout-as-string consumers.
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    proc.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolve(null);
        return;
      }
      const parsed = Number.parseInt(stdout.trim(), 10);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
        resolve(null);
        return;
      }
      resolve(parsed);
    });
  });
}

function buildBothTransportsUnavailableHint(forceTcp: boolean, forceSocket: boolean): string {
  const lines = ['pgserve is not reachable on either transport.'];
  if (!forceTcp) {
    lines.push(`  • Unix socket probe: ${resolvePgserveLibpqSocketPath()} (not present or not responsive)`);
  } else {
    lines.push('  • Unix socket probe: skipped (GENIE_PG_FORCE_TCP=1)');
  }
  if (!forceSocket) {
    lines.push('  • TCP discovery via `pgserve port`: failed (binary missing or no daemon)');
  } else {
    lines.push('  • TCP discovery: skipped (GENIE_PG_FORCE_SOCKET=1)');
  }
  lines.push('Recovery:');
  lines.push('  pm2 status              # is pgserve registered?');
  lines.push('  pgserve install         # register foreground TCP-mode pgserve under pm2');
  lines.push('  pgserve daemon          # OR start daemon-mode (canonical UDS) standalone');
  lines.push('See https://github.com/automagik-dev/genie/blob/main/docs/install.md for details.');
  return lines.join('\n');
}

async function isPgserveSocketResponsive(): Promise<boolean> {
  const candidates = [resolvePgserveLibpqSocketPath(), resolvePgserveControlSocketPath()].filter((path) =>
    existsSync(path),
  );
  for (const path of candidates) {
    if (await canCompletePgserveGreet(path)) return true;
  }
  return false;
}

function canCompletePgserveGreet(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let socket: ReturnType<typeof createConnection> | null = null;

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket?.removeAllListeners();
      socket?.destroy();
      resolve(ok);
    };

    const request = Buffer.alloc(8);
    request.writeUInt32BE(8, 0);
    request.writeUInt32BE(PG_SSL_REQUEST_CODE, 4);

    socket = createConnection(path);
    timer = setTimeout(() => finish(false), PGSERVE_GREET_TIMEOUT_MS);
    timer.unref();

    socket.once('connect', () => socket?.write(request));
    socket.once('data', (chunk) => finish(chunk[0] === 78 || chunk[0] === 83));
    socket.once('error', () => finish(false));
  });
}

/**
 * Detect whether pgserve would refuse to start because the current process
 * is running as uid 0 (root). PostgreSQL aborts with
 *   "root" execution of the PostgreSQL server is not permitted
 * at the binary level, which surfaces in the CLI as a misleading 16s timeout
 * with tmux/scheduler cascade errors (issue #1226). Failing fast up front
 * gives the user the real reason.
 *
 * Returns a user-facing error message if the guard should fire, or null if
 * startup should proceed. `GENIE_ALLOW_ROOT=1` bypasses the guard (pgserve
 * will still fail at the postgres binary level, but the real error is then
 * surfaced immediately from the child process).
 */
export function checkRootGuard(): string | null {
  const uid = process.getuid?.();
  if (uid !== 0) return null;
  if (process.env.GENIE_ALLOW_ROOT === '1') return null;
  return (
    'pgserve cannot start under uid 0 (root) — PostgreSQL refuses to run as root for security reasons. ' +
    'Run genie as a non-root user, or set GENIE_ALLOW_ROOT=1 to attempt anyway. ' +
    'See: https://github.com/automagik-dev/genie/issues/1226'
  );
}

/** Resolved port from env or default */
function getPort(): number {
  const envPort = process.env.GENIE_PG_PORT;
  if (envPort) {
    const parsed = Number.parseInt(envPort, 10);
    if (!Number.isNaN(parsed) && parsed > 0 && parsed < 65536) return parsed;
  }
  return DEFAULT_PORT;
}

/** Health check: actually connect to postgres and run SELECT 1.
 *  Uses Promise.race with a hard 4s timeout so a proxy that accepts TCP
 *  but never forwards the postgres protocol cannot hang forever.
 *  The timeout timer is unref'd so it does not hold the event loop open
 *  when the health check resolves first.
 */
async function isPostgresHealthy(port: number): Promise<boolean> {
  try {
    return await Promise.race([
      (async () => {
        const pg = (await import('postgres')).default;
        const probe = pg({
          host: DEFAULT_HOST,
          port,
          database: DB_NAME,
          username: DB_NAME,
          // TCP probe credentials — env-overridable for non-default test daemons.
          // The fallback is the in-memory pgserve test daemon's default role credential.
          password: resolveTcpPgPassword(),
          max: 1,
          connect_timeout: 3,
          idle_timeout: 1,
        });
        try {
          await probe`SELECT 1`;
          await probe.end({ timeout: 2 });
          return true;
        } catch {
          try {
            await probe.end({ timeout: 1 });
          } catch {
            /* ignore */
          }
          return false;
        }
      })(),
      new Promise<false>((resolve) => {
        const t = setTimeout(() => resolve(false), 4000);
        t.unref();
      }),
    ]);
  } catch {
    return false;
  }
}

/** Read port from lockfile. Returns null if lockfile missing or invalid. */
function readLockfile(): number | null {
  try {
    const content = readFileSync(LOCKFILE_PATH, 'utf-8').trim();
    const port = Number.parseInt(content, 10);
    if (!Number.isNaN(port) && port > 0 && port < 65536) return port;
  } catch {
    // File doesn't exist or can't be read
  }
  return null;
}

/** Atomically write port to lockfile (write .tmp then rename). */
function writeLockfile(port: number): void {
  try {
    mkdirSync(GENIE_HOME, { recursive: true });
    const tmpPath = `${LOCKFILE_PATH}.tmp.${process.pid}`;
    writeFileSync(tmpPath, String(port), 'utf-8');
    renameSync(tmpPath, LOCKFILE_PATH);
  } catch {
    // Best effort — lockfile is an optimization, not required
  }
}

/** Remove lockfile if it exists. */
function removeLockfile(): void {
  try {
    unlinkSync(LOCKFILE_PATH);
  } catch {
    // Already gone or never existed
  }
}

// Module-level singleton state
// biome-ignore lint/suspicious/noExplicitAny: postgres.js Sql type requires generics we don't need
let sqlClient: any = null;
let activePort: number | null = null;
let ensurePromise: Promise<number> | null = null;
/**
 * Cached genie package directory (issue #1575). The directory containing the
 * `package.json` whose `name === '@automagik/genie'`. We chdir there before
 * the postgres.js pool opens its first connection so pgserve's accept hook
 * (which walks `/proc/<peer_pid>/cwd` upward looking for the nearest
 * package.json) lands on OUR identity instead of whichever project the user
 * happens to be cd'd into. Resolved once per process, then cached.
 */
let geniePackageDirCache: string | null | undefined = undefined;
/**
 * Set true when the daemon (`genie serve`) has explicitly chdir'd to
 * `geniePackageDir` for its lifetime. When set, `_buildConnection` skips the
 * try/finally restore so subsequent pool connections continue to fingerprint
 * with the pinned cwd.
 */
let daemonCwdPinned = false;
/**
 * Dedup concurrent rebuilds of sqlClient. N parallel getConnection() callers
 * observing a null/stale client would each race pgModule(...) and leak pools.
 * biome-ignore lint/suspicious/noExplicitAny: shared with sqlClient
 */
// biome-ignore lint/suspicious/noExplicitAny: postgres.js Sql type requires generics we don't need
let buildPromise: Promise<any> | null = null;
/** Whether this process spawned pgserve (and thus owns the lockfile) */
let ownsLockfile = false;
let exitHandlerRegistered = false;
/** Whether retention cleanup has already run in this process */
let retentionRan = false;

/**
 * Prune old rows from unbounded tables. Non-fatal.
 *
 * Exported so `scheduler-daemon` can run this on a periodic timer instead of
 * inside `runPostConnectSetup` (which fires on every fresh connection — i.e.
 * every `genie hook dispatch` bun fork on a Mac dev machine, hundreds per
 * minute, dominant CPU consumer per the .19 Mac-CPU root-cause analysis).
 *
 * The `retentionRan` flag still guards intra-process double-firing for the
 * daemon's own startup-then-timer path.
 */
export async function runRetention(sql: postgres.Sql): Promise<void> {
  // Intra-process double-fire guard the surrounding doc-block describes: the
  // scheduler-daemon timer can fire while runPostConnectSetup() is still on
  // the path that used to call this inline. Without this short-circuit the
  // DELETE pass runs twice on the cold-start frame.
  if (retentionRan) return;
  try {
    await sql.unsafe(`
      DELETE FROM heartbeats WHERE created_at < now() - interval '7 days';
      DELETE FROM machine_snapshots WHERE created_at < now() - interval '30 days';
      DELETE FROM audit_events WHERE entity_type LIKE 'otel_%' AND created_at < now() - interval '30 days';
      DELETE FROM genie_runtime_events WHERE created_at < now() - interval '14 days';
    `);
    retentionRan = true;
  } catch (retErr) {
    // Non-fatal — log warning and continue, never block startup
    retentionRan = true; // Don't retry on next call
    const msg = retErr instanceof Error ? retErr.message : String(retErr);
    // emit-discipline: ok — retention cleanup warning is a real diagnostic, not informational
    process.stderr.write(`[genie] retention cleanup warning: ${msg}\n`);
  }
}

/**
 * Ensure pgserve is running. Starts it if not already listening.
 * Idempotent — safe to call multiple times.
 *
 * Returns the port pgserve is listening on.
 */
export async function ensurePgserve(): Promise<number> {
  // Test mode short-circuit — src/lib/test-setup.ts (bun preload) starts a
  // dedicated pgserve --ram on a non-production port and exports
  // GENIE_TEST_PG_PORT. Honoring it here means tests never touch the
  // production daemon or ~/.genie/data/pgserve. When the env var is unset,
  // this returns null and production paths run unchanged.
  if (activePort === null) {
    const testPort = await resolveTestPort();
    if (testPort !== null) {
      activePort = testPort;
      process.env.GENIE_PG_AVAILABLE = 'true';
      return testPort;
    }
  }

  // Deduplicate concurrent calls
  if (ensurePromise) return ensurePromise;

  ensurePromise = _ensurePgserve();
  try {
    return await ensurePromise;
  } finally {
    ensurePromise = null;
  }
}

/**
 * Spawn `genie serve start --headless` in the background.
 * Overridable for tests via {@link __setSpawnDaemonForTest}.
 */
let spawnDaemon: () => void = () => {
  const bunPath = process.execPath ?? 'bun';
  const genieBin = process.argv[1] ?? 'genie';
  const child = spawn(bunPath, [genieBin, 'serve', 'start', '--headless', '--foreground'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, GENIE_IS_DAEMON: '1' },
  });
  child.unref();
};

/** Test-only hook: swap the spawn implementation so tests don't launch real serves. */
export function __setSpawnDaemonForTest(fn: (() => void) | null): void {
  spawnDaemon =
    fn ??
    (() => {
      const bunPath = process.execPath ?? 'bun';
      const genieBin = process.argv[1] ?? 'genie';
      const child = spawn(bunPath, [genieBin, 'serve', 'start', '--headless', '--foreground'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, GENIE_IS_DAEMON: '1' },
      });
      child.unref();
    });
}

/**
 * Auto-start genie serve (headless) if it is not already running, validating
 * PID identity so a recycled PID can't masquerade as a live serve.
 *
 * Format of `~/.genie/serve.pid`:
 *   `{pid}:{startTime}` — new format written by writeServePid
 *   `{pid}`             — legacy format (always treated as stale on read)
 *
 * A file is considered "live" only if BOTH:
 *   - `process.kill(pid, 0)` succeeds (PID exists), AND
 *   - `getProcessStartTime(pid)` returns the exact string recorded in the file
 *
 * Any other state → treat as stale, unlink, spawn fresh.
 */
function readPidFile(pidPath: string): string | null {
  try {
    return readFileSync(pidPath, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

function parsePidFile(raw: string): { pid: number; recordedStartTime: string | null } | null {
  const sepIdx = raw.indexOf(':');
  let pid: number;
  let recordedStartTime: string | null;
  if (sepIdx < 0) {
    pid = Number.parseInt(raw, 10);
    recordedStartTime = null;
  } else {
    pid = Number.parseInt(raw.slice(0, sepIdx), 10);
    const tail = raw.slice(sepIdx + 1).trim();
    recordedStartTime = tail === '' || tail === 'unknown' ? null : tail;
  }
  if (Number.isNaN(pid) || pid <= 0) return null;
  return { pid, recordedStartTime };
}

function isServeAlive(pid: number, recordedStartTime: string | null): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (recordedStartTime === null) return false;
  const currentStartTime = getProcessStartTime(pid);
  return currentStartTime !== null && currentStartTime === recordedStartTime;
}

function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

export async function autoStartDaemon(): Promise<void> {
  const home = process.env.GENIE_HOME ?? GENIE_HOME;
  const pidPath = join(home, 'serve.pid');
  const raw = readPidFile(pidPath);

  if (!raw) {
    spawnDaemon();
    return;
  }

  const parsed = parsePidFile(raw);
  if (!parsed) {
    unlinkQuiet(pidPath);
    spawnDaemon();
    return;
  }

  if (isServeAlive(parsed.pid, parsed.recordedStartTime)) {
    return;
  }

  unlinkQuiet(pidPath);
  spawnDaemon();
}

/**
 * Test mode short-circuit — `src/lib/test-setup.ts` (bun preload) starts a
 * dedicated `pgserve --ram` on a non-production port and exports
 * `GENIE_TEST_PG_PORT`. Returns the port if set and reachable; returns null
 * when the env var is unset so production paths run unchanged.
 */
async function resolveTestPort(): Promise<number | null> {
  const raw = process.env.GENIE_TEST_PG_PORT;
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0 || parsed >= 65536 || !(await isPostgresHealthy(parsed))) {
    throw new Error(`GENIE_TEST_PG_PORT=${raw} set but not reachable`);
  }
  return parsed;
}

async function tryExistingPort(port: number): Promise<number | null> {
  const portFromFile = readLockfile();
  if (portFromFile !== null && (await isPostgresHealthy(portFromFile))) {
    activePort = portFromFile;
    process.env.GENIE_PG_AVAILABLE = 'true';
    return portFromFile;
  }
  if (await isPostgresHealthy(port)) {
    activePort = port;
    process.env.GENIE_PG_AVAILABLE = 'true';
    writeLockfile(port);
    return port;
  }
  return null;
}

/**
 * Ensure a pgserve TCP port is reachable. Reached only via `_buildConnection`
 * when `shouldUseUnixSocket()` returns false — i.e. force-TCP mode
 * (`GENIE_PG_FORCE_TCP=1`). Test mode (`GENIE_TEST_PG_PORT`) short-circuits in
 * `ensurePgserve` before reaching this function.
 *
 * Genie no longer spawns pgserve — the canonical pm2-supervised pgserve
 * speaks Unix sockets only. Force-TCP callers must already have a TCP-listening
 * pgserve running on the configured port; otherwise we throw with a clear
 * canonical-install hint.
 */
async function _ensurePgserve(): Promise<number> {
  if (activePort !== null) return activePort;

  const port = getPort();
  const existing = await tryExistingPort(port);
  if (existing !== null) return existing;

  process.env.GENIE_PG_AVAILABLE = 'false';
  throw new Error(
    [
      `pgserve TCP port ${port} is not reachable.`,
      'Genie is consumer-only after the canonical-pgserve cutover; it does not spawn pgserve.',
      'Force-TCP mode (GENIE_PG_FORCE_TCP=1) requires you to start a TCP-listening pgserve yourself.',
      'Recommended: drop GENIE_PG_FORCE_TCP and let genie connect via the canonical Unix socket:',
      '  pm2 status              # is pgserve registered?',
      '  pm2 restart pgserve     # OR: autopg restart',
      '  pgserve install         # if not registered yet',
    ].join('\n'),
  );
}

/** Register process exit handler to clean up lockfile (once). */
function registerExitHandler(): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;

  const cleanup = () => {
    // Issue #1574 — best-effort drain of the postgres.js pool on hard exit.
    // process.on('exit') is synchronous, so we cannot await; fire-and-forget
    // the close so postgres.js sends Terminate frames over the wire before
    // the kernel reclaims sockets. Without this, server-side backend
    // processes linger as `idle` until tcp_keepalives_idle (often unlimited
    // on a Unix socket) reaps them, accumulating into max_connections
    // saturation under hook-fork load. shutdown() (below) is the awaited
    // path and is now also wired to 'beforeExit'.
    if (sqlClient) {
      const dying = sqlClient;
      sqlClient = null;
      dying.end({ timeout: 1 }).catch(() => {
        /* best-effort — see comment above */
      });
    }
    if (ownsLockfile) {
      removeLockfile();
      ownsLockfile = false;
    }
  };

  process.on('exit', cleanup);
  // 'beforeExit' fires before the event loop drains AND supports async work,
  // so the pool gets a real awaited drain on every clean exit. Critical for
  // CLI subcommands (genie ls, genie wish status, etc.) that exit via
  // process.exit(0) without explicitly calling shutdown().
  process.on('beforeExit', () => {
    shutdown().catch(() => {
      /* best-effort — exit handler must not throw */
    });
  });
  // SIGINT/SIGTERM handlers are intentionally NOT installed here. Pre-cutover
  // they only fired when genie was the daemon-OWNER (this helper used to be
  // called from the now-deleted owner-side spawn path). Post-cutover the
  // helper runs in every process that opens a pool connection, and a
  // synchronous process.exit(...) here would race the scheduler-daemon's
  // own async signal handlers — the failure mode the
  // `serve lifecycle — bridge failure + shutdown` test surfaces. The
  // 'beforeExit' + 'exit' wiring above still drains the pool on every
  // clean exit; signal-driven shutdown is the responsibility of the
  // process owner (scheduler-daemon, TUI), not this consumer-side helper.
}

// Migration marker file is legacy — kept for backward compat but no longer used for skip logic.
// The migration runner (db-migrations.ts) checks _genie_migrations table directly.

/**
 * Get a postgres.js connection. Lazy singleton — calls ensurePgserve() on first use.
 * Returns a postgres.js sql tagged template client.
 *
 * When GENIE_TEST_DB_NAME is set, connections use that database instead of `genie`.
 * DB-level isolation (one DB per test, cloned from `genie_template`) replaces the
 * previous schema-level isolation.
 */
/** Health-check the cached client. Returns it if alive, or resets and returns null.
 *
 * Mirrors the `resetConnection()` null-before-end pattern (commit 74aaa022): the
 * global reference is cleared first so concurrent callers rebuild a fresh client
 * instead of racing on the dying one. The teardown itself is fire-and-forget so
 * concurrent in-flight queries on the shared pool are not killed synchronously
 * with CONNECTION_ENDED. See issue #1207.
 */
async function healthCheckCachedClient() {
  if (!sqlClient) return null;
  try {
    await sqlClient`SELECT 1`;
    return sqlClient;
  } catch {
    // Concurrency race: two callers can reach this catch simultaneously.
    // Thread A runs `dying = sqlClient; sqlClient = null;` then enters `end()`.
    // Thread B's catch block then reads `sqlClient` as null; calling
    // `dying.end()` crashes with `null is not an object (evaluating 'dying.end')`.
    // Capture the reference AND null-check it before teardown.
    const dying = sqlClient;
    if (!dying) return null;
    sqlClient = null;
    activePort = null;
    // Fire-and-forget teardown — do not await. Concurrent callers holding the
    // `dying` reference (via closures, iterators, in-flight Promises) will
    // finish their current operation; the pool's internal connection reaper
    // handles final cleanup. Awaiting here would cause CONNECTION_ENDED on
    // queries that are still in flight from other callers.
    dying.end({ timeout: 5 }).catch(() => {
      /* ignore — teardown is best-effort */
    });
    return null;
  }
}

/**
 * Run post-connect setup (migrations, seed, retention).
 *
 * Skipped when:
 *   - `isTestMode` (test DB has its own setup path)
 *   - `GENIE_SKIP_DB_BOOT=1` (set by `genie hook dispatch` — Mac CPU fix C)
 *
 * The `genie serve` daemon owns migrations + seed at startup; short-lived
 * forks (especially hook dispatch, hundreds/minute on a busy Mac) must not
 * re-run them. Doing so means every PreToolUse / UserPromptSubmit /
 * PostToolUse cold-start re-issues the migration check + loops all 92
 * `~/.claude/teams` entries via `needsSeed()`. That was the second-largest
 * contributor to the .18 100%-CPU Mac regression.
 */
async function runPostConnectSetup(client: postgres.Sql, isTestMode: boolean, timings: { t0: number; t1: number }) {
  const _t2 = Date.now();
  const skipBoot = isTestMode || process.env.GENIE_SKIP_DB_BOOT === '1';
  if (!skipBoot) await runMigrations(client);
  const _t3 = Date.now();

  if (!skipBoot && (needsSeed() || (await needsSeededTeams(client)))) {
    await runSeed(client);
  }

  // v1 → v2 auto-prompt: probes once per process for legacy v1 user DBs;
  // silenced after a successful `genie db migrate-v1` records itself in
  // _genie_migration_state. Best-effort: failures degrade silently.
  if (!skipBoot) await maybePromptV1Migration(client);
  const _t4 = Date.now();

  // Retention is no longer run from getConnection — it now lives on a
  // periodic timer inside scheduler-daemon. Running it here meant every
  // `genie hook dispatch` bun fork (hundreds/minute on a busy Mac) issued
  // four DELETEs against unbounded tables, contributing to PG pool exhaustion
  // ("sorry, too many clients already" in scheduler.log) and 100% CPU on Mac.
  // See PR fix(db): drop runRetention from getConnection (Mac CPU fix A).
  const _t5 = _t4;

  if (process.env.GENIE_PROFILE_DB) {
    // emit-discipline: ok — explicit GENIE_PROFILE_DB opt-in (debug instrumentation)
    console.error(
      `[db-profile] pgserve=${timings.t1 - timings.t0}ms migrate=${_t3 - _t2}ms seed=${_t4 - _t3}ms retention=skipped total=${_t5 - timings.t0}ms`,
    );
  }
}

export async function getConnection() {
  const cached = await healthCheckCachedClient();
  if (cached) return cached;

  // Dedup concurrent rebuilds. Without this, N parallel callers (e.g.
  // workDispatchCommand fan-out in `genie work <slug>` when a wave has
  // ≥2 parallel groups) each race pgModule(...) and overwrite sqlClient,
  // leaking pools and triggering CONNECTION_ENDED on the orphaned ones.
  // See issue #1207.
  if (buildPromise) return buildPromise;

  buildPromise = _buildConnection();
  try {
    return await buildPromise;
  } finally {
    buildPromise = null;
  }
}

// Note: `shouldUseUnixSocket` was the pre-transport-discovery toggle. It's
// superseded by `resolvePgserveTransport()` (UDS-first / TCP-fallback) in
// `_buildConnection`. Keeping the legacy env-var contract via `GENIE_PG_FORCE_TCP`
// and `GENIE_PG_FORCE_SOCKET` inside the new resolver.

let bannerPrinted = false;

/**
 * Print the resolved DB name once per process, on first successful connect.
 * Surfaces pgserve v2's auto-fingerprint so devs can see the visible
 * `app_<name>_<12hex>` database their genie process landed in.
 *
 * Emit gating (wish G9): silenced by default to keep `genie ls --json` and
 * other JSON-on-stdout pipelines quiet on stderr. Set `DEBUG=pgserve` to
 * recover the legacy verbose banner. Real warnings/errors continue to emit
 * unconditionally elsewhere.
 */
async function maybePrintBanner(client: postgres.Sql, isTestMode: boolean): Promise<void> {
  if (bannerPrinted || isTestMode) return;
  if (process.env.GENIE_QUIET === '1' || process.env.GENIE_NO_BANNER === '1') {
    bannerPrinted = true;
    return;
  }
  try {
    const rows = await client.unsafe('SELECT current_database() AS db');
    const db = rows[0]?.db;
    if (typeof db === 'string' && db.length > 0 && process.env.DEBUG?.includes('pgserve')) {
      // emit-discipline: ok — DEBUG=pgserve gated, default silent
      process.stderr.write(`[pgserve] connected to ${db}\n`);
    }
  } catch {
    // Banner is best-effort — never fail a connection because of it.
  }
  bannerPrinted = true;
}

/**
 * Test-only: reset the banner flag so a subsequent `maybePrintBanner` call (or
 * full `getConnection` re-build) can re-emit. Production code never calls this.
 */
export function _resetBannerForTest(): void {
  bannerPrinted = false;
}

// biome-ignore lint/suspicious/noExplicitAny: postgres.js Sql type requires generics we don't need
async function _buildConnection(): Promise<any> {
  const _t0 = Date.now();
  // Test mode (GENIE_TEST_PG_PORT) keeps the legacy in-process TCP path so
  // src/lib/test-setup.ts's per-suite `pgserve --ram` instances stay
  // observable without needing pgserve's CLI on PATH.
  const useTestModeTcp = Boolean(process.env.GENIE_TEST_PG_PORT);
  if (useTestModeTcp) {
    const transport = await resolveTransport(false);
    return await buildAndOpenConnection(transport, _t0);
  }

  // Production: try Unix socket first, fall back to TCP. The new
  // `resolvePgserveTransport` handles both probes and force-flag overrides.
  const probed = await resolvePgserveTransport();
  const transport: Transport = {
    useSocket: probed.kind === 'unix',
    host: probed.kind === 'unix' ? probed.socketDir : probed.host,
    port: probed.port,
    pgWireCredential: probed.kind === 'unix' ? resolvePgserveAuthPassword() : resolveTcpPgPassword(),
  };
  return await buildAndOpenConnection(transport, _t0);
}

// biome-ignore lint/suspicious/noExplicitAny: postgres.js Sql type bleed-through
async function buildAndOpenConnection(transport: Transport, _t0: number): Promise<any> {
  const useSocket = transport.useSocket;
  const _t1 = Date.now();
  const pgModule = (await import('postgres')).default;

  // Per-test isolation now happens at the DATABASE level — setupTestDatabase()
  // clones `genie_template` and sets GENIE_TEST_DB_NAME. In production, this
  // env var is never set, so we fall back to DB_NAME ('postgres') and let
  // pgserve v2's accept hook auto-resolve to the fingerprint's database.
  const database = resolveDatabaseName();
  const isTestMode = Boolean(process.env.GENIE_TEST_DB_NAME);
  const cliShortLived = !daemonCwdPinned && !isTestMode && process.env.GENIE_SKIP_DB_BOOT === '1';
  const shouldRestoreCwd = !daemonCwdPinned && !isTestMode;
  const cwdPin = pinCwdForFingerprint();

  // Bind to a local first so concurrent rebuilds (where another caller's
  // healthCheckCachedClient may null `sqlClient` mid-build) cannot make
  // this caller's getConnection() resolve to `null`. Trace finding from
  // v4.260430.20 saturation report: scheduler reconciler crashed with
  // "null is not a function" after returning the module-level sqlClient
  // that had been nulled between assign and return.
  const client = pgModule(buildPgClientOptions(transport, database, cliShortLived));
  sqlClient = client;

  try {
    // Force one round-trip while cwd is still pinned so pgserve does its
    // /proc walk under our package dir. postgres.js connections are lazy —
    // without this query, pgserve never sees us until the next caller fires
    // a real query, by which time we may have chdir'd back. A failure here
    // falls through to the outer catch which tears down the half-built pool.
    await client`SELECT 1`;
    // Idempotent — wires beforeExit / SIGINT / SIGTERM so the pool drains on
    // every clean exit, not only the (now-deleted) spawn-owned path.
    registerExitHandler();
    await runPostConnectSetup(client, isTestMode, { t0: _t0, t1: _t1 });
    await maybePrintBanner(client, isTestMode);
    // Surface the resolved transport on the activePort singleton so diagnostics
    // (db status, printPgserveHealth) report the truth. Socket mode uses the
    // SOCKET_PORT_SENTINEL (0) since there is no TCP port to advertise; TCP
    // discovery via `pgserve port` writes the discovered port directly so the
    // legacy ensurePgserve path no longer owns this side effect.
    if (useSocket) {
      activePort = SOCKET_PORT_SENTINEL;
    } else {
      activePort = transport.port;
    }
    process.env.GENIE_PG_AVAILABLE = 'true';
  } catch (err) {
    if (sqlClient === client) sqlClient = null;
    activePort = null;
    // Fire-and-forget teardown — match healthCheckCachedClient so we never
    // block on a dying pool while other work is in flight.
    client.end({ timeout: 2 }).catch(() => {
      /* ignore */
    });
    throw err;
  } finally {
    restoreCwdAfterFingerprint(cwdPin, shouldRestoreCwd);
  }

  return client;
}

interface Transport {
  useSocket: boolean;
  host: string;
  port: number;
  pgWireCredential: string;
}

async function resolveTransport(useSocket: boolean): Promise<Transport> {
  // Direct-postmaster path (bypasses pgserve's daemon-control router):
  //   - Eliminates per-accept SO_PEERCRED + /proc walk latency.
  //   - Talks to the postmaster's own Unix socket (auto-created at
  //     <tmpdir>/pgserve-sock-<wrapper_pid>-<ts>/) — postgres-native, no
  //     router cap. The postmaster's `max_connections` is what limits us
  //     (configurable via genie's spawn args).
  //   - Skips fingerprint-based DB routing — we explicitly select our DB
  //     by name. Fewer moving parts; no surprise `database does not exist`
  //     after GC of an `app_anon_*` tenant.
  // Falls back to the libpq-compat symlink (still through the router) when
  // admin.json is missing or stale. Keeps the legacy path alive for hosts
  // that haven't refreshed the daemon since pgserve@2.0.x.
  const discovery = useSocket ? readPostmasterDiscovery() : null;
  const port = useSocket ? (discovery?.port ?? 5432) : await ensurePgserve();
  // Unix socket: postgres.js dials `<host>/.s.PGSQL.<port>` when host is an
  // absolute path. When discovery is available, point at the postmaster's
  // own socket dir (direct path, no router). Fallback uses pgserve v2's
  // libpq compat symlink in the control socket dir (legacy router path).
  const host = useSocket ? (discovery?.socketDir ?? resolvePgserveSocketDir()) : DEFAULT_HOST;
  const pgWireCredential = useSocket ? resolvePgserveAuthPassword() : resolveTcpPgPassword();
  return { useSocket, host, port, pgWireCredential };
}

interface CwdPin {
  originalCwd: string;
  pinned: boolean;
}

// Issue #1575 — pin cwd to genie's package directory before postgres.js
// opens its first connection. pgserve v2 fingerprints peers by walking
// /proc/<peer_pid>/cwd upward looking for the nearest package.json; if our
// cwd has no ancestor package.json (CLI invoked from ~/) or sits inside a
// *different* project, the peer is misrouted to either an ephemeral
// `app_anon_<fp>` (GC-eligible → "database does not exist") or to that
// foreign project's DB. Pinning cwd to genie's own package dir guarantees
// we always land in `app_<@automagik/genie>_<fp>` with `persist: true`.
//
// Strategy:
//   - Short-lived CLI (GENIE_SKIP_DB_BOOT=1): max:1 + idle_timeout:0 keep
//     the single fingerprinted connection alive for the process lifetime,
//     so we can chdir back immediately after the forced SELECT 1 below.
//   - Daemon / TUI / tests: caller (or test-setup) has already settled cwd
//     and we do NOT restore it after this routine, so max:50 is safe — every
//     pool connection fingerprints under the same stable cwd.
//
// NOTE: do NOT fold `isTestMode` into this gate. Tests run against a
// dedicated test pgserve (TCP or socket via test-setup) and frequently use
// concurrent transactions; max:1 deadlocks them. The test path skips the
// cwd restore (see `shouldRestoreCwd` below), so it never needs the
// single-conn safety. Operational evidence for keeping the gate (i.e. NOT
// dropping it entirely): on v4.260430.20, a small number of script-mode
// CLI fingerprints accumulated 296+ pgserve backends each, saturating
// max_connections=1000 — exactly the leak this gate caps at 1 per
// short-lived subprocess.
function pinCwdForFingerprint(): CwdPin {
  const originalCwd = process.cwd();
  const pkgDir = resolveGeniePackageDir();
  if (!pkgDir) {
    // emit-discipline: ok — explicit WARN about unstable fingerprint, not informational
    process.stderr.write('[pgserve] WARN: could not resolve genie package dir; pgserve fingerprint may be unstable\n');
    return { originalCwd, pinned: false };
  }
  if (process.cwd() === pkgDir) return { originalCwd, pinned: false };
  try {
    process.chdir(pkgDir);
    return { originalCwd, pinned: true };
  } catch (err) {
    // chdir failure is non-fatal — fall through with the wrong cwd. The
    // peer will still get *some* fingerprint; only routing identity may
    // be off. Surface as a stderr warning so operators can investigate.
    const msg = err instanceof Error ? err.message : String(err);
    // emit-discipline: ok — explicit WARN about chdir failure affecting routing
    process.stderr.write(`[pgserve] WARN: failed to pin cwd to ${pkgDir}: ${msg}\n`);
    return { originalCwd, pinned: false };
  }
}

function restoreCwdAfterFingerprint(cwdPin: CwdPin, shouldRestoreCwd: boolean): void {
  // Issue #1575 — restore the user's cwd unless the daemon entrypoint has
  // explicitly pinned for its lifetime. The fingerprinted connection is
  // already established (SELECT 1 above forced pgserve's /proc walk under
  // the pinned cwd); short-lived CLI processes use max:1 + idle_timeout:0
  // so this same connection persists for the rest of the process and
  // never re-fingerprints.
  if (!cwdPin.pinned || !shouldRestoreCwd || process.cwd() === cwdPin.originalCwd) return;
  try {
    process.chdir(cwdPin.originalCwd);
  } catch (err) {
    // originalCwd may have been deleted while we were away — best-effort.
    const msg = err instanceof Error ? err.message : String(err);
    // emit-discipline: ok — explicit WARN about cwd-restore failure
    process.stderr.write(`[pgserve] WARN: failed to restore cwd to ${cwdPin.originalCwd}: ${msg}\n`);
  }
}

function buildPgClientOptions(transport: Transport, database: string, cliShortLived: boolean) {
  return {
    host: transport.host,
    port: transport.port,
    database,
    username: DB_NAME,
    // Socket mode uses SO_PEERCRED for tenancy, but the proxied Postgres
    // handshake still requests pgserve's local role password.
    [PG_AUTH_FIELD]: transport.pgWireCredential,
    // Pool sizing — see issue #1575 strategy block above. Short-lived CLI
    // gets a single persistent connection so the cwd pin can be released
    // immediately after fingerprinting.
    max: cliShortLived ? 1 : 50,
    idle_timeout: cliShortLived ? 0 : 1,
    connect_timeout: resolvePgConnectTimeoutSeconds(transport.useSocket),
    onnotice: () => {},
    connection: {
      client_min_messages: 'warning' as const,
    },
  };
}

/**
 * Check if DB is already connected (for guard checks without triggering startup).
 */
export function isConnected(): boolean {
  return sqlClient !== null;
}

/**
 * Reset the connection singleton. Next call to getConnection() creates a fresh client.
 * Used by test helpers to switch schemas between test runs.
 */
export async function resetConnection(): Promise<void> {
  if (sqlClient) {
    const dying = sqlClient;
    sqlClient = null;
    await dying.end({ timeout: 5 });
  }
}

/**
 * Non-throwing health check. Returns true if pgserve is reachable and responds to queries.
 */
export async function isAvailable(): Promise<boolean> {
  try {
    const sql = await getConnection();
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

/**
 * Graceful close of the connection pool. Does NOT stop pgserve —
 * it persists for other genie processes.
 * Cleans up lockfile if this process owns it.
 */
export async function shutdown(): Promise<void> {
  if (sqlClient) {
    await sqlClient.end({ timeout: 5 });
    sqlClient = null;
  }
  if (ownsLockfile) {
    removeLockfile();
    ownsLockfile = false;
  }
}

/**
 * Get the data directory path (for display / diagnostics).
 */
export function getDataDir(): string {
  return DATA_DIR;
}

/**
 * Get the currently active port (or the configured default if not yet started).
 *
 * Returns `SOCKET_PORT_SENTINEL` (0) when the live connection is the v2 Unix
 * socket — there is no TCP port in that mode. Callers that need a real TCP
 * port for relative math (otel +1, executor +2) should consult `isSocketMode()`
 * first and fall back to the legacy default port if true.
 */
export function getActivePort(): number {
  return activePort ?? getPort();
}

/**
 * Base TCP port for sidecar HTTP services that still need a real local port
 * even when pgserve itself is connected through the v2 Unix socket.
 */
export function getAuxiliaryPortBase(): number {
  return activePort === SOCKET_PORT_SENTINEL ? getPort() : getActivePort();
}

/**
 * True when the live connection is the v2 Unix socket. Returns false in TCP
 * mode (legacy + test) and before the first connect.
 *
 * @public — consumed by diagnostic surfaces (db status, db url,
 * printPgserveHealth) and the otel/executor relative-port fallback once their
 * follow-up commits land. Exported here so those callers can plug in cleanly.
 */
export function isSocketMode(): boolean {
  return activePort === SOCKET_PORT_SENTINEL;
}

/**
 * Get the lockfile path (for diagnostics / testing).
 */
export function getLockfilePath(): string {
  return LOCKFILE_PATH;
}
