import { execSync, spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { chmod, copyFile, mkdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { genieConfigExists, loadGenieConfig, saveGenieConfig } from '../lib/genie-config.js';

const GENIE_HOME = process.env.GENIE_HOME || join(homedir(), '.genie');
const GENIE_SRC = join(GENIE_HOME, 'src');
const GENIE_BIN = join(GENIE_HOME, 'bin');
const LOCAL_BIN = join(homedir(), '.local', 'bin');

function log(message: string): void {
  console.log(`\x1b[32m▸\x1b[0m ${message}`);
}

function success(message: string): void {
  console.log(`\x1b[32m✔\x1b[0m ${message}`);
}

function error(message: string): void {
  console.log(`\x1b[31m✖\x1b[0m ${message}`);
}

async function runCommand(
  command: string,
  args: string[],
  cwd?: string,
): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    const output: string[] = [];

    const child = spawn(command, args, {
      cwd,
      stdio: ['inherit', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '1' },
    });

    child.stdout?.on('data', (data) => {
      const str = data.toString();
      output.push(str);
      process.stdout.write(str);
    });

    child.stderr?.on('data', (data) => {
      const str = data.toString();
      output.push(str);
      process.stderr.write(str);
    });

    child.on('close', (code) => {
      resolve({ success: code === 0, output: output.join('') });
    });

    child.on('error', (err) => {
      error(err.message);
      resolve({ success: false, output: err.message });
    });
  });
}

async function getGitInfo(cwd: string): Promise<{ branch: string; commit: string; commitDate: string } | null> {
  try {
    const branchResult = await runCommandSilent('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    const commitResult = await runCommandSilent('git', ['rev-parse', '--short', 'HEAD'], cwd);
    const dateResult = await runCommandSilent('git', ['log', '-1', '--format=%ci'], cwd);

    if (branchResult.success && commitResult.success && dateResult.success) {
      return {
        branch: branchResult.output.trim(),
        commit: commitResult.output.trim(),
        commitDate: dateResult.output.trim().split(' ')[0], // Just the date part
      };
    }
  } catch {
    // Ignore errors
  }
  return null;
}

async function runCommandSilent(
  command: string,
  args: string[],
  cwd?: string,
  timeoutMs = 4000,
): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    const output: string[] = [];
    let settled = false;

    const child = spawn(command, args, {
      cwd,
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve({ success: false, output: `Timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout?.on('data', (data) => {
      output.push(data.toString());
    });

    child.stderr?.on('data', (data) => {
      output.push(data.toString());
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ success: code === 0, output: output.join('') });
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ success: false, output: err.message });
    });
  });
}

type InstallationType = 'source' | 'npm' | 'bun' | 'unknown';

function detectFromBinaryPath(path: string): InstallationType | null {
  if (path.includes('.bun')) return 'bun';
  if (path.includes('node_modules')) return 'npm';
  if (path === join(LOCAL_BIN, 'genie') || path.startsWith(GENIE_BIN)) return 'source';
  return null;
}

async function detectInstallationType(): Promise<InstallationType> {
  // Check config first
  if (genieConfigExists()) {
    try {
      const config = await loadGenieConfig();
      if (config.installMethod) return config.installMethod;
    } catch {
      // Ignore config errors
    }
  }

  // Check for source installation
  if (existsSync(join(GENIE_SRC, '.git'))) return 'source';

  // Detect from binary location
  const result = await runCommandSilent('which', ['genie']);
  if (!result.success) return 'unknown';

  const detected = detectFromBinaryPath(result.output.trim());
  if (detected) return detected;

  // Default to bun for other paths if bun is available
  const hasBun = (await runCommandSilent('which', ['bun'])).success;
  return hasBun ? 'bun' : 'npm';
}

async function updateViaBun(channel: string): Promise<boolean> {
  // Delete global lockfile — it pins old versions even with --force --no-cache
  try {
    require('node:fs').unlinkSync(join(homedir(), '.bun', 'install', 'global', 'bun.lock'));
  } catch {
    /* may not exist */
  }

  log(`Updating via bun (channel: ${channel})...`);
  const result = await runCommand('bun', ['add', '-g', '--force', '--no-cache', `@automagik/genie@${channel}`]);
  if (!result.success) {
    error('Failed to update via bun');
    return false;
  }
  console.log();
  success(`Genie CLI updated via bun (${channel})!`);
  return true;
}

async function updateViaNpm(channel: string): Promise<boolean> {
  log(`Updating via npm (channel: ${channel})...`);
  const result = await runCommand('npm', ['install', '-g', `@automagik/genie@${channel}`]);
  if (!result.success) {
    error('Failed to update via npm');
    return false;
  }
  console.log();
  success(`Genie CLI updated via npm (${channel})!`);
  return true;
}

/** Detect which package-manager global installs exist (npm, bun, or both). */
export async function detectGlobalInstalls(): Promise<Set<'npm' | 'bun'>> {
  const found = new Set<'npm' | 'bun'>();

  const [npmResult, bunResult] = await Promise.all([
    runCommandSilent('npm', ['list', '-g', '@automagik/genie']),
    runCommandSilent('bun', ['pm', 'ls', '-g']),
  ]);

  if (npmResult.success && !npmResult.output.includes('(empty)')) {
    found.add('npm');
  }
  if (bunResult.success && bunResult.output.includes('@automagik/genie')) {
    found.add('bun');
  }

  return found;
}

async function updateSource(): Promise<void> {
  // Get current version info before update
  const beforeInfo = await getGitInfo(GENIE_SRC);
  if (beforeInfo) {
    console.log(`Current: \x1b[2m${beforeInfo.branch}@${beforeInfo.commit} (${beforeInfo.commitDate})\x1b[0m`);
    console.log();
  }

  // Step 1: Fetch and reset to origin/main
  log('Fetching latest changes...');
  const fetchResult = await runCommand('git', ['fetch', 'origin'], GENIE_SRC);
  if (!fetchResult.success) {
    error('Failed to fetch from origin');
    process.exit(1);
  }

  log('Resetting to origin/main...');
  const resetResult = await runCommand('git', ['reset', '--hard', 'origin/main'], GENIE_SRC);
  if (!resetResult.success) {
    error('Failed to reset to origin/main');
    process.exit(1);
  }
  console.log();

  // Get new version info
  const afterInfo = await getGitInfo(GENIE_SRC);

  // Check if anything changed
  if (beforeInfo && afterInfo && beforeInfo.commit === afterInfo.commit) {
    success('Already up to date!');
    console.log();
    return;
  }

  // Step 2: Install dependencies
  log('Installing dependencies...');
  const installResult = await runCommand('bun', ['install'], GENIE_SRC);
  if (!installResult.success) {
    error('Failed to install dependencies');
    process.exit(1);
  }
  console.log();

  // Step 3: Build
  log('Building...');
  const buildResult = await runCommand('bun', ['run', 'build'], GENIE_SRC);
  if (!buildResult.success) {
    error('Failed to build');
    process.exit(1);
  }
  console.log();

  // Step 4: Copy binaries and update symlinks
  log('Installing binaries...');

  try {
    await mkdir(GENIE_BIN, { recursive: true });
    await mkdir(LOCAL_BIN, { recursive: true });

    const binaries = ['genie.js', 'term.js'];
    const names = ['genie', 'term'];

    for (let i = 0; i < binaries.length; i++) {
      const src = join(GENIE_SRC, 'dist', binaries[i]);
      const binDest = join(GENIE_BIN, binaries[i]);
      const linkDest = join(LOCAL_BIN, names[i]);

      // Copy to GENIE_BIN
      await copyFile(src, binDest);
      await chmod(binDest, 0o755);

      // Symlink to LOCAL_BIN
      await symlinkOrCopy(binDest, linkDest);
    }

    // Clean up legacy claudio binaries from previous installs
    for (const legacy of ['claudio.js', 'claudio']) {
      const legacyBin = join(GENIE_BIN, legacy);
      const legacyLink = join(LOCAL_BIN, legacy);
      try {
        await unlink(legacyBin);
      } catch {}
      try {
        await unlink(legacyLink);
      } catch {}
    }

    success('Binaries installed');
  } catch (err) {
    error(`Failed to install binaries: ${err}`);
    process.exit(1);
  }

  // Print success
  console.log();
  console.log('\x1b[2m────────────────────────────────────\x1b[0m');
  success('Genie CLI updated successfully!');
  console.log();

  if (afterInfo) {
    console.log(`Version: \x1b[36m${afterInfo.branch}@${afterInfo.commit}\x1b[0m (${afterInfo.commitDate})`);
    console.log();
  }
}

async function symlinkOrCopy(src: string, dest: string): Promise<void> {
  const { symlink, unlink } = await import('node:fs/promises');

  try {
    // Remove existing symlink/file if present
    if (existsSync(dest)) {
      await unlink(dest);
    }
    await symlink(src, dest);
  } catch {
    // Fallback to copy if symlink fails
    await copyFile(src, dest);
  }
}

// ============================================================================
// Plugin Sync — update Claude Code plugin cache after CLI update
// ============================================================================

function copyDirSync(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

async function resolveGlobalPkgDir(installType: InstallationType): Promise<string | null> {
  // Prefer the package manager that was actually used for this update
  if (installType === 'bun') {
    const bunPath = join(homedir(), '.bun', 'install', 'global', 'node_modules', '@automagik', 'genie');
    if (existsSync(bunPath)) return bunPath;
  }

  if (installType === 'npm') {
    // Dynamic resolution via npm root -g (handles nvm/fnm/volta)
    const npmRootResult = await runCommandSilent('npm', ['root', '-g']);
    if (npmRootResult.success) {
      const npmPath = join(npmRootResult.output.trim(), '@automagik', 'genie');
      if (existsSync(npmPath)) return npmPath;
    }
  }

  // Fallback: try both regardless of installType
  const bunFallback = join(homedir(), '.bun', 'install', 'global', 'node_modules', '@automagik', 'genie');
  if (existsSync(bunFallback)) return bunFallback;

  const npmRootFallback = await runCommandSilent('npm', ['root', '-g']);
  if (npmRootFallback.success) {
    const npmPath = join(npmRootFallback.output.trim(), '@automagik', 'genie');
    if (existsSync(npmPath)) return npmPath;
  }

  return null;
}

/** Update the installed_plugins.json registry entry for genie. */
function updatePluginRegistry(claudePlugins: string, cacheDir: string, version: string): void {
  const registryPath = join(claudePlugins, 'installed_plugins.json');
  try {
    if (!existsSync(registryPath)) return;
    const registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
    const entries = registry.plugins?.['genie@automagik'];
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (entry.scope === 'user') {
        entry.installPath = cacheDir;
        entry.version = version;
        entry.lastUpdated = new Date().toISOString();
      }
    }
    writeFileSync(registryPath, JSON.stringify(registry, null, 2));
  } catch (err) {
    log(`Registry update failed (non-fatal): ${err}`);
  }
}

/** Install tmux configs to ~/.genie/ and reload the genie tmux server. */
function syncTmuxConf(tmuxScriptsSrc: string): void {
  mkdirSync(GENIE_HOME, { recursive: true });

  // Install genie.tmux.conf → ~/.genie/tmux.conf (agent server config)
  const tmuxConfSrc = join(tmuxScriptsSrc, 'genie.tmux.conf');
  const tmuxConfDest = join(GENIE_HOME, 'tmux.conf');
  if (existsSync(tmuxConfSrc)) {
    try {
      copyFileSync(tmuxConfSrc, tmuxConfDest);
      success(`Installed tmux config to ${tmuxConfDest}`);
      try {
        const { tmuxBin } = require('../lib/ensure-tmux.js');
        execSync(`${tmuxBin()} -L genie source-file '${tmuxConfDest}'`, { stdio: 'ignore' });
        success('Reloaded genie tmux server configuration');
      } catch {
        // genie tmux server not running or reload failed — non-fatal
      }
    } catch {
      // Read/write failed — non-fatal
    }
  }

  // Install tui-tmux.conf → ~/.genie/tui-tmux.conf (TUI display config, no shell probes)
  const tuiConfSrc = join(tmuxScriptsSrc, 'tui-tmux.conf');
  const tuiConfDest = join(GENIE_HOME, 'tui-tmux.conf');
  if (existsSync(tuiConfSrc)) {
    try {
      copyFileSync(tuiConfSrc, tuiConfDest);
      success(`Installed TUI tmux config to ${tuiConfDest}`);
    } catch {
      // Read/write failed — non-fatal
    }
  }

  // Install .generated.theme.conf → ~/.genie/.generated.theme.conf (Severance palette,
  // sourced by both tmux configs above). Generated from packages/genie-tokens.
  const themeSrc = join(tmuxScriptsSrc, '.generated.theme.conf');
  const themeDest = join(GENIE_HOME, '.generated.theme.conf');
  if (existsSync(themeSrc)) {
    try {
      copyFileSync(themeSrc, themeDest);
      success(`Installed tmux theme to ${themeDest}`);
    } catch {
      // Read/write failed — non-fatal
    }
  }

  // Install osc52-copy.sh → ~/.genie/scripts/osc52-copy.sh (clipboard helper for nested tmux)
  const osc52Src = join(tmuxScriptsSrc, 'osc52-copy.sh');
  const osc52Dest = join(GENIE_HOME, 'scripts', 'osc52-copy.sh');
  if (existsSync(osc52Src)) {
    try {
      copyFileSync(osc52Src, osc52Dest);
      chmodSync(osc52Dest, 0o755);
      success(`Installed OSC 52 clipboard helper to ${osc52Dest}`);
    } catch {
      // Read/write failed — non-fatal
    }
  }
}

/** Copy tmux scripts from the global package to ~/.genie/scripts/ */
function syncTmuxScripts(globalPkgDir: string): void {
  const tmuxScriptsSrc = join(globalPkgDir, 'scripts', 'tmux');
  if (!existsSync(tmuxScriptsSrc)) return;

  const scriptsDir = join(GENIE_HOME, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });

  let scriptCount = 0;
  for (const entry of readdirSync(tmuxScriptsSrc)) {
    if (
      entry.endsWith('.sh') ||
      entry === 'genie.tmux.conf' ||
      entry === 'tui-tmux.conf' ||
      entry === '.generated.theme.conf'
    ) {
      const src = join(tmuxScriptsSrc, entry);
      const dest = join(scriptsDir, entry);
      copyFileSync(src, dest);
      try {
        chmodSync(dest, entry.endsWith('.sh') ? 0o755 : 0o644);
      } catch {
        // chmod may fail on some filesystems — non-fatal
      }
      scriptCount++;
    }
  }

  if (scriptCount > 0) {
    success(`Refreshed ${scriptCount} tmux scripts at ${scriptsDir}`);
  }

  syncTmuxConf(tmuxScriptsSrc);
}

/** Update marketplace.json version field to match the installed CLI version. */
function syncMarketplaceVersion(claudePlugins: string, version: string): void {
  const marketplacePath = join(claudePlugins, 'marketplaces', 'automagik', '.claude-plugin', 'marketplace.json');
  try {
    if (!existsSync(marketplacePath)) return;
    const data = JSON.parse(readFileSync(marketplacePath, 'utf-8'));
    if (Array.isArray(data.plugins)) {
      for (const plugin of data.plugins) {
        if (plugin.name === 'genie') {
          plugin.version = version;
        }
      }
    }
    writeFileSync(marketplacePath, JSON.stringify(data, null, 2));
    success(`Updated marketplace.json to v${version}`);
  } catch (err) {
    log(`Marketplace version update failed (non-fatal): ${err}`);
  }
}

/** Update plugins/genie/package.json version field to match the installed CLI version. */
function syncPluginPackageVersion(claudePlugins: string, version: string): void {
  const pkgPath = join(claudePlugins, 'marketplaces', 'automagik', 'plugins', 'genie', 'package.json');
  try {
    if (!existsSync(pkgPath)) return;
    const data = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    data.version = version;
    writeFileSync(pkgPath, JSON.stringify(data, null, 2));
    success(`Updated plugin package.json to v${version}`);
  } catch (err) {
    log(`Plugin package.json update failed (non-fatal): ${err}`);
  }
}

/** Repoint the skills symlink to the current cache version. */
function syncSkillsSymlink(claudePlugins: string, version: string): void {
  const skillsLink = join(claudePlugins, 'marketplaces', 'automagik', 'plugins', 'genie', 'skills');
  const cacheSkills = join('..', '..', '..', '..', 'cache', 'automagik', 'genie', version, 'skills');
  try {
    const { symlinkSync, unlinkSync, lstatSync } = require('node:fs') as typeof import('node:fs');
    // Remove existing symlink/dir if present
    try {
      lstatSync(skillsLink);
      unlinkSync(skillsLink);
    } catch {
      // doesn't exist — fine
    }
    symlinkSync(cacheSkills, skillsLink);
    success(`Skills symlink → cache/${version}/skills`);
  } catch (err) {
    log(`Skills symlink update failed (non-fatal): ${err}`);
  }
}

async function syncPlugin(installType: InstallationType): Promise<void> {
  log('Syncing Claude Code plugin...');

  const globalPkgDir = await resolveGlobalPkgDir(installType);
  if (!globalPkgDir) {
    log('Could not find installed package — skipping plugin sync');
    return;
  }

  const pluginSrc = join(globalPkgDir, 'plugins', 'genie');
  if (!existsSync(pluginSrc)) {
    log('Plugin source not found in package — skipping plugin sync');
    return;
  }

  // Read version from installed package
  let version: string;
  try {
    const pkg = JSON.parse(readFileSync(join(globalPkgDir, 'package.json'), 'utf-8'));
    version = pkg.version;
  } catch {
    log('Could not read package version — skipping plugin sync');
    return;
  }

  // Copy to Claude Code plugin cache
  const claudePlugins = join(homedir(), '.claude', 'plugins');
  const cacheDir = join(claudePlugins, 'cache', 'automagik', 'genie', version);

  try {
    // Clean existing cache dir if it exists (stale version)
    if (existsSync(cacheDir)) {
      rmSync(cacheDir, { recursive: true, force: true });
    }
    copyDirSync(pluginSrc, cacheDir);

    // Skills live at <pkg>/skills/ (symlink in plugins/genie/ doesn't survive npm)
    const skillsSrc = join(globalPkgDir, 'skills');
    if (existsSync(skillsSrc) && !existsSync(join(cacheDir, 'skills'))) {
      copyDirSync(skillsSrc, join(cacheDir, 'skills'));
    }
  } catch (err) {
    error(`Failed to copy plugin: ${err}`);
    return;
  }

  updatePluginRegistry(claudePlugins, cacheDir, version);
  syncMarketplaceVersion(claudePlugins, version);
  syncPluginPackageVersion(claudePlugins, version);
  syncSkillsSymlink(claudePlugins, version);
  syncTmuxScripts(globalPkgDir);

  success(`Plugin synced to v${version}`);
}

// ============================================================================
// Channel Management
// ============================================================================

async function resolveChannel(options: { next?: boolean; stable?: boolean }): Promise<string> {
  // Explicit flags override everything
  if (options.next) return 'next';
  if (options.stable) return 'latest';

  // Read saved channel from config
  if (genieConfigExists()) {
    try {
      const config = await loadGenieConfig();
      if (config.updateChannel) return config.updateChannel;
    } catch {
      // Ignore config errors
    }
  }

  return 'latest';
}

async function persistChannel(channel: string): Promise<void> {
  try {
    const config = await loadGenieConfig();
    config.updateChannel = channel as 'latest' | 'next';
    await saveGenieConfig(config);
  } catch {
    // Non-fatal — channel preference lost but update still works
  }
}

export async function updateCommand(options: { next?: boolean; stable?: boolean } = {}): Promise<void> {
  console.log();
  console.log('\x1b[1m🧞 Genie CLI Update\x1b[0m');
  console.log('\x1b[2m────────────────────────────────────\x1b[0m');
  console.log();

  const channel = await resolveChannel(options);

  // Persist channel when explicitly switching
  if (options.next || options.stable) {
    await persistChannel(channel);
  }

  const installType = await detectInstallationType();
  log(`Detected installation: ${installType}`);
  log(`Channel: ${channel}${channel === 'next' ? ' (dev builds)' : ' (stable)'}`);
  console.log();

  if (installType === 'unknown') {
    error('No Genie CLI installation found');
    console.log();
    console.log('Install method not configured. Please reinstall genie:');
    console.log(
      '\x1b[36m  curl -fsSL https://raw.githubusercontent.com/automagik-dev/genie/main/install.sh | bash\x1b[0m',
    );
    console.log();
    process.exit(1);
  }

  if (installType === 'source') {
    await updateSource();
    return;
  }

  // Detect all global installs (npm + bun) to update both when they coexist
  const globalInstalls = await detectGlobalInstalls();

  // Primary update — exit on failure
  const primaryMethod = installType as 'npm' | 'bun';
  const primaryOk = primaryMethod === 'bun' ? await updateViaBun(channel) : await updateViaNpm(channel);
  if (!primaryOk) {
    process.exit(1);
  }

  // Secondary update — warn on failure, don't block
  const secondaryMethod = primaryMethod === 'bun' ? 'npm' : 'bun';
  if (globalInstalls.has(secondaryMethod)) {
    console.log();
    log(`Also updating ${secondaryMethod}-global install...`);
    const secondaryOk = secondaryMethod === 'bun' ? await updateViaBun(channel) : await updateViaNpm(channel);
    if (!secondaryOk) {
      error(`Secondary update via ${secondaryMethod} failed (non-blocking)`);
    }
  }

  await syncPlugin(installType);
}
