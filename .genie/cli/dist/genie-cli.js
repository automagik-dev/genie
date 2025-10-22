#!/usr/bin/env node
/**
 * Genie CLI - Unified command-line interface with commander.js
 *
 * Provides a unified CLI for:
 * - Agent orchestration (run, resume, list, view, stop)
 * - MCP server management (genie mcp)
 */
import { Command } from 'commander';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import gradient from 'gradient-string';
import { startForgeInBackground, waitForForgeReady, stopForge, isForgeRunning, killForgeProcess, getRunningTasks } from './lib/forge-manager.js';
import { collectForgeStats, formatStatsForDashboard } from './lib/forge-stats.js';
import { formatTokenMetrics } from './lib/token-tracker.js';
const program = new Command();
// Genie-themed gradients 🧞✨
const genieGradient = gradient(['#00f5ff', '#9d00ff', '#ff00ea']); // Cyan → Purple → Magenta
const performanceGradient = gradient(['#ffd700', '#ff8c00']); // Gold → Dark Orange
const successGradient = gradient(['#00ff88', '#00ccff']); // Green → Cyan
// Get package version
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8'));
program
    .name('genie')
    .description('Self-evolving AI agent orchestration framework\n\nRun with no arguments to start Genie server (Forge + MCP)')
    .version(packageJson.version);
// ==================== SERVER MANAGEMENT ====================
// Status command
program
    .command('status')
    .description('Show Genie server status (Forge backend, MCP server, statistics)')
    .action(() => {
    execGenie(['status']);
});
// MCP command (stdio only - for Claude Desktop integration)
program
    .command('mcp')
    .description('Start MCP server in stdio mode (for Claude Desktop). Requires Forge to be running.')
    .action(async () => {
    await startMCPStdio();
});
// ==================== AGENT ORCHESTRATION ====================
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
    .description('List agents, sessions, or workflows')
    .action((type) => {
    const normalized = (type || 'agents').toLowerCase();
    const validTypes = ['agents', 'sessions', 'workflows'];
    if (!validTypes.includes(normalized)) {
        console.error('Error: list command accepts agents (default), sessions, or workflows');
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
// ==================== WORKSPACE MANAGEMENT ====================
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
// ==================== PACKAGE MANAGEMENT ====================
// Update command (npm package with changelog from GitHub)
program
    .command('update')
    .description('Update Genie globally to latest @next version (shows changelog from GitHub)')
    .option('--check', 'Check for updates without installing')
    .action(async (options) => {
    await updateGeniePackage(options.check || false);
});
// If no command was provided, run intelligent entry first, then start the server
const args = process.argv.slice(2);
if (!args.length) {
    // Check if should show intelligent entry (interactive mode)
    if (process.stdin.isTTY && !process.env.GENIE_SKIP_ENTRY) {
        runIntelligentEntry();
    }
    else {
        startGenieServer();
    }
}
else {
    // Parse arguments for other commands
    program.parse(process.argv);
}
/**
 * Run the intelligent entry point with animations and auto-detection
 */
function runIntelligentEntry() {
    const entryScript = path.join(__dirname, 'intelligent-entry-main.js');
    // Check if intelligent entry exists (might not be built yet)
    if (!fs.existsSync(entryScript)) {
        console.error('Warning: Intelligent entry not built. Falling back to direct server start.');
        console.error('Run: pnpm run build:genie');
        console.error('');
        startGenieServer();
        return;
    }
    const child = spawn('node', [entryScript], {
        stdio: 'inherit',
        env: process.env
    });
    child.on('exit', (code) => {
        // If intelligent entry exits successfully, it means user chose to start
        if (code === 0) {
            // Don't start server - intelligent entry already handled it
            process.exit(0);
        }
        else {
            process.exit(code || 0);
        }
    });
    child.on('error', (err) => {
        console.error('Failed to start intelligent entry:', err);
        console.error('Falling back to direct server start...');
        console.error('');
        startGenieServer();
    });
}
/**
 * Execute the legacy genie CLI
 */
function execGenie(args) {
    const genieScript = path.join(__dirname, 'genie.js');
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
 * Update Genie globally to latest @next version and show changelog from GitHub
 */
async function updateGeniePackage(checkOnly) {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    const https = require('https');
    console.log(genieGradient('━'.repeat(60)));
    console.log(genieGradient('🧞 ✨ GENIE UPDATE'));
    console.log(genieGradient('━'.repeat(60)));
    console.log('');
    // Get current version
    const currentVersion = packageJson.version;
    console.log(`Current version:     ${currentVersion}`);
    // Fetch latest version from npm @next tag
    let latestVersion;
    try {
        const { stdout } = await execFileAsync('npm', ['view', 'automagik-genie@next', 'version']);
        latestVersion = stdout.trim();
        console.log(`Latest @next:        ${latestVersion}`);
        console.log(`New version will be: ${latestVersion}`);
        console.log('');
    }
    catch (error) {
        console.error('❌ Failed to fetch latest version from npm');
        process.exit(1);
    }
    // Check if already up to date
    if (currentVersion === latestVersion) {
        console.log(successGradient('✅ Already on latest @next version!'));
        console.log('');
        process.exit(0);
    }
    // Fetch changelog from GitHub
    console.log('📜 Fetching changelog from GitHub...');
    console.log('');
    const fetchChangelog = (url) => {
        return new Promise((resolve, reject) => {
            https.get(url, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        resolve(data);
                    }
                    else {
                        reject(new Error(`GitHub API returned ${res.statusCode}`));
                    }
                });
            }).on('error', reject);
        });
    };
    try {
        // Fetch release from GitHub
        const releaseData = await fetchChangelog(`https://api.github.com/repos/namastexlabs/automagik-genie/releases/tags/v${latestVersion}`);
        const release = JSON.parse(releaseData);
        console.log(performanceGradient('━'.repeat(60)));
        console.log(performanceGradient(`📦 Release: v${latestVersion}`));
        console.log(performanceGradient('━'.repeat(60)));
        console.log('');
        console.log(release.body || 'No release notes available');
        console.log('');
    }
    catch (error) {
        console.log('⚠️  Could not fetch changelog (GitHub rate limit or release not found)');
        console.log('');
    }
    if (checkOnly) {
        console.log(genieGradient('━'.repeat(60)));
        console.log(`Run ${successGradient('genie update')} to install v${latestVersion}`);
        console.log(genieGradient('━'.repeat(60)));
        console.log('');
        process.exit(0);
    }
    // Prompt for update
    const readline = require('readline').createInterface({
        input: process.stdin,
        output: process.stdout
    });
    const answer = await new Promise((resolve) => {
        readline.question(`Update to v${latestVersion}? [Y/n]: `, resolve);
    });
    readline.close();
    if (answer.toLowerCase() === 'n' || answer.toLowerCase() === 'no') {
        console.log('');
        console.log('❌ Update cancelled');
        console.log('');
        process.exit(0);
    }
    // Perform update
    console.log('');
    console.log(performanceGradient('⬆️  Updating Genie...'));
    console.log('');
    try {
        await execFileAsync('pnpm', ['install', '-g', 'automagik-genie@next'], {
            stdio: 'inherit'
        });
        console.log('');
        console.log(successGradient(`✅ Successfully updated to v${latestVersion}!`));
        console.log('');
        console.log(genieGradient('━'.repeat(60)));
        console.log('Run ' + successGradient('genie') + ' to start using the new version');
        console.log(genieGradient('━'.repeat(60)));
        console.log('');
    }
    catch (error) {
        console.error('❌ Update failed:', error);
        process.exit(1);
    }
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
        const forgeHealthy = await isForgeRunning(baseUrl);
        const forgeStatus = forgeHealthy ? '🟢' : '🔴';
        // Check MCP health
        const mcpHealthy = mcpChild && !mcpChild.killed;
        const mcpStatus = mcpHealthy ? '🟢' : '🔴';
        // Collect Forge statistics (only if healthy)
        const forgeStats = forgeHealthy ? await collectForgeStats(baseUrl) : null;
        const statsDisplay = formatStatsForDashboard(forgeStats);
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
            process.stdout.write('\x1b[2J'); // Clear entire screen
            process.stdout.write('\x1b[H'); // Move cursor to home (0,0)
        }
        // Print new dashboard
        process.stdout.write(dashboard + '\n');
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
    const mcpServer = path.join(__dirname, '../../mcp/dist/server.js');
    // Check if MCP server exists
    if (!fs.existsSync(mcpServer)) {
        console.error('Error: MCP server not built. Run: pnpm run build:mcp');
        process.exit(1);
    }
    // Phase 1: Start Forge in background
    const baseUrl = process.env.FORGE_BASE_URL || 'http://localhost:8887';
    const logDir = path.join(process.cwd(), '.genie', 'state');
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
    const forgeRunning = await isForgeRunning(baseUrl);
    timings.initialHealthCheck = Date.now() - healthCheckStart;
    if (!forgeRunning) {
        const forgeSpawnStart = Date.now();
        process.stderr.write('📦 Starting Forge backend');
        const startResult = startForgeInBackground({ baseUrl, logDir });
        timings.forgeSpawn = Date.now() - forgeSpawnStart;
        if (!startResult.ok) {
            const error = 'error' in startResult ? startResult.error : new Error('Unknown error');
            console.error(`\n❌ Failed to start Forge: ${error.message}`);
            console.error(`   Check logs at ${logDir}/forge.log`);
            process.exit(1);
        }
        // Wait for Forge to be ready (parallel with MCP startup below)
        const forgeReadyStart = Date.now();
        const forgeReady = await waitForForgeReady(baseUrl, 60000, 500, true);
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
        // Check for running tasks before killing Forge
        const runningTasks = await getRunningTasks(baseUrl);
        if (runningTasks.length > 0) {
            console.log('');
            console.log('⚠️  WARNING: Running tasks detected!');
            console.log('');
            console.log(`${runningTasks.length} task(s) are currently running:`);
            console.log('');
            runningTasks.forEach((task, index) => {
                console.log(`${index + 1}. ${task.projectName} → ${task.taskTitle}`);
                console.log(`   ${task.url}`);
                console.log('');
            });
            // Prompt for confirmation
            const readline = require('readline').createInterface({
                input: process.stdin,
                output: process.stdout
            });
            const answer = await new Promise((resolve) => {
                readline.question('Kill these tasks and shutdown? [y/N]: ', resolve);
            });
            readline.close();
            if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
                console.log('');
                console.log('❌ Shutdown cancelled. Tasks are still running.');
                console.log('   Press Ctrl+C again to force shutdown.');
                console.log('');
                isShuttingDown = false; // Reset flag to allow retry
                return;
            }
        }
        // Calculate session stats
        const sessionDuration = Date.now() - startTime;
        const uptimeStr = formatUptime(sessionDuration);
        // Stop MCP immediately
        if (mcpChild && !mcpChild.killed) {
            mcpChild.kill('SIGTERM');
            console.log('📡 MCP server stopped');
        }
        // Kill Forge child process immediately (prevents orphaned processes)
        killForgeProcess();
        // Stop Forge and wait for completion
        try {
            const stopped = await stopForge(logDir);
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
        const finalStats = await collectForgeStats(baseUrl);
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
            console.log(formatTokenMetrics(finalStats.tokens, false));
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
        mcpChild = spawn('node', [mcpServer], {
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
                    await stopForge(logDir);
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
                    await stopForge(logDir);
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
    const mcpServer = path.join(__dirname, '../../mcp/dist/server.js');
    // Check if MCP server exists
    if (!fs.existsSync(mcpServer)) {
        console.error('Error: MCP server not built. Run: pnpm run build:mcp');
        process.exit(1);
    }
    // Check if Forge is running
    const baseUrl = process.env.FORGE_BASE_URL || 'http://localhost:8887';
    const forgeRunning = await isForgeRunning(baseUrl);
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
    const child = spawn('node', [mcpServer], {
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
