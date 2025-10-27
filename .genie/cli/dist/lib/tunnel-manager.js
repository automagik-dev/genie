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
// Store active listener for proper cleanup
let activeListener = null;
/**
 * Start ngrok tunnel for HTTP stream MCP server
 *
 * @param port - Local port to expose
 * @param authToken - Optional ngrok auth token (for better reliability and persistent URLs)
 * @returns Object with url (on success) or error details (on failure)
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
            return { error: '@ngrok/ngrok not installed', errorCode: 'NGROK_NOT_INSTALLED' };
        }
        // Kill any existing tunnel first (prevents "endpoint already online" errors)
        await stopNgrokTunnel();
        // Start tunnel (authtoken is optional - works without but with limitations)
        const forwardOptions = {
            addr: port,
            schemes: ['https']
        };
        // Only add authtoken if provided
        if (authToken) {
            forwardOptions.authtoken = authToken;
        }
        try {
            const listener = await ngrok.forward(forwardOptions);
            // Store listener globally for proper cleanup
            activeListener = listener;
            const url = listener.url();
            return { url };
        }
        catch (innerError) {
            const message = innerError instanceof Error ? innerError.message : String(innerError);
            // Detect ERR_NGROK_334 (endpoint already online from previous session)
            if (message.includes('ERR_NGROK_334') || message.includes('already online')) {
                console.error('🔧 Detected stuck tunnel session, forcing cleanup...');
                // Force aggressive cleanup
                await forceCleanupNgrokSession(ngrok, authToken);
                // Retry once after cleanup
                console.error('🔄 Retrying tunnel creation...');
                try {
                    const listener = await ngrok.forward(forwardOptions);
                    activeListener = listener;
                    const url = listener.url();
                    console.error('✅ Tunnel recovered successfully!');
                    return { url };
                }
                catch (retryError) {
                    const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
                    console.error(`❌ Cleanup retry failed: ${retryMessage}`);
                    // Return error with specific code so caller knows this is NOT a token issue
                    return {
                        error: retryMessage,
                        errorCode: 'ERR_NGROK_334'
                    };
                }
            }
            // Re-throw if not the "already online" error
            throw innerError;
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`⚠️  Failed to start ngrok tunnel: ${message}`);
        // Extract error code if present
        let errorCode = 'UNKNOWN';
        if (message.includes('ERR_NGROK_')) {
            const match = message.match(/ERR_NGROK_\d+/);
            if (match)
                errorCode = match[0];
        }
        return { error: message, errorCode };
    }
}
/**
 * Force aggressive cleanup of stuck ngrok sessions
 * Used when ERR_NGROK_334 is detected (endpoint already online)
 *
 * Strategy:
 * 1. Kill ngrok agent process first (most aggressive)
 * 2. Wait for ngrok backend to release endpoint (needs time)
 * 3. Multiple disconnect attempts with longer delays
 *
 * @param ngrok - ngrok SDK instance
 * @param authToken - ngrok auth token
 */
async function forceCleanupNgrokSession(ngrok, authToken) {
    try {
        // Strategy 1: Kill ngrok agent process (most aggressive)
        // This terminates all ngrok connections immediately
        try {
            await ngrok.kill();
            console.error('   ✓ Killed ngrok agent process');
        }
        catch (err) {
            // Ignore - may not be running
        }
        // Strategy 2: Wait for ngrok backend to release endpoint
        // ngrok needs time to process the kill signal and release endpoints
        // Testing shows 2-5 seconds is usually sufficient
        console.error('   ⏳ Waiting for ngrok backend to release endpoint...');
        await new Promise(resolve => setTimeout(resolve, 3000)); // 3 seconds
        // Strategy 3: Multiple disconnect attempts with longer delays
        // This ensures any leaked sessions are cleaned up
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await ngrok.disconnect();
                // Longer delay between attempts (total: 3 seconds)
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            catch (err) {
                // Ignore errors, keep trying
            }
        }
        console.error('   ✓ Cleanup complete (total wait: ~6 seconds)');
    }
    catch (error) {
        // Ignore all errors - we're forcing cleanup
    }
}
/**
 * Stop ngrok tunnel (properly closes listener and cleans up ngrok session)
 */
async function stopNgrokTunnel() {
    try {
        // Close specific listener if active
        if (activeListener) {
            try {
                await activeListener.close();
                activeListener = null;
            }
            catch (err) {
                // Ignore close errors
            }
        }
        // Also disconnect all sessions (catches any leaked sessions)
        let ngrok;
        try {
            ngrok = require('@ngrok/ngrok');
        }
        catch {
            return;
        }
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
