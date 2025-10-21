#!/usr/bin/env node
"use strict";
/**
 * GENIE Agent CLI - Codex exec orchestration with configurable execution modes
 */
Object.defineProperty(exports, "__esModule", { value: true });
const cli_parser_1 = require("./lib/cli-parser");
const config_1 = require("./lib/config");
const session_helpers_1 = require("./lib/session-helpers");
const help_1 = require("./views/help");
const common_1 = require("./views/common");
const view_helpers_1 = require("./lib/view-helpers");
const cli_core_1 = require("./cli-core");
const help_2 = require("./commands/help");
const init_1 = require("./commands/init");
const rollback_1 = require("./commands/rollback");
const status_1 = require("./commands/status");
const cleanup_1 = require("./commands/cleanup");
const statusline_1 = require("./commands/statusline");
void main();
async function main() {
    try {
        let parsed = (0, cli_parser_1.parseArguments)(process.argv.slice(2));
        // Fast path for help commands - skip config loading
        const isHelpOnly = (parsed.command === 'help' || parsed.command === undefined) ||
            parsed.options.requestHelp;
        let config;
        let paths;
        let handlers = null;
        if (isHelpOnly) {
            // Minimal config for help display
            config = { defaults: { background: true } };
            paths = (0, config_1.resolvePaths)({});
        }
        else {
            config = (0, config_1.loadConfig)();
            (0, config_1.applyDefaults)(parsed.options, config.defaults);
            paths = (0, config_1.resolvePaths)(config.paths || {});
            (0, config_1.prepareDirectories)(paths);
            const startupWarnings = (0, config_1.getStartupWarnings)();
            if (startupWarnings.length) {
                const envelope = (0, common_1.buildWarningView)('Configuration warnings', startupWarnings);
                await (0, view_helpers_1.emitView)(envelope, parsed.options);
                (0, config_1.clearStartupWarnings)();
            }
            // Create handler context for run/resume/list/view/stop commands
            const sessionService = new cli_core_1.SessionService({
                paths,
                loadConfig: config,
                defaults: { defaults: config.defaults }
            });
            const handlerContext = {
                config,
                defaultConfig: config,
                paths,
                sessionService,
                emitView: view_helpers_1.emitView,
                recordRuntimeWarning: (msg) => {
                    const { recordRuntimeWarning } = require('./lib/session-helpers');
                    recordRuntimeWarning(msg);
                },
                recordStartupWarning: (msg) => {
                    const { recordStartupWarning } = require('./lib/config');
                    recordStartupWarning(msg);
                }
            };
            handlers = (0, cli_core_1.createHandlers)(handlerContext);
        }
        switch (parsed.command) {
            case 'run':
                if (parsed.options.requestHelp) {
                    await (0, view_helpers_1.emitView)((0, help_1.buildRunHelpView)(), parsed.options);
                    return;
                }
                if (!handlers)
                    throw new Error('Handlers not initialized');
                await handlers.run(parsed);
                break;
            case 'init':
                if (parsed.options.requestHelp) {
                    await (0, view_helpers_1.emitView)((0, common_1.buildInfoView)('Genie init', [
                        'Usage: genie init [code|create] [--yes]',
                        '• Copies packaged .genie into your repo (preserving agents, wishes, reports, state).',
                        '• Copies AGENTS.md and .gitignore to project root (no CLAUDE.md changes).',
                        '• Backs up existing .genie and AGENTS.md under .genie/backups/<id>/.',
                        '• Prompts for default executor and model (arrow keys), updates .genie/config.yaml.',
                        '• Configures MCP: genie@next and Forge in .mcp.json.',
                        '• Starts a private Forge on 8888 and creates an Install task.'
                    ]), parsed.options);
                    return;
                }
                await (0, init_1.runInit)(parsed, config, paths);
                break;
            case 'rollback':
                if (parsed.options.requestHelp) {
                    await (0, view_helpers_1.emitView)((0, common_1.buildInfoView)('Genie rollback', [
                        'Usage: genie rollback [--list] [--id <backupId>] [--latest]',
                        'Restores a previous snapshot stored under .genie/backups.'
                    ]), parsed.options);
                    return;
                }
                await (0, rollback_1.runRollback)(parsed, config, paths);
                break;
            case 'status':
                await (0, status_1.runStatus)(parsed, config, paths);
                break;
            case 'cleanup':
                await (0, cleanup_1.runCleanup)(parsed, config, paths);
                break;
            case 'statusline':
                await (0, statusline_1.runStatusline)(parsed, config, paths);
                break;
            case 'resume':
                if (parsed.options.requestHelp) {
                    await (0, view_helpers_1.emitView)((0, help_1.buildResumeHelpView)(), parsed.options);
                    return;
                }
                if (!handlers)
                    throw new Error('Handlers not initialized');
                await handlers.resume(parsed);
                break;
            case 'list':
                if (parsed.options.requestHelp) {
                    await (0, view_helpers_1.emitView)((0, help_1.buildListHelpView)(), parsed.options);
                    return;
                }
                if (!handlers)
                    throw new Error('Handlers not initialized');
                await handlers.list(parsed);
                break;
            case 'view':
                if (parsed.options.requestHelp) {
                    await (0, view_helpers_1.emitView)((0, help_1.buildViewHelpView)(), parsed.options);
                    return;
                }
                if (!handlers)
                    throw new Error('Handlers not initialized');
                await handlers.view(parsed);
                break;
            case 'stop':
                if (parsed.options.requestHelp) {
                    await (0, view_helpers_1.emitView)((0, help_1.buildStopHelpView)(), parsed.options);
                    return;
                }
                if (!handlers)
                    throw new Error('Handlers not initialized');
                await handlers.stop(parsed);
                break;
            case 'help':
            case undefined:
                await (0, help_2.runHelp)(parsed, config, paths);
                break;
            default: {
                await (0, view_helpers_1.emitView)((0, common_1.buildErrorView)('Unknown command', `Unknown command: ${parsed.command}`), parsed.options, { stream: process.stderr });
                await (0, help_2.runHelp)(parsed, config, paths);
                process.exitCode = 1;
                break;
            }
        }
        const runtimeWarnings = (0, session_helpers_1.getRuntimeWarnings)();
        if (runtimeWarnings.length) {
            const envelope = (0, common_1.buildWarningView)('Runtime warnings', runtimeWarnings);
            await (0, view_helpers_1.emitView)(envelope, parsed.options);
            (0, session_helpers_1.clearRuntimeWarnings)();
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await emitEmergencyError(message);
        process.exitCode = 1;
    }
}
async function emitEmergencyError(message) {
    const errorMessage = (0, common_1.buildErrorView)('Fatal error', message);
    process.stderr.write(errorMessage + '\n');
}
