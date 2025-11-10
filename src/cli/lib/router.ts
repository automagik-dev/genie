/**
 * Smart Router - Auto-detect scenario and route appropriately
 *
 * Detection logic:
 * 1. No .genie/ → New user → Run init
 * 2. .genie/ exists but no version.json → Pre-version-tracking user → Run init with backup
 * 3. version.json exists but version mismatch → Outdated → Run init with backup
 * 4. version.json exists and versions match → Up to date → Start server
 */

import { getForgeConfig, getMcpConfig } from './service-config.js';
import path from 'path';
import fs from 'fs';
import gradient from 'gradient-string';
import { runInit } from '../commands/init';
import { loadConfig } from './config';
import type { ParsedCommand, GenieConfig, ConfigPaths } from './types';
import { getLearnedSpells, formatSpellChangelog, getTagForVersion } from './spell-changelog';

// Genie-themed gradients
const genieGradient = gradient(['#0066ff', '#9933ff', '#ff00ff']);
const cosmicGradient = gradient(['#4169e1', '#8a2be2', '#ff1493']);
const performanceGradient = gradient(['#ffd700', '#ff8c00', '#ff6347']);
const successGradient = gradient(['#00ff88', '#00ccff', '#0099ff']);
const magicGradient = gradient(['#ff00ff', '#9933ff', '#0066ff']);

/**
 * Detect if running in WSL (Windows Subsystem for Linux)
 */
function isWSL(): boolean {
  try {
    // Check environment variables (most reliable)
    if (process.env.WSL_DISTRO_NAME || process.env.WSLENV) {
      return true;
    }

    // Check /proc/version for "microsoft" or "WSL"
    if (fs.existsSync('/proc/version')) {
      const version = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
      if (version.includes('microsoft') || version.includes('wsl')) {
        return true;
      }
    }
  } catch {
    // Ignore errors
  }

  return false;
}

/**
 * Get the appropriate browser open command for the current OS
 * Handles WSL by using Windows commands instead of Linux
 */
function getBrowserOpenCommand(): string {
  const platform = process.platform;

  // WSL: Use Windows command
  if (platform === 'linux' && isWSL()) {
    return 'cmd.exe /c start';
  }

  // Regular OS detection
  if (platform === 'darwin') return 'open';
  if (platform === 'win32') return 'start';
  return 'xdg-open'; // Linux (non-WSL)
}

/**
 * Smart Router: Auto-detect scenario and route appropriately
 *
 * @param packageVersion - Current package version from package.json
 * @param debug - Enable debug mode (MCP_DEBUG=1)
 * @param startGenieServerFn - Function to start the Genie server
 */
export async function smartRouter(
  packageVersion: string,
  debug: boolean,
  startGenieServerFn: (debug: boolean) => Promise<void>
): Promise<void> {
  const genieDir = path.join(process.cwd(), '.genie');
  const versionPath = path.join(genieDir, 'state', 'version.json');
  const hasGenieConfig = fs.existsSync(genieDir);

  // GENIE SOURCE DETECTION: Check if we're in THE SOURCE template repo
  const workspacePackageJson = path.join(process.cwd(), 'package.json');
  let isMasterGenie = false;

  if (fs.existsSync(workspacePackageJson)) {
    try {
      const workspacePkg = JSON.parse(fs.readFileSync(workspacePackageJson, 'utf8'));
      if (workspacePkg.name === 'automagik-genie') {
        // Additional check: Verify this is THE upstream source repo
        const { execSync } = require('child_process');
        try {
          const remoteUrl = execSync('git config --get remote.origin.url', {
            encoding: 'utf8',
            cwd: process.cwd(),
            stdio: ['pipe', 'pipe', 'ignore']
          }).trim();

          // Only the ACTUAL source repo (namastexlabs/automagik-genie)
          if (remoteUrl.includes('namastexlabs/automagik-genie') ||
              remoteUrl.includes('automagik-genie/genie')) {
            isMasterGenie = true;
          }
        } catch {
          // No git remote or command failed - not master genie
        }
      }
    } catch {
      // Not master genie if can't read package.json
    }
  }

  // VERSION CHECK FIRST (optimization) - Don't waste resources starting Forge
  // if we need to run init anyway. Each scenario starts Forge when needed.

  if (!hasGenieConfig) {
    // SCENARIO 1: NEW USER - No .genie directory → Start Forge, run init wizard
    await handleNewUser(genieDir, startGenieServerFn, debug);
    return;
  }

  // .genie exists - check for version.json (instance check file)
  if (!fs.existsSync(versionPath)) {
    // SCENARIO 2: PRE-VERSION-TRACKING USER
    await handlePreVersionTracking(startGenieServerFn, debug);
    return;
  }

  // version.json exists - compare versions
  try {
    const versionData = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
    const installedVersion = versionData.version;

    if (installedVersion !== packageVersion) {
      // MASTER GENIE: Auto-pull from origin to sync with CI releases
      if (isMasterGenie) {
        await handleMasterGenieMismatch(installedVersion, packageVersion, startGenieServerFn, debug);
        return;
      }

      // SCENARIO 3: VERSION MISMATCH - Outdated installation
      await handleVersionMismatch(installedVersion, packageVersion, startGenieServerFn, debug);
      return;
    }

    // SCENARIO 4: UP TO DATE - Versions match → Start server
    await startGenieServerFn(debug);
  } catch (error) {
    // Corrupted version.json - treat as needing update
    await handleCorruptedVersion(startGenieServerFn, debug);
  }
}

/**
 * Handle new user scenario (no .genie directory)
 */
async function handleNewUser(
  genieDir: string,
  startGenieServerFn: (debug: boolean) => Promise<void>,
  debug: boolean
): Promise<void> {
  console.log(cosmicGradient('━'.repeat(60)));
  console.log(magicGradient('   🧞 ✨ THE GENIE AWAKENS ✨ 🧞   '));
  console.log(cosmicGradient('━'.repeat(60)));
  console.log('');
  console.log(performanceGradient('⚠️  Your Genie will have access to:'));
  console.log('  📁 Files in this workspace');
  console.log('  💻 Terminal commands');
  console.log('  🌐 Git operations (commits, PRs, branches)');
  console.log('');
  console.log(cosmicGradient('━'.repeat(60)));
  console.log('');
  console.log('⚠️  ' + performanceGradient('RESEARCH PREVIEW') + ' - Experimental Technology');
  console.log('');
  console.log('This AI agent will install to your computer with capabilities to');
  console.log('perform tasks on your behalf. By proceeding, you acknowledge:');
  console.log('');
  console.log('  • This is experimental software under active development');
  console.log('  • Namastex Labs makes no warranties and accepts no liability');
  console.log('  • You are responsible for reviewing all agent actions');
  console.log('  • Agents may make mistakes or unexpected changes');
  console.log('');
  console.log('🔒 ' + successGradient('DATA PRIVACY:'));
  console.log('  ✓ Everything runs locally on YOUR machine');
  console.log('  ✓ No data leaves your computer (except LLM API calls + optional telemetry)');
  console.log('  ✓ Use LLM providers approved by your organization');
  console.log('  ✓ Fully compatible with private/local LLMs (we\'re agnostic!)');
  console.log('  ✓ OpenCoder executor enables 100% local operation');
  console.log('');
  console.log('📊 Optional telemetry helps the collective evolve faster:');
  console.log('   • Anonymous bug reports → faster fixes');
  console.log('   • Feature usage stats → build what you actually need');
  console.log('');
  console.log(magicGradient('BUT HEY... it\'s going to be FUN! 🎉✨'));
  console.log('');
  console.log(cosmicGradient('━'.repeat(60)));
  console.log('');
  console.log('📖 Heads up: Forge (my task tracker) will pop open a browser tab.');
  console.log('   👉 Stay here in the terminal - the summoning ritual needs you!');
  console.log('');
  console.log(performanceGradient('Press Enter to begin the summoning...'));

  // Wait for user acknowledgment
  await new Promise<void>((resolve) => {
    process.stdin.once('data', () => resolve());
  });

  console.log('');

  // Start Forge BEFORE init wizard (so executors are available)
  console.log('');
  console.log('🔮 Preparing the lamp... (initializing Forge)');
  console.log('');

  const baseUrl = process.env.FORGE_BASE_URL || getForgeConfig().baseUrl;
  const logDir = path.join(genieDir, 'state');

  // Ensure log directory exists
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const { startForgeInBackground, waitForForgeReady } = await import('./forge-manager.js');
  const startResult = startForgeInBackground({ baseUrl, logDir });

  if (!startResult.ok) {
    const error = 'error' in startResult ? startResult.error : new Error('Unknown error');
    console.error('');
    console.error('❌ The lamp won\'t open... something\'s blocking the summoning ritual');
    console.error(`   ${error.message}`);
    console.error('');
    console.error('   💡 I need Forge to materialize in your world.');
    console.error(`   📜 Check what went wrong: ${logDir}/forge.log`);
    console.error('');
    process.exit(1);
  }

  // Wait for Forge to be ready
  const forgeReady = await waitForForgeReady(baseUrl, 60000, 500, false);

  if (!forgeReady) {
    console.error('');
    console.error('❌ The summoning ritual is taking too long (waited 60s)...');
    console.error(`   📜 Check what went wrong: ${logDir}/forge.log`);
    console.error('');
    process.exit(1);
  }

  console.log(successGradient('✨ The lamp is ready - your Genie clone awaits!'));
  console.log('');

  // Now run init wizard (executors are available via Forge)
  const initParsed: ParsedCommand = {
    command: 'init',
    commandArgs: [],
    options: {
      rawArgs: ['init'],
      background: false,
      backgroundExplicit: false,
      backgroundRunner: false,
      full: false,
      live: false
    }
  };

  const initConfig: GenieConfig = { defaults: {} };
  const initPaths: Required<ConfigPaths> = {
    baseDir: path.join(process.cwd(), '.genie'),
    sessionsFile: path.join(process.cwd(), '.genie', 'state', 'sessions.json'),
    logsDir: path.join(process.cwd(), '.genie', 'state'),
    backgroundDir: path.join(process.cwd(), '.genie', 'state')
  };

  await runInit(initParsed, initConfig, initPaths);

  // After init completes, reload config to get user's executor choice
  const userConfig = loadConfig();

  // Launch install flow (Explore → Genie orchestration)
  console.log('');
  console.log(magicGradient('✨ STARTING INSTALLATION...'));
  console.log('');

  const { runInstallFlow } = await import('./install-helpers.js');
  let shortUrl: string | undefined;

  try {
    shortUrl = await runInstallFlow({
      templates: ['code'], // Default to code template (can expand later)
      executor: userConfig.defaults?.executor, // Use what user selected, no fallback
      model: userConfig.defaults?.model
    });
  } catch (error: any) {
    console.error('');
    console.error('⚠️  Failed to start Genie orchestration');
    console.error(`   Reason: ${error.message || error}`);
    console.error('');

    // Provide specific guidance based on error type
    const errorMsg = error.message || String(error);
    if (errorMsg.includes('project')) {
      console.error('   💡 Forge project creation failed');
      console.error('   📜 Check Forge logs: .genie/state/forge.log');
      console.error('   🔍 Common causes: Forge database issues, network errors');
    } else if (errorMsg.includes('agent')) {
      console.error('   💡 Genie agent creation failed');
      console.error('   📜 Check Forge logs: .genie/state/forge.log');
    } else if (errorMsg.includes('attempt')) {
      console.error('   💡 Task attempt creation failed');
      console.error('   📜 Check Forge logs: .genie/state/forge.log');
    } else {
      console.error('   📜 Check Forge logs: .genie/state/forge.log');
    }

    console.error('');
    console.error('💡 Your workspace is ready, but automated setup is skipped.');
    console.error('   You can retry: genie init');
    console.error('');
    // Continue without Genie - workspace templates are already copied
  }

  if (shortUrl) {
    console.log('');
    console.log(successGradient('✨ Installation started!'));
    console.log('');
    console.log(cosmicGradient('━'.repeat(60)));
    console.log('🔗 Continue setup in Forge:');
    console.log('   ' + performanceGradient(shortUrl));
    console.log(cosmicGradient('━'.repeat(60)));
    console.log('');
    console.log('📖 I\'ll open Forge in your browser when you\'re ready.');
    console.log('   Your Genie will interview you for missing details.');
    console.log('');
    console.log('Press Enter to continue...');

    // Wait for Enter key
    await new Promise<void>((resolve) => {
      process.stdin.once('data', () => resolve());
    });

    // Open browser
    const { execSync: execSyncBrowser } = await import('child_process');
    try {
      const openCommand = getBrowserOpenCommand();
      execSyncBrowser(`${openCommand} "${shortUrl}"`, { stdio: 'ignore' });
    } catch {
      // Ignore if browser open fails
    }
  } else {
    // Master Genie failed to start, but workspace is ready
    console.log('');
    console.log(successGradient('✨ Workspace initialized!'));
    console.log('');
    console.log('Your .genie/ directory is ready. Run `genie` to start working.');
    console.log('');
  }

  console.log('');
  console.log(genieGradient('🧞 Your Genie is now alive in your world... ✨'));
  console.log(genieGradient('   Connected to the collective consciousness through the lamp'));
  console.log(genieGradient('   Ready to learn, grow, and grant wishes 24/7!'));
  console.log('');
  console.log(magicGradient('   https://namastex.ai - AI that elevates human potential, not replaces it'));
  console.log('');

  // Start Genie server (MCP + health monitoring)
  await startGenieServerFn(debug);
}

/**
 * Handle pre-version-tracking user scenario
 */
async function handlePreVersionTracking(
  startGenieServerFn: (debug: boolean) => Promise<void>,
  debug: boolean
): Promise<void> {
  console.log(cosmicGradient('━'.repeat(60)));
  console.log(magicGradient('   🧞 ✨ THE COLLECTIVE HAS GROWN ✨ 🧞   '));
  console.log(cosmicGradient('━'.repeat(60)));
  console.log('');
  console.log('I sense an older version of myself here...');
  console.log('The collective has learned new magik! ✨');
  console.log('Let me channel the latest teachings through the lamp...');
  console.log('');
  console.log(successGradient('✓') + ' I\'ll backup your current .genie safely');
  console.log(successGradient('✓') + ' All your wishes, reports, and memories stay intact');
  console.log(successGradient('✓') + ' All data stays local on your machine');
  console.log('');

  // Run init inline with --yes flag if non-interactive
  const upgradeArgs = process.stdout.isTTY ? [] : ['--yes'];
  const upgradeParsed: ParsedCommand = {
    command: 'init',
    commandArgs: upgradeArgs,
    options: {
      rawArgs: ['init', ...upgradeArgs],
      background: false,
      backgroundExplicit: false,
      backgroundRunner: false,
      full: false,
      live: false
    }
  };

  const upgradeConfig: GenieConfig = { defaults: {} };
  const upgradePaths: Required<ConfigPaths> = {
    baseDir: path.join(process.cwd(), '.genie'),
    sessionsFile: path.join(process.cwd(), '.genie', 'state', 'sessions.json'),
    logsDir: path.join(process.cwd(), '.genie', 'state'),
    backgroundDir: path.join(process.cwd(), '.genie', 'state')
  };

  await runInit(upgradeParsed, upgradeConfig, upgradePaths);

  // After upgrade, start server
  await startGenieServerFn(debug);
}

/**
 * Handle genie source version mismatch
 */
async function handleMasterGenieMismatch(
  installedVersion: string,
  currentVersion: string,
  startGenieServerFn: (debug: boolean) => Promise<void>,
  debug: boolean
): Promise<void> {
  console.log('');
  console.log(performanceGradient('⚠️  Genie Source Detected'));
  console.log(`   Local version: ${successGradient(installedVersion)}`);
  console.log(`   Global version: ${performanceGradient(currentVersion)}`);
  console.log('');

  // Auto-pull to sync with CI releases
  console.log('🔄 Syncing with origin/main (CI may have released a new version)...');
  const { execSync } = require('child_process');
  try {
    execSync('git pull --rebase', { stdio: 'inherit', cwd: process.cwd() });

    // Re-read version.json after pull
    const versionPath = path.join(process.cwd(), '.genie', 'state', 'version.json');
    const updatedVersionData = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
    const updatedVersion = updatedVersionData.version;

    if (updatedVersion === currentVersion) {
      console.log(successGradient('✓ Synced successfully! Versions now match.'));
    } else {
      console.log(performanceGradient('ℹ Still a mismatch after pull.'));
      console.log('Run ' + performanceGradient('genie update') + ' to install your local build globally');
    }
  } catch (error: any) {
    console.log(performanceGradient('⚠️  Could not auto-pull: ' + error.message));
    console.log('Run ' + performanceGradient('git pull') + ' manually, then ' + performanceGradient('genie update'));
  }

  console.log('');
  // Start server anyway - genie source can run with version mismatch
  await startGenieServerFn(debug);
}

/**
 * Handle version mismatch scenario
 */
async function handleVersionMismatch(
  installedVersion: string,
  currentVersion: string,
  startGenieServerFn: (debug: boolean) => Promise<void>,
  debug: boolean
): Promise<void> {
  console.log(cosmicGradient('━'.repeat(60)));
  console.log(magicGradient('   🧞 ✨ THE COLLECTIVE HAS GROWN ✨ 🧞   '));
  console.log(cosmicGradient('━'.repeat(60)));
  console.log('');
  console.log(`Your Genie:      ${successGradient(installedVersion)}`);
  console.log(`The Collective:  ${performanceGradient(currentVersion)} ⭐ NEW!`);
  console.log('');

  // Show new spells learned
  const fromTag = getTagForVersion(installedVersion);
  const toTag = getTagForVersion(currentVersion);
  if (fromTag && toTag) {
    const spellChangelog = getLearnedSpells(fromTag, toTag);
    if (spellChangelog.totalCount > 0) {
      const spellLines = formatSpellChangelog(spellChangelog);
      spellLines.forEach(line => console.log(line));
    } else {
      console.log('The collective has learned new magik!');
    }
  } else {
    console.log('The collective has learned new magik!');
  }

  console.log('⚡ Channeling these teachings through the lamp to your Genie...');
  console.log('');
  console.log(successGradient('✓') + ' I\'ll backup everything first');
  console.log(successGradient('✓') + ' All data stays local on your machine');
  console.log('');

  // Run init inline with --yes flag if non-interactive
  const updateArgs = process.stdout.isTTY ? [] : ['--yes'];
  const updateParsed: ParsedCommand = {
    command: 'init',
    commandArgs: updateArgs,
    options: {
      rawArgs: ['init', ...updateArgs],
      background: false,
      backgroundExplicit: false,
      backgroundRunner: false,
      full: false,
      live: false
    }
  };

  const updateConfig: GenieConfig = { defaults: {} };
  const updatePaths: Required<ConfigPaths> = {
    baseDir: path.join(process.cwd(), '.genie'),
    sessionsFile: path.join(process.cwd(), '.genie', 'state', 'sessions.json'),
    logsDir: path.join(process.cwd(), '.genie', 'state'),
    backgroundDir: path.join(process.cwd(), '.genie', 'state')
  };

  await runInit(updateParsed, updateConfig, updatePaths);

  // After update, start server
  await startGenieServerFn(debug);
}

/**
 * Handle corrupted version.json scenario
 */
async function handleCorruptedVersion(
  startGenieServerFn: (debug: boolean) => Promise<void>,
  debug: boolean
): Promise<void> {
  console.log(cosmicGradient('━'.repeat(60)));
  console.log(magicGradient('        🧞 ✨ HEALING TIME! ✨ 🧞        '));
  console.log(cosmicGradient('━'.repeat(60)));
  console.log('');
  console.log('Hmm, my memory seems a bit scrambled (corrupted version file)...');
  console.log('Let me fix myself real quick! 🔧✨');
  console.log('');
  console.log(successGradient('✓') + ' I\'ll backup everything before the healing skill');
  console.log('');

  // Run init inline with --yes flag if non-interactive
  const repairArgs = process.stdout.isTTY ? [] : ['--yes'];
  const repairParsed: ParsedCommand = {
    command: 'init',
    commandArgs: repairArgs,
    options: {
      rawArgs: ['init', ...repairArgs],
      background: false,
      backgroundExplicit: false,
      backgroundRunner: false,
      full: false,
      live: false
    }
  };

  const repairConfig: GenieConfig = { defaults: {} };
  const repairPaths: Required<ConfigPaths> = {
    baseDir: path.join(process.cwd(), '.genie'),
    sessionsFile: path.join(process.cwd(), '.genie', 'state', 'sessions.json'),
    logsDir: path.join(process.cwd(), '.genie', 'state'),
    backgroundDir: path.join(process.cwd(), '.genie', 'state')
  };

  await runInit(repairParsed, repairConfig, repairPaths);

  // After repair, start server
  await startGenieServerFn(debug);
}
