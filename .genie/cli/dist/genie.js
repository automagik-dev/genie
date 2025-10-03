#!/usr/bin/env node
"use strict";
/**
 * GENIE Agent CLI - Codex exec orchestration with configurable execution modes
 */
Object.defineProperty(exports, "__esModule", { value: true });
const cli_parser_1 = require("./lib/cli-parser");
const config_1 = require("./lib/config");
const session_helpers_1 = require("./lib/session-helpers");
const view_1 = require("./view");
const help_1 = require("./views/help");
const common_1 = require("./views/common");
const view_helpers_1 = require("./lib/view-helpers");
const run_1 = require("./commands/run");
const resume_1 = require("./commands/resume");
const list_1 = require("./commands/list");
const view_2 = require("./commands/view");
const stop_1 = require("./commands/stop");
const help_2 = require("./commands/help");
const background_manager_1 = require("./background-manager");
void main();
async function main() {
    try {
        let parsed = (0, cli_parser_1.parseArguments)(process.argv.slice(2));
        const envIsBackground = process.env[background_manager_1.INTERNAL_BACKGROUND_MARKER_ENV] === '1';
        if (envIsBackground) {
            parsed.options.background = true;
            parsed.options.backgroundRunner = true;
            parsed.options.backgroundExplicit = true;
        }
        else {
            delete process.env[background_manager_1.INTERNAL_BACKGROUND_ENV];
            delete process.env[background_manager_1.INTERNAL_START_TIME_ENV];
            delete process.env[background_manager_1.INTERNAL_LOG_PATH_ENV];
        }
        // Fast path for help commands - skip config loading
        const isHelpOnly = (parsed.command === 'help' || parsed.command === undefined) ||
            parsed.options.requestHelp;
        let config;
        let paths;
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
        }
        switch (parsed.command) {
            case 'run':
                if (parsed.options.requestHelp) {
                    await (0, view_helpers_1.emitView)((0, help_1.buildRunHelpView)(), parsed.options);
                    return;
                }
                await (0, run_1.runChat)(parsed, config, paths);
                break;
            case 'resume':
                if (parsed.options.requestHelp) {
                    await (0, view_helpers_1.emitView)((0, help_1.buildResumeHelpView)(), parsed.options);
                    return;
                }
                await (0, resume_1.runContinue)(parsed, config, paths);
                break;
            case 'list':
                if (parsed.options.requestHelp) {
                    await (0, view_helpers_1.emitView)((0, help_1.buildListHelpView)(), parsed.options);
                    return;
                }
                await (0, list_1.runList)(parsed, config, paths);
                break;
            case 'view':
                if (parsed.options.requestHelp) {
                    await (0, view_helpers_1.emitView)((0, help_1.buildViewHelpView)(), parsed.options);
                    return;
                }
                await (0, view_2.runView)(parsed, config, paths);
                break;
            case 'stop':
                if (parsed.options.requestHelp) {
                    await (0, view_helpers_1.emitView)((0, help_1.buildStopHelpView)(), parsed.options);
                    return;
                }
                await (0, stop_1.runStop)(parsed, config, paths);
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
    const envelope = (0, common_1.buildErrorView)('Fatal error', message);
    await (0, view_1.renderEnvelope)(envelope, { json: false, stream: process.stderr });
}
