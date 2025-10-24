"use strict";
/**
 * First-Run Setup Wizard for Genie MCP Server
 *
 * Guides users through initial configuration including:
 * - Tunnel enablement
 * - ngrok token setup
 * - Auth token generation
 * - ChatGPT configuration
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runSetupWizard = runSetupWizard;
exports.isSetupNeeded = isSetupNeeded;
const readline_1 = __importDefault(require("readline"));
const config_manager_1 = require("./config-manager");
const tunnel_manager_1 = require("./tunnel-manager");
/**
 * Prompt user for input
 */
function createQuestion(rl, query) {
    return new Promise(resolve => {
        rl.question(query, resolve);
    });
}
/**
 * Run first-run setup wizard
 */
async function runSetupWizard() {
    const rl = readline_1.default.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    try {
        console.log('\n🧞 Genie MCP Server - First Run Setup\n');
        // Step 1: Ask about tunnel
        const tunnelResponse = await createQuestion(rl, '? Do you want to enable remote access via tunnel? (Y/n): ');
        const enableTunnel = tunnelResponse.toLowerCase() !== 'n' && tunnelResponse !== '';
        let ngrokToken = null;
        // Step 2: Ask for ngrok token if tunnel enabled
        if (enableTunnel) {
            console.log(`\nℹ️  Free ngrok account gives you a tunneled URL for ChatGPT integration.`);
            console.log(`   Get your free token at: ${(0, tunnel_manager_1.getNgrokSignupUrl)()}\n`);
            const token = await createQuestion(rl, '? Enter your ngrok authtoken (or press Enter to skip): ');
            if (token && (0, tunnel_manager_1.isValidNgrokToken)(token)) {
                ngrokToken = token;
                console.log('✓ Token saved');
            }
            else if (token) {
                console.log('⚠️  Invalid token format, tunnel will be skipped');
            }
            else {
                console.log('⚠️  Tunnel disabled (no token provided)');
            }
        }
        // Step 3: Create config with token
        const config = (0, config_manager_1.createDefaultConfig)(ngrokToken || undefined);
        (0, config_manager_1.saveConfig)(config);
        // Step 4: Show summary
        console.log('\n✓ Configuration saved to ~/.genie/config.yaml');
        console.log(`✓ MCP Auth token: ${config.mcp.auth.token}`);
        if (ngrokToken) {
            console.log('✓ Tunnel enabled (ngrok)');
        }
        else {
            console.log('ℹ️  Tunnel disabled (edit config to enable later)');
        }
        console.log('\n');
        return config;
    }
    finally {
        rl.close();
    }
}
/**
 * Check if setup is needed
 * Returns true if config file doesn't exist
 */
function isSetupNeeded() {
    try {
        const { loadConfig } = require('./config-manager');
        return loadConfig() === null;
    }
    catch {
        return true;
    }
}
