#!/usr/bin/env node
/**
 * Smart Install Script for genie
 *
 * Ensures required dependencies are installed:
 * - Bun runtime (auto-installs if missing)
 * - tmux (guides user if missing - can't auto-install)
 * - beads (auto-installs if missing via npm)
 * - genie CLI (installed globally via bun)
 *
 * Also handles:
 * - Dependency installation when version changes
 * - Version marker management
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execSync, spawnSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';

const ROOT = process.env.CLAUDE_PLUGIN_ROOT || join(homedir(), '.claude', 'plugins', 'genie');
const GENIE_DIR = join(homedir(), '.genie');
const MARKER = join(GENIE_DIR, '.install-version');
const IS_WINDOWS = process.platform === 'win32';

// Common installation paths (handles fresh installs before PATH reload)
const BUN_COMMON_PATHS = IS_WINDOWS
  ? [join(homedir(), '.bun', 'bin', 'bun.exe')]
  : [join(homedir(), '.bun', 'bin', 'bun'), '/usr/local/bin/bun', '/opt/homebrew/bin/bun'];

const BEADS_COMMON_PATHS = IS_WINDOWS
  ? [join(homedir(), 'AppData', 'Roaming', 'npm', 'bd.cmd')]
  : [join(homedir(), '.local', 'bin', 'bd'), '/usr/local/bin/bd', '/opt/homebrew/bin/bd'];

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
      shell: IS_WINDOWS
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
      shell: IS_WINDOWS
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
      execSync('powershell -c "irm bun.com/install.ps1 | iex"', { stdio: 'inherit', shell: true });
    } else {
      execSync('curl -fsSL https://bun.com/install | bash', { stdio: 'inherit', shell: true });
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
      shell: IS_WINDOWS
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
      shell: IS_WINDOWS
    });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Check if beads (bd) is installed
 */
function getBeadsPath() {
  try {
    const result = spawnSync('bd', ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS
    });
    if (result.status === 0) return 'bd';
  } catch {
    // Not in PATH
  }
  return BEADS_COMMON_PATHS.find(existsSync) || null;
}

function isBeadsInstalled() {
  return getBeadsPath() !== null;
}

/**
 * Install beads via npm
 */
function installBeads() {
  console.error('Installing beads (bd)...');
  try {
    execSync('npm install -g @anthropic-ai/bd', { stdio: 'inherit', shell: true });
    if (!isBeadsInstalled()) {
      throw new Error('beads installation completed but bd not found.');
    }
    console.error('beads installed');
  } catch (error) {
    console.error('Failed to install beads. Please install manually:');
    console.error('  npm install -g @anthropic-ai/bd');
    throw error;
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
  execSync(`${bunCmd} install`, { cwd: ROOT, stdio: 'inherit', shell: IS_WINDOWS });

  // Write version marker
  let version = 'unknown';
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    version = pkg.version;
  } catch {
    // Ignore
  }

  writeFileSync(MARKER, JSON.stringify({
    version,
    bun: getBunVersion(),
    tmux: getTmuxVersion(),
    installedAt: new Date().toISOString()
  }));
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
      shell: IS_WINDOWS
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
      shell: IS_WINDOWS
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
 * Install or upgrade genie CLI globally via bun
 */
function installGenieCli() {
  const bunPath = getBunPath();
  if (!bunPath) {
    throw new Error('Bun executable not found — cannot install genie CLI');
  }

  const pluginVersion = getPluginVersion();
  const installed = getGenieVersion();

  if (installed) {
    console.error(`Upgrading genie CLI: ${installed} → ${pluginVersion}...`);
  } else {
    console.error('Installing genie CLI globally via bun...');
  }

  const bunCmd = IS_WINDOWS && bunPath.includes(' ') ? `"${bunPath}"` : bunPath;
  const versionSuffix = pluginVersion ? `@${pluginVersion}` : '';
  execSync(`${bunCmd} install -g @automagik/genie${versionSuffix}`, { stdio: 'inherit', shell: IS_WINDOWS });

  const newVersion = getGenieVersion();
  if (!newVersion) {
    throw new Error('genie CLI installation completed but binary not found. Restart your terminal.');
  }
  console.error(`genie CLI ${newVersion} installed`);
}

// Main execution
try {
  // Quick check: if everything is already installed, exit silently
  if (isBunInstalled() && isTmuxInstalled() && isBeadsInstalled() && !needsInstall() && !genieCliNeedsInstall()) {
    process.exit(0);
  }

  // 1. Check/install Bun
  if (!isBunInstalled()) {
    installBun();
  }

  // 2. Check tmux - REQUIRED, but can't auto-install
  if (!isTmuxInstalled()) {
    console.error('');
    console.error('ERROR: tmux is required but not installed.');
    console.error('');
    console.error('Please install tmux manually:');
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
    console.error('Then restart Claude Code.');
    process.exit(2); // Exit code 2 = blocking error for Claude to process
  }

  // 3. Check/install beads
  if (!isBeadsInstalled()) {
    installBeads();
  }

  // 4. Install plugin dependencies if needed
  if (needsInstall()) {
    installDeps();
    console.error('Dependencies installed');
  }

  // 5. Install or upgrade genie CLI via bun global
  if (genieCliNeedsInstall()) {
    installGenieCli();
  }

} catch (e) {
  console.error('Installation failed:', e.message);
  process.exit(1);
}
