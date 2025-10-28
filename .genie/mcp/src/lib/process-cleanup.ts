/**
 * MCP Server Process Cleanup Utility
 *
 * Detects and kills stale MCP server processes to prevent proliferation.
 * Used by CLI before starting new MCP server instance.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

export interface ProcessInfo {
  pid: number;
  ppid: number;
  cmd: string;
  age: string;
}

/**
 * Find all running MCP server processes
 */
export function findMcpServerProcesses(): ProcessInfo[] {
  try {
    // Use ps to find all node processes running server.js
    const output = execSync(
      'ps aux | grep -E "node.*mcp.*server\\.js" | grep -v grep',
      { encoding: 'utf-8' }
    ).trim();

    if (!output) {
      return [];
    }

    const lines = output.split('\n');
    const processes: ProcessInfo[] = [];

    for (const line of lines) {
      // Parse ps output: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
      const parts = line.trim().split(/\s+/);
      if (parts.length < 11) continue;

      const pid = parseInt(parts[1], 10);
      const ppid = parseInt(parts[2], 10);
      const start = parts[8];
      const cmd = parts.slice(10).join(' ');

      if (isNaN(pid)) continue;

      processes.push({
        pid,
        ppid,
        cmd,
        age: start
      });
    }

    return processes;
  } catch (error) {
    // No processes found or ps command failed
    return [];
  }
}

/**
 * Check if a process is still alive
 */
export function isProcessAlive(pid: number): boolean {
  try {
    // Send signal 0 (no-op) to check if process exists
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill a process gracefully (SIGTERM first, then SIGKILL if needed)
 */
export async function killProcess(pid: number, timeout = 5000): Promise<boolean> {
  if (!isProcessAlive(pid)) {
    return true; // Already dead
  }

  try {
    // Try SIGTERM first (graceful)
    process.kill(pid, 'SIGTERM');

    // Wait for process to exit
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (!isProcessAlive(pid)) {
        return true; // Exited gracefully
      }
    }

    // If still alive, force kill
    if (isProcessAlive(pid)) {
      process.kill(pid, 'SIGKILL');
      await new Promise(resolve => setTimeout(resolve, 500));
      return !isProcessAlive(pid);
    }

    return true;
  } catch (error) {
    // Process might have already exited or we don't have permission
    return !isProcessAlive(pid);
  }
}

/**
 * Detect orphaned MCP servers (parent process died)
 */
export function findOrphanedServers(processes: ProcessInfo[]): ProcessInfo[] {
  return processes.filter(proc => {
    // Never mark the current process as orphaned
    if (proc.pid === process.pid) {
      return false;
    }

    // Check if parent process is still alive
    if (proc.ppid === 1) {
      // Reparented to init (parent died)
      return true;
    }
    return !isProcessAlive(proc.ppid);
  });
}

/**
 * Cleanup stale MCP server processes
 */
export async function cleanupStaleMcpServers(options: {
  killOrphans?: boolean;
  maxAge?: number;
  dryRun?: boolean;
} = {}): Promise<{
  found: number;
  orphans: number;
  killed: number;
  failed: number;
}> {
  const {
    killOrphans = true,
    maxAge = 24 * 60 * 60 * 1000, // 24 hours
    dryRun = false
  } = options;

  const processes = findMcpServerProcesses();
  const orphans = findOrphanedServers(processes);

  const result = {
    found: processes.length,
    orphans: orphans.length,
    killed: 0,
    failed: 0
  };

  if (!killOrphans || dryRun) {
    return result;
  }

  // Kill orphaned processes
  for (const proc of orphans) {
    const success = await killProcess(proc.pid);
    if (success) {
      result.killed++;
    } else {
      result.failed++;
    }
  }

  return result;
}

/**
 * Create PID file for current server instance
 */
export function writePidFile(workspaceRoot: string): void {
  const pidDir = path.join(workspaceRoot, '.genie', 'state');
  const pidFile = path.join(pidDir, 'mcp-server.pid');

  try {
    // Ensure directory exists
    if (!fs.existsSync(pidDir)) {
      fs.mkdirSync(pidDir, { recursive: true });
    }

    // Write PID
    fs.writeFileSync(pidFile, process.pid.toString(), 'utf-8');

    // Cleanup on exit
    process.on('exit', () => {
      try {
        if (fs.existsSync(pidFile)) {
          const storedPid = parseInt(fs.readFileSync(pidFile, 'utf-8'), 10);
          if (storedPid === process.pid) {
            fs.unlinkSync(pidFile);
          }
        }
      } catch {
        // Ignore cleanup errors
      }
    });
  } catch (error) {
    // Non-fatal, continue without PID file
  }
}

/**
 * Check if another MCP server is already running for this workspace
 */
export function isServerAlreadyRunning(workspaceRoot: string): { running: boolean; pid?: number } {
  const pidFile = path.join(workspaceRoot, '.genie', 'state', 'mcp-server.pid');

  if (!fs.existsSync(pidFile)) {
    return { running: false };
  }

  try {
    const pidStr = fs.readFileSync(pidFile, 'utf-8').trim();
    const pid = parseInt(pidStr, 10);

    if (isNaN(pid)) {
      // Invalid PID file, clean it up
      fs.unlinkSync(pidFile);
      return { running: false };
    }

    if (isProcessAlive(pid)) {
      return { running: true, pid };
    } else {
      // Stale PID file, clean it up
      fs.unlinkSync(pidFile);
      return { running: false };
    }
  } catch {
    return { running: false };
  }
}
