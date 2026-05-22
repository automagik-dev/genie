/**
 * genie brain — delegate to @khal-os/brain (enterprise).
 *
 * Brain installs from a release tarball on the private GitHub repo.
 * Only people with repo access can install = enterprise license.
 * Published to GitHub Packages + release tarballs, never to npmjs.
 *
 * Brain is NEVER a hard dependency. genie works exactly the same
 * without it. Zero behavior change for OSS users.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import { type BrainRegistryApi, findBrainVault } from '../lib/brain-vaults.js';

const BRAIN_PKG = '@khal-os/brain';
const BRAIN_REPO = 'khal-os/brain';

/**
 * Canonical Brain installer (signed Gitea release flow). `genie brain
 * install` and `genie brain upgrade` are thin delegators to this URL —
 * never an inline downloader, never npm. Operators can override with
 * `BRAIN_INSTALLER_URL` for staging/forks.
 *
 * See: khal-core/brain → `scripts/install.sh` and `.well-known/<channel>.json`.
 */
const BRAIN_INSTALLER_URL =
  process.env.BRAIN_INSTALLER_URL ?? 'https://git.namastex.io/khal-core/brain/raw/branch/main/scripts/install.sh';

// Env vars the canonical installer reads. We thread the SAFE ones through
// from the calling shell into the delegated `bash -c …` so people can use
// genie as the install front door without losing their channel/home knobs.
// SECRET tokens are never echoed or persisted by genie — they ride through
// the inherited process env into the installer, which only routes them as
// Authorization headers to git.namastex.io.
const BRAIN_INSTALLER_SAFE_ENV = [
  'BRAIN_CHANNEL',
  'BRAIN_HOME',
  'BRAIN_BIN_DIR',
  'BRAIN_INSTALL_HOST',
  'BRAIN_INSTALL_REPO',
  'BRAIN_INSTALL_BRANCH',
  'BRAIN_VERSION',
  'BRAIN_INSECURE',
  'BRAIN_INSTALL_NO_SYMLINK',
  'BRAIN_INSTALL_KEEP_TMP',
] as const;

const BRAIN_INSTALLER_SECRET_ENV = ['BRAIN_GITEA_TOKEN', 'GITEA_TOKEN', 'TEA_TOKEN'] as const;

/** Resolve genie's package root — works from both src/ (dev) and dist/ (compiled). */
function resolveGenieRoot(): string {
  try {
    const scriptDir = dirname(realpathSync(process.argv[1]));
    const candidates = [
      resolve(scriptDir, '..'), // dist/ or src/ → project root
      resolve(scriptDir, '..', '..'), // src/term-commands/ → project root
    ];
    for (const c of candidates) {
      if (existsSync(join(c, 'package.json'))) return c;
    }
  } catch {
    /* fallback below */
  }
  // Fallback: import.meta.dir (works in dev, unreliable in compiled)
  return resolve(import.meta.dir, '..', '..');
}

const BRAIN_DIR = join(resolveGenieRoot(), 'node_modules', '@khal-os', 'brain');
const CACHE_PATH = join(homedir(), '.genie', 'brain-version-check.json');

/** Compare dot-separated version strings numerically (e.g., "260403.9" vs "260403.10"). */
export function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Read brain version from its local package.json. Returns undefined on failure. */
function readLocalBrainVersion(): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(BRAIN_DIR, 'package.json'), 'utf-8'));
    return (pkg.version as string | undefined) ?? 'unknown';
  } catch {
    return undefined;
  }
}

// ── Daemon lifecycle helpers ────────────────────────────────────────────────

/** Resolve the brain CLI binary. Prefers .bin symlink, falls back to dist/cli.js. */
function resolveBrainBin(): string | undefined {
  const candidates = [join(resolveGenieRoot(), 'node_modules', '.bin', 'brain'), join(BRAIN_DIR, 'dist', 'cli.js')];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

interface ActiveBrainConfig {
  pid: number;
  pgPort?: number;
  brainPath?: string;
}

/** Read ~/.brain/config.json for running server PID + brainPath. Returns null on failure. */
function readActiveBrainConfig(): ActiveBrainConfig | null {
  try {
    const configPath = join(homedir(), '.brain', 'config.json');
    if (!existsSync(configPath)) return null;
    const data = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (!data.pid) return null;
    return { pid: data.pid, pgPort: data.pgPort, brainPath: data.brainPath };
  } catch {
    return null;
  }
}

/** Check if a process is alive by signaling 0. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop a running brain daemon gracefully.
 * Calls `brain serve stop --brain-path`, polls PID 200ms × 25 (5s), SIGKILL fallback.
 * Returns true if a daemon was running and stopped.
 */
async function stopBrainDaemon(): Promise<boolean> {
  const config = readActiveBrainConfig();
  if (!config?.pid || !isProcessAlive(config.pid)) return false;

  const brainBin = resolveBrainBin();
  const brainPath = config.brainPath;

  // Use brain's own stop command
  if (brainBin) {
    try {
      const pathArg = brainPath ? ` --brain-path "${brainPath}"` : '';
      execSync(`"${brainBin}" serve stop${pathArg}`, { stdio: 'pipe', timeout: 10000 });
    } catch {
      // Fall through to PID polling — stop command may not be available in older versions
    }
  }

  // Poll PID for up to 5s (25 × 200ms)
  for (let i = 0; i < 25; i++) {
    if (!isProcessAlive(config.pid)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }

  // SIGKILL fallback
  try {
    process.kill(config.pid, 'SIGKILL');
  } catch {
    // Already gone
  }

  return true;
}

/** Start brain daemon for a vault. Logs result. Never throws. */
function startBrainDaemon(vaultPath: string, extraArgs?: string[]): void {
  const bin = resolveBrainBin();
  if (!bin) return;
  try {
    const argsStr = extraArgs?.length ? ` ${extraArgs.join(' ')}` : '';
    execSync(`"${bin}" serve --daemon --brain-path "${vaultPath}"${argsStr}`, {
      stdio: 'inherit',
      timeout: 15000,
    });
    console.log('  Brain daemon started.');
  } catch {
    console.log('  Daemon failed to start. Run: brain serve --daemon');
  }
}

// (readSavedDaemonArgs was used by the legacy in-genie upgrader; removed
// alongside the move to canonical-installer delegation. If a future
// upgrade flow wants to restart the daemon after upgrade, re-introduce
// it on the Brain side where the daemon lifecycle is owned.)

// ── Cache-only update check (no network, sync, never throws) ──────────────

interface UpdateCheck {
  updateAvailable: boolean;
  latestVersion?: string;
}

export function checkForUpdates(cachePath?: string): UpdateCheck {
  try {
    const p = cachePath ?? CACHE_PATH;
    if (!existsSync(p)) return { updateAvailable: false };
    const cache = JSON.parse(readFileSync(p, 'utf-8'));
    if (cache.updateAvailable && cache.latestVersion) {
      return { updateAvailable: true, latestVersion: cache.latestVersion };
    }
    return { updateAvailable: false };
  } catch {
    return { updateAvailable: false };
  }
}

// ── Refresh version cache (called by update and version commands) ──────────

function refreshVersionCache(localVersion?: string): void {
  try {
    // Resolve local version from param or package.json
    const version = localVersion ?? readLocalBrainVersion();
    if (!version) return;

    // Query latest release from GitHub via gh CLI (works for private repos)
    const latestTag = execSync(`gh release view --repo ${BRAIN_REPO} --json tagName -q .tagName`, {
      stdio: 'pipe',
      encoding: 'utf-8',
    }).trim();
    const latestVersion = latestTag.replace(/^v/, '');

    // Compare: strip prefix digit for comparison (dev uses 1.x, main uses 0.x)
    const localCore = version.replace(/^\d+\./, '');
    const latestCore = latestVersion.replace(/^\d+\./, '');
    const updateAvailable = compareVersions(latestCore, localCore) > 0;

    // Write cache
    const cacheDir = join(homedir(), '.genie');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      CACHE_PATH,
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          localVersion: version,
          latestTag,
          latestVersion,
          updateAvailable,
        },
        null,
        2,
      ),
    );
  } catch {
    // Never throw — cache refresh is best-effort
  }
}

// ── Update brain via canonical signed installer ────────────────────────────

interface DelegatedInstallPlan {
  installerUrl: string;
  channel: string;
  command: string;
  envSummary: Array<{ key: string; present: boolean; secret: boolean }>;
}

function planBrainInstallerDelegation(): DelegatedInstallPlan {
  const channel = process.env.BRAIN_CHANNEL ?? 'stable';
  const envSummary = [
    ...BRAIN_INSTALLER_SAFE_ENV.map((key) => ({
      key,
      present: process.env[key] !== undefined,
      secret: false,
    })),
    ...BRAIN_INSTALLER_SECRET_ENV.map((key) => ({
      key,
      present: process.env[key] !== undefined,
      secret: true,
    })),
  ];
  // The token never appears on the command line. The installer reads it
  // from the inherited env and routes it only as an Authorization header
  // to git.namastex.io.
  const command = `curl -fsSL "${BRAIN_INSTALLER_URL}" | bash`;
  return { installerUrl: BRAIN_INSTALLER_URL, channel, command, envSummary };
}

function printDelegationPlan(label: string, plan: DelegatedInstallPlan): void {
  console.log('');
  console.log(`  ${label} → canonical Brain installer`);
  console.log(`    installer: ${plan.installerUrl}`);
  console.log(`    channel:   ${plan.channel}`);
  console.log('    env:');
  for (const e of plan.envSummary) {
    const label = e.secret ? (e.present ? 'set (masked)' : 'not set') : e.present ? 'set' : 'not set';
    console.log(`      - ${e.key}: ${label}`);
  }
  console.log(`    command:   ${plan.command}`);
}

interface DelegationOptions {
  dryRun?: boolean;
  label?: string;
}

async function runBrainInstallerDelegation(opts: DelegationOptions = {}): Promise<boolean> {
  const plan = planBrainInstallerDelegation();
  const label = opts.label ?? 'Brain install';
  printDelegationPlan(label, plan);

  if (opts.dryRun) {
    console.log('  --dry-run: nothing executed.');
    return true;
  }

  try {
    execSync(plan.command, { stdio: 'inherit', env: process.env, shell: '/bin/bash' });
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('');
    console.error(`  ${label} failed: ${msg.split('\n')[0]}`);
    console.error('  See the canonical installer output above for details.');
    return false;
  }
}

async function updateBrain(opts: DelegationOptions = {}): Promise<boolean> {
  const oldVersion = readLocalBrainVersion();
  const ok = await runBrainInstallerDelegation({ ...opts, label: 'Brain upgrade' });
  if (ok && !opts.dryRun) {
    const newVersion = readLocalBrainVersion();
    if (oldVersion && newVersion && newVersion !== oldVersion) {
      console.log('');
      console.log(`  Updated: ${oldVersion} → ${newVersion}`);
    }
    refreshVersionCache(newVersion);
  }
  return ok;
}

// ── Show version ───────────────────────────────────────────────────────────

async function showVersion(): Promise<void> {
  let localVersion = 'not installed';
  try {
    const brain = await import(BRAIN_PKG);
    localVersion = brain.getVersion?.() ?? brain.VERSION ?? 'unknown';
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isModuleNotFound(msg)) {
      console.log('  Brain is not installed. Run: genie brain install');
      return;
    }
  }

  console.log(`  Local:  ${localVersion}`);

  // Force fresh check (does network call via refreshVersionCache)
  refreshVersionCache(localVersion);
  const check = checkForUpdates();

  if (check.updateAvailable && check.latestVersion) {
    console.log(`  Latest: ${check.latestVersion}`);
    console.log('');
    console.log('  Update available. Run: genie brain upgrade');
  } else {
    console.log('  Status: up to date');
  }
}

// ── Install brain ──────────────────────────────────────────────────────────

/**
 * Install brain via the canonical signed Brain installer.
 *
 * `genie brain install` is a thin delegator. It never inlines an alternate
 * downloader, never uses npm, never embeds tokens in the command line.
 * It runs Brain's `scripts/install.sh` from `khal-core/brain` with the
 * inherited environment so users can pass `BRAIN_CHANNEL`, `BRAIN_HOME`,
 * `BRAIN_GITEA_TOKEN` etc. through `genie brain install` exactly as if
 * they had piped install.sh directly to bash.
 */
async function installBrain(opts: DelegationOptions = {}): Promise<boolean> {
  // Honour the brain.embedded=false opt-out. Power-users manage brain as a
  // standalone install and do not want genie fetching anything behind
  // their back.
  const { loadGenieConfigSync } = await import('../lib/genie-config.js');
  if (!loadGenieConfigSync().brain.embedded) {
    console.log('');
    console.log('  Brain is configured as external (brain.embedded=false).');
    console.log('  Genie will not run the Brain installer on your behalf.');
    console.log('');
    console.log('  Install brain standalone via the canonical signed installer:');
    console.log(`    curl -fsSL ${BRAIN_INSTALLER_URL} | bash`);
    console.log('');
    console.log('  Channels:  BRAIN_CHANNEL=stable|homolog|dev');
    console.log('  Token:     export BRAIN_GITEA_TOKEN=<token>   (or GITEA_TOKEN / TEA_TOKEN)');
    console.log('');
    console.log('  Then run your own brain serve:');
    console.log('    brain serve --brain-path <path> [--port <port>]');
    console.log('');
    console.log('  To re-enable embedded management, remove brain.embedded from');
    console.log('  ~/.genie/config.json (or set it to true).');
    console.log('');
    return true;
  }

  const ok = await runBrainInstallerDelegation({ ...opts, label: 'Brain install' });
  if (!ok || opts.dryRun) return ok;

  // Best-effort post-install wiring: migrations, install wizard, daemon
  // auto-start. Any failure here is non-fatal — the binary itself is
  // already installed and usable from `$BRAIN_HOME/bin/brain`.
  let installedBrain: BrainRegistryApi | null = null;
  try {
    const brain = await import(BRAIN_PKG);
    installedBrain = brain as BrainRegistryApi;
    if (brain.runAllMigrations) {
      console.log('');
      console.log('  Running brain migrations...');
      await brain.runAllMigrations();
      console.log('  Brain tables created in Postgres.');
    }
  } catch {
    console.log('  Auto-migration skipped. Run: genie brain migrate');
  }

  await runBrainInstallWizard();

  const vaultPath = await findBrainVault({ brain: installedBrain });
  if (vaultPath) {
    startBrainDaemon(vaultPath);
  } else {
    console.log('  No brain vault found. Create one with: brain init --name <name> --path <path>');
  }

  console.log('');
  console.log('  Get started:');
  console.log('    genie brain init --name my-brain --path ./brain');
  console.log('');
  return true;
}

/**
 * Closes khal-os/brain wish brain-v2-onboarding-overhaul Grupo G:
 * chain the brain-side install wizard after the binary is installed
 * + migrations have run. The wizard does:
 *   - diagnose (wraps `brain doctor`)
 *   - auto-install rlmx if missing (`bun install -g @automagik/rlmx`)
 *   - run a smoke test (`brain doctor --json` parse)
 *
 * Idempotent: re-run on a healthy env is a no-op. Best-effort: any
 * failure here is non-fatal because the binary itself is already
 * installed and usable. Operator can re-run manually with
 * `brain install --apply --yes`.
 */
async function runBrainInstallWizard(): Promise<void> {
  try {
    const brain = await import(BRAIN_PKG);
    if (brain.execute) {
      console.log('');
      console.log('  Running brain install wizard (rlmx + smoke test)...');
      await brain.execute(['install', '--apply', '--yes']);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  Install wizard skipped (${msg.split('\n')[0]}). Run manually: brain install --apply --yes`);
  }
}

async function uninstallBrain(): Promise<void> {
  try {
    if (!existsSync(BRAIN_DIR)) {
      console.log('  Brain is not installed.');
      return;
    }

    // Stop running daemon before removing files
    await stopBrainDaemon();

    execSync(`rm -rf "${BRAIN_DIR}"`, { stdio: 'pipe' });
    console.log('  Brain uninstalled.');
  } catch {
    console.error(`  Uninstall failed. Manual: rm -rf ${BRAIN_DIR}`);
  }
}

function isModuleNotFound(msg: string): boolean {
  return msg.includes('Cannot find') || msg.includes('not found') || msg.includes('MODULE_NOT_FOUND');
}

function printNotInstalledMessage(): void {
  console.log('');
  console.log('  Brain is an enterprise knowledge graph engine.');
  console.log('  It is not installed.');
  console.log('');
  console.log('  Quick install:');
  console.log('');
  console.log('    genie brain install');
  console.log('');
  console.log('  Requires GitHub org membership (khal-os).');
  console.log('');
}

async function executeBrainCommand(args: string[]): Promise<void> {
  try {
    const brain = await import(BRAIN_PKG);
    if (brain.execute) {
      await brain.execute(args);

      // Auto-check hint (cache-only, no network, sync)
      const check = checkForUpdates();
      if (check.updateAvailable && check.latestVersion) {
        console.log(`\n  Update available (${check.latestVersion}). Run: genie brain upgrade`);
      }
    } else {
      console.error('Brain module loaded but execute() not found.');
      console.error('Update: genie brain install');
      process.exit(1);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isModuleNotFound(msg)) {
      printNotInstalledMessage();
      process.exit(1);
    } else {
      console.error(`Brain error: ${msg}`);
      process.exit(1);
    }
  }
}

export function registerBrainCommands(program: Command): void {
  const brain = program
    .command('brain')
    .description('Knowledge graph engine (enterprise) — forwards unknown subcommands to @khal-os/brain')
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (_options: Record<string, unknown>, cmd: Command) => {
      // Fallback: delegate unrecognized subcommands to the enterprise brain module
      // (e.g. init, search, ingest, analyze, etc.)
      const args = cmd.args;
      if (args.length === 0) {
        brain.help();
        return;
      }
      await executeBrainCommand(args);
    })
    .addHelpText(
      'after',
      `
Forwarded commands (require @khal-os/brain installed):
  status              Show running brain server status
  health              Show brain health score
  init                Initialize a new brain vault
  search <query>      Search the brain knowledge graph
  ingest <path>       Ingest files into the brain
  analyze <path>      Analyze a file against the brain
  config              Manage brain configuration
  mount/unmount       Mount brains
  graph               Explore the knowledge graph
  traces              View reasoning traces

Examples:
  $ genie brain status
  $ genie brain search "how does login work"
  $ genie brain init --name my-brain --path ./brain

Install brain: genie brain install`,
    );

  brain
    .command('install')
    .description('Install Brain via the canonical signed installer (Gitea release)')
    .option('--dry-run', 'Print the planned installer command and exit; do not execute')
    .action(async (cmdOpts: { dryRun?: boolean }) => {
      await installBrain({ dryRun: cmdOpts.dryRun });
    });

  brain
    .command('uninstall')
    .description('Remove Brain installation (sweeps legacy npm-style installs too)')
    .action(async () => {
      await uninstallBrain();
    });

  brain
    .command('upgrade')
    .alias('update-self')
    .description('Upgrade Brain via the canonical signed installer')
    .option('--dry-run', 'Print the planned installer command and exit; do not execute')
    .action(async (cmdOpts: { dryRun?: boolean }) => {
      await updateBrain({ dryRun: cmdOpts.dryRun });
    });

  brain
    .command('version')
    .description('Show installed brain version')
    .action(async () => {
      await showVersion();
    });
}
