/**
 * Genie Doctor Command
 *
 * Diagnostic tool to check the health of the genie installation.
 * Checks prerequisites, configuration, and tmux connectivity.
 */

import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import type { BridgeStatusResult, PingOptions } from '../lib/bridge-status.js';
import { contractClaudePath, getClaudeSettingsPath } from '../lib/claude-settings.js';
import { tmuxBin } from '../lib/ensure-tmux.js';
import { genieConfigExists, getGenieConfigPath, isSetupComplete, loadGenieConfig } from '../lib/genie-config.js';
import { checkCommand } from '../lib/system-detect.js';
import { findWorkspace } from '../lib/workspace.js';
import { collectInstallerResolution } from './installer-resolution.js';
import { collectObservabilityHealth } from './observability-health.js';

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
    // `=` prefix forces literal session-name match — without it tmux parses
    // values like `@46` as window-id syntax and fails lookup.
    const sessionResult = await $`${tmuxBin()} -L genie has-session -t ${`=${sessionName}`} 2>/dev/null`.quiet();
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
 * Check Omni bridge health via cross-process IPC (pidfile + NATS ping).
 *
 * This used to reach for the in-process bridge singleton which only
 * ever returned a bridge when doctor ran inside the same process as serve.
 * Now doctor is authoritative across processes: it reads the pidfile written
 * by the bridge, validates the owning PID, and issues a `omni.bridge.ping`
 * request with a 2s timeout. The result includes pid, uptime, subjects, and
 * the ping round-trip latency.
 */
async function checkBridge(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  try {
    const { getBridgeStatus, removeBridgePidfile } = await import('../lib/bridge-status.js');
    // Explicit PingOptions — doctor uses the default 2s timeout, but we
    // annotate the type so this call site stays self-documenting and so
    // the PingOptions export has a concrete consumer.
    const pingOpts: PingOptions = {};
    const res: BridgeStatusResult = await getBridgeStatus(undefined, pingOpts);

    if (res.state === 'stopped') {
      results.push({
        name: 'Bridge',
        status: 'warn',
        message: 'stopped (no pidfile)',
        suggestion: 'Start the bridge with: genie serve',
      });
      return results;
    }

    if (res.state === 'stale') {
      // Stale pidfile = owning process is dead or ping timed out. Clean up
      // the pidfile so the next `genie serve` start can retake cleanly.
      if (res.pidfile) {
        removeBridgePidfile();
      }
      results.push({
        name: 'Bridge',
        status: 'fail',
        message: `stale: ${res.detail}`,
        suggestion: 'Restart the bridge with: genie serve restart',
      });
      return results;
    }

    // state === 'running'
    const pong = res.pong;
    const pidfile = res.pidfile;
    if (!pong || !pidfile) {
      results.push({
        name: 'Bridge',
        status: 'warn',
        message: 'running state missing pong/pidfile metadata',
      });
      return results;
    }

    const uptimeSec = Math.round(pong.uptimeMs / 1000);
    results.push({
      name: 'Bridge running',
      status: 'pass',
      message: `running (pid ${pong.pid}, uptime ${uptimeSec}s)`,
    });

    results.push({
      name: 'NATS ping',
      status: 'pass',
      message: `pong in ${res.latencyMs ?? 0}ms (${pidfile.natsUrl})`,
    });

    results.push({
      name: 'Subjects',
      status: 'pass',
      message: pong.subjects.join(', '),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({
      name: 'Bridge module',
      status: 'warn',
      message: `could not probe bridge: ${detail}`,
    });
  }

  return results;
}

/**
 * Check that no agent has leftover `---` frontmatter in its `AGENTS.md`
 * when `agent.yaml` is also present. Wish `dir-sync-frontmatter-refresh`
 * (Group 6) eliminates frontmatter entirely post-migration — if a user
 * pastes config back into AGENTS.md, sync silently ignores it, which is
 * confusing. This check surfaces the drift loudly.
 *
 * Exported for unit tests and for callers that want to run this check
 * outside `genie doctor` (e.g. a pre-sync lint).
 */
export function checkLegacyAgentFrontmatter(workspaceRoot?: string): CheckResult[] {
  const results: CheckResult[] = [];
  const root = workspaceRoot ?? findWorkspace()?.root;
  if (!root) return [];

  const agentsDir = join(root, 'agents');
  if (!existsSync(agentsDir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(agentsDir);
  } catch {
    return [];
  }

  for (const name of entries) {
    const agentDir = join(agentsDir, name);
    try {
      if (!statSync(agentDir).isDirectory()) continue;
    } catch {
      continue;
    }

    const yamlPath = join(agentDir, 'agent.yaml');
    const agentsMdPath = join(agentDir, 'AGENTS.md');

    // Only flag when both files exist AND AGENTS.md starts with a fence.
    // Pre-migration state (no yaml, frontmatter present) is NOT a warning —
    // sync will migrate it on the next run.
    if (!existsSync(yamlPath) || !existsSync(agentsMdPath)) continue;

    let headContent: string;
    try {
      // Read only the first handful of bytes to cheaply detect the fence.
      headContent = readFileSync(agentsMdPath, 'utf-8').slice(0, 4);
    } catch {
      continue;
    }

    if (!headContent.startsWith('---')) continue;

    results.push({
      name: `agents/${name}/AGENTS.md`,
      status: 'warn',
      message: 'legacy frontmatter detected (ignored by sync)',
      suggestion: `Move config into agents/${name}/agent.yaml — AGENTS.md is prompt-only post-migration.`,
    });
  }

  // Single positive result when nothing drifted, so the section prints a
  // clean "✓" row.
  if (results.length === 0) {
    results.push({ name: 'No legacy frontmatter in agents/*/AGENTS.md', status: 'pass' });
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

export async function doctorCommand(options?: {
  fix?: boolean;
  observability?: boolean;
  json?: boolean;
}): Promise<void> {
  if (options?.fix) {
    await doctorFix();
    return;
  }

  if (options?.observability) {
    const report = await collectObservabilityHealth();
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log();
      console.log('\x1b[1mObservability Health\x1b[0m');
      console.log(`\x1b[2m${'\u2500'.repeat(40)}\x1b[0m`);
      console.log(`  partition_health:  ${report.partition_health}`);
      console.log(`  partition_count:   ${report.partition_count}`);
      console.log(`  next_rotation_at:  ${report.next_rotation_at ?? 'n/a'}`);
      console.log(`  oldest_partition:  ${report.oldest_partition ?? 'n/a'}`);
      console.log(`  newest_partition:  ${report.newest_partition ?? 'n/a'}`);
      console.log(`  GENIE_WIDE_EMIT:   ${report.wide_emit_flag}`);
      if (report.message) console.log(`  note:              ${report.message}`);
      console.log();
    }
    if (report.partition_health === 'fail') process.exit(1);
    return;
  }

  console.log();
  console.log('\x1b[1mGenie Doctor\x1b[0m');
  console.log(`\x1b[2m${'\u2500'.repeat(40)}\x1b[0m`);

  const counts = { errors: false, warnings: false };

  runCheckSection('Prerequisites', await checkPrerequisites(), counts);
  runCheckSection('Installer Resolution', await collectInstallerResolution(), counts);
  runCheckSection('Configuration', await checkConfiguration(), counts);
  runCheckSection('Tmux', await checkTmux(), counts);
  runCheckSection('Worker Profiles', await checkWorkerProfiles(), counts);
  runCheckSection('Omni Bridge', await checkBridge(), counts);
  runCheckSection('Agent Config', checkLegacyAgentFrontmatter(), counts);

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
