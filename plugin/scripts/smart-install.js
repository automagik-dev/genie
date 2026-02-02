#!/usr/bin/env node
/**
 * Smart Install Script for automagik-genie
 *
 * Ensures required dependencies are installed:
 * - Bun runtime (auto-installs if missing)
 * - tmux (guides user if missing - can't auto-install)
 * - beads (auto-installs if missing via npm)
 *
 * Also handles:
 * - Dependency installation when version changes
 * - CLI symlink creation for agent access
 * - Version marker management
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync } from 'fs';
import { execSync, spawnSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';

const ROOT = process.env.CLAUDE_PLUGIN_ROOT || join(homedir(), '.claude', 'plugins', 'automagik-genie');
const GENIE_DIR = join(homedir(), '.genie');
const MARKER = join(GENIE_DIR, '.install-version');
const BIN_DIR = join(homedir(), '.local', 'bin');
const IS_WINDOWS = process.platform === 'win32';

// Common installation paths (handles fresh installs before PATH reload)
const BUN_COMMON_PATHS = IS_WINDOWS
  ? [join(homedir(), '.bun', 'bin', 'bun.exe')]
  : [join(homedir(), '.bun', 'bin', 'bun'), '/usr/local/bin/bun', '/opt/homebrew/bin/bun'];

const BEADS_COMMON_PATHS = IS_WINDOWS
  ? [join(homedir(), 'AppData', 'Roaming', 'npm', 'bd.cmd')]
  : [join(homedir(), '.local', 'bin', 'bd'), '/usr/local/bin/bd', '/opt/homebrew/bin/bd'];

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
      execSync('powershell -c "irm bun.sh/install.ps1 | iex"', { stdio: 'inherit', shell: true });
    } else {
      execSync('curl -fsSL https://bun.sh/install | bash', { stdio: 'inherit', shell: true });
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
      console.error('  curl -fsSL https://bun.sh/install | bash');
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
 * Create CLI symlinks for agent access
 */
function createCliSymlinks() {
  // Ensure bin directory exists
  if (!existsSync(BIN_DIR)) {
    mkdirSync(BIN_DIR, { recursive: true });
  }

  const links = [
    { name: 'genie', target: join(ROOT, 'scripts', 'genie.cjs') },
    { name: 'term', target: join(ROOT, 'scripts', 'term.cjs') }
  ];

  for (const { name, target } of links) {
    const linkPath = join(BIN_DIR, name);

    // Skip if target doesn't exist
    if (!existsSync(target)) {
      continue;
    }

    // Remove existing symlink if it exists
    try {
      if (existsSync(linkPath)) {
        unlinkSync(linkPath);
      }
    } catch {
      // Ignore errors
    }

    // Create symlink
    try {
      symlinkSync(target, linkPath);
      console.error(`Created symlink: ${linkPath} -> ${target}`);
    } catch (error) {
      console.error(`Warning: Could not create symlink for ${name}: ${error.message}`);
    }
  }
}

// Main execution
try {
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

  // 4. Install dependencies if needed
  if (needsInstall()) {
    installDeps();
    console.error('Dependencies installed');
  }

  // 5. Create CLI symlinks
  createCliSymlinks();

} catch (e) {
  console.error('Installation failed:', e.message);
  process.exit(1);
}
