#!/usr/bin/env bun

import { Command } from 'commander';
import { VERSION } from './lib/version.js';
import * as newCmd from './term-commands/new.js';
import * as lsCmd from './term-commands/ls.js';
import * as attachCmd from './term-commands/attach.js';
import * as rmCmd from './term-commands/rm.js';
import * as readCmd from './term-commands/read.js';
import * as execCmd from './term-commands/exec.js';
import * as sendCmd from './term-commands/send.js';
import * as splitCmd from './term-commands/split.js';
import * as hookCmd from './term-commands/hook.js';
import * as windowCmd from './term-commands/window.js';
import * as paneCmd from './term-commands/pane.js';
import * as statusCmd from './term-commands/status.js';
import * as shortcutsCmd from './term-commands/shortcuts.js';
import * as orchestrateCmd from './term-commands/orchestrate.js';
import * as workCmd from './term-commands/work.js';
import * as workersCmd from './term-commands/workers.js';
import * as closeCmd from './term-commands/close.js';
import * as killCmd from './term-commands/kill.js';
import * as daemonCmd from './term-commands/daemon.js';
import * as spawnCmd from './term-commands/spawn.js';
import * as createCmd from './term-commands/create.js';
import * as updateCmd from './term-commands/update.js';
import * as shipCmd from './term-commands/ship.js';
import * as pushCmd from './term-commands/push.js';
import * as syncCmd from './term-commands/sync.js';
import * as eventsCmd from './term-commands/events.js';
import * as approveCmd from './term-commands/approve.js';
import * as dashboardCmd from './term-commands/dashboard.js';
import * as spawnParallelCmd from './term-commands/spawn-parallel.js';
import * as batchCmd from './term-commands/batch.js';
import * as councilCmd from './term-commands/council.js';
import * as resolveCmd from './term-commands/resolve.js';
import * as historyCmd from './term-commands/history.js';
import { registerSessionNamespace } from './term-commands/session/commands.js';
import { registerTaskNamespace } from './term-commands/task/commands.js';
import { registerWishNamespace } from './term-commands/wish/commands.js';
import { getRepoGenieDir } from './lib/genie-dir.js';

const program = new Command();

program
  .name('term')
  .description(`AI-friendly terminal orchestration for Claude Code workflows

WORKERS (most common)
  spawn [skill]       Spawn Claude worker (interactive picker if omitted)
  work <id|next>      Spawn worker bound to beads task
  workers             List all workers and states
  dashboard           Live status of all workers
  approve [id]        Approve pending permission
  answer <w> <choice> Answer worker question
  history <worker>    Compressed session summary
  close <id>          Close task and cleanup worker
  kill <worker>       Force kill a worker

TASKS (beads integration)
  task create         Create new beads issue
  task update         Update task properties
  task ship           Mark done + merge + cleanup
  task ls             List ready tasks
  task link           Link task to wish

WISHES (planning)
  wish ls             List all wishes
  wish status <slug>  Show wish with linked tasks

SESSIONS (low-level tmux) - see: term session --help
  session new/ls/attach/rm/exec/send/read/info/split
  session window/pane/hook

MONITORING
  watch <session>     Real-time event stream
  events [pane-id]    Claude Code events

POWER TOOLS
  parallel            Spawn multiple workers
  batch               Manage parallel batches
  council             Dual-model deliberation
  daemon              Beads sync daemon

SHORT ALIASES
  w    → work         s    → spawn
  d    → dashboard    a    → approve
  h    → history

Examples:
  term work bd-42              # Start working on task
  term spawn review            # Spawn with review skill
  term d                       # Show dashboard
  term h bd-42                 # Session catch-up`)
  .version(VERSION);

// Register session namespace (term session <subcommand>)
registerSessionNamespace(program);

// Register task namespace (term task <subcommand>)
registerTaskNamespace(program);

// Register wish namespace (term wish <subcommand>)
registerWishNamespace(program);

// ============================================================================
// Deprecation Helper
// ============================================================================

const DEPRECATION_SHOWN = new Set<string>();

/**
 * Show a deprecation warning once per command
 */
function showDeprecation(oldCmd: string, newCmd: string): void {
  if (DEPRECATION_SHOWN.has(oldCmd)) return;
  DEPRECATION_SHOWN.add(oldCmd);
  console.error(`⚠️  DEPRECATED: "term ${oldCmd}" → use "term ${newCmd}" instead`);
}

// Session management (top-level aliases - DEPRECATED, kept for backwards compat)
program
  .command('new <name>')
  .description('[DEPRECATED] Create a new tmux session → use "term session new"')
  .option('-d, --workspace <path>', 'Working directory for the session')
  .option('-w, --worktree', 'Create git worktree in .worktrees/<name>/')
  .action(async (name: string, options: { workspace?: string; worktree?: boolean }) => {
    showDeprecation('new', 'session new');
    await newCmd.createNewSession(name, options);
  });

program
  .command('attach <name>')
  .description('[DEPRECATED] Attach to a tmux session → use "term session attach"')
  .action(async (name: string) => {
    showDeprecation('attach', 'session attach');
    await attachCmd.attachToSession(name);
  });

program
  .command('rm <name>')
  .description('[DEPRECATED] Remove a tmux session → use "term session rm"')
  .option('--keep-worktree', 'Keep worktree folder when removing session')
  .action(async (name: string, options: { keepWorktree?: boolean }) => {
    showDeprecation('rm', 'session rm');
    await rmCmd.removeSession(name, options);
  });

// Log reading (CRITICAL for AI orchestration)
program
  .command('read <target>')
  .description('[DEPRECATED] Read logs from a target → use "term session read"')
  .option('-n, --lines <number>', 'Number of lines to read (default: 100)', '100')
  .option('--from <line>', 'Start line number')
  .option('--to <line>', 'End line number')
  .option('--range <range>', 'Line range (e.g., 100:200)')
  .option('--search <pattern>', 'Search for pattern')
  .option('--grep <pattern>', 'Regex search pattern')
  .option('-f, --follow', 'Follow mode (live tail)')
  .option('--all', 'Export entire scrollback buffer')
  .option('--reverse', 'Reverse chronological (newest first)')
  .option('--json', 'Output as JSON')
  .option('-p, --pane <id>', '[DEPRECATED] Target specific pane ID - use target addressing instead')
  .action(async (target: string, options: readCmd.ReadOptions) => {
    showDeprecation('read', 'session read');
    await readCmd.readSessionLogs(target, options);
  });

// Command execution
program
  .command('exec <target> <command...>')
  .description('[DEPRECATED] Execute command in a target → use "term session exec"')
  .option('-q, --quiet', 'Suppress stdout output')
  .option('-t, --timeout <ms>', 'Timeout in milliseconds (default: 120000)')
  .option('-p, --pane <id>', '[DEPRECATED] Target specific pane ID - use target addressing instead')
  .action(async (target: string, command: string[], options: { quiet?: boolean; timeout?: string; pane?: string }) => {
    showDeprecation('exec', 'session exec');
    await execCmd.executeInSession(target, command.join(' '), {
      quiet: options.quiet,
      timeout: options.timeout ? parseInt(options.timeout, 10) : undefined,
      pane: options.pane,
    });
  });

program
  .command('send <target> <keys>')
  .description('[DEPRECATED] Send keys to a target → use "term session send"')
  .option('--no-enter', 'Send raw keys without appending Enter')
  .option('-p, --pane <id>', '[DEPRECATED] Target specific pane ID - use target addressing instead')
  .action(async (target: string, keys: string, options: { enter?: boolean; pane?: string }) => {
    showDeprecation('send', 'session send');
    await sendCmd.sendKeysToSession(target, keys, options);
  });

// Pane splitting
program
  .command('split <target> [direction]')
  .description('[DEPRECATED] Split pane for a target → use "term session split"')
  .option('-p, --pane <id>', '[DEPRECATED] Target pane ID - use target addressing instead')
  .option('-d, --workspace <path>', 'Working directory for the new pane')
  .option('-w, --worktree <branch>', 'Create git worktree in .worktrees/<branch>/')
  .action(async (target: string, direction: string | undefined, options: { workspace?: string; worktree?: string; pane?: string }) => {
    showDeprecation('split', 'session split');
    await splitCmd.splitSessionPane(target, direction, options);
  });

// Info command (renamed from status)
program
  .command('info <session>')
  .description('[DEPRECATED] Check session state → use "term session info"')
  .option('--command <id>', 'Check specific command status')
  .option('--json', 'Output as JSON')
  .action(async (session: string, options: statusCmd.StatusOptions) => {
    showDeprecation('info', 'session info');
    await statusCmd.getStatus(session, options);
  });

// Window management - DEPRECATED
const windowProgram = program.command('window').description('[DEPRECATED] Manage tmux windows → use "term session window"');

windowProgram
  .command('new <session> <name>')
  .description('[DEPRECATED] Create a new window in session')
  .action(async (session: string, name: string) => {
    showDeprecation('window new', 'session window new');
    await windowCmd.createWindow(session, name);
  });

windowProgram
  .command('ls <session>')
  .description('[DEPRECATED] List windows in session')
  .option('--json', 'Output as JSON')
  .action(async (session: string, options: { json?: boolean }) => {
    showDeprecation('window ls', 'session window ls');
    await windowCmd.listWindows(session, options);
  });

windowProgram
  .command('rm <window-id>')
  .description('[DEPRECATED] Remove window by ID')
  .action(async (windowId: string) => {
    showDeprecation('window rm', 'session window rm');
    await windowCmd.removeWindow(windowId);
  });

// Pane management - DEPRECATED
const paneProgram = program.command('pane').description('[DEPRECATED] Manage tmux panes → use "term session pane"');

paneProgram
  .command('ls <session>')
  .description('[DEPRECATED] List all panes in session')
  .option('--json', 'Output as JSON')
  .action(async (session: string, options: { json?: boolean }) => {
    showDeprecation('pane ls', 'session pane ls');
    await paneCmd.listPanes(session, options);
  });

paneProgram
  .command('rm <pane-id>')
  .description('[DEPRECATED] Remove pane by ID')
  .action(async (paneId: string) => {
    showDeprecation('pane rm', 'session pane rm');
    await paneCmd.removePane(paneId);
  });

// Hook management - DEPRECATED
const hookProgram = program.command('hook').description('[DEPRECATED] Manage tmux hooks → use "term session hook"');

hookProgram
  .command('set <event> <command>')
  .description('[DEPRECATED] Set a tmux hook')
  .action(async (event: string, command: string) => {
    showDeprecation('hook set', 'session hook set');
    await hookCmd.setHook(event, command);
  });

hookProgram
  .command('list')
  .description('[DEPRECATED] List all tmux hooks')
  .action(async () => {
    showDeprecation('hook list', 'session hook list');
    await hookCmd.listHooks();
  });

hookProgram
  .command('rm <event>')
  .description('[DEPRECATED] Remove a tmux hook')
  .action(async (event: string) => {
    showDeprecation('hook rm', 'session hook rm');
    await hookCmd.removeHook(event);
  });

// Shortcuts command
program
  .command('shortcuts')
  .description('Warp-like keyboard shortcuts for tmux/Termux')
  .option('--tmux', 'Output tmux.conf snippet')
  .option('--termux', 'Output termux.properties snippet')
  .option('--install', 'Install to config files (interactive)')
  .action(async (options: shortcutsCmd.ShortcutsOptions) => {
    await shortcutsCmd.handleShortcuts(options);
  });

// Skill-based spawning
program
  .command('spawn [skill]')
  .description('Spawn Claude with a skill (interactive picker if no skill specified)')
  .option('-s, --session <name>', 'Target tmux session')
  .option('--no-worktree', 'Skip worktree creation when taskId provided')
  .option('--no-focus', 'Don\'t focus the new pane')
  .option('-p, --prompt <message>', 'Additional context for the skill')
  .option('-t, --task-id <id>', 'Bind to beads issue')
  .option('--profile <name>', 'Worker profile to use')
  .action(async (skill: string | undefined, options: spawnCmd.SpawnOptions) => {
    await spawnCmd.spawnCommand(skill, options);
  });

program
  .command('skills')
  .description('List available skills from all sources')
  .option('-v, --verbose', 'Show detailed skill info (path, source)')
  .option('-s, --source', 'Group skills by source (local, user, plugin)')
  .action(async (options: spawnCmd.SkillsOptions) => {
    await spawnCmd.listSkillsCommand(options);
  });

program
  .command('brainstorm')
  .description('Spawn Claude with brainstorm skill (idea → design → spec)')
  .option('-s, --session <name>', 'Target tmux session')
  .option('--no-focus', 'Don\'t focus the new pane')
  .option('-p, --prompt <message>', 'Additional context')
  .action(async (options: spawnCmd.SpawnOptions) => {
    await spawnCmd.spawnCommand('brainstorm', options);
  });

// Watch session events (promoted from orc watch)
program
  .command('watch <target>')
  .description('Watch target events in real-time')
  .option('-p, --pane <id>', '[DEPRECATED] Target pane ID - use target addressing instead')
  .option('--json', 'Output events as JSON')
  .option('--poll <ms>', 'Poll interval in milliseconds')
  .action(async (target: string, options: orchestrateCmd.WatchOptions) => {
    await orchestrateCmd.watchSession(target, options);
  });

// Run task with monitoring (promoted from orc run)
program
  .command('run <target> <message>')
  .description('Send task and auto-approve until idle (fire-and-forget)')
  .option('-p, --pane <id>', '[DEPRECATED] Target pane ID - use target addressing instead')
  .option('-a, --auto-approve', 'Auto-approve permissions and plans')
  .option('-t, --timeout <ms>', 'Timeout in milliseconds (default: 300000)')
  .option('--json', 'Output final state as JSON')
  .action(async (target: string, message: string, options: orchestrateCmd.RunOptions) => {
    await orchestrateCmd.runTask(target, message, options);
  });

// Create beads issue command
program
  .command('create <title>')
  .description('Create a new beads issue')
  .option('-d, --description <text>', 'Issue description')
  .option('-p, --parent <id>', 'Parent issue ID (creates dependency)')
  .option('--json', 'Output as JSON')
  .action(async (title: string, options: createCmd.CreateOptions) => {
    await createCmd.createCommand(title, options);
  });

// Worker management commands (beads + Claude orchestration)
program
  .command('work <target>')
  .description('Spawn worker bound to beads issue (target: bd-id, "next", or "wish")')
  .option('--no-worktree', 'Use shared repo instead of worktree')
  .option('-s, --session <name>', 'Target tmux session')
  .option('--focus', 'Focus the worker pane after spawning')
  .option('-p, --prompt <message>', 'Custom initial prompt')
  .option('--no-resume', 'Start fresh session even if previous exists')
  .option('--skill <name>', 'Skill to invoke (auto-detects "forge" if wish.md exists)')
  .option('--no-auto-approve', 'Disable auto-approve for this worker')
  .option('--profile <name>', 'Worker profile to use')
  .option('-n, --name <name>', 'Custom worker name (for N workers per task)')
  .option('-r, --role <role>', 'Worker role (e.g., "main", "tests", "review")')
  .option('--shared-worktree', 'Share worktree with existing worker on same task')
  .option('--inline', 'Skip beads claim, create branch inline (fallback when beads is broken)')
  .action(async (target: string, options: workCmd.WorkOptions) => {
    await workCmd.workCommand(target, options);
  });

program
  .command('workers')
  .description('List all workers and their states')
  .option('--json', 'Output as JSON')
  .option('-w, --watch', 'Live updates (coming soon)')
  .action(async (options: workersCmd.WorkersOptions) => {
    if (options.watch) {
      console.log('ℹ️  --watch mode coming in Phase 1.5');
    }
    await workersCmd.workersCommand(options);
  });

program
  .command('dashboard')
  .description('Show all active workers with current state')
  .option('-w, --watch', 'Auto-refresh every 2 seconds')
  .option('-v, --verbose', 'Show detailed worker info')
  .option('--json', 'Output as JSON')
  .action(async (options: { watch?: boolean; verbose?: boolean; json?: boolean }) => {
    await dashboardCmd.dashboardCommand({
      json: options.json,
      verbose: options.verbose,
      watch: options.watch,
    });
  });

program
  .command('update <task-id>')
  .description('Update task properties (status, title, blocked-by)')
  .option('--status <status>', 'New status (ready, in_progress, done, blocked)')
  .option('--title <title>', 'New title')
  .option('--blocked-by <ids>', 'Set blocked-by list (comma-separated task IDs)')
  .option('--add-blocked-by <ids>', 'Add to blocked-by list (comma-separated task IDs)')
  .option('--json', 'Output as JSON')
  .action(async (taskId: string, options: updateCmd.UpdateOptions) => {
    await updateCmd.updateCommand(taskId, options);
  });

program
  .command('ship <task-id>')
  .description('Mark task as done and cleanup worker')
  .option('--keep-worktree', 'Don\'t remove the worktree')
  .option('--merge', 'Merge worktree changes to main branch')
  .option('-y, --yes', 'Skip confirmation')
  .action(async (taskId: string, options: shipCmd.ShipOptions) => {
    await shipCmd.shipCommand(taskId, options);
  });

program
  .command('push')
  .description('Push current branch to remote (with branch protection)')
  .option('-u, --set-upstream', 'Set upstream for new branches (default: true)')
  .option('-f, --force', 'Force push with lease')
  .action(async (options: pushCmd.PushOptions) => {
    await pushCmd.pushCommand(options);
  });

program
  .command('close <task-id>')
  .description('Close task/issue and cleanup worker')
  .option('--no-sync', 'Skip bd sync (beads only)')
  .option('--keep-worktree', 'Don\'t remove the worktree')
  .option('--merge', 'Merge worktree changes to main branch')
  .option('-y, --yes', 'Skip confirmation')
  .action(async (taskId: string, options: closeCmd.CloseOptions) => {
    await closeCmd.closeCommand(taskId, options);
  });

program
  .command('kill <worker>')
  .description('Force kill a worker')
  .option('-y, --yes', 'Skip confirmation')
  .option('--keep-worktree', 'Don\'t remove the worktree')
  .action(async (worker: string, options: killCmd.KillOptions) => {
    await killCmd.killCommand(worker, options);
  });

// Answer command (shortcut to orc answer for worker use)
program
  .command('answer <worker> <choice>')
  .description('Answer a question for a worker (use "text:..." for text input)')
  .action(async (worker: string, choice: string) => {
    const registry = await import('./lib/worker-registry.js');
    let workerInfo = await registry.get(worker);
    if (!workerInfo) {
      workerInfo = await registry.findByTask(worker);
    }
    if (!workerInfo) {
      console.error(`❌ Worker "${worker}" not found. Run \`term workers\` to see workers.`);
      process.exit(1);
    }
    await orchestrateCmd.answerQuestion(workerInfo.session, choice, {
      pane: workerInfo.paneId,
    });
  });

// Daemon management (beads auto-sync)
const daemonProgram = program.command('daemon').description('Manage beads daemon for auto-sync');

daemonProgram
  .command('start')
  .description('Start beads daemon (auto-commit, auto-sync)')
  .option('--no-auto-commit', 'Disable auto-commit')
  .option('--auto-push', 'Enable auto-push to remote')
  .action(async (options: daemonCmd.DaemonStartOptions) => {
    await daemonCmd.startCommand(options);
  });

daemonProgram
  .command('stop')
  .description('Stop beads daemon')
  .action(async () => {
    await daemonCmd.stopCommand();
  });

daemonProgram
  .command('status')
  .description('Show daemon status')
  .option('--json', 'Output as JSON')
  .action(async (options: daemonCmd.DaemonStatusOptions) => {
    await daemonCmd.statusCommand(options);
  });

daemonProgram
  .command('restart')
  .description('Restart beads daemon')
  .option('--no-auto-commit', 'Disable auto-commit')
  .option('--auto-push', 'Enable auto-push to remote')
  .action(async (options: daemonCmd.DaemonStartOptions) => {
    await daemonCmd.restartCommand(options);
  });

// Plugin sync command (development mode)
program
  .command('sync')
  .description('Sync plugin to ~/.claude/plugins (creates symlink for dev mode)')
  .option('-b, --build', 'Build plugin before syncing')
  .option('-v, --verbose', 'Show detailed output')
  .action(async (options: syncCmd.SyncOptions) => {
    await syncCmd.syncCommand(options);
  });

// Events command - Stream Claude Code events from a pane
program
  .command('events [pane-id]')
  .description('Stream Claude Code events from a pane or all workers')
  .option('--json', 'Output events as JSON')
  .option('-f, --follow', 'Continuous tailing (like tail -f)')
  .option('-n, --lines <number>', 'Number of recent events to show (default: 20)', '20')
  .option('--emit', 'Write events to .genie/events/<pane-id>.jsonl while tailing')
  .option('--all', 'Aggregate events from all active workers')
  .action(async (paneId: string | undefined, options: { json?: boolean; follow?: boolean; lines?: string; emit?: boolean; all?: boolean }) => {
    await eventsCmd.eventsCommand(paneId, {
      json: options.json,
      follow: options.follow,
      lines: options.lines ? parseInt(options.lines, 10) : undefined,
      emit: options.emit,
      all: options.all,
    });
  });

// History command - Session catch-up with compression
program
  .command('history <worker>')
  .description('Show compressed session history for a worker (catch-up)')
  .option('--full', 'Show full conversation without compression')
  .option('--since <n>', 'Show last N user/assistant exchanges', parseInt)
  .option('--json', 'Output as JSON')
  .option('--raw', 'Output raw JSONL entries')
  .option('--log-file <path>', 'Direct path to log file (for testing)')
  .action(async (worker: string, options: historyCmd.HistoryOptions) => {
    await historyCmd.historyCommand(worker, options);
  });

// Alias: term h <worker>
program
  .command('h <worker>')
  .description('Alias for "term history"')
  .option('--full', 'Show full conversation')
  .option('--since <n>', 'Last N exchanges', parseInt)
  .option('--json', 'JSON output')
  .option('--log-file <path>', 'Direct log file path')
  .action(async (worker: string, options: historyCmd.HistoryOptions) => {
    await historyCmd.historyCommand(worker, options);
  });

// Target resolution diagnostic
program
  .command('resolve <target>')
  .description('Resolve a target to its tmux pane (diagnostic, no side effects)')
  .option('--json', 'Output as JSON')
  .action(async (target: string, options: resolveCmd.ResolveOptions) => {
    await resolveCmd.resolveCommand(target, options);
  });

// Orchestration commands (Claude Code automation)
const orcProgram = program.command('orc').description('Orchestrate Claude Code sessions');

orcProgram
  .command('start <session>')
  .description('Start Claude Code in a session with optional monitoring')
  .option('-p, --pane <id>', 'Target specific pane ID (e.g., %16)')
  .option('-m, --monitor', 'Enable real-time event monitoring')
  .option('-c, --command <cmd>', 'Command to run instead of claude')
  .option('--json', 'Output events as JSON')
  .action(async (session: string, options: orchestrateCmd.StartOptions) => {
    await orchestrateCmd.startSession(session, options);
  });

orcProgram
  .command('send <target> <message>')
  .description('Send message to Claude and track completion')
  .option('--pane <id>', '[DEPRECATED] Target pane ID - use target addressing instead')
  .option('--method <name>', 'Completion detection method')
  .option('-t, --timeout <ms>', 'Timeout in milliseconds')
  .option('--no-wait', 'Send without waiting for completion')
  .option('--json', 'Output as JSON')
  .action(async (target: string, message: string, options: orchestrateCmd.SendOptions) => {
    await orchestrateCmd.sendMessage(target, message, options);
  });

orcProgram
  .command('status <target>')
  .description('Show current Claude state and details')
  .option('--pane <id>', '[DEPRECATED] Target pane ID - use target addressing instead')
  .option('--json', 'Output as JSON')
  .action(async (target: string, options: orchestrateCmd.StatusOptions) => {
    await orchestrateCmd.showStatus(target, options);
  });

orcProgram
  .command('watch <target>')
  .description('Watch target events in real-time')
  .option('--pane <id>', '[DEPRECATED] Target pane ID - use target addressing instead')
  .option('--json', 'Output events as JSON')
  .option('-p, --poll <ms>', 'Poll interval in milliseconds')
  .action(async (target: string, options: orchestrateCmd.WatchOptions) => {
    await orchestrateCmd.watchSession(target, options);
  });

orcProgram
  .command('approve <target>')
  .description('Approve pending permission request')
  .option('-p, --pane <id>', '[DEPRECATED] Pane ID - use target addressing instead')
  .option('--auto', 'Auto-approve all future permissions (dangerous!)')
  .option('--deny', 'Deny instead of approve')
  .action(async (target: string, options: orchestrateCmd.ApproveOptions) => {
    await orchestrateCmd.approvePermission(target, options);
  });

orcProgram
  .command('answer <target> <choice>')
  .description('Answer a question with the given choice (use "text:..." to send feedback)')
  .option('-p, --pane <id>', '[DEPRECATED] Pane ID - use target addressing instead')
  .action(async (target: string, choice: string, options: { pane?: string }) => {
    await orchestrateCmd.answerQuestion(target, choice, options);
  });

orcProgram
  .command('experiment <method>')
  .description('Test a completion detection method')
  .option('-n, --runs <number>', 'Number of test runs')
  .option('--task <command>', 'Test command to run')
  .option('--json', 'Output as JSON')
  .action(async (method: string, options: orchestrateCmd.ExperimentOptions) => {
    await orchestrateCmd.runExperiment(method, options);
  });

orcProgram
  .command('methods')
  .description('List available completion detection methods')
  .action(async () => {
    await orchestrateCmd.listMethods();
  });

orcProgram
  .command('run <target> <message>')
  .description('Send task and auto-approve until idle (fire-and-forget)')
  .option('-p, --pane <id>', '[DEPRECATED] Target pane ID - use target addressing instead')
  .option('-a, --auto-approve', 'Auto-approve permissions and plans')
  .option('-t, --timeout <ms>', 'Timeout in milliseconds (default: 300000)')
  .option('--json', 'Output final state as JSON')
  .action(async (target: string, message: string, options: orchestrateCmd.RunOptions) => {
    await orchestrateCmd.runTask(target, message, options);
  });

// Auto-approve engine management
program
  .command('approve [request-id]')
  .description('Auto-approve engine management and manual approval')
  .option('--status', 'Show pending/approved/denied requests')
  .option('--deny <request-id>', 'Manually deny a pending request')
  .option('--start', 'Start the auto-approve engine')
  .option('--stop', 'Stop the auto-approve engine')
  .action(async (requestId: string | undefined, options: { status?: boolean; deny?: string; start?: boolean; stop?: boolean }) => {
    await approveCmd.approveCommand(requestId, options);
  });

// Parallel spawn command
program
  .command('spawn-parallel [wish-ids...]')
  .description('Spawn multiple Claude Code workers in parallel')
  .option('--all-ready', 'Spawn all wishes with Status: READY')
  .option('--skill <name>', 'Skill for all workers')
  .option('--no-auto-approve', 'Disable auto-approve')
  .option('--max <n>', 'Max concurrent workers', parseInt)
  .option('-s, --session <name>', 'Target tmux session')
  .action(async (wishIds: string[], options: spawnParallelCmd.SpawnParallelOptions) => {
    await spawnParallelCmd.spawnParallelCommand(wishIds, options);
  });

// Council command - dual-model deliberation
program
  .command('council')
  .description('Spawn dual Claude instances for multi-model deliberation')
  .option('-s, --session <name>', 'Target tmux session')
  .option('--preset <name>', 'Council preset to use')
  .option('--skill <skill>', 'Skill to load on both instances')
  .option('--no-focus', "Don't focus the new window")
  .action(async (options: councilCmd.CouncilOptions) => {
    await councilCmd.councilCommand(options);
  });

// Batch management commands
const batchProgram = program.command('batch').description('Manage parallel spawn batches');

batchProgram
  .command('status <batch-id>')
  .description('Show aggregated status for a batch')
  .action(async (batchId: string) => {
    const genieDir = getRepoGenieDir(process.cwd());
    await batchCmd.batchStatusCommand(genieDir, batchId);
  });

batchProgram
  .command('list')
  .description('List all batches')
  .action(async () => {
    const genieDir = getRepoGenieDir(process.cwd());
    await batchCmd.batchListCommand(genieDir);
  });

batchProgram
  .command('cancel <batch-id>')
  .description('Cancel all active workers in a batch')
  .action(async (batchId: string) => {
    const genieDir = getRepoGenieDir(process.cwd());
    await batchCmd.batchCancelCommand(genieDir, batchId);
  });

// ============================================================================
// Short Aliases (LLM-friendly)
// ============================================================================

// term w <id> -> term work <id>
program
  .command('w <target>')
  .description('Alias for "term work" - spawn worker bound to task')
  .option('--no-worktree', 'Use shared repo')
  .option('-s, --session <name>', 'Target session')
  .option('--skill <name>', 'Skill to invoke')
  .option('--profile <name>', 'Worker profile')
  .action(async (target: string, options: workCmd.WorkOptions) => {
    await workCmd.workCommand(target, options);
  });

// term s [skill] -> term spawn [skill]
program
  .command('s [skill]')
  .description('Alias for "term spawn" - spawn Claude with skill')
  .option('-s, --session <name>', 'Target session')
  .option('-p, --prompt <message>', 'Additional context')
  .option('--profile <name>', 'Worker profile')
  .action(async (skill: string | undefined, options: spawnCmd.SpawnOptions) => {
    await spawnCmd.spawnCommand(skill, options);
  });

// term d -> term dashboard
program
  .command('d')
  .description('Alias for "term dashboard" - show worker status')
  .option('-w, --watch', 'Auto-refresh')
  .option('-v, --verbose', 'Detailed info')
  .option('--json', 'JSON output')
  .action(async (options: { watch?: boolean; verbose?: boolean; json?: boolean }) => {
    await dashboardCmd.dashboardCommand(options);
  });

// term a -> term approve
program
  .command('a [request-id]')
  .description('Alias for "term approve" - approve pending permission')
  .option('--status', 'Show pending requests')
  .option('--start', 'Start auto-approve engine')
  .option('--stop', 'Stop auto-approve engine')
  .action(async (requestId: string | undefined, options: { status?: boolean; start?: boolean; stop?: boolean }) => {
    await approveCmd.approveCommand(requestId, options);
  });

// Skill shortcuts
program
  .command('forge <id>')
  .description('Shortcut for "term work <id> --skill forge"')
  .option('-s, --session <name>', 'Target session')
  .action(async (id: string, options: { session?: string }) => {
    await workCmd.workCommand(id, { ...options, skill: 'forge' } as workCmd.WorkOptions);
  });

program
  .command('review')
  .description('Shortcut for "term spawn review"')
  .option('-s, --session <name>', 'Target session')
  .option('-p, --prompt <message>', 'Additional context')
  .action(async (options: spawnCmd.SpawnOptions) => {
    await spawnCmd.spawnCommand('review', options);
  });

program.parse();
