/**
 * Daemon commands — CLI interface for scheduler daemon lifecycle management.
 *
 * Commands:
 *   genie daemon install  — generate systemd service unit, enable
 *   genie daemon start    — start scheduler daemon (background or foreground)
 *   genie daemon stop     — stop scheduler daemon gracefully
 *   genie daemon status   — show daemon state, PID, uptime, stats
 *   genie daemon logs     — tail structured JSON log
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';

// ============================================================================
// Paths
// ============================================================================

function genieHome(): string {
  return process.env.GENIE_HOME ?? join(homedir(), '.genie');
}

function pidFilePath(): string {
  return join(genieHome(), 'scheduler.pid');
}

function logFilePath(): string {
  return join(genieHome(), 'logs', 'scheduler.log');
}

function systemdDir(): string {
  return join(homedir(), '.config', 'systemd', 'user');
}

function systemdUnitPath(): string {
  return join(systemdDir(), 'genie-scheduler.service');
}

// ============================================================================
// PID file helpers
// ============================================================================

/** Read the stored PID. Returns null if no PID file or process not running. */
export function readPid(): number | null {
  const path = pidFilePath();
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf-8').trim();
  const pid = Number.parseInt(raw, 10);
  if (Number.isNaN(pid) || pid <= 0) return null;
  return pid;
}

/** Write the current PID to the PID file. */
export function writePid(pid: number): void {
  const dir = genieHome();
  mkdirSync(dir, { recursive: true });
  writeFileSync(pidFilePath(), String(pid), 'utf-8');
}

/** Remove the PID file. */
export function removePid(): void {
  const path = pidFilePath();
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {}
  }
}

/** Check if a process with the given PID is alive. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// systemd unit template
// ============================================================================

/** Generate a systemd user service unit file for the scheduler. */
export function generateSystemdUnit(): string {
  const genieBin = process.argv[1] ?? 'genie';
  const bunPath = process.execPath ?? 'bun';

  return `[Unit]
Description=Genie Scheduler Daemon
Documentation=https://github.com/automagik/genie
After=network.target

[Service]
Type=simple
ExecStart=${bunPath} ${genieBin} daemon start --foreground
Restart=on-failure
RestartSec=5
Environment=GENIE_HOME=${genieHome()}
WorkingDirectory=${homedir()}

# Logging handled by the daemon itself (structured JSON)
StandardOutput=journal
StandardError=journal
SyslogIdentifier=genie-scheduler

[Install]
WantedBy=default.target
`;
}

// ============================================================================
// Commands
// ============================================================================

interface StartOptions {
  foreground?: boolean;
}

interface LogsOptions {
  follow?: boolean;
  lines?: number;
}

/**
 * `genie daemon install` — generate systemd service and enable it.
 */
async function daemonInstallCommand(): Promise<void> {
  const unitContent = generateSystemdUnit();
  const unitPath = systemdUnitPath();

  mkdirSync(systemdDir(), { recursive: true });
  writeFileSync(unitPath, unitContent, 'utf-8');
  console.log(`Wrote systemd unit: ${unitPath}`);

  // Try to enable the service
  const { spawnSync } = await import('node:child_process');

  const reloadResult = spawnSync('systemctl', ['--user', 'daemon-reload'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (reloadResult.status !== 0) {
    const stderr = reloadResult.stderr?.toString().trim();
    console.log('\nNote: systemctl daemon-reload failed (systemd may not be available).');
    if (stderr) console.log(`  ${stderr}`);
    console.log('You can still run the daemon manually: genie daemon start --foreground');
    return;
  }

  const enableResult = spawnSync('systemctl', ['--user', 'enable', 'genie-scheduler.service'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (enableResult.status === 0) {
    console.log('Enabled genie-scheduler.service');
    console.log('\nTo start: systemctl --user start genie-scheduler');
    console.log('Or:       genie daemon start');
  } else {
    const stderr = enableResult.stderr?.toString().trim();
    console.log('\nNote: systemctl enable failed.');
    if (stderr) console.log(`  ${stderr}`);
    console.log('You can start manually: genie daemon start');
  }
}

/**
 * `genie daemon start [--foreground]` — start the scheduler daemon.
 */
async function daemonStartCommand(options: StartOptions): Promise<void> {
  // Check if already running
  const existingPid = readPid();
  if (existingPid && isProcessAlive(existingPid)) {
    console.log(`Scheduler daemon already running (PID ${existingPid})`);
    process.exit(0);
  }

  // Clean up stale PID file
  if (existingPid) {
    removePid();
  }

  if (options.foreground) {
    await runForeground();
  } else {
    await runBackground();
  }
}

/** Run the scheduler in the current process (foreground mode, for systemd). */
async function runForeground(): Promise<void> {
  const { startDaemon } = await import('../lib/scheduler-daemon.js');

  writePid(process.pid);
  console.log(`Scheduler daemon starting (PID ${process.pid}, foreground)`);

  const handle = startDaemon();

  const shutdown = () => {
    console.log('Shutting down scheduler daemon...');
    handle.stop();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await handle.done;
  removePid();
  console.log('Scheduler daemon stopped.');
}

/** Spawn the scheduler as a detached background process. */
async function runBackground(): Promise<void> {
  const { spawn } = await import('node:child_process');
  const genieBin = process.argv[1] ?? 'genie';
  const bunPath = process.execPath ?? 'bun';

  const child = spawn(bunPath, [genieBin, 'daemon', 'start', '--foreground'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });

  child.unref();

  if (child.pid) {
    // Wait briefly for the process to start and write its PID
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Verify it's still alive
    if (isProcessAlive(child.pid)) {
      console.log(`Scheduler daemon started (PID ${child.pid})`);
      console.log(`  Log: ${logFilePath()}`);
    } else {
      console.error('Error: daemon process exited immediately. Check logs:');
      console.error(`  ${logFilePath()}`);
      process.exit(1);
    }
  } else {
    console.error('Error: failed to spawn daemon process');
    process.exit(1);
  }
}

/**
 * `genie daemon stop` — stop the scheduler daemon gracefully.
 */
async function daemonStopCommand(): Promise<void> {
  const pid = readPid();

  if (!pid) {
    console.log('No scheduler daemon PID file found. Daemon is not running.');
    return;
  }

  if (!isProcessAlive(pid)) {
    console.log(`Stale PID file (PID ${pid} is not running). Cleaning up.`);
    removePid();
    return;
  }

  console.log(`Stopping scheduler daemon (PID ${pid})...`);
  process.kill(pid, 'SIGTERM');

  // Wait up to 10s for graceful shutdown
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (isProcessAlive(pid)) {
    console.log('Daemon did not stop within 10s. Sending SIGKILL.');
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }

  removePid();
  console.log('Scheduler daemon stopped.');
}

/** Try to read process uptime from /proc. Returns formatted string or null. */
function getProcessUptime(pid: number): string | null {
  try {
    const procStat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const bootTimeJiffies = Number.parseInt(procStat.split(' ')[21], 10);
    if (Number.isNaN(bootTimeJiffies)) return null;

    const uptimeSec = readFileSync('/proc/uptime', 'utf-8');
    const systemUptimeS = Number.parseFloat(uptimeSec.split(' ')[0]);
    const hz = 100; // Standard jiffies/sec on Linux
    const processUptimeS = systemUptimeS - bootTimeJiffies / hz;
    return processUptimeS > 0 ? formatUptime(processUptimeS * 1000) : null;
  } catch {
    return null; // /proc not available (macOS, Docker)
  }
}

/** Fetch trigger stats from the database and print them. */
async function printDaemonStats(): Promise<void> {
  try {
    const { getConnection, shutdown } = await import('../lib/db.js');
    const sql = await getConnection();

    const firedResult = await sql`
      SELECT count(*)::int AS cnt FROM triggers WHERE status IN ('executing', 'completed')
    `;
    console.log(`  Fired:    ${firedResult[0]?.cnt ?? 0} trigger(s)`);

    const pendingResult = await sql`
      SELECT count(*)::int AS cnt FROM triggers WHERE status = 'pending'
    `;
    console.log(`  Pending:  ${pendingResult[0]?.cnt ?? 0} trigger(s)`);

    const failedResult = await sql`
      SELECT count(*)::int AS cnt FROM triggers WHERE status = 'failed'
    `;
    const failedCount = failedResult[0]?.cnt ?? 0;
    if (failedCount > 0) {
      console.log(`  Failed:   ${failedCount} trigger(s)`);
    }

    const lastError = await sql`
      SELECT error, completed_at FROM runs
      WHERE status = 'failed' AND error IS NOT NULL
      ORDER BY completed_at DESC
      LIMIT 1
    `;
    if (lastError.length > 0 && lastError[0].error) {
      console.log(`  Last err: ${lastError[0].error.slice(0, 80)}`);
    }

    await shutdown();
  } catch {
    console.log('  (database not available — stats unavailable)');
  }
}

/**
 * `genie daemon status` — show daemon state and stats.
 */
async function daemonStatusCommand(): Promise<void> {
  const pid = readPid();
  const running = pid !== null && isProcessAlive(pid);

  console.log('\nGenie Scheduler Daemon');
  console.log('─'.repeat(50));
  console.log(`  Status:   ${running ? 'running' : 'stopped'}`);

  if (running && pid) {
    console.log(`  PID:      ${pid}`);
    const uptime = getProcessUptime(pid);
    if (uptime) console.log(`  Uptime:   ${uptime}`);
  }

  await printDaemonStats();

  console.log(`  PID file: ${pidFilePath()}`);
  console.log(`  Log file: ${logFilePath()}`);
  console.log('');
}

/**
 * `genie daemon logs [--follow] [--lines N]` — tail scheduler log.
 */
async function daemonLogsCommand(options: LogsOptions): Promise<void> {
  const logPath = logFilePath();

  if (!existsSync(logPath)) {
    console.log('No scheduler log file found. Start the daemon first.');
    console.log(`  Expected: ${logPath}`);
    return;
  }

  const linesToShow = options.lines ?? 20;

  if (options.follow) {
    await tailFollow(logPath, linesToShow);
  } else {
    tailStatic(logPath, linesToShow);
  }
}

/** Read last N lines from a file. */
function tailStatic(filePath: string, lines: number): void {
  const content = readFileSync(filePath, 'utf-8');
  const allLines = content.trim().split('\n').filter(Boolean);
  const start = Math.max(0, allLines.length - lines);
  const slice = allLines.slice(start);

  for (const line of slice) {
    printLogLine(line);
  }

  if (allLines.length > lines) {
    console.log(`\n(showing last ${lines} of ${allLines.length} entries)`);
  }
}

/** Follow a log file, printing new lines as they appear. */
async function tailFollow(filePath: string, initialLines: number): Promise<void> {
  const { watch } = await import('node:fs');

  // Show initial lines
  tailStatic(filePath, initialLines);
  console.log('\n--- following (Ctrl+C to exit) ---\n');

  let lastSize = existsSync(filePath) ? readFileSync(filePath).length : 0;

  const watcher = watch(filePath, () => {
    try {
      const content = readFileSync(filePath, 'utf-8');
      if (content.length > lastSize) {
        const newContent = content.slice(lastSize);
        const newLines = newContent.trim().split('\n').filter(Boolean);
        for (const line of newLines) {
          printLogLine(line);
        }
        lastSize = content.length;
      }
    } catch {}
  });

  // Handle graceful exit
  process.on('SIGINT', () => {
    watcher.close();
    process.exit(0);
  });

  // Keep process alive
  await new Promise(() => {});
}

/** Print a single log line with minimal formatting. */
function printLogLine(raw: string): void {
  try {
    const entry = JSON.parse(raw);
    const ts = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false }) : '??:??:??';
    const level = (entry.level ?? 'info').toUpperCase().padEnd(5);
    const event = entry.event ?? 'unknown';

    // Collect extra fields
    const extras = Object.entries(entry)
      .filter(([k]) => !['timestamp', 'level', 'event'].includes(k))
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(' ');

    console.log(`${ts} ${level} ${event}${extras ? ` ${extras}` : ''}`);
  } catch {
    // Not valid JSON — print raw
    console.log(raw);
  }
}

/** Format milliseconds into human-readable uptime. */
function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

// ============================================================================
// Registration
// ============================================================================

export function registerDaemonCommands(program: Command): void {
  const daemon = program.command('daemon').description('Manage scheduler daemon lifecycle');

  daemon
    .command('install')
    .description('Generate systemd service unit and enable it')
    .action(async () => {
      await daemonInstallCommand();
    });

  daemon
    .command('start')
    .description('Start the scheduler daemon')
    .option('--foreground', 'Run in foreground (for systemd ExecStart)')
    .action(async (options: StartOptions) => {
      await daemonStartCommand(options);
    });

  daemon
    .command('stop')
    .description('Stop the scheduler daemon gracefully')
    .action(async () => {
      await daemonStopCommand();
    });

  daemon
    .command('status')
    .description('Show daemon state, PID, uptime, and trigger stats')
    .action(async () => {
      await daemonStatusCommand();
    });

  daemon
    .command('logs')
    .description('Tail structured JSON scheduler log')
    .option('--follow, -f', 'Follow log output')
    .option('--lines <n>', 'Number of lines to show (default: 20)', Number.parseInt)
    .action(async (options: LogsOptions) => {
      await daemonLogsCommand(options);
    });
}
