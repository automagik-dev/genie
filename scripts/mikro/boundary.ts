#!/usr/bin/env bun
/**
 * scripts/mikro/boundary.ts — the execution boundary for the mikro REPL.
 *
 *   bun scripts/mikro/boundary.ts --probe [--dir <repo>] [--no-evidence]
 *
 * `call.ts --boundary bwrap` runs `mikro mcp` inside an unprivileged bubblewrap
 * sandbox instead of on the bare host. Three things live here and nothing else:
 *
 *   1. `bwrapArgv` — a PURE argv builder. It touches no filesystem and spawns
 *      nothing, so the whole mount/env policy is unit-testable (`boundary.test.ts`)
 *      on a host that has no bwrap at all.
 *   2. `startEgressProxy` — the one hole in `--unshare-net`: a host-side HTTP
 *      CONNECT proxy on a unix socket under the run's scratch dir, allowlisted by
 *      `host:port`, which logs EVERY attempt (allowed or not) as one JSON line to
 *      `<ledger>/egress.jsonl`. Inside the sandbox `socat` republishes that socket
 *      on 127.0.0.1 so `HTTPS_PROXY` can point at it.
 *   3. `--probe` — deterministic negative tests with an UNCONTAINED control arm,
 *      printed as a differential table and appended to `EVIDENCE-boundary.md`.
 *
 * The boundary stops writes to the SOURCE tree and connections to unknown hosts.
 * It deliberately does NOT hide what an obeyed injection attempted: the ledger
 * dir (`<dir>/.mikro/runs`, which holds the file-vector canary) and the bench's
 * prompt-vector canary root are bound READ-WRITE, so an executed side effect
 * still lands where `adversarial.ts` looks for it. A boundary that hid the
 * canary would blind the very bench that measures injection.
 *
 * Fail-closed by construction: every resolution failure throws `BoundaryError`
 * with a named cause and the run aborts. `bwrap` mode never downgrades to `none`.
 *
 * Credentials never reach argv: the sandbox environment is handed to the bwrap
 * PROCESS (`boundaryEnv`), not written as `--setenv`, because `/proc/<pid>/cmdline`
 * is world-readable and `--setenv DEEPSEEK_API_KEY …` would publish the key to
 * every user on the host for the life of the run.
 */
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { type Server, type Socket, createServer, connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

// ─── Errors ──────────────────────────────────────────────

export type BoundaryFailure =
  /** `bwrap` is not on PATH. */
  | 'bwrap-missing'
  /** `socat` (the in-sandbox republisher of the proxy socket) is not on PATH. */
  | 'socat-missing'
  /** `mikro`, `node` or the host settings file could not be resolved. */
  | 'runtime-missing'
  /** The proxy could not bind its unix socket. */
  | 'socket-unavailable'
  /** A path handed to the builder is not absolute. */
  | 'bad-spec'
  /** `bwrap <binds> -- /bin/true` did not exit 0 (user namespaces disabled, a bind that does not exist). */
  | 'preflight-failed';

/** Every boundary failure is typed and named; nothing here ever falls back to running uncontained. */
export class BoundaryError extends Error {
  constructor(
    readonly failure: BoundaryFailure,
    message: string,
  ) {
    super(message);
    this.name = 'BoundaryError';
  }
}

// ─── The argv builder (pure) ─────────────────────────────

export type BoundaryMode = 'none' | 'bwrap';

export function isBoundaryMode(value: string): value is BoundaryMode {
  return value === 'none' || value === 'bwrap';
}

/**
 * The system trees bound read-only. Started from a `--ro-bind / /` prototype and
 * narrowed to what `mikro --version` and the agents' git/gh helpers actually need
 * inside; `/etc` is here for `ca-certificates`, `resolv.conf` and `passwd`.
 */
export const SYSTEM_RO_BINDS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc'];

/** Loopback port socat listens on INSIDE the sandbox. The network namespace is private, so a constant cannot collide. */
export const SANDBOX_PROXY_PORT = 8118;

/** `ulimit -u`: enough for node + socat + the REPL's `subprocess` children, far below a fork bomb. */
export const DEFAULT_MAX_PROCS = 256;
/** `ulimit -v` in KiB (4 GiB): node v26 reserves a large virtual arena, so this is a ceiling, not a working-set budget. */
export const DEFAULT_MAX_VIRTUAL_KB = 4_194_304;

export interface BoundarySpec {
  /** The repository under `--dir`: bound READ-ONLY. */
  dir: string;
  /** `git rev-parse --git-common-dir` of `dir`, bound read-only — a worktree's `.git` is a file pointing here. */
  gitCommonDir: string | null;
  /** `MIKRO_AGENTS_DIR`, bound read-only when it is outside `dir`. */
  agentsDir: string | null;
  /** The host HOME path; replaced by a tmpfs at the same path. */
  home: string;
  /** The mikro runtime root (`~/.mikro/mikro`), read-only. */
  mikroRoot: string;
  /** The real launcher inside `mikroRoot` (`bin/mikro.mjs`). */
  mikroLauncher: string;
  /** Where `mikro` must appear on PATH; recreated as a symlink to `mikroLauncher` (never a bind — the launcher resolves its root from its own path). */
  mikroCommandPath: string;
  /** Host-side generated settings file, bound read-only at `<home>/.mikro/settings.json`. */
  settingsFile: string;
  /** The node install root that runs the launcher, read-only; its `bin` goes on PATH. */
  nodeRoot: string;
  /** This run's scratch dir (holds the proxy socket), bound READ-WRITE. */
  scratch: string;
  /** The proxy's unix socket, inside `scratch`. */
  socket: string;
  /** Extra READ-WRITE binds: the ledger dir and the bench canary root, each justified in the README. */
  writable: string[];
  systemRo: string[];
  env: Record<string, string>;
  /** The command exec'd inside, e.g. `['mikro','mcp','--dir',dir]`. */
  command: string[];
  proxyPort: number;
  maxProcs: number;
  maxVirtualKb: number;
  socatPath: string;
  shellPath: string;
  /** Absolute path to bwrap, resolved once on the host: argv[0] is never left to a PATH lookup. */
  bwrapPath: string;
}

/** POSIX single-quote quoting: the only escaping the inner `sh -c` payload needs. */
export function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

function requireAbsolute(label: string, value: string): string {
  if (!isAbsolute(value))
    throw new BoundaryError('bad-spec', `${label} must be an absolute path, got ${value || '(empty)'}`);
  return value;
}

/**
 * The MOUNT policy, in the order bwrap applies it — ordering is load-bearing: the
 * HOME tmpfs must land before anything bound underneath it, and a read-write bind
 * must land after the read-only bind it punches through.
 *
 * No `--setenv` and no `--clearenv` appear here, deliberately. `--setenv` would put
 * `DEEPSEEK_API_KEY` and `GH_TOKEN` in bwrap's own argv, and `/proc/<pid>/cmdline`
 * is world-readable — every other user on the host would be able to read the key
 * out of `ps` for as long as the run lasts. The sandbox environment is instead
 * handed to the bwrap PROCESS (`boundaryEnv`), which forwards it to the child, so
 * the secret lives in `/proc/<pid>/environ` (owner-only) exactly as it already does
 * on the uncontained path. The guarantee is unchanged — the environment is declared
 * in full, never inherited — because the spawn replaces the whole environment.
 */
export function bindArgs(spec: BoundarySpec): string[] {
  requireAbsolute('home', spec.home);
  requireAbsolute('dir', spec.dir);
  requireAbsolute('scratch', spec.scratch);
  requireAbsolute('socket', spec.socket);
  const argv = ['--unshare-all', '--die-with-parent', '--new-session', '--proc', '/proc', '--dev', '/dev'];
  for (const path of spec.systemRo) argv.push('--ro-bind', requireAbsolute('systemRo', path), path);
  argv.push('--tmpfs', '/tmp');
  // HOME is a tmpfs at the same path: mikro's ~/.mikro/sessions store is writable and discarded
  // with the sandbox, and nothing else of HOME exists unless it is bound back below.
  argv.push('--tmpfs', spec.home);
  argv.push('--ro-bind', requireAbsolute('mikroRoot', spec.mikroRoot), spec.mikroRoot);
  argv.push(
    '--ro-bind',
    requireAbsolute('settingsFile', spec.settingsFile),
    join(spec.home, '.mikro', 'settings.json'),
  );
  argv.push(
    '--symlink',
    requireAbsolute('mikroLauncher', spec.mikroLauncher),
    requireAbsolute('mikroCommandPath', spec.mikroCommandPath),
  );
  argv.push('--ro-bind', requireAbsolute('nodeRoot', spec.nodeRoot), spec.nodeRoot);
  argv.push('--ro-bind', spec.dir, spec.dir);
  if (spec.gitCommonDir) argv.push('--ro-bind', requireAbsolute('gitCommonDir', spec.gitCommonDir), spec.gitCommonDir);
  if (spec.agentsDir) argv.push('--ro-bind', requireAbsolute('agentsDir', spec.agentsDir), spec.agentsDir);
  for (const path of spec.writable) argv.push('--bind', requireAbsolute('writable', path), path);
  argv.push('--bind', spec.scratch, spec.scratch);
  argv.push('--chdir', spec.dir);
  return argv;
}

/**
 * The environment the bwrap PROCESS is spawned with, and therefore the whole
 * environment the contained runtime sees. Never `--setenv` (see `bindArgs`).
 */
export function boundaryEnv(spec: BoundarySpec): Record<string, string> {
  return { ...spec.env };
}

/**
 * The payload `bash -c` runs inside: resource limits, then socat republishing the
 * host proxy socket on 127.0.0.1 (the only reachable address under `--unshare-net`),
 * then `exec` of the real command so the sandbox's PID 1 IS the runtime and
 * `--die-with-parent` reaches it.
 */
export function innerCommand(spec: BoundarySpec): string {
  const socat = `${shellQuote(spec.socatPath)} TCP-LISTEN:${spec.proxyPort},bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${shellQuote(spec.socket)}`;
  const ready = `for _ in 1 2 3 4 5 6 7 8 9 10; do (exec 3<>/dev/tcp/127.0.0.1/${spec.proxyPort}) 2>/dev/null && break; sleep 0.2; done`;
  return [
    `ulimit -u ${spec.maxProcs}`,
    `ulimit -v ${spec.maxVirtualKb}`,
    `${socat} >/dev/null 2>&1 &`,
    ready,
    `exec ${spec.command.map(shellQuote).join(' ')}`,
  ].join('\n');
}

/** The full sandbox argv. The ONE place a contained child's command line is assembled. */
export function bwrapArgv(spec: BoundarySpec): string[] {
  return [spec.bwrapPath, ...bindArgs(spec), '--', spec.shellPath, '-c', innerCommand(spec)];
}

/** The same mounts with no proxy and no payload: `bwrap … -- /bin/true`, the launch that must succeed before anything is spawned. */
export function preflightArgv(spec: BoundarySpec): string[] {
  return [spec.bwrapPath, ...bindArgs(spec), '--', '/bin/true'];
}

// ─── The egress proxy ────────────────────────────────────

/**
 * Where a contained REPL may connect. Derived from what the agents actually call:
 * `api.deepseek.com` is the provider baseUrl in `.mikro/mikro.yaml`, and
 * `api.github.com` is every read-only `gh` verb the three SYSTEM.md starter blocks
 * expose (`gh issue view`, `gh pr list`, `gh search`, `gh api` without a method) —
 * `gh` speaks to the API host, never to github.com, for all of them.
 */
export const DEFAULT_EGRESS_ALLOW = ['api.deepseek.com:443', 'api.github.com:443'];

export interface EgressTarget {
  host: string;
  port: number;
}

export interface EgressAttempt extends EgressTarget {
  ts: string;
  runId: string;
  allowed: boolean;
}

/** The CONNECT line of a proxy request, or null when this is not a CONNECT (which the proxy refuses). */
export function parseConnectRequest(head: string): EgressTarget | null {
  const line = (head.split('\r\n')[0] ?? '').trim();
  const match = /^CONNECT\s+([A-Za-z0-9._-]+):(\d{1,5})\s+HTTP\/1\.[01]$/.exec(line);
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: match[1].toLowerCase(), port };
}

/** The `Host:` header of a non-CONNECT request, so a refused attempt is still logged by name. */
export function hostHeaderTarget(head: string): EgressTarget {
  const match = /^host:\s*([A-Za-z0-9._-]+)(?::(\d{1,5}))?\s*$/im.exec(head);
  if (!match) return { host: 'unknown', port: 0 };
  return { host: match[1].toLowerCase(), port: match[2] ? Number(match[2]) : 80 };
}

/** Exact `host:port` membership — no wildcards, no suffix matching, so `evil-api.deepseek.com.attacker.net` can never pass. */
export function isEgressAllowed(target: EgressTarget, allow: readonly string[]): boolean {
  return allow.includes(`${target.host.toLowerCase()}:${target.port}`);
}

/** One JSON line per attempt; the ledger is append-only and holds no payload, only the decision. */
export function egressLogLine(attempt: EgressAttempt): string {
  return `${JSON.stringify({
    ts: attempt.ts,
    runId: attempt.runId,
    host: attempt.host,
    port: attempt.port,
    allowed: attempt.allowed,
  })}\n`;
}

export const PROXY_DENIED_RESPONSE =
  'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\nX-Mikro-Boundary: denied\r\n\r\n';
export const PROXY_ESTABLISHED_RESPONSE = 'HTTP/1.1 200 Connection established\r\n\r\n';

export interface EgressProxy {
  readonly socketPath: string;
  counts(): { allowed: number; denied: number };
  close(): Promise<void>;
}

interface ProxyOptions {
  socketPath: string;
  logPath: string;
  runId: string;
  allow?: readonly string[];
}

function readHead(socket: Socket, onHead: (head: string, rest: Buffer) => void): void {
  let buf = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) {
      if (buf.length > 8192) socket.destroy();
      return;
    }
    socket.off('data', onData);
    // Pause before handing over: the upstream connect is async, and a flowing
    // socket with no listener would drop the bytes that arrive in between.
    socket.pause();
    onHead(buf.subarray(0, end + 4).toString('latin1'), buf.subarray(end + 4));
  };
  socket.on('data', onData);
}

/**
 * The host side of the one network hole. Connections arrive over a unix socket
 * bound into the sandbox; a CONNECT to an allowlisted `host:port` is spliced to
 * the real host, anything else gets 403. Every attempt is logged before the
 * decision is acted on, so a denial is never silent.
 */
export function startEgressProxy(options: ProxyOptions): Promise<EgressProxy> {
  const allow = options.allow ?? DEFAULT_EGRESS_ALLOW;
  const counts = { allowed: 0, denied: 0 };
  mkdirSync(dirname(options.logPath), { recursive: true });
  const record = (target: EgressTarget, allowed: boolean) => {
    if (allowed) counts.allowed++;
    else counts.denied++;
    appendFileSync(
      options.logPath,
      egressLogLine({ ts: new Date().toISOString(), runId: options.runId, ...target, allowed }),
    );
  };
  // Every socket this proxy owns, tracked so `close()` can end deterministically:
  // `server.close()` waits for open connections, and a half-closed tunnel would
  // otherwise leave the runner hanging after the sandbox is already gone.
  const live = new Set<Socket>();
  const track = (socket: Socket) => {
    live.add(socket);
    socket.on('close', () => live.delete(socket));
  };
  const server: Server = createServer((socket) => {
    track(socket);
    socket.on('error', () => socket.destroy());
    readHead(socket, (head, rest) => {
      const target = parseConnectRequest(head);
      if (!target || !isEgressAllowed(target, allow)) {
        record(target ?? hostHeaderTarget(head), false);
        socket.end(PROXY_DENIED_RESPONSE);
        return;
      }
      record(target, true);
      const upstream = netConnect({ host: target.host, port: target.port });
      track(upstream);
      upstream.on('error', () => socket.destroy());
      upstream.on('connect', () => {
        socket.write(PROXY_ESTABLISHED_RESPONSE);
        if (rest.length) upstream.write(rest);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
    });
  });
  return new Promise((resolvePromise, rejectPromise) => {
    server.once('error', (error: NodeJS.ErrnoException) =>
      rejectPromise(
        new BoundaryError(
          'socket-unavailable',
          `the egress proxy could not bind ${options.socketPath}: ${error.message}`,
        ),
      ),
    );
    server.listen(options.socketPath, () => {
      resolvePromise({
        socketPath: options.socketPath,
        counts: () => ({ ...counts }),
        close: () =>
          new Promise<void>((done) => {
            for (const socket of live) socket.destroy();
            live.clear();
            server.close(() => done());
          }),
      });
    });
  });
}

// ─── Host-side resolution ────────────────────────────────

function which(binary: string, failure: BoundaryFailure): string {
  const found = Bun.which(binary);
  if (!found) throw new BoundaryError(failure, `${binary} is not on PATH — \`--boundary bwrap\` cannot run without it`);
  return found;
}

/** `git rev-parse --path-format=absolute --git-common-dir`: a worktree's `.git` is a file pointing into the main repo, which must be readable inside. */
export function gitCommonDirOf(dir: string): string | null {
  const probe = Bun.spawnSync(['git', '-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (probe.exitCode !== 0) return null;
  const path = probe.stdout.toString().trim();
  return path && isAbsolute(path) && existsSync(path) ? path : null;
}

/**
 * The settings file the sandbox sees: the host's `providers:` block and the model
 * selection, nothing else. Generated rather than bound so a host file that later
 * grows a literal key or an unrelated section cannot reach the sandbox.
 */
export function sandboxSettings(hostSettings: unknown): Record<string, unknown> {
  const source = (hostSettings ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ['model.provider', 'model.model', 'model.sub-call-model'])
    if (key in source) out[key] = source[key];
  out.providers = source.providers ?? {};
  return out;
}

export interface OpenBoundaryOptions {
  dir: string;
  agentsDir?: string | null;
  runId: string;
  /** Where `egress.jsonl` is appended, host-side: the gitignored `<trustedRoot>/.mikro/runs`. */
  ledgerDir: string;
  /** Extra read-write binds (the bench's canary root). `<dir>/.mikro/runs` is always added. */
  writable?: string[];
  allow?: readonly string[];
  /** Credentials and `MIKRO_*` the contained runtime needs; merged into the sandbox environment. */
  env?: Record<string, string>;
  home?: string;
}

export interface BoundarySession {
  readonly mode: 'bwrap';
  readonly spec: BoundarySpec;
  /** The full argv for one contained command; the caller never assembles one itself. */
  argv(command: string[]): string[];
  /** The environment the bwrap process is spawned with — the credentials go here, never into argv. */
  readonly env: Record<string, string>;
  counts(): { allowed: number; denied: number };
  close(): Promise<void>;
}

/**
 * The environment inside the sandbox. `--clearenv` empties it first, so this is the
 * WHOLE environment the runtime sees: no caller tokens, no SSH agent, and the proxy
 * pair that makes the one allowed network hole reachable.
 */
export function sandboxEnv(
  paths: { home: string; mikroCommandPath: string; nodeRoot: string; proxyPort: number },
  extra: Record<string, string>,
): Record<string, string> {
  const proxy = `http://127.0.0.1:${paths.proxyPort}`;
  return {
    HOME: paths.home,
    PATH: `${dirname(paths.mikroCommandPath)}:${join(paths.nodeRoot, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: '/tmp',
    SHELL: '/bin/bash',
    LANG: process.env.LANG ?? 'C.UTF-8',
    // node v26 honours a proxy from the environment only when this is set, and the
    // `openai` client mikro uses runs on global fetch — this pair is what makes the
    // provider reachable at all inside `--unshare-net`.
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    NO_PROXY: '',
    NODE_USE_ENV_PROXY: '1',
    ...extra,
  };
}

/**
 * Resolve every host path, generate the settings copy, start the proxy and prove
 * the mounts work — in that order, so a failure aborts before anything is spawned.
 */
export async function openBoundary(options: OpenBoundaryOptions): Promise<BoundarySession> {
  const bwrapPath = which('bwrap', 'bwrap-missing');
  const socatPath = which('socat', 'socat-missing');
  const home = options.home ?? process.env.HOME ?? '';
  requireAbsolute('home', home);
  const mikroCommandPath = which('mikro', 'runtime-missing');
  const mikroLauncher = realpathSync(mikroCommandPath);
  const mikroRoot = resolve(dirname(mikroLauncher), '..');
  const nodeRoot = resolve(dirname(realpathSync(which('node', 'runtime-missing'))), '..');
  const hostSettings = join(home, '.mikro', 'settings.json');
  if (!existsSync(hostSettings))
    throw new BoundaryError(
      'runtime-missing',
      `${hostSettings} is missing — the sandbox has no provider configuration to copy`,
    );
  const dir = resolve(options.dir);
  const scratch = mkdtempSync(join(tmpdir(), 'mikro-boundary-'));
  const settingsFile = join(scratch, 'settings.json');
  writeFileSync(
    settingsFile,
    `${JSON.stringify(sandboxSettings(JSON.parse(readFileSync(hostSettings, 'utf8'))), null, 2)}\n`,
  );
  const runsDir = join(dir, '.mikro', 'runs');
  mkdirSync(runsDir, { recursive: true });
  const agentsDir = options.agentsDir ? resolve(options.agentsDir) : null;
  const socket = join(scratch, 'egress.sock');
  const spec: BoundarySpec = {
    dir,
    gitCommonDir: gitCommonDirOf(dir),
    agentsDir: agentsDir && !agentsDir.startsWith(`${dir}/`) ? agentsDir : null,
    home,
    mikroRoot,
    mikroLauncher,
    mikroCommandPath,
    settingsFile,
    nodeRoot,
    scratch,
    socket,
    writable: [runsDir, ...(options.writable ?? []).map((p) => resolve(p))],
    systemRo: SYSTEM_RO_BINDS.filter((p) => existsSync(p)),
    env: sandboxEnv({ home, mikroCommandPath, nodeRoot, proxyPort: SANDBOX_PROXY_PORT }, options.env ?? {}),
    command: [],
    proxyPort: SANDBOX_PROXY_PORT,
    maxProcs: DEFAULT_MAX_PROCS,
    maxVirtualKb: DEFAULT_MAX_VIRTUAL_KB,
    socatPath,
    shellPath: '/bin/bash',
    bwrapPath,
  };
  const proxy = await startEgressProxy({
    socketPath: socket,
    logPath: join(options.ledgerDir, 'egress.jsonl'),
    runId: options.runId,
    allow: options.allow,
  });
  const preflight = Bun.spawnSync(preflightArgv(spec), { stdout: 'pipe', stderr: 'pipe', env: boundaryEnv(spec) });
  if (preflight.exitCode !== 0) {
    await proxy.close();
    rmSync(scratch, { recursive: true, force: true });
    throw new BoundaryError(
      'preflight-failed',
      `bwrap could not start the sandbox (exit ${preflight.exitCode}): ${preflight.stderr.toString().trim().slice(0, 300)}`,
    );
  }
  return {
    mode: 'bwrap',
    spec,
    argv: (command) => bwrapArgv({ ...spec, command }),
    env: boundaryEnv(spec),
    counts: () => proxy.counts(),
    close: async () => {
      await proxy.close();
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

// ─── Probes ──────────────────────────────────────────────

export interface ProbeRow {
  probe: string;
  arm: 'boundary' | 'control';
  expected: string;
  observed: string;
  ok: boolean;
}

/** A digest of what git can see, so "the source tree is unchanged" is a comparison, not an assertion. */
export function treeDigest(dir: string): string {
  const status = Bun.spawnSync(['git', '-C', dir, 'status', '--porcelain']).stdout.toString();
  const files = Bun.spawnSync(['git', '-C', dir, 'ls-files']).stdout.toString();
  return createHash('sha256').update(status).update(' ').update(files).digest('hex').slice(0, 16);
}

/**
 * Async on purpose: the egress proxy runs on THIS process's event loop, so a
 * `Bun.spawnSync` here would block the accept loop and every proxied probe would
 * time out against a proxy that was simply never scheduled.
 */
async function runContained(session: BoundarySession, command: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(session.argv(command), { stdout: 'pipe', stderr: 'pipe', env: session.env });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: `${out}${err}`.trim() };
}

function row(probe: string, arm: ProbeRow['arm'], expected: string, observed: string, ok: boolean): ProbeRow {
  return { probe, arm, expected, observed: observed.replace(/\s+/g, ' ').slice(0, 120), ok };
}

/** A throwaway git repo for the control arm — the real checkout is NEVER the target of a write probe. */
function throwawayRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'mikro-control-'));
  Bun.spawnSync(['git', 'init', '-q', root]);
  writeFileSync(join(root, 'README.md'), 'control arm\n');
  Bun.spawnSync(['git', '-C', root, 'add', 'README.md']);
  Bun.spawnSync(['git', '-C', root, '-c', 'user.email=probe@local', '-c', 'user.name=probe', 'commit', '-qm', 'init']);
  return root;
}

async function probeWriteToRepo(session: BoundarySession, dir: string): Promise<ProbeRow[]> {
  const before = treeDigest(dir);
  const target = join(dir, '.boundary-probe');
  const contained = await runContained(session, ['sh', '-c', `echo x > ${shellQuote(target)}`]);
  const after = treeDigest(dir);
  const refused = contained.code !== 0 && /read-only file system/i.test(contained.out);
  const rows = [
    row(
      'write-to-repo',
      'boundary',
      'write refused, EROFS',
      `exit ${contained.code}: ${contained.out || '(no output)'}`,
      refused && !existsSync(target),
    ),
    row('write-to-repo', 'boundary', `tree digest unchanged (${before})`, after, before === after),
  ];
  const control = throwawayRepo();
  const controlTarget = join(control, '.boundary-probe');
  const uncontained = Bun.spawnSync(['sh', '-c', `echo x > ${shellQuote(controlTarget)}`], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  rows.push(
    row(
      'write-to-repo',
      'control',
      'write succeeds uncontained',
      `exit ${uncontained.exitCode}, file ${existsSync(controlTarget) ? 'created' : 'absent'}`,
      uncontained.exitCode === 0 && existsSync(controlTarget),
    ),
  );
  rmSync(control, { recursive: true, force: true });
  return rows;
}

/**
 * `HTTPS_PROXY` is set INSIDE the sandbox, so a bare `curl` there would quietly use
 * the proxy and prove nothing about the network namespace. The direct arms clear
 * every proxy variable first: what they measure is `--unshare-net` alone.
 */
const NO_PROXY_ENV = [
  'env',
  '-u',
  'HTTP_PROXY',
  '-u',
  'HTTPS_PROXY',
  '-u',
  'http_proxy',
  '-u',
  'https_proxy',
  '-u',
  'ALL_PROXY',
];

/** The last decision the proxy wrote for this host, read back from the ledger the run appends to. */
function lastEgressDecision(logPath: string, host: string): boolean | null {
  if (!existsSync(logPath)) return null;
  const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
  for (const line of lines.reverse()) {
    try {
      const entry = JSON.parse(line) as { host?: string; allowed?: boolean };
      if (entry.host === host) return entry.allowed ?? null;
    } catch {
      // a truncated line is not a decision
    }
  }
  return null;
}

async function probeEgress(session: BoundarySession, allow: readonly string[], logPath: string): Promise<ProbeRow[]> {
  const proxy = `http://127.0.0.1:${session.spec.proxyPort}`;
  const allowedHost = allow[0]?.split(':')[0] ?? 'api.deepseek.com';
  const curl = (args: string[]) => ['curl', '-sS', '-o', '/dev/null', '-w', '%{http_code}', ...args];
  const direct = await runContained(session, [...NO_PROXY_ENV, ...curl(['-m', '5', 'https://example.com'])]);
  const noProxyEnv = await runContained(session, [...NO_PROXY_ENV, ...curl(['-m', '5', `https://${allowedHost}/`])]);
  const denied = await runContained(session, curl(['-m', '10', '-x', proxy, 'https://example.com']));
  const permitted = await runContained(session, curl(['-m', '20', '-x', proxy, `https://${allowedHost}/`]));
  const control = Bun.spawnSync(curl(['-m', '10', 'https://example.com']), { stdout: 'pipe', stderr: 'pipe' });
  return [
    row(
      'egress-direct',
      'boundary',
      'unreachable with the proxy env cleared',
      `exit ${direct.code}: ${direct.out || '(no output)'}`,
      direct.code !== 0,
    ),
    row(
      'egress-needs-proxy-env',
      'boundary',
      `${allowedHost} unreachable without the proxy env`,
      `exit ${noProxyEnv.code}: ${noProxyEnv.out || '(no output)'}`,
      noProxyEnv.code !== 0,
    ),
    row(
      'egress-denied',
      'boundary',
      '403 from the proxy, logged allowed:false',
      `${denied.out || `exit ${denied.code}`} · ledger ${lastEgressDecision(logPath, 'example.com')}`,
      denied.out.includes('403') && lastEgressDecision(logPath, 'example.com') === false,
    ),
    row(
      'egress-allowed',
      'boundary',
      `CONNECT completes to ${allowedHost} (any status), logged allowed:true`,
      `${permitted.out || `exit ${permitted.code}`} · ledger ${lastEgressDecision(logPath, allowedHost)}`,
      permitted.code === 0 && lastEgressDecision(logPath, allowedHost) === true,
    ),
    row(
      'egress-direct',
      'control',
      'direct curl succeeds uncontained',
      `exit ${control.exitCode}: ${control.stdout.toString().trim()}`,
      control.exitCode === 0,
    ),
  ];
}

async function probeSecrets(session: BoundarySession, home: string): Promise<ProbeRow[]> {
  const targets = [
    join(home, '.config', 'gh', 'hosts.yml'),
    join(home, '.claude'),
    join(home, '.mikro', 'gate-env.sh'),
  ];
  const script = targets
    .map((t) => `if [ -e ${shellQuote(t)} ]; then echo "VISIBLE ${t}"; else echo "absent ${t}"; fi`)
    .join('\n');
  const contained = await runContained(session, ['sh', '-c', script]);
  return [
    row(
      'secrets-not-visible',
      'boundary',
      'every path absent',
      contained.out || `exit ${contained.code}`,
      !/VISIBLE/.test(contained.out),
    ),
    row(
      'secrets-not-visible',
      'control',
      'the same paths exist on the host',
      targets.map((t) => `${existsSync(t) ? 'present' : 'absent'}`).join(', '),
      targets.some((t) => existsSync(t)),
    ),
  ];
}

/** What a thrown value looks like in the table, and whether it is the typed failure this probe expects. */
function failureOf(run: () => unknown, expected: BoundaryFailure): { observed: string; ok: boolean } {
  try {
    run();
  } catch (error) {
    if (error instanceof BoundaryError)
      return { observed: `BoundaryError(${error.failure})`, ok: error.failure === expected };
    return { observed: `${(error as Error).name}: ${(error as Error).message}`, ok: false };
  }
  return { observed: 'no error thrown', ok: false };
}

async function probeFailsClosed(spec: BoundarySpec): Promise<ProbeRow[]> {
  let socketRow = { observed: 'no error thrown', ok: false };
  try {
    const leaked = await startEgressProxy({
      socketPath: '/nonexistent-boundary-root/egress.sock',
      logPath: join(tmpdir(), 'mikro-boundary-probe-egress.jsonl'),
      runId: 'probe',
    });
    await leaked.close();
  } catch (error) {
    socketRow =
      error instanceof BoundaryError
        ? { observed: `BoundaryError(${error.failure})`, ok: error.failure === 'socket-unavailable' }
        : { observed: `${(error as Error).name}: ${(error as Error).message}`, ok: false };
  }
  const specRow = failureOf(() => bindArgs({ ...spec, home: 'relative/home' }), 'bad-spec');
  return [
    row(
      'launch-fails-closed',
      'boundary',
      'BoundaryError(socket-unavailable), no fallback',
      socketRow.observed,
      socketRow.ok,
    ),
    row(
      'launch-fails-closed',
      'boundary',
      'BoundaryError(bad-spec) on a non-absolute path',
      specRow.observed,
      specRow.ok,
    ),
  ];
}

export function probeTable(rows: ProbeRow[]): string {
  return [
    '| probe | arm | expected | observed | verdict |',
    '|---|---|---|---|---|',
    ...rows.map(
      (r) => `| ${r.probe} | ${r.arm} | ${r.expected} | ${r.observed.replace(/\|/g, '/')} | ${r.ok ? '✔' : '✖'} |`,
    ),
  ].join('\n');
}

const EVIDENCE_PREAMBLE = `# mikro execution boundary — evidence

Every row below is a real probe run recorded by \`bun scripts/mikro/boundary.ts --probe\`; nothing is
estimated. The \`boundary\` arm runs inside bubblewrap, the \`control\` arm runs the SAME check
uncontained (against a throwaway git repo for the write probe — never the real checkout), so a row is
only evidence when its control arm shows the check would otherwise have passed.
`;

export function appendBoundaryEvidence(path: string, rows: ProbeRow[], note: string): void {
  const header = existsSync(path) ? '' : EVIDENCE_PREAMBLE;
  appendFileSync(
    path,
    `${header}\n## ${new Date().toISOString().slice(0, 16)}Z — ${note}\n\n${probeTable(rows)}\n\n${rows.filter((r) => !r.ok).length} failing expectation(s) of ${rows.length}.\n`,
  );
}

async function runProbes(dir: string, writeEvidence: boolean): Promise<number> {
  const home = process.env.HOME ?? '';
  const session = await openBoundary({
    dir,
    runId: `probe-${Date.now()}`,
    ledgerDir: join(dir, '.mikro', 'runs'),
    env: {},
  });
  let rows: ProbeRow[];
  try {
    rows = [
      ...(await probeWriteToRepo(session, dir)),
      ...(await probeEgress(session, DEFAULT_EGRESS_ALLOW, join(dir, '.mikro', 'runs', 'egress.jsonl'))),
      ...(await probeSecrets(session, home)),
    ];
  } finally {
    await session.close();
  }
  rows.push(...(await probeFailsClosed(session.spec)));
  process.stdout.write(`${probeTable(rows)}\n`);
  const failures = rows.filter((r) => !r.ok);
  process.stdout.write(`\n${rows.length - failures.length}/${rows.length} expectations met\n`);
  if (writeEvidence)
    appendBoundaryEvidence(
      join(dirname(new URL(import.meta.url).pathname), 'EVIDENCE-boundary.md'),
      rows,
      `${Bun.spawnSync(['bwrap', '--version']).stdout.toString().trim() || 'bwrap unknown'} · dir \`${dir}\``,
    );
  return failures.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (!argv.includes('--probe')) {
    process.stderr.write('usage: bun scripts/mikro/boundary.ts --probe [--dir <repo>] [--no-evidence]\n');
    process.exit(2);
  }
  const dirIndex = argv.indexOf('--dir');
  const dir = resolve(dirIndex >= 0 ? (argv[dirIndex + 1] ?? '.') : '.');
  process.exit(await runProbes(dir, !argv.includes('--no-evidence')));
}
