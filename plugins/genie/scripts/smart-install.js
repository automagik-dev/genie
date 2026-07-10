#!/usr/bin/env node
import { execFileSync, execSync, spawnSync } from 'node:child_process';
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
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

// This file is ESM (plugin package.json is type:module), so load the CommonJS
// council-stamp helper through createRequire rather than a bare require.
const requireCjs = createRequire(import.meta.url);

const ROOT = process.env.CLAUDE_PLUGIN_ROOT || join(homedir(), '.claude', 'plugins', 'genie');
// GENIE_HOME relocates all global genie state; the CLI honors it, so the hook
// must too or the throttle marker below would never match the CLI's writes.
const GENIE_DIR = process.env.GENIE_HOME || join(homedir(), '.genie');
const MARKER = join(GENIE_DIR, '.install-version');
// Throttle marker (ISO string) refreshed by BOTH the canonical agent-sync
// engine (runAgentSyncSafe) and this hook around delegation. We delegate a
// session-start sync only when it is absent or older than 6h, so session
// starts stay cheap. On a FAILED delegation the hook writes a backdated marker
// that re-allows a retry after 30 minutes instead of retrying (and re-warning)
// on every single session start.
const AGENT_SYNC_MARKER = join(GENIE_DIR, '.last-agent-sync');
const AGENT_SYNC_THROTTLE_MS = 6 * 60 * 60 * 1000;
const AGENT_SYNC_RETRY_MS = 30 * 60 * 1000;
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

/**
 * Resolve a genie binary path for agent-sync delegation. Prefers the canonical
 * v5 location (~/.genie/bin/genie), then a `genie` on PATH. Returns null when no
 * CLI is installed (plugin-only machine) so the caller falls back to the in-hook
 * /council stamp.
 */
function findGenieBinary() {
  const canonical = join(GENIE_DIR, 'bin', 'genie');
  if (existsSync(canonical)) return canonical;
  try {
    const result = spawnSync('genie', ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS,
      timeout: 5000,
    });
    if (result.status === 0) return 'genie';
  } catch {
    // not on PATH
  }
  return null;
}

/**
 * Allow a delegated sync only when the last one is absent or older than 6h. The
 * CLI refreshes AGENT_SYNC_MARKER (ISO string) on every sync phase, and this
 * hook refreshes it around delegation (see delegateAgentSync). A marker dated
 * in the FUTURE (clock skew, corruption) is treated as stale — a negative
 * delta must never read as "fresh", or sync would be suppressed forever.
 */
function agentSyncThrottleAllows() {
  try {
    const last = Date.parse(readFileSync(AGENT_SYNC_MARKER, 'utf-8').trim());
    if (Number.isNaN(last)) return true;
    const delta = Date.now() - last;
    if (delta < 0) return true; // future-dated marker → stale
    return delta > AGENT_SYNC_THROTTLE_MS;
  } catch {
    return true; // no marker / unreadable → allowed
  }
}

/**
 * Best-effort hook-side write of the throttle marker. The CLI writes it too on
 * a successful sync; writing from the hook as well guarantees a FAILING
 * delegation (pre-contract binary, spawn error, timeout) cannot retry on every
 * session start — failures get a backdated marker that re-allows a retry after
 * AGENT_SYNC_RETRY_MS instead of the full throttle window.
 */
function writeAgentSyncMarker(date) {
  try {
    if (!existsSync(GENIE_DIR)) {
      mkdirSync(GENIE_DIR, { recursive: true });
    }
    writeFileSync(AGENT_SYNC_MARKER, `${date.toISOString()}\n`);
  } catch {
    // the marker only optimizes throttling — never break session start over it
  }
}

/**
 * Delegate ALL syncing (skills + /council stamp for every detected agent) to
 * the canonical engine. The invocation is `genie update --sync-only` with the
 * GENIE_UPDATE_SYNC_ONLY=1 env as belt-and-suspenders: contract-aware binaries
 * honor either form, while a PRE-CONTRACT binary (which ignores the env and
 * would otherwise run a full unattended download + binary swap mid-session)
 * rejects the unknown flag and exits non-zero immediately with zero network.
 * Quiet, time-bounded, and fully sandboxed — a failure never breaks session
 * start. Returns true when the delegated sync succeeded.
 */
function delegateAgentSync(geniePath) {
  // shell: IS_WINDOWS matches this file's own probes — Node >=18.20 EINVAL
  // hardening refuses to spawn .cmd shims without a shell, and the shell-based
  // probe above may have resolved exactly such a shim. Quote a path containing
  // spaces when it goes through the shell (same pattern as installDeps).
  const genieCmd = IS_WINDOWS && geniePath.includes(' ') ? `"${geniePath}"` : geniePath;
  try {
    execFileSync(genieCmd, ['update', '--sync-only'], {
      env: { ...process.env, GENIE_UPDATE_SYNC_ONLY: '1' },
      stdio: 'ignore',
      timeout: 45000,
      shell: IS_WINDOWS,
    });
    writeAgentSyncMarker(new Date());
    return true;
  } catch (e) {
    console.error(`Warning: agent sync via genie update failed: ${e.message}`);
    // Backdated marker: throttled right now, retries after AGENT_SYNC_RETRY_MS
    // rather than warning on every session start (or never retrying at all).
    writeAgentSyncMarker(new Date(Date.now() - (AGENT_SYNC_THROTTLE_MS - AGENT_SYNC_RETRY_MS)));
    return false;
  }
}

/**
 * CLI-less fallback: stamp the /council workflow so plugin-only machines still
 * get it. resolveStampInputs prefers the stable ~/.genie/plugins/genie root,
 * falling back to CLAUDE_PLUGIN_ROOT.
 */
function stampCouncilFallback() {
  try {
    const { stampCouncilWorkflow, resolveStampInputs } = requireCjs('./council-stamp.cjs');
    const { pluginRoot, templatePath } = resolveStampInputs({ claudePluginRoot: ROOT, genieHome: GENIE_DIR });
    const stampResult = stampCouncilWorkflow({
      templatePath,
      pluginRoot,
      targetDir: join(homedir(), '.claude', 'workflows'),
    });
    if (stampResult.action === 'written') {
      console.error(`Stamped /council workflow to ${stampResult.targetPath}`);
    }
  } catch (e) {
    console.error(`Warning: could not stamp /council workflow: ${e.message}`);
  }
}

// Main execution
try {
  // Workers inherit parent's deps AND the parent session's already-converged
  // agents — skip everything to keep spawn latency flat (#712). The delegation
  // below therefore only ever runs in top-level sessions.
  if (process.env.GENIE_WORKER === '1') {
    process.exit(0);
  }

  // Converge coding agents on session start. This runs BEFORE the remaining
  // early-exit guard (deps-already-present) so a plugin update refreshes skills
  // + the /council stamp even on machines that would otherwise skip all install
  // work. Prefer the canonical CLI engine: `genie update --sync-only` syncs
  // skills AND stamps /council for every detected agent (claude/codex/hermes)
  // from one source root — throttled to 6h so session starts stay cheap and no
  // sync logic is duplicated in the hook. When NO genie CLI is installed, or
  // the delegation FAILS (pre-contract binary rejecting the flag, .cmd shim
  // spawn errors, timeout), we fall back to an in-hook /council stamp so the
  // workflow stays available on exactly the machines the fallback exists for.
  // Fully sandboxed — nothing here can break session start.
  const geniePath = findGenieBinary();
  if (geniePath) {
    if (agentSyncThrottleAllows() && !delegateAgentSync(geniePath)) {
      stampCouncilFallback();
    }
  } else {
    stampCouncilFallback();
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
