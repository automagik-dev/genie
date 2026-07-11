#!/usr/bin/env node
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
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
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// This file is ESM (plugin package.json is type:module), so load the CommonJS
// council-stamp helper through createRequire rather than a bare require.
const requireCjs = createRequire(import.meta.url);

const ROOT = process.env.CLAUDE_PLUGIN_ROOT || join(homedir(), '.claude', 'plugins', 'genie');
// GENIE_HOME relocates all global genie state; the CLI honors it, so the hook
// must too or the throttle marker below would never match the CLI's writes.
const GENIE_DIR = process.env.GENIE_HOME || join(homedir(), '.genie');
const MARKER = join(GENIE_DIR, '.install-version');
// Throttle marker (ISO string) is owned exclusively by runAgentSyncSafe after
// both agent skills and role agents converge successfully. The hook only reads
// it: failed, partial, and pre-contract runs remain immediately retryable.
const AGENT_SYNC_MARKER = join(GENIE_DIR, '.last-agent-sync');
const AGENT_SYNC_THROTTLE_MS = 6 * 60 * 60 * 1000;
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
      execSync('powershell -c "irm bun.com/install.ps1 | iex"', { stdio: ['pipe', 'pipe', 'inherit'] });
    } else {
      execSync('curl -fsSL https://bun.com/install | bash', { stdio: ['pipe', 'pipe', 'inherit'] });
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
  execSync(`${bunCmd} install`, { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'] });

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
 * Current CLIs refresh AGENT_SYNC_MARKER (ISO string) only after full
 * convergence; failed-child compatibility cleanup below repairs markers from
 * older CLIs. A marker dated in the FUTURE (clock skew, corruption) is treated
 * as stale — a negative delta must never read as "fresh", or sync would be
 * suppressed forever.
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
 * Capture enough marker identity to distinguish a legacy child's write from a
 * pre-existing marker and from a replacement that races failure cleanup. A
 * non-regular or unstable path is deliberately opaque: cleanup then fails
 * closed and leaves it untouched.
 */
function captureAgentSyncMarker(path = AGENT_SYNC_MARKER) {
  try {
    const before = lstatSync(path);
    if (!before.isFile()) return { kind: 'opaque' };
    const content = readFileSync(path, 'utf8');
    const after = lstatSync(path);
    if (
      !after.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      return { kind: 'opaque' };
    }
    return {
      kind: 'regular',
      content,
      dev: after.dev,
      ino: after.ino,
      size: after.size,
      mtimeMs: after.mtimeMs,
    };
  } catch (error) {
    return error?.code === 'ENOENT' ? { kind: 'absent' } : { kind: 'opaque' };
  }
}

function sameAgentSyncMarker(a, b) {
  return (
    a.kind === 'regular' &&
    b.kind === 'regular' &&
    a.content === b.content &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs
  );
}

/** Restore bytes only when no concurrent writer has recreated the marker. */
function restoreAgentSyncMarkerIfAbsent(content) {
  let fd;
  try {
    fd = openSync(AGENT_SYNC_MARKER, 'wx', 0o600);
    writeSync(fd, content);
  } catch {
    // Existing marker belongs to a concurrent writer; never overwrite it.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best effort; marker bytes were already written
      }
    }
  }
}

/**
 * Releases before the success-only marker contract wrote the throttle marker
 * even when their sync later failed. Remove only a canonical fresh ISO marker
 * created during THIS child invocation. The lifecycle lease excludes current
 * cooperative writers; an atomic quarantine plus an identity re-check ensures
 * a replacement racing the cleanup remains at the canonical path. Any older
 * marker is restored with create-if-absent semantics, so it cannot clobber a
 * concurrent success.
 */
function discardFailedLegacySyncMarker(before, startedAt, finishedAt) {
  if (before.kind === 'opaque') return;
  const candidate = captureAgentSyncMarker();
  if (candidate.kind !== 'regular' || sameAgentSyncMarker(before, candidate)) return;

  const timestamp = Date.parse(candidate.content.trim());
  const mtimeSlopMs = 2000; // accommodate coarse filesystem mtime resolution
  if (
    Number.isNaN(timestamp) ||
    new Date(timestamp).toISOString() !== candidate.content.trim() ||
    timestamp < startedAt ||
    timestamp > finishedAt ||
    candidate.mtimeMs < startedAt - mtimeSlopMs ||
    candidate.mtimeMs > finishedAt + mtimeSlopMs
  ) {
    return;
  }

  const quarantine = `${AGENT_SYNC_MARKER}.failed-${process.pid}-${randomBytes(8).toString('hex')}`;
  try {
    renameSync(AGENT_SYNC_MARKER, quarantine);
  } catch {
    return;
  }

  const quarantined = captureAgentSyncMarker(quarantine);
  if (!sameAgentSyncMarker(candidate, quarantined)) {
    if (quarantined.kind === 'regular') restoreAgentSyncMarkerIfAbsent(quarantined.content);
    try {
      rmSync(quarantine, { force: true });
    } catch {
      // quarantine is harmless; never risk the canonical marker to clean it
    }
    return;
  }

  try {
    rmSync(quarantine, { force: true });
  } catch {
    // quarantine no longer throttles SessionStart; leave best-effort debris
  }
  if (before.kind === 'regular') restoreAgentSyncMarkerIfAbsent(before.content);
}

// --- agent-sync delegation contract tiers -----------------------------------
// The installed binary decides HOW (and whether) we may delegate. Probed once
// per delegation with `genie --version` (cheap, zero network).
//
// - >= SYNC_FLAG_AWARE_MIN: binary registers `update --sync-only` → invoke the
//   flag form (plus the env, belt-and-suspenders).
// - >= SYNC_ENV_AWARE_MIN (5.260710.5, first release honoring the
//   GENIE_UPDATE_SYNC_ONLY=1 fast path): env-aware but FLAG-UNAWARE — commander
//   rejects the unknown `--sync-only` before the env is ever read, so these
//   binaries must be invoked env-only (`genie update` + GENIE_UPDATE_SYNC_ONLY=1).
// - older (pre-contract): the env is ignored and `genie update` would run a
//   full unattended download + binary swap mid-session → never delegate; the
//   caller falls back to the in-hook /council stamp.
//
// SYNC_FLAG_AWARE_MIN is the first release cut AFTER 5.260710.9 (the flag lands
// with this plugin version; auto-versioning bumps past .9 on release). A dev
// build still reporting .9 takes the env-only path, which flag-aware binaries
// honor identically.
const SYNC_ENV_AWARE_MIN = [5, 260710, 5];
const SYNC_FLAG_AWARE_MIN = [5, 260710, 10];
// 5.260711.6 is the first release where BOTH sides of this handoff share the
// lifecycle lease and the child writes .last-agent-sync only after complete
// convergence. Published .10–.14 and 5.260711.1–.5 remain parent-serialized;
// current/new children must acquire the lease themselves to avoid self-deadlock.
const SYNC_SUCCESS_ONLY_AND_SELF_SERIALIZING_MIN = [5, 260711, 6];

/** Extract [major, minor, patch] from `genie --version` output, or null. */
function parseGenieVersion(raw) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(raw || '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Numeric triple compare: negative when a < b, 0 when equal, positive when a > b. */
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** Probe the resolved binary's version (5s cap, no network). Null on any failure. */
function probeGenieVersion(geniePath) {
  try {
    const result = spawnSync(geniePath, ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS,
      timeout: 5000,
    });
    return result.status === 0 ? parseGenieVersion(result.stdout) : null;
  } catch {
    return null;
  }
}

/**
 * Delegate ALL syncing (skills + /council stamp for every detected agent) to
 * the canonical engine, choosing the invocation the INSTALLED binary can parse
 * (see the contract tiers above). Pre-contract or unprobeable binaries are
 * never invoked — delegating there would trigger a full unattended update.
 * Quiet, time-bounded, and fully sandboxed — a failure never breaks session
 * start. Returns true when the delegated sync succeeded; on false the caller
 * stamps /council in-hook.
 */
function delegateAgentSync(geniePath) {
  const version = probeGenieVersion(geniePath);
  if (!version || compareVersions(version, SYNC_ENV_AWARE_MIN) < 0) {
    console.error('Warning: installed genie CLI predates the agent-sync contract — skipping delegated sync');
    return false;
  }
  const flagAware = compareVersions(version, SYNC_FLAG_AWARE_MIN) >= 0;
  const selfSerializing = compareVersions(version, SYNC_SUCCESS_ONLY_AND_SELF_SERIALIZING_MIN) >= 0;
  const args = flagAware ? ['update', '--sync-only'] : ['update'];
  // Pre-5.260711.6 children do not acquire the shared lifecycle lease, so the
  // hook holds it across their run. Current/new children self-acquire; holding
  // it here would deadlock them. Their success-only marker contract also means
  // no parent-side failure cleanup is safe or necessary.
  const releaseParentLease = selfSerializing ? undefined : acquireFallbackLifecycleLease();
  if (!selfSerializing && releaseParentLease === null) {
    console.error('Agent sync deferred: another Genie lifecycle writer holds the lease');
    return false;
  }
  const markerBefore = selfSerializing ? undefined : captureAgentSyncMarker();
  const startedAt = Date.now();
  // shell: IS_WINDOWS matches this file's own probes — Node >=18.20 EINVAL
  // hardening refuses to spawn .cmd shims without a shell, and the shell-based
  // probe above may have resolved exactly such a shim. Quote a path containing
  // spaces when it goes through the shell (same pattern as installDeps).
  const genieCmd = IS_WINDOWS && geniePath.includes(' ') ? `"${geniePath}"` : geniePath;
  try {
    execFileSync(genieCmd, args, {
      env: { ...process.env, GENIE_UPDATE_SYNC_ONLY: '1' },
      stdio: 'ignore',
      timeout: 45000,
      shell: IS_WINDOWS,
    });
    return true;
  } catch (e) {
    // Success-only 5.260711.6+ children never stamp on failure. If a marker
    // exists after they release their own lease, it belongs to another
    // successful owner and the hook must not touch it. Legacy children are
    // still under the parent lease here, so their attributable false-success
    // marker can be removed without racing another lifecycle writer.
    if (!selfSerializing && markerBefore !== undefined) {
      discardFailedLegacySyncMarker(markerBefore, startedAt, Date.now());
    }
    console.error(`Warning: agent sync via genie update failed: ${e.message}`);
    return false;
  } finally {
    releaseParentLease?.();
  }
}

function lifecycleLockPath(genieHome) {
  const canonical = resolve(genieHome);
  const suffix = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return join(dirname(canonical), `.genie-lifecycle-${suffix}.lock`);
}

function processStartIdentity(pid) {
  let marker;
  try {
    if (process.platform === 'linux') {
      const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closeParen = raw.lastIndexOf(')');
      const fields = raw
        .slice(closeParen + 2)
        .trim()
        .split(/\s+/);
      marker = `linux:${fields[19] || ''}`;
    } else if (process.platform === 'win32') {
      marker = `windows:${execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`],
        { encoding: 'utf8', timeout: 1000 },
      ).trim()}`;
    } else {
      marker = `ps:${execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 1000,
      }).trim()}`;
    }
    if (marker.endsWith(':')) return null;
    return createHash('sha256').update(marker).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Minimal CommonJS-fallback lease compatible with the canonical TS lifecycle
 * lease. It never steals: a live, stale, malformed, or unreadable owner all
 * cause safe deferral, so fallback recovery cannot touch a live transaction.
 */
function acquireFallbackLifecycleLease() {
  const lockPath = lifecycleLockPath(GENIE_DIR);
  const ownerRecord = `${process.pid}:${randomBytes(16).toString('hex')}:${processStartIdentity(process.pid) || 'unknown'}`;
  let fd;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
    writeSync(fd, `${ownerRecord}\n`);
    closeSync(fd);
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best effort; exact-record cleanup below remains ownership-safe
      }
    }
    try {
      if (readFileSync(lockPath, 'utf8').trim() === ownerRecord) rmSync(lockPath, { force: true });
    } catch {
      // another owner or unreadable state: fail closed
    }
    return null;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      if (readFileSync(lockPath, 'utf8').trim() === ownerRecord) rmSync(lockPath, { force: true });
    } catch {
      // never unlink a pathname without exact token ownership
    }
  };
  process.once('exit', release);
  return () => {
    process.removeListener('exit', release);
    release();
  };
}

/**
 * CLI-less fallback: stamp the /council workflow so plugin-only machines still
 * get it. resolveStampInputs prefers the stable ~/.genie/plugins/genie root,
 * falling back to CLAUDE_PLUGIN_ROOT.
 */
function stampCouncilFallback() {
  const releaseLease = acquireFallbackLifecycleLease();
  if (releaseLease === null) {
    console.error('Council workflow convergence deferred: another Genie lifecycle writer holds the lease');
    return;
  }
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
  } finally {
    releaseLease();
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
  // the delegation FAILS (pre-contract binary skipped by the version probe,
  // .cmd shim spawn errors, timeout), we fall back to an in-hook /council stamp so the
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
