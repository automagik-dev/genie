/**
 * Unified Startup Display Formatter
 *
 * Formats the output shown to users when Genie starts with Forge + MCP
 * Displays connection info, auth tokens, tunnel URLs, and ChatGPT config
 */

import { GenieConfig } from './config-manager';

export interface StartupInfo {
  forgeUrl: string;
  mcpUrl: string;
  tunnelUrl?: string;
  authToken: string;
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
 * Format authentication info
 */
export function displayAuthInfo(token: string): string {
  let output = '🔑 Authentication\n\n';
  output += `  Bearer Token: ${token}\n`;
  output += `  Add to requests:\n`;
  output += `    Authorization: Bearer ${token}\n`;
  output += `\n`;

  return output;
}

/**
 * Format ChatGPT configuration
 */
export function displayChatGPTConfig(info: StartupInfo): string {
  const url = info.tunnelUrl || info.mcpUrl;

  const config = {
    mcpServers: {
      genie: {
        url: url.endsWith('/sse') ? url : `${url}/sse`,
        headers: {
          Authorization: `Bearer ${info.authToken}`
        }
      }
    }
  };

  let output = '💬 ChatGPT Configuration\n\n';
  output += `  Copy this to ChatGPT's config:\n\n`;
  output += '  ```json\n';
  output += JSON.stringify(config, null, 2)
    .split('\n')
    .map(line => `  ${line}`)
    .join('\n');
  output += '\n  ```\n\n';

  return output;
}

/**
 * Format complete startup information
 */
export function displayStartupInfo(info: StartupInfo, showChatGPT: boolean = true): string {
  let output = displayStartupBanner();
  output += displayServiceStatus(info);
  output += displayAuthInfo(info.authToken);

  if (showChatGPT) {
    output += displayChatGPTConfig(info);
  }

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
