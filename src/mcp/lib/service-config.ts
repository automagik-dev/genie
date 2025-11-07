/**
 * Unified Service Configuration Resolver
 *
 * Single source of truth for all service port configuration.
 * Provides consistent port resolution across Forge backend and Genie MCP server.
 */

export interface ServiceConfig {
  forge: {
    port: number;
    baseUrl: string;
    token?: string;
  };
  mcp: {
    port: number;
    baseUrl: string;
    sseUrl: string;
  };
}

/**
 * Get complete service configuration for both Forge and MCP.
 *
 * Environment Variables (in order of precedence):
 * - FORGE_BASE_URL: Complete Forge URL override (ignores FORGE_PORT/FORGE_HOST)
 * - FORGE_HOST: Custom host (default: localhost)
 * - FORGE_PORT: Custom Forge port (default: 8887)
 * - MCP_HOST: Custom MCP host (default: localhost)
 * - MCP_PORT: Custom MCP port (default: 8885)
 *
 * @returns Complete service configuration
 */
export function getServiceConfig(): ServiceConfig {
  // Forge configuration with URL override support
  let forgePort = 8887;
  let forgeHost = 'localhost';
  let forgeBaseUrl = `http://${forgeHost}:${forgePort}`;

  if (process.env.FORGE_BASE_URL) {
    // Explicit URL override - extract port and host, use as-is
    try {
      const url = new URL(process.env.FORGE_BASE_URL);
      forgePort = parseInt(url.port || '8887', 10);
      forgeHost = url.hostname;
      forgeBaseUrl = process.env.FORGE_BASE_URL;
    } catch {
      // Invalid URL, fall through to port-based config
    }
  }

  if (!process.env.FORGE_BASE_URL) {
    // Dynamic host and port configuration
    forgeHost = process.env.FORGE_HOST || process.env.HOST || 'localhost';
    forgePort = parseInt(process.env.FORGE_PORT || '8887', 10);
    forgeBaseUrl = `http://${forgeHost}:${forgePort}`;
  }

  // MCP configuration (simple host + port based)
  const mcpHost = process.env.MCP_HOST || process.env.HOST || 'localhost';
  const mcpPort = parseInt(process.env.MCP_PORT || '8885', 10);
  const mcpBaseUrl = `http://${mcpHost}:${mcpPort}`;

  return {
    forge: {
      port: forgePort,
      baseUrl: forgeBaseUrl,
      token: process.env.FORGE_TOKEN
    },
    mcp: {
      port: mcpPort,
      baseUrl: mcpBaseUrl,
      sseUrl: `${mcpBaseUrl}/sse`
    }
  };
}

/**
 * Get Forge-specific configuration.
 * Convenience wrapper for getServiceConfig().forge
 */
export function getForgeConfig() {
  return getServiceConfig().forge;
}

/**
 * Get MCP-specific configuration.
 * Convenience wrapper for getServiceConfig().mcp
 */
export function getMcpConfig() {
  return getServiceConfig().mcp;
}
