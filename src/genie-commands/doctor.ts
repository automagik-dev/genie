/**
 * Genie Doctor Command
 *
 * Diagnostic tool to check the health of the genie installation.
 * Checks prerequisites, configuration, and tmux connectivity.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { contractClaudePath, getClaudeSettingsPath } from '../lib/claude-settings.js';
import { tmuxBin } from '../lib/ensure-tmux.js';
import { genieConfigExists, getGenieConfigPath, isSetupComplete, loadGenieConfig } from '../lib/genie-config.js';
import { checkCommand } from '../lib/system-detect.js';

interface CheckResult {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  message?: string;
  suggestion?: string;
}

/**
 * Print section header
 */
function printSectionHeader(title: string): void {
  console.log();
  console.log(`\x1b[1m${title}:\x1b[0m`);
}

/**
 * Print a check result
 */
function printCheckResult(result: CheckResult): void {
  const icons = {
    pass: '\x1b[32m\u2713\x1b[0m',
    fail: '\x1b[31m\u2717\x1b[0m',
    warn: '\x1b[33m!\x1b[0m',
  };

  const icon = icons[result.status];
  const message = result.message ? ` ${result.message}` : '';
  console.log(`  ${icon} ${result.name}${message}`);

  if (result.suggestion) {
    console.log(`    \x1b[2m${result.suggestion}\x1b[0m`);
  }
}

/**
 * Check prerequisites (tmux, jq, bun, Claude Code)
 */
async function checkPrerequisites(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // Check tmux
  const tmuxCheck = await checkCommand('tmux');
  if (tmuxCheck.exists) {
    results.push({
      name: 'tmux',
      status: 'pass',
      message: tmuxCheck.version || '',
    });
  } else {
    results.push({
      name: 'tmux',
      status: 'fail',
      suggestion: 'Install with: brew install tmux (or apt install tmux)',
    });
  }

  // Check jq
  const jqCheck = await checkCommand('jq');
  if (jqCheck.exists) {
    results.push({
      name: 'jq',
      status: 'pass',
      message: jqCheck.version || '',
    });
  } else {
    results.push({
      name: 'jq',
      status: 'fail',
      suggestion: 'Install with: brew install jq (or apt install jq)',
    });
  }

  // Check bun
  const bunCheck = await checkCommand('bun');
  if (bunCheck.exists) {
    results.push({
      name: 'bun',
      status: 'pass',
      message: bunCheck.version || '',
    });
  } else {
    results.push({
      name: 'bun',
      status: 'fail',
      suggestion: 'Install with: curl -fsSL https://bun.sh/install | bash',
    });
  }

  // Check Claude Code
  const claudeCheck = await checkCommand('claude');
  if (claudeCheck.exists) {
    results.push({
      name: 'Claude Code',
      status: 'pass',
      message: claudeCheck.version || '',
    });
  } else {
    results.push({
      name: 'Claude Code',
      status: 'warn',
      suggestion: 'Install with: npm install -g @anthropic-ai/claude-code',
    });
  }

  return results;
}

/**
 * Check configuration
 */
async function checkConfiguration(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // Check if genie config exists
  if (genieConfigExists()) {
    results.push({
      name: 'Genie config exists',
      status: 'pass',
      message: contractClaudePath(getGenieConfigPath()),
    });
  } else {
    results.push({
      name: 'Genie config exists',
      status: 'warn',
      message: 'not found',
      suggestion: 'Run: genie setup',
    });
  }

  // Check if setup is complete
  if (isSetupComplete()) {
    results.push({
      name: 'Setup complete',
      status: 'pass',
    });
  } else {
    results.push({
      name: 'Setup complete',
      status: 'warn',
      message: 'not completed',
      suggestion: 'Run: genie setup',
    });
  }

  // Check if claude settings exists
  const claudeSettingsPath = getClaudeSettingsPath();
  if (existsSync(claudeSettingsPath)) {
    results.push({
      name: 'Claude settings exists',
      status: 'pass',
      message: contractClaudePath(claudeSettingsPath),
    });
  } else {
    results.push({
      name: 'Claude settings exists',
      status: 'warn',
      message: 'not found',
      suggestion: 'Claude Code creates this on first run',
    });
  }

  return results;
}

/**
 * Check tmux status
 */
async function checkTmux(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // Check if tmux server is running
  try {
    const serverResult = await $`${tmuxBin()} -L genie list-sessions 2>/dev/null`.quiet();
    if (serverResult.exitCode === 0) {
      results.push({
        name: 'Server running',
        status: 'pass',
      });
    } else {
      results.push({
        name: 'Server running',
        status: 'warn',
        message: 'no sessions',
        suggestion: 'Start with: tmux new-session -d -s genie',
      });
      return results;
    }
  } catch {
    results.push({
      name: 'Server running',
      status: 'warn',
      message: 'could not check',
    });
    return results;
  }

  // Check if genie session exists
  const config = await loadGenieConfig();
  const sessionName = config.session.name;

  try {
    const sessionResult = await $`${tmuxBin()} -L genie has-session -t ${sessionName} 2>/dev/null`.quiet();
    if (sessionResult.exitCode === 0) {
      results.push({
        name: `Session '${sessionName}' exists`,
        status: 'pass',
      });
    } else {
      results.push({
        name: `Session '${sessionName}' exists`,
        status: 'warn',
        suggestion: `Start with: tmux new-session -d -s ${sessionName}`,
      });
    }
  } catch {
    results.push({
      name: `Session '${sessionName}' exists`,
      status: 'warn',
      message: 'could not check',
    });
  }

  return results;
}

/**
 * Check worker profiles configuration
 */
async function checkWorkerProfiles(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // First check if genie config exists and has worker profiles
  if (!genieConfigExists()) {
    results.push({
      name: 'Worker profiles',
      status: 'warn',
      message: 'no genie config',
      suggestion: 'Run: genie setup',
    });
    return results;
  }

  const config = await loadGenieConfig();
  const profiles = config.workerProfiles;

  if (!profiles || Object.keys(profiles).length === 0) {
    results.push({
      name: 'Worker profiles',
      status: 'pass',
      message: 'none configured (using defaults)',
    });
    return results;
  }

  // Report profile count
  const totalProfiles = Object.keys(profiles).length;
  results.push({
    name: 'Profiles configured',
    status: 'pass',
    message: `${totalProfiles} profile${totalProfiles === 1 ? '' : 's'}`,
  });

  // Report claude profiles
  for (const name of Object.keys(profiles)) {
    results.push({
      name: `Profile '${name}'`,
      status: 'pass',
      message: 'claude (direct)',
    });
  }

  // Check default profile
  if (config.defaultWorkerProfile) {
    if (profiles[config.defaultWorkerProfile]) {
      results.push({
        name: 'Default profile',
        status: 'pass',
        message: config.defaultWorkerProfile,
      });
    } else {
      results.push({
        name: 'Default profile',
        status: 'warn',
        message: `'${config.defaultWorkerProfile}' not found`,
        suggestion: 'Run: genie profiles default <profile>',
      });
    }
  }

  return results;
}

/**
 * Check Omni bridge health
 */
async function checkBridge(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  try {
    const { getBridge } = await import('../services/omni-bridge.js');
    const bridge = getBridge();

    if (!bridge) {
      results.push({
        name: 'Bridge running',
        status: 'warn',
        message: 'not running in this process',
        suggestion: 'Bridge starts automatically with: genie serve',
      });
      return results;
    }

    const s = await bridge.status();

    results.push({
      name: 'NATS connection',
      status: s.connected ? 'pass' : 'fail',
      message: s.connected ? `connected (${s.natsUrl})` : `disconnected (${s.natsUrl})`,
      suggestion: s.connected ? undefined : 'Check NATS server: nats-server or omni start',
    });

    results.push({
      name: 'Active sessions',
      status: 'pass',
      message: `${s.activeSessions} / ${s.maxConcurrent} (queue: ${s.queueDepth})`,
    });

    results.push({
      name: 'PG backing',
      status: s.pgAvailable ? 'pass' : 'warn',
      message: s.pgAvailable ? 'connected' : 'degraded (in-memory)',
    });
  } catch {
    results.push({
      name: 'Bridge module',
      status: 'warn',
      message: 'could not load omni-bridge',
    });
  }

  return results;
}

/**
 * Main doctor command
 */
function runCheckSection(label: string, results: CheckResult[], counts: { errors: boolean; warnings: boolean }): void {
  printSectionHeader(label);
  for (const result of results) {
    printCheckResult(result);
    if (result.status === 'fail') counts.errors = true;
    if (result.status === 'warn') counts.warnings = true;
  }
}

export async function doctorCommand(options?: { fix?: boolean }): Promise<void> {
  if (options?.fix) {
    await doctorFix();
    return;
  }

  console.log();
  console.log('\x1b[1mGenie Doctor\x1b[0m');
  console.log(`\x1b[2m${'\u2500'.repeat(40)}\x1b[0m`);

  const counts = { errors: false, warnings: false };

  runCheckSection('Prerequisites', await checkPrerequisites(), counts);
  runCheckSection('Configuration', await checkConfiguration(), counts);
  runCheckSection('Tmux', await checkTmux(), counts);
  runCheckSection('Worker Profiles', await checkWorkerProfiles(), counts);
  runCheckSection('Omni Bridge', await checkBridge(), counts);

  // Summary
  console.log();
  console.log(`\x1b[2m${'\u2500'.repeat(40)}\x1b[0m`);

  if (counts.errors) {
    console.log('\x1b[31mSome checks failed.\x1b[0m Run \x1b[36mgenie setup\x1b[0m to fix.');
  } else if (counts.warnings) {
    console.log('\x1b[33mSome warnings detected.\x1b[0m Everything should still work.');
  } else {
    console.log('\x1b[32mAll checks passed!\x1b[0m');
  }

  console.log();

  if (counts.errors) {
    process.exit(1);
  }
}

/**
 * `genie doctor --fix` — automated recovery for stale PG state.
 * Kills zombie postgres, cleans shared memory, removes stale files, restarts daemon.
 */
async function killStalePostgres(): Promise<void> {
  console.log('  Killing stale postgres processes...');
  try {
    const { execSync } = await import('node:child_process');
    execSync('pkill -9 -f "postgres.*pgserve" 2>/dev/null || true', { stdio: 'ignore', timeout: 5000 });
    console.log('  \x1b[32m\u2713\x1b[0m Stale postgres processes killed');
  } catch {
    console.log('  \x1b[33m!\x1b[0m Could not kill stale postgres processes');
  }
}

async function cleanSharedMemory(): Promise<void> {
  console.log('  Cleaning shared memory...');
  try {
    const { execSync } = await import('node:child_process');
    execSync("ipcs -m 2>/dev/null | awk '$6 == 0 {print $2}' | xargs -I{} ipcrm -m {} 2>/dev/null || true", {
      stdio: 'ignore',
      timeout: 5000,
    });
    console.log('  \x1b[32m\u2713\x1b[0m Shared memory cleaned');
  } catch {
    console.log('  \x1b[32m\u2713\x1b[0m No stale shared memory');
  }
}

async function stopExistingDaemon(pidFile: string): Promise<void> {
  try {
    const { readFileSync } = await import('node:fs');
    const pid = Number.parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    if (!Number.isNaN(pid) && pid > 0) {
      try {
        process.kill(pid, 'SIGTERM');
        console.log(`  \x1b[32m\u2713\x1b[0m Stopped existing daemon (PID ${pid})`);
        await new Promise((r) => setTimeout(r, 1000));
      } catch {
        // Already dead
      }
    }
  } catch {
    // No PID file or unreadable — no daemon to stop
  }
}

function removeStaleFiles(genieHome: string, pidFile: string): void {
  const portFile = join(genieHome, 'pgserve.port');
  const postmasterPid = join(genieHome, 'data', 'pgserve', 'postmaster.pid');

  for (const file of [portFile, pidFile, postmasterPid]) {
    if (existsSync(file)) {
      try {
        unlinkSync(file);
        console.log(`  \x1b[32m\u2713\x1b[0m Removed ${file}`);
      } catch {
        console.log(`  \x1b[33m!\x1b[0m Could not remove ${file}`);
      }
    }
  }
}

async function restartDaemon(): Promise<void> {
  console.log('  Restarting daemon...');
  try {
    const { spawn } = await import('node:child_process');
    const bunPath = process.execPath ?? 'bun';
    const genieBin = process.argv[1] ?? 'genie';
    const child = spawn(bunPath, [genieBin, 'daemon', 'start'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    console.log('  \x1b[32m\u2713\x1b[0m Daemon restart initiated');
  } catch {
    console.log('  \x1b[33m!\x1b[0m Could not restart daemon \u2014 run: genie daemon start');
  }
}

async function doctorFix(): Promise<void> {
  console.log('\n\x1b[1mGenie Doctor \u2014 Auto Fix\x1b[0m');
  console.log(`\x1b[2m${'\u2500'.repeat(40)}\x1b[0m\n`);

  await killStalePostgres();
  await cleanSharedMemory();

  const genieHome = process.env.GENIE_HOME ?? join(homedir(), '.genie');
  const pidFile = join(genieHome, 'scheduler.pid');

  await stopExistingDaemon(pidFile);
  removeStaleFiles(genieHome, pidFile);
  await restartDaemon();

  console.log(`\n\x1b[2m${'\u2500'.repeat(40)}\x1b[0m`);
  console.log('\x1b[32mFix complete.\x1b[0m Run \x1b[36mgenie doctor\x1b[0m to verify.\n');
}
