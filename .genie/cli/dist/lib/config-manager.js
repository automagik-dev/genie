"use strict";
/**
 * Configuration Manager for Genie MCP Server
 *
 * Handles loading and saving of ~/.genie/config.yaml with OAuth2.1 support:
 * - OAuth2 client credentials (client_id, client_secret)
 * - JWT signing keys (RSA key pair)
 * - Tunnel configuration
 * - Server settings
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadConfig = loadConfig;
exports.loadOAuth2Config = loadOAuth2Config;
exports.saveConfig = saveConfig;
exports.createDefaultConfig = createDefaultConfig;
exports.loadOrCreateConfig = loadOrCreateConfig;
exports.getConfigPath = getConfigPath;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const yaml_1 = __importDefault(require("yaml"));
const os_1 = __importDefault(require("os"));
const CONFIG_FILE = path_1.default.join(os_1.default.homedir(), '.genie', 'config.yaml');
/**
 * Ensure config directory exists
 */
function ensureConfigDir() {
    const configDir = path_1.default.dirname(CONFIG_FILE);
    if (!fs_1.default.existsSync(configDir)) {
        fs_1.default.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    }
}
/**
 * Load configuration from ~/.genie/config.yaml
 * Returns null if file doesn't exist
 */
function loadConfig() {
    try {
        if (!fs_1.default.existsSync(CONFIG_FILE)) {
            return null;
        }
        const content = fs_1.default.readFileSync(CONFIG_FILE, 'utf8');
        const config = yaml_1.default.parse(content);
        // Validate required OAuth2 structure
        if (!config.mcp?.auth?.oauth2?.clientId) {
            throw new Error('Invalid config: missing OAuth2 configuration');
        }
        return config;
    }
    catch (error) {
        throw new Error(`Failed to load config: ${error instanceof Error ? error.message : String(error)}`);
    }
}
/**
 * Load OAuth2 config from config file
 * Returns null if not configured
 */
function loadOAuth2Config() {
    try {
        const config = loadConfig();
        return config?.mcp?.auth?.oauth2 || null;
    }
    catch {
        return null;
    }
}
/**
 * Save configuration to ~/.genie/config.yaml
 * Sets restrictive permissions (0o600) for security
 */
function saveConfig(config) {
    try {
        ensureConfigDir();
        // Convert to YAML
        const yaml = yaml_1.default.stringify(config);
        // Write with restrictive permissions for security
        fs_1.default.writeFileSync(CONFIG_FILE, yaml, { mode: 0o600 });
    }
    catch (error) {
        throw new Error(`Failed to save config: ${error instanceof Error ? error.message : String(error)}`);
    }
}
/**
 * Generate random 6-digit PIN
 */
function generatePin() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}
/**
 * Create default configuration with OAuth2.1 credentials (async)
 */
async function createDefaultConfig(ngrokToken) {
    const oauth2Utils = require('./oauth2-utils');
    const { clientId, clientSecret } = oauth2Utils.generateClientCredentials();
    const { privateKey, publicKey } = await oauth2Utils.generateKeyPair();
    return {
        mcp: {
            auth: {
                oauth2: {
                    clientId,
                    clientSecret,
                    signingKey: privateKey,
                    publicKey: publicKey,
                    tokenExpiry: 3600, // 1 hour
                    issuer: 'genie-mcp-server',
                    pin: generatePin() // Random 6-digit PIN for OAuth consent
                },
                created: new Date().toISOString()
            },
            tunnel: {
                enabled: !!ngrokToken,
                provider: 'ngrok',
                token: ngrokToken || null
            },
            server: {
                port: 8885,
                transport: 'httpStream'
            }
        }
    };
}
/**
 * Load or create config (async)
 * Returns existing config if present, creates default if missing
 */
async function loadOrCreateConfig(ngrokToken) {
    try {
        const existing = loadConfig();
        if (existing) {
            return existing;
        }
    }
    catch {
        // Config exists but is invalid, create new
    }
    const config = await createDefaultConfig(ngrokToken);
    saveConfig(config);
    return config;
}
/**
 * Get config file path (for display/debugging)
 */
function getConfigPath() {
    return CONFIG_FILE;
}
