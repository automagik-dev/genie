/**
 * `genie install` — register the `Genie` pm2 service with hardened defaults.
 *
 * Wave 2 of the canonical-pgserve-pm2-supervision wish (PR pgserve#55,
 * Wave 1 = pgserve#57). Mirrors `omni install`: shells out to `pgserve
 * install` first (idempotent — no-op when pgserve is already pm2-managed),
 * then registers a pm2 service named `Genie` so the bridge survives shell
 * exits and host reboots.
 *
 * Naming history: this service was named `genie-serve` from initial release
 * through 4.260507.2. The canonical name is now `Genie` (capital G) — it
 * matches the project brand in `pm2 list` and stops blending into the
 * lowercase `genie` CLI invocations that operators see in the same listing.
 * `genie install` and `genie update` migrate the legacy entry automatically:
 * any `genie-serve` row found in `pm2 jlist` is `pm2 delete`d and replaced
 * with the canonical `Genie` row in the same boot. See
 * `LEGACY_PM2_PROCESS_NAMES` for the migration set and
 * `removeLegacyPm2Entries` for the call site.
 *
 * Hardened defaults shared with pgserve and omni — same numbers everywhere
 * so the four pm2 services in the canonical stack
 * (pgserve / omni-api / omni-nats / Genie) behave identically under
 * crash-loop and resource pressure. See `~/.genie/logs/genie-serve-*.log`
 * after install (logfile names are preserved across the rename so existing
 * log-rotation rules keep working).
 *
 * The command is idempotent. Re-running `genie install` after it's
 * already registered prints "already installed" and exits 0. Operators
 * wanting to change ports / data dirs run `genie uninstall` (eventually)
 * + `genie install` again. Until then, `pm2 restart Genie` is the
 * way to pick up code changes (and `genie update` does this automatically
 * via `pm2 startOrReload` against the regenerated ecosystem config).
 *
 * Empirically validated 2026-04-30 on a production server. The exact
 * `pm2 start` invocation here matches the manual command pinned in
 * Decisions 4 & 5 of the wish.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Canonical pm2 process name. See file header for the rename rationale.
 * Logfile prefix in `~/.genie/logs/` is intentionally NOT renamed — operators
 * have shell aliases / log-rotation pinned to `genie-serve-*.log` and breaking
 * those for a cosmetic delta is not worth it.
 */
const PM2_PROCESS_NAME = 'Genie';
/** Logfile prefix — pinned independently of `PM2_PROCESS_NAME` so the rename
 *  doesn't orphan existing `genie-serve-{out,error}.log` files. */
const PM2_LOG_PREFIX = 'genie-serve';
/**
 * pm2 process names this install/update cycle treats as "the same service in
 * a previous form" — found rows are `pm2 delete`d so the canonical name
 * (`PM2_PROCESS_NAME`) is the only entry left after install. Add to this
 * list, never remove: every legacy name ever shipped must remain detected
 * for an operator's first post-rename update to clean up.
 */
const LEGACY_PM2_PROCESS_NAMES = ['genie-serve'] as const;
/**
 * pgserve/autopg pm2 process names. pgserve v2.4 renamed the supervised
 * postmaster process from `pgserve` to `autopg-server`; keep both so Genie
 * can recognize hosts installed before and after the rename.
 */
const PGSERVE_PM2_PROCESS_NAMES = ['autopg-server', 'pgserve'] as const;

/**
 * Hardened defaults — mirror pgserve's HARDENED_DEFAULTS so the canonical
 * stack behaves uniformly. Each value is documented in the wish and in
 * `pgserve/src/cli-install.cjs` rationale.
 *
 * Memory ceiling is env-tunable (`GENIE_SERVE_MAX_MEMORY=8G genie install`)
 * for big-iron deployments without a recompile.
 */
const HARDENED_DEFAULTS = {
  maxRestarts: 50,
  minUptimeMs: 10_000,
  restartDelayMs: 4000,
  expBackoffRestartDelayMs: 100,
  maxMemory: process.env.GENIE_SERVE_MAX_MEMORY || '4G',
  killTimeoutMs: 60_000,
  logDateFormat: 'YYYY-MM-DD HH:mm:ss.SSS',
};

function getLogsDir(): string {
  return join(homedir(), '.genie', 'logs');
}

function ok(msg: string): void {
  process.stdout.write(`genie install: ${msg}\n`);
}

function fail(msg: string): never {
  process.stderr.write(`genie install: ${msg}\n`);
  process.exit(1);
}

function which(cmd: string): string | null {
  try {
    const result = execFileSync('which', [cmd], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

interface Pm2Process {
  name?: string;
  pid?: number;
  pm2_env?: { status?: string };
}

function pm2GetProcess(name: string): Pm2Process | null {
  try {
    const out = execFileSync('pm2', ['jlist'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const list = JSON.parse(out) as Pm2Process[];
    return list.find((p) => p.name === name) ?? null;
  } catch {
    return null;
  }
}

function pm2GetAnyProcess(names: readonly string[]): Pm2Process | null {
  for (const name of names) {
    const existing = pm2GetProcess(name);
    if (existing) return existing;
  }
  return null;
}

/**
 * Delete any pm2 entries matching `LEGACY_PM2_PROCESS_NAMES`. Called from
 * the install path so the rename `genie-serve` → `Genie` is automatic on
 * the next `genie install` / `genie update` cycle. Returns the names that
 * were successfully deleted (informational — the caller decides whether
 * to log them).
 *
 * No-op when:
 *   - pm2 is not installed (the deletion shell-out fails fast and is treated
 *     as "not present").
 *   - No legacy entries exist in `pm2 jlist`.
 *   - The legacy entry's pm2 delete fails — we surface that the caller has
 *     a manual cleanup to do (`pm2 delete <legacy-name>`) but do not abort
 *     install over it.
 */
function removeLegacyPm2Entries(log: (msg: string) => void = () => {}): string[] {
  const removed: string[] = [];
  for (const legacyName of LEGACY_PM2_PROCESS_NAMES) {
    const existing = pm2GetProcess(legacyName);
    if (!existing) continue;
    try {
      execFileSync('pm2', ['delete', legacyName], {
        encoding: 'utf8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      log(`removed legacy pm2 entry "${legacyName}" (renamed to "${PM2_PROCESS_NAME}")`);
      removed.push(legacyName);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log(`legacy pm2 entry "${legacyName}" present but pm2 delete failed: ${reason}`);
      log(`  manual cleanup: pm2 delete ${legacyName}`);
    }
  }
  return removed;
}

function pm2IsAvailable(): boolean {
  try {
    execFileSync('pm2', ['--version'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function pgserveIsAvailable(): boolean {
  return which('pgserve') !== null;
}

/**
 * Build the canonical-install hint message printed before exiting non-zero
 * when pgserve is missing or its install fails. Exported via `_internals`
 * for unit tests.
 */
function buildCanonicalPgserveHint(reason: string): string {
  return [
    `Error: canonical pgserve registration failed (${reason}).`,
    'Genie depends on pm2-supervised pgserve. To proceed:',
    '  bun add -g pgserve@^2',
    '  pgserve install',
    '  genie install',
    'See https://github.com/automagik-dev/genie/blob/main/docs/install.md for details.',
    '',
  ].join('\n');
}

function failCanonicalPgserve(reason: string): never {
  process.stderr.write(buildCanonicalPgserveHint(reason));
  process.exit(1);
}

/**
 * Hard prerequisite: shell out to `pgserve install` so the canonical pgserve
 * is registered under pm2 before genie-serve depends on it.
 *
 * Idempotency: `pgserve install` is supposed to be a no-op when pgserve is
 * already pm2-managed, but in pgserve@^2 the install runs an EADDRINUSE bind
 * check on the canonical port BEFORE noticing that the existing listener is
 * its own pm2-supervised instance. Operators upgrading via
 * `curl -fsSL https://get.automagik.dev/genie | bash` on a host that already
 * has pgserve under pm2 see:
 *
 *   pgserve install: port 8432 is already in use on 127.0.0.1
 *   Error: canonical pgserve registration failed (exit code 1).
 *
 * Detected on Felipe's box on 2026-05-11. Workaround on the genie side: probe
 * `pm2 jlist` first; if `pgserve` is online under pm2 we own it and the
 * install step is a redundant no-op that we can skip. Falls through to the
 * shell-out for first-time installs and for boxes where pgserve is missing
 * from pm2.
 *
 * Returns void on success. On any failure (binary missing, non-zero exit)
 * prints the canonical install hint and exits the process with code 1.
 * Genie has no embedded pgserve fallback after the canonical-cutover wish;
 * a missing or broken pgserve must surface at install time, not at runtime.
 */
interface PgserveStatus {
  installed?: boolean;
  name?: string;
  status?: string;
  pid?: number | null;
  supervisor?: string | null;
  runtime?: { live?: boolean } | null;
}

function readPgserveStatus(): PgserveStatus | null {
  if (!pgserveIsAvailable()) return null;
  const result = spawnSync('pgserve', ['status', '--json'], { encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0 && !result.stdout) return null;
  try {
    const parsed = JSON.parse(result.stdout ?? '') as PgserveStatus;
    return parsed.installed === true ? parsed : null;
  } catch {
    return null;
  }
}

function isPgservePm2ManagedStatus(status: PgserveStatus | null): boolean {
  return status?.installed === true && status.supervisor === 'pm2';
}

function isPgserveReadyStatus(status: PgserveStatus | null): boolean {
  return isPgservePm2ManagedStatus(status) && status?.status === 'online' && status.runtime?.live !== false;
}

function restartPgserve(): boolean {
  const result = spawnSync('pgserve', ['restart'], { stdio: 'inherit' });
  return result.status === 0;
}

function describePgserveStatus(status: PgserveStatus | null): string {
  if (!status) return 'unknown';
  return `${status.name ?? 'pgserve'} status=${status.status ?? 'unknown'} runtime=${status.runtime?.live === false ? 'not-live' : 'live-or-unknown'}`;
}

/** Predicate: is this pm2 entry pgserve in a healthy "online" state? Pulled
 *  out as a pure function so the install-skip decision can be unit-tested
 *  without mocking `pm2 jlist`. */
function isPgserveOnlinePm2(entry: Pm2Process | null): boolean {
  return entry?.pm2_env?.status === 'online';
}

function requirePgserveInstall(): void {
  if (!pgserveIsAvailable()) {
    failCanonicalPgserve('pgserve binary not found in PATH');
  }

  const status = readPgserveStatus();
  if (isPgserveReadyStatus(status)) {
    ok(
      `${status?.name ?? 'pgserve'} already pm2-managed and online (pid ${status?.pid ?? 'unknown'}) — skipping pgserve install`,
    );
    return;
  }
  if (isPgservePm2ManagedStatus(status)) {
    ok(`${describePgserveStatus(status)}; restarting pgserve before install`);
    if (restartPgserve()) {
      const restarted = readPgserveStatus();
      if (isPgserveReadyStatus(restarted)) {
        ok(
          `${restarted?.name ?? status?.name ?? 'pgserve'} restarted and online (pid ${restarted?.pid ?? 'unknown'}) — skipping pgserve install`,
        );
        return;
      }
    }
    failCanonicalPgserve(
      `${describePgserveStatus(status)}; pgserve is registered under pm2 but not healthy. Run: pgserve restart (or pgserve install --redeploy)`,
    );
  }

  const existing = pm2GetAnyProcess(PGSERVE_PM2_PROCESS_NAMES);
  if (isPgserveOnlinePm2(existing)) {
    ok(
      `${existing?.name ?? 'pgserve'} already pm2-managed and online (pid ${existing?.pid ?? 'unknown'}) — skipping pgserve install`,
    );
    return;
  }
  const result = spawnSync('pgserve', ['install'], { stdio: 'inherit' });
  if (result.status !== 0) {
    failCanonicalPgserve(`exit code ${result.status}`);
  }
}

/**
 * Read the canonical pgserve port via `pgserve port`. Returns null on any
 * failure — caller falls back to the embedded auto-spawn path so a missing
 * binary is non-fatal.
 *
 * Probes via `pgserve port` (not `pgserve --version` — that flag doesn't
 * exist in pgserve@^2.1.0 and was the cause of an earlier false-negative
 * regression in `omni doctor --fix`).
 */
function tryPgservePort(): number | null {
  if (!pgserveIsAvailable()) return null;
  const result = spawnSync('pgserve', ['port'], { encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0) return null;
  const port = Number.parseInt((result.stdout ?? '').trim(), 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
  return port;
}

/**
 * Compose the genie-serve connection string from a canonical pgserve port.
 *
 * The `genie` database is auto-provisioned by pgserve on first connection,
 * matching omni's pattern. Credentials match pgserve@^2.1.0 defaults.
 */
function buildGenieDatabaseUrl(port: number): string {
  return `postgresql://postgres:postgres@localhost:${port}/genie`;
}

/**
 * Resolve the path to the `genie` binary. We prefer `which genie` so the
 * pm2-registered command matches the operator's `$PATH` — surviving bun
 * upgrades that relocate the global bin dir.
 */
function resolveGenieBinary(): string {
  const wired = which('genie');
  if (wired) return wired;
  // Fall back to the path of the currently running script. Less ideal
  // because pm2 will point at this exact path forever, but better than
  // failing the install. In a Bun-compiled standalone, process.argv[1] is a
  // virtual bunfs path (`/$bunfs/root/genie`) that is not usable from outside
  // the binary — fall back to process.execPath (the compiled binary itself).
  const argv1 = process.argv[1];
  if (argv1 && !argv1.startsWith('/$bunfs/')) return argv1;
  return process.execPath || 'genie';
}

/**
 * Resolve the on-disk `@automagik/genie` version by walking up from the
 * resolved `genie` binary path until we hit a `package.json` whose `name`
 * matches our package. The walk is bounded; mirrors the resolver in
 * `src/lib/version.ts`.
 *
 * Why duplicate the logic: `src/lib/version.ts` exports a frozen
 * compile-time constant — useful in 99% of the CLI but USELESS to
 * `genie update`, where the running CLI process IS the old version and
 * the freshly-installed one is what we need to bake into the pm2 ecosystem
 * config. Reading from disk here makes `version` track the installed
 * package across `bun add -g @automagik/genie@next` swaps.
 *
 * Returns `null` when no matching package.json is reachable (source-tree
 * runs, broken installs). Caller omits the `version` field when null —
 * pm2 then displays `N/A` instead of crashing on a malformed config.
 */
const MAX_PACKAGE_JSON_WALK_DEPTH = 10;
function readGenieVersionFromDisk(geniePath: string): string | null {
  let current = dirname(resolve(geniePath));
  for (let depth = 0; depth < MAX_PACKAGE_JSON_WALK_DEPTH; depth++) {
    const candidate = join(current, 'package.json');
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf-8')) as { name?: string; version?: string };
        if (pkg.name === '@automagik/genie' && typeof pkg.version === 'string' && pkg.version.length > 0) {
          return pkg.version;
        }
      } catch {
        // try parent
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Path to the pm2 ecosystem config file we write at install time. Lives
 * under `~/.genie/` alongside the daemon's other state. pm2 6 dropped
 * most CLI hardening flags (`--min-uptime`, `--max-restarts`, etc.) in
 * favour of ecosystem-config-only configuration; this is the canonical
 * path on every modern pm2 install.
 *
 * IMPORTANT: filename MUST end in `.config.{js,cjs,mjs,json,yaml,yml}`
 * for pm2 to auto-detect ecosystem mode. Other suffixes (e.g. legacy
 * `.ecosystem.cjs`) make pm2 fall back to running the file as a regular
 * Node script — the config loads, exports, and exits immediately, leaving
 * pm2 in a restart-loop on a no-op script with no actual genie-serve
 * running. Empirically validated 2026-04-30.
 */
function getEcosystemConfigPath(): string {
  return join(homedir(), '.genie', `${PM2_PROCESS_NAME}.config.cjs`);
}

/**
 * Build the ecosystem config JS source. pm2 evaluates this file at start
 * time; we generate it deterministically from `HARDENED_DEFAULTS`, the
 * resolved `geniePath`, and the on-disk @automagik/genie version (read
 * fresh from the binary's resolved package.json). Exported for unit tests
 * to assert content shape.
 *
 * The `version` field is what pm2 surfaces in the `version` column of
 * `pm2 list`. We pass it explicitly here because pm2's auto-detection
 * walks the SCRIPT directory's package.json — `~/.bun/bin/genie` resolves
 * to `~/.bun/install/global/node_modules/@automagik/genie/dist/genie.js`
 * and pm2 looks at `dist/`, which has no package.json — so without an
 * explicit value the version column shows `N/A`. Re-running
 * `buildEcosystemConfigSource` on every `genie install` AND on every
 * `genie update` (post-bun-package-swap, pre-pm2-reload) keeps the
 * displayed version in lockstep with the actual installed bytes.
 *
 * `version` is omitted (absent from JSON output) when the disk read fails,
 * which keeps tests deterministic and lets pm2 fall back to its default
 * `N/A` rather than crashing on a malformed config string.
 */
export function buildEcosystemConfigSource(geniePath: string, databaseUrl?: string): string {
  const logs = {
    out: join(getLogsDir(), `${PM2_LOG_PREFIX}-out.log`),
    error: join(getLogsDir(), `${PM2_LOG_PREFIX}-error.log`),
  };
  const version = readGenieVersionFromDisk(geniePath);
  // Use JSON.stringify for safe value escaping inside the generated JS.
  // When `databaseUrl` is supplied (canonical pgserve detected at install
  // time), it's baked into the pm2-stored env so the daemon picks it up
  // on every restart without operators having to set DATABASE_URL in their
  // shell. Without it, the daemon falls back to its embedded pgserve
  // auto-spawn path — which works, but defeats the canonical-shared-
  // backbone goal of the wish.
  const cfg: Record<string, unknown> = {
    name: PM2_PROCESS_NAME,
    script: geniePath,
    args: 'serve start --headless --no-tui --no-interactive',
    // Shebang resolution — geniePath is `#!/usr/bin/env bun`. With
    // `interpreter: 'bun'`, pm2's bun launcher errors out on top-level
    // await ("require() async module ... is unsupported"). 'none' makes
    // pm2 exec the script directly so the kernel honours the shebang.
    interpreter: 'none',
    autorestart: true,
    // A deliberate clean exit(0) ("genie serve already running") must NOT
    // trigger pm2 autorestart — otherwise one squatting daemon turns into
    // an unbounded respawn storm (uptime 0, thousands of restarts, empty
    // error log). pm2 treats a matched code as "stopped", not "errored".
    stop_exit_codes: [0],
    max_restarts: HARDENED_DEFAULTS.maxRestarts,
    min_uptime: HARDENED_DEFAULTS.minUptimeMs,
    restart_delay: HARDENED_DEFAULTS.restartDelayMs,
    exp_backoff_restart_delay: HARDENED_DEFAULTS.expBackoffRestartDelayMs,
    max_memory_restart: HARDENED_DEFAULTS.maxMemory,
    kill_timeout: HARDENED_DEFAULTS.killTimeoutMs,
    log_date_format: HARDENED_DEFAULTS.logDateFormat,
    error_file: logs.error,
    out_file: logs.out,
    merge_logs: true,
    time: true,
  };
  // `version` only when we successfully read the disk package.json — pm2 is
  // tolerant of a missing field but rejects non-string values.
  if (version) {
    cfg.version = version;
  }
  if (databaseUrl) {
    cfg.env = { DATABASE_URL: databaseUrl };
  }
  return `// Generated by \`genie install\` and \`genie update\` — do not edit by hand.
// Regenerated on every install/update invocation; \`version\` reflects the
// on-disk @automagik/genie package.json at write time.
module.exports = {
  apps: [${JSON.stringify(cfg, null, 2)}],
};
`;
}

/**
 * Write the ecosystem config to disk. Returns the absolute path. Idempotent
 * (overwrites every install — values are deterministic from defaults).
 */
function writeEcosystemConfig(geniePath: string, databaseUrl?: string): string {
  const path = getEcosystemConfigPath();
  ensureLogsDir(); // also ensures ~/.genie exists
  writeFileSync(path, buildEcosystemConfigSource(geniePath, databaseUrl), { mode: 0o644 });
  return path;
}

function buildPm2StartArgs(geniePath: string, databaseUrl?: string): string[] {
  // pm2 6 dropped CLI flags like --min-uptime / --max-restarts / etc.
  // ecosystem config is the only supported path. We write the config
  // first and tell pm2 to start from it.
  const configPath = writeEcosystemConfig(geniePath, databaseUrl);
  return ['start', configPath, '--update-env'];
}

function ensureLogsDir(): void {
  const dir = getLogsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o755 });
}

export interface InstallOptions {
  /** Skip the `pgserve install` step (operators who manage pgserve themselves). */
  skipPgserve?: boolean;
}

/**
 * Run the install. Idempotent. Exit code 0 on success or "already
 * installed"; non-zero on hard failure (pm2 missing, pm2 start failed).
 */
export async function installCommand(options: InstallOptions = {}): Promise<void> {
  if (!pm2IsAvailable()) {
    fail('pm2 not found in PATH. Install with: bun add -g pm2  (or npm i -g pm2)');
  }

  // Step 1 — canonical pgserve. Hard prerequisite: any failure here exits
  // the installer with the canonical install hint. Genie has no embedded
  // fallback after the canonical-cutover wish.
  let canonicalDatabaseUrl: string | undefined;
  if (!options.skipPgserve) {
    requirePgserveInstall();
    const port = tryPgservePort();
    if (port === null) {
      failCanonicalPgserve('pgserve port could not be discovered (run: pgserve port)');
    }
    canonicalDatabaseUrl = buildGenieDatabaseUrl(port);
    ok(`canonical pgserve detected; genie-serve will connect to ${canonicalDatabaseUrl}`);
  }

  // Step 2 — drop any legacy pm2 entries (genie-serve → Genie rename) so
  // the canonical name is the only one running after install. Idempotent:
  // no-op when no legacy entry exists. Done BEFORE the canonical check so
  // a freshly-renamed install still gets the right "already installed"
  // diagnostic on subsequent runs.
  removeLegacyPm2Entries((msg) => ok(msg));

  // Step 3 — pm2-supervise the canonical Genie service.
  const existing = pm2GetProcess(PM2_PROCESS_NAME);
  if (existing) {
    ok(
      `already installed (pm2 process "${PM2_PROCESS_NAME}", status=${existing.pm2_env?.status ?? 'unknown'}). Use \`pm2 delete ${PM2_PROCESS_NAME} && genie install\` to refresh the env (e.g. to pick up a new canonical pgserve URL).`,
    );
    return;
  }

  ensureLogsDir();
  const geniePath = resolveGenieBinary();
  const pm2Args = buildPm2StartArgs(geniePath, canonicalDatabaseUrl);
  const result = spawnSync('pm2', pm2Args, { stdio: 'inherit' });
  if (result.status !== 0) {
    fail(`pm2 start failed (exit ${result.status}). Logs: ${getLogsDir()}/${PM2_LOG_PREFIX}-error.log`);
  }

  ok(`installed: pm2 process "${PM2_PROCESS_NAME}" (logs: ${getLogsDir()})`);
  if (canonicalDatabaseUrl) {
    ok(`${PM2_PROCESS_NAME} env DATABASE_URL → ${canonicalDatabaseUrl}`);
  }
  ok('the genie bridge will now survive shell closure and host reboots (after `pm2 save` + `pm2 startup`).');
}

/**
 * Regenerate the pm2 ecosystem config on disk and return its path.
 * Called by `genie update` AFTER bun has swapped the package on disk so
 * the `version` field reflects the new install. Caller then runs
 * `pm2 startOrReload <path> --update-env` to pick up the change without
 * losing pid history.
 *
 * Idempotent. Read-only with respect to pm2 — does NOT shell out to pm2.
 * The daemon's `DATABASE_URL` env is preserved across regenerations:
 * `tryPgservePort()` re-reads the canonical port at write time so
 * operators who reinstall pgserve get the URL refreshed for free.
 */
export function regenerateEcosystemConfig(): string {
  const geniePath = resolveGenieBinary();
  const port = pgserveIsAvailable() ? tryPgservePort() : null;
  const databaseUrl = port !== null ? buildGenieDatabaseUrl(port) : undefined;
  return writeEcosystemConfig(geniePath, databaseUrl);
}

/**
 * Return the canonical + legacy pm2 process names in declaration order.
 * Consumers (`update.ts`, `doctor.ts`) iterate this list when they need
 * to find "the genie service under pm2 by any historical name". The
 * canonical name is first so `Array.find(...)` selects it when both a
 * canonical and a legacy entry are registered (transient state during
 * the rename migration).
 */
export function pm2ProcessNameCandidates(): string[] {
  return [PM2_PROCESS_NAME, ...LEGACY_PM2_PROCESS_NAMES];
}

/** Test surface — exported for unit tests. */
export const _internals = {
  HARDENED_DEFAULTS,
  PM2_PROCESS_NAME,
  PM2_LOG_PREFIX,
  LEGACY_PM2_PROCESS_NAMES,
  PGSERVE_PM2_PROCESS_NAMES,
  buildPm2StartArgs,
  buildEcosystemConfigSource,
  buildCanonicalPgserveHint,
  getEcosystemConfigPath,
  readGenieVersionFromDisk,
  resolveGenieBinary,
  pm2IsAvailable,
  pgserveIsAvailable,
  removeLegacyPm2Entries,
  isPgservePm2ManagedStatus,
  isPgserveReadyStatus,
  isPgserveOnlinePm2,
};
