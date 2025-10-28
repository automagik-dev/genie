"use strict";
/**
 * MCP Cleanup Command
 *
 * Manually cleanup stale MCP server processes.
 * Useful for troubleshooting zombie processes.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.cleanupMcpServers = cleanupMcpServers;
exports.handleMcpCleanup = handleMcpCleanup;
const child_process_1 = require("child_process");
/**
 * Find all MCP server processes
 */
function findMcpProcesses() {
    try {
        const output = (0, child_process_1.execSync)('ps aux | grep -E "node.*mcp.*server\\.js" | grep -v grep', {
            encoding: 'utf-8'
        }).trim();
        if (!output)
            return [];
        return output.split('\n').map(line => {
            const parts = line.trim().split(/\s+/);
            return {
                pid: parseInt(parts[1], 10),
                ppid: parseInt(parts[2], 10),
                cmd: parts.slice(10).join(' ')
            };
        }).filter(p => !isNaN(p.pid));
    }
    catch {
        return [];
    }
}
/**
 * Check if process is alive
 */
function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Kill process with timeout
 */
async function killWithTimeout(pid, timeout = 5000) {
    if (!isAlive(pid))
        return true;
    try {
        process.kill(pid, 'SIGTERM');
        const start = Date.now();
        while (Date.now() - start < timeout) {
            await new Promise(resolve => setTimeout(resolve, 100));
            if (!isAlive(pid))
                return true;
        }
        // Force kill if still alive
        if (isAlive(pid)) {
            process.kill(pid, 'SIGKILL');
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        return !isAlive(pid);
    }
    catch {
        return !isAlive(pid);
    }
}
/**
 * Execute MCP cleanup
 */
async function cleanupMcpServers(options = {}) {
    const { dryRun = false, force = false } = options;
    const processes = findMcpProcesses();
    const result = {
        found: processes.length,
        killed: 0,
        failed: 0
    };
    if (processes.length === 0) {
        console.log('✅ No MCP server processes found');
        return result;
    }
    console.log(`\n🔍 Found ${processes.length} MCP server process(es):\n`);
    processes.forEach((proc, i) => {
        const parentAlive = isAlive(proc.ppid);
        const status = parentAlive ? '(running)' : '(orphaned)';
        console.log(`  ${i + 1}. PID ${proc.pid} ${status}`);
    });
    if (dryRun) {
        console.log('\n📋 Dry run mode - no processes killed');
        return result;
    }
    // Kill orphaned processes (or all if force)
    console.log('\n🧹 Cleaning up...\n');
    for (const proc of processes) {
        const parentAlive = isAlive(proc.ppid);
        const shouldKill = force || !parentAlive;
        if (!shouldKill) {
            console.log(`  ⏭️  Skipping PID ${proc.pid} (parent alive, use --force to kill)`);
            continue;
        }
        const success = await killWithTimeout(proc.pid);
        if (success) {
            console.log(`  ✅ Killed PID ${proc.pid}`);
            result.killed++;
        }
        else {
            console.log(`  ❌ Failed to kill PID ${proc.pid}`);
            result.failed++;
        }
    }
    console.log(`\n✅ Cleanup complete: ${result.killed} killed, ${result.failed} failed\n`);
    return result;
}
/**
 * CLI handler
 */
async function handleMcpCleanup(options) {
    try {
        await cleanupMcpServers(options);
    }
    catch (error) {
        console.error(`\n❌ Cleanup failed: ${error}\n`);
        process.exit(1);
    }
}
