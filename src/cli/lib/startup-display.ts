/**
 * Unified Startup Display Formatter
 *
 * Formats the output shown to users when Genie starts with Forge + MCP
 * Displays connection info, OAuth2 credentials, tunnel URLs, and client setup instructions
 */

import { OAuth2Config } from './config-manager';

export interface StartupInfo {
  forgeUrl: string;
  mcpUrl: string;
  tunnelUrl?: string;
  oauth2: OAuth2Config;
  configPath: string;
}

/**
 * Format startup banner
 */
export function displayStartupBanner(): string {
  return `
🧞 Genie MCP Server

`;
}

/**
 * Format service status
 */
export function displayServiceStatus(info: StartupInfo): string {
  let output = '📦 Services Ready\n\n';

  output += `  📦 Forge:  ${info.forgeUrl} ✓\n`;
  output += `  📡 MCP:    ${info.mcpUrl} ✓\n`;

  if (info.tunnelUrl) {
    output += `  🌐 Tunnel: ${info.tunnelUrl}\n`;
  }

  output += `\n`;

  return output;
}

/**
 * Format OAuth2 authentication info
 */
export function displayOAuth2Info(oauth2: OAuth2Config, tokenEndpoint: string): string {
  let output = '🔐 OAuth2 Authentication\n\n';
  output += `  Client ID:     ${oauth2.clientId}\n`;
  output += `  Client Secret: ${oauth2.clientSecret}\n`;
  output += `  Token Endpoint: ${tokenEndpoint}\n`;
  output += `\n`;
  output += `  💡 To get an access token:\n`;
  output += `     curl -X POST ${tokenEndpoint} \\\n`;
  output += `       -H "Content-Type: application/x-www-form-urlencoded" \\\n`;
  output += `       -d "grant_type=client_credentials&client_id=${oauth2.clientId}&client_secret=${oauth2.clientSecret}"\n`;
  output += `\n`;

  return output;
}

/**
 * Format Claude Desktop configuration
 */
export function displayClaudeConfig(info: StartupInfo): string {
  const serverUrl = info.tunnelUrl || info.mcpUrl.replace('/sse', '');

  let output = '💻 Claude Desktop Setup\n\n';
  output += `  1. Open Claude Desktop Settings → Connectors\n`;
  output += `  2. Click "Add custom connector"\n`;
  output += `  3. Enter these details:\n\n`;
  output += `     Name: Genie\n`;
  output += `     Remote MCP server URL: ${serverUrl}/sse\n`;
  output += `     OAuth Client ID: ${info.oauth2.clientId}\n`;
  output += `     OAuth Client Secret: ${info.oauth2.clientSecret}\n`;
  output += `\n`;
  output += `  4. Click "Add" and test the connection\n\n`;

  return output;
}

/**
 * Format ChatGPT configuration
 */
export function displayChatGPTConfig(info: StartupInfo): string {
  const serverUrl = info.tunnelUrl || info.mcpUrl.replace('/sse', '');

  let output = '💬 ChatGPT Setup\n\n';
  output += `  1. Go to ChatGPT Settings → Integrations\n`;
  output += `  2. Add new MCP server with OAuth2:\n\n`;
  output += `     Server URL: ${serverUrl}/sse\n`;
  output += `     Auth Type: OAuth 2.0 Client Credentials\n`;
  output += `     Token URL: ${serverUrl}/oauth/token\n`;
  output += `     Client ID: ${info.oauth2.clientId}\n`;
  output += `     Client Secret: ${info.oauth2.clientSecret}\n`;
  output += `\n`;

  return output;
}

/**
 * Format complete startup information
 */
export function displayStartupInfo(info: StartupInfo): string {
  const serverUrl = info.tunnelUrl || info.mcpUrl.replace('/sse', '');
  const tokenEndpoint = `${serverUrl}/oauth/token`;

  let output = displayStartupBanner();
  output += displayServiceStatus(info);
  output += displayOAuth2Info(info.oauth2, tokenEndpoint);
  output += displayClaudeConfig(info);
  output += displayChatGPTConfig(info);
  output += '═══════════════════════════════════════════════════════════════\n\n';
  output += 'Press Ctrl+C to stop\n';

  return output;
}

/**
 * Format error message for service startup failures
 */
export function displayStartupError(service: 'Forge' | 'MCP', error: string): string {
  return `❌ Failed to start ${service}\n\nError: ${error}\n`;
}

/**
 * Format shutdown message
 */
export function displayShutdownMessage(): string {
  return '\n🛑 Shutting down services...\n';
}

/**
 * Format shutdown complete message
 */
export function displayShutdownComplete(): string {
  return '✅ All services stopped\n';
}

/**
 * Format tunnel status
 */
export function displayTunnelStatus(enabled: boolean, url?: string, error?: string): string {
  if (!enabled) {
    return '🌐 Tunnel: Disabled\n';
  }

  if (error) {
    return `⚠️  Tunnel: Failed to start (${error})\n`;
  }

  if (url) {
    return `🌐 Tunnel: ${url}\n`;
  }

  return '🌐 Tunnel: Starting...\n';
}

/**
 * Format progress indicator with spinner
 */
export function displayProgress(message: string): string {
  const spinners = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const spinner = spinners[Math.floor(Date.now() / 80) % spinners.length];
  return `${spinner} ${message}`;
}
