#!/usr/bin/env node
/**
 * Unified Genie MCP Startup
 *
 * Orchestrates starting Forge backend and MCP server together with:
 * - Auth token generation on first run
 * - Graceful shutdown handling
 * - Unified status output
 * - Optional tunnel setup
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { loadOrCreateConfig, getConfigPath, MCPConfig } from './lib/config-manager';
import {
  displayStartupInfo,
  displayStartupError,
  displayShutdownMessage,
  displayShutdownComplete,
  StartupInfo
} from './lib/startup-display';
import { startForgeInBackground, waitForForgeReady, killForgeProcess, stopForge } from './lib/forge-manager';
import { runSetupWizard, isSetupNeeded } from './lib/setup-wizard';
import { startNgrokTunnel, stopNgrokTunnel } from './lib/tunnel-manager';

const DEFAULT_FORGE_URL = 'http://localhost:8887';
const DEFAULT_MCP_URL = 'http://localhost:8885/sse';

/**
 * Main unified startup function
 */
export async function startGenie(): Promise<void> {
  const logDir = path.join(process.cwd(), '.genie', 'state');
  let tunnelUrl: string | null = null;

  try {
    // Step 1: Run setup wizard if needed
    let config = await (async () => {
      if (isSetupNeeded()) {
        return await runSetupWizard();
      } else {
        return loadOrCreateConfig();
      }
    })();

    console.error('🧞 Starting Genie...\n');

    const mcpConfig = config.mcp;
    const authToken = mcpConfig.auth.token;

    // Step 2: Start Forge in background
    console.error('📦 Starting Forge backend...');
    const forgeResult = startForgeInBackground({ logDir });

    if (!forgeResult.ok) {
      const errorMsg = (forgeResult as any).error?.message || 'Unknown error';
      console.error(displayStartupError('Forge', errorMsg));
      process.exit(1);
    }

    // Step 3: Wait for Forge to be ready
    console.error('⏳ Waiting for Forge to be ready...');
    const forgeReady = await waitForForgeReady(DEFAULT_FORGE_URL, 15000, 500, true);

    if (!forgeReady) {
      killForgeProcess();
      console.error(displayStartupError('Forge', 'Health check timeout (15s)'));
      console.error(`📋 Check logs: ${path.join(logDir, 'forge.log')}`);
      process.exit(1);
    }

    // Step 4: Start MCP server via subprocess
    console.error('📡 Starting MCP server...');
    const mcpProcess = spawn('node', [
      path.join(__dirname, '..', 'mcp', 'dist', 'server.js')
    ], {
      env: {
        ...process.env,
        MCP_PORT: String(mcpConfig.server.port),
        MCP_TRANSPORT: mcpConfig.server.transport
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // Wait a bit for MCP to start (health check would be better)
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Check if MCP process crashed immediately
    if (mcpProcess.exitCode !== null) {
      killForgeProcess();
      console.error(displayStartupError('MCP', `Process exited with code ${mcpProcess.exitCode}`));
      process.exit(1);
    }

    // Step 5: Start tunnel if configured
    if (mcpConfig.tunnel?.enabled && mcpConfig.tunnel?.token) {
      console.error('🌐 Starting ngrok tunnel...');
      tunnelUrl = await startNgrokTunnel(mcpConfig.server.port, mcpConfig.tunnel.token);
      if (tunnelUrl) {
        console.error(`🌐 Tunnel ready: ${tunnelUrl}`);
      } else {
        console.error('⚠️  Tunnel startup failed, continuing without tunnel');
      }
    }

    // Step 6: Display startup info
    const startupInfo: StartupInfo = {
      forgeUrl: DEFAULT_FORGE_URL,
      mcpUrl: DEFAULT_MCP_URL,
      tunnelUrl: tunnelUrl || undefined,
      authToken: authToken,
      configPath: getConfigPath()
    };

    console.log(displayStartupInfo(startupInfo));

    // Step 7: Setup graceful shutdown
    process.on('SIGINT', async () => {
      console.error(displayShutdownMessage());

      // Stop tunnel if running
      if (tunnelUrl) {
        try {
          await stopNgrokTunnel();
        } catch {
          // Ignore errors
        }
      }

      // Kill MCP process
      try {
        mcpProcess.kill('SIGTERM');
      } catch {
        // Already dead
      }

      // Stop Forge
      try {
        await stopForge(logDir);
      } catch {
        killForgeProcess();
      }

      console.error(displayShutdownComplete());
      process.exit(0);
    });

    // Handle MCP process exit
    mcpProcess.on('exit', (code, signal) => {
      if (code !== 0) {
        console.error(`\n⚠️  MCP process exited (code ${code}, signal ${signal})`);
      }
    });

    // Let process run until Ctrl+C
    await new Promise(() => {
      // Never resolves - waits for signal
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n❌ Startup failed: ${message}\n`);
    process.exit(1);
  }
}

// Run startup if executed directly
if (require.main === module) {
  startGenie().catch(error => {
    console.error(`Fatal error: ${error.message}`);
    process.exit(1);
  });
}

export default startGenie;
