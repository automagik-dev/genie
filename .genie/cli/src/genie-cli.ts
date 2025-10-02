#!/usr/bin/env node
/**
 * Genie CLI - Unified command-line interface with commander.js
 *
 * Provides a unified CLI for:
 * - Agent orchestration (run, resume, list, view, stop)
 * - MCP server management (genie mcp)
 */

import { Command } from 'commander';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const program = new Command();

// Get package version
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8')
);

program
  .name('genie')
  .description('Self-evolving AI agent orchestration framework')
  .version(packageJson.version);

// Run command
program
  .command('run <agent> <prompt>')
  .description('Run an agent with a prompt')
  .option('-b, --background', 'Run in background mode')
  .action((agent: string, prompt: string, options: { background?: boolean }) => {
    const args = ['run', agent, prompt];
    if (options.background) {
      args.push('--background');
    }
    execGenie(args);
  });

// Resume command
program
  .command('resume <sessionId> <prompt>')
  .description('Resume an existing agent session')
  .action((sessionId: string, prompt: string) => {
    execGenie(['resume', sessionId, prompt]);
  });

// List command
program
  .command('list <type>')
  .description('List agents or sessions')
  .action((type: string) => {
    if (type !== 'agents' && type !== 'sessions') {
      console.error('Error: list command accepts "agents" or "sessions"');
      process.exit(1);
    }
    execGenie(['list', type]);
  });

// View command
program
  .command('view <sessionId>')
  .description('View session transcript')
  .option('--full', 'Show full transcript')
  .option('--live', 'Live view (auto-refresh)')
  .action((sessionId: string, options: { full?: boolean; live?: boolean }) => {
    const args = ['view', sessionId];
    if (options.full) args.push('--full');
    if (options.live) args.push('--live');
    execGenie(args);
  });

// Stop command
program
  .command('stop <sessionId>')
  .description('Stop a running session')
  .action((sessionId: string) => {
    execGenie(['stop', sessionId]);
  });

// MCP command
program
  .command('mcp')
  .description('Start MCP server')
  .option('-t, --transport <type>', 'Transport type: stdio, sse, http', 'stdio')
  .option('-p, --port <port>', 'Port for HTTP/SSE transport', '8080')
  .action((options: { transport: string; port: string }) => {
    startMCPServer(options.transport, options.port);
  });

// Parse arguments
program.parse(process.argv);

/**
 * Execute the legacy genie CLI
 */
function execGenie(args: string[]): void {
  const genieScript = path.join(__dirname, 'genie.js');

  const child = spawn('node', [genieScript, ...args], {
    stdio: 'inherit',
    env: process.env
  });

  child.on('exit', (code) => {
    process.exit(code || 0);
  });
}

/**
 * Start MCP server with specified transport
 */
function startMCPServer(transport: string, port: string): void {
  // Validate transport
  const validTransports = ['stdio', 'sse', 'http'];
  if (!validTransports.includes(transport)) {
    console.error(`Error: Invalid transport "${transport}". Valid options: ${validTransports.join(', ')}`);
    process.exit(1);
  }

  // Map user-facing transport names to internal transport names
  const transportMap: Record<string, string> = {
    stdio: 'stdio',
    sse: 'httpStream',  // SSE maps to httpStream internally
    http: 'httpStream'
  };

  const internalTransport = transportMap[transport];
  const mcpServer = path.join(__dirname, '../../mcp/dist/server.js');

  // Check if MCP server exists
  if (!fs.existsSync(mcpServer)) {
    console.error('Error: MCP server not built. Run: pnpm run build:mcp');
    process.exit(1);
  }

  // Set environment variables
  const env = {
    ...process.env,
    MCP_TRANSPORT: internalTransport,
    MCP_PORT: port
  };

  console.log(`Starting Genie MCP Server...`);
  console.log(`Transport: ${transport}${internalTransport !== transport ? ` (${internalTransport})` : ''}`);
  console.log(`Port: ${port} (for HTTP/SSE)`);
  console.log('');

  const child = spawn('node', [mcpServer], {
    stdio: 'inherit',
    env
  });

  child.on('exit', (code) => {
    if (code !== 0) {
      console.error(`MCP server exited with code ${code}`);
    }
    process.exit(code || 0);
  });

  child.on('error', (err) => {
    console.error('Failed to start MCP server:', err);
    process.exit(1);
  });
}
