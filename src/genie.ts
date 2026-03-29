#!/usr/bin/env bun

/**
 * genie — Single entrypoint CLI.
 *
 * Top-level commands:
 *   spawn, kill, stop, ls, history, read, answer, work
 *
 * Namespaces:
 *   team, dir, send/inbox, state, hook
 *
 * Utilities:
 *   setup, doctor, update, uninstall, shortcuts
 *
 * Session:
 *   genie --session <name>  — Start or resume a named leader session
 */

import { Command } from 'commander';
import { doctorCommand } from './genie-commands/doctor.js';
import { type SetupOptions, setupCommand } from './genie-commands/setup.js';
import {
  shortcutsInstallCommand,
  shortcutsShowCommand,
  shortcutsUninstallCommand,
} from './genie-commands/shortcuts.js';
import { uninstallCommand } from './genie-commands/uninstall.js';
import { updateCommand } from './genie-commands/update.js';
import { VERSION } from './lib/version.js';

import { registerHookNamespace } from './hooks/dispatch-command.js';
import { getActor, recordAuditEvent } from './lib/audit.js';
import { shutdown as shutdownDb } from './lib/db.js';
import { stopOtelReceiver } from './lib/otel-receiver.js';

// ── New 4-object namespace registrations ──
import { registerAgentCommands } from './term-commands/agent/index.js';
import { registerExecCommands } from './term-commands/exec/index.js';
import { extendTaskCommands } from './term-commands/task/index.js';

// ── Existing registrations (kept until Group 8 cleanup) ──
import { registerEventsCommands } from './term-commands/audit-events.js';
import { registerDaemonCommands } from './term-commands/daemon.js';
import { registerDbCommands } from './term-commands/db.js';
import { registerDispatchCommands } from './term-commands/dispatch.js';
import { registerExportCommands } from './term-commands/export.js';
import { registerImportCommands } from './term-commands/import.js';
import { registerInstallCommand } from './term-commands/install.js';
import { registerItemUninstallCommand } from './term-commands/item-uninstall.js';
import { registerItemUpdateCommand } from './term-commands/item-update.js';
import { registerMetricsCommands } from './term-commands/metrics.js';
import { registerNotifyCommands } from './term-commands/notify.js';
import { registerPublishCommand } from './term-commands/publish.js';
import {
  type QaCheckOptions,
  type QaOptions,
  qaCheckCommand,
  qaCommand,
  qaHistoryCommand,
  qaStatusCommand,
} from './term-commands/qa.js';
import { registerScheduleCommands } from './term-commands/schedule.js';
import { registerSessionsCommands } from './term-commands/sessions.js';
import { registerTaskCommands } from './term-commands/task.js';
import { registerTeamCommands } from './term-commands/team/index.js';
import { registerTemplateCommands } from './term-commands/template.js';

// Safety net: ensure git repo is never in bare mode.
// This should no longer trigger now that we use `git clone --shared` instead of
// `git worktree` (which could flip core.bare=true on the parent repo). Kept as
// a last-resort guard for repos previously corrupted by the old worktree approach.
try {
  const { execSync: execSyncStartup } = require('node:child_process');
  const isBare = execSyncStartup('git config core.bare', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  if (isBare === 'true') {
    execSyncStartup('git config core.bare false', { stdio: ['pipe', 'pipe', 'pipe'] });
  }
} catch {
  // Not in a git repo — that's fine
}

const program = new Command();

program.name('genie').description('Genie CLI - AI-assisted development').version(VERSION);

// ============================================================================
// Named session — genie --session <name>
// ============================================================================

async function startNamedSession(name: string): Promise<void> {
  const { buildTeamLeadCommand, sessionExists } = await import('./lib/team-lead-command.js');
  const { getAgentsFilePath } = await import('./genie-commands/session.js');

  const systemPromptFile = getAgentsFilePath();

  // Only resume if a prior CC session with this name exists (#694, #701)
  const hasPriorSession = sessionExists(name);
  const cmd = buildTeamLeadCommand(name, {
    systemPromptFile: systemPromptFile ?? undefined,
    continueName: hasPriorSession ? name : undefined,
  });

  console.log(hasPriorSession ? `Resuming session: ${name}` : `Starting new session: ${name}`);

  const { spawnSync } = await import('node:child_process');
  const result = spawnSync('sh', ['-c', cmd], { stdio: 'inherit' });
  if (result.status) process.exit(result.status);
}

// ============================================================================
// Utility commands
// ============================================================================

program
  .command('setup')
  .description('Configure genie settings')
  .option('--quick', 'Accept all defaults')
  .option('--shortcuts', 'Only configure keyboard shortcuts')
  .option('--codex', 'Only configure Codex integration')
  .option('--terminal', 'Only configure terminal defaults')
  .option('--session', 'Only configure session settings')
  .option('--reset', 'Reset configuration to defaults')
  .option('--show', 'Show current configuration')
  .action(async (options: SetupOptions) => {
    await setupCommand(options);
  });

program
  .command('doctor')
  .description('Run diagnostic checks on genie installation')
  .option('--fix', 'Auto-fix: kill zombie postgres, clean shared memory, restart daemon')
  .action(doctorCommand);
program
  .command('update')
  .description('Update Genie CLI to the latest version')
  .option('--next', 'Switch to dev builds (npm @next tag)')
  .option('--stable', 'Switch to stable releases (npm @latest tag)')
  .action(updateCommand);
program.command('uninstall').description('Remove Genie CLI and clean up hooks').action(uninstallCommand);

const shortcuts = program.command('shortcuts').description('Manage tmux keyboard shortcuts');
shortcuts.action(shortcutsShowCommand);
shortcuts.command('show').description('Show available shortcuts and installation status').action(shortcutsShowCommand);
shortcuts
  .command('install')
  .description('Install shortcuts to config files (~/.tmux.conf, shell rc)')
  .action(shortcutsInstallCommand);
shortcuts.command('uninstall').description('Remove shortcuts from config files').action(shortcutsUninstallCommand);

// ============================================================================
// 4-Object Namespace Registration — agent, task, team, exec
// ============================================================================

// agent namespace (Group 1) — absorbs spawn/kill/stop/resume/ls/show/answer/register/directory/inbox/brief + stubs
registerAgentCommands(program);

// task namespace — existing task commands + absorbed state.ts verbs + planning delegations
registerTaskCommands(program);
extendTaskCommands(program);

// team namespace (Group 3) — existing team handlers
registerTeamCommands(program);

// exec namespace (Group 3) — new debug commands for executor management
registerExecCommands(program);

// ============================================================================
// TUI — interactive terminal interface
// ============================================================================

program
  .command('tui')
  .description('Launch interactive terminal UI (OpenTUI nav + tmux Claude Code)')
  .option('--dev', 'Development mode with auto-reload on file changes')
  .action(async (options: { dev?: boolean }) => {
    const { launchTui } = await import('./tui/index.js');
    await launchTui({ dev: options.dev });
  });

// ============================================================================
// Existing namespaces (kept until full migration — Group 8 cleanup)
// ============================================================================

registerDispatchCommands(program);
registerHookNamespace(program);
registerDbCommands(program);
registerScheduleCommands(program);
registerDaemonCommands(program);
registerNotifyCommands(program);
registerEventsCommands(program);
registerSessionsCommands(program);
registerMetricsCommands(program);
registerExportCommands(program);
registerImportCommands(program);
registerTemplateCommands(program);

// Item registry commands — install, publish (top-level), item uninstall/update (namespaced)
registerInstallCommand(program);
registerPublishCommand(program);
const itemCmd = program.command('item').description('Item registry management');
registerItemUninstallCommand(itemCmd);
registerItemUpdateCommand(itemCmd);

// ============================================================================
// CLI audit hooks — record every command execution to audit_events
// ============================================================================

const auditTimers = new Map<string, number>();

program.hook('preAction', (_thisCommand, actionCommand) => {
  const name = actionCommand.name();
  auditTimers.set(name, Date.now());
  // Only record audit if DB is already connected — never trigger independent startup
  import('./lib/db.js')
    .then(({ isConnected }) => {
      if (!isConnected()) return;
      recordAuditEvent('command', name, 'command_start', getActor(), {
        args: actionCommand.args,
      }).catch(() => {});
    })
    .catch(() => {});
});

program.hook('postAction', (_thisCommand, actionCommand) => {
  const name = actionCommand.name();
  const startMs = auditTimers.get(name);
  const durationMs = startMs ? Date.now() - startMs : undefined;
  auditTimers.delete(name);
  import('./lib/db.js')
    .then(({ isConnected }) => {
      if (!isConnected()) return;
      recordAuditEvent('command', name, 'command_success', getActor(), {
        args: actionCommand.args,
        duration_ms: durationMs,
      }).catch(() => {});
    })
    .catch(() => {});
});

// ============================================================================
// QA commands (staying top-level — not part of 4-object restructure)
// ============================================================================

const qaCmd = program.command('qa').description('QA — self-testing system for genie CLI');

qaCmd
  .command('run [target]', { isDefault: true })
  .description('Run QA specs (all, a domain, or a single spec)')
  .option('--timeout <seconds>', 'Max seconds per spec', (v: string) => Number(v), 3600)
  .option('--parallel <n>', 'Max specs to run in parallel', (v: string) => Number(v), 5)
  .option('--verbose', 'Show all collected events')
  .option('--ndjson', 'Machine-readable NDJSON output')
  .action(async (target: string | undefined, options: QaOptions) => {
    await qaCommand(target, options);
  });

qaCmd
  .command('status')
  .description('Show QA dashboard with last results per spec')
  .option('--json', 'Output as JSON')
  .action(async (options: { json?: boolean }) => {
    await qaStatusCommand(options);
  });

qaCmd
  .command('history')
  .description('Show recent QA runs')
  .action(async () => {
    await qaHistoryCommand();
  });

qaCmd
  .command('check <specFile>')
  .description('Evaluate a QA spec against current team logs and publish qa-report')
  .option('--team <name>', 'Team name (defaults to GENIE_TEAM)')
  .option('--since <timestamp>', 'Only consider events after this ISO timestamp')
  .option('--since-file <path>', 'Read the lower-bound timestamp from a file')
  .action(async (specFile: string, options: QaCheckOptions) => {
    await qaCheckCommand(specFile, options);
  });

program
  .command('qa-report <json>')
  .description('Publish QA result to the PG event log (called by QA team-lead)')
  .action(async (json: string) => {
    const team = process.env.GENIE_TEAM;
    if (!team) {
      console.error('Error: GENIE_TEAM not set. This command must be run by a QA team-lead agent.');
      process.exit(1);
    }
    try {
      const data = JSON.parse(json);
      const { publishSubjectEvent } = await import('./lib/runtime-events.js');
      await publishSubjectEvent(process.cwd(), `genie.qa.${team}.result`, {
        kind: 'qa',
        agent: 'qa',
        team,
        text: `QA result: ${String(data.result ?? 'unknown')}`,
        data,
        source: 'hook',
      });
      console.log(`QA result published to PG event log as genie.qa.${team}.result`);
    } catch (err) {
      console.error(`Failed to publish QA result: ${err}`);
      process.exit(1);
    }
  });

// ============================================================================
// Error redirects — old top-level commands → helpful suggestions
// ============================================================================

function errorRedirect(oldCmd: string, newCmd: string): () => void {
  return () => {
    const args = process.argv.slice(3).join(' ');
    const suggestion = args ? `${newCmd} ${args}` : newCmd;
    console.error(`Command "${oldCmd}" has moved. Did you mean: genie ${suggestion}?`);
    process.exit(1);
  };
}

program
  .command('spawn [args...]')
  .description('(moved) → genie agent spawn')
  .action(errorRedirect('spawn', 'agent spawn'));
program.command('kill [args...]').description('(moved) → genie agent kill').action(errorRedirect('kill', 'agent kill'));
program.command('stop [args...]').description('(moved) → genie agent stop').action(errorRedirect('stop', 'agent stop'));
program
  .command('resume [args...]')
  .description('(moved) → genie agent resume')
  .action(errorRedirect('resume', 'agent resume'));
program.command('ls').description('(moved) → genie agent list').action(errorRedirect('ls', 'agent list'));
program
  .command('read [args...]')
  .description('(moved) → genie agent log --raw')
  .action(errorRedirect('read', 'agent log --raw'));
program
  .command('history [args...]')
  .description('(moved) → genie agent log --transcript')
  .action(errorRedirect('history', 'agent log --transcript'));
program.command('log [args...]').description('(moved) → genie agent log').action(errorRedirect('log', 'agent log'));
program
  .command('status [args...]')
  .description('(moved) → genie task status')
  .action(errorRedirect('status', 'task status'));
program.command('done [args...]').description('(moved) → genie task done').action(errorRedirect('done', 'task done'));
program.command('send [args...]').description('(moved) → genie agent send').action(errorRedirect('send', 'agent send'));
program
  .command('broadcast [args...]')
  .description('(moved) → genie agent send --broadcast')
  .action(errorRedirect('broadcast', 'agent send --broadcast'));
program
  .command('answer [args...]')
  .description('(moved) → genie agent answer')
  .action(errorRedirect('answer', 'agent answer'));
program
  .command('inbox [args...]')
  .description('(moved) → genie agent inbox')
  .action(errorRedirect('inbox', 'agent inbox'));
program
  .command('chat [args...]')
  .description('(moved) → genie agent log --conversations')
  .action(errorRedirect('chat', 'agent log --conversations'));
program
  .command('brief [args...]')
  .description('(moved) → genie agent brief')
  .action(errorRedirect('brief', 'agent brief'));
program
  .command('dir [args...]')
  .description('(moved) → genie agent directory / genie agent register')
  .action(errorRedirect('dir', 'agent directory'));
program
  .command('show [args...]')
  .description('(moved) → genie task show / genie agent show')
  .action(errorRedirect('show', 'agent show'));

// ============================================================================
// genie --session <name> — named leader session (pre-parse check)
// ============================================================================

const args = process.argv.slice(2);

// Default command: genie (no args) or genie --reset
if (args.length === 0 || args.every((a) => a === '--reset')) {
  const { sessionCommand } = await import('./genie-commands/session.js');
  await sessionCommand({ reset: args.includes('--reset') });
  process.exit(0);
}

const sessionIdx = args.indexOf('--session');
if (sessionIdx !== -1 && sessionIdx + 1 < args.length) {
  const sessionName = args[sessionIdx + 1];
  // Only start session if no subcommand is provided
  const otherArgs = args.filter((_: string, i: number) => i !== sessionIdx && i !== sessionIdx + 1);
  const hasSubcommand = otherArgs.some((a: string) => !a.startsWith('-'));
  if (!hasSubcommand) {
    try {
      await startNamedSession(sessionName);
      process.exit(0);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  } else {
    try {
      await program.parseAsync(process.argv);
    } finally {
      stopOtelReceiver();
      await shutdownDb().catch(() => {});
    }
  }
} else {
  try {
    await program.parseAsync(process.argv);
  } finally {
    stopOtelReceiver();
    await shutdownDb().catch(() => {});
  }
}
