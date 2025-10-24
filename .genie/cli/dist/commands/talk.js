"use strict";
/**
 * Talk Command - Interactive browser session with agent
 *
 * Starts Forge if needed, shows ready message, opens dashboard in browser.
 * Forge stays running in background after command exits.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runTalk = runTalk;
const forge_manager_1 = require("../lib/forge-manager");
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const gradient_string_1 = __importDefault(require("gradient-string"));
// Genie-themed gradients
const genieGradient = (0, gradient_string_1.default)(['#0066ff', '#9933ff', '#ff00ff']);
const successGradient = (0, gradient_string_1.default)(['#00ff88', '#00ccff', '#0099ff']);
async function runTalk(parsed, config, paths) {
    const [agentName] = parsed.commandArgs;
    if (!agentName) {
        console.error('Usage: genie talk <agent>');
        process.exit(1);
    }
    const baseUrl = process.env.FORGE_BASE_URL || 'http://localhost:8887';
    const logDir = path_1.default.join(process.cwd(), '.genie', 'state');
    // Start Forge if not running
    const forgeRunning = await (0, forge_manager_1.isForgeRunning)(baseUrl);
    if (!forgeRunning) {
        console.log('');
        process.stderr.write('Starting Forge... ');
        const startTime = Date.now();
        const result = (0, forge_manager_1.startForgeInBackground)({ baseUrl, logDir });
        if (!result.ok) {
            const error = 'error' in result ? result.error : new Error('Unknown error');
            console.error('');
            console.error('❌ Failed to start Forge');
            console.error(`   ${error.message}`);
            console.error(`   Check logs at ${logDir}/forge.log`);
            process.exit(1);
        }
        const ready = await (0, forge_manager_1.waitForForgeReady)(baseUrl, 60000, 500, false);
        if (!ready) {
            console.error('');
            console.error('❌ Forge did not start in time (60s)');
            console.error(`   Check logs at ${logDir}/forge.log`);
            process.exit(1);
        }
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        process.stderr.write(`ready (${elapsed}s)\n`);
    }
    // Show ready message
    console.log('');
    console.log(successGradient('━'.repeat(60)));
    console.log(successGradient('✨ Genie is ready and running! ✨'));
    console.log(successGradient('━'.repeat(60)));
    console.log('');
    console.log(genieGradient('Press Enter to open dashboard...'));
    // Countdown with Enter interrupt
    const opened = await waitForEnterOrTimeout(5000);
    console.log('');
    console.log(genieGradient('📊 Opening dashboard in browser...'));
    console.log('');
    // Open browser to dashboard
    const dashboardUrl = `${baseUrl}/dashboard`;
    openBrowser(dashboardUrl);
    // Exit (Forge stays running in background)
    console.log(successGradient('Forge is running in background. Use Ctrl+C in dashboard or run "genie stop" to shutdown.'));
    console.log('');
    process.exit(0);
}
/**
 * Wait for Enter key or timeout
 * Shows countdown if timeout will trigger
 */
async function waitForEnterOrTimeout(ms) {
    return new Promise((resolve) => {
        let countdown = Math.floor(ms / 1000);
        const timer = setInterval(() => {
            process.stderr.write(`\rOpening in ${countdown}s... (or press Enter now)`);
            countdown--;
            if (countdown < 0) {
                clearInterval(timer);
                cleanup();
                resolve('timeout');
            }
        }, 1000);
        const onData = () => {
            clearInterval(timer);
            cleanup();
            resolve('enter');
        };
        const cleanup = () => {
            process.stdin.removeListener('data', onData);
            process.stderr.write('\r' + ' '.repeat(50) + '\r'); // Clear countdown line
        };
        process.stdin.once('data', onData);
    });
}
/**
 * Open URL in default browser
 */
function openBrowser(url) {
    try {
        const platform = process.platform;
        const openCommand = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
        (0, child_process_1.execSync)(`${openCommand} "${url}"`, { stdio: 'ignore' });
    }
    catch {
        console.log(`Failed to open browser. Visit: ${url}`);
    }
}
