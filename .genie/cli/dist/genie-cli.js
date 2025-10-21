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
const forge_manager_1 = require("./lib/forge-manager");
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
    .option('-x, --executor <executor>', 'Override executor for this run')
    .option('-m, --model <model>', 'Override model for the selected executor')
    .option('-n, --name <name>', 'Friendly session name for easy identification')
    .action((agent, prompt, options) => {
    const args = ['run', agent, prompt];
    if (options.background) {
        args.push('--background');
    }
    if (options.executor) {
        args.push('--executor', options.executor);
    }
    if (options.model) {
        args.push('--model', options.model);
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
    .option('-y, --yes', 'Accept defaults without prompting')
    .action((template, options) => {
    const args = ['init'];
    if (template) {
        args.push(template);
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
    .command('list [type]')
    .description('List collectives (default) or sessions')
    .action((type) => {
    const normalized = (type || 'collectives').toLowerCase();
    const validTypes = ['collectives', 'agents', 'sessions', 'workflows', 'skills'];
    if (!validTypes.includes(normalized)) {
        console.error('Error: list command accepts collectives (default), agents, workflows, skills, or sessions');
        process.exit(1);
    }
    execGenie(['list', normalized]);
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
// Start command (default - starts Forge + MCP with SSE)
program
    .command('start')
    .description('Start Genie server (Forge backend + MCP with SSE on port 8885)')
    .action(async () => {
    await startGenieServer();
});
// MCP command (stdio only - for Claude Desktop integration)
program
    .command('mcp')
    .description('Start MCP server in stdio mode (for Claude Desktop). Requires Forge to be running.')
    .action(async () => {
    await startMCPStdio();
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
 * Start Genie server (Forge + MCP with SSE transport on port 8885)
 * This is the main entry point for npx automagik-genie
 */
async function startGenieServer() {
    const mcpServer = path_1.default.join(__dirname, '../../mcp/dist/server.js');
    // Check if MCP server exists
    if (!fs_1.default.existsSync(mcpServer)) {
        console.error('Error: MCP server not built. Run: pnpm run build:mcp');
        process.exit(1);
    }
    // Phase 1: Start Forge in background
    const baseUrl = process.env.FORGE_BASE_URL || 'http://localhost:8888';
    const logDir = path_1.default.join(process.cwd(), '.genie', 'state');
    console.log('🚀 Starting Genie services...');
    console.log('');
    // Check if Forge is already running
    const forgeRunning = await (0, forge_manager_1.isForgeRunning)(baseUrl);
    if (!forgeRunning) {
        process.stderr.write('📦 Starting Forge backend');
        (0, forge_manager_1.startForgeInBackground)({ baseUrl, logDir });
        // Wait for Forge to be ready (30s timeout with progress dots)
        const forgeReady = await (0, forge_manager_1.waitForForgeReady)(baseUrl, 30000, 500, true);
        if (!forgeReady) {
            console.error('\n❌ Forge did not start in time (30s). Check logs at .genie/state/forge.log');
            process.exit(1);
        }
        console.log(`📦 Forge:  ${baseUrl} ✓`);
    }
    else {
        console.log(`📦 Forge:  ${baseUrl} ✓ (already running)`);
    }
    // Phase 2: Start MCP server with SSE transport
    const mcpPort = process.env.MCP_PORT || '8885';
    console.log(`📡 MCP:    http://localhost:${mcpPort}/sse ✓`);
    console.log('');
    console.log('Ready for connections.');
    console.log('Press Ctrl+C to stop all services.');
    console.log('');
    // Set environment variables
    const env = {
        ...process.env,
        MCP_TRANSPORT: 'httpStream',
        MCP_PORT: mcpPort
    };
    // Handle graceful shutdown (stop both Forge and MCP)
    let mcpChild = null;
    process.on('SIGINT', () => {
        console.log('');
        console.log('🛑 Shutting down...');
        // Stop MCP
        if (mcpChild) {
            mcpChild.kill('SIGTERM');
        }
        // Stop Forge
        const stopped = (0, forge_manager_1.stopForge)(logDir);
        if (stopped) {
            console.log('✅ All services stopped');
        }
        else {
            console.log('✅ MCP stopped (Forge was not started by this session)');
        }
        process.exit(0);
    });
    // Resilient startup: retry on early non-zero exit
    const maxAttempts = parseInt(process.env.GENIE_MCP_RESTARTS || '2', 10);
    const backoffMs = parseInt(process.env.GENIE_MCP_BACKOFF || '500', 10);
    let attempt = 0;
    const start = () => {
        attempt += 1;
        mcpChild = (0, child_process_1.spawn)('node', [mcpServer], {
            stdio: 'inherit',
            env
        });
        const timer = setTimeout(() => {
            // After grace period, consider startup successful; let process lifecycle continue
            // We only auto-retry if it exits quickly within grace period
        }, 1000);
        mcpChild.on('exit', (code) => {
            const exitCode = code === null ? 0 : code;
            clearTimeout(timer);
            if (exitCode !== 0 && attempt <= maxAttempts) {
                console.log(`MCP server exited early with code ${exitCode}. Retrying (${attempt}/${maxAttempts}) in ${backoffMs}ms...`);
                setTimeout(start, backoffMs);
            }
            else {
                if (exitCode !== 0) {
                    console.error(`MCP server exited with code ${exitCode}`);
                }
                // Don't exit immediately - let SIGINT handler clean up Forge
                (0, forge_manager_1.stopForge)(logDir);
                process.exit(exitCode || 0);
            }
        });
        mcpChild.on('error', (err) => {
            clearTimeout(timer);
            if (attempt <= maxAttempts) {
                console.log(`Failed to start MCP server (${err?.message || err}). Retrying (${attempt}/${maxAttempts}) in ${backoffMs}ms...`);
                setTimeout(start, backoffMs);
            }
            else {
                console.error('Failed to start MCP server:', err);
                (0, forge_manager_1.stopForge)(logDir);
                process.exit(1);
            }
        });
    };
    start();
}
/**
 * Start MCP in stdio mode (for Claude Desktop integration)
 * Requires Forge to already be running
 */
async function startMCPStdio() {
    const mcpServer = path_1.default.join(__dirname, '../../mcp/dist/server.js');
    // Check if MCP server exists
    if (!fs_1.default.existsSync(mcpServer)) {
        console.error('Error: MCP server not built. Run: pnpm run build:mcp');
        process.exit(1);
    }
    // Check if Forge is running
    const baseUrl = process.env.FORGE_BASE_URL || 'http://localhost:8888';
    const forgeRunning = await (0, forge_manager_1.isForgeRunning)(baseUrl);
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
    const child = (0, child_process_1.spawn)('node', [mcpServer], {
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
