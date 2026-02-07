/**
 * Session Commands Registration
 *
 * Registers all session-related commands under `term session` namespace.
 * Also provides deprecated top-level aliases for backwards compatibility.
 */

import { Command } from 'commander';
import * as newCmd from '../new.js';
import * as lsCmd from '../ls.js';
import * as attachCmd from '../attach.js';
import * as rmCmd from '../rm.js';
import * as readCmd from '../read.js';
import * as execCmd from '../exec.js';
import * as sendCmd from '../send.js';
import * as statusCmd from '../status.js';
import * as splitCmd from '../split.js';
import * as windowCmd from '../window.js';
import * as paneCmd from '../pane.js';
import * as hookCmd from '../hook.js';

/**
 * Show deprecation warning for old command usage
 */
function deprecationWarning(oldCmd: string, newCmd: string): void {
  console.warn(`\x1b[33m⚠️  '${oldCmd}' is deprecated. Use '${newCmd}' instead.\x1b[0m\n`);
}

/**
 * Register the `term session` namespace with all subcommands
 */
export function registerSessionNamespace(program: Command): void {
  const sessionProgram = program
    .command('session')
    .description('Tmux session management (low-level primitives)');

  // session new
  sessionProgram
    .command('new <name>')
    .description('Create a new tmux session')
    .option('-d, --workspace <path>', 'Working directory for the session')
    .option('-w, --worktree', 'Create git worktree in .worktrees/<name>/')
    .action(async (name: string, options: { workspace?: string; worktree?: boolean }) => {
      await newCmd.createNewSession(name, options);
    });

  // session ls
  sessionProgram
    .command('ls')
    .description('List all tmux sessions')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      await lsCmd.listAllSessions(options);
    });

  // session attach
  sessionProgram
    .command('attach <name>')
    .description('Attach to a tmux session')
    .action(async (name: string) => {
      await attachCmd.attachToSession(name);
    });

  // session rm
  sessionProgram
    .command('rm <name>')
    .description('Remove a tmux session')
    .option('--keep-worktree', 'Keep worktree folder when removing session')
    .action(async (name: string, options: { keepWorktree?: boolean }) => {
      await rmCmd.removeSession(name, options);
    });

  // session read
  sessionProgram
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
    .option('-p, --pane <id>', 'Target specific pane ID (e.g., %16)')
    .action(async (session: string, options: readCmd.ReadOptions) => {
      await readCmd.readSessionLogs(session, options);
    });

  // session exec
  sessionProgram
    .command('exec <session> <command...>')
    .description('Execute command in a tmux session')
    .option('-q, --quiet', 'Suppress stdout output')
    .option('-t, --timeout <ms>', 'Timeout in milliseconds (default: 120000)')
    .option('-p, --pane <id>', 'Target specific pane ID (e.g., %16)')
    .action(async (session: string, command: string[], options: { quiet?: boolean; timeout?: string; pane?: string }) => {
      await execCmd.executeInSession(session, command.join(' '), {
        quiet: options.quiet,
        timeout: options.timeout ? parseInt(options.timeout, 10) : undefined,
        pane: options.pane,
      });
    });

  // session send
  sessionProgram
    .command('send <session> <keys>')
    .description('Send keys to a tmux session (appends Enter by default)')
    .option('--no-enter', 'Send raw keys without appending Enter')
    .option('-p, --pane <id>', 'Target specific pane ID (e.g., %16)')
    .action(async (session: string, keys: string, options: { enter?: boolean; pane?: string }) => {
      await sendCmd.sendKeysToSession(session, keys, options);
    });

  // session info
  sessionProgram
    .command('info <session>')
    .description('Check session state (idle/busy, pane count)')
    .option('--command <id>', 'Check specific command status')
    .option('--json', 'Output as JSON')
    .action(async (session: string, options: statusCmd.StatusOptions) => {
      await statusCmd.getStatus(session, options);
    });

  // session split
  sessionProgram
    .command('split <session> [direction]')
    .description('Split pane in a tmux session (h=horizontal, v=vertical)')
    .option('-p, --pane <id>', 'Target pane ID to split (default: active pane)')
    .option('-d, --workspace <path>', 'Working directory for the new pane')
    .option('-w, --worktree <branch>', 'Create git worktree in .worktrees/<branch>/')
    .action(async (session: string, direction: string | undefined, options: { workspace?: string; worktree?: string; pane?: string }) => {
      await splitCmd.splitSessionPane(session, direction, options);
    });

  // session window (subcommand group)
  const windowProgram = sessionProgram.command('window').description('Manage tmux windows');

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

  // session pane (subcommand group)
  const paneProgram = sessionProgram.command('pane').description('Manage tmux panes');

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

  // session hook (subcommand group)
  const hookProgram = sessionProgram.command('hook').description('Manage tmux hooks');

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
}

/**
 * Register deprecated top-level aliases for backwards compatibility
 */
export function registerDeprecatedSessionAliases(program: Command): void {
  // These are hidden from help but still work with deprecation warnings

  program
    .command('new <name>', { hidden: true })
    .description('[DEPRECATED] Use "term session new"')
    .option('-d, --workspace <path>', 'Working directory')
    .option('-w, --worktree', 'Create git worktree')
    .action(async (name: string, options: { workspace?: string; worktree?: boolean }) => {
      deprecationWarning('term new', 'term session new');
      await newCmd.createNewSession(name, options);
    });

  program
    .command('attach <name>', { hidden: true })
    .description('[DEPRECATED] Use "term session attach"')
    .action(async (name: string) => {
      deprecationWarning('term attach', 'term session attach');
      await attachCmd.attachToSession(name);
    });

  program
    .command('rm <name>', { hidden: true })
    .description('[DEPRECATED] Use "term session rm"')
    .option('--keep-worktree', 'Keep worktree folder')
    .action(async (name: string, options: { keepWorktree?: boolean }) => {
      deprecationWarning('term rm', 'term session rm');
      await rmCmd.removeSession(name, options);
    });

  program
    .command('exec <session> <command...>', { hidden: true })
    .description('[DEPRECATED] Use "term session exec"')
    .option('-q, --quiet', 'Suppress output')
    .option('-t, --timeout <ms>', 'Timeout')
    .option('-p, --pane <id>', 'Target pane')
    .action(async (session: string, command: string[], options: { quiet?: boolean; timeout?: string; pane?: string }) => {
      deprecationWarning('term exec', 'term session exec');
      await execCmd.executeInSession(session, command.join(' '), {
        quiet: options.quiet,
        timeout: options.timeout ? parseInt(options.timeout, 10) : undefined,
        pane: options.pane,
      });
    });

  program
    .command('send <session> <keys>', { hidden: true })
    .description('[DEPRECATED] Use "term session send"')
    .option('--no-enter', 'No enter key')
    .option('-p, --pane <id>', 'Target pane')
    .action(async (session: string, keys: string, options: { enter?: boolean; pane?: string }) => {
      deprecationWarning('term send', 'term session send');
      await sendCmd.sendKeysToSession(session, keys, options);
    });

  program
    .command('split <session> [direction]', { hidden: true })
    .description('[DEPRECATED] Use "term session split"')
    .option('-p, --pane <id>', 'Target pane ID to split')
    .option('-d, --workspace <path>', 'Working directory')
    .option('-w, --worktree <branch>', 'Create worktree')
    .action(async (session: string, direction: string | undefined, options: { workspace?: string; worktree?: string; pane?: string }) => {
      deprecationWarning('term split', 'term session split');
      await splitCmd.splitSessionPane(session, direction, options);
    });

  program
    .command('info <session>', { hidden: true })
    .description('[DEPRECATED] Use "term session info"')
    .option('--command <id>', 'Command status')
    .option('--json', 'JSON output')
    .action(async (session: string, options: statusCmd.StatusOptions) => {
      deprecationWarning('term info', 'term session info');
      await statusCmd.getStatus(session, options);
    });
}
