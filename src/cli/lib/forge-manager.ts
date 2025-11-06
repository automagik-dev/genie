import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

// @ts-ignore - compiled client shipped at project root
import { ForgeClient } from '../../../src/lib/forge-client.js';

export interface ForgeStartOptions {
  baseUrl?: string;
  token?: string;
  logDir: string;
}

export interface ForgeProcess {
  pid: number;
  startTime: number;
  binPath: string;
}

export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

const DEFAULT_BASE_URL = process.env.FORGE_BASE_URL || 'http://localhost:8887';
const HEALTH_CHECK_TIMEOUT = 3000; // 3s per health check
const MAX_HEALTH_RETRIES = 3;

// Track Forge child process for graceful shutdown
let forgeChildProcess: ChildProcess | null = null;

/**
 * Health check with retry logic and exponential backoff
 */
export async function isForgeRunning(
  baseUrl: string = DEFAULT_BASE_URL,
  retries = MAX_HEALTH_RETRIES
): Promise<boolean> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const client = new ForgeClient(baseUrl, process.env.FORGE_TOKEN);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT);

      const ok = await client.healthCheck();
      clearTimeout(timeout);

      if (ok) return true;
    } catch (error) {
      // Exponential backoff: 100ms, 200ms, 400ms
      if (attempt < retries - 1) {
        await new Promise(r => setTimeout(r, 100 * Math.pow(2, attempt)));
      }
    }
  }
  return false;
}

/**
 * Wait for Forge to become ready with progress indication
 */
export async function waitForForgeReady(
  baseUrl: string = DEFAULT_BASE_URL,
  timeoutMs = 60000,
  intervalMs = 500,
  showProgress = false
): Promise<boolean> {
  const start = Date.now();
  let lastDot = 0;
  let consecutiveFailures = 0;

  while (Date.now() - start < timeoutMs) {
    const isRunning = await isForgeRunning(baseUrl, 1); // Single attempt per poll

    if (isRunning) {
      if (showProgress) process.stderr.write('\n');
      return true;
    }

    consecutiveFailures++;

    // Show progress dots every 2 seconds
    if (showProgress && Date.now() - lastDot > 2000) {
      process.stderr.write('.');
      lastDot = Date.now();
    }

    await new Promise(r => setTimeout(r, intervalMs));
  }

  if (showProgress) process.stderr.write('\n');
  return false;
}

/**
 * Resolve automagik-forge binary path
 *
 * With bundledDependencies, Forge is always included in the genie package.
 * Node.js module resolution automatically finds it in node_modules.
 */
function resolveForgeBinary(): Result<string> {
  try {
    // require.resolve() uses Node.js module resolution algorithm
    // Works with all package managers (npm, pnpm, yarn, bun)
    const forgePath = require.resolve('automagik-forge/bin/cli.js');
    return { ok: true, value: forgePath };
  } catch (error) {
    return {
      ok: false,
      error: new Error(
        'automagik-forge not found (bundled dependency missing). ' +
        'This should not happen - please reinstall: npm install -g automagik-genie@latest'
      )
    };
  }
}

/**
 * Parse port from URL with fallback
 */
function parsePort(baseUrl: string): string {
  try {
    return new URL(baseUrl).port || '8887';
  } catch {
    return '8887';
  }
}

/**
 * Start Forge in background with comprehensive error handling
 */
export function startForgeInBackground(opts: ForgeStartOptions): Result<ForgeProcess> {
  const baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
  const logDir = opts.logDir;

  // Ensure log directory exists
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      error: new Error(`Failed to create log directory: ${error}`)
    };
  }

  const logPath = path.join(logDir, 'forge.log');
  const pidPath = path.join(logDir, 'forge.pid');

  // Resolve binary path
  const binaryResult = resolveForgeBinary();
  if (!binaryResult.ok) {
    const error = 'error' in binaryResult ? binaryResult.error : new Error('Unknown error');
    return { ok: false, error };
  }

  const binPath = binaryResult.value;
  const port = parsePort(baseUrl);

  // Open log files (will be inherited by child)
  let logFd: number;
  try {
    logFd = fs.openSync(logPath, 'a');
  } catch (error) {
    return {
      ok: false,
      error: new Error(`Failed to open log file: ${error}`)
    };
  }

  // Spawn process with error handling
  let child: ChildProcess;
  try {
    child = spawn('node', [binPath], {
      env: {
        ...process.env,
        PORT: port,
        FORGE_PORT: port,
        BACKEND_PORT: port,
        HOST: '0.0.0.0'
      },
      detached: true,
      stdio: ['ignore', logFd, logFd]
    });
  } catch (error) {
    fs.closeSync(logFd);
    return {
      ok: false,
      error: new Error(`Failed to spawn Forge process: ${error}`)
    };
  }

  // Handle spawn errors
  child.on('error', (error) => {
    fs.appendFileSync(logPath, `\n[SPAWN ERROR] ${error}\n`);
  });

  // Handle early exit (crash during startup)
  child.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      fs.appendFileSync(
        logPath,
        `\n[EARLY EXIT] Process exited with code ${code}, signal ${signal}\n`
      );
    }
  });

  // Track child process for graceful shutdown
  forgeChildProcess = child;

  // Detach so it survives parent exit
  child.unref();

  // Close our handle to log file (child has inherited it)
  fs.closeSync(logFd);

  // Write PID file
  const pid = child.pid ?? -1;
  if (pid > 0) {
    try {
      fs.writeFileSync(pidPath, String(pid), 'utf8');
    } catch (error) {
      // Non-fatal: log but continue
      fs.appendFileSync(logPath, `\n[WARNING] Failed to write PID file: ${error}\n`);
    }
  }

  return {
    ok: true,
    value: {
      pid,
      startTime: Date.now(),
      binPath
    }
  };
}

/**
 * Check for running task attempts and return them with URLs
 */
export async function getRunningTasks(baseUrl: string = DEFAULT_BASE_URL): Promise<Array<{
  projectId: string;
  projectName: string;
  taskId: string;
  taskTitle: string;
  attemptId: string;
  url: string;
}>> {
  try {
    const client = new ForgeClient(baseUrl, process.env.FORGE_TOKEN);

    // Get all projects
    const projects = await client.listProjects();
    const runningTasks: Array<{
      projectId: string;
      projectName: string;
      taskId: string;
      taskTitle: string;
      attemptId: string;
      url: string;
    }> = [];

    // Check each project for running attempts
    for (const project of projects) {
      const tasks = await client.listTasks(project.id);

      for (const task of tasks) {
        // Check if task has running attempts
        const attempts = await client.listAttempts(project.id, task.id);
        const runningAttempts = attempts.filter((a: any) => a.status === 'running' || a.status === 'pending');

        for (const attempt of runningAttempts) {
          runningTasks.push({
            projectId: project.id,
            projectName: project.name || 'Unnamed Project',
            taskId: task.id,
            taskTitle: task.title || 'Untitled Task',
            attemptId: attempt.id,
            url: `${baseUrl}/projects/${project.id}/tasks/${task.id}/attempts/${attempt.id}`
          });
        }
      }
    }

    return runningTasks;
  } catch (error) {
    // If we can't check, return empty array (don't block shutdown)
    return [];
  }
}

/**
 * Kill Forge child process immediately (for Ctrl+C shutdown)
 * Sends SIGTERM to the entire process group
 */
export function killForgeProcess(): void {
  if (!forgeChildProcess || forgeChildProcess.killed) {
    return;
  }

  try {
    const pid = forgeChildProcess.pid;
    if (pid) {
      // Kill the entire process group (negative PID)
      // This ensures all child processes are terminated
      try {
        process.kill(-pid, 'SIGTERM');
      } catch (err) {
        // If process group kill fails, try killing the process directly
        forgeChildProcess.kill('SIGTERM');
      }
    }
  } catch (error) {
    // Ignore errors - process might already be dead
  } finally {
    forgeChildProcess = null;
  }
}

/**
 * Stop Forge process with verification
 */
export async function stopForge(logDir: string): Promise<boolean> {
  const pidPath = path.join(logDir, 'forge.pid');

  let pid: number;
  try {
    const pidStr = fs.readFileSync(pidPath, 'utf8').trim();
    pid = parseInt(pidStr, 10);

    if (Number.isNaN(pid) || pid <= 0) {
      return false;
    }
  } catch {
    return false;
  }

  // Send SIGTERM
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    // Process might already be dead
    return false;
  }

  // Wait for process to exit (max 5 seconds)
  for (let i = 0; i < 50; i++) {
    try {
      // Check if process still exists (throws if dead)
      process.kill(pid, 0);
      await new Promise(r => setTimeout(r, 100));
    } catch {
      // Process is dead
      try {
        fs.unlinkSync(pidPath);
      } catch {}
      return true;
    }
  }

  // Force kill if still alive
  try {
    process.kill(pid, 'SIGKILL');
    fs.unlinkSync(pidPath);
  } catch {}

  return true;
}

/**
 * Restart Forge with proper shutdown and startup
 */
export async function restartForge(opts: ForgeStartOptions): Promise<Result<ForgeProcess>> {
  const baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
  const logDir = opts.logDir;

  // Check if already running
  const wasRunning = await isForgeRunning(baseUrl);

  if (wasRunning) {
    const stopped = await stopForge(logDir);
    if (!stopped) {
      return {
        ok: false,
        error: new Error('Failed to stop existing Forge process')
      };
    }
    // Wait for port to be released
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Start new instance
  const startResult = startForgeInBackground(opts);
  if (!startResult.ok) {
    return startResult;
  }

  // Wait for ready
  const ready = await waitForForgeReady(baseUrl, 60000, 500);
  if (!ready) {
    return {
      ok: false,
      error: new Error('Forge did not become ready after restart')
    };
  }

  return startResult;
}

/**
 * Get Forge process info
 */
export function getForgeProcess(logDir: string): ForgeProcess | null {
  const pidPath = path.join(logDir, 'forge.pid');

  try {
    const pidStr = fs.readFileSync(pidPath, 'utf8').trim();
    const pid = parseInt(pidStr, 10);

    if (Number.isNaN(pid) || pid <= 0) {
      return null;
    }

    // Verify process is still running
    try {
      process.kill(pid, 0);
      return {
        pid,
        startTime: 0, // Unknown
        binPath: '' // Unknown
      };
    } catch {
      // Process is dead, clean up PID file
      fs.unlinkSync(pidPath);
      return null;
    }
  } catch {
    return null;
  }
}
