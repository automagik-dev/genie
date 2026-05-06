import { execSync, spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { chmod, copyFile, mkdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { genieConfigExists, loadGenieConfig, saveGenieConfig } from '../lib/genie-config.js';
import { VERSION } from '../lib/version.js';
import { type CleanupReport, cleanupLegacyArtifacts, parseSkipCleanupFlag } from './legacy-cleanup.js';

const GENIE_HOME = process.env.GENIE_HOME || join(homedir(), '.genie');
const GENIE_SRC = join(GENIE_HOME, 'src');
const GENIE_BIN = join(GENIE_HOME, 'bin');
const LOCAL_BIN = join(homedir(), '.local', 'bin');
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/**
 * Diagnostics schema version. Bump on every additive change so consumers
 * branch on `schemaVersion` rather than file presence.
 *
 * - v1 (pre-update-unify-stages): `update`, `runtime`, `paths`, `processSnapshot`,
 *   `maintenance`, `recentLogSignals`.
 * - v2 (this wish): adds `verify: VerifyResult` and `cleanups: CleanupReport`
 *   blocks. Existing v1 fields preserved byte-identically.
 *
 * Genie's number diverges from omni's (omni stays at v1) per
 * SHARED-DESIGN.md decision #4 — each repo evolves its own schema.
 */
const UPDATE_DIAGNOSTIC_SCHEMA_VERSION = 2;

/** Verify probe deadline. Wish §10: 15s — genie's daemon stack (pgserve +
 *  scheduler + tmux) takes longer to bounce than pm2-managed processes. */
const VERIFY_PROBE_DEADLINE_MS = 15_000;
const VERIFY_PROBE_POLL_INTERVAL_MS = 500;
const FETCH_LATEST_TIMEOUT_MS = 5_000;

// ============================================================================
// Verify decision shape — shared with omni#update-unify-stages (SHARED-DESIGN §4.3).
// `decideVerify` is a pure function so the tagged-union outcome can be unit-tested
// in isolation from the daemon-probe side effects. The `auth-invalid` variant is
// reserved for cross-CLI shape parity (omni has auth; genie does not) — it exists
// in the type but `decideVerify` never returns it for genie inputs today.
// ============================================================================

export type VerifySkipReason = 'no-restart' | 'no-running-services' | 'no-verify-flag';

export type VerifyResult =
  | { kind: 'ok'; cliVersion: string; serverVersion: string | null }
  | { kind: 'health-unreachable'; endpoint: string }
  | { kind: 'version-mismatch'; cliVersion: string; serverVersion: string | null }
  | { kind: 'daemon-stale-inode'; cliVersion: string; diskVersion: string | null; pid: number; cwd: string }
  | { kind: 'auth-invalid' }
  | { kind: 'skipped'; reason: VerifySkipReason };

export interface ServerHealthBody {
  version?: string | null;
  /**
   * Linux-only. `true` when `/proc/<pid>/cwd` ends with the kernel `(deleted)`
   * marker — i.e. bun's package swap during update unlinked the directory the
   * pm2 genie-serve process was launched from. The daemon is still serving
   * pre-update bytes from the open inode and needs `pm2 restart genie-serve`
   * (or our `restartServeIfStale` helper) to pick up the new code.
   *
   * Non-Linux: always `false` (no `/proc` to probe). On those platforms the
   * verify probe falls back to optimistic same-version inference.
   */
  daemonInodeStale?: boolean;
  /** Daemon pid surfaced for the `daemon-stale-inode` variant's banner. */
  daemonPid?: number;
  /** Raw `/proc/<pid>/cwd` readlink result, surfaced for diagnostics. */
  daemonCwd?: string;
}

export interface DecideVerifyArgs {
  cliVersion: string;
  serverHealthBody: ServerHealthBody | null;
  endpoint: string;
  skipReason?: VerifySkipReason | null;
}

/**
 * Strip build metadata (anything after `+`) so a `4.260504.21+abc1234` CLI build
 * compares equal to the `4.260504.21` registry-published string. Mirrors omni's
 * `normalizeVersion` helper.
 */
export function normalizeVersion(value: string): string {
  const trimmed = value.trim();
  const plusIdx = trimmed.indexOf('+');
  return plusIdx === -1 ? trimmed : trimmed.slice(0, plusIdx);
}

export function decideVerify(args: DecideVerifyArgs): VerifyResult {
  if (args.skipReason) {
    return { kind: 'skipped', reason: args.skipReason };
  }
  if (args.serverHealthBody === null) {
    return { kind: 'health-unreachable', endpoint: args.endpoint };
  }
  const cliVersion = normalizeVersion(args.cliVersion);
  const rawServerVersion = args.serverHealthBody.version ?? null;
  const serverVersion = rawServerVersion === null ? null : normalizeVersion(rawServerVersion);
  // Inode-stale wins over plain version-mismatch because it's a stronger
  // signal: the daemon's running bytes don't match disk regardless of what
  // the version string says. Operators get a more actionable banner
  // ("run pm2 restart") instead of a generic mismatch.
  if (args.serverHealthBody.daemonInodeStale === true) {
    return {
      kind: 'daemon-stale-inode',
      cliVersion,
      diskVersion: serverVersion,
      pid: args.serverHealthBody.daemonPid ?? 0,
      cwd: args.serverHealthBody.daemonCwd ?? '',
    };
  }
  if (serverVersion === null || serverVersion !== cliVersion) {
    return { kind: 'version-mismatch', cliVersion, serverVersion };
  }
  return { kind: 'ok', cliVersion, serverVersion };
}

// ============================================================================
// Group 3 — pre-flight registry version check + confirmation prompt + `--yes`.
// Both helpers are pure (the network call is split out) so the decision logic
// is unit-testable independent of the registry round-trip.
// ============================================================================

/**
 * Compare a current install to the registry-published version. Both inputs are
 * normalized (build metadata stripped) before comparison so a `4.260504.21+sha`
 * CLI build matches the `4.260504.21` registry string.
 *
 * Returns `true` only when both strings normalize equal AND `latestVersion`
 * is non-null. A null/empty `latestVersion` (network failure, parse error)
 * conservatively returns `false` so the caller proceeds with the update —
 * never block on a transient registry hiccup.
 */
export function shortCircuitIfCurrent(currentVersion: string, latestVersion: string | null | undefined): boolean {
  if (!latestVersion) return false;
  return normalizeVersion(currentVersion) === normalizeVersion(latestVersion);
}

/**
 * Resolve the registry-published version for a channel. Calls
 * `bunx npm view @automagik/genie@<channel> version` (so we ride whatever
 * registry config is already set up — npm/bun share the auth + registry
 * config in practice). Returns `null` on any failure: missing tools, network
 * timeout, parse error, empty stdout. Caller treats null as "proceed with
 * install" — defensive against the operator being offline mid-update.
 */
export async function fetchLatestVersion(channel: string): Promise<string | null> {
  const candidates = [
    { cmd: 'npm', args: ['view', `@automagik/genie@${channel}`, 'version'] },
    { cmd: 'bunx', args: ['npm', 'view', `@automagik/genie@${channel}`, 'version'] },
  ];
  for (const { cmd, args } of candidates) {
    const result = await runCommandSilent(cmd, args, undefined, FETCH_LATEST_TIMEOUT_MS);
    if (!result.success) continue;
    const trimmed = result.output.trim();
    if (!trimmed) continue;
    // Take the last non-empty token — `npm view` may print the package name on
    // some setups; the version is always the trailing token.
    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    const lastLine = lines[lines.length - 1];
    const tokens = lastLine.split(/\s+/);
    const candidate = tokens[tokens.length - 1].replace(/^['"]|['"]$/g, '');
    if (/^\d+\.\d+/.test(candidate)) return candidate;
  }
  return null;
}

/**
 * TTY confirmation prompt. Auto-confirms in non-TTY environments so CI
 * pipelines never hang waiting for stdin. The `--yes` / `GENIE_UPDATE_YES`
 * caller-side bypass is checked before this function runs (see
 * `shouldAutoConfirm`); this helper is the actual stdin read.
 */
async function promptConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return true;
  process.stdout.write(`${question} [Y/n] `);
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      process.stdin.removeListener('data', onData);
      process.stdin.pause();
      const answer = chunk.toString('utf-8').trim().toLowerCase();
      // Empty (just Enter) defaults to yes.
      if (answer === '' || answer === 'y' || answer === 'yes') resolve(true);
      else resolve(false);
    };
    process.stdin.resume();
    process.stdin.once('data', onData);
  });
}

/** Bypass logic for the prompt: `--yes` flag OR `GENIE_UPDATE_YES` env. */
function shouldAutoConfirm(opts: { yes?: boolean }): boolean {
  if (opts.yes) return true;
  return isTruthyEnv(process.env.GENIE_UPDATE_YES);
}

// ============================================================================
// Group 4 — post-restart verify probe via genie doctor / pgserve health.
// `runVerifyProbe` is the I/O wrapper; it polls until the deadline, then
// hands the parsed health body to `decideVerify` (the pure decider above).
// ============================================================================

const VERIFY_PROBE_ENDPOINT = 'pgserve status --json + ~/.genie/serve.pid';

interface VerifyProbeOptions {
  cliVersion: string;
  skipReason?: VerifySkipReason | null;
  /**
   * Test seam: synchronous read of the probe result. Production callers leave
   * this undefined; tests inject a stub to exercise the I/O wrapping without a
   * live daemon.
   */
  readHealth?: () => Promise<ServerHealthBody | null>;
  /** Test seam: shorten the poll deadline. Production uses
   *  `VERIFY_PROBE_DEADLINE_MS`. */
  deadlineMs?: number;
  /** Test seam: shorten the poll interval. Production uses
   *  `VERIFY_PROBE_POLL_INTERVAL_MS`. */
  intervalMs?: number;
}

/**
 * Daemon health probe. Tries pgserve's `status --json` and falls back to the
 * scheduler PID + serve.pid existence. Returns a `ServerHealthBody` with the
 * detected version, or `null` when no daemon is reachable.
 *
 * Why we don't shell out to `genie doctor` directly: doctor's main flow is
 * text-only (the `--json` mode covers `--observability` / `--fix-team-orphans`
 * sub-flows, not the top-level health). A thin probe is faster and avoids the
 * "doctor recurses into update which spawns doctor" pitfall.
 */
/**
 * Linux-only daemon-inode probe. After bun's package swap during update, the
 * pm2 `genie-serve` process keeps running from a deleted directory inode; the
 * kernel reports the cwd readlink as `<path> (deleted)`. That's our cheap,
 * reliable signal that the daemon needs `pm2 restart genie-serve` to re-exec
 * from the live bytes.
 *
 * Returns `null` on non-Linux (no `/proc`) or on readlink failure (race with
 * pid reaping, EACCES, etc.). Callers MUST treat null as "can't determine"
 * and fall through to the optimistic same-version inference rather than
 * blocking the update.
 */
function readDaemonCwd(pid: number): { cwd: string; staleInode: boolean } | null {
  if (process.platform !== 'linux') return null;
  try {
    const cwd = readlinkSync(`/proc/${pid}/cwd`);
    return { cwd, staleInode: cwd.endsWith(' (deleted)') };
  } catch {
    return null;
  }
}

/**
 * Resolve the on-disk `@automagik/genie` `package.json` version. We have no
 * RPC channel to ask the running daemon "what's your VERSION constant" — so
 * we read whatever's at the install dir and combine it with the inode-stale
 * signal: when the cwd is NOT deleted, the daemon's runtime bytes equal the
 * on-disk version; when it IS deleted, the version we read here is what the
 * daemon SHOULD be running once restarted.
 *
 * Two candidate paths cover the two install topologies (bun-global, npm-global).
 * Returns the calling CLI's compiled-in `VERSION` when no install metadata
 * resolves — preserves the pre-fix tautology only as a last-resort fallback,
 * not as the canonical source of truth.
 */
function readInstalledPackageVersion(): string | null {
  const candidates: string[] = [
    join(homedir(), '.bun', 'install', 'global', 'node_modules', '@automagik', 'genie', 'package.json'),
  ];
  const npmPrefix = safeExec('npm prefix -g', 1500);
  if (npmPrefix) {
    candidates.push(join(npmPrefix, 'lib', 'node_modules', '@automagik', 'genie', 'package.json'));
  }
  for (const path of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(path, 'utf-8')) as { version?: unknown };
      if (typeof pkg.version === 'string' && /^\d+\.\d+/.test(pkg.version)) return pkg.version;
    } catch {
      // try next candidate
    }
  }
  return null;
}

async function readServerHealth(): Promise<ServerHealthBody | null> {
  // Step 1: pgserve must answer status (this is the canonical backbone check
  // every other genie subsystem depends on). If pgserve is down, nothing else
  // matters.
  const pgServeStatus = await runCommandSilent('pgserve', ['status', '--json'], undefined, 3000);
  if (!pgServeStatus.success) return null;

  // Step 2: serve.pid must exist AND the pid must be alive.
  const pidPath = join(GENIE_HOME, 'serve.pid');
  const rawPid = safeRead(pidPath, 32);
  if (!rawPid) return null;
  const pid = Number.parseInt(rawPid.trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0); // signal 0 = aliveness probe, throws if dead
  } catch {
    return null;
  }

  // Step 3: detect inode staleness on Linux + read the on-disk package version.
  // Pre-fix this returned `{ version: VERSION }` (the calling CLI's compile-time
  // constant) which made `verify` a tautology — it could not distinguish a
  // post-update daemon running stale code from a healthy one. The new probe
  // reads `/proc/<pid>/cwd` to detect the bun-package-swap-leaves-deleted-inode
  // case, AND reads the disk package.json so the reported `version` reflects
  // what's actually installed rather than what the calling CLI was compiled with.
  const cwdInfo = readDaemonCwd(pid);
  const diskVersion = readInstalledPackageVersion() ?? VERSION;
  return {
    version: diskVersion,
    daemonInodeStale: cwdInfo?.staleInode ?? false,
    daemonPid: pid,
    daemonCwd: cwdInfo?.cwd,
  };
}

/**
 * Poll `readHealth` until the deadline expires. First successful read wins;
 * a stream of nulls returns `null` so `decideVerify` can emit
 * `health-unreachable`.
 */
async function pollHealth(
  readHealth: () => Promise<ServerHealthBody | null>,
  deadlineMs: number,
  intervalMs: number,
): Promise<ServerHealthBody | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < deadlineMs) {
    let body: ServerHealthBody | null = null;
    try {
      body = await readHealth();
    } catch {
      // Reader threw — treat as unreachable. Same outcome as a `null` read.
    }
    if (body !== null) return body;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

export async function runVerifyProbe(opts: VerifyProbeOptions): Promise<VerifyResult> {
  if (opts.skipReason) {
    return decideVerify({
      cliVersion: opts.cliVersion,
      serverHealthBody: null,
      endpoint: VERIFY_PROBE_ENDPOINT,
      skipReason: opts.skipReason,
    });
  }
  const reader = opts.readHealth ?? readServerHealth;
  const deadline = opts.deadlineMs ?? VERIFY_PROBE_DEADLINE_MS;
  const interval = opts.intervalMs ?? VERIFY_PROBE_POLL_INTERVAL_MS;
  const body = await pollHealth(reader, deadline, interval);
  return decideVerify({
    cliVersion: opts.cliVersion,
    serverHealthBody: body,
    endpoint: VERIFY_PROBE_ENDPOINT,
  });
}

// ============================================================================
// Group 6 (follow-up to update-unify-stages): pm2 genie-serve restart on stale
// inode. After bun's package swap, the daemon is still mapped to the old
// (deleted) `node_modules/@automagik/genie/.old-<hash>` directory. Without
// this step, every `genie update` left the daemon serving pre-update bytes
// until the operator manually ran `pm2 restart genie-serve` — the verify
// probe couldn't even surface it because `readServerHealth` was a tautology.
// ============================================================================

interface Pm2GenieServe {
  pid: number;
  restartCount: number;
}

/**
 * pm2 introspection: look for a `genie-serve` entry and return its current
 * pid + restart counter. We shell out to `pm2 jlist` (the documented stable
 * JSON output) instead of importing pm2 because pm2 is not bundled with
 * genie — operators install it separately, and many environments (CI, source
 * runs) don't have it at all.
 *
 * Returns `null` when pm2 is missing, errors out, or no `genie-serve` entry
 * is registered. The caller treats null as "no pm2 supervision in play —
 * nothing to restart".
 */
async function pm2GenieServe(): Promise<Pm2GenieServe | null> {
  const result = await runCommandSilent('pm2', ['jlist'], undefined, 3000);
  if (!result.success) return null;
  try {
    const list = JSON.parse(result.output) as Array<{
      name?: string;
      pid?: number;
      pm2_env?: { restart_time?: number; status?: string };
    }>;
    const entry = list.find((p) => p.name === 'genie-serve');
    if (!entry || typeof entry.pid !== 'number' || entry.pid <= 0) return null;
    if (entry.pm2_env?.status !== 'online') return null;
    return { pid: entry.pid, restartCount: entry.pm2_env?.restart_time ?? 0 };
  } catch {
    return null;
  }
}

/**
 * Restart pm2 `genie-serve` when its current pid is mapped to a deleted
 * inode (post-bun-package-swap state). No-op when:
 * - pm2 is missing or has no `genie-serve` entry (source installs, CI)
 * - the daemon is already on the live inode (no-op update, manual restart
 *   already performed, non-Linux where we can't probe `/proc`)
 * - the restart command itself fails (we surface the error and let verify
 *   catch the still-stale state)
 *
 * Returns `{ oldPid, newPid }` on a successful restart with new pid observed,
 * or `null` when no restart was needed/possible.
 */
export async function restartServeIfStale(): Promise<{ oldPid: number; newPid: number } | null> {
  const before = await pm2GenieServe();
  if (!before) return null;
  const cwdInfo = readDaemonCwd(before.pid);
  if (!cwdInfo || !cwdInfo.staleInode) return null;
  log(`Restarting pm2 genie-serve (stale inode detected: ${cwdInfo.cwd})`);
  const restartResult = await runCommandSilent('pm2', ['restart', 'genie-serve', '--update-env'], undefined, 10_000);
  if (!restartResult.success) {
    error('pm2 restart genie-serve failed; daemon will keep serving pre-update bytes until manually restarted');
    return null;
  }
  // Poll pm2 for a new pid. We watch BOTH pid change (typical case) AND
  // restart-count increment (covers the edge case where pm2 reuses a pid
  // briefly during the restart cycle).
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const after = await pm2GenieServe();
    if (after && (after.pid !== before.pid || after.restartCount > before.restartCount)) {
      success(`pm2 genie-serve restarted (pid ${before.pid} → ${after.pid})`);
      return { oldPid: before.pid, newPid: after.pid };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  error('pm2 genie-serve restart did not produce a new pid within 10s — verify probe will surface the stale state');
  return null;
}

/** Format the post-restart 3-line banner. Genie has no auth model, so the
 *  auth row from omni's banner is omitted. */
export function formatVerifyBanner(result: VerifyResult): string[] {
  const lines: string[] = [];
  switch (result.kind) {
    case 'ok':
      lines.push(`${colorize('\x1b[32m', '\x1b[0m', '✔')} CLI:    v${result.cliVersion}`);
      lines.push(`${colorize('\x1b[32m', '\x1b[0m', '✔')} Server: v${result.serverVersion} (healthy)`);
      break;
    case 'health-unreachable':
      lines.push(`${colorize('\x1b[33m', '\x1b[0m', '!')} CLI:    v${VERSION}`);
      lines.push(`${colorize('\x1b[31m', '\x1b[0m', '✖')} Server: unreachable (probe: ${result.endpoint})`);
      break;
    case 'version-mismatch':
      lines.push(`${colorize('\x1b[32m', '\x1b[0m', '✔')} CLI:    v${result.cliVersion}`);
      lines.push(`${colorize('\x1b[31m', '\x1b[0m', '✖')} Server: v${result.serverVersion ?? 'unknown'} (mismatch)`);
      break;
    case 'daemon-stale-inode':
      lines.push(`${colorize('\x1b[32m', '\x1b[0m', '✔')} CLI:    v${result.cliVersion}`);
      lines.push(
        `${colorize('\x1b[31m', '\x1b[0m', '✖')} Server: stale inode (pid ${result.pid}, on-disk v${result.diskVersion ?? 'unknown'})`,
      );
      lines.push(`${colorize('\x1b[2m', '\x1b[0m', `  cwd: ${result.cwd}`)}`);
      lines.push(`${colorize('\x1b[2m', '\x1b[0m', '  fix: pm2 restart genie-serve --update-env')}`);
      break;
    case 'auth-invalid':
      lines.push(`${colorize('\x1b[31m', '\x1b[0m', '✖')} Auth: invalid`);
      break;
    case 'skipped':
      lines.push(`${colorize('\x1b[32m', '\x1b[0m', '✔')} CLI:    v${VERSION}`);
      lines.push(`${colorize('\x1b[2m', '\x1b[0m', `· Server: v… (skipped: ${result.reason})`)}`);
      break;
  }
  return lines;
}

// ============================================================================
// Output primitives — direct ANSI today; will migrate to output.ts (the
// `output-primitives-unified` wish) in a follow-up so the whole CLI shares one
// chalk/ora abstraction. NO_COLOR is honored here so behavior already matches
// the post-migration contract (see `colorize` below).
// ============================================================================

function colorEnabled(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return Boolean(process.stdout.isTTY);
}

function colorize(open: string, close: string, text: string): string {
  return colorEnabled() ? `${open}${text}${close}` : text;
}

function log(message: string): void {
  console.log(`${colorize('\x1b[32m', '\x1b[0m', '▸')} ${message}`);
}

function success(message: string): void {
  console.log(`${colorize('\x1b[32m', '\x1b[0m', '✔')} ${message}`);
}

function error(message: string): void {
  console.log(`${colorize('\x1b[31m', '\x1b[0m', '✖')} ${message}`);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function isTruthyEnv(value: string | undefined): boolean {
  return value !== undefined && TRUTHY.has(value.trim().toLowerCase());
}

async function withTemporaryEnv<T>(key: string, value: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env[key];
  process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}

interface PluginSyncInfo {
  version?: string;
  globalPkgDir?: string;
  cacheDir?: string;
  skippedReason?: string;
}

interface UpdateDiagnosticsContext {
  channel: string;
  installType: InstallationType;
  primaryMethod: 'npm' | 'bun';
  globalInstalls: Array<'npm' | 'bun'>;
  plugin: PluginSyncInfo;
  /** Latest registry version observed pre-flight, or null when fetch failed. */
  latestVersion: string | null;
  /** Local CLI version at the time the diagnostics file was written. */
  cliVersion: string;
}

interface RecentLogSignal {
  level: string;
  event: string;
  count: number;
  lastTimestamp?: string;
  lastError?: string;
}

function safeExec(command: string, timeoutMs = 1500): string {
  try {
    return execSync(command, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    }).trim();
  } catch (err) {
    const stdout = (err as { stdout?: unknown }).stdout;
    if (typeof stdout === 'string' && stdout.trim()) return stdout.trim();
    return '';
  }
}

function safeRead(path: string, maxChars = 4000): string | null {
  try {
    const value = readFileSync(path, 'utf-8');
    if (value.length <= maxChars) return value;
    return value.slice(value.length - maxChars);
  } catch {
    return null;
  }
}

function tailLines(path: string, maxBytes = 64_000, maxLines = 200): string[] {
  let fd: number | null = null;
  try {
    const stat = statSync(path);
    const bytesToRead = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(bytesToRead);
    fd = openSync(path, 'r');
    readSync(fd, buffer, 0, bytesToRead, Math.max(0, stat.size - bytesToRead));
    const tail = buffer.toString('utf-8');
    return tail
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-maxLines);
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function summarizeJsonlSignals(path: string): RecentLogSignal[] {
  const signals = new Map<string, RecentLogSignal>();
  for (const line of tailLines(path)) {
    try {
      const event = JSON.parse(line) as { level?: unknown; event?: unknown; timestamp?: unknown; error?: unknown };
      const level = typeof event.level === 'string' ? event.level : 'unknown';
      if (level !== 'error' && level !== 'warn') continue;
      const name = typeof event.event === 'string' ? event.event : 'unknown';
      const key = `${level}:${name}`;
      const existing = signals.get(key) ?? { level, event: name, count: 0 };
      existing.count++;
      if (typeof event.timestamp === 'string') existing.lastTimestamp = event.timestamp;
      if (typeof event.error === 'string') existing.lastError = event.error;
      signals.set(key, existing);
    } catch {
      // Non-JSON log lines are kept in the raw tail, not summarized here.
    }
  }
  return [...signals.values()].sort((a, b) => b.count - a.count).slice(0, 10);
}

interface UpdateDiagnosticsExtras {
  verify: VerifyResult;
  cleanups: CleanupReport;
}

async function collectUpdateDiagnostics(
  ctx: UpdateDiagnosticsContext,
  maintenance: { outcome: 'completed' | 'failed'; durationMs: number; lines: string[]; error?: string },
  extras: UpdateDiagnosticsExtras,
): Promise<{ path: string; signals: RecentLogSignal[] }> {
  const logsDir = join(GENIE_HOME, 'logs');
  mkdirSync(logsDir, { recursive: true });
  const generatedAt = new Date().toISOString();
  const safeStamp = generatedAt.replace(/[:.]/g, '-');
  const path = join(logsDir, `update-diagnostics-${safeStamp}.json`);
  const schedulerLog = join(logsDir, 'scheduler.log');
  const tuiCrashLog = join(logsDir, 'tui-crash.log');
  const signals = summarizeJsonlSignals(schedulerLog);

  const diagnostics = {
    schemaVersion: UPDATE_DIAGNOSTIC_SCHEMA_VERSION,
    cli: 'genie',
    generatedAt,
    verify: extras.verify,
    cleanups: extras.cleanups,
    update: ctx,
    runtime: {
      platform: process.platform,
      arch: process.arch,
      cwd: process.cwd(),
      node: process.version,
      bun: (await runCommandSilent('bun', ['--version'])).output.trim() || null,
      npm: (await runCommandSilent('npm', ['--version'])).output.trim() || null,
      genie: {
        which: (await runCommandSilent('which', ['genie'])).output.trim() || null,
        tuiDisabled: isTruthyEnv(process.env.GENIE_TUI_DISABLE),
        updateSkipMaintenance: isTruthyEnv(process.env.GENIE_UPDATE_SKIP_MAINTENANCE),
      },
    },
    paths: {
      genieHome: GENIE_HOME,
      logsDir,
      servePid: safeRead(join(GENIE_HOME, 'serve.pid'), 200),
      pgservePort: safeRead(join(GENIE_HOME, 'pgserve.port'), 200),
      schedulerLog,
      tuiCrashLog,
    },
    processSnapshot: {
      genie:
        safeExec(
          "ps -axo pid,ppid,pgid,stat,pcpu,pmem,etime,command -r | rg -i 'dist/genie.js|/src/genie.ts|pgserve|postgres -D .*\\.genie/data/pgserve|tmux -L genie-tui|bun' || true",
          2000,
        ) || null,
      tuiTmux: safeExec('tmux -L genie-tui ls 2>/dev/null || true', 1000) || null,
    },
    maintenance: {
      ...maintenance,
      pgAutostartDisabled: true,
      legend: {
        '[ok]': 'healthy',
        '[fix]': 'fixed during maintenance',
        '[--]': 'skipped/non-blocking',
        '[!!]': 'operator action needed; update still completed',
      },
    },
    recentLogSignals: {
      scheduler: signals,
      schedulerTail: tailLines(schedulerLog, 32_000, 80),
      tuiCrashTail: tailLines(tuiCrashLog, 32_000, 80),
    },
  };

  writeFileSync(path, `${JSON.stringify(diagnostics, null, 2)}\n`);
  return { path, signals };
}

async function runCommand(
  command: string,
  args: string[],
  cwd?: string,
): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    const output: string[] = [];

    const child = spawn(command, args, {
      cwd,
      stdio: ['inherit', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '1' },
    });

    child.stdout?.on('data', (data) => {
      const str = data.toString();
      output.push(str);
      process.stdout.write(str);
    });

    child.stderr?.on('data', (data) => {
      const str = data.toString();
      output.push(str);
      process.stderr.write(str);
    });

    child.on('close', (code) => {
      resolve({ success: code === 0, output: output.join('') });
    });

    child.on('error', (err) => {
      error(err.message);
      resolve({ success: false, output: err.message });
    });
  });
}

async function getGitInfo(cwd: string): Promise<{ branch: string; commit: string; commitDate: string } | null> {
  try {
    const branchResult = await runCommandSilent('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    const commitResult = await runCommandSilent('git', ['rev-parse', '--short', 'HEAD'], cwd);
    const dateResult = await runCommandSilent('git', ['log', '-1', '--format=%ci'], cwd);

    if (branchResult.success && commitResult.success && dateResult.success) {
      return {
        branch: branchResult.output.trim(),
        commit: commitResult.output.trim(),
        commitDate: dateResult.output.trim().split(' ')[0], // Just the date part
      };
    }
  } catch {
    // Ignore errors
  }
  return null;
}

async function runCommandSilent(
  command: string,
  args: string[],
  cwd?: string,
  timeoutMs = 4000,
): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    const output: string[] = [];
    let settled = false;

    const child = spawn(command, args, {
      cwd,
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve({ success: false, output: `Timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout?.on('data', (data) => {
      output.push(data.toString());
    });

    child.stderr?.on('data', (data) => {
      output.push(data.toString());
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ success: code === 0, output: output.join('') });
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ success: false, output: err.message });
    });
  });
}

type InstallationType = 'source' | 'npm' | 'bun' | 'unknown';

/**
 * Detect installation type from the binary path returned by `which genie`.
 *
 * Group 7 fix: realpath the input first. The standard CLI install symlinks
 * `~/.local/bin/genie → ~/.bun/bin/genie → ~/.bun/install/global/.../dist/genie.js`
 * mean the literal `which` output is the symlink path, not the resolved target.
 * Pre-fix, `~/.local/bin/genie` matched the `LOCAL_BIN` source-install branch
 * even when the actual binary lived in `node_modules`, breaking
 * `genie update --next` for bun-installed users with `ENOENT: posix_spawn 'git'`
 * because the source-install path then tried to `git fetch` against a
 * non-existent `~/.genie/src/` directory.
 */
export function detectFromBinaryPath(path: string): InstallationType | null {
  // Resolve symlink chain so node_modules / .bun checks see the real target.
  let resolved = path;
  try {
    resolved = require('node:fs').realpathSync(path);
  } catch {
    // Broken symlink or permission error — fall back to the literal path.
  }

  if (resolved.includes('.bun')) return 'bun';
  if (resolved.includes('node_modules')) return 'npm';
  // Source install: literal LOCAL_BIN path with no node_modules in resolved
  // target, OR the binary lives under ~/.genie/bin/ directly.
  if (path === join(LOCAL_BIN, 'genie') || resolved.startsWith(GENIE_BIN)) return 'source';
  return null;
}

/**
 * Detect the genie installation type by inspecting the running binary first.
 *
 * Group 7 v2: binary path is ground truth. Previous order — config first, then
 * GENIE_SRC/.git, then binary detection — was wrong: both upstream signals are
 * stale hints from prior installs; the actual running binary's location is the
 * only reliable source of truth.
 *
 * Felipe's `felipe-personal` machine reproduced this: bun-installed genie at
 * `~/.bun/install/global/.../@automagik/genie` BUT `~/.genie/src/.git` existed
 * from a legacy source clone. Pre-v2, detection returned 'source' on the stale
 * clone, then `genie update` ran `git fetch` against a directory git couldn't
 * even resolve (PATH didn't include git non-interactively), failing with
 * `posix_spawn 'git': ENOENT` — total dead-end for the user.
 *
 * Order:
 *   1. Detect from binary path via `which genie` + realpath chain.
 *   2. Fall back to `config.installMethod` if binary detection is null.
 *   3. Fall back to `GENIE_SRC/.git` legacy hint only when config is missing.
 *   4. Final fallback: prefer bun if available, else npm.
 */
async function detectInstallationType(): Promise<InstallationType> {
  // 1. Binary path is ground truth — runs FIRST.
  const whichResult = await runCommandSilent('which', ['genie']);
  if (whichResult.success) {
    const detected = detectFromBinaryPath(whichResult.output.trim());
    if (detected) return detected;
  }

  // 2. Cached config is a hint, not truth — used only when binary path
  //    didn't classify (e.g. installed to a custom location).
  if (genieConfigExists()) {
    try {
      const config = await loadGenieConfig();
      if (config.installMethod) return config.installMethod;
    } catch {
      // Ignore config errors
    }
  }

  // 3. Legacy `~/.genie/src/.git` hint — last-resort. Pre-v2 this fired
  //    aggressively and broke bun installs that happened to have a stale
  //    source clone in their home directory.
  if (existsSync(join(GENIE_SRC, '.git'))) return 'source';

  // 4. Final fallback: prefer bun if available
  const hasBun = (await runCommandSilent('which', ['bun'])).success;
  return hasBun ? 'bun' : 'npm';
}

async function updateViaBun(channel: string): Promise<boolean> {
  // Delete global lockfile so the tag resolves fresh. Avoid `--force --no-cache`
  // here: on macOS Bun can sit at "Resolving dependencies" for a long time
  // when reinstalling the same global package, even though a plain global add
  // completes quickly after the stale lockfile is gone.
  try {
    require('node:fs').unlinkSync(join(homedir(), '.bun', 'install', 'global', 'bun.lock'));
  } catch {
    /* may not exist */
  }

  log(`Updating via bun (channel: ${channel})...`);
  const result = await runCommand('bun', ['add', '-g', `@automagik/genie@${channel}`]);
  if (!result.success) {
    error('Failed to update via bun');
    return false;
  }
  console.log();
  success(`Genie CLI updated via bun (${channel})!`);
  return true;
}

async function updateViaNpm(channel: string): Promise<boolean> {
  log(`Updating via npm (channel: ${channel})...`);
  const result = await runCommand('npm', ['install', '-g', `@automagik/genie@${channel}`]);
  if (!result.success) {
    error('Failed to update via npm');
    return false;
  }
  console.log();
  success(`Genie CLI updated via npm (${channel})!`);
  return true;
}

/** Detect which package-manager global installs exist (npm, bun, or both). */
export async function detectGlobalInstalls(): Promise<Set<'npm' | 'bun'>> {
  const found = new Set<'npm' | 'bun'>();

  const [npmResult, bunResult] = await Promise.all([
    runCommandSilent('npm', ['list', '-g', '@automagik/genie']),
    runCommandSilent('bun', ['pm', 'ls', '-g']),
  ]);

  if (npmResult.success && !npmResult.output.includes('(empty)')) {
    found.add('npm');
  }
  if (bunResult.success && bunResult.output.includes('@automagik/genie')) {
    found.add('bun');
  }

  return found;
}

async function updateSource(): Promise<void> {
  // Pre-flight: GENIE_SRC must exist as a git checkout. Without this guard,
  // node:child_process.spawn() bubbles up `ENOENT: posix_spawn 'git'` from
  // the missing-cwd, which is misleading — operators read it as "git not
  // installed" and waste time on the wrong fix. Fail loudly with the actual
  // root cause and the path that's missing.
  if (!existsSync(GENIE_SRC)) {
    error(`Source install path not found: ${GENIE_SRC}`);
    console.error('  Detection picked the source-install path, but the directory does not exist.');
    console.error('  This usually means a stale install hint (config or ~/.genie/src/.git) is');
    console.error('  pointing somewhere genuine. Either:');
    console.error(`    1. Re-clone the source: git clone https://github.com/automagik-dev/genie ${GENIE_SRC}`);
    console.error('    2. Update via package manager instead: genie update --next --via bun');
    console.error('    3. Inspect detection: genie doctor --update-detection');
    process.exit(1);
  }
  if (!existsSync(join(GENIE_SRC, '.git'))) {
    error(`Source install path is not a git checkout: ${GENIE_SRC}`);
    console.error(`  ${GENIE_SRC} exists but has no .git/. Cannot run \`git fetch\` from it.`);
    console.error(`  Either delete ${GENIE_SRC} and re-clone, or update via package manager:`);
    console.error('    genie update --next --via bun');
    process.exit(1);
  }

  // Get current version info before update
  const beforeInfo = await getGitInfo(GENIE_SRC);
  if (beforeInfo) {
    console.log(`Current: \x1b[2m${beforeInfo.branch}@${beforeInfo.commit} (${beforeInfo.commitDate})\x1b[0m`);
    console.log();
  }

  // Step 1: Fetch and reset to origin/main
  log('Fetching latest changes...');
  const fetchResult = await runCommand('git', ['fetch', 'origin'], GENIE_SRC);
  if (!fetchResult.success) {
    error('Failed to fetch from origin');
    process.exit(1);
  }

  log('Resetting to origin/main...');
  const resetResult = await runCommand('git', ['reset', '--hard', 'origin/main'], GENIE_SRC);
  if (!resetResult.success) {
    error('Failed to reset to origin/main');
    process.exit(1);
  }
  console.log();

  // Get new version info
  const afterInfo = await getGitInfo(GENIE_SRC);

  // Check if anything changed
  if (beforeInfo && afterInfo && beforeInfo.commit === afterInfo.commit) {
    success('Already up to date!');
    console.log();
    return;
  }

  // Step 2: Install dependencies
  log('Installing dependencies...');
  const installResult = await runCommand('bun', ['install'], GENIE_SRC);
  if (!installResult.success) {
    error('Failed to install dependencies');
    process.exit(1);
  }
  console.log();

  // Step 3: Build
  log('Building...');
  const buildResult = await runCommand('bun', ['run', 'build'], GENIE_SRC);
  if (!buildResult.success) {
    error('Failed to build');
    process.exit(1);
  }
  console.log();

  // Step 4: Copy binaries and update symlinks
  log('Installing binaries...');

  try {
    await mkdir(GENIE_BIN, { recursive: true });
    await mkdir(LOCAL_BIN, { recursive: true });

    const binaries = ['genie.js', 'term.js'];
    const names = ['genie', 'term'];

    for (let i = 0; i < binaries.length; i++) {
      const src = join(GENIE_SRC, 'dist', binaries[i]);
      const binDest = join(GENIE_BIN, binaries[i]);
      const linkDest = join(LOCAL_BIN, names[i]);

      // Copy to GENIE_BIN
      await copyFile(src, binDest);
      await chmod(binDest, 0o755);

      // Symlink to LOCAL_BIN
      await symlinkOrCopy(binDest, linkDest);
    }

    // Clean up legacy claudio binaries from previous installs
    for (const legacy of ['claudio.js', 'claudio']) {
      const legacyBin = join(GENIE_BIN, legacy);
      const legacyLink = join(LOCAL_BIN, legacy);
      try {
        await unlink(legacyBin);
      } catch {}
      try {
        await unlink(legacyLink);
      } catch {}
    }

    success('Binaries installed');
  } catch (err) {
    error(`Failed to install binaries: ${err}`);
    process.exit(1);
  }

  // Print success
  console.log();
  console.log('\x1b[2m────────────────────────────────────\x1b[0m');
  success('Genie CLI updated successfully!');
  console.log();

  if (afterInfo) {
    console.log(`Version: \x1b[36m${afterInfo.branch}@${afterInfo.commit}\x1b[0m (${afterInfo.commitDate})`);
    console.log();
  }
}

async function symlinkOrCopy(src: string, dest: string): Promise<void> {
  const { symlink, unlink } = await import('node:fs/promises');

  try {
    // Remove existing symlink/file if present
    if (existsSync(dest)) {
      await unlink(dest);
    }
    await symlink(src, dest);
  } catch {
    // Fallback to copy if symlink fails
    await copyFile(src, dest);
  }
}

// ============================================================================
// Plugin Sync — update Claude Code plugin cache after CLI update
// ============================================================================

/**
 * Files that MUST NOT propagate from the source plugin tree into the active
 * Claude Code cache. These are framework markers Claude Code writes to its
 * own `~/.claude/plugins/cache/...` to mark plugin versions orphaned. If
 * a stale tarball ships one (e.g. a dev box accidentally committed it; the
 * 2026-05-06 multi-server regression diagnosed `plugins/genie/.orphaned_at`
 * being checked in since the initial commit), `copyDirSync` would copy it
 * into the active cache, Claude Code's loader would mark the active plugin
 * orphaned, and skills would silently fail to load. Filter at the copy
 * boundary so older binaries already deployed don't keep replaying the bug
 * on every `genie update` until the source-side fix lands.
 */
const FRAMEWORK_MARKER_FILES = new Set(['.orphaned_at']);

function copyDirSync(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (FRAMEWORK_MARKER_FILES.has(entry.name)) continue;
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

async function resolveGlobalPkgDir(installType: InstallationType): Promise<string | null> {
  // Prefer the package manager that was actually used for this update
  if (installType === 'bun') {
    const bunPath = join(homedir(), '.bun', 'install', 'global', 'node_modules', '@automagik', 'genie');
    if (existsSync(bunPath)) return bunPath;
  }

  if (installType === 'npm') {
    // Dynamic resolution via npm root -g (handles nvm/fnm/volta)
    const npmRootResult = await runCommandSilent('npm', ['root', '-g']);
    if (npmRootResult.success) {
      const npmPath = join(npmRootResult.output.trim(), '@automagik', 'genie');
      if (existsSync(npmPath)) return npmPath;
    }
  }

  // Fallback: try both regardless of installType
  const bunFallback = join(homedir(), '.bun', 'install', 'global', 'node_modules', '@automagik', 'genie');
  if (existsSync(bunFallback)) return bunFallback;

  const npmRootFallback = await runCommandSilent('npm', ['root', '-g']);
  if (npmRootFallback.success) {
    const npmPath = join(npmRootFallback.output.trim(), '@automagik', 'genie');
    if (existsSync(npmPath)) return npmPath;
  }

  return null;
}

/** Update the installed_plugins.json registry entry for genie. */
function updatePluginRegistry(claudePlugins: string, cacheDir: string, version: string): void {
  const registryPath = join(claudePlugins, 'installed_plugins.json');
  try {
    if (!existsSync(registryPath)) return;
    const registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
    const entries = registry.plugins?.['genie@automagik'];
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (entry.scope === 'user') {
        entry.installPath = cacheDir;
        entry.version = version;
        entry.lastUpdated = new Date().toISOString();
      }
    }
    writeFileSync(registryPath, JSON.stringify(registry, null, 2));
  } catch (err) {
    log(`Registry update failed (non-fatal): ${err}`);
  }
}

/** Install tmux configs to ~/.genie/ and reload the genie tmux server. */
function syncTmuxConf(tmuxScriptsSrc: string): void {
  mkdirSync(GENIE_HOME, { recursive: true });

  // Install genie.tmux.conf → ~/.genie/tmux.conf (agent server config)
  const tmuxConfSrc = join(tmuxScriptsSrc, 'genie.tmux.conf');
  const tmuxConfDest = join(GENIE_HOME, 'tmux.conf');
  if (existsSync(tmuxConfSrc)) {
    try {
      copyFileSync(tmuxConfSrc, tmuxConfDest);
      success(`Installed tmux config to ${tmuxConfDest}`);
      try {
        const { tmuxBin } = require('../lib/ensure-tmux.js');
        execSync(`${tmuxBin()} -L genie source-file '${tmuxConfDest}'`, { stdio: 'ignore' });
        success('Reloaded genie tmux server configuration');
      } catch {
        // genie tmux server not running or reload failed — non-fatal
      }
    } catch {
      // Read/write failed — non-fatal
    }
  }

  // Install tui-tmux.conf → ~/.genie/tui-tmux.conf (TUI display config, no shell probes)
  const tuiConfSrc = join(tmuxScriptsSrc, 'tui-tmux.conf');
  const tuiConfDest = join(GENIE_HOME, 'tui-tmux.conf');
  if (existsSync(tuiConfSrc)) {
    try {
      copyFileSync(tuiConfSrc, tuiConfDest);
      success(`Installed TUI tmux config to ${tuiConfDest}`);
    } catch {
      // Read/write failed — non-fatal
    }
  }

  // Install .generated.theme.conf → ~/.genie/.generated.theme.conf (Severance palette,
  // sourced by both tmux configs above). Generated from packages/genie-tokens.
  const themeSrc = join(tmuxScriptsSrc, '.generated.theme.conf');
  const themeDest = join(GENIE_HOME, '.generated.theme.conf');
  if (existsSync(themeSrc)) {
    try {
      copyFileSync(themeSrc, themeDest);
      success(`Installed tmux theme to ${themeDest}`);
    } catch {
      // Read/write failed — non-fatal
    }
  }

  // Install osc52-copy.sh → ~/.genie/scripts/osc52-copy.sh (clipboard helper for nested tmux)
  const osc52Src = join(tmuxScriptsSrc, 'osc52-copy.sh');
  const osc52Dest = join(GENIE_HOME, 'scripts', 'osc52-copy.sh');
  if (existsSync(osc52Src)) {
    try {
      copyFileSync(osc52Src, osc52Dest);
      chmodSync(osc52Dest, 0o755);
      success(`Installed OSC 52 clipboard helper to ${osc52Dest}`);
    } catch {
      // Read/write failed — non-fatal
    }
  }
}

/** Copy tmux scripts from the global package to ~/.genie/scripts/ */
function syncTmuxScripts(globalPkgDir: string): void {
  const tmuxScriptsSrc = join(globalPkgDir, 'scripts', 'tmux');
  if (!existsSync(tmuxScriptsSrc)) return;

  const scriptsDir = join(GENIE_HOME, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });

  let scriptCount = 0;
  for (const entry of readdirSync(tmuxScriptsSrc)) {
    if (
      entry.endsWith('.sh') ||
      entry === 'genie.tmux.conf' ||
      entry === 'tui-tmux.conf' ||
      entry === '.generated.theme.conf'
    ) {
      const src = join(tmuxScriptsSrc, entry);
      const dest = join(scriptsDir, entry);
      copyFileSync(src, dest);
      try {
        chmodSync(dest, entry.endsWith('.sh') ? 0o755 : 0o644);
      } catch {
        // chmod may fail on some filesystems — non-fatal
      }
      scriptCount++;
    }
  }

  if (scriptCount > 0) {
    success(`Refreshed ${scriptCount} tmux scripts at ${scriptsDir}`);
  }

  syncTmuxConf(tmuxScriptsSrc);
}

/** Update marketplace.json version field to match the installed CLI version. */
function syncMarketplaceVersion(claudePlugins: string, version: string): void {
  const marketplacePath = join(claudePlugins, 'marketplaces', 'automagik', '.claude-plugin', 'marketplace.json');
  try {
    if (!existsSync(marketplacePath)) return;
    const data = JSON.parse(readFileSync(marketplacePath, 'utf-8'));
    if (Array.isArray(data.plugins)) {
      for (const plugin of data.plugins) {
        if (plugin.name === 'genie') {
          plugin.version = version;
        }
      }
    }
    writeFileSync(marketplacePath, JSON.stringify(data, null, 2));
    success(`Updated marketplace.json to v${version}`);
  } catch (err) {
    log(`Marketplace version update failed (non-fatal): ${err}`);
  }
}

/** Update plugins/genie/package.json version field to match the installed CLI version. */
function syncPluginPackageVersion(claudePlugins: string, version: string): void {
  const pkgPath = join(claudePlugins, 'marketplaces', 'automagik', 'plugins', 'genie', 'package.json');
  try {
    if (!existsSync(pkgPath)) return;
    const data = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    data.version = version;
    writeFileSync(pkgPath, JSON.stringify(data, null, 2));
    success(`Updated plugin package.json to v${version}`);
  } catch (err) {
    log(`Plugin package.json update failed (non-fatal): ${err}`);
  }
}

/** Repoint the skills symlink to the current cache version. */
function syncSkillsSymlink(claudePlugins: string, version: string): void {
  const skillsLink = join(claudePlugins, 'marketplaces', 'automagik', 'plugins', 'genie', 'skills');
  const cacheSkills = join('..', '..', '..', '..', 'cache', 'automagik', 'genie', version, 'skills');
  try {
    const { symlinkSync, unlinkSync, lstatSync } = require('node:fs') as typeof import('node:fs');
    // Remove existing symlink/dir if present
    try {
      lstatSync(skillsLink);
      unlinkSync(skillsLink);
    } catch {
      // doesn't exist — fine
    }
    symlinkSync(cacheSkills, skillsLink);
    success(`Skills symlink → cache/${version}/skills`);
  } catch (err) {
    log(`Skills symlink update failed (non-fatal): ${err}`);
  }
}

async function syncPlugin(installType: InstallationType): Promise<PluginSyncInfo> {
  log('Syncing Claude Code plugin...');

  const globalPkgDir = await resolveGlobalPkgDir(installType);
  if (!globalPkgDir) {
    log('Could not find installed package — skipping plugin sync');
    return { skippedReason: 'installed package not found' };
  }

  const pluginSrc = join(globalPkgDir, 'plugins', 'genie');
  if (!existsSync(pluginSrc)) {
    log('Plugin source not found in package — skipping plugin sync');
    return { globalPkgDir, skippedReason: 'plugin source not found in package' };
  }

  // Read version from installed package
  let version: string;
  try {
    const pkg = JSON.parse(readFileSync(join(globalPkgDir, 'package.json'), 'utf-8'));
    version = pkg.version;
  } catch {
    log('Could not read package version — skipping plugin sync');
    return { globalPkgDir, skippedReason: 'could not read package version' };
  }

  // Copy to Claude Code plugin cache
  const claudePlugins = join(homedir(), '.claude', 'plugins');
  const cacheDir = join(claudePlugins, 'cache', 'automagik', 'genie', version);

  try {
    // Clean existing cache dir if it exists (stale version)
    if (existsSync(cacheDir)) {
      rmSync(cacheDir, { recursive: true, force: true });
    }
    copyDirSync(pluginSrc, cacheDir);

    // Skills live at <pkg>/skills/ (symlink in plugins/genie/ doesn't survive npm)
    const skillsSrc = join(globalPkgDir, 'skills');
    if (existsSync(skillsSrc) && !existsSync(join(cacheDir, 'skills'))) {
      copyDirSync(skillsSrc, join(cacheDir, 'skills'));
    }
  } catch (err) {
    error(`Failed to copy plugin: ${err}`);
    return { version, globalPkgDir, cacheDir, skippedReason: `failed to copy plugin: ${err}` };
  }

  updatePluginRegistry(claudePlugins, cacheDir, version);
  syncMarketplaceVersion(claudePlugins, version);
  syncPluginPackageVersion(claudePlugins, version);
  syncSkillsSymlink(claudePlugins, version);
  syncTmuxScripts(globalPkgDir);

  success(`Plugin synced to v${version}`);
  return { version, globalPkgDir, cacheDir };
}

// ============================================================================
// Channel Management
// ============================================================================

async function resolveChannel(options: { next?: boolean; stable?: boolean }): Promise<string> {
  // Explicit flags override everything
  if (options.next) return 'next';
  if (options.stable) return 'latest';

  // Read saved channel from config
  if (genieConfigExists()) {
    try {
      const config = await loadGenieConfig();
      if (config.updateChannel) return config.updateChannel;
    } catch {
      // Ignore config errors
    }
  }

  return 'latest';
}

async function persistChannel(channel: string): Promise<void> {
  try {
    const config = await loadGenieConfig();
    config.updateChannel = channel as 'latest' | 'next';
    await saveGenieConfig(config);
  } catch {
    // Non-fatal — channel preference lost but update still works
  }
}

export interface UpdateCommandOptions {
  next?: boolean;
  stable?: boolean;
  skipMaintenance?: boolean;
  skipCleanup?: string;
  /**
   * Mirrors commander's `--no-sidecar-cleanup` convention: defaults to `true`
   * (i.e. cleanup permitted), set to `false` when the flag is present. Accepted
   * for cross-CLI portability with omni; genie's day-one registry is empty so
   * the flag is logged and otherwise has no effect.
   */
  sidecarCleanup?: boolean;
  /** `--yes` / `-y`. Skips the TTY confirmation. `GENIE_UPDATE_YES=1` env
   *  has the same effect for CI / scripted callers. */
  yes?: boolean;
  /** `--no-restart`. Skips post-update maintenance AND the verify probe. */
  restart?: boolean;
  /** `--no-verify`. Runs maintenance but skips the post-restart probe. */
  verify?: boolean;
}

export async function updateCommand(options: UpdateCommandOptions = {}): Promise<void> {
  console.log();
  console.log(`${colorize('\x1b[1m', '\x1b[0m', '🧞 Genie CLI Update')}`);
  console.log(`${colorize('\x1b[2m', '\x1b[0m', '────────────────────────────────────')}`);
  console.log();

  const cleanupSkipList = buildCleanupSkipList(options);
  const noRestart = options.restart === false || isTruthyEnv(process.env.GENIE_UPDATE_NO_RESTART);
  const noVerify = options.verify === false || isTruthyEnv(process.env.GENIE_UPDATE_NO_VERIFY);
  const channel = await resolveChannel(options);

  // Persist channel when explicitly switching
  if (options.next || options.stable) {
    await persistChannel(channel);
  }

  // Group 3: pre-flight version check. Short-circuit when already current.
  const latestVersion = await fetchLatestVersion(channel);
  if (shortCircuitIfCurrent(VERSION, latestVersion)) {
    success(`Already up to date (v${normalizeVersion(VERSION)}, channel ${channel})`);
    console.log();
    return;
  }

  const installType = await detectInstallationType();
  log(`Detected installation: ${installType}`);
  log(`Channel: ${channel}${channel === 'next' ? ' (dev builds)' : ' (stable)'}`);
  if (latestVersion) {
    log(`Update available: ${normalizeVersion(VERSION)} → ${normalizeVersion(latestVersion)}`);
  } else {
    log(`Registry version unavailable (proceeding with reinstall of channel ${channel})`);
  }
  console.log();

  if (installType === 'unknown') {
    error('No Genie CLI installation found');
    console.log();
    console.log('Install method not configured. Please reinstall genie:');
    console.log(
      `${colorize('\x1b[36m', '\x1b[0m', '  curl -fsSL https://raw.githubusercontent.com/automagik-dev/genie/main/install.sh | bash')}`,
    );
    console.log();
    process.exit(1);
  }

  // Group 3: confirmation prompt (TTY) / `--yes` / GENIE_UPDATE_YES bypass.
  if (!shouldAutoConfirm(options)) {
    const proceedQuestion = latestVersion
      ? `Update v${normalizeVersion(VERSION)} → v${normalizeVersion(latestVersion)}?`
      : `Reinstall channel "${channel}"?`;
    const proceed = await promptConfirm(proceedQuestion);
    if (!proceed) {
      console.log();
      log('Update declined.');
      console.log();
      return;
    }
  }

  if (installType === 'source') {
    await updateSource();
    return;
  }

  // Detect all global installs (npm + bun) to update both when they coexist
  const globalInstalls = await detectGlobalInstalls();

  // Primary update — exit on failure
  const primaryMethod = installType as 'npm' | 'bun';
  const primaryOk = primaryMethod === 'bun' ? await updateViaBun(channel) : await updateViaNpm(channel);
  if (!primaryOk) {
    process.exit(1);
  }

  // Secondary update — warn on failure, don't block
  const secondaryMethod = primaryMethod === 'bun' ? 'npm' : 'bun';
  if (globalInstalls.has(secondaryMethod)) {
    console.log();
    log(`Also updating ${secondaryMethod}-global install...`);
    const secondaryOk = secondaryMethod === 'bun' ? await updateViaBun(channel) : await updateViaNpm(channel);
    if (!secondaryOk) {
      error(`Secondary update via ${secondaryMethod} failed (non-blocking)`);
    }
  }

  const plugin = await syncPlugin(installType);
  const cleanupReport = await runLegacyCleanupSafe(cleanupSkipList);
  await runPostUpdateMaintenanceSafe(
    { ...options, noRestart, noVerify },
    {
      channel,
      installType,
      primaryMethod,
      globalInstalls: [...globalInstalls].sort(),
      plugin,
      latestVersion,
      cliVersion: VERSION,
    },
    cleanupReport,
  );
}

function buildCleanupSkipList(options: UpdateCommandOptions): Set<string> {
  const skipList = parseSkipCleanupFlag(options.skipCleanup);
  if (options.sidecarCleanup === false) {
    skipList.add('nats-reply-sidecar');
    log('--no-sidecar-cleanup (no-op for genie, retained for cross-CLI portability)');
  }
  return skipList;
}

async function runLegacyCleanupSafe(skipList: Set<string>): Promise<CleanupReport> {
  try {
    return await cleanupLegacyArtifacts(skipList);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Legacy artifact cleanup failed (non-fatal): ${msg}`);
    return { entries: [] };
  }
}

/**
 * Day-one users hit watchdog install + foreground backfill convergence on
 * first `genie` after upgrade. Run maintenance NOW so `genie` (auto-start)
 * can stay fast. Failures are surfaced but never block the update.
 */
function printPostUpdateMaintenanceIntro(): void {
  console.log();
  log('Running post-update maintenance...');
  console.log('  Purpose: make first launch after update fast and collect upgrade health signals.');
  console.log(
    '  Checks: runtime partitions, watchdog status, session backfill drift, zombie rows, team config orphans.',
  );
  console.log('  PG policy: read-only; uses an already-running pgserve when available and will not auto-start it.');
  console.log('  Legend: [ok]=healthy, [fix]=fixed, [--]=skipped/non-blocking, [!!]=operator action needed.');
}

async function runMaintenanceWithCapturedLines(maintenanceLines: string[]): Promise<void> {
  const { runPostUpdateMaintenance } = await import('./doctor.js');
  await withTemporaryEnv('GENIE_PG_NO_AUTOSTART', '1', () =>
    runPostUpdateMaintenance({
      log: (line) => {
        maintenanceLines.push(line);
        console.log(line);
      },
    }),
  );
}

function printDiagnosticsSummary(diagnostics: { path: string; signals: RecentLogSignal[] }): void {
  log('Post-update diagnostics captured.');
  console.log(`  Report: ${diagnostics.path}`);
  console.log('  Include this file when opening a GitHub issue; it contains install metadata, step output,');
  console.log('  local process state, and recent scheduler/TUI log signals.');
  if (diagnostics.signals.length === 0) return;
  console.log('  Recent scheduler signals:');
  for (const signal of diagnostics.signals.slice(0, 3)) {
    const errorDetail = signal.lastError ? ` — ${signal.lastError}` : '';
    console.log(`    ${signal.level}:${signal.event} ×${signal.count}${errorDetail}`);
  }
}

async function capturePostUpdateDiagnostics(
  diagnosticsCtx: UpdateDiagnosticsContext | undefined,
  maintenance: { outcome: 'completed' | 'failed'; durationMs: number; lines: string[]; error?: string },
  extras: UpdateDiagnosticsExtras,
): Promise<void> {
  if (!diagnosticsCtx) return;
  try {
    const diagnostics = await collectUpdateDiagnostics(diagnosticsCtx, maintenance, extras);
    printDiagnosticsSummary(diagnostics);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Post-update diagnostics capture failed (non-fatal): ${msg}`);
  }
}

/**
 * Print the 3-line verify banner. Genie has no auth row (no auth model), so
 * the banner is 2 lines for ok / health-unreachable / version-mismatch and
 * collapses to 1 line for skipped variants.
 */
function printVerifyBanner(result: VerifyResult): void {
  console.log();
  for (const line of formatVerifyBanner(result)) console.log(`  ${line}`);
  console.log();
}

interface MaintenanceOptions {
  skipMaintenance?: boolean;
  noRestart?: boolean;
  noVerify?: boolean;
}

async function runPostUpdateMaintenanceSafe(
  options: MaintenanceOptions,
  diagnosticsCtx: UpdateDiagnosticsContext,
  cleanupReport: CleanupReport,
): Promise<void> {
  // `--no-restart` short-circuits BOTH maintenance and verify. Diagnostics
  // still get written (with a `skipped` verify variant) so operators have a
  // record of every invocation.
  if (options.noRestart) {
    log('--no-restart: skipping maintenance and verify probe.');
    const verify = await runVerifyProbe({ cliVersion: VERSION, skipReason: 'no-restart' });
    printVerifyBanner(verify);
    await capturePostUpdateDiagnostics(
      diagnosticsCtx,
      { outcome: 'completed', durationMs: 0, lines: [] },
      { verify, cleanups: cleanupReport },
    );
    return;
  }

  if (options.skipMaintenance || isTruthyEnv(process.env.GENIE_UPDATE_SKIP_MAINTENANCE)) {
    log('Skipping post-update maintenance (requested).');
    const verify = await runVerifyProbe({ cliVersion: VERSION, skipReason: 'no-restart' });
    printVerifyBanner(verify);
    await capturePostUpdateDiagnostics(
      diagnosticsCtx,
      { outcome: 'completed', durationMs: 0, lines: [] },
      { verify, cleanups: cleanupReport },
    );
    return;
  }
  const startedAt = Date.now();
  const maintenanceLines: string[] = [];
  let outcome: 'completed' | 'failed' = 'completed';
  let maintenanceError: string | undefined;
  try {
    printPostUpdateMaintenanceIntro();
    await runMaintenanceWithCapturedLines(maintenanceLines);
    success(`Post-update maintenance complete (${formatDuration(Date.now() - startedAt)}).`);
  } catch (err) {
    outcome = 'failed';
    maintenanceError = err instanceof Error ? err.message : String(err);
    error(`Post-update maintenance skipped: ${maintenanceError}`);
  }

  // Group 6 (follow-up): bun's package swap unlinks the old
  // `node_modules/@automagik/genie` directory under the running pm2
  // genie-serve process. Restart it BEFORE verifying so the daemon re-execs
  // from the live bytes — otherwise the verify probe will (correctly) flag
  // it as `daemon-stale-inode` and exit 1, leaving operators to fix it
  // manually after every update.
  await restartServeIfStaleSafe();

  // Group 4: verify probe AFTER maintenance. `--no-verify` produces the
  // `skipped: no-verify-flag` variant so diagnostics still record the
  // intentional bypass.
  const verify = options.noVerify
    ? await runVerifyProbe({ cliVersion: VERSION, skipReason: 'no-verify-flag' })
    : await runVerifyProbe({ cliVersion: VERSION });
  printVerifyBanner(verify);

  await capturePostUpdateDiagnostics(
    diagnosticsCtx,
    {
      outcome,
      durationMs: Date.now() - startedAt,
      lines: maintenanceLines,
      error: maintenanceError,
    },
    { verify, cleanups: cleanupReport },
  );

  // Exit 1 on health-unreachable OR daemon-stale-inode unless --no-verify was
  // set (escape hatch). Stale-inode is a real failure: the new binary is on
  // disk but the daemon is still serving old bytes — every subsequent
  // `genie ...` call hits the new code while the running scheduler / event
  // router lag behind. Exit 1 forces CI / scripted updaters to notice and
  // re-run with `pm2 restart genie-serve`.
  if ((verify.kind === 'health-unreachable' || verify.kind === 'daemon-stale-inode') && !options.noVerify) {
    process.exitCode = 1;
  }
}

/**
 * Best-effort wrapper around `restartServeIfStale` so update never aborts
 * because pm2 misbehaved. Failures inside the helper already log error()
 * lines; here we just guarantee we never throw upward into the caller.
 */
async function restartServeIfStaleSafe(): Promise<void> {
  try {
    await restartServeIfStale();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Stale-serve restart skipped (non-fatal): ${msg}`);
  }
}
