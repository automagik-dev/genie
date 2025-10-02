#!/usr/bin/env node
"use strict";
/**
 * Genie CLI - Unified command-line interface with commander.js
 *
 * Provides a unified CLI for:
 * - Agent orchestration (run, resume, list, view, stop)
 * - MCP server management (genie mcp)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const child_process_1 = require("child_process");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const program = new commander_1.Command();
// Get package version
const packageJson = JSON.parse(fs_1.default.readFileSync(path_1.default.join(__dirname, '../../../package.json'), 'utf8'));
program
    .name('genie')
    .description('Self-evolving AI agent orchestration framework')
    .version(packageJson.version);
// Run command
program
    .command('run <agent> <prompt>')
    .description('Run an agent with a prompt')
    .option('-b, --background', 'Run in background mode')
    .action((agent, prompt, options) => {
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
    .action((sessionId, prompt) => {
    execGenie(['resume', sessionId, prompt]);
});
// List command
program
    .command('list <type>')
    .description('List agents or sessions')
    .action((type) => {
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
    .action((sessionId, options) => {
    const args = ['view', sessionId];
    if (options.full)
        args.push('--full');
    if (options.live)
        args.push('--live');
    execGenie(args);
});
// Stop command
program
    .command('stop <sessionId>')
    .description('Stop a running session')
    .action((sessionId) => {
    execGenie(['stop', sessionId]);
});
// MCP command
program
    .command('mcp')
    .description('Start MCP server')
    .option('-t, --transport <type>', 'Transport type: stdio, sse, http', 'stdio')
    .option('-p, --port <port>', 'Port for HTTP/SSE transport', '8080')
    .action((options) => {
    startMCPServer(options.transport, options.port);
});
// Parse arguments
program.parse(process.argv);
/**
 * Execute the legacy genie CLI
 */
function execGenie(args) {
    const genieScript = path_1.default.join(__dirname, 'genie.js');
    const child = (0, child_process_1.spawn)('node', [genieScript, ...args], {
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
function startMCPServer(transport, port) {
    // Validate transport
    const validTransports = ['stdio', 'sse', 'http'];
    if (!validTransports.includes(transport)) {
        console.error(`Error: Invalid transport "${transport}". Valid options: ${validTransports.join(', ')}`);
        process.exit(1);
    }
    // Map user-facing transport names to internal transport names
    const transportMap = {
        stdio: 'stdio',
        sse: 'httpStream', // SSE maps to httpStream internally
        http: 'httpStream'
    };
    const internalTransport = transportMap[transport];
    const mcpServer = path_1.default.join(__dirname, '../../mcp/dist/server.js');
    // Check if MCP server exists
    if (!fs_1.default.existsSync(mcpServer)) {
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
    const child = (0, child_process_1.spawn)('node', [mcpServer], {
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
