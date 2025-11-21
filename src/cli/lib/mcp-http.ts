/**
 * MCP HTTP mode starter
 * For headless HTTP/SSE transport with OAuth2
 */

import { getForgeConfig, getMcpConfig } from './service-config.js';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { isForgeRunning } from './forge-manager';

export interface McpHttpOptions {
  port?: number;
  debug?: boolean;
}

/**
 * Start MCP in HTTP mode (headless, non-interactive)
 * Requires Forge to already be running
 */
export async function startMCPHttp(options: McpHttpOptions = {}): Promise<void> {
  const mcpServer = path.join(__dirname, '../../../dist/mcp/server.js');

  // Check if MCP server exists
  if (!fs.existsSync(mcpServer)) {
    console.error('Error: MCP server not built. Run: pnpm run build:mcp');
    process.exit(1);
  }

  // Check if Forge is running
  const baseUrl = process.env.FORGE_BASE_URL || getForgeConfig().baseUrl;
  const forgeRunning = await isForgeRunning(baseUrl);

  if (!forgeRunning) {
    console.error('❌ Forge is not running.');
    console.error('');
    console.error('Please start Forge first:');
    console.error('  genie server');
    console.error('');
    console.error('Or use the unified startup:');
    console.error('  genie');
    console.error('');
    process.exit(1);
  }

  // Use provided port or default
  const port = options.port || getMcpConfig().port || 8885;

  // Set environment for HTTP transport
  const env = {
    ...process.env,
    MCP_TRANSPORT: 'httpStream',
    MCP_PORT: port.toString(),
    ...(options.debug ? { MCP_DEBUG: '1' } : {})
  };

  console.error(`🚀 Starting Genie MCP Server in HTTP mode...`);
  console.error(`   Port: ${port}`);
  console.error(`   Transport: HTTP Stream + SSE`);
  console.error(`   Auth: OAuth2`);
  console.error('');

  // Start MCP in HTTP mode
  const child = spawn('node', [mcpServer], {
    stdio: 'inherit',
    env
  });

  child.on('exit', (code) => {
    process.exit(code === null ? 0 : code);
  });

  child.on('error', (err) => {
    console.error('Failed to start MCP server:', err);
    process.exit(1);
  });
}
