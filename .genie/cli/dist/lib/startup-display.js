"use strict";
/**
 * Unified Startup Display Formatter
 *
 * Formats the output shown to users when Genie starts with Forge + MCP
 * Displays connection info, auth tokens, tunnel URLs, and ChatGPT config
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.displayStartupBanner = displayStartupBanner;
exports.displayServiceStatus = displayServiceStatus;
exports.displayAuthInfo = displayAuthInfo;
exports.displayChatGPTConfig = displayChatGPTConfig;
exports.displayStartupInfo = displayStartupInfo;
exports.displayStartupError = displayStartupError;
exports.displayShutdownMessage = displayShutdownMessage;
exports.displayShutdownComplete = displayShutdownComplete;
exports.displayTunnelStatus = displayTunnelStatus;
exports.displayProgress = displayProgress;
/**
 * Format startup banner
 */
function displayStartupBanner() {
    return `
🧞 Genie MCP Server

`;
}
/**
 * Format service status
 */
function displayServiceStatus(info) {
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
function displayAuthInfo(token) {
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
function displayChatGPTConfig(info) {
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
function displayStartupInfo(info, showChatGPT = true) {
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
function displayStartupError(service, error) {
    return `❌ Failed to start ${service}\n\nError: ${error}\n`;
}
/**
 * Format shutdown message
 */
function displayShutdownMessage() {
    return '\n🛑 Shutting down services...\n';
}
/**
 * Format shutdown complete message
 */
function displayShutdownComplete() {
    return '✅ All services stopped\n';
}
/**
 * Format tunnel status
 */
function displayTunnelStatus(enabled, url, error) {
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
function displayProgress(message) {
    const spinners = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    const spinner = spinners[Math.floor(Date.now() / 80) % spinners.length];
    return `${spinner} ${message}`;
}
