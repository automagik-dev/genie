/**
 * MCP stdio mode starter
 * For Claude Desktop integration
 */

import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { isForgeRunning } from './forge-manager';

/**
 * Start MCP in stdio mode (for Claude Desktop integration)
 * Requires Forge to already be running
 */
export async function startMCPStdio(): Promise<void> {
  const mcpServer = path.join(__dirname, '../../../mcp/dist/server.js');

  // Check if MCP server exists
  if (!fs.existsSync(mcpServer)) {
    console.error('Error: MCP server not built. Run: pnpm run build:mcp');
    process.exit(1);
  }

  // Check if Forge is running
  const baseUrl = process.env.FORGE_BASE_URL || 'http://localhost:8887';
  const forgeRunning = await isForgeRunning(baseUrl);

  if (!forgeRunning) {
    console.error('❌ Forge is not running.');
    console.error('');
    console.error('Please start the Genie server first:');
    console.error('  npx automagik-genie');
    console.error('');
    console.error('This will start both Forge backend and MCP server.');
    process.exit(1);
  }

  // Set environment for stdio transport
  const env = {
    ...process.env,
    MCP_TRANSPORT: 'stdio'
  };

  // Start MCP in stdio mode
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
