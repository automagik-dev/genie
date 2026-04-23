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

const BRAIN_PKG = '@khal-os/brain';
const BRAIN_REPO = 'khal-os/brain';

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

/** Search for a brain vault (brain.json) in common locations. Returns path or null. */
function findBrainVault(): string | null {
  const candidates = [process.cwd(), join(process.cwd(), 'brain'), join(homedir(), 'brain')];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'brain.json'))) return dir;
  }
  return null;
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

/** Read saved daemon args from .brain-server.json in a vault. */
function readSavedDaemonArgs(brainPath: string): string[] | undefined {
  try {
    const serverJsonPath = join(brainPath, '.brain-server.json');
    const serverInfo = JSON.parse(readFileSync(serverJsonPath, 'utf-8'));
    return serverInfo.args;
  } catch {
    return undefined;
  }
}

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

// ── Update brain from GitHub ───────────────────────────────────────────────

async function updateBrain(): Promise<boolean> {
  // Check brain is installed (has package.json from tarball extract)
  if (!existsSync(join(BRAIN_DIR, 'package.json'))) {
    console.log('  Brain is not installed. Run: genie brain install');
    return false;
  }

  // Get old version before update
  const oldVersion = readLocalBrainVersion() ?? 'unknown';

  console.log('  Checking for updates...');

  // Query latest release from GitHub
  let tag: string;
  try {
    tag = execSync(`gh release view --repo ${BRAIN_REPO} --json tagName -q .tagName`, {
      stdio: 'pipe',
      encoding: 'utf-8',
    }).trim();
  } catch {
    console.error('  Failed to check latest release. Ensure: gh auth login');
    return false;
  }

  const newVersion = tag.replace(/^v/, '');
  if (compareVersions(newVersion, oldVersion) <= 0) {
    console.log(`  Already at latest version (${oldVersion}).`);
    return true;
  }

  console.log(`  Upgrading: ${oldVersion} → ${newVersion}`);
  console.log('');

  // Stop running daemon before upgrade (read saved args for restart)
  const activeConfig = readActiveBrainConfig();
  const savedArgs = activeConfig?.brainPath ? readSavedDaemonArgs(activeConfig.brainPath) : undefined;
  const wasRunning = activeConfig ? await stopBrainDaemon() : false;

  // Download and extract new tarball (same flow as install)
  const tmpDir = join(homedir(), '.cache', 'genie-brain');
  mkdirSync(tmpDir, { recursive: true });

  execSync(`gh release download ${tag} --repo ${BRAIN_REPO} --pattern '*.tgz' --dir "${tmpDir}" --clobber`, {
    stdio: 'inherit',
  });

  // Replace existing install
  execSync(`rm -rf "${BRAIN_DIR}"`, { stdio: 'pipe' });
  mkdirSync(BRAIN_DIR, { recursive: true });
  execSync(`tar xzf "${tmpDir}/khal-os-brain-${newVersion}.tgz" -C "${BRAIN_DIR}" --strip-components=1`, {
    stdio: 'inherit',
  });

  // Install runtime deps
  execSync('bun install', { cwd: BRAIN_DIR, stdio: 'inherit' });

  console.log(`\n  Updated: ${oldVersion} → ${newVersion}`);

  // Run migrations via subprocess — import() cache returns stale pre-update
  // module, so new migrations would be skipped. A fresh bun process loads
  // the rebuilt code from disk.
  try {
    const migrateScript = `const b = require('${BRAIN_PKG}'); if (b.runAllMigrations) b.runAllMigrations().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); }); else process.exit(0);`;
    execSync(`bun -e "${migrateScript}"`, { cwd: BRAIN_DIR, stdio: 'inherit' });
    console.log('  Migrations applied.');
  } catch {
    console.log('  Migration skipped. Run: genie brain migrate');
  }

  // Refresh version cache
  refreshVersionCache(newVersion);

  // Restart daemon if it was running before upgrade
  if (wasRunning && activeConfig?.brainPath) {
    startBrainDaemon(activeConfig.brainPath, savedArgs);
  }

  return true;
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

/** Install brain package from GitHub release tarball */
async function installBrain(): Promise<boolean> {
  // Honour the brain.embedded=false opt-out. Power-users manage brain as a
  // standalone global install (typically from the @next dev channel) and do
  // not want genie fetching a release tarball behind their back.
  const { loadGenieConfigSync } = await import('../lib/genie-config.js');
  if (!loadGenieConfigSync().brain.embedded) {
    console.log('');
    console.log('  Brain is configured as external (brain.embedded=false).');
    console.log('  Genie will not install brain into its node_modules.');
    console.log('');
    console.log('  Install brain standalone instead:');
    console.log('    bun install -g @khal-os/brain@next    # dev channel');
    console.log('    bun install -g @khal-os/brain         # stable channel');
    console.log('');
    console.log('  Then run your own brain serve:');
    console.log('    brain serve --brain-path <path> [--port <port>]');
    console.log('');
    console.log('  To re-enable embedded management, remove brain.embedded from');
    console.log('  ~/.genie/config.json (or set it to true).');
    console.log('');
    return true;
  }

  console.log('');
  console.log('  Installing brain from GitHub release (enterprise)...');
  console.log('');
  console.log('  Source: https://github.com/khal-os/brain');
  console.log('  Requires: GitHub org membership (khal-os)');
  console.log('');

  try {
    // Verify GitHub CLI is authenticated (no token extraction — gh handles auth securely)
    try {
      execSync('gh auth token', { stdio: 'pipe' });
    } catch {
      console.error('  GitHub CLI not authenticated. Run: gh auth login');
      return false;
    }

    // Resolve latest release tag and download tarball via gh (handles private repo auth)
    const tag = execSync(`gh release view --repo ${BRAIN_REPO} --json tagName -q .tagName`, {
      stdio: 'pipe',
      encoding: 'utf-8',
    }).trim();
    const version = tag.replace(/^v/, '');

    console.log(`  Latest release: ${tag}`);
    console.log('');

    // Download tarball via gh (handles private repo auth) and extract to node_modules.
    // We bypass `bun add` because .npmrc scope config causes bun to verify against
    // GitHub Packages registry even for local tarballs, triggering 401 on machines
    // without registry tokens.
    const root = resolveGenieRoot();
    const brainDir = join(root, 'node_modules', '@khal-os', 'brain');
    const tmpDir = join(homedir(), '.cache', 'genie-brain');
    mkdirSync(tmpDir, { recursive: true });

    execSync(`gh release download ${tag} --repo ${BRAIN_REPO} --pattern '*.tgz' --dir "${tmpDir}" --clobber`, {
      stdio: 'inherit',
    });

    // Extract tarball — npm tarballs contain a `package/` prefix
    execSync(`rm -rf "${brainDir}"`, { stdio: 'pipe' });
    mkdirSync(brainDir, { recursive: true });
    execSync(`tar xzf "${tmpDir}/khal-os-brain-${version}.tgz" -C "${brainDir}" --strip-components=1`, {
      stdio: 'inherit',
    });

    // Install brain's runtime deps (postgres, pgserve, etc.)
    execSync('bun install', { cwd: brainDir, stdio: 'inherit' });

    console.log('');
    console.log(`  Brain ${version} installed from GitHub release.`);
    console.log('');

    // Auto-run migrations
    try {
      const brain = await import(BRAIN_PKG);
      if (brain.runAllMigrations) {
        console.log('  Running brain migrations...');
        await brain.runAllMigrations();
        console.log('  Brain tables created in Postgres.');
      }
    } catch {
      console.log('  Auto-migration skipped. Run: genie brain migrate');
    }

    await runBrainInstallWizard();

    // Auto-start daemon if a vault is found
    const vaultPath = findBrainVault();
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
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);

    if (msg.includes('Authentication') || msg.includes('permission') || msg.includes('404')) {
      console.error('  Access denied. Brain is enterprise-only.');
      console.log('');
      console.log('  You need:');
      console.log('    1. Membership in the khal-os GitHub org');
      console.log('    2. GitHub CLI authenticated: gh auth login');
      console.log('');
      console.log('  Manual install:');
      console.log(`    gh release download --repo ${BRAIN_REPO} --pattern '*.tgz'`);
      console.log('    tar xzf khal-os-brain-*.tgz -C node_modules/@khal-os/brain --strip-components=1');
      console.log('');
    } else {
      console.error(`  Install failed: ${msg}`);
      console.log('');
      console.log('  Manual install:');
      console.log(`    gh release download --repo ${BRAIN_REPO} --pattern '*.tgz'`);
      console.log('    tar xzf khal-os-brain-*.tgz -C node_modules/@khal-os/brain --strip-components=1');
      console.log('');
    }
    return false;
  }
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
    .description('Install genie-brain from GitHub')
    .action(async () => {
      await installBrain();
    });

  brain
    .command('uninstall')
    .description('Remove genie-brain installation')
    .action(async () => {
      await uninstallBrain();
    });

  brain
    .command('upgrade')
    .description('Upgrade genie-brain to latest version')
    .action(async () => {
      await updateBrain();
    });

  brain
    .command('version')
    .description('Show installed brain version')
    .action(async () => {
      await showVersion();
    });
}
