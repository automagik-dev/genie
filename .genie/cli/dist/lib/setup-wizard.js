"use strict";
/**
 * First-Run Setup Wizard for Genie MCP Server
 *
 * Guides users through initial configuration including:
 * - OAuth2.1 client credentials generation
 * - Tunnel enablement
 * - ngrok token setup
 * - Claude Desktop and ChatGPT configuration
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
        console.log('Generating OAuth2.1 credentials for secure authentication...\n');
        // Step 1: Ask about tunnel
        const tunnelResponse = await createQuestion(rl, '? Do you want to enable remote access via tunnel? (Y/n): ');
        const enableTunnel = tunnelResponse.toLowerCase() !== 'n' && tunnelResponse !== '';
        let ngrokToken = null;
        // Step 2: Ask for ngrok token if tunnel enabled
        if (enableTunnel) {
            console.log(`\nℹ️  Free ngrok account gives you a tunneled URL for Claude Desktop and ChatGPT.`);
            console.log(`   Get your free token at: ${(0, tunnel_manager_1.getNgrokSignupUrl)()}\n`);
            const token = await createQuestion(rl, '? Enter your ngrok authtoken (or press Enter to skip): ');
            if (token && (0, tunnel_manager_1.isValidNgrokToken)(token)) {
                ngrokToken = token;
                console.log('✓ ngrok token saved');
            }
            else if (token) {
                console.log('⚠️  Invalid token format, tunnel will be skipped');
            }
            else {
                console.log('⚠️  Tunnel disabled (no token provided)');
            }
        }
        // Step 3: Create config with OAuth2 credentials (async)
        console.log('\n⏳ Generating RSA key pair for JWT signing...');
        const config = await (0, config_manager_1.createDefaultConfig)(ngrokToken || undefined);
        (0, config_manager_1.saveConfig)(config);
        // Step 4: Show summary with OAuth2 credentials
        console.log('\n✅ Configuration complete!\n');
        console.log('📁 Config saved to: ~/.genie/config.yaml');
        console.log('\n🔐 OAuth2 Client Credentials:');
        console.log(`   Client ID:     ${config.mcp.auth.oauth2.clientId}`);
        console.log(`   Client Secret: ${config.mcp.auth.oauth2.clientSecret}`);
        console.log('\n⚠️  Keep these credentials secure! They provide full access to your MCP server.\n');
        if (ngrokToken) {
            console.log('✅ Tunnel enabled (ngrok)');
        }
        else {
            console.log('ℹ️  Tunnel disabled (edit ~/.genie/config.yaml to enable later)');
        }
        console.log('\n💡 Next: Run `npx automagik-genie` to start the server');
        console.log('   You\'ll receive connection details for Claude Desktop and ChatGPT.\n');
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
