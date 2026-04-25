/**
 * Genie Doctor Command
 *
 * Diagnostic tool to check the health of the genie installation.
 * Checks prerequisites, configuration, and tmux connectivity.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { $ } from 'bun';
import type { BridgeStatusResult, PingOptions } from '../lib/bridge-status.js';
import { contractClaudePath, getClaudeSettingsPath } from '../lib/claude-settings.js';
import { tmuxBin } from '../lib/ensure-tmux.js';
import { genieConfigExists, getGenieConfigPath, isSetupComplete, loadGenieConfig } from '../lib/genie-config.js';
import { checkCommand } from '../lib/system-detect.js';
import { findWorkspace } from '../lib/workspace.js';
import {
  GENIE_AGENTS_TEMPLATE,
  GENIE_HEARTBEAT_TEMPLATE,
  GENIE_SOUL_TEMPLATE,
  STALE_GENIE_AGENTS_MD_MARKER,
  STALE_GENIE_AGENT_YAML_MISSING_MODEL_REGEX,
} from '../templates/index.js';
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
 * Detect workspaces scaffolded before the GENIE_AGENTS_TEMPLATE branch
 * landed. Their `agents/genie/AGENTS.md` still carries the generic
 * placeholder template (gray TUI, no model resolution); upgrading the
 * package never re-runs scaffold, so the file persists. See #1374.
 *
 * Two independent symptoms — either is enough to flag:
 *   1. AGENTS.md contains the generic-template marker phrase.
 *   2. agent.yaml is missing a `model:` field.
 *
 * Exported so the `--fix` path and unit tests can share the detection.
 */
export function checkGenieAgentTemplate(workspaceRoot?: string): CheckResult[] {
  const root = workspaceRoot ?? findWorkspace()?.root;
  if (!root) return [];

  const genieDir = join(root, 'agents', 'genie');
  if (!existsSync(genieDir)) return [];

  const agentsMd = join(genieDir, 'AGENTS.md');
  const agentYaml = join(genieDir, 'agent.yaml');

  const issues: string[] = [];
  if (existsSync(agentsMd)) {
    try {
      const text = readFileSync(agentsMd, 'utf-8');
      if (text.includes(STALE_GENIE_AGENTS_MD_MARKER)) {
        issues.push('AGENTS.md uses generic placeholder template');
      }
    } catch {
      // unreadable — skip silently; another check will surface IO problems
    }
  }
  if (existsSync(agentYaml)) {
    try {
      const text = readFileSync(agentYaml, 'utf-8');
      if (!STALE_GENIE_AGENT_YAML_MISSING_MODEL_REGEX.test(text)) {
        issues.push('agent.yaml missing model field (TUI falls back to gray)');
      }
    } catch {
      // unreadable — skip silently
    }
  }

  if (issues.length === 0) {
    return [{ name: 'agents/genie scaffold up to date', status: 'pass' }];
  }
  return [
    {
      name: 'agents/genie stale scaffold',
      status: 'warn',
      message: issues.join('; '),
      suggestion: 'Run: genie doctor --fix (re-emits genie specialist templates, preserves user edits)',
    },
  ];
}

/**
 * Locate the bundled `scripts/tmux/*.conf` directory shipped with this
 * version of @automagik/genie. The path differs between the dev tree
 * (workspace), the global bun install, and the npm install (under dist/),
 * so we walk up from this module's URL to find a `scripts/tmux/` sibling.
 *
 * Returns null if the bundled configs can't be found — in which case the
 * tmux-config staleness check is skipped (we can't compute a diff target).
 */
export function findBundledTmuxConfigDir(): string | null {
  try {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    // Walk up: src/genie-commands/ → src/ → repo-root, then look for scripts/tmux
    for (let i = 0; i < 6; i += 1) {
      const candidate = resolve(moduleDir, '../'.repeat(i + 1), 'scripts', 'tmux');
      if (existsSync(join(candidate, 'tui-tmux.conf')) && existsSync(join(candidate, 'genie.tmux.conf'))) {
        return candidate;
      }
    }
  } catch {
    // import.meta.url unavailable (CJS); fall through
  }
  return null;
}

/**
 * Detect stale `~/.genie/{tui-tmux,tmux}.conf` files. The `MouseDown3*`
 * unbinds for tmux 3.3+ context menus shipped in #1153 — workspaces from
 * before that fix carry conf files that allow right-click to corrupt the
 * TUI render. Same fix-on-upgrade gap as #1374: postinstall-tmux only
 * copies on first install.
 *
 * Strategy: read the bundled scripts/tmux/*.conf and check that ~/.genie
 * counterparts contain the same MouseDown3 unbind block. Difference =>
 * stale. (Full byte-equality is too strict — users may have local edits.)
 */
export function checkTmuxConfigs(): CheckResult[] {
  const bundledDir = findBundledTmuxConfigDir();
  if (!bundledDir) {
    return [{ name: 'tmux configs', status: 'pass', message: 'bundled configs unavailable (skipped)' }];
  }

  const home = join(homedir(), '.genie');
  const stale: string[] = [];
  const expectedSnippet = 'unbind -n MouseDown3Pane';

  for (const file of ['tui-tmux.conf', 'tmux.conf']) {
    const installedPath = join(home, file);
    if (!existsSync(installedPath)) continue;
    try {
      const installed = readFileSync(installedPath, 'utf-8');
      if (!installed.includes(expectedSnippet)) {
        stale.push(file);
      }
    } catch {
      // unreadable — surface as stale to be safe
      stale.push(file);
    }
  }

  if (stale.length === 0) {
    return [{ name: '~/.genie tmux configs up to date', status: 'pass' }];
  }
  return [
    {
      name: '~/.genie tmux configs stale',
      status: 'warn',
      message: `missing right-click unbind in: ${stale.join(', ')}`,
      suggestion: 'Run: genie doctor --fix (refreshes ~/.genie tmux configs from bundled scripts/tmux/)',
    },
  ];
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
function isAgentDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function hasLegacyFrontmatter(agentDir: string): boolean {
  const yamlPath = join(agentDir, 'agent.yaml');
  const agentsMdPath = join(agentDir, 'AGENTS.md');
  if (!existsSync(yamlPath) || !existsSync(agentsMdPath)) return false;
  try {
    return readFileSync(agentsMdPath, 'utf-8').slice(0, 4).startsWith('---');
  } catch {
    return false;
  }
}

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
    if (!isAgentDirectory(agentDir)) continue;
    if (!hasLegacyFrontmatter(agentDir)) continue;

    results.push({
      name: `agents/${name}/AGENTS.md`,
      status: 'warn',
      message: 'legacy frontmatter detected (ignored by sync)',
      suggestion: `Move config into agents/${name}/agent.yaml — AGENTS.md is prompt-only post-migration.`,
    });
  }

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
    await runObservabilityCheck(Boolean(options.json));
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
  runCheckSection('Tmux Configs', checkTmuxConfigs(), counts);
  runCheckSection('Worker Profiles', await checkWorkerProfiles(), counts);
  runCheckSection('Omni Bridge', await checkBridge(), counts);
  runCheckSection('Agent Config', checkLegacyAgentFrontmatter(), counts);
  runCheckSection('Genie Specialist', checkGenieAgentTemplate(), counts);

  printDoctorSummary(counts);
  if (counts.errors) process.exit(1);
}

function printObservabilityReport(report: Awaited<ReturnType<typeof collectObservabilityHealth>>): void {
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

async function runObservabilityCheck(json: boolean): Promise<void> {
  const report = await collectObservabilityHealth();
  if (json) console.log(JSON.stringify(report, null, 2));
  else printObservabilityReport(report);
  if (report.partition_health === 'fail') process.exit(1);
}

function printDoctorSummary(counts: { errors: boolean; warnings: boolean }): void {
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
    // Linux ipcs -m columns: key shmid owner perms bytes nattch status
    //   \u2192 `$6 == 0` filter removes only segments with no attached processes.
    // Darwin (macOS) ipcs -m columns: T ID KEY MODE OWNER GROUP
    //   \u2192 no nattch column. We blind-call ipcrm on every segment owned by
    //   the current uid and let the kernel reject in-use ones with EBUSY.
    //   Real PostgreSQL 18 (pgserve 1.2.0+) needs SysV shmem; without this
    //   path, leaked segments accumulate to SHMMNI=32 and pgserve startup
    //   fails with "could not create shared memory segment: No space left
    //   on device" \u2014 surfacing as the #1335 / #1273 test flake.
    if (process.platform === 'darwin') {
      execSync(`ipcs -m 2>/dev/null | awk '/^m/ {print $2}' | xargs -I{} ipcrm -m {} 2>/dev/null || true`, {
        stdio: 'ignore',
        timeout: 5000,
      });
    } else {
      execSync(`ipcs -m 2>/dev/null | awk '$6 == 0 {print $2}' | xargs -I{} ipcrm -m {} 2>/dev/null || true`, {
        stdio: 'ignore',
        timeout: 5000,
      });
    }
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

/**
 * User-edited heuristic for AGENTS.md: existing file is non-empty AND does
 * NOT contain the stale generic-template marker. The marker only appears in
 * the pre-#1374 generic AGENTS_TEMPLATE; absence of it implies the user has
 * customized the file. Conservative on purpose \u2014 better to write `.new`
 * than overwrite real edits.
 *
 * SOUL.md and HEARTBEAT.md don't carry a useful marker, so we always
 * overwrite them \u2014 the genie specialist soul/heartbeat are framework code
 * (command listings, pipeline definitions) that users should not be editing.
 */
function isAgentsMdUserEdited(target: string, fresh: string): boolean {
  if (!existsSync(target)) return false;
  try {
    const current = readFileSync(target, 'utf-8');
    if (current.trim().length === 0) return false;
    if (current.includes(STALE_GENIE_AGENTS_MD_MARKER)) return false;
    return current !== fresh;
  } catch {
    return false;
  }
}

function writeGenieTemplate(targetDir: string, name: string, content: string): void {
  const target = join(targetDir, name);
  const userEdited = name === 'AGENTS.md' && isAgentsMdUserEdited(target, content);
  const writeTo = userEdited ? `${target}.new` : target;
  try {
    writeFileSync(writeTo, content);
    const marker = userEdited ? `wrote ${name}.new (user edits preserved \u2014 merge manually)` : `wrote ${name}`;
    console.log(`  \x1b[32m\u2713\x1b[0m ${marker}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.log(`  \x1b[31m\u2717\x1b[0m ${name}: ${detail}`);
  }
}

/**
 * Re-emit the genie specialist templates for workspaces flagged by
 * checkGenieAgentTemplate. Preserves user edits to AGENTS.md by writing to
 * `AGENTS.md.new` when the file looks customized; otherwise overwrites in
 * place. See #1374.
 */
function fixGenieAgentTemplate(workspaceRoot?: string): void {
  const root = workspaceRoot ?? findWorkspace()?.root;
  if (!root) {
    console.log('  \x1b[33m!\x1b[0m No workspace detected \u2014 skipping genie-template repair');
    return;
  }
  const genieDir = join(root, 'agents', 'genie');
  if (!existsSync(genieDir)) {
    console.log('  \x1b[2m\u00b7\x1b[0m No agents/genie directory \u2014 skipping');
    return;
  }
  console.log('  Refreshing agents/genie scaffold...');
  writeGenieTemplate(genieDir, 'AGENTS.md', GENIE_AGENTS_TEMPLATE);
  writeGenieTemplate(genieDir, 'SOUL.md', GENIE_SOUL_TEMPLATE);
  writeGenieTemplate(genieDir, 'HEARTBEAT.md', GENIE_HEARTBEAT_TEMPLATE);
}

function ensureGenieHomeDir(home: string): boolean {
  if (existsSync(home)) return true;
  try {
    mkdirSync(home, { recursive: true });
    return true;
  } catch {
    console.log(`  \x1b[31m\u2717\x1b[0m Could not create ${home}`);
    return false;
  }
}

function refreshTmuxConfFile(bundledDir: string, home: string, file: string): void {
  const src = join(bundledDir, file);
  const dst = join(home, file);
  if (!existsSync(src)) return;
  if (existsSync(dst)) {
    try {
      copyFileSync(dst, `${dst}.bak`);
    } catch {
      // best-effort backup
    }
  }
  try {
    copyFileSync(src, dst);
    console.log(`  \x1b[32m\u2713\x1b[0m wrote ${file} (previous saved as ${file}.bak)`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.log(`  \x1b[31m\u2717\x1b[0m ${file}: ${detail}`);
  }
}

/**
 * Refresh `~/.genie/{tui-tmux,tmux}.conf` from the bundled scripts/tmux
 * versions. Backs up the existing file to `<name>.bak` before overwriting
 * so users can recover any local edits. See #1153 + this PR's audit.
 */
function fixTmuxConfigs(): void {
  const bundledDir = findBundledTmuxConfigDir();
  if (!bundledDir) {
    console.log('  \x1b[33m!\x1b[0m Bundled tmux configs not found \u2014 skipping');
    return;
  }
  const home = join(homedir(), '.genie');
  if (!ensureGenieHomeDir(home)) return;
  console.log('  Refreshing ~/.genie tmux configs...');
  refreshTmuxConfFile(bundledDir, home, 'tui-tmux.conf');
  refreshTmuxConfFile(bundledDir, home, 'tmux.conf');
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

  // macOS-hardening repairs (#1374, #1390 companion). Both are workspace/host
  // state, not daemon state, so they run independent of the postgres path.
  fixGenieAgentTemplate();
  fixTmuxConfigs();

  await restartDaemon();

  console.log(`\n\x1b[2m${'\u2500'.repeat(40)}\x1b[0m`);
  console.log('\x1b[32mFix complete.\x1b[0m Run \x1b[36mgenie doctor\x1b[0m to verify.\n');
}
