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
import { registerAgentCommands } from './term-commands/agent/index.js';
import {
  type SpawnOptions,
  handleLsCommand,
  handleWorkerKill,
  handleWorkerResume,
  handleWorkerSpawn,
  handleWorkerStop,
} from './term-commands/agents.js';
import { registerAppCommand } from './term-commands/app.js';
import { registerEventsCommands } from './term-commands/audit-events.js';
import { registerBoardCommands } from './term-commands/board.js';
import { registerBriefCommands } from './term-commands/brief.js';
import { registerDaemonCommands } from './term-commands/daemon.js';
import { registerDbCommands } from './term-commands/db.js';
import { registerDirNamespace } from './term-commands/dir.js';
import { registerDispatchCommands } from './term-commands/dispatch.js';
import { registerExportCommands } from './term-commands/export.js';
import * as historyCmd from './term-commands/history.js';
import { registerImportCommands } from './term-commands/import.js';
import { registerInitCommands } from './term-commands/init.js';
import { type LogOptions, logCommand } from './term-commands/log.js';
import { registerMetricsCommands } from './term-commands/metrics.js';
import { registerSendInboxCommands } from './term-commands/msg.js';
import { registerNotifyCommands } from './term-commands/notify.js';
import * as orchestrateCmd from './term-commands/orchestrate.js';
import { registerProjectCommands } from './term-commands/project.js';
import {
  type QaCheckOptions,
  type QaOptions,
  qaCheckCommand,
  qaCommand,
  qaHistoryCommand,
  qaStatusCommand,
} from './term-commands/qa.js';
import * as readCmd from './term-commands/read.js';
import { registerReleaseCommands } from './term-commands/release.js';
import { registerScheduleCommands } from './term-commands/schedule.js';
import { registerServeCommands } from './term-commands/serve.js';
import { registerSessionsCommands } from './term-commands/sessions.js';
import { registerStateCommands } from './term-commands/state.js';
import { registerTagCommands } from './term-commands/tag.js';
import { registerTaskCommands } from './term-commands/task.js';
import { registerTeamNamespace } from './term-commands/team.js';
import { registerTemplateCommands } from './term-commands/template.js';
import { registerTypeCommands } from './term-commands/type.js';

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

program.configureHelp({
  sortSubcommands: true,
  showGlobalOptions: true,
});

program.configureOutput({
  outputError: (str, write) => {
    const cmd = program.commands.find((c) => process.argv.slice(2, 6).includes(c.name()));
    const prefix = cmd ? `genie ${cmd.name()}` : 'genie';
    write(`\x1b[31mError (${prefix}): ${str}\x1b[0m\n`);
  },
});

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

// genie serve — infrastructure owner (pgserve + tmux + scheduler)
registerServeCommands(program);

// ============================================================================
// Orchestration namespaces
// ============================================================================

// ============================================================================
// TUI — interactive terminal interface
// ============================================================================

// genie tui removed — `genie` (no args) IS the TUI now

registerAppCommand(program);

registerInitCommands(program);
registerTeamNamespace(program);
registerDirNamespace(program);
registerAgentCommands(program);
registerSendInboxCommands(program);
registerStateCommands(program);
registerDispatchCommands(program);
registerHookNamespace(program);
registerDbCommands(program);
registerScheduleCommands(program);
registerDaemonCommands(program);
registerTaskCommands(program);
registerTypeCommands(program);
registerBoardCommands(program);
registerTagCommands(program);
registerReleaseCommands(program);
registerProjectCommands(program);
registerNotifyCommands(program);
registerEventsCommands(program);
registerSessionsCommands(program);
registerMetricsCommands(program);
registerExportCommands(program);
registerImportCommands(program);
registerTemplateCommands(program);
registerBriefCommands(program);

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
// Top-level aliases — shortcuts for genie agent <command>
// ============================================================================

// genie spawn <name>
program
  .command('spawn <name>')
  .description('Spawn a new agent by name (resolves from directory or built-ins)')
  .option('--provider <provider>', 'Provider: claude or codex', 'claude')
  .option('--team <team>', 'Team name', process.env.GENIE_TEAM ?? 'genie')
  .option('--model <model>', 'Model override (e.g., sonnet, opus)')
  .option('--skill <skill>', 'Skill to load (optional)')
  .option('--layout <layout>', 'Layout mode: mosaic (default) or vertical')
  .option('--color <color>', 'Teammate pane border color')
  .option('--plan-mode', 'Start teammate in plan mode')
  .option('--permission-mode <mode>', 'Permission mode (e.g., acceptEdits)')
  .option('--extra-args <args...>', 'Extra CLI args forwarded to provider')
  .option('--cwd <path>', 'Working directory for the agent (overrides directory entry)')
  .option('--session <session>', 'Tmux session name to spawn into')
  .option('--no-auto-resume', 'Disable auto-resume on pane death')
  .addHelpText(
    'after',
    `
Examples:
  genie spawn engineer                          # Spawn built-in engineer role
  genie spawn researcher --model sonnet         # Spawn with model override
  genie spawn my-agent --team my-feature        # Spawn into a specific team
  genie spawn council--questioner --provider codex  # Use Codex provider`,
  )
  .action(async (name: string, options: SpawnOptions) => {
    try {
      await handleWorkerSpawn(name, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

// genie kill <name>
program
  .command('kill <name>')
  .description('Force kill an agent by name')
  .action(async (name: string) => {
    try {
      await handleWorkerKill(name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

// genie stop <name>
program
  .command('stop <name>')
  .description('Stop an agent (preserves session for resume)')
  .action(async (name: string) => {
    try {
      await handleWorkerStop(name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

// genie resume [name]
program
  .command('resume [name]')
  .description('Resume a suspended/failed agent with its Claude session')
  .option('--all', 'Resume all eligible agents')
  .action(async (name: string | undefined, options: { all?: boolean }) => {
    try {
      await handleWorkerResume(name, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

// genie history <name>
program
  .command('history <name>')
  .description('Show compressed session history for an agent')
  .option('--full', 'Show full conversation without compression')
  .option('--since <n>', 'Show last N user/assistant exchanges', Number.parseInt)
  .option('--last <n>', 'Show last N transcript entries', Number.parseInt)
  .option('--type <role>', 'Filter by role (user, assistant, tool_call)')
  .option('--after <timestamp>', 'Only entries after ISO timestamp')
  .option('--json', 'Output as JSON')
  .option('--ndjson', 'Output as newline-delimited JSON (pipeable to jq)')
  .option('--raw', 'Output raw JSONL entries')
  .option('--log-file <path>', 'Direct path to log file (for testing)')
  .action(async (name: string, options: historyCmd.HistoryOptions) => {
    await historyCmd.historyCommand(name, options);
  });

// genie log [agent]
program
  .command('log [agent]')
  .description('Unified observability feed — aggregates transcript, DMs, team chat')
  .option('--team <name>', 'Show interleaved feed for all agents in a team')
  .option('--type <kind>', 'Filter by event kind (transcript, message, tool_call, state, system)')
  .option('--since <timestamp>', 'Only events after ISO timestamp')
  .option('--last <n>', 'Show last N events', Number.parseInt)
  .option('--ndjson', 'Output as newline-delimited JSON (pipeable to jq)')
  .option('--json', 'Output as pretty JSON')
  .option('-f, --follow', 'Follow mode — real-time streaming')
  .action(async (agent: string | undefined, options: LogOptions) => {
    await logCommand(agent, options);
  });

// genie qa [target] — run specs by name, domain, or all
// genie qa status — dashboard
// genie qa history — recent runs
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

// genie qa report <json> — team-lead calls this to publish QA result to PG event log
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

// genie read <name>
program
  .command('read <name>')
  .description('Read terminal output from an agent pane')
  .option('-n, --lines <number>', 'Number of lines to read')
  .option('--from <line>', 'Start line')
  .option('--to <line>', 'End line')
  .option('--range <range>', 'Line range (e.g., "10-20")')
  .option('--search <text>', 'Search for text')
  .option('--grep <pattern>', 'Grep for pattern')
  .option('-f, --follow', 'Follow mode (like tail -f)')
  .option('--all', 'Show all output')
  .option('-r, --reverse', 'Reverse order')
  .option('--json', 'Output as JSON')
  .action(async (name: string, options: readCmd.ReadOptions) => {
    await readCmd.readSessionLogs(name, options);
  });

// genie answer <name> <choice>
program
  .command('answer <name> <choice>')
  .description('Answer a question for an agent (use "text:..." for text input)')
  .action(async (name: string, choice: string) => {
    await orchestrateCmd.answerQuestion(name, choice);
  });

// genie ls — smart agent view
program
  .command('ls')
  .description('List registered agents with runtime status')
  .option('--json', 'Output as JSON')
  .action(async (options: { json?: boolean }) => {
    try {
      await handleLsCommand(options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

// ============================================================================
// genie --session <name> — named leader session (pre-parse check)
// ============================================================================

const args = process.argv.slice(2);

// TUI renderer mode: only when GENIE_TUI_PANE=left AND no subcommand given.
// Any subcommand (work, spawn, team, etc.) runs normally regardless of env.
// Clear the env var after checking so child processes never inherit it.
if (process.env.GENIE_TUI_PANE === 'left' && args.length === 0) {
  process.env.GENIE_TUI_PANE = undefined;
  const { launchTui } = await import('./tui/index.js');
  await launchTui();
  process.exit(0);
}
process.env.GENIE_TUI_PANE = undefined;

// Default command: genie (no args) → thin TUI client (attach to serve).
if (args.length === 0) {
  const { findWorkspace } = await import('./lib/workspace.js');
  const { resolveInitialAgent } = await import('./tui/initial-agent.js');
  const ws = findWorkspace();

  if (!ws) {
    console.error('Not in a genie workspace. Run `genie init` to create one.');
    process.exit(1);
  }

  const { isServeRunning, autoStartServe, isTuiSessionReady, ensureTuiSession } = await import(
    './term-commands/serve.js'
  );

  // Auto-start serve if not running
  if (!isServeRunning()) {
    console.log('Starting genie serve...');
    await autoStartServe();
  } else if (!isTuiSessionReady()) {
    // Serve is alive but TUI tmux session died — recreate it
    ensureTuiSession(ws.root);
  }

  const initialAgent = resolveInitialAgent(ws.root, ws.agent);

  // Set env vars for TUI (workspace root + agent) before attach
  if (ws.root) process.env.GENIE_TUI_WORKSPACE = ws.root;
  if (initialAgent) process.env.GENIE_TUI_AGENT = initialAgent;

  // Write initial agent to file so the already-running TUI can pick it up.
  // The TUI reads and deletes this file on its next diagnostics refresh.
  if (initialAgent) {
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const home = process.env.GENIE_HOME ?? join((await import('node:os')).homedir(), '.genie');
    try {
      writeFileSync(join(home, 'tui-initial-agent'), initialAgent, 'utf-8');
    } catch {
      // best-effort — TUI falls back to env var if file write fails
    }
  }

  // Attach to the genie-tui session (blocking call — returns on detach)
  const { attachTuiSession } = await import('./tui/tmux.js');
  attachTuiSession();
  process.exit(0);
}
if (args.every((a) => a === '--reset')) {
  const { sessionCommand } = await import('./genie-commands/session.js');
  await sessionCommand({ reset: true });
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
