/**
 * Configuration Manager for Genie MCP Server
 *
 * Handles loading and saving of ~/.genie/config.yaml with OAuth2.1 support:
 * - OAuth2 client credentials (client_id, client_secret)
 * - JWT signing keys (RSA key pair)
 * - Tunnel configuration
 * - Server settings
 */

import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import os from 'os';

export interface OAuth2Config {
  clientId: string;
  clientSecret: string;
  signingKey: string; // Private key for signing JWTs (PEM format)
  publicKey: string;  // Public key for verification (PEM format)
  tokenExpiry: number; // Token expiry in seconds (default: 3600)
  issuer: string;      // Token issuer (e.g., 'genie-mcp-server')
}

export interface AuthConfig {
  oauth2: OAuth2Config;
  created: string;
}

export interface TunnelConfig {
  enabled: boolean;
  provider: 'ngrok' | 'localtunnel' | 'cloudflare';
  token: string | null;
}

export interface ServerConfig {
  port: number;
  transport: 'httpStream' | 'stdio';
}

export interface MCPConfig {
  auth: AuthConfig;
  tunnel?: TunnelConfig;
  server: ServerConfig;
}

export interface GenieConfig {
  mcp: MCPConfig;
}

const CONFIG_FILE = path.join(os.homedir(), '.genie', 'config.yaml');

/**
 * Ensure config directory exists
 */
function ensureConfigDir(): void {
  const configDir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Load configuration from ~/.genie/config.yaml
 * Returns null if file doesn't exist
 */
export function loadConfig(): GenieConfig | null {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      return null;
    }

    const content = fs.readFileSync(CONFIG_FILE, 'utf8');
    const config = YAML.parse(content) as GenieConfig;

    // Validate required OAuth2 structure
    if (!config.mcp?.auth?.oauth2?.clientId) {
      throw new Error('Invalid config: missing OAuth2 configuration');
    }

    return config;
  } catch (error) {
    throw new Error(`Failed to load config: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Load OAuth2 config from config file
 * Returns null if not configured
 */
export function loadOAuth2Config(): OAuth2Config | null {
  try {
    const config = loadConfig();
    return config?.mcp?.auth?.oauth2 || null;
  } catch {
    return null;
  }
}

/**
 * Save configuration to ~/.genie/config.yaml
 * Sets restrictive permissions (0o600) for security
 */
export function saveConfig(config: GenieConfig): void {
  try {
    ensureConfigDir();

    // Convert to YAML
    const yaml = YAML.stringify(config);

    // Write with restrictive permissions for security
    fs.writeFileSync(CONFIG_FILE, yaml, { mode: 0o600 });
  } catch (error) {
    throw new Error(`Failed to save config: ${error instanceof Error ? error.message : String(error)}`);
  }
}


/**
 * Create default configuration with OAuth2.1 credentials (async)
 */
export async function createDefaultConfig(ngrokToken?: string): Promise<GenieConfig> {
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
          issuer: 'genie-mcp-server'
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
export async function loadOrCreateConfig(ngrokToken?: string): Promise<GenieConfig> {
  try {
    const existing = loadConfig();
    if (existing) {
      return existing;
    }
  } catch {
    // Config exists but is invalid, create new
  }

  const config = await createDefaultConfig(ngrokToken);
  saveConfig(config);
  return config;
}

/**
 * Get config file path (for display/debugging)
 */
export function getConfigPath(): string {
  return CONFIG_FILE;
}
