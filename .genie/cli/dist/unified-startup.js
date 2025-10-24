#!/usr/bin/env node
"use strict";
/**
 * Unified Genie MCP Startup
 *
 * Orchestrates starting Forge backend and MCP server together with:
 * - Auth token generation on first run
 * - Graceful shutdown handling
 * - Unified status output
 * - Optional tunnel setup
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startGenie = startGenie;
const child_process_1 = require("child_process");
const path_1 = __importDefault(require("path"));
const config_manager_1 = require("./lib/config-manager");
const startup_display_1 = require("./lib/startup-display");
const forge_manager_1 = require("./lib/forge-manager");
const setup_wizard_1 = require("./lib/setup-wizard");
const tunnel_manager_1 = require("./lib/tunnel-manager");
const DEFAULT_FORGE_URL = 'http://localhost:8887';
const DEFAULT_MCP_URL = 'http://localhost:8885/sse';
/**
 * Main unified startup function
 */
async function startGenie() {
    const logDir = path_1.default.join(process.cwd(), '.genie', 'state');
    let tunnelUrl = null;
    try {
        // Step 1: Run setup wizard if needed
        let config = await (async () => {
            if ((0, setup_wizard_1.isSetupNeeded)()) {
                return await (0, setup_wizard_1.runSetupWizard)();
            }
            else {
                return (0, config_manager_1.loadOrCreateConfig)();
            }
        })();
        console.error('🧞 Starting Genie...\n');
        const mcpConfig = config.mcp;
        const authToken = mcpConfig.auth.token;
        // Step 2: Start Forge in background
        console.error('📦 Starting Forge backend...');
        const forgeResult = (0, forge_manager_1.startForgeInBackground)({ logDir });
        if (!forgeResult.ok) {
            const errorMsg = forgeResult.error?.message || 'Unknown error';
            console.error((0, startup_display_1.displayStartupError)('Forge', errorMsg));
            process.exit(1);
        }
        // Step 3: Wait for Forge to be ready
        console.error('⏳ Waiting for Forge to be ready...');
        const forgeReady = await (0, forge_manager_1.waitForForgeReady)(DEFAULT_FORGE_URL, 15000, 500, true);
        if (!forgeReady) {
            (0, forge_manager_1.killForgeProcess)();
            console.error((0, startup_display_1.displayStartupError)('Forge', 'Health check timeout (15s)'));
            console.error(`📋 Check logs: ${path_1.default.join(logDir, 'forge.log')}`);
            process.exit(1);
        }
        // Step 4: Start MCP server via subprocess
        console.error('📡 Starting MCP server...');
        const mcpProcess = (0, child_process_1.spawn)('node', [
            path_1.default.join(__dirname, '..', 'mcp', 'dist', 'server.js')
        ], {
            env: {
                ...process.env,
                MCP_PORT: String(mcpConfig.server.port),
                MCP_TRANSPORT: mcpConfig.server.transport
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        // Wait a bit for MCP to start (health check would be better)
        await new Promise(resolve => setTimeout(resolve, 2000));
        // Check if MCP process crashed immediately
        if (mcpProcess.exitCode !== null) {
            (0, forge_manager_1.killForgeProcess)();
            console.error((0, startup_display_1.displayStartupError)('MCP', `Process exited with code ${mcpProcess.exitCode}`));
            process.exit(1);
        }
        // Step 5: Start tunnel if configured
        if (mcpConfig.tunnel?.enabled && mcpConfig.tunnel?.token) {
            console.error('🌐 Starting ngrok tunnel...');
            tunnelUrl = await (0, tunnel_manager_1.startNgrokTunnel)(mcpConfig.server.port, mcpConfig.tunnel.token);
            if (tunnelUrl) {
                console.error(`🌐 Tunnel ready: ${tunnelUrl}`);
            }
            else {
                console.error('⚠️  Tunnel startup failed, continuing without tunnel');
            }
        }
        // Step 6: Display startup info
        const startupInfo = {
            forgeUrl: DEFAULT_FORGE_URL,
            mcpUrl: DEFAULT_MCP_URL,
            tunnelUrl: tunnelUrl || undefined,
            authToken: authToken,
            configPath: (0, config_manager_1.getConfigPath)()
        };
        console.log((0, startup_display_1.displayStartupInfo)(startupInfo));
        // Step 7: Setup graceful shutdown
        process.on('SIGINT', async () => {
            console.error((0, startup_display_1.displayShutdownMessage)());
            // Stop tunnel if running
            if (tunnelUrl) {
                try {
                    await (0, tunnel_manager_1.stopNgrokTunnel)();
                }
                catch {
                    // Ignore errors
                }
            }
            // Kill MCP process
            try {
                mcpProcess.kill('SIGTERM');
            }
            catch {
                // Already dead
            }
            // Stop Forge
            try {
                await (0, forge_manager_1.stopForge)(logDir);
            }
            catch {
                (0, forge_manager_1.killForgeProcess)();
            }
            console.error((0, startup_display_1.displayShutdownComplete)());
            process.exit(0);
        });
        // Handle MCP process exit
        mcpProcess.on('exit', (code, signal) => {
            if (code !== 0) {
                console.error(`\n⚠️  MCP process exited (code ${code}, signal ${signal})`);
            }
        });
        // Let process run until Ctrl+C
        await new Promise(() => {
            // Never resolves - waits for signal
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`\n❌ Startup failed: ${message}\n`);
        process.exit(1);
    }
}
// Run startup if executed directly
if (require.main === module) {
    startGenie().catch(error => {
        console.error(`Fatal error: ${error.message}`);
        process.exit(1);
    });
}
exports.default = startGenie;
