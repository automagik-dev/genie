"use strict";
/**
 * Talk Command - Interactive browser session with agent
 *
 * Creates a Forge task for the agent and opens it in browser.
 * Similar to 'genie run' but opens browser instead of waiting in terminal.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runTalk = runTalk;
const forge_manager_1 = require("../lib/forge-manager");
const agent_resolver_1 = require("../lib/agent-resolver");
const session_store_1 = require("../session-store");
const forge_executor_1 = require("../lib/forge-executor");
const forge_helpers_1 = require("../lib/forge-helpers");
const executor_registry_1 = require("../lib/executor-registry");
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const gradient_string_1 = __importDefault(require("gradient-string"));
const fs_1 = __importDefault(require("fs"));
// Genie-themed gradients
const genieGradient = (0, gradient_string_1.default)(['#0066ff', '#9933ff', '#ff00ff']);
const successGradient = (0, gradient_string_1.default)(['#00ff88', '#00ccff', '#0099ff']);
async function runTalk(parsed, config, paths) {
    const [agentName, ...promptParts] = parsed.commandArgs;
    if (!agentName) {
        console.error('Usage: genie talk <agent> ["<prompt>"]');
        process.exit(1);
    }
    const prompt = promptParts.join(' ').trim() || `Start interactive session with ${agentName}`;
    const resolvedAgentName = (0, agent_resolver_1.resolveAgentIdentifier)(agentName);
    const agentSpec = (0, agent_resolver_1.loadAgentSpec)(resolvedAgentName);
    const agentGenie = agentSpec.meta?.genie || {};
    // Resolve executor configuration
    const executorKey = (0, executor_registry_1.normalizeExecutorKeyOrDefault)(agentGenie.executor || config.defaults?.executor);
    const executorVariant = (agentGenie.executorVariant ||
        agentGenie.variant ||
        config.defaults?.executorVariant ||
        'DEFAULT').trim().toUpperCase();
    const model = agentGenie.model || config.defaults?.model;
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
    // Create Forge session
    const forgeExecutor = (0, forge_executor_1.createForgeExecutor)();
    try {
        await forgeExecutor.syncProfiles(config.forge?.executors);
    }
    catch (error) {
        const reason = (0, forge_helpers_1.describeForgeError)(error);
        console.warn(`⚠️  Failed to sync agent profiles to Forge: ${reason}`);
    }
    let sessionResult;
    try {
        sessionResult = await forgeExecutor.createSession({
            agentName: resolvedAgentName,
            prompt,
            executorKey,
            executorVariant,
            executionMode: 'interactive',
            model
        });
    }
    catch (error) {
        const reason = (0, forge_helpers_1.describeForgeError)(error);
        console.error(`❌ Failed to create session: ${reason}`);
        console.error(`   ${forge_helpers_1.FORGE_RECOVERY_HINT}`);
        process.exit(1);
    }
    const sessionName = parsed.options.name || (0, session_store_1.generateSessionName)(resolvedAgentName);
    const now = new Date().toISOString();
    // Save session to state (optional for talk mode)
    // Session will be tracked in Forge, this is for 'genie list' compatibility
    // Show success message
    console.log('');
    console.log(successGradient('━'.repeat(60)));
    console.log(successGradient(`✨ ${resolvedAgentName} session ready! ✨`));
    console.log(successGradient('━'.repeat(60)));
    console.log('');
    console.log(`📊 Opening task in browser...`);
    console.log('');
    // Open browser to task URL using Forge's cross-platform logic
    openBrowserCrossPlatform(sessionResult.forgeUrl);
    // Exit cleanly (Forge stays running in background)
    console.log(successGradient('✅ Session started in Forge.'));
    console.log('');
    process.exitCode = 0;
}
/**
 * Open URL in browser using cross-platform logic (including WSL support)
 * Based on Forge's browser opening strategy
 */
function openBrowserCrossPlatform(url) {
    try {
        const platform = process.platform;
        if (platform === 'darwin') {
            // macOS
            (0, child_process_1.execSync)(`open "${url}"`, { stdio: 'ignore' });
        }
        else if (platform === 'win32') {
            // Windows
            (0, child_process_1.spawn)('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
        }
        else if (platform === 'linux') {
            // Check if running in WSL
            const isWSL = fs_1.default.existsSync('/proc/version') &&
                fs_1.default.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
            if (isWSL) {
                // WSL: Use Windows browser via cmd.exe
                try {
                    (0, child_process_1.execSync)(`cmd.exe /c start "" "${url}"`, { stdio: 'ignore' });
                }
                catch {
                    // Fallback to wslview if cmd.exe fails
                    try {
                        (0, child_process_1.execSync)(`wslview "${url}"`, { stdio: 'ignore' });
                    }
                    catch {
                        // Last resort: Linux browser
                        (0, child_process_1.execSync)(`xdg-open "${url}"`, { stdio: 'ignore' });
                    }
                }
            }
            else {
                // Native Linux
                (0, child_process_1.execSync)(`xdg-open "${url}"`, { stdio: 'ignore' });
            }
        }
        else {
            // Unknown platform, try xdg-open
            (0, child_process_1.execSync)(`xdg-open "${url}"`, { stdio: 'ignore' });
        }
    }
    catch (error) {
        console.log(`⚠️  Failed to open browser automatically.`);
        console.log(`   Visit: ${url}`);
    }
}
