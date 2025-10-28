"use strict";
/**
 * MCP Server Process Cleanup Utility
 *
 * Detects and kills stale MCP server processes to prevent proliferation.
 * Used by CLI before starting new MCP server instance.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.findMcpServerProcesses = findMcpServerProcesses;
exports.isProcessAlive = isProcessAlive;
exports.killProcess = killProcess;
exports.findOrphanedServers = findOrphanedServers;
exports.cleanupStaleMcpServers = cleanupStaleMcpServers;
exports.writePidFile = writePidFile;
exports.isServerAlreadyRunning = isServerAlreadyRunning;
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
/**
 * Find all running MCP server processes
 */
function findMcpServerProcesses() {
    try {
        // Use ps to find all node processes running server.js
        const output = (0, child_process_1.execSync)('ps aux | grep -E "node.*mcp.*server\\.js" | grep -v grep', { encoding: 'utf-8' }).trim();
        if (!output) {
            return [];
        }
        const lines = output.split('\n');
        const processes = [];
        for (const line of lines) {
            // Parse ps output: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
            const parts = line.trim().split(/\s+/);
            if (parts.length < 11)
                continue;
            const pid = parseInt(parts[1], 10);
            const ppid = parseInt(parts[2], 10);
            const start = parts[8];
            const cmd = parts.slice(10).join(' ');
            if (isNaN(pid))
                continue;
            processes.push({
                pid,
                ppid,
                cmd,
                age: start
            });
        }
        return processes;
    }
    catch (error) {
        // No processes found or ps command failed
        return [];
    }
}
/**
 * Check if a process is still alive
 */
function isProcessAlive(pid) {
    try {
        // Send signal 0 (no-op) to check if process exists
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Kill a process gracefully (SIGTERM first, then SIGKILL if needed)
 */
async function killProcess(pid, timeout = 5000) {
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
    }
    catch (error) {
        // Process might have already exited or we don't have permission
        return !isProcessAlive(pid);
    }
}
/**
 * Detect orphaned MCP servers (parent process died)
 */
function findOrphanedServers(processes) {
    return processes.filter(proc => {
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
async function cleanupStaleMcpServers(options = {}) {
    const { killOrphans = true, maxAge = 24 * 60 * 60 * 1000, // 24 hours
    dryRun = false } = options;
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
        }
        else {
            result.failed++;
        }
    }
    return result;
}
/**
 * Create PID file for current server instance
 */
function writePidFile(workspaceRoot) {
    const pidDir = path_1.default.join(workspaceRoot, '.genie', 'state');
    const pidFile = path_1.default.join(pidDir, 'mcp-server.pid');
    try {
        // Ensure directory exists
        if (!fs_1.default.existsSync(pidDir)) {
            fs_1.default.mkdirSync(pidDir, { recursive: true });
        }
        // Write PID
        fs_1.default.writeFileSync(pidFile, process.pid.toString(), 'utf-8');
        // Cleanup on exit
        process.on('exit', () => {
            try {
                if (fs_1.default.existsSync(pidFile)) {
                    const storedPid = parseInt(fs_1.default.readFileSync(pidFile, 'utf-8'), 10);
                    if (storedPid === process.pid) {
                        fs_1.default.unlinkSync(pidFile);
                    }
                }
            }
            catch {
                // Ignore cleanup errors
            }
        });
    }
    catch (error) {
        // Non-fatal, continue without PID file
    }
}
/**
 * Check if another MCP server is already running for this workspace
 */
function isServerAlreadyRunning(workspaceRoot) {
    const pidFile = path_1.default.join(workspaceRoot, '.genie', 'state', 'mcp-server.pid');
    if (!fs_1.default.existsSync(pidFile)) {
        return { running: false };
    }
    try {
        const pidStr = fs_1.default.readFileSync(pidFile, 'utf-8').trim();
        const pid = parseInt(pidStr, 10);
        if (isNaN(pid)) {
            // Invalid PID file, clean it up
            fs_1.default.unlinkSync(pidFile);
            return { running: false };
        }
        if (isProcessAlive(pid)) {
            return { running: true, pid };
        }
        else {
            // Stale PID file, clean it up
            fs_1.default.unlinkSync(pidFile);
            return { running: false };
        }
    }
    catch {
        return { running: false };
    }
}
