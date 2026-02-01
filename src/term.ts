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

const program = new Command();

program
  .name('term')
  .description(`AI-friendly terminal orchestration (tmux wrapper)

Workflow: new → exec → read → rm
Full control: window new/ls/rm, pane ls/rm, split, status`)
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
  .action(async (session: string, command: string[]) => {
    await execCmd.executeInSession(session, command.join(' '));
  });

program
  .command('send <session> <keys>')
  .description('Send raw keys to a tmux session')
  .action(async (session: string, keys: string) => {
    await sendCmd.sendKeysToSession(session, keys);
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

// Status command
program
  .command('status <session>')
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

program.parse();
