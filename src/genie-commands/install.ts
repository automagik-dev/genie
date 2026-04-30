/**
 * `genie install` — register genie-serve under pm2 with hardened defaults.
 *
 * Wave 2 of the canonical-pgserve-pm2-supervision wish (PR pgserve#55,
 * Wave 1 = pgserve#57). Mirrors `omni install`: shells out to `pgserve
 * install` first (idempotent — no-op when pgserve is already pm2-managed),
 * then registers `genie-serve` under pm2 so the bridge survives shell
 * exits and host reboots.
 *
 * Hardened defaults shared with pgserve and omni — same numbers everywhere
 * so the four pm2 services in the canonical stack
 * (pgserve / omni-api / omni-nats / genie-serve) behave identically under
 * crash-loop and resource pressure. See `~/.genie/logs/genie-serve-*.log`
 * after install.
 *
 * The command is idempotent. Re-running `genie install` after it's
 * already registered prints "already installed" and exits 0. Operators
 * wanting to change ports / data dirs run `genie uninstall` (eventually)
 * + `genie install` again. Until then, `pm2 restart genie-serve` is the
 * way to pick up code changes.
 *
 * Empirically validated 2026-04-30 on a production server. The exact
 * `pm2 start` invocation here matches the manual command pinned in
 * Decisions 4 & 5 of the wish.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PM2_PROCESS_NAME = 'genie-serve';

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

function note(msg: string): void {
  process.stderr.write(`genie install: ${msg}\n`);
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

function pm2GetProcess(name: string): { pid?: number; pm2_env?: { status?: string } } | null {
  try {
    const out = execFileSync('pm2', ['jlist'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const list = JSON.parse(out) as Array<{ name?: string; pid?: number; pm2_env?: { status?: string } }>;
    return list.find((p) => p.name === name) ?? null;
  } catch {
    return null;
  }
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
 * Best-effort: shell out to `pgserve install` so the canonical pgserve is
 * registered under pm2 before genie-serve depends on it. The command is
 * idempotent on the pgserve side, so running it on every `genie install`
 * is safe.
 *
 * Returns true on success or "already installed" exit. Returns false when
 * pgserve isn't installed globally — caller then decides whether to fail
 * or warn-and-continue. Today we warn-and-continue: genie can run without
 * pgserve (it has its own pgserve daemon embedded in `genie serve`), but
 * an operator wiring the canonical stack should install pgserve globally.
 */
function tryPgserveInstall(): boolean {
  if (!pgserveIsAvailable()) {
    note(
      'pgserve binary not found in PATH. Skipping the canonical pgserve hookup. ' +
        'Install with: bun add -g pgserve  (then re-run genie install).',
    );
    return false;
  }
  const result = spawnSync('pgserve', ['install'], { stdio: 'inherit' });
  if (result.status !== 0) {
    note(`pgserve install exited with code ${result.status}. Continuing — genie-serve registration proceeds.`);
    return false;
  }
  return true;
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
  // failing the install.
  return process.argv[1] ?? 'genie';
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
 * time; we generate it deterministically from `HARDENED_DEFAULTS` and the
 * resolved `geniePath`. Exported for unit tests to assert content shape.
 */
export function buildEcosystemConfigSource(geniePath: string): string {
  const logs = {
    out: join(getLogsDir(), `${PM2_PROCESS_NAME}-out.log`),
    error: join(getLogsDir(), `${PM2_PROCESS_NAME}-error.log`),
  };
  // Use JSON.stringify for safe value escaping inside the generated JS.
  const cfg = {
    name: PM2_PROCESS_NAME,
    script: geniePath,
    args: 'serve start --headless --no-tui --no-interactive',
    // Shebang resolution — geniePath is `#!/usr/bin/env bun`. With
    // `interpreter: 'bun'`, pm2's bun launcher errors out on top-level
    // await ("require() async module ... is unsupported"). 'none' makes
    // pm2 exec the script directly so the kernel honours the shebang.
    interpreter: 'none',
    autorestart: true,
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
  return `// Generated by \`genie install\` — do not edit by hand.
// Regenerated on every \`genie install\` invocation.
module.exports = {
  apps: [${JSON.stringify(cfg, null, 2)}],
};
`;
}

/**
 * Write the ecosystem config to disk. Returns the absolute path. Idempotent
 * (overwrites every install — values are deterministic from defaults).
 */
function writeEcosystemConfig(geniePath: string): string {
  const path = getEcosystemConfigPath();
  ensureLogsDir(); // also ensures ~/.genie exists
  writeFileSync(path, buildEcosystemConfigSource(geniePath), { mode: 0o644 });
  return path;
}

function buildPm2StartArgs(geniePath: string): string[] {
  // pm2 6 dropped CLI flags like --min-uptime / --max-restarts / etc.
  // ecosystem config is the only supported path. We write the config
  // first and tell pm2 to start from it.
  const configPath = writeEcosystemConfig(geniePath);
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

  // Step 1 — canonical pgserve. Best-effort; we continue on failure
  // because genie can boot its embedded pgserve as a fallback.
  if (!options.skipPgserve) {
    tryPgserveInstall();
  }

  // Step 2 — pm2-supervise genie-serve.
  const existing = pm2GetProcess(PM2_PROCESS_NAME);
  if (existing) {
    ok(
      `already installed (pm2 process "${PM2_PROCESS_NAME}", status=${existing.pm2_env?.status ?? 'unknown'}). Use \`pm2 restart genie-serve\` to pick up code changes.`,
    );
    return;
  }

  ensureLogsDir();
  const geniePath = resolveGenieBinary();
  const pm2Args = buildPm2StartArgs(geniePath);
  const result = spawnSync('pm2', pm2Args, { stdio: 'inherit' });
  if (result.status !== 0) {
    fail(`pm2 start failed (exit ${result.status}). Logs: ${getLogsDir()}/${PM2_PROCESS_NAME}-error.log`);
  }

  ok(`installed: pm2 process "${PM2_PROCESS_NAME}" (logs: ${getLogsDir()})`);
  ok('the genie bridge will now survive shell closure and host reboots (after `pm2 save` + `pm2 startup`).');
}

/** Test surface — exported for unit tests. */
export const _internals = {
  HARDENED_DEFAULTS,
  PM2_PROCESS_NAME,
  buildPm2StartArgs,
  buildEcosystemConfigSource,
  getEcosystemConfigPath,
  resolveGenieBinary,
  pm2IsAvailable,
  pgserveIsAvailable,
};
