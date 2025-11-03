/**
 * CLI Utility Functions
 * Helper functions for CLI operations
 */

import fs from 'fs';
import { spawn } from 'child_process';
import path from 'path';

/**
 * Execute the legacy genie CLI
 */
export function execGenie(args: string[]): void {
  const genieScript = path.join(__dirname, '../genie.js');

  const child = spawn('node', [genieScript, ...args], {
    stdio: 'inherit',
    env: process.env
  });

  child.on('exit', (code) => {
    process.exit(code || 0);
  });
}

/**
 * Check if a port is in use and return process info
 */
export async function checkPortConflict(port: string): Promise<{ pid: string; command: string } | null> {
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileAsync = promisify(execFile);

  try {
    const { stdout } = await execFileAsync('lsof', ['-i', `:${port}`, '-t', '-sTCP:LISTEN']);
    const pid = stdout.trim().split('\n')[0];

    if (pid) {
      try {
        const { stdout: psOut } = await execFileAsync('ps', ['-p', pid, '-o', 'command=']);
        return { pid, command: psOut.trim() };
      } catch {
        return { pid, command: 'unknown' };
      }
    }
  } catch {
    // No process on port
    return null;
  }

  return null;
}

/**
 * Format uptime in human-readable format
 */
export function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * Detect if running in WSL (Windows Subsystem for Linux)
 */
export function isWSL(): boolean {
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
export function getBrowserOpenCommand(): string {
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
 * Check if a process is alive by PID
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
    const start = Date.now();
    while (isProcessAlive(pid) && Date.now() - start < timeout) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // If still alive, force kill with SIGKILL
    if (isProcessAlive(pid)) {
      process.kill(pid, 'SIGKILL');
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return !isProcessAlive(pid);
  } catch (error) {
    return false;
  }
}
