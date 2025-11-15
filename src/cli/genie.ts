#!/usr/bin/env node
/**
 * GENIE Agent CLI - Codex exec orchestration with configurable execution modes
 */

import { parseArguments } from './lib/cli-parser';
import {
  loadConfig,
  applyDefaults,
  resolvePaths,
  prepareDirectories,
  getStartupWarnings,
  clearStartupWarnings
} from './lib/config';
import { getRuntimeWarnings, clearRuntimeWarnings } from './lib/task-helpers';
import {
  buildRunHelpView,
  buildResumeHelpView,
  buildListHelpView,
  buildViewHelpView,
  buildStopHelpView
} from './views/help';
import { buildErrorView, buildInfoView, buildWarningView } from './views/common';
import { emitView } from './lib/view-helpers';
import { TaskService, createHandlers } from './cli-core';
import type { HandlerContext } from './cli-core';
import { runHelp } from './commands/help';
import { runInit } from './commands/init';
import { runRollback } from './commands/rollback';
import { runStatus } from './commands/status';
import { runDashboard } from './commands/dashboard';
import { runCleanup } from './commands/cleanup';
import { runStatusline } from './commands/statusline';
import { runUpdate } from './commands/update';

void main();

async function main(): Promise<void> {
  try {
    let parsed = parseArguments(process.argv.slice(2));

    // Set port environment variables from CLI flags (early, before any config loading)
    if (parsed.options.forgePort) {
      process.env.FORGE_PORT = parsed.options.forgePort;
    }
    if (parsed.options.geniePort) {
      process.env.MCP_PORT = parsed.options.geniePort;
    }

    // Fast path for help commands - skip config loading
    const isHelpOnly = (parsed.command === 'help' || parsed.command === undefined) ||
                      parsed.options.requestHelp;

    let config: ReturnType<typeof loadConfig>;
    let paths: ReturnType<typeof resolvePaths>;
    let handlers: ReturnType<typeof createHandlers> | null = null;

    if (isHelpOnly) {
      // Minimal config for help display
      config = { defaults: { background: true } } as ReturnType<typeof loadConfig>;
      paths = resolvePaths({});
    } else {
      config = loadConfig();
      applyDefaults(parsed.options, config.defaults);
      paths = resolvePaths(config.paths || {});
      prepareDirectories(paths);

      const startupWarnings = getStartupWarnings();
      if (startupWarnings.length) {
        const envelope = buildWarningView('Configuration warnings', startupWarnings);
        await emitView(envelope, parsed.options);
        clearStartupWarnings();
      }

      // Create handler context for run/resume/list/view/stop commands
      const sessionService = new TaskService({
        paths,
        loadConfig: config,
        defaults: { defaults: config.defaults }
      });

      const handlerContext: HandlerContext = {
        config,
        defaultConfig: config,
        paths,
        sessionService,
        emitView,
        recordRuntimeWarning: (msg: string) => {
          const { recordRuntimeWarning } = require('./lib/task-helpers');
          recordRuntimeWarning(msg);
        },
        recordStartupWarning: (msg: string) => {
          const { recordStartupWarning } = require('./lib/config');
          recordStartupWarning(msg);
        }
      };

      handlers = createHandlers(handlerContext);
    }

    switch (parsed.command) {
      case 'run':
        if (parsed.options.requestHelp) {
          await emitView(buildRunHelpView(), parsed.options);
          return;
        }
        const { runRun } = await import('./commands/run.js');
        await runRun(parsed, config, paths);
        break;
      case 'init':
        if (parsed.options.requestHelp) {
          await emitView(buildInfoView('Genie init', [
            'Usage: genie init [code|create] [--yes]',
            '• Copies packaged .genie into your repo (preserving agents, wishes, reports, state).',
            '• Copies AGENTS.md and .gitignore to project root (no CLAUDE.md changes).',
            '• Backs up existing .genie and AGENTS.md under .genie/backups/<id>/.',
            '• Prompts for default executor and model (arrow keys), updates .genie/config.yaml.',
            '• Configures MCP: genie@latest and Forge in .mcp.json.',
            '• Starts a private Forge on 8887 and creates an Install task.'
          ]), parsed.options);
          return;
        }
        await runInit(parsed, config, paths);
        break;
      case 'rollback':
        if (parsed.options.requestHelp) {
          await emitView(buildInfoView('Genie rollback', [
            'Usage: genie rollback [--list] [--id <backupId>] [--latest]',
            'Restores a previous snapshot stored under .genie/backups.'
          ]), parsed.options);
          return;
        }
        await runRollback(parsed, config, paths);
        break;
      case 'status':
        await runStatus(parsed, config, paths);
        break;
      case 'dashboard':
        await runDashboard(parsed, config, paths);
        break;
      case 'talk':
        const { runTalk } = await import('./commands/talk.js');
        await runTalk(parsed, config, paths);
        break;
      case 'task':
        const { runTask } = await import('./commands/task.js');
        await runTask(parsed, config, paths);
        break;
      case 'cleanup':
        await runCleanup(parsed, config, paths);
        break;
      case 'statusline':
        await runStatusline(parsed, config, paths);
        break;
      case 'update':
        if (parsed.options.requestHelp) {
          await emitView(buildInfoView('Genie update', [
            'Usage: genie update [--preview] [--force]',
            'Updates the Genie framework to the latest version',
            '',
            'Options:',
            '  --preview   Show what would change without applying',
            '  --force     Skip confirmation prompt',
            '',
            'The update command:',
            '• Checks npm registry for newer versions',
            '• Uses git diff to intelligently merge framework changes',
            '• Preserves user customizations (.genie/USERCONTEXT.md, custom agents, etc.)',
            '• Creates automatic backup before applying changes',
            '• Handles conflicts via Update Agent (when implemented)'
          ]), parsed.options);
          return;
        }
        await runUpdate(parsed, config, paths);
        break;
      case 'resume':
        if (parsed.options.requestHelp) {
          await emitView(buildResumeHelpView(), parsed.options);
          return;
        }
        if (!handlers) throw new Error('Handlers not initialized');
        await handlers.resume(parsed);
        break;
      case 'list':
        if (parsed.options.requestHelp) {
          await emitView(buildListHelpView(), parsed.options);
          return;
        }
        if (!handlers) throw new Error('Handlers not initialized');
        await handlers.list(parsed);
        break;
      case 'view':
        if (parsed.options.requestHelp) {
          await emitView(buildViewHelpView(), parsed.options);
          return;
        }
        if (!handlers) throw new Error('Handlers not initialized');
        await handlers.view(parsed);
        break;
      case 'stop':
        if (parsed.options.requestHelp) {
          await emitView(buildStopHelpView(), parsed.options);
          return;
        }
        if (!handlers) throw new Error('Handlers not initialized');
        await handlers.stop(parsed);
        break;
      case 'help':
      case undefined:
        await runHelp(parsed, config, paths);
        break;
      default: {
        await emitView(buildErrorView('Unknown command', `Unknown command: ${parsed.command}`), parsed.options, { stream: process.stderr });
        await runHelp(parsed, config, paths);
        process.exitCode = 1;
        break;
      }
    }
    const runtimeWarnings = getRuntimeWarnings();
    if (runtimeWarnings.length) {
      const envelope = buildWarningView('Runtime warnings', runtimeWarnings);
      await emitView(envelope, parsed.options);
      clearRuntimeWarnings();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await emitEmergencyError(message);
    process.exitCode = 1;
  }
}

async function emitEmergencyError(message: string): Promise<void> {
  const errorMessage = buildErrorView('Fatal error', message);
  process.stderr.write(errorMessage + '\n');
}
