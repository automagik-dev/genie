#!/usr/bin/env node
"use strict";
/**
 * Genie CLI - Unified command-line interface with commander.js
 *
 * Provides a unified CLI for:
 * - Agent orchestration (run, resume, list, view, stop)
 * - MCP server management (genie mcp)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const child_process_1 = require("child_process");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const gradient_string_1 = __importDefault(require("gradient-string"));
const forge_manager_1 = require("./lib/forge-manager");
const forge_stats_1 = require("./lib/forge-stats");
const token_tracker_1 = require("./lib/token-tracker");
const program = new commander_1.Command();
// Genie-themed gradients 🧞✨
const genieGradient = (0, gradient_string_1.default)(['#00f5ff', '#9d00ff', '#ff00ea']); // Cyan → Purple → Magenta
const performanceGradient = (0, gradient_string_1.default)(['#ffd700', '#ff8c00']); // Gold → Dark Orange
const successGradient = (0, gradient_string_1.default)(['#00ff88', '#00ccff']); // Green → Cyan
// Get package version
const packageJson = JSON.parse(fs_1.default.readFileSync(path_1.default.join(__dirname, '../../../package.json'), 'utf8'));
program
    .name('genie')
    .description('Self-evolving AI agent orchestration framework\n\nRun with no arguments to start Genie server (Forge + MCP)')
    .version(packageJson.version);
// Run command
program
    .command('run <agent> <prompt>')
    .description('Run an agent with a prompt')
    .option('-b, --background', 'Run in background mode')
    .option('-x, --executor <executor>', 'Override executor for this run')
    .option('-m, --model <model>', 'Override model for the selected executor')
    .option('-n, --name <name>', 'Friendly session name for easy identification')
    .action((agent, prompt, options) => {
    const args = ['run', agent, prompt];
    if (options.background) {
        args.push('--background');
    }
    if (options.executor) {
        args.push('--executor', options.executor);
    }
    if (options.model) {
        args.push('--model', options.model);
    }
    if (options.name) {
        args.push('--name', options.name);
    }
    execGenie(args);
});
// Init command
program
    .command('init [template]')
    .description('Initialize Genie configuration in the current workspace')
    .option('-y, --yes', 'Accept defaults without prompting')
    .action((template, options) => {
    const args = ['init'];
    if (template) {
        args.push(template);
    }
    if (options.yes) {
        args.push('--yes');
    }
    execGenie(args);
});
// Migrate command
program
    .command('migrate')
    .description('Migrate from old Genie (v2.x) to npm-backed architecture (v3.0+)')
    .option('--dry-run', 'Show changes without applying them')
    .option('-f, --force', 'Force migration even if already migrated')
    .action((options) => {
    const args = ['migrate'];
    if (options.dryRun) {
        args.push('--dry-run');
    }
    if (options.force) {
        args.push('--force');
    }
    execGenie(args);
});
// Update command
program
    .command('update')
    .description('Update Genie templates in this workspace')
    .option('--dry-run', 'Show changes without applying them')
    .option('-f, --force', 'Apply updates even when no changes detected')
    .action((options) => {
    const args = ['update'];
    if (options.dryRun) {
        args.push('--dry-run');
    }
    if (options.force) {
        args.push('--force');
    }
    execGenie(args);
});
// Rollback command
program
    .command('rollback')
    .description('Restore a previous Genie backup snapshot')
    .option('--list', 'List available backups')
    .option('--latest', 'Restore the most recent backup')
    .option('--id <backupId>', 'Restore a specific backup by ID')
    .action((options) => {
    const args = ['rollback'];
    if (options.list) {
        args.push('--list');
    }
    if (options.latest) {
        args.push('--latest');
    }
    if (options.id) {
        args.push('--id', options.id);
    }
    execGenie(args);
});
// Resume command
program
    .command('resume <sessionId> <prompt>')
    .description('Resume an existing agent session')
    .action((sessionId, prompt) => {
    execGenie(['resume', sessionId, prompt]);
});
// List command
program
    .command('list [type]')
    .description('List collectives (default) or sessions')
    .action((type) => {
    const normalized = (type || 'collectives').toLowerCase();
    const validTypes = ['collectives', 'agents', 'sessions', 'workflows', 'skills'];
    if (!validTypes.includes(normalized)) {
        console.error('Error: list command accepts collectives (default), agents, workflows, skills, or sessions');
        process.exit(1);
    }
    execGenie(['list', normalized]);
});
// View command
program
    .command('view <sessionId>')
    .description('View session transcript')
    .option('--full', 'Show full transcript')
    .option('--live', 'Live view (auto-refresh)')
    .action((sessionId, options) => {
    const args = ['view', sessionId];
    if (options.full)
        args.push('--full');
    if (options.live)
        args.push('--live');
    execGenie(args);
});
// Stop command
program
    .command('stop <sessionId>')
    .description('Stop a running session')
    .action((sessionId) => {
    execGenie(['stop', sessionId]);
});
// Status command
program
    .command('status')
    .description('Show Genie server status (Forge backend, MCP server, statistics)')
    .action(() => {
    execGenie(['status']);
});
// Cleanup command
program
    .command('cleanup')
    .description('Deprecated cleanup shim (see migration guide)')
    .action(() => {
    execGenie(['cleanup']);
});
// Statusline command
program
    .command('statusline')
    .description('Emit statusline output (deprecated)')
    .action(() => {
    execGenie(['statusline']);
});
// MCP command (stdio only - for Claude Desktop integration)
program
    .command('mcp')
    .description('Start MCP server in stdio mode (for Claude Desktop). Requires Forge to be running.')
    .action(async () => {
    await startMCPStdio();
});
// If no command was provided, start the server
const args = process.argv.slice(2);
if (!args.length) {
    startGenieServer();
}
else {
    // Parse arguments for other commands
    program.parse(process.argv);
}
/**
 * Execute the legacy genie CLI
 */
function execGenie(args) {
    const genieScript = path_1.default.join(__dirname, 'genie.js');
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
 * Display live health monitoring dashboard with executive stats
 * Returns the interval ID for cleanup
 */
async function startHealthMonitoring(baseUrl, mcpPort, mcpChild, serverStartTime, startupTimings) {
    const UPDATE_INTERVAL = 5000; // 5 seconds
    let dashboardLines = 0;
    const updateDashboard = async () => {
        // Calculate uptime
        const uptime = Date.now() - serverStartTime;
        const uptimeStr = formatUptime(uptime);
        // Current time
        const now = new Date();
        const timeStr = now.toLocaleTimeString();
        const dateStr = now.toLocaleDateString();
        // Check Forge health
        const forgeHealthy = await (0, forge_manager_1.isForgeRunning)(baseUrl);
        const forgeStatus = forgeHealthy ? '🟢' : '🔴';
        // Check MCP health
        const mcpHealthy = mcpChild && !mcpChild.killed;
        const mcpStatus = mcpHealthy ? '🟢' : '🔴';
        // Collect Forge statistics (only if healthy)
        const forgeStats = forgeHealthy ? await (0, forge_stats_1.collectForgeStats)(baseUrl) : null;
        const statsDisplay = (0, forge_stats_1.formatStatsForDashboard)(forgeStats);
        // Build executive dashboard with stats
        const headerLine = '━'.repeat(60);
        const header = genieGradient(`${headerLine}
🧞 GENIE SERVER - Executive Dashboard
${headerLine}`);
        const footer = genieGradient(`${headerLine}
Press Ctrl+C to stop all services
${headerLine}`);
        const dashboard = `${header}

📊 **Quick Stats**
   Real-time: ${timeStr} (${dateStr})
   Uptime: ${uptimeStr}
   Startup: ${startupTimings.total || 0}ms (${((startupTimings.total || 0) / 1000).toFixed(1)}s)

${forgeStatus} **Forge Backend**
   Status: ${forgeHealthy ? 'Running' : 'Down'}
   URL: ${baseUrl}
${statsDisplay}

${mcpStatus} **MCP Server**
   Status: ${mcpHealthy ? 'Running' : 'Down'}
   URL: http://localhost:${mcpPort}/sse

${footer}`;
        // Clear previous dashboard if not first render
        if (dashboardLines > 0) {
            // Move cursor up and clear lines
            for (let i = 0; i < dashboardLines; i++) {
                process.stdout.write('\x1b[1A'); // Move up one line
                process.stdout.write('\x1b[2K'); // Clear entire line
            }
            process.stdout.write('\r'); // Move to start of line
        }
        // Print new dashboard
        console.log(dashboard);
        // Count lines for next update
        dashboardLines = dashboard.split('\n').length;
    };
    // Initial render
    await updateDashboard();
    // Update every 5 seconds and return the interval ID
    return setInterval(updateDashboard, UPDATE_INTERVAL);
}
/**
 * Start Genie server (Forge + MCP with SSE transport on port 8885)
 * This is the main entry point for npx automagik-genie
 */
async function startGenieServer() {
    const startTime = Date.now();
    const timings = {};
    const mcpServer = path_1.default.join(__dirname, '../../mcp/dist/server.js');
    // Check if MCP server exists
    if (!fs_1.default.existsSync(mcpServer)) {
        console.error('Error: MCP server not built. Run: pnpm run build:mcp');
        process.exit(1);
    }
    // Phase 1: Start Forge in background
    const baseUrl = process.env.FORGE_BASE_URL || 'http://localhost:8887';
    const logDir = path_1.default.join(process.cwd(), '.genie', 'state');
    const forgePort = new URL(baseUrl).port || '8887';
    console.log(genieGradient('━'.repeat(60)));
    console.log(genieGradient('🧞 ✨ GENIE - Autonomous Agent Orchestration'));
    console.log(genieGradient('━'.repeat(60)));
    console.log('');
    // Check for port conflicts BEFORE trying to start
    const conflictCheckStart = Date.now();
    const portConflict = await checkPortConflict(forgePort);
    timings.portConflictCheck = Date.now() - conflictCheckStart;
    if (portConflict) {
        console.log(`⚠️  Port ${forgePort} is already in use by:`);
        console.log(`   PID: ${portConflict.pid}`);
        console.log(`   Command: ${portConflict.command}`);
        console.log('');
        // Prompt user to take over
        const readline = require('readline').createInterface({
            input: process.stdin,
            output: process.stdout
        });
        const answer = await new Promise((resolve) => {
            readline.question('Kill this process and start Genie server? [y/N]: ', resolve);
        });
        readline.close();
        if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
            console.log(`🔪 Killing process ${portConflict.pid}...`);
            try {
                process.kill(parseInt(portConflict.pid), 'SIGTERM');
                await new Promise(r => setTimeout(r, 2000)); // Wait for cleanup
                console.log('✅ Process terminated');
            }
            catch (err) {
                console.error(`❌ Failed to kill process: ${err}`);
                process.exit(1);
            }
        }
        else {
            console.log('❌ Cancelled. Cannot start on occupied port.');
            process.exit(1);
        }
    }
    // Check if Forge is already running (health check)
    const healthCheckStart = Date.now();
    const forgeRunning = await (0, forge_manager_1.isForgeRunning)(baseUrl);
    timings.initialHealthCheck = Date.now() - healthCheckStart;
    if (!forgeRunning) {
        const forgeSpawnStart = Date.now();
        process.stderr.write('📦 Starting Forge backend');
        const startResult = (0, forge_manager_1.startForgeInBackground)({ baseUrl, logDir });
        timings.forgeSpawn = Date.now() - forgeSpawnStart;
        if (!startResult.ok) {
            console.error(`\n❌ Failed to start Forge: ${startResult.error.message}`);
            console.error(`   Check logs at ${logDir}/forge.log`);
            process.exit(1);
        }
        // Wait for Forge to be ready (parallel with MCP startup below)
        const forgeReadyStart = Date.now();
        const forgeReady = await (0, forge_manager_1.waitForForgeReady)(baseUrl, 60000, 500, true);
        timings.forgeReady = Date.now() - forgeReadyStart;
        if (!forgeReady) {
            console.error('\n❌ Forge did not start in time (60s). Check logs at .genie/state/forge.log');
            process.exit(1);
        }
        console.log(successGradient(`📦 Forge:  ${baseUrl} ✓`));
    }
    else {
        console.log(successGradient(`📦 Forge:  ${baseUrl} ✓ (already running)`));
        timings.forgeReady = 0; // Already running
    }
    // Phase 2: Start MCP server with SSE transport
    const mcpPort = process.env.MCP_PORT || '8885';
    console.log(successGradient(`📡 MCP:    http://localhost:${mcpPort}/sse ✓`));
    console.log('');
    // Set environment variables
    const env = {
        ...process.env,
        MCP_TRANSPORT: 'httpStream',
        MCP_PORT: mcpPort
    };
    // Track runtime stats for shutdown report
    let requestCount = 0;
    let errorCount = 0;
    let lastHealthCheck = Date.now();
    // Handle graceful shutdown (stop both Forge and MCP)
    let mcpChild = null;
    let isShuttingDown = false;
    let healthMonitoringInterval = null;
    // Shutdown function that actually does the work
    const shutdown = async () => {
        // Prevent multiple shutdown attempts
        if (isShuttingDown)
            return;
        isShuttingDown = true;
        // Clear health monitoring interval
        if (healthMonitoringInterval) {
            clearInterval(healthMonitoringInterval);
            healthMonitoringInterval = null;
        }
        console.log('');
        console.log('');
        console.log(genieGradient('━'.repeat(60)));
        console.log(genieGradient('🛑 Shutting down Genie...'));
        console.log(genieGradient('━'.repeat(60)));
        // Calculate session stats
        const sessionDuration = Date.now() - startTime;
        const uptimeStr = formatUptime(sessionDuration);
        // Stop MCP immediately
        if (mcpChild && !mcpChild.killed) {
            mcpChild.kill('SIGTERM');
            console.log('📡 MCP server stopped');
        }
        // Stop Forge and wait for completion
        try {
            const stopped = await (0, forge_manager_1.stopForge)(logDir);
            if (stopped) {
                console.log('📦 Forge backend stopped');
            }
            else {
                console.log('⚠️  Forge was not started by this session');
            }
        }
        catch (error) {
            console.error(`❌ Error stopping Forge: ${error}`);
        }
        // Collect final stats for goodbye report
        const finalStats = await (0, forge_stats_1.collectForgeStats)(baseUrl);
        // Display epic goodbye report with Genie's face
        console.log('');
        console.log(genieGradient('━'.repeat(80)));
        console.log(genieGradient('                    🧞 ✨ GENIE SESSION COMPLETE ✨ 🧞                     '));
        console.log(genieGradient('━'.repeat(80)));
        console.log('');
        // Genie ASCII art face
        const genieFace = `
         ✨             ⭐️
            ╱|、
          (˚ˎ 。7   🌙   ~  Your wish is my command  ~
           |、˜〵
          じしˉ,)ノ
                     💫    ⭐️`;
        console.log(genieGradient(genieFace));
        console.log('');
        console.log(performanceGradient('━'.repeat(80)));
        console.log(performanceGradient('📊  SESSION STATISTICS'));
        console.log(performanceGradient('━'.repeat(80)));
        console.log('');
        console.log(`   ${successGradient('⏱  Uptime:')}          ${uptimeStr}`);
        console.log(`   ${successGradient('🚀 Startup time:')}    ${timings.total || 0}ms (${((timings.total || 0) / 1000).toFixed(1)}s)`);
        console.log(`   ${successGradient('✓  Services:')}        Forge + MCP`);
        console.log('');
        // Token usage stats (detailed)
        if (finalStats?.tokens && finalStats.tokens.total > 0) {
            console.log(performanceGradient('━'.repeat(80)));
            console.log(performanceGradient('🪙  TOKEN USAGE THIS SESSION'));
            console.log(performanceGradient('━'.repeat(80)));
            console.log('');
            console.log((0, token_tracker_1.formatTokenMetrics)(finalStats.tokens, false));
            console.log('');
        }
        // Work summary
        if (finalStats) {
            console.log(performanceGradient('━'.repeat(80)));
            console.log(performanceGradient('📋  WORK SUMMARY'));
            console.log(performanceGradient('━'.repeat(80)));
            console.log('');
            console.log(`   ${successGradient('📁 Projects:')}       ${finalStats.projects.total} total`);
            console.log(`   ${successGradient('📝 Tasks:')}          ${finalStats.tasks.total} total`);
            console.log(`   ${successGradient('🔄 Attempts:')}       ${finalStats.attempts.total} total`);
            if (finalStats.attempts.completed > 0) {
                console.log(`      ✅ ${finalStats.attempts.completed} completed`);
            }
            if (finalStats.attempts.failed > 0) {
                console.log(`      ❌ ${finalStats.attempts.failed} failed`);
            }
            console.log('');
        }
        console.log(genieGradient('━'.repeat(80)));
        console.log(genieGradient('                 ✨ Until next time, keep making magic! ✨                '));
        console.log(genieGradient('━'.repeat(80)));
        console.log('');
    };
    // Install signal handlers for graceful shutdown
    const handleShutdownSignal = (signal) => {
        shutdown()
            .catch((error) => {
            console.error(`Fatal error during shutdown (${signal}):`, error);
            process.exit(1);
        })
            .then(() => {
            process.exit(0);
        });
    };
    process.on('SIGINT', () => handleShutdownSignal('SIGINT'));
    process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
    // Resilient startup: retry on early non-zero exit
    const maxAttempts = parseInt(process.env.GENIE_MCP_RESTARTS || '2', 10);
    const backoffMs = parseInt(process.env.GENIE_MCP_BACKOFF || '500', 10);
    let attempt = 0;
    let monitoringStarted = false;
    const start = () => {
        attempt += 1;
        mcpChild = (0, child_process_1.spawn)('node', [mcpServer], {
            stdio: 'inherit',
            env
        });
        const timer = setTimeout(() => {
            // After grace period, consider startup successful
            // Start health monitoring dashboard (only once, not on retries)
            if (!monitoringStarted && mcpChild) {
                monitoringStarted = true;
                // Calculate total startup time
                const totalTime = Date.now() - startTime;
                timings.total = totalTime;
                // Always show performance metrics (colorful and genie-themed!)
                console.log('');
                console.log(performanceGradient('━'.repeat(60)));
                console.log(performanceGradient('⚡ Performance Metrics'));
                console.log(performanceGradient('━'.repeat(60)));
                console.log(`   ${successGradient('✓')} Port check:      ${timings.portConflictCheck || 0}ms`);
                console.log(`   ${successGradient('✓')} Health check:    ${timings.initialHealthCheck || 0}ms`);
                console.log(`   ${successGradient('✓')} Forge spawn:     ${timings.forgeSpawn || 0}ms`);
                console.log(`   ${successGradient('✓')} Forge ready:     ${timings.forgeReady || 0}ms`);
                console.log(`   ${performanceGradient('⚡')} Total startup:   ${performanceGradient(`${totalTime}ms (${(totalTime / 1000).toFixed(1)}s)`)}`);
                console.log(performanceGradient('━'.repeat(60)));
                console.log('');
                console.log(genieGradient('━'.repeat(60)));
                console.log(genieGradient('🩺 Starting health monitoring...'));
                console.log(genieGradient('━'.repeat(60)));
                startHealthMonitoring(baseUrl, mcpPort, mcpChild, startTime, timings);
            }
        }, 1000);
        mcpChild.on('exit', (code) => {
            const exitCode = code === null ? 0 : code;
            clearTimeout(timer);
            if (exitCode !== 0 && attempt <= maxAttempts) {
                console.log(`MCP server exited early with code ${exitCode}. Retrying (${attempt}/${maxAttempts}) in ${backoffMs}ms...`);
                setTimeout(start, backoffMs);
            }
            else {
                if (exitCode !== 0) {
                    console.error(`MCP server exited with code ${exitCode}`);
                }
                // Don't exit immediately - let SIGINT handler clean up Forge
                (async () => {
                    await (0, forge_manager_1.stopForge)(logDir);
                    process.exit(exitCode || 0);
                })();
            }
        });
        mcpChild.on('error', (err) => {
            clearTimeout(timer);
            if (attempt <= maxAttempts) {
                console.log(`Failed to start MCP server (${err?.message || err}). Retrying (${attempt}/${maxAttempts}) in ${backoffMs}ms...`);
                setTimeout(start, backoffMs);
            }
            else {
                console.error('Failed to start MCP server:', err);
                (async () => {
                    await (0, forge_manager_1.stopForge)(logDir);
                    process.exit(1);
                })();
            }
        });
    };
    start();
}
/**
 * Start MCP in stdio mode (for Claude Desktop integration)
 * Requires Forge to already be running
 */
async function startMCPStdio() {
    const mcpServer = path_1.default.join(__dirname, '../../mcp/dist/server.js');
    // Check if MCP server exists
    if (!fs_1.default.existsSync(mcpServer)) {
        console.error('Error: MCP server not built. Run: pnpm run build:mcp');
        process.exit(1);
    }
    // Check if Forge is running
    const baseUrl = process.env.FORGE_BASE_URL || 'http://localhost:8887';
    const forgeRunning = await (0, forge_manager_1.isForgeRunning)(baseUrl);
    if (!forgeRunning) {
        console.error('❌ Forge is not running.');
        console.error('');
        console.error('Please start the Genie server first:');
        console.error('  npx automagik-genie');
        console.error('');
        console.error('This will start both Forge backend and MCP server.');
        process.exit(1);
    }
    // Set environment for stdio transport
    const env = {
        ...process.env,
        MCP_TRANSPORT: 'stdio'
    };
    // Start MCP in stdio mode
    const child = (0, child_process_1.spawn)('node', [mcpServer], {
        stdio: 'inherit',
        env
    });
    child.on('exit', (code) => {
        process.exit(code === null ? 0 : code);
    });
    child.on('error', (err) => {
        console.error('Failed to start MCP server:', err);
        process.exit(1);
    });
}
