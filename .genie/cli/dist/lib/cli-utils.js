"use strict";
/**
 * CLI Utility Functions
 * Helper functions for CLI operations
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.execGenie = execGenie;
exports.checkPortConflict = checkPortConflict;
exports.formatUptime = formatUptime;
exports.isWSL = isWSL;
exports.getBrowserOpenCommand = getBrowserOpenCommand;
const fs_1 = __importDefault(require("fs"));
const child_process_1 = require("child_process");
const path_1 = __importDefault(require("path"));
/**
 * Execute the legacy genie CLI
 */
function execGenie(args) {
    const genieScript = path_1.default.join(__dirname, '../genie.js');
    const child = (0, child_process_1.spawn)('node', [genieScript, ...args], {
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
async function checkPortConflict(port) {
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
            }
            catch {
                return { pid, command: 'unknown' };
            }
        }
    }
    catch {
        // No process on port
        return null;
    }
    return null;
}
/**
 * Format uptime in human-readable format
 */
function formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days > 0)
        return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0)
        return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0)
        return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}
/**
 * Detect if running in WSL (Windows Subsystem for Linux)
 */
function isWSL() {
    try {
        // Check environment variables (most reliable)
        if (process.env.WSL_DISTRO_NAME || process.env.WSLENV) {
            return true;
        }
        // Check /proc/version for "microsoft" or "WSL"
        if (fs_1.default.existsSync('/proc/version')) {
            const version = fs_1.default.readFileSync('/proc/version', 'utf8').toLowerCase();
            if (version.includes('microsoft') || version.includes('wsl')) {
                return true;
            }
        }
    }
    catch {
        // Ignore errors
    }
    return false;
}
/**
 * Get the appropriate browser open command for the current OS
 * Handles WSL by using Windows commands instead of Linux
 */
function getBrowserOpenCommand() {
    const platform = process.platform;
    // WSL: Use Windows command
    if (platform === 'linux' && isWSL()) {
        return 'cmd.exe /c start';
    }
    // Regular OS detection
    if (platform === 'darwin')
        return 'open';
    if (platform === 'win32')
        return 'start';
    return 'xdg-open'; // Linux (non-WSL)
}
