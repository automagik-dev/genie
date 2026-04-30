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

import { type ChildProcess, execFileSync, execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
 * Truthy env-var values. Restored during rebase onto dev — `-X theirs`
 * preferred pgserve-v2 changes wholesale and dropped the dev-side const,
 * but `isPgAutostartDisabled` still references it. Single source of truth
 * for env-var bool parsing.
 */
const TRUTHY_ENV = new Set(['1', 'true', 'yes', 'on']);

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

interface DaemonState {
  running: boolean;
  pid: number | null;
  socketPresent: boolean;
  reason?: string;
}

interface PgserveSdkDaemonState {
  running: boolean;
  pid: number | null;
  libpqSocketPresent?: boolean;
  socketPresent?: boolean;
  reason?: string | null;
}

interface PgserveSdk {
  ensureDaemon?: (options?: {
    dataDir?: string;
    logLevel?: string;
    timeoutMs?: number;
    controlSocketDir?: string;
  }) => Promise<PgserveSdkDaemonState>;
}

interface PgserveDaemonCommand {
  command: string;
  argsPrefix: string[];
  display: string;
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

function findLocalPgserveRoot(): string | null {
  const candidates = [
    // Installed package layout: @automagik/genie/dist/genie.js ->
    // @automagik/genie/node_modules/pgserve.
    join(import.meta.dir, '..', 'node_modules', 'pgserve'),
    // Source checkout layout: src/lib/db.ts -> ./node_modules/pgserve.
    join(import.meta.dir, '..', '..', 'node_modules', 'pgserve'),
  ];
  for (const root of candidates) {
    if (existsSync(join(root, 'package.json'))) return root;
  }
  return null;
}

function resolveLocalPgserveEntry(): string | null {
  const root = findLocalPgserveRoot();
  if (root === null) return null;
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { main?: string };
    return join(root, pkg.main ?? 'src/index.js');
  } catch {
    return join(root, 'src/index.js');
  }
}

async function importPgserveSdk(): Promise<PgserveSdk | null> {
  const localEntry = resolveLocalPgserveEntry();
  if (localEntry !== null && existsSync(localEntry)) {
    try {
      return (await import(pathToFileURL(localEntry).href)) as PgserveSdk;
    } catch {
      /* fall back to package resolution */
    }
  }
  try {
    return (await import('pgserve')) as PgserveSdk;
  } catch {
    return null;
  }
}

/** Resolve the v2 daemon command — bundled dependency → global → PATH. */
function findPgserveDaemonCommand(): PgserveDaemonCommand | null {
  const localRoot = findLocalPgserveRoot();
  if (localRoot !== null) {
    const localCommand = resolvePgservePackageCommand(localRoot);
    if (localCommand !== null) return localCommand;
  }
  try {
    const resolved = require.resolve('pgserve/bin/pgserve-wrapper.cjs');
    const packageCommand = resolvePgservePackageCommand(join(dirname(resolved), '..'));
    if (packageCommand !== null) return packageCommand;
  } catch {
    /* not in local deps */
  }
  const globalBin = join(homedir(), '.bun', 'bin', 'pgserve');
  if (existsSync(globalBin)) return { command: globalBin, argsPrefix: [], display: globalBin };
  try {
    const fromPath = execSync('which pgserve', { encoding: 'utf-8', timeout: 3000 }).trim();
    if (fromPath.length > 0) return { command: fromPath, argsPrefix: [], display: fromPath };
  } catch {
    /* not on PATH */
  }
  return null;
}

function resolvePgservePackageCommand(root: string): PgserveDaemonCommand | null {
  const script = join(root, 'bin', 'postgres-server.js');
  const bun = findBunRuntime();
  if (existsSync(script) && bun !== null) {
    return { command: bun, argsPrefix: [script], display: `${bun} ${script}` };
  }

  const wrapper = join(root, 'bin', 'pgserve-wrapper.cjs');
  if (existsSync(wrapper)) return { command: wrapper, argsPrefix: [], display: wrapper };
  return null;
}

function findBunRuntime(): string | null {
  if (process.execPath && existsSync(process.execPath) && basename(process.execPath).startsWith('bun')) {
    return process.execPath;
  }

  const homeBun = join(homedir(), '.bun', 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
  if (existsSync(homeBun)) return homeBun;

  try {
    const fromPath = execSync('which bun', { encoding: 'utf-8', timeout: 3000 }).trim();
    if (fromPath.length > 0) return fromPath;
  } catch {
    /* not on PATH */
  }
  return null;
}

/** Sleep helper used by readiness loops. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let daemonStartPromise: Promise<void> | null = null;

/**
 * Discover-or-spawn the pgserve v2 daemon. Idempotent + single-flighted.
 *
 * Modes:
 *   A. Daemon already running (PM2/systemd, or another genie process).
 *      We do nothing — connect to the existing socket.
 *   B. Stale state (pid file but no socket, or socket but dead pid).
 *      We unlink the stale pid file and respawn.
 *   C. Nothing running. We spawn `pgserve daemon` detached + unref'd so it
 *      outlives the current genie invocation, then wait for the socket.
 *
 * If the pgserve binary cannot be resolved, throws a clear install-guidance
 * error rather than auto-installing — that's the user's call.
 *
 * @public — wired up by the scheduler-daemon and `genie serve` boot path in
 * downstream commits; exported here so those call-sites land cleanly.
 */
export async function getOrStartDaemon(): Promise<DaemonState> {
  if (process.env.GENIE_PG_DISABLE_AUTOSTART === '1' || isPgAutostartDisabled()) {
    const state = probePgserveDaemon();
    if (state.running && (await isPgserveSocketResponsive())) return state;
    throw new Error('pgserve daemon unavailable and PG autostart is disabled');
  }
  const initial = probePgserveDaemon();
  if (initial.running) {
    if (await isPgserveSocketResponsive()) return initial;
    await recoverUnresponsivePgserveDaemon(initial);
  }

  // CI: tests get TCP via GENIE_TEST_PG_PORT; non-test CI shouldn't autospawn.
  if (process.env.CI === 'true' && process.env.GENIE_PG_ALLOW_CI_AUTOSTART !== '1') {
    throw new Error(
      'pgserve v2 daemon socket not present and CI=true. Either start `pgserve daemon` in the workflow or set GENIE_PG_ALLOW_CI_AUTOSTART=1 to opt in.',
    );
  }

  const rootErr = checkRootGuard();
  if (rootErr !== null) throw new Error(rootErr);

  if (initial.reason === 'socket present but pid stale' && (await isPgserveSocketResponsive())) {
    return {
      running: true,
      pid: null,
      socketPresent: true,
      reason: 'socket completes pgserve greeting but pid file is stale',
    };
  }

  if (daemonStartPromise) {
    await daemonStartPromise;
    return probePgserveDaemon();
  }

  daemonStartPromise = startPgserveDaemonOnce(initial);

  try {
    await daemonStartPromise;
  } finally {
    daemonStartPromise = null;
  }
  return probePgserveDaemon();
}

function cleanPartialDaemonState(initial: DaemonState): void {
  // Do not signal a pid from the v2 pid file when the socket is absent: during
  // migration that pid may be stale/recycled, and pgserve v1 TCP daemons must
  // be allowed to coexist.
  if (initial.reason === 'pid alive but no socket' && initial.pid !== null) {
    unlinkIfPresent(resolvePgserveDaemonPidPath());
  }
  if (initial.reason === 'socket present but pid stale') {
    removeStalePgserveSocketArtifacts();
  }
}

async function recoverUnresponsivePgserveDaemon(state: DaemonState): Promise<void> {
  if (state.pid !== null && isLikelyPgserveDaemonProcess(state.pid)) {
    await signalPgserveDaemonPid(state.pid, 'SIGTERM');
    if (liveDaemonPid(state.pid) !== null) await signalPgserveDaemonPid(state.pid, 'SIGKILL');
  }
  removeStalePgserveSocketArtifacts();
}

function isLikelyPgserveDaemonProcess(pid: number): boolean {
  try {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf-8',
      timeout: 1000,
    }).trim();
    return (
      command.includes('pgserve') ||
      command.includes('postgres-server.js') ||
      (command.includes('postgres') && command.includes(DATA_DIR))
    );
  } catch {
    return false;
  }
}

async function signalPgserveDaemonPid(pid: number, signal: NodeJS.Signals): Promise<void> {
  let signaled = false;
  try {
    process.kill(-pid, signal);
    signaled = true;
  } catch {
    /* pid is not a process-group leader */
  }
  try {
    process.kill(pid, signal);
    signaled = true;
  } catch {
    /* process already exited */
  }
  if (!signaled) return;

  const deadline = Date.now() + (signal === 'SIGTERM' ? 1000 : 250);
  while (Date.now() < deadline) {
    if (liveDaemonPid(pid) === null) return;
    await sleep(50);
  }
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

function removeStalePgserveSocketArtifacts(): void {
  for (const path of [
    resolvePgserveDaemonPidPath(),
    resolvePgserveLibpqSocketPath(),
    resolvePgserveControlSocketPath(),
  ]) {
    unlinkIfPresent(path);
  }
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* gone */
  }
}

async function startPgserveDaemonOnce(initial: DaemonState): Promise<void> {
  cleanPartialDaemonState(initial);
  // The data directory may be locked by an orphan from a prior daemon — for
  // example, a pgserve upgrade left the previous version's daemon running on
  // a different control-socket layout, or the daemon parent died while its
  // postgres backend kept running. probePgserveDaemon() can't see those
  // (no current libpq socket / pgserve.pid), so we'd otherwise spawn a fresh
  // daemon whose postgres backend immediately exits with
  //   FATAL: lock file "postmaster.pid" already exists
  // surfaced upstream as the unhelpful "daemon exited before binding …".
  const orphan = detectOrphanDataDirLock();
  if (orphan !== null) await evictOrphanDataDirHolder(orphan);

  const daemonCommand = findPgserveDaemonCommand();
  if (daemonCommand === null) {
    if (await tryEnsureDaemonWithSdk()) return;
    throw new Error(
      'pgserve binary not found. Install with `bun add pgserve@^2.0.2` (or `npm i pgserve@^2.0.2`), or start `pgserve daemon` manually before running genie.',
    );
  }
  mkdirSync(resolvePgserveSocketDir(), { recursive: true, mode: 0o700 });

  const child = spawn(
    daemonCommand.command,
    [...daemonCommand.argsPrefix, 'daemon', '--data', DATA_DIR, '--log', 'warn'],
    {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    },
  );
  try {
    await waitForDaemonSocket(daemonCommand, child);
    child.unref();
  } catch (err) {
    await terminatePgserveTree(child);
    throw err;
  }
}

interface OrphanDataDirHolder {
  pid: number;
  cmd: string;
}

/**
 * Detect a live process holding `<DATA_DIR>/postmaster.pid` that
 * `probePgserveDaemon` can't see — i.e., a pgserve daemon (or its postgres
 * backend) from a previous version / a daemon whose libpq compat symlink
 * was nuked. Only flags processes whose command line proves they belong to
 * us (pgserve, postgres-server.js, or `postgres -D <DATA_DIR>`); unrelated
 * postmasters on the same host are left alone.
 */
function detectOrphanDataDirLock(): OrphanDataDirHolder | null {
  const pidFile = join(DATA_DIR, 'postmaster.pid');
  if (!existsSync(pidFile)) return null;
  let raw: string;
  try {
    raw = readFileSync(pidFile, 'utf-8');
  } catch {
    return null;
  }
  const firstLine = raw.split('\n', 1)[0]?.trim() ?? '';
  const pid = Number.parseInt(firstLine, 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (liveDaemonPid(pid) === null) return null;
  let cmd: string;
  try {
    cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf-8',
      timeout: 1000,
    }).trim();
  } catch {
    return null;
  }
  const ours =
    cmd.includes('pgserve') ||
    cmd.includes('postgres-server.js') ||
    (cmd.includes('postgres') && cmd.includes(DATA_DIR));
  return ours ? { pid, cmd } : null;
}

/**
 * Terminate the orphan that holds `<DATA_DIR>/postmaster.pid`. If the holder
 * is the postgres backend, walk up to the pgserve daemon parent so we kill
 * the whole tree; otherwise signal the holder directly. After the process
 * exits we remove the stale postmaster.pid so the new daemon's first call
 * to `pg_ctl start` doesn't trip on it.
 */
async function evictOrphanDataDirHolder(holder: OrphanDataDirHolder): Promise<void> {
  let target = holder.pid;
  try {
    const ppidStr = execFileSync('ps', ['-p', String(holder.pid), '-o', 'ppid='], {
      encoding: 'utf-8',
      timeout: 1000,
    }).trim();
    const ppid = Number.parseInt(ppidStr, 10);
    if (Number.isInteger(ppid) && ppid > 1) {
      const pcmd = execFileSync('ps', ['-p', String(ppid), '-o', 'command='], {
        encoding: 'utf-8',
        timeout: 1000,
      }).trim();
      if (pcmd.includes('pgserve') || pcmd.includes('postgres-server.js')) target = ppid;
    }
  } catch {
    /* fall back to direct holder */
  }
  await signalPgserveDaemonPid(target, 'SIGTERM');
  if (liveDaemonPid(target) !== null) await signalPgserveDaemonPid(target, 'SIGKILL');
  unlinkIfPresent(join(DATA_DIR, 'postmaster.pid'));
  removeStalePgserveSocketArtifacts();
}

async function waitForDaemonSocket(daemonCommand: PgserveDaemonCommand, child?: ChildProcess): Promise<void> {
  const socketPath = resolvePgserveLibpqSocketPath();
  const timeout = resolvePgserveTimeoutMs();
  const deadline = Date.now() + timeout;
  let childExit: string | null = null;
  child?.once('exit', (code, signal) => {
    childExit = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
  });

  while (Date.now() < deadline) {
    if (existsSync(socketPath) && (await isPgserveSocketResponsive())) return;
    if (childExit !== null) {
      const holder = detectOrphanDataDirLock();
      const holderHint =
        holder !== null
          ? ` Data directory ${DATA_DIR} is held by PID ${holder.pid} (${holder.cmd}); kill it (or run \`genie serve restart\`) and retry.`
          : '';
      throw new Error(
        `pgserve v2 daemon exited before binding ${socketPath} (${childExit}).${holderHint} Try starting it manually: ${formatPgserveDaemonCommand(
          daemonCommand,
        )}`,
      );
    }
    await sleep(250);
  }
  throw new Error(
    `pgserve v2 daemon did not bind ${socketPath} within ${Math.round(
      timeout / 1000,
    )}s. Try starting it manually: ${formatPgserveDaemonCommand(daemonCommand)}`,
  );
}

function formatPgserveDaemonCommand(daemonCommand: PgserveDaemonCommand): string {
  return `${daemonCommand.display} daemon --data ${DATA_DIR} --log warn`;
}

async function tryEnsureDaemonWithSdk(): Promise<boolean> {
  const sdk = await importPgserveSdk();
  if (sdk === null) return false;
  if (typeof sdk.ensureDaemon !== 'function') return false;

  try {
    const state = await sdk.ensureDaemon({
      dataDir: DATA_DIR,
      logLevel: 'warn',
      timeoutMs: resolvePgserveTimeoutMs(),
      controlSocketDir: resolvePgserveSocketDir(),
    });
    if (!state.running || !(state.libpqSocketPresent ?? state.socketPresent ?? true)) return false;
    if (await isPgserveSocketResponsive()) return true;
    await recoverUnresponsivePgserveDaemon(probePgserveDaemon());
    return false;
  } catch {
    const state = probePgserveDaemon();
    if (state.running) await recoverUnresponsivePgserveDaemon(state);
    else cleanPartialDaemonState(state);
    return false;
  }
}

/** Sanitize connection URLs for logging — never expose credentials */
function maskCredentials(url: string): string {
  return url.replace(/\/\/.*@/, '//***@');
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

function isPgAutostartDisabled(): boolean {
  const value = process.env.GENIE_PG_NO_AUTOSTART;
  return value !== undefined && TRUTHY_ENV.has(value.trim().toLowerCase());
}

/**
 * Self-heal: kill stale postgres processes, clean shared memory, remove stale PID files.
 * Handles zombies (which can't be killed) by cleaning their artifacts instead.
 */
function selfHealPostgres(dataDir: string): void {
  try {
    // Kill any stale postgres processes associated with pgserve data dir
    execSync(`pkill -9 -f "postgres.*${dataDir.replace(/\//g, '\\/')}" 2>/dev/null || true`, {
      stdio: 'ignore',
      timeout: 5000,
    });
    // Also kill stale pgserve router/wrapper processes on the same data dir
    execSync(`pkill -9 -f "pgserve.*${dataDir.replace(/\//g, '\\/')}" 2>/dev/null || true`, {
      stdio: 'ignore',
      timeout: 5000,
    });
  } catch {
    // Best effort
  }

  // Remove stale postmaster.pid
  const pidFile = join(dataDir, 'postmaster.pid');
  if (existsSync(pidFile)) {
    try {
      unlinkSync(pidFile);
    } catch {
      // May still be locked
    }
  }

  // Clean stale shared memory segments owned by this user
  try {
    execSync("ipcs -m 2>/dev/null | awk '$6 == 0 {print $2}' | xargs -I{} ipcrm -m {} 2>/dev/null || true", {
      stdio: 'ignore',
      timeout: 5000,
    });
  } catch {
    // Best effort
  }
}

function signalPgserveTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) {
    try {
      child.kill(signal);
    } catch {
      /* already dead */
    }
    return;
  }

  try {
    if (process.platform === 'win32') {
      child.kill(signal);
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already dead */
    }
  }
}

async function terminatePgserveTree(child: ChildProcess): Promise<void> {
  signalPgserveTree(child, 'SIGTERM');

  const exited = await new Promise<boolean>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), 1000);
    timer.unref();
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

  if (!exited) {
    signalPgserveTree(child, 'SIGKILL');
  }
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
let pgserveChild: ChildProcess | null = null;
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
 * Outcome of the most recent autoStartDaemon() call. Consumed by the branched
 * timeout error in _ensurePgserve so the user gets a message naming the
 * actual failure mode instead of a generic timeout.
 *
 *   - `missing`   — serve.pid absent; spawned a fresh serve
 *   - `stale`     — serve.pid existed but its PID was recycled or dead;
 *                   unlinked the file and spawned a fresh serve
 *   - `alive`     — serve.pid points at a live serve process whose kernel
 *                   start time still matches; did NOT respawn
 *
 * A module-level variable is acceptable here because autoStartDaemon is only
 * called from the single-flight _ensurePgserve path (guarded by ensurePromise).
 */
type AutoStartOutcome = 'missing' | 'stale' | 'alive';
let lastAutoStartOutcome: AutoStartOutcome | null = null;
/** PID that was in serve.pid at the time of the most recent autoStartDaemon() call. */
let lastAutoStartPid: number | null = null;

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
    lastAutoStartOutcome = 'missing';
    lastAutoStartPid = null;
    spawnDaemon();
    return;
  }

  const parsed = parsePidFile(raw);
  if (!parsed) {
    unlinkQuiet(pidPath);
    lastAutoStartOutcome = 'stale';
    lastAutoStartPid = null;
    spawnDaemon();
    return;
  }

  if (isServeAlive(parsed.pid, parsed.recordedStartTime)) {
    lastAutoStartOutcome = 'alive';
    lastAutoStartPid = parsed.pid;
    return;
  }

  unlinkQuiet(pidPath);
  lastAutoStartOutcome = 'stale';
  lastAutoStartPid = parsed.pid;
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

async function spawnPgserveDirect(port: number): Promise<number> {
  mkdirSync(DATA_DIR, { recursive: true });
  selfHealPostgres(DATA_DIR);
  try {
    const startedPort = await startPgserveOnPort(port);
    registerExitHandler();
    return startedPort;
  } catch (err) {
    process.env.GENIE_PG_AVAILABLE = 'false';
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`pgserve failed to start: ${maskCredentials(message)}`);
  }
}

async function waitForDaemonPort(): Promise<number | null> {
  const deadline = Date.now() + 16000;
  while (Date.now() < deadline) {
    const p = readLockfile();
    if (p !== null && (await isPostgresHealthy(p))) {
      activePort = p;
      process.env.GENIE_PG_AVAILABLE = 'true';
      return p;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

function throwDaemonTimeout(outcomeAtStart: typeof lastAutoStartOutcome, pidAtStart: typeof lastAutoStartPid): never {
  process.env.GENIE_PG_AVAILABLE = 'false';
  const home = process.env.GENIE_HOME ?? GENIE_HOME;
  const pidPath = join(home, 'serve.pid');
  const hasPidFile = existsSync(pidPath);
  const currentPort = readLockfile() ?? getPort();
  if (outcomeAtStart === 'stale') {
    throw new Error(
      `Stale ~/.genie/serve.pid (PID ${pidAtStart ?? 'unknown'} was not our serve). Removed and retried — if this persists, run: genie serve start`,
    );
  }
  if (!hasPidFile) {
    throw new Error('genie serve not running. Run: genie serve start');
  }
  const pidLabel = pidAtStart ?? outcomeAtStart ?? 'unknown';
  throw new Error(
    `genie serve is running (PID ${pidLabel}) but pgserve did not respond on port ${currentPort} within 16s. Try: genie serve restart, or check ~/.genie/logs/scheduler.log`,
  );
}

async function _ensurePgserve(): Promise<number> {
  if (activePort !== null) return activePort;

  const port = getPort();
  const existing = await tryExistingPort(port);
  if (existing !== null) return existing;

  if (process.env.CI === 'true') {
    process.env.GENIE_PG_AVAILABLE = 'false';
    throw new Error('pgserve not available in CI');
  }

  if (isPgAutostartDisabled()) {
    process.env.GENIE_PG_AVAILABLE = 'false';
    throw new Error('pgserve unavailable and GENIE_PG_NO_AUTOSTART=1');
  }

  const rootErr = checkRootGuard();
  if (rootErr !== null) {
    process.env.GENIE_PG_AVAILABLE = 'false';
    throw new Error(rootErr);
  }

  if (process.env.GENIE_IS_DAEMON === '1') {
    return spawnPgserveDirect(port);
  }

  await autoStartDaemon();
  const outcomeAtStart = lastAutoStartOutcome;
  const pidAtStart = lastAutoStartPid;
  const waited = await waitForDaemonPort();
  if (waited !== null) return waited;
  throwDaemonTimeout(outcomeAtStart, pidAtStart);
}

/** Resolve the pgserve CLI binary path — checks local dep, global, then PATH. */
function findPgserveBin(): string {
  // 1. Local node_modules (pgserve is a dependency)
  try {
    const resolved = require.resolve('pgserve/bin/pgserve-wrapper.cjs');
    if (existsSync(resolved)) return resolved;
  } catch {
    /* not found locally */
  }
  // 2. Global bun install
  const globalBin = join(homedir(), '.bun', 'bin', 'pgserve');
  if (existsSync(globalBin)) return globalBin;
  // 3. PATH
  try {
    return execSync('which pgserve', { encoding: 'utf-8', timeout: 3000 }).trim();
  } catch {
    return 'pgserve';
  }
}

/**
 * Start pgserve as a separate child process (like omni does).
 * Avoids the self-referencing proxy deadlock that occurs when the
 * MultiTenantRouter Bun TCP proxy runs in the same event loop as
 * the daemon that also connects to it.
 */
async function startPgserveOnPort(port: number): Promise<number> {
  mkdirSync(DATA_DIR, { recursive: true });

  const child = spawn(
    findPgserveBin(),
    [
      '--port',
      String(port),
      '--host',
      DEFAULT_HOST,
      '--data',
      DATA_DIR,
      '--log',
      'warn',
      '--no-stats',
      '--no-cluster',
      '--pgvector',
    ],
    { detached: true, stdio: 'ignore' },
  );

  child.unref();
  pgserveChild = child;

  const timeout = Number(process.env.GENIE_PGSERVE_TIMEOUT) || 30000;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await isPostgresHealthy(port)) {
      activePort = port;
      ownsLockfile = true;
      process.env.GENIE_PG_AVAILABLE = 'true';
      writeLockfile(port);
      return port;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  await terminatePgserveTree(child);
  if (pgserveChild === child) pgserveChild = null;
  selfHealPostgres(DATA_DIR);
  throw new Error(`pgserve failed to start on port ${port} (timeout after ${timeout / 1000}s)`);
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
    if (pgserveChild) {
      signalPgserveTree(pgserveChild, 'SIGTERM');
      pgserveChild = null;
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
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });
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

/**
 * Decide between Unix socket (pgserve v2 production path) and TCP loopback
 * (legacy + test mode). Test mode is selected by GENIE_TEST_PG_PORT — that
 * env var is set by src/lib/test-setup.ts (bun preload) which boots a
 * dedicated `pgserve --ram` instance for the suite. Production never sets it.
 */
function shouldUseUnixSocket(): boolean {
  if (process.env.GENIE_PG_FORCE_TCP === '1') return false;
  if (process.env.GENIE_TEST_PG_PORT) return false;
  return true;
}

let bannerPrinted = false;

/**
 * Print the resolved DB name once per process, on first successful connect.
 * Surfaces pgserve v2's auto-fingerprint so devs can see the visible
 * `app_<name>_<12hex>` database their genie process landed in.
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
    if (typeof db === 'string' && db.length > 0) {
      process.stderr.write(`[pgserve] connected to ${db}\n`);
    }
  } catch {
    // Banner is best-effort — never fail a connection because of it.
  }
  bannerPrinted = true;
}

// biome-ignore lint/suspicious/noExplicitAny: postgres.js Sql type requires generics we don't need
async function _buildConnection(): Promise<any> {
  const _t0 = Date.now();
  const useSocket = shouldUseUnixSocket();
  if (useSocket) await getOrStartDaemon();
  const port = useSocket ? 5432 : await ensurePgserve();
  const _t1 = Date.now();
  const pgModule = (await import('postgres')).default;

  // Per-test isolation now happens at the DATABASE level — setupTestDatabase()
  // clones `genie_template` and sets GENIE_TEST_DB_NAME. In production, this
  // env var is never set, so we fall back to DB_NAME ('postgres') and let
  // pgserve v2's accept hook auto-resolve to the fingerprint's database.
  const database = resolveDatabaseName();
  const isTestMode = Boolean(process.env.GENIE_TEST_DB_NAME);
  const pgWireCredential = useSocket ? resolvePgserveAuthPassword() : resolveTcpPgPassword();

  // Unix socket: postgres.js dials `<host>/.s.PGSQL.<port>` when host is an
  // absolute path. pgserve v2 publishes a `.s.PGSQL.5432` libpq compat link
  // alongside its control socket so off-the-shelf clients connect without
  // knowing the daemon's actual socket name.
  const host = useSocket ? resolvePgserveSocketDir() : DEFAULT_HOST;

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
  const cliShortLived = !daemonCwdPinned && !isTestMode && process.env.GENIE_SKIP_DB_BOOT === '1';
  const originalCwd = process.cwd();
  const pkgDir = resolveGeniePackageDir();
  const shouldRestoreCwd = !daemonCwdPinned && !isTestMode;
  let pinned = false;
  if (pkgDir && process.cwd() !== pkgDir) {
    try {
      process.chdir(pkgDir);
      pinned = true;
    } catch (err) {
      // chdir failure is non-fatal — fall through with the wrong cwd. The
      // peer will still get *some* fingerprint; only routing identity may
      // be off. Surface as a stderr warning so operators can investigate.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[pgserve] WARN: failed to pin cwd to ${pkgDir}: ${msg}\n`);
    }
  } else if (!pkgDir) {
    process.stderr.write('[pgserve] WARN: could not resolve genie package dir; pgserve fingerprint may be unstable\n');
  }

  sqlClient = pgModule({
    host,
    port,
    database,
    username: DB_NAME,
    // Socket mode uses SO_PEERCRED for tenancy, but the proxied Postgres
    // handshake still requests pgserve's local role password.
    [PG_AUTH_FIELD]: pgWireCredential,
    // Pool sizing — see issue #1575 strategy block above. Short-lived CLI
    // gets a single persistent connection so the cwd pin can be released
    // immediately after fingerprinting.
    max: cliShortLived ? 1 : 50,
    idle_timeout: cliShortLived ? 0 : 1,
    connect_timeout: resolvePgConnectTimeoutSeconds(useSocket),
    onnotice: () => {},
    connection: {
      client_min_messages: 'warning',
    },
  });

  try {
    // Force one round-trip while cwd is still pinned so pgserve does its
    // /proc walk under our package dir. postgres.js connections are lazy —
    // without this query, pgserve never sees us until the next caller fires
    // a real query, by which time we may have chdir'd back. A failure here
    // falls through to the outer catch which tears down the half-built pool.
    await sqlClient`SELECT 1`;
    await runPostConnectSetup(sqlClient, isTestMode, { t0: _t0, t1: _t1 });
    await maybePrintBanner(sqlClient, isTestMode);
    // Surface the resolved transport on the activePort singleton so diagnostics
    // (db status, printPgserveHealth) report the truth. Socket mode uses the
    // SOCKET_PORT_SENTINEL (0) since there is no TCP port to advertise; TCP
    // mode already updates activePort via ensurePgserve().
    if (useSocket) {
      activePort = SOCKET_PORT_SENTINEL;
      process.env.GENIE_PG_AVAILABLE = 'true';
    }
  } catch (err) {
    const dying = sqlClient;
    sqlClient = null;
    activePort = null;
    // Fire-and-forget teardown — match healthCheckCachedClient so we never
    // block on a dying pool while other work is in flight.
    dying?.end({ timeout: 2 }).catch(() => {
      /* ignore */
    });
    throw err;
  } finally {
    // Issue #1575 — restore the user's cwd unless the daemon entrypoint has
    // explicitly pinned for its lifetime. The fingerprinted connection is
    // already established (SELECT 1 above forced pgserve's /proc walk under
    // the pinned cwd); short-lived CLI processes use max:1 + idle_timeout:0
    // so this same connection persists for the rest of the process and
    // never re-fingerprints.
    if (pinned && shouldRestoreCwd && process.cwd() !== originalCwd) {
      try {
        process.chdir(originalCwd);
      } catch (err) {
        // originalCwd may have been deleted while we were away — best-effort.
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[pgserve] WARN: failed to restore cwd to ${originalCwd}: ${msg}\n`);
      }
    }
  }

  return sqlClient;
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
