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
 * Read updateChannel from ~/.genie/config.json.
 * Returns 'latest' or 'next'.
 */
function getUpdateChannel() {
  try {
    const configPath = join(GENIE_DIR, 'config.json');
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      return config.updateChannel || 'latest';
    }
  } catch {
    // Ignore
  }
  return 'latest';
}

/**
 * Check if genie CLI needs install or upgrade via bun global
 */
function genieCliNeedsInstall() {
  const installed = getGenieVersion();
  if (!installed) return true;
  const pluginVersion = getPluginVersion();
  if (!pluginVersion) return false;
  return installed !== pluginVersion;
}


/**
 * Read the current marker version (before installDeps overwrites it).
 * Returns the version string or null if not found.
 */
function getMarkerVersion() {
  try {
    if (existsSync(MARKER)) {
      const marker = JSON.parse(readFileSync(MARKER, 'utf-8'));
      return marker.version || null;
    }
  } catch {
    // Ignore
  }
  return null;
}

/**
 * Inject the orchestration prompt into ~/.claude/rules/genie-orchestration.md
 * Reads from the rules file in the plugin directory.
 * Only writes/rewrites if the plugin version changed.
 * @param {string|null} oldVersion - marker version captured before installDeps ran
 */
function injectOrchestrationPrompt(oldVersion) {
  const rulesDir = join(homedir(), '.claude', 'rules');
  const destFile = join(rulesDir, 'genie-orchestration.md');

  if (!existsSync(rulesDir)) {
    mkdirSync(rulesDir, { recursive: true });
  }

  let pluginVersion = null;
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    pluginVersion = pkg.version || null;
  } catch {
    // Ignore
  }

  const fileExists = existsSync(destFile);
  const versionChanged = !fileExists || oldVersion !== pluginVersion;

  if (versionChanged) {
    const sourceFile = join(ROOT, 'rules', 'genie-orchestration.md');
    if (existsSync(sourceFile)) {
      const content = readFileSync(sourceFile, 'utf-8');
      writeFileSync(destFile, content, 'utf-8');
      console.error(`Orchestration rules installed: ${destFile}`);
    } else {
      // Fallback: write minimal inline message
      writeFileSync(destFile, '# Genie CLI\n\nUse `genie` CLI for all agent operations. Never use native Agent/SendMessage tools.\n', 'utf-8');
      console.error(`Orchestration rules installed (fallback): ${destFile}`);
    }
  }
}

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
 * Install or upgrade genie CLI globally via bun
 */
function installGenieCli() {
  const bunPath = getBunPath();
  if (!bunPath) {
    throw new Error('Bun executable not found — cannot install genie CLI');
  }

  const updateChannel = getUpdateChannel();
  const tag = updateChannel === 'next' ? 'next' : 'latest';
  const installed = getGenieVersion();

  if (installed) {
    console.error(`Upgrading genie CLI: ${installed} → @${tag}...`);
  } else {
    console.error('Installing genie CLI globally via bun...');
  }

  const bunCmd = IS_WINDOWS && bunPath.includes(' ') ? `"${bunPath}"` : bunPath;
  execSync(`${bunCmd} install -g @automagik/genie@${tag}`, { stdio: ['pipe', 'pipe', 'inherit'], shell: IS_WINDOWS });

  const newVersion = getGenieVersion();
  if (!newVersion) {
    throw new Error('genie CLI installation completed but binary not found. Restart your terminal.');
  }
  console.error(`genie CLI ${newVersion} installed`);
}

// Main execution
try {
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
    console.error('tmux is required for agent orchestration (genie spawn, teams, etc.).');
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

  // Capture marker version BEFORE installDeps overwrites it
  const oldVersion = getMarkerVersion();

  // 3. Install plugin dependencies if needed
  if (needsInstall()) {
    installDeps();
    console.error('Dependencies installed');
  }

  // 3a. Inject orchestration prompt (idempotent — checks version marker)
  try {
    injectOrchestrationPrompt(oldVersion);
  } catch (e) {
    console.error(`Warning: Could not write orchestration prompt: ${e.message}`);
  }

  // 3b. Create default config if missing (idempotent — never overwrites)
  try {
    createDefaultConfig();
  } catch (e) {
    console.error(`Warning: Could not create default config: ${e.message}`);
  }

  // 3c. Configure tmux TUI (scripts + config on first run)
  try {
    configureTmux();
  } catch (e) {
    console.error(`Warning: Could not configure tmux TUI: ${e.message}`);
  }

  // 4. Install or upgrade genie CLI via bun global (non-fatal)
  if (genieCliNeedsInstall()) {
    try {
      installGenieCli();
    } catch (e) {
      console.error(`Warning: genie CLI install/upgrade failed: ${e.message}`);
      console.error('The plugin will still work. Install genie CLI manually later.');
    }
  }
} catch (e) {
  // Only Bun install failure reaches here — everything else is graceful
  console.error('Critical installation failed:', e.message);
  console.error('Continuing anyway to let remaining hooks run...');
  // Exit 0 so the hook chain continues (first-run-check, session-context)
  process.exit(0);
}
