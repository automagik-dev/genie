"use strict";
/**
 * Genie Server Manager
 * Manages the Genie server (Forge + MCP with SSE transport)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startGenieServer = startGenieServer;
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const child_process_1 = require("child_process");
const gradient_string_1 = __importDefault(require("gradient-string"));
const forge_manager_1 = require("./forge-manager");
const forge_stats_1 = require("./forge-stats");
const token_tracker_1 = require("./token-tracker");
const config_manager_1 = require("./config-manager");
const config_manager_2 = require("./config-manager");
const tunnel_manager_1 = require("./tunnel-manager");
const cli_utils_1 = require("./cli-utils");
// Universe Genie-themed gradients 🧞✨🌌
const genieGradient = (0, gradient_string_1.default)(['#0066ff', '#9933ff', '#ff00ff']); // Deep Blue → Purple → Fuscia
const cosmicGradient = (0, gradient_string_1.default)(['#4169e1', '#8a2be2', '#ff1493']); // Royal Blue → Blue Violet → Deep Pink
const performanceGradient = (0, gradient_string_1.default)(['#ffd700', '#ff8c00', '#ff6347']); // Gold → Orange → Tomato
const successGradient = (0, gradient_string_1.default)(['#00ff88', '#00ccff', '#0099ff']); // Green → Cyan → Sky Blue
const magicGradient = (0, gradient_string_1.default)(['#ff00ff', '#9933ff', '#0066ff']); // Fuscia → Purple → Blue (reverse)
/**
 * Start Genie server (Forge + MCP with SSE transport on port 8885)
 * This is the main entry point for npx automagik-genie
 * @param debug - Enable debug mode (MCP_DEBUG=1)
 */
async function startGenieServer(debug = false) {
    const startTime = Date.now();
    const timings = {};
    const mcpServer = path_1.default.join(__dirname, '../../../mcp/dist/server.js');
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
    console.log(cosmicGradient('        🧞 ✨ GENIE ✨ 🧞        '));
    console.log(magicGradient('   Autonomous Agent Orchestration   '));
    console.log(genieGradient('━'.repeat(60)));
    console.log('');
    // FIRST: Check if Forge is already running (health check)
    const healthCheckStart = Date.now();
    const forgeRunning = await (0, forge_manager_1.isForgeRunning)(baseUrl);
    timings.initialHealthCheck = Date.now() - healthCheckStart;
    if (forgeRunning) {
        // Forge already running and healthy - just show status and continue
        console.log(successGradient(`📦 Forge:  ${baseUrl} ✓`));
        timings.forgeReady = 0; // Already running
    }
    else {
        // Forge not running - check for port conflicts before starting
        const conflictCheckStart = Date.now();
        const portConflict = await (0, cli_utils_1.checkPortConflict)(forgePort);
        timings.portConflictCheck = Date.now() - conflictCheckStart;
        if (portConflict) {
            // Port occupied by something else
            console.error('');
            console.error(`❌ Port ${forgePort} is occupied by another process:`);
            console.error(`   PID: ${portConflict.pid}`);
            console.error(`   Command: ${portConflict.command}`);
            console.error('');
            console.error('Please kill that process or use a different port:');
            console.error(`   export FORGE_BASE_URL=http://localhost:8888`);
            console.error('');
            process.exit(1);
        }
        // Port is free - start Forge
        const forgeSpawnStart = Date.now();
        process.stderr.write('📦 Starting Forge backend');
        const startResult = (0, forge_manager_1.startForgeInBackground)({ baseUrl, logDir });
        timings.forgeSpawn = Date.now() - forgeSpawnStart;
        if (!startResult.ok) {
            const error = 'error' in startResult ? startResult.error : new Error('Unknown error');
            console.error(`\n❌ Failed to start Forge: ${error.message}`);
            console.error(`   Check logs at ${logDir}/forge.log`);
            process.exit(1);
        }
        // Wait for Forge to be ready
        const forgeReadyStart = Date.now();
        const forgeReady = await (0, forge_manager_1.waitForForgeReady)(baseUrl, 60000, 500, true);
        timings.forgeReady = Date.now() - forgeReadyStart;
        if (!forgeReady) {
            console.error('\n❌ Forge did not start in time (60s). Check logs at .genie/state/forge.log');
            process.exit(1);
        }
        console.log(successGradient(`📦 Forge:  ${baseUrl} ✓`));
    }
    // Phase 2: Ensure MCP OAuth2 config exists before starting MCP server
    await (0, config_manager_2.loadOrCreateConfig)();
    // Phase 2.5: ChatGPT Tunnel Setup (BEFORE MCP starts)
    const mcpPort = process.env.MCP_PORT || '8885';
    // Set environment variables (will be used when MCP starts)
    const env = {
        ...process.env,
        MCP_TRANSPORT: 'httpStream',
        MCP_PORT: mcpPort,
        ...(debug ? { MCP_DEBUG: '1' } : {})
    };
    // ChatGPT tunnel setup
    await setupChatGPTTunnel(mcpPort, env);
    // Phase 3: Check for MCP port conflict and handle takeover
    await handleMCPPortConflict(mcpPort);
    // Phase 3: Start MCP server with SSE transport
    console.log('');
    console.log(successGradient(`📡 MCP:    http://localhost:${mcpPort}/sse ✓`));
    console.log('');
    // Track runtime stats for shutdown report
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
        const runningTasks = await (0, forge_manager_1.getRunningTasks)(baseUrl);
        if (runningTasks.length > 0) {
            const shouldShutdown = await confirmShutdownWithRunningTasks(runningTasks);
            if (!shouldShutdown) {
                console.log('');
                console.log('❌ Shutdown cancelled. Tasks are still running.');
                console.log('   Press Ctrl+C again to force shutdown.');
                console.log('');
                isShuttingDown = false; // Reset flag to allow retry
                return;
            }
        }
        // Calculate session stats and stop services
        await performShutdown(mcpChild, logDir, baseUrl, startTime, timings);
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
            if (!monitoringStarted && mcpChild) {
                monitoringStarted = true;
                showStartupSuccess(startTime, timings, baseUrl);
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
 * Setup ChatGPT tunnel with ngrok
 */
async function setupChatGPTTunnel(mcpPort, env) {
    const readline = require('readline');
    const genieConfig = (0, config_manager_1.loadConfig)();
    // Check if tunnel is already configured
    const hasSavedTunnel = genieConfig?.mcp?.tunnel?.token;
    // Create readline interface
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    const createQuestion = (query) => {
        return new Promise(resolve => {
            rl.question(query, resolve);
        });
    };
    // Only prompt if no saved tunnel configuration
    let tunnelResponse = 'y'; // Default to yes if already configured
    if (!hasSavedTunnel) {
        console.log('');
        console.log(magicGradient('✨ Would you like to integrate your Genie into ChatGPT?'));
        console.log('   (more coming soon)');
        console.log('');
        tunnelResponse = await createQuestion(performanceGradient('? Connect ChatGPT to Genie? [Y/n]: '));
    }
    else {
        console.log('');
        console.log(successGradient('✓ ChatGPT tunnel configured, starting...'));
    }
    if (tunnelResponse.toLowerCase() !== 'n') {
        await handleTunnelSetup(genieConfig, mcpPort, env, rl, createQuestion, !!hasSavedTunnel);
    }
    rl.close();
}
/**
 * Handle tunnel setup flow
 */
async function handleTunnelSetup(genieConfig, mcpPort, env, rl, createQuestion, isTokenFromSaved) {
    if (!genieConfig || !genieConfig.mcp?.auth?.oauth2) {
        console.log('');
        console.log('❌ OAuth config not found. This should not happen.');
        return;
    }
    const oauth2Conf = genieConfig.mcp.auth.oauth2;
    // Get or prompt for ngrok token
    let ngrokToken = undefined;
    if (genieConfig.mcp.tunnel?.token) {
        ngrokToken = genieConfig.mcp.tunnel.token;
        console.log('');
        console.log('✓ Using saved ngrok token');
    }
    else {
        ngrokToken = await promptForNgrokToken(createQuestion);
    }
    // Start tunnel if we have a token
    if (ngrokToken) {
        await startTunnel(ngrokToken, mcpPort, env, oauth2Conf, genieConfig, isTokenFromSaved, createQuestion);
    }
}
/**
 * Prompt user for ngrok token
 */
async function promptForNgrokToken(createQuestion) {
    console.log('');
    console.log(performanceGradient('━'.repeat(60)));
    console.log(performanceGradient('📝 ngrok Setup (Free Account Required)'));
    console.log(performanceGradient('━'.repeat(60)));
    console.log('');
    const hasAccountResponse = await createQuestion(performanceGradient('? Do you have an ngrok account? [y/N]: '));
    if (hasAccountResponse.toLowerCase() === 'y' || hasAccountResponse.toLowerCase() === 'yes') {
        return await promptForExistingAccount(createQuestion);
    }
    else {
        return await promptForNewAccount(createQuestion);
    }
}
/**
 * Prompt for existing ngrok account token
 */
async function promptForExistingAccount(createQuestion) {
    console.log('');
    console.log('Great! Let\'s get your authtoken:');
    console.log('');
    console.log('📍 Step 1: Open ngrok dashboard');
    console.log(`   ${successGradient('https://dashboard.ngrok.com/get-started/your-authtoken')}`);
    console.log('');
    console.log('📍 Step 2: Find the box that says "Your Authtoken"');
    console.log('   (There\'s a password field with dots ••••• and a COPY button)');
    console.log('');
    console.log('📍 Step 3: Click the COPY button');
    console.log('');
    console.log('📍 Step 4: Paste it below');
    console.log('');
    const token = await createQuestion(performanceGradient('? Paste your ngrok authtoken here: '));
    if (token && token.trim().length > 0) {
        return token.trim();
    }
    else {
        console.log('');
        console.log('⚠️  No token provided. Skipping tunnel setup.');
        return undefined;
    }
}
/**
 * Prompt for new ngrok account
 */
async function promptForNewAccount(createQuestion) {
    console.log('');
    console.log('No problem! Let\'s create one (takes 30 seconds):');
    console.log('');
    console.log('📍 Step 1: Sign up for free');
    console.log(`   ${successGradient('https://dashboard.ngrok.com/signup')}`);
    console.log('');
    console.log('📍 Step 2: After signup, you\'ll see your authtoken');
    console.log('   (A password field with ••••• and a COPY button)');
    console.log('');
    console.log('📍 Step 3: Click COPY');
    console.log('');
    const openBrowserResponse = await createQuestion(performanceGradient('? Open signup page in browser? [Y/n]: '));
    if (openBrowserResponse.toLowerCase() !== 'n') {
        // Open browser
        const { execSync: execSyncBrowser } = await import('child_process');
        try {
            const openCommand = (0, cli_utils_1.getBrowserOpenCommand)();
            execSyncBrowser(`${openCommand} "https://dashboard.ngrok.com/signup"`, { stdio: 'ignore' });
            console.log('');
            console.log('✓ Browser opened! Come back here after you copy your token.');
        }
        catch {
            console.log('');
            console.log('⚠️  Could not open browser automatically.');
            console.log(`   Please visit: https://dashboard.ngrok.com/signup`);
        }
    }
    console.log('');
    const token = await createQuestion(performanceGradient('? Paste your ngrok authtoken here (or press Enter to skip): '));
    if (token && token.trim().length > 0) {
        return token.trim();
    }
    else {
        console.log('');
        console.log('⚠️  No token provided. Skipping tunnel setup.');
        return undefined;
    }
}
/**
 * Start ngrok tunnel
 */
async function startTunnel(ngrokToken, mcpPort, env, oauth2Conf, genieConfig, isTokenFromSaved, createQuestion) {
    console.log('');
    console.log('🌐 Starting secure tunnel...');
    const tunnelResult = await (0, tunnel_manager_1.startNgrokTunnel)(parseInt(mcpPort), ngrokToken);
    if (tunnelResult.url) {
        // SUCCESS - Set public URL in env BEFORE starting MCP
        env.MCP_PUBLIC_URL = tunnelResult.url;
        // Save token to config (only after validation)
        try {
            genieConfig.mcp.tunnel = {
                enabled: true,
                provider: 'ngrok',
                token: ngrokToken
            };
            (0, config_manager_1.saveConfig)(genieConfig);
        }
        catch (err) {
            console.error(`⚠️  Warning: Could not save token (${err.message})`);
        }
        displayTunnelSuccess(tunnelResult.url, oauth2Conf);
    }
    else {
        await handleTunnelFailure(tunnelResult, genieConfig, isTokenFromSaved, createQuestion);
    }
}
/**
 * Display tunnel success message
 */
function displayTunnelSuccess(url, oauth2Conf) {
    console.log('');
    console.log(successGradient('━'.repeat(60)));
    console.log(successGradient('✅ ChatGPT Integration Ready!'));
    console.log(successGradient('━'.repeat(60)));
    console.log('');
    console.log(magicGradient('📋 Connection Details for ChatGPT:'));
    console.log('');
    console.log(`   ${performanceGradient('SSE Endpoint:')}`);
    console.log(`   ${url}/mcp`);
    console.log('');
    console.log(`   ${performanceGradient('OAuth Client ID:')}`);
    console.log(`   ${oauth2Conf.clientId}`);
    console.log('');
    console.log(`   ${performanceGradient('OAuth Client Secret:')}`);
    console.log(`   ${oauth2Conf.clientSecret}`);
    console.log('');
    console.log(magicGradient('💡 How to connect ChatGPT:'));
    console.log('   1. Go to ChatGPT → Settings → Connectors → Create');
    console.log('   2. Fill in: Name, Description, MCP Server URL (SSE endpoint above)');
    console.log('   3. Authentication: OAuth → Add Client ID and Client Secret above');
    console.log('   4. Accept notice checkbox and create');
    console.log('');
    console.log(successGradient('━'.repeat(60)));
    console.log('');
}
/**
 * Handle tunnel failure
 */
async function handleTunnelFailure(tunnelResult, genieConfig, isTokenFromSaved, createQuestion) {
    console.log('');
    console.log('❌ Failed to start tunnel');
    console.log('');
    const errorCode = tunnelResult.errorCode || 'UNKNOWN';
    const errorMessage = tunnelResult.error || 'Unknown error';
    if (errorCode === 'ERR_NGROK_334') {
        // Endpoint already online
        console.log('   ⚠️  Your ngrok endpoint is stuck from a previous session.');
        console.log('   This is NOT a problem with your token.');
        console.log('');
        console.log('   Quick fixes:');
        console.log('   1. Wait 60 seconds and run ' + performanceGradient('genie') + ' again');
        console.log('   2. Kill stuck ngrok: ' + performanceGradient('pkill -f ngrok && genie'));
        console.log('   3. Or use ngrok dashboard: ' + successGradient('https://dashboard.ngrok.com/tunnels/agents'));
        console.log('');
    }
    else if (errorCode.includes('ERR_NGROK_4011') || errorMessage.toLowerCase().includes('authentication') || errorMessage.toLowerCase().includes('unauthorized')) {
        // Authentication errors
        console.log('   ❌ Authentication failed - your token may be invalid.');
        console.log('');
        if (isTokenFromSaved) {
            const clearResponse = await createQuestion(performanceGradient('? Clear saved token and try again? [Y/n]: '));
            if (clearResponse.toLowerCase() !== 'n') {
                try {
                    delete genieConfig.mcp.tunnel;
                    (0, config_manager_1.saveConfig)(genieConfig);
                    console.log('');
                    console.log(successGradient('✓ Saved token cleared.'));
                    console.log('   Run ' + performanceGradient('genie') + ' again to set up a new token.');
                }
                catch (err) {
                    console.log('');
                    console.log(`⚠️  Could not clear token: ${err.message}`);
                }
            }
        }
        else {
            console.log('   Please check your authtoken and try again.');
        }
        console.log('');
    }
    else {
        // Unknown error
        console.log(`   Error: ${errorMessage}`);
        console.log('');
        if (isTokenFromSaved) {
            console.log('   If the problem persists, try clearing your saved token:');
            console.log('   Delete ~/.genie/config.yaml and run ' + performanceGradient('genie') + ' again');
        }
        console.log('');
    }
}
/**
 * Handle MCP port conflict with takeover prompt
 */
async function handleMCPPortConflict(mcpPort) {
    const mcpPortConflict = await (0, cli_utils_1.checkPortConflict)(mcpPort);
    if (mcpPortConflict) {
        console.log('');
        console.log(performanceGradient('⚠️  Another Genie instance is already running'));
        console.log('');
        console.log(`   Port: ${mcpPort}`);
        console.log(`   PID: ${mcpPortConflict.pid}`);
        console.log(`   Command: ${mcpPortConflict.command}`);
        console.log('');
        // Create readline for takeover prompt
        const takeoverRl = require('readline').createInterface({
            input: process.stdin,
            output: process.stdout
        });
        const answer = await new Promise((resolve) => {
            takeoverRl.question(performanceGradient('? Take over and shutdown the other instance? [y/N]: '), resolve);
        });
        takeoverRl.close();
        if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
            console.log('');
            console.log(performanceGradient('🔄 Taking over from previous instance...'));
            // Kill the old MCP server process
            try {
                process.kill(parseInt(mcpPortConflict.pid), 'SIGTERM');
                // Wait a bit for graceful shutdown
                await new Promise(resolve => setTimeout(resolve, 3000));
                console.log(successGradient('✅ Previous instance stopped'));
            }
            catch (err) {
                console.error(`⚠️  Could not stop previous instance: ${err.message}`);
                console.error(`   You may need to kill it manually: kill ${mcpPortConflict.pid}`);
                process.exit(1);
            }
        }
        else {
            console.log('');
            console.log('❌ Cancelled. To use a different port:');
            console.log(`   MCP_PORT=8886 genie`);
            console.log('');
            process.exit(0);
        }
    }
}
/**
 * Confirm shutdown when there are running tasks
 */
async function confirmShutdownWithRunningTasks(runningTasks) {
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
    return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
}
/**
 * Perform the actual shutdown
 */
async function performShutdown(mcpChild, logDir, baseUrl, startTime, timings) {
    const sessionDuration = Date.now() - startTime;
    const uptimeStr = (0, cli_utils_1.formatUptime)(sessionDuration);
    // Stop MCP immediately
    if (mcpChild && !mcpChild.killed) {
        mcpChild.kill('SIGTERM');
        console.log('📡 MCP server stopped');
    }
    // Kill Forge child process immediately (prevents orphaned processes)
    (0, forge_manager_1.killForgeProcess)();
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
    // Display epic goodbye report
    displayGoodbyeReport(uptimeStr, timings, finalStats);
}
/**
 * Display goodbye report
 */
function displayGoodbyeReport(uptimeStr, timings, finalStats) {
    console.log('');
    console.log(cosmicGradient('━'.repeat(80)));
    console.log(magicGradient('                    🧞 ✨ GENIE SESSION COMPLETE ✨ 🧞                     '));
    console.log(cosmicGradient('━'.repeat(80)));
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
    console.log(cosmicGradient('━'.repeat(80)));
    console.log(magicGradient('                 ✨ Until next time, keep making magik! ✨                '));
    console.log(cosmicGradient('━'.repeat(80)));
    console.log('');
    console.log(magicGradient('           https://namastex.ai - AI that elevates human potential'));
    console.log('');
}
/**
 * Show startup success message and launch dashboard
 */
function showStartupSuccess(startTime, timings, baseUrl) {
    // Calculate total startup time
    const totalTime = Date.now() - startTime;
    timings.total = totalTime;
    // Always show performance metrics
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
    console.log(successGradient('━'.repeat(60)));
    console.log(successGradient('✨ Genie is ready and running! ✨'));
    console.log(successGradient('━'.repeat(60)));
    console.log('');
    console.log('💡 What you can do:');
    console.log('   • Create tasks and track progress in the dashboard');
    console.log('   • Press ' + performanceGradient('k') + ' in dashboard to kill Forge (with confirmation)');
    console.log('   • Use ' + performanceGradient('Ctrl+C') + ' here to shutdown Genie gracefully');
    console.log('');
    // Dashboard prompt
    (async () => {
        const readline = require('readline');
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        const createQuestion = (query) => {
            return new Promise(resolve => {
                rl.question(query, resolve);
            });
        };
        console.log('');
        await createQuestion(genieGradient('Press Enter to open dashboard...'));
        console.log('');
        console.log(genieGradient('📊 Launching dashboard...'));
        console.log('');
        // Launch the engagement dashboard in background
        const dashboardScript = path_1.default.join(__dirname, '../genie.js');
        const dashboardChild = (0, child_process_1.spawn)('node', [dashboardScript, 'dashboard', '--live'], {
            stdio: 'inherit',
            detached: false,
            env: process.env
        });
        // Keep stdin open so process stays alive until Ctrl+C or MCP exit
        console.log('');
        console.log('💡 Press ' + performanceGradient('Ctrl+C') + ' to stop Genie');
    })();
}
