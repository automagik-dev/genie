/**
 * Configuration Manager for Genie MCP Server
 *
 * Handles loading and saving of ~/.genie/config.yaml with support for:
 * - MCP auth tokens
 * - Tunnel configuration
 * - Server settings
 */

import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import os from 'os';

export interface AuthConfig {
  token: string;
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

    // Validate required structure
    if (!config.mcp || !config.mcp.auth || !config.mcp.auth.token) {
      throw new Error('Invalid config: missing mcp.auth.token');
    }

    return config;
  } catch (error) {
    throw new Error(`Failed to load config: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Load auth token from config, or return null if not configured
 */
export function loadAuthToken(): string | null {
  try {
    const config = loadConfig();
    return config?.mcp?.auth?.token || null;
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
 * Create default configuration with generated auth token
 */
export function createDefaultConfig(ngrokToken?: string): GenieConfig {
  const { generateToken } = require('./auth-token');

  return {
    mcp: {
      auth: {
        token: generateToken(),
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
 * Load or create config
 * Returns existing config if present, creates default if missing
 */
export function loadOrCreateConfig(ngrokToken?: string): GenieConfig {
  try {
    const existing = loadConfig();
    if (existing) {
      return existing;
    }
  } catch {
    // Config exists but is invalid, create new
  }

  const config = createDefaultConfig(ngrokToken);
  saveConfig(config);
  return config;
}

/**
 * Get config file path (for display/debugging)
 */
export function getConfigPath(): string {
  return CONFIG_FILE;
}
