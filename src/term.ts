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
import { getRepoGenieDir } from './lib/genie-dir.js';

const program = new Command();

program
  .name('term')
  .description(`AI-friendly terminal orchestration (tmux wrapper)

Collaborative Usage:
  AI runs:    term exec genie:shell '<command>'
  Human watches: tmux attach -t genie
  AI reads:   term read genie

Workflow: new → exec → read → rm
Full control: window new/ls/rm, pane ls/rm, split, status

Skill-Based Spawning:
  term spawn          - Pick skill interactively
  term spawn <skill>  - Spawn Claude with skill loaded
  term skills         - List available skills
  term create <title> - Create beads issue

Worker Orchestration:
  term work <bd-id>   - Spawn worker bound to beads issue
  term work next      - Work on next ready issue
  term workers        - List all workers and states
  term dashboard      - Live worker status dashboard (--watch, -v, --json)
  term update <id>    - Update task (--status, --title, --blocked-by)
  term ship <id>      - Mark done + cleanup worker (optional merge)
  term close <bd-id>  - Close issue, cleanup worker
  term kill <worker>  - Force kill a stuck worker
  term daemon start   - Start beads daemon for auto-sync`)
  .version(VERSION);

// Session management
program
  .command('new <name>')
  .description('Create a new tmux session')
  .option('-d, --workspace <path>', 'Working directory for the session')
  .option('-w, --worktree', 'Create git worktree in .worktrees/<name>/')
  .action(async (name: string, options: { workspace?: string; worktree?: boolean }) => {
    await newCmd.createNewSession(name, options);
  });

program
  .command('ls')
  .description('List all tmux sessions')
  .option('--json', 'Output as JSON')
  .action(async (options: { json?: boolean }) => {
    await lsCmd.listAllSessions(options);
  });

program
  .command('attach <name>')
  .description('Attach to a tmux session')
  .action(async (name: string) => {
    await attachCmd.attachToSession(name);
  });

program
  .command('rm <name>')
  .description('Remove a tmux session')
  .option('--keep-worktree', 'Keep worktree folder when removing session')
  .action(async (name: string, options: { keepWorktree?: boolean }) => {
    await rmCmd.removeSession(name, options);
  });

// Log reading (CRITICAL for AI orchestration)
program
  .command('read <session>')
  .description('Read logs from a tmux session')
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
  .action(async (session: string, options: readCmd.ReadOptions) => {
    await readCmd.readSessionLogs(session, options);
  });

// Command execution
program
  .command('exec <session> <command...>')
  .description('Execute command in a tmux session')
  .option('-q, --quiet', 'Suppress stdout output')
  .option('-t, --timeout <ms>', 'Timeout in milliseconds (default: 120000)')
  .action(async (session: string, command: string[], options: { quiet?: boolean; timeout?: string }) => {
    await execCmd.executeInSession(session, command.join(' '), {
      quiet: options.quiet,
      timeout: options.timeout ? parseInt(options.timeout, 10) : undefined,
    });
  });

program
  .command('send <session> <keys>')
  .description('Send keys to a tmux session (appends Enter by default)')
  .option('--no-enter', 'Send raw keys without appending Enter')
  .option('-p, --pane <id>', 'Target specific pane ID (e.g., %16)')
  .action(async (session: string, keys: string, options: { enter?: boolean; pane?: string }) => {
    await sendCmd.sendKeysToSession(session, keys, options);
  });

// Pane splitting
program
  .command('split <session> [direction]')
  .description('Split pane in a tmux session (h=horizontal, v=vertical)')
  .option('-d, --workspace <path>', 'Working directory for the new pane')
  .option('-w, --worktree <branch>', 'Create git worktree in .worktrees/<branch>/')
  .action(async (session: string, direction: string | undefined, options: { workspace?: string; worktree?: string }) => {
    await splitCmd.splitSessionPane(session, direction, options);
  });

// Info command (renamed from status)
program
  .command('info <session>')
  .description('Check session state (idle/busy, pane count)')
  .option('--command <id>', 'Check specific command status')
  .option('--json', 'Output as JSON')
  .action(async (session: string, options: statusCmd.StatusOptions) => {
    await statusCmd.getStatus(session, options);
  });

// Window management
const windowProgram = program.command('window').description('Manage tmux windows');

windowProgram
  .command('new <session> <name>')
  .description('Create a new window in session')
  .action(async (session: string, name: string) => {
    await windowCmd.createWindow(session, name);
  });

windowProgram
  .command('ls <session>')
  .description('List windows in session')
  .option('--json', 'Output as JSON')
  .action(async (session: string, options: { json?: boolean }) => {
    await windowCmd.listWindows(session, options);
  });

windowProgram
  .command('rm <window-id>')
  .description('Remove window by ID')
  .action(async (windowId: string) => {
    await windowCmd.removeWindow(windowId);
  });

// Pane management
const paneProgram = program.command('pane').description('Manage tmux panes');

paneProgram
  .command('ls <session>')
  .description('List all panes in session')
  .option('--json', 'Output as JSON')
  .action(async (session: string, options: { json?: boolean }) => {
    await paneCmd.listPanes(session, options);
  });

paneProgram
  .command('rm <pane-id>')
  .description('Remove pane by ID')
  .action(async (paneId: string) => {
    await paneCmd.removePane(paneId);
  });

// Hook management
const hookProgram = program.command('hook').description('Manage tmux hooks');

hookProgram
  .command('set <event> <command>')
  .description('Set a tmux hook')
  .action(async (event: string, command: string) => {
    await hookCmd.setHook(event, command);
  });

hookProgram
  .command('list')
  .description('List all tmux hooks')
  .action(async () => {
    await hookCmd.listHooks();
  });

hookProgram
  .command('rm <event>')
  .description('Remove a tmux hook')
  .action(async (event: string) => {
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
  .description('List available skills')
  .action(async () => {
    await spawnCmd.listSkillsCommand();
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
  .command('watch <session>')
  .description('Watch session events in real-time')
  .option('-p, --pane <id>', 'Target specific pane ID (e.g., %16)')
  .option('--json', 'Output events as JSON')
  .option('--poll <ms>', 'Poll interval in milliseconds')
  .action(async (session: string, options: orchestrateCmd.WatchOptions) => {
    await orchestrateCmd.watchSession(session, options);
  });

// Run task with monitoring (promoted from orc run)
program
  .command('run <session> <message>')
  .description('Send task and auto-approve until idle (fire-and-forget)')
  .option('-p, --pane <id>', 'Target specific pane ID (e.g., %16)')
  .option('-a, --auto-approve', 'Auto-approve permissions and plans')
  .option('-t, --timeout <ms>', 'Timeout in milliseconds (default: 300000)')
  .option('--json', 'Output final state as JSON')
  .action(async (session: string, message: string, options: orchestrateCmd.RunOptions) => {
    await orchestrateCmd.runTask(session, message, options);
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
  .command('send <session> <message>')
  .description('Send message to Claude and track completion')
  .option('--pane <id>', 'Target specific pane ID (e.g., %16)')
  .option('--method <name>', 'Completion detection method')
  .option('-t, --timeout <ms>', 'Timeout in milliseconds')
  .option('--no-wait', 'Send without waiting for completion')
  .option('--json', 'Output as JSON')
  .action(async (session: string, message: string, options: orchestrateCmd.SendOptions) => {
    await orchestrateCmd.sendMessage(session, message, options);
  });

orcProgram
  .command('status <session>')
  .description('Show current Claude state and details')
  .option('--pane <id>', 'Target specific pane ID (e.g., %16)')
  .option('--json', 'Output as JSON')
  .action(async (session: string, options: orchestrateCmd.StatusOptions) => {
    await orchestrateCmd.showStatus(session, options);
  });

orcProgram
  .command('watch <session>')
  .description('Watch session events in real-time')
  .option('--pane <id>', 'Target specific pane ID (e.g., %16)')
  .option('--json', 'Output events as JSON')
  .option('-p, --poll <ms>', 'Poll interval in milliseconds')
  .action(async (session: string, options: orchestrateCmd.WatchOptions) => {
    await orchestrateCmd.watchSession(session, options);
  });

orcProgram
  .command('approve <session>')
  .description('Approve pending permission request')
  .option('-p, --pane <id>', 'Specific pane ID to target')
  .option('--auto', 'Auto-approve all future permissions (dangerous!)')
  .option('--deny', 'Deny instead of approve')
  .action(async (session: string, options: orchestrateCmd.ApproveOptions) => {
    await orchestrateCmd.approvePermission(session, options);
  });

orcProgram
  .command('answer <session> <choice>')
  .description('Answer a question with the given choice (use "text:..." to send feedback)')
  .option('-p, --pane <id>', 'Specific pane ID to target')
  .action(async (session: string, choice: string, options: { pane?: string }) => {
    await orchestrateCmd.answerQuestion(session, choice, options);
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
  .command('run <session> <message>')
  .description('Send task and auto-approve until idle (fire-and-forget)')
  .option('-p, --pane <id>', 'Target specific pane ID (e.g., %16)')
  .option('-a, --auto-approve', 'Auto-approve permissions and plans')
  .option('-t, --timeout <ms>', 'Timeout in milliseconds (default: 300000)')
  .option('--json', 'Output final state as JSON')
  .action(async (session: string, message: string, options: orchestrateCmd.RunOptions) => {
    await orchestrateCmd.runTask(session, message, options);
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

program.parse();
