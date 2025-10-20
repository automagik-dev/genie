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
    .option('-e, --executor <executor>', 'Override executor (codex or claude)')
    .option('-n, --name <name>', 'Friendly session name for easy identification')
    .action((agent, prompt, options) => {
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
    .action((template, options) => {
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
    .action((options) => {
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
    .action((options) => {
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
    .action((options) => {
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
    .action((sessionId, prompt) => {
    execGenie(['resume', sessionId, prompt]);
});
// List command
program
    .command('list <type>')
    .description('List agents or sessions')
    .action((type) => {
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
    .action((subcommand) => {
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
    // For stdio transport, avoid printing to stdout (clients expect pure JSON)
    const log = (msg) => {
        if (transport === 'stdio') {
            // Route to stderr only
            console.error(msg);
        }
        else {
            console.log(msg);
        }
    };
    log(`Starting Genie MCP Server...`);
    log(`Transport: ${transport}${internalTransport !== transport ? ` (${internalTransport})` : ''}`);
    if (internalTransport === 'httpStream') {
        log(`Port: ${port} (for HTTP/SSE)`);
        log('');
    }
    // Resilient startup: retry on early non-zero exit
    const maxAttempts = parseInt(process.env.GENIE_MCP_RESTARTS || '2', 10);
    const backoffMs = parseInt(process.env.GENIE_MCP_BACKOFF || '500', 10);
    let attempt = 0;
    const start = () => {
        attempt += 1;
        const child = (0, child_process_1.spawn)('node', [mcpServer], {
            stdio: 'inherit',
            env
        });
        let exited = false;
        let exitCode = null;
        const timer = setTimeout(() => {
            // After grace period, consider startup successful; let process lifecycle continue
            // We only auto-retry if it exits quickly within grace period
        }, 1000);
        child.on('exit', (code) => {
            exited = true;
            exitCode = code === null ? 0 : code;
            clearTimeout(timer);
            if (exitCode !== 0 && attempt <= maxAttempts) {
                log(`MCP server exited early with code ${exitCode}. Retrying (${attempt}/${maxAttempts}) in ${backoffMs}ms...`);
                setTimeout(start, backoffMs);
            }
            else {
                if (exitCode !== 0) {
                    console.error(`MCP server exited with code ${exitCode}`);
                }
                process.exit(exitCode || 0);
            }
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            if (attempt <= maxAttempts) {
                log(`Failed to start MCP server (${err?.message || err}). Retrying (${attempt}/${maxAttempts}) in ${backoffMs}ms...`);
                setTimeout(start, backoffMs);
            }
            else {
                console.error('Failed to start MCP server:', err);
                process.exit(1);
            }
        });
    };
    start();
}
