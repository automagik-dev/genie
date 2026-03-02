/**
 * Term Namespace — Low-level tmux operations, namespaced under
 * `genie term` per DEC-1.
 *
 * Full command tree ported from the standalone `term` binary.
 */

import { Command } from 'commander';
import * as spawnCmd from './spawn.js';
import * as workCmd from './work.js';
import * as workersCmd from './workers.js';
import * as dashboardCmd from './dashboard.js';
import * as approveCmd from './approve.js';
import * as orchestrateCmd from './orchestrate.js';
import * as closeCmd from './close.js';
import * as killCmd from './kill.js';
import * as daemonCmd from './daemon.js';
import * as createCmd from './create.js';
import * as updateCmd from './update.js';
import * as shipCmd from './ship.js';
import * as pushCmd from './push.js';
import * as syncCmd from './sync.js';
import * as eventsCmd from './events.js';
import * as shortcutsCmd from './shortcuts.js';
import * as spawnParallelCmd from './spawn-parallel.js';
import * as batchCmd from './batch.js';
import * as councilCmd from './council.js';
import * as resolveCmd from './resolve.js';
import * as historyCmd from './history.js';
import * as feedCmd from './feed.js';
import * as nextCmd from './next.js';
import * as scoreCmd from './score.js';
import { registerSessionNamespace } from './session/commands.js';
import { registerTaskNamespace } from './task/commands.js';
import { registerWishNamespace } from './wish/commands.js';
import { getRepoGenieDir } from '../lib/genie-dir.js';

export function registerTermNamespace(program: Command): void {
  const term = program
    .command('term')
    .description(`Low-level tmux session/pane operations (DEC-1: namespaced under genie)

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

PRIORITY QUEUE
  feed "<title>"      Add epic to priority queue with scoring
  feed "<title>" -l   Link epic to wish/brainstorm file

TASKS (beads integration)
  task create         Create new beads issue
  task update         Update task properties
  task ship           Mark done + merge + cleanup
  task ls             List ready tasks
  task link           Link task to wish

WISHES (planning + inspection)
  wish ls             List all wishes
  wish status <slug>  Show wish with linked tasks
  wish read <slug>    Read wish content (or section)
  wish sections <slug> List headings in a wish

SESSIONS (low-level tmux) - see: genie term session --help
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
  h    → history      f    → feed

Examples:
  genie term work bd-42              # Start working on task
  genie term spawn review            # Spawn with review skill
  genie term d                       # Show dashboard
  genie term h bd-42                 # Session catch-up`);

  // Register session namespace (genie term session <subcommand>)
  registerSessionNamespace(term);

  // Register task namespace (genie term task <subcommand>)
  registerTaskNamespace(term);

  // Register wish namespace (genie term wish <subcommand>)
  registerWishNamespace(term);

  // Shortcuts command
  term
    .command('shortcuts')
    .description('Warp-like keyboard shortcuts for tmux/Termux')
    .option('--tmux', 'Output tmux.conf snippet')
    .option('--termux', 'Output termux.properties snippet')
    .option('--install', 'Install to config files (interactive)')
    .action(async (options: shortcutsCmd.ShortcutsOptions) => {
      await shortcutsCmd.handleShortcuts(options);
    });

  // Skill-based spawning
  term
    .command('spawn [skill]')
    .description('Spawn Claude with a skill (interactive picker if no skill specified)')
    .option('-s, --session <name>', 'Target tmux session')
    .option('--no-worktree', 'Skip worktree creation when taskId provided')
    .option('--no-focus', "Don't focus the new pane")
    .option('-p, --prompt <message>', 'Additional context for the skill')
    .option('-t, --task-id <id>', 'Bind to beads issue')
    .option('--profile <name>', 'Worker profile to use')
    .action(async (skill: string | undefined, options: spawnCmd.SpawnOptions) => {
      await spawnCmd.spawnCommand(skill, options);
    });

  term
    .command('skills')
    .description('List available skills from all sources')
    .option('-v, --verbose', 'Show detailed skill info (path, source)')
    .option('-s, --source', 'Group skills by source (local, user, plugin)')
    .action(async (options: spawnCmd.SkillsOptions) => {
      await spawnCmd.listSkillsCommand(options);
    });

  term
    .command('brainstorm')
    .description('Spawn Claude with brainstorm skill (idea → design → spec)')
    .option('-s, --session <name>', 'Target tmux session')
    .option('--no-focus', "Don't focus the new pane")
    .option('-p, --prompt <message>', 'Additional context')
    .action(async (options: spawnCmd.SpawnOptions) => {
      await spawnCmd.spawnCommand('brainstorm', options);
    });

  // Watch session events
  term
    .command('watch <target>')
    .description('Watch target events in real-time')
    .option('--json', 'Output events as JSON')
    .option('--poll <ms>', 'Poll interval in milliseconds')
    .action(async (target: string, options: orchestrateCmd.WatchOptions) => {
      await orchestrateCmd.watchSession(target, options);
    });

  // Run task with monitoring
  term
    .command('run <target> <message>')
    .description('Send task and auto-approve until idle (fire-and-forget)')
    .option('-a, --auto-approve', 'Auto-approve permissions and plans')
    .option('-t, --timeout <ms>', 'Timeout in milliseconds (default: 300000)')
    .option('--json', 'Output final state as JSON')
    .action(async (target: string, message: string, options: orchestrateCmd.RunOptions) => {
      await orchestrateCmd.runTask(target, message, options);
    });

  // Feed epic into priority queue
  term
    .command('feed <title>')
    .alias('f')
    .description('Add epic to priority queue with scoring (genie term feed "title" [--link path])')
    .option('-l, --link <path>', 'Link to wish/brainstorm file on disk')
    .option('--json', 'Output as JSON')
    .action(async (title: string, options: feedCmd.FeedOptions) => {
      await feedCmd.feedCommand(title, options);
    });

  // Create beads issue command
  term
    .command('create <title>')
    .description('Create a new beads issue')
    .option('-d, --description <text>', 'Issue description')
    .option('-p, --parent <id>', 'Parent issue ID (creates dependency)')
    .option('--json', 'Output as JSON')
    .action(async (title: string, options: createCmd.CreateOptions) => {
      await createCmd.createCommand(title, options);
    });

  // Auto-pick next priority item
  term
    .command('next [target]')
    .description('Auto-pick highest priority unblocked epic and suggest next action')
    .option('--json', 'Output as JSON')
    .action(async (target: string | undefined, options: nextCmd.NextOptions) => {
      await nextCmd.nextCommand(target, options);
    });

  // View and update priority scores
  term
    .command('score <task-id>')
    .description('View and update priority scores for a task')
    .option('--set <dims>', 'Set dimensions (e.g., blocking=5,quickWin=1)')
    .option('--sofia', 'Trigger Sofia validation')
    .option('--json', 'Output as JSON')
    .action(async (taskId: string, options: scoreCmd.ScoreOptions) => {
      await scoreCmd.scoreCommand(taskId, options);
    });

  // Worker management commands
  term
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
    .action(async (target: string, options: workCmd.WorkOptions) => {
      await workCmd.workCommand(target, options);
    });

  term
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

  term
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

  term
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

  term
    .command('ship <task-id>')
    .description('Mark task as done and cleanup worker')
    .option('--keep-worktree', "Don't remove the worktree")
    .option('--merge', 'Merge worktree changes to main branch')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (taskId: string, options: shipCmd.ShipOptions) => {
      await shipCmd.shipCommand(taskId, options);
    });

  term
    .command('push')
    .description('Push current branch to remote (with branch protection)')
    .option('-u, --set-upstream', 'Set upstream for new branches (default: true)')
    .option('-f, --force', 'Force push with lease')
    .action(async (options: pushCmd.PushOptions) => {
      await pushCmd.pushCommand(options);
    });

  term
    .command('close <task-id>')
    .description('Close task/issue and cleanup worker')
    .option('--no-sync', 'Skip bd sync (beads only)')
    .option('--keep-worktree', "Don't remove the worktree")
    .option('--merge', 'Merge worktree changes to main branch')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (taskId: string, options: closeCmd.CloseOptions) => {
      await closeCmd.closeCommand(taskId, options);
    });

  term
    .command('kill <worker>')
    .description('Force kill a worker')
    .option('-y, --yes', 'Skip confirmation')
    .option('--keep-worktree', "Don't remove the worktree")
    .action(async (worker: string, options: killCmd.KillOptions) => {
      await killCmd.killCommand(worker, options);
    });

  // Answer command
  term
    .command('answer <worker> <choice>')
    .description('Answer a question for a worker (use "text:..." for text input)')
    .action(async (worker: string, choice: string) => {
      await orchestrateCmd.answerQuestion(worker, choice);
    });

  // Daemon management (beads auto-sync)
  const daemonProgram = term.command('daemon').description('Manage beads daemon for auto-sync');

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

  // Plugin sync command
  term
    .command('sync')
    .description('Sync plugin to ~/.claude/plugins (creates symlink for dev mode)')
    .option('-b, --build', 'Build plugin before syncing')
    .option('-v, --verbose', 'Show detailed output')
    .action(async (options: syncCmd.SyncOptions) => {
      await syncCmd.syncCommand(options);
    });

  // Events command
  term
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

  // History command
  term
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

  // Alias: h <worker>
  term
    .command('h <worker>')
    .description('Alias for "genie term history"')
    .option('--full', 'Show full conversation')
    .option('--since <n>', 'Last N exchanges', parseInt)
    .option('--json', 'JSON output')
    .option('--log-file <path>', 'Direct log file path')
    .action(async (worker: string, options: historyCmd.HistoryOptions) => {
      await historyCmd.historyCommand(worker, options);
    });

  // Target resolution diagnostic
  term
    .command('resolve <target>')
    .description('Resolve a target to its tmux pane (diagnostic, no side effects)')
    .option('--json', 'Output as JSON')
    .action(async (target: string, options: resolveCmd.ResolveOptions) => {
      await resolveCmd.resolveCommand(target, options);
    });

  // Orchestration commands (Claude Code automation)
  const orcProgram = term.command('orc').description('Orchestrate Claude Code sessions');

  orcProgram
    .command('start <session>')
    .description('Start Claude Code in a session with optional monitoring')
    .option('-m, --monitor', 'Enable real-time event monitoring')
    .option('-c, --command <cmd>', 'Command to run instead of claude')
    .option('--json', 'Output events as JSON')
    .action(async (session: string, options: orchestrateCmd.StartOptions) => {
      await orchestrateCmd.startSession(session, options);
    });

  orcProgram
    .command('send <target> <message>')
    .description('Send message to Claude and track completion')
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
    .option('--json', 'Output as JSON')
    .action(async (target: string, options: orchestrateCmd.StatusOptions) => {
      await orchestrateCmd.showStatus(target, options);
    });

  orcProgram
    .command('watch <target>')
    .description('Watch target events in real-time')
    .option('--json', 'Output events as JSON')
    .option('-p, --poll <ms>', 'Poll interval in milliseconds')
    .action(async (target: string, options: orchestrateCmd.WatchOptions) => {
      await orchestrateCmd.watchSession(target, options);
    });

  orcProgram
    .command('approve <target>')
    .description('Approve pending permission request')
    .option('--auto', 'Auto-approve all future permissions (dangerous!)')
    .option('--deny', 'Deny instead of approve')
    .action(async (target: string, options: orchestrateCmd.ApproveOptions) => {
      await orchestrateCmd.approvePermission(target, options);
    });

  orcProgram
    .command('answer <target> <choice>')
    .description('Answer a question with the given choice (use "text:..." to send feedback)')
    .action(async (target: string, choice: string) => {
      await orchestrateCmd.answerQuestion(target, choice);
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
    .option('-a, --auto-approve', 'Auto-approve permissions and plans')
    .option('-t, --timeout <ms>', 'Timeout in milliseconds (default: 300000)')
    .option('--json', 'Output final state as JSON')
    .action(async (target: string, message: string, options: orchestrateCmd.RunOptions) => {
      await orchestrateCmd.runTask(target, message, options);
    });

  // Auto-approve engine management
  term
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
  term
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
  term
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
  const batchProgram = term.command('batch').description('Manage parallel spawn batches');

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

  // genie term w <id> -> genie term work <id>
  term
    .command('w <target>')
    .description('Alias for "genie term work" - spawn worker bound to task')
    .option('--no-worktree', 'Use shared repo')
    .option('-s, --session <name>', 'Target session')
    .option('--skill <name>', 'Skill to invoke')
    .option('--profile <name>', 'Worker profile')
    .action(async (target: string, options: workCmd.WorkOptions) => {
      await workCmd.workCommand(target, options);
    });

  // genie term s [skill] -> genie term spawn [skill]
  term
    .command('s [skill]')
    .description('Alias for "genie term spawn" - spawn Claude with skill')
    .option('-s, --session <name>', 'Target session')
    .option('-p, --prompt <message>', 'Additional context')
    .option('--profile <name>', 'Worker profile')
    .action(async (skill: string | undefined, options: spawnCmd.SpawnOptions) => {
      await spawnCmd.spawnCommand(skill, options);
    });

  // genie term d -> genie term dashboard
  term
    .command('d')
    .description('Alias for "genie term dashboard" - show worker status')
    .option('-w, --watch', 'Auto-refresh')
    .option('-v, --verbose', 'Detailed info')
    .option('--json', 'JSON output')
    .action(async (options: { watch?: boolean; verbose?: boolean; json?: boolean }) => {
      await dashboardCmd.dashboardCommand(options);
    });

  // genie term a -> genie term approve
  term
    .command('a [request-id]')
    .description('Alias for "genie term approve" - approve pending permission')
    .option('--status', 'Show pending requests')
    .option('--start', 'Start auto-approve engine')
    .option('--stop', 'Stop auto-approve engine')
    .action(async (requestId: string | undefined, options: { status?: boolean; start?: boolean; stop?: boolean }) => {
      await approveCmd.approveCommand(requestId, options);
    });

  // Skill shortcuts
  term
    .command('forge <id>')
    .description('Shortcut for "genie term work <id> --skill forge"')
    .option('-s, --session <name>', 'Target session')
    .action(async (id: string, options: { session?: string }) => {
      await workCmd.workCommand(id, { ...options, skill: 'forge' } as workCmd.WorkOptions);
    });

  term
    .command('review')
    .description('Shortcut for "genie term spawn review"')
    .option('-s, --session <name>', 'Target session')
    .option('-p, --prompt <message>', 'Additional context')
    .action(async (options: spawnCmd.SpawnOptions) => {
      await spawnCmd.spawnCommand('review', options);
    });
}
