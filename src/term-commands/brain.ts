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

const BRAIN_DIR = join(resolveGenieRoot(), 'node_modules', '@automagik', 'genie-brain');
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
    if (!existsSync(join(BRAIN_DIR, '.git'))) return;

    // Resolve local version from param or package.json
    const version = localVersion ?? readLocalBrainVersion();
    if (!version) return;

    // Fetch latest tags from remote
    execSync(`git -C "${BRAIN_DIR}" fetch origin --tags`, { stdio: 'pipe' });

    // Find latest v0.* tag via version sort
    const tagsOutput = execSync(`git -C "${BRAIN_DIR}" tag -l "v0.*" --sort=-version:refname`, {
      encoding: 'utf-8',
    });
    const latestTag = tagsOutput.trim().split('\n')[0] ?? '';
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
  // Check brain is installed (has .git dir from clone)
  if (!existsSync(join(BRAIN_DIR, '.git'))) {
    console.log('  Brain is not installed. Run: genie brain install');
    return false;
  }

  // Get old version before pull
  let oldVersion = 'unknown';
  try {
    const brain = await import(BRAIN_PKG);
    oldVersion = brain.getVersion?.() ?? 'unknown';
  } catch {
    /* ok */
  }

  console.log('  Updating brain from GitHub...');

  // Ensure we're on main before pulling — if the clone is on dev,
  // `git pull origin main` merges main INTO dev, keeping the dev version.
  execSync(`git -C "${BRAIN_DIR}" checkout main`, { stdio: 'pipe' });
  execSync(`git -C "${BRAIN_DIR}" pull origin main`, { stdio: 'inherit' });

  // Rebuild
  execSync('bun install', { cwd: BRAIN_DIR, stdio: 'inherit' });
  execSync('bun run build', { cwd: BRAIN_DIR, stdio: 'inherit' });

  // Get new version (read from package.json since module cache won't refresh)
  let newVersion = 'unknown';
  try {
    const pkg = JSON.parse(readFileSync(join(BRAIN_DIR, 'package.json'), 'utf-8'));
    newVersion = pkg.version ?? 'unknown';
  } catch {
    /* ok */
  }

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
      console.log(
        `    gh release download --repo ${BRAIN_REPO} --pattern '*.tgz' && bun add ${BRAIN_PKG}@./khal-os-brain-*.tgz`,
      );
      console.log('');
    } else {
      console.error(`  Install failed: ${msg}`);
      console.log('');
      console.log('  Manual install:');
      console.log(
        `    gh release download --repo ${BRAIN_REPO} --pattern '*.tgz' && bun add ${BRAIN_PKG}@./khal-os-brain-*.tgz`,
      );
      console.log('');
    }
    return false;
  }
}

function uninstallBrain(): void {
  try {
    const root = resolveGenieRoot();
    execSync(`bun remove ${BRAIN_PKG}`, { cwd: root, stdio: 'pipe' });
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
  console.log('  Requires GitHub org membership (automagik-dev).');
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
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isModuleNotFound(msg)) {
      printNotInstalledMessage();
    } else {
      console.error(`Brain error: ${msg}`);
    }
  }
}

export function registerBrainCommands(program: Command): void {
  const brain = program
    .command('brain')
    .description('Knowledge graph engine (enterprise)')
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
    });

  brain
    .command('install')
    .description('Install genie-brain from GitHub')
    .action(async () => {
      await installBrain();
    });

  brain
    .command('uninstall')
    .description('Remove genie-brain installation')
    .action(() => {
      uninstallBrain();
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
