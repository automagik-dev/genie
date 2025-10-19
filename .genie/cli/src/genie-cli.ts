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
  .option('-e, --executor <executor>', 'Override executor (codex or claude)')
  .option('-n, --name <name>', 'Friendly session name for easy identification')
  .action((agent: string, prompt: string, options: { background?: boolean; executor?: string; name?: string }) => {
    const args = ['run', agent, prompt];
    if (options.background) {
      args.push('--background');
    }
    if (options.executor) {
      args.push('--executor', options.executor);
    }
    if (options.name) {
      args.push('--name', options.name);
    }
    execGenie(args);
  });

// Init command
program
  .command('init [template]')
  .description('Initialize Genie configuration in the current workspace')
  .option('--provider <provider>', 'Choose provider (codex or claude)')
  .option('-y, --yes', 'Accept defaults without prompting')
  .action((template: string | undefined, options: { provider?: string; yes?: boolean }) => {
    const args = ['init'];
    if (template) {
      args.push(template);
    }
    if (options.provider) {
      args.push('--provider', options.provider);
    }
    if (options.yes) {
      args.push('--yes');
    }
    execGenie(args);
  });

// Migrate command
program
  .command('migrate')
  .description('Migrate from old Genie (v2.x) to npm-backed architecture (v3.0+)')
  .option('--dry-run', 'Show changes without applying them')
  .option('-f, --force', 'Force migration even if already migrated')
  .action((options: { dryRun?: boolean; force?: boolean }) => {
    const args = ['migrate'];
    if (options.dryRun) {
      args.push('--dry-run');
    }
    if (options.force) {
      args.push('--force');
    }
    execGenie(args);
  });

// Update command
program
  .command('update')
  .description('Update Genie templates in this workspace')
  .option('--dry-run', 'Show changes without applying them')
  .option('-f, --force', 'Apply updates even when no changes detected')
  .action((options: { dryRun?: boolean; force?: boolean }) => {
    const args = ['update'];
    if (options.dryRun) {
      args.push('--dry-run');
    }
    if (options.force) {
      args.push('--force');
    }
    execGenie(args);
  });

// Rollback command
program
  .command('rollback')
  .description('Restore a previous Genie backup snapshot')
  .option('--list', 'List available backups')
  .option('--latest', 'Restore the most recent backup')
  .option('--id <backupId>', 'Restore a specific backup by ID')
  .action((options: { list?: boolean; latest?: boolean; id?: string }) => {
    const args = ['rollback'];
    if (options.list) {
      args.push('--list');
    }
    if (options.latest) {
      args.push('--latest');
    }
    if (options.id) {
      args.push('--id', options.id);
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
    const validTypes = ['agents', 'agents', 'sessions'];
    if (!validTypes.includes(type)) {
      console.error('Error: list command accepts "agents" or "sessions" (agents is alias for agents)');
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

// Status command
program
  .command('status')
  .description('Deprecated status shim (see migration guide)')
  .action(() => {
    execGenie(['status']);
  });

// Cleanup command
program
  .command('cleanup')
  .description('Deprecated cleanup shim (see migration guide)')
  .action(() => {
    execGenie(['cleanup']);
  });

// Statusline command
program
  .command('statusline')
  .description('Emit statusline output (deprecated)')
  .action(() => {
    execGenie(['statusline']);
  });

// Model command
program
  .command('model [subcommand]')
  .description('Configure default executor (show, detect, codex, claude)')
  .action((subcommand?: string) => {
    const args = ['model'];
    if (subcommand) {
      args.push(subcommand);
    }
    execGenie(args);
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
