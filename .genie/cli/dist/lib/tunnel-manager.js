"use strict";
/**
 * Tunnel Manager for Genie MCP Server
 *
 * Manages ngrok tunnel startup for remote access to MCP server
 * Handles auth token configuration and URL generation
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.startNgrokTunnel = startNgrokTunnel;
exports.stopNgrokTunnel = stopNgrokTunnel;
exports.isValidNgrokToken = isValidNgrokToken;
exports.getNgrokSignupUrl = getNgrokSignupUrl;
/**
 * Start ngrok tunnel for HTTP stream MCP server
 *
 * @param port - Local port to expose
 * @param authToken - Optional ngrok auth token (for better reliability and persistent URLs)
 * @returns Tunnel URL or null if failed
 */
async function startNgrokTunnel(port, authToken) {
    try {
        // Dynamically import ngrok (may not be installed)
        let ngrok;
        try {
            ngrok = require('@ngrok/ngrok');
        }
        catch {
            // ngrok not installed
            console.warn('⚠️  @ngrok/ngrok not installed, skipping tunnel');
            return null;
        }
        // Start tunnel (authtoken is optional - works without but with limitations)
        const forwardOptions = {
            addr: port,
            schemes: ['https']
        };
        // Only add authtoken if provided
        if (authToken) {
            forwardOptions.authtoken = authToken;
        }
        const listener = await ngrok.forward(forwardOptions);
        const url = listener.url();
        return url;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`⚠️  Failed to start ngrok tunnel: ${message}`);
        return null;
    }
}
/**
 * Stop ngrok tunnel
 */
async function stopNgrokTunnel() {
    try {
        let ngrok;
        try {
            ngrok = require('@ngrok/ngrok');
        }
        catch {
            return;
        }
        // Close all ngrok connections
        await ngrok.disconnect();
    }
    catch (error) {
        // Ignore errors on disconnect
    }
}
/**
 * Validate ngrok auth token format
 * Token format: 2<digit>_<alphanumeric>
 */
function isValidNgrokToken(token) {
    // ngrok tokens typically start with 2 followed by a digit
    return /^2\w_[A-Za-z0-9_-]+$/.test(token);
}
/**
 * Get ngrok signup URL for user to get token
 */
function getNgrokSignupUrl() {
    return 'https://ngrok.com/signup';
}
