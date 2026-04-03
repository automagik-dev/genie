/**
 * genie brain — delegate to @automagik/genie-brain (enterprise).
 *
 * Brain installs directly from the private GitHub repo.
 * Only people with repo access can install = enterprise license.
 * Source code stays in git, never published to npm.
 *
 * Brain is NEVER a hard dependency. genie works exactly the same
 * without it. Zero behavior change for OSS users.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';

const BRAIN_PKG = '@automagik/genie-brain';
const BRAIN_REPO = 'github:automagik-dev/genie-brain';
const BRAIN_DIR = 'node_modules/@automagik/genie-brain';
const CACHE_PATH = join(homedir(), '.genie', 'brain-version-check.json');

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
    const updateAvailable = latestCore > localCore;

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

  // git pull origin main
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

  // Run migrations (warn on failure, don't abort)
  try {
    const brain = await import(BRAIN_PKG);
    if (brain.runAllMigrations) {
      await brain.runAllMigrations();
      console.log('  Migrations applied.');
    }
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
    console.log('  Update available. Run: genie brain update');
  } else {
    console.log('  Status: up to date');
  }
}

// ── Install brain ──────────────────────────────────────────────────────────

/** Install brain package directly from GitHub repo */
async function installBrain(): Promise<boolean> {
  console.log('');
  console.log('  Installing genie-brain from GitHub (enterprise)...');
  console.log('');
  console.log('  Source: https://github.com/automagik-dev/genie-brain');
  console.log('  Requires: GitHub org membership (automagik-dev)');
  console.log('');

  try {
    // Verify GitHub CLI is authenticated (no token extraction — gh handles auth securely)
    try {
      execSync('gh auth token', { stdio: 'pipe' });
    } catch {
      console.error('  GitHub CLI not authenticated. Run: gh auth login');
      return false;
    }

    // Clone brain repo using gh CLI (handles private repos without exposing tokens in process list)
    execSync(`rm -rf "${BRAIN_DIR}"`, { stdio: 'pipe' });
    execSync('mkdir -p node_modules/@automagik', { stdio: 'pipe' });
    execSync(`gh repo clone automagik-dev/genie-brain "${BRAIN_DIR}" -- --depth 1`, {
      stdio: 'inherit',
    });

    // Install brain's deps + build
    execSync('bun install', { cwd: BRAIN_DIR, stdio: 'inherit' });
    execSync('bun run build', { cwd: BRAIN_DIR, stdio: 'inherit' });

    console.log('');
    console.log('  Brain installed from GitHub.');
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
      console.log('    1. Membership in the automagik-dev GitHub org');
      console.log('    2. SSH key or GH token configured for git');
      console.log('');
      console.log('  Manual install:');
      console.log(`    bun add ${BRAIN_REPO}`);
      console.log('');
    } else {
      console.error(`  Install failed: ${msg}`);
      console.log('');
      console.log('  Manual install:');
      console.log(`    bun add ${BRAIN_REPO}`);
      console.log('');
    }
    return false;
  }
}

function uninstallBrain(): void {
  try {
    execSync(`rm -rf "${BRAIN_DIR}"`, { stdio: 'pipe' });
    console.log('  Brain uninstalled.');
  } catch {
    console.error('  Uninstall failed. Manual: rm -rf node_modules/@automagik/genie-brain');
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
        console.log(`\n  Update available (${check.latestVersion}). Run: genie brain update`);
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
  program
    .command('brain')
    .description('Knowledge graph engine (enterprise)')
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (_options: Record<string, unknown>, cmd: Command) => {
      const args = cmd.args;

      if (args[0] === 'install') {
        await installBrain();
        return;
      }
      if (args[0] === 'uninstall') {
        uninstallBrain();
        return;
      }
      if (args[0] === 'update') {
        await updateBrain();
        return;
      }
      if (args[0] === 'version') {
        await showVersion();
        return;
      }
      await executeBrainCommand(args);
    });
}
