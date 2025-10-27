/**
 * Tunnel Manager for Genie MCP Server
 *
 * Manages ngrok tunnel startup for remote access to MCP server
 * Handles auth token configuration and URL generation
 */

// Store active listener for proper cleanup
let activeListener: any = null;

/**
 * Start ngrok tunnel for HTTP stream MCP server
 *
 * @param port - Local port to expose
 * @param authToken - Optional ngrok auth token (for better reliability and persistent URLs)
 * @returns Tunnel URL or null if failed
 */
export async function startNgrokTunnel(port: number, authToken?: string): Promise<string | null> {
  try {
    // Dynamically import ngrok (may not be installed)
    let ngrok: any;
    try {
      ngrok = require('@ngrok/ngrok');
    } catch {
      // ngrok not installed
      console.warn('⚠️  @ngrok/ngrok not installed, skipping tunnel');
      return null;
    }

    // Kill any existing tunnel first (prevents "endpoint already online" errors)
    await stopNgrokTunnel();

    // Start tunnel (authtoken is optional - works without but with limitations)
    const forwardOptions: any = {
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
      return url;
    } catch (innerError) {
      const message = innerError instanceof Error ? innerError.message : String(innerError);

      // Detect ERR_NGROK_334 (endpoint already online from previous session)
      if (message.includes('ERR_NGROK_334') || message.includes('already online')) {
        console.error('🔧 Detected stuck tunnel session, forcing cleanup...');

        // Force aggressive cleanup
        await forceCleanupNgrokSession(ngrok, authToken);

        // Retry once after cleanup
        console.error('🔄 Retrying tunnel creation...');
        const listener = await ngrok.forward(forwardOptions);
        activeListener = listener;
        const url = listener.url();

        console.error('✅ Tunnel recovered successfully!');
        return url;
      }

      // Re-throw if not the "already online" error
      throw innerError;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️  Failed to start ngrok tunnel: ${message}`);
    return null;
  }
}

/**
 * Force aggressive cleanup of stuck ngrok sessions
 * Used when ERR_NGROK_334 is detected (endpoint already online)
 *
 * @param ngrok - ngrok SDK instance
 * @param authToken - ngrok auth token
 */
async function forceCleanupNgrokSession(ngrok: any, authToken?: string): Promise<void> {
  try {
    // Multiple disconnect attempts to ensure cleanup
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await ngrok.disconnect();
        // Small delay between attempts
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (err) {
        // Ignore errors, keep trying
      }
    }

    // If we have an auth token, try killing all sessions explicitly
    if (authToken) {
      try {
        await ngrok.kill();
      } catch (err) {
        // Ignore errors
      }
    }

    // Final disconnect
    await ngrok.disconnect();
  } catch (error) {
    // Ignore all errors - we're forcing cleanup
  }
}

/**
 * Stop ngrok tunnel (properly closes listener and cleans up ngrok session)
 */
export async function stopNgrokTunnel(): Promise<void> {
  try {
    // Close specific listener if active
    if (activeListener) {
      try {
        await activeListener.close();
        activeListener = null;
      } catch (err) {
        // Ignore close errors
      }
    }

    // Also disconnect all sessions (catches any leaked sessions)
    let ngrok: any;
    try {
      ngrok = require('@ngrok/ngrok');
    } catch {
      return;
    }

    await ngrok.disconnect();
  } catch (error) {
    // Ignore errors on disconnect
  }
}

/**
 * Validate ngrok auth token format
 * Token format: 2<digit>_<alphanumeric>
 */
export function isValidNgrokToken(token: string): boolean {
  // ngrok tokens typically start with 2 followed by a digit
  return /^2\w_[A-Za-z0-9_-]+$/.test(token);
}

/**
 * Get ngrok signup URL for user to get token
 */
export function getNgrokSignupUrl(): string {
  return 'https://ngrok.com/signup';
}
