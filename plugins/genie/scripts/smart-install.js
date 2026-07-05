#!/usr/bin/env node
import { execSync, spawnSync } from 'node:child_process';
/**
 * Smart Install Script for genie
 *
 * Ensures required dependencies are installed:
 * - Bun runtime (auto-installs if missing)
 * - tmux (guides user if missing - can't auto-install)
 * - genie CLI (installed globally via bun)
 *
 * Also handles:
 * - Dependency installation when version changes
 * - Version marker management
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.env.CLAUDE_PLUGIN_ROOT || join(homedir(), '.claude', 'plugins', 'genie');
const GENIE_DIR = join(homedir(), '.genie');
const MARKER = join(GENIE_DIR, '.install-version');
const IS_WINDOWS = process.platform === 'win32';

// Common installation paths (handles fresh installs before PATH reload)
const BUN_COMMON_PATHS = IS_WINDOWS
  ? [join(homedir(), '.bun', 'bin', 'bun.exe')]
  : [join(homedir(), '.bun', 'bin', 'bun'), '/usr/local/bin/bun', '/opt/homebrew/bin/bun'];

const GENIE_COMMON_PATHS = IS_WINDOWS
  ? [join(homedir(), '.bun', 'bin', 'genie.exe')]
  : [join(homedir(), '.bun', 'bin', 'genie'), '/usr/local/bin/genie', '/opt/homebrew/bin/genie'];

/**
 * Get the Bun executable path
 */
function getBunPath() {
  // Try PATH first
  try {
    const result = spawnSync('bun', ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS,
    });
    if (result.status === 0) return 'bun';
  } catch {
    // Not in PATH
  }
  return BUN_COMMON_PATHS.find(existsSync) || null;
}

function isBunInstalled() {
  return getBunPath() !== null;
}

function getBunVersion() {
  const bunPath = getBunPath();
  if (!bunPath) return null;
  try {
    const result = spawnSync(bunPath, ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS,
    });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Install Bun automatically
 */
function installBun() {
  console.error('Installing Bun runtime...');
  try {
    if (IS_WINDOWS) {
      execSync('powershell -c "irm bun.com/install.ps1 | iex"', { stdio: ['pipe', 'pipe', 'inherit'], shell: true });
    } else {
      execSync('curl -fsSL https://bun.com/install | bash', { stdio: ['pipe', 'pipe', 'inherit'], shell: true });
    }
    if (!isBunInstalled()) {
      throw new Error('Bun installation completed but binary not found. Please restart your terminal.');
    }
    console.error(`Bun ${getBunVersion()} installed`);
  } catch (error) {
    console.error('Failed to install Bun. Please install manually:');
    if (IS_WINDOWS) {
      console.error('  winget install Oven-sh.Bun');
    } else {
      console.error('  curl -fsSL https://bun.com/install | bash');
    }
    throw error;
  }
}

/**
 * Check if tmux is installed
 */
function isTmuxInstalled() {
  try {
    const result = spawnSync('tmux', ['-V'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Get tmux version
 */
function getTmuxVersion() {
  try {
    const result = spawnSync('tmux', ['-V'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS,
    });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Check if dependencies need to be installed
 */
function needsInstall() {
  if (!existsSync(join(ROOT, 'node_modules'))) return true;
  if (!existsSync(join(ROOT, 'package.json'))) return false; // No package.json = no deps needed

  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    if (!existsSync(MARKER)) return true;
    const marker = JSON.parse(readFileSync(MARKER, 'utf-8'));
    return pkg.version !== marker.version || getBunVersion() !== marker.bun;
  } catch {
    return true;
  }
}

/**
 * Install dependencies using Bun
 */
function installDeps() {
  const bunPath = getBunPath();
  if (!bunPath) {
    throw new Error('Bun executable not found');
  }

  console.error('Installing dependencies...');

  // Ensure .genie directory exists
  if (!existsSync(GENIE_DIR)) {
    mkdirSync(GENIE_DIR, { recursive: true });
  }

  const bunCmd = IS_WINDOWS && bunPath.includes(' ') ? `"${bunPath}"` : bunPath;
  execSync(`${bunCmd} install`, { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'], shell: IS_WINDOWS });

  // Write version marker
  let version = 'unknown';
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    version = pkg.version;
  } catch {
    // Ignore
  }

  writeFileSync(
    MARKER,
    JSON.stringify({
      version,
      bun: getBunVersion(),
      tmux: getTmuxVersion(),
      installedAt: new Date().toISOString(),
    }),
  );
}

/**
 * Get the genie executable path
 */
function getGeniePath() {
  // Try PATH first
  try {
    const result = spawnSync('genie', ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS,
    });
    if (result.status === 0) return 'genie';
  } catch {
    // Not in PATH
  }
  return GENIE_COMMON_PATHS.find(existsSync) || null;
}

/**
 * Get installed genie CLI version (via bun global)
 */
function getGenieVersion() {
  const geniePath = getGeniePath();
  if (!geniePath) return null;
  try {
    const result = spawnSync(geniePath, ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS,
    });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Get the plugin's package version
 */
function getPluginVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    return pkg.version || null;
  } catch {
    return null;
  }
}

/**
 * Check if genie CLI needs FIRST-TIME install.
 * Only returns true when binary is completely missing.
 * Upgrades are explicit via `genie update` — never mid-session.
 */
function genieCliNeedsInstall() {
  return !getGenieVersion();
}


// NOTE: this script used to copy rules/genie-orchestration.md into
// ~/.claude/rules/ on version change. That injection is gone: the rules file
// is plugin-native (loaded from the plugin itself), and the copy kept
// resurrecting a file that `genie install`'s v4 cleanup deletes.

/**
 * Create default ~/.genie/config.json with schema v2 defaults if missing.
 * Also migrates stale keys from older versions.
 */
function createDefaultConfig() {
  const configPath = join(GENIE_DIR, 'config.json');
  if (!existsSync(configPath)) {
    if (!existsSync(GENIE_DIR)) {
      mkdirSync(GENIE_DIR, { recursive: true });
    }
    writeFileSync(configPath, JSON.stringify({
      version: 2,
      promptMode: 'append',
      session: { name: 'genie', defaultWindow: 'shell', autoCreate: true },
      terminal: { execTimeout: 120000, readLines: 100 },
      logging: { tmuxDebug: false, verbose: false },
      shell: { preference: 'auto' },
      shortcuts: { tmuxInstalled: false, shellInstalled: false },
      setupComplete: false,
    }, null, 2), 'utf-8');
    console.error('Created default ~/.genie/config.json');
  } else {
    // Migrate: remove stale worktreeBase that overrides dynamic default
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (config.terminal && config.terminal.worktreeBase === '.worktrees') {
        delete config.terminal.worktreeBase;
        writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
        console.error('Migrated config: removed stale worktreeBase');
      }
    } catch {
      // Ignore migration errors
    }
  }
}

/**
 * Copy tmux scripts from npm package to ~/.genie/scripts/ and configure tmux.
 * On first run (no ~/.tmux.conf or no "Genie TUI" marker): write full config with backup.
 * On subsequent runs: only refresh scripts, don't touch ~/.tmux.conf.
 */
function configureTmux() {
  const scriptsDir = join(GENIE_DIR, 'scripts');
  const tmuxScriptsSrc = join(ROOT, '..', '..', 'scripts', 'tmux');

  // Fallback: try global package dir structure (npm package root)
  const altSrc = join(ROOT, 'scripts', 'tmux');
  const srcDir = existsSync(tmuxScriptsSrc) ? tmuxScriptsSrc : existsSync(altSrc) ? altSrc : null;

  if (!srcDir) {
    console.error('tmux scripts not found in package — skipping TUI setup');
    return;
  }

  // --- Copy scripts to ~/.genie/scripts/ ---
  if (!existsSync(scriptsDir)) {
    mkdirSync(scriptsDir, { recursive: true });
  }

  const { readdirSync, chmodSync } = require('node:fs');
  let scriptCount = 0;
  for (const entry of readdirSync(srcDir)) {
    if (entry.endsWith('.sh')) {
      const srcFile = join(srcDir, entry);
      const destFile = join(scriptsDir, entry);
      const content = readFileSync(srcFile);
      writeFileSync(destFile, content);
      chmodSync(destFile, 0o755);
      scriptCount++;
    }
  }

  if (scriptCount > 0) {
    console.error(`Installed ${scriptCount} tmux scripts to ${scriptsDir}`);
  }

  // --- Write tmux config on first run only ---
  const tmuxConf = join(homedir(), '.tmux.conf');
  const tmuxConfSrc = join(srcDir, 'genie.tmux.conf');

  if (!existsSync(tmuxConfSrc)) {
    console.error('genie.tmux.conf template not found — skipping config');
    return;
  }

  // Check if this is a first run (no config or no Genie marker)
  let isFirstRun = true;
  if (existsSync(tmuxConf)) {
    const existing = readFileSync(tmuxConf, 'utf-8');
    if (existing.includes('Genie TUI')) {
      isFirstRun = false;
    }
  }

  if (isFirstRun) {
    console.error('Genie will configure tmux. Your existing config will be backed up.');

    // Backup existing config
    if (existsSync(tmuxConf)) {
      const { copyFileSync } = require('node:fs');
      copyFileSync(tmuxConf, `${tmuxConf}.bak`);
      console.error(`Backed up existing config to ${tmuxConf}.bak`);
    }

    // Write full config
    const template = readFileSync(tmuxConfSrc, 'utf-8');
    writeFileSync(tmuxConf, template, 'utf-8');
    console.error(`Genie tmux config written to ${tmuxConf}`);

    // Reload tmux if running
    try {
      const { spawnSync: spSync } = require('node:child_process');
      spSync('tmux', ['source-file', tmuxConf], { stdio: 'ignore' });
    } catch {
      // tmux not running — that's fine
    }
  }
}

/**
 * genie CLI is missing — advise the canonical v5 install path.
 *
 * v5 ships as cosign/SLSA-signed tarballs via GitHub Releases + install.sh.
 * The old npm/bun-global path (`bun add -g` of the @automagik package) was
 * discontinued 2026-05-09 and no longer resolves a current build.
 *
 * We deliberately do NOT run the network installer from this SessionStart hook:
 * `curl | bash` downloads, cosign-verifies, extracts, and rewrites the user's
 * shell rc — too heavy and intrusive to do silently while a Claude Code session
 * is starting, and it would block startup on the network. Instead we print the
 * one canonical command and let the user run it deliberately. The hook stays
 * fast and never hard-fails on a missing CLI.
 */
function adviseGenieCliInstall() {
  console.error('');
  console.error('genie CLI is not installed.');
  console.error('Install it (cosign + SLSA verified) with:');
  console.error('  curl -fsSL https://raw.githubusercontent.com/automagik-dev/genie/main/install.sh | bash');
  console.error('');
}

// Main execution
try {
  // Workers inherit parent's deps — skip all checks to reduce spawn latency (#712)
  if (process.env.GENIE_WORKER === '1') {
    process.exit(0);
  }

  // Quick check: if everything is already installed, exit silently
  if (isBunInstalled() && isTmuxInstalled() && !needsInstall() && !genieCliNeedsInstall()) {
    process.exit(0);
  }

  // 1. Check/install Bun (required — fatal if fails)
  if (!isBunInstalled()) {
    installBun();
  }

  // 2. Check tmux (required for agent orchestration — fatal)
  if (!isTmuxInstalled()) {
    console.error('');
    console.error('WARNING: tmux is not installed.');
    console.error('tmux is required for the genie launch cockpit and TUI integration.');
    console.error('Non-interactive features still work without it.');
    console.error('');
    console.error('Install tmux:');
    if (process.platform === 'darwin') {
      console.error('  brew install tmux');
    } else if (process.platform === 'linux') {
      console.error('  sudo apt install tmux    # Debian/Ubuntu');
      console.error('  sudo dnf install tmux    # Fedora/RHEL');
      console.error('  sudo pacman -S tmux      # Arch');
    } else if (IS_WINDOWS) {
      console.error('  WSL is required for tmux on Windows');
      console.error('  Inside WSL: sudo apt install tmux');
    }
    console.error('');
    // Don't exit — let the rest of the chain run
  }

  // 3. Install plugin dependencies if needed
  if (needsInstall()) {
    installDeps();
    console.error('Dependencies installed');
  }

  // 3a. Create default config if missing (idempotent — never overwrites)
  try {
    createDefaultConfig();
  } catch (e) {
    console.error(`Warning: Could not create default config: ${e.message}`);
  }

  // 3b. Configure tmux TUI (scripts + config on first run)
  try {
    configureTmux();
  } catch (e) {
    console.error(`Warning: Could not configure tmux TUI: ${e.message}`);
  }

  // 4. Advise on genie CLI install if missing (non-fatal, no network in-hook)
  if (genieCliNeedsInstall()) {
    adviseGenieCliInstall();
  }
} catch (e) {
  // Only Bun install failure reaches here — everything else is graceful.
  // Don't say "continuing anyway" — be specific about what failed and what to do.
  console.error('');
  console.error('Genie setup failed: Bun runtime could not be installed.');
  console.error(`  Error: ${e.message}`);
  console.error('');
  console.error('What to do:');
  console.error('  1. Install Bun manually: curl -fsSL https://bun.com/install | bash');
  console.error('  2. Restart your terminal to update PATH');
  console.error('  3. Start a new Claude Code session');
  console.error('');
  console.error('Genie features will be unavailable until Bun is installed.');
  // Exit 0 so the hook chain continues (first-run-check, session-context)
  // but session state is not corrupted — no partial markers were written
  process.exit(0);
}
