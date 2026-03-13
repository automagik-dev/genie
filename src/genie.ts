#!/usr/bin/env bun

/**
 * genie — Single entrypoint CLI with namespaces:
 *   team, task, agent + top-level: work, council, send, inbox, done, status
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { doctorCommand } from './genie-commands/doctor.js';
import { type SessionOptions, sessionCommand } from './genie-commands/session.js';
import { type SetupOptions, setupCommand } from './genie-commands/setup.js';
import {
  shortcutsInstallCommand,
  shortcutsShowCommand,
  shortcutsUninstallCommand,
} from './genie-commands/shortcuts.js';
import { uninstallCommand } from './genie-commands/uninstall.js';
import { updateCommand } from './genie-commands/update.js';
import { sanitizeTeamName } from './lib/claude-native-teams.js';
import { resolveTeamShortcut } from './lib/team-shortcut.js';
import { VERSION } from './lib/version.js';

import { registerHookNamespace } from './hooks/dispatch-command.js';
import { registerAgentNamespace } from './term-commands/agents.js';
import * as councilCmd from './term-commands/council.js';
import { registerDirNamespace } from './term-commands/dir.js';
import { registerSendInboxCommands } from './term-commands/msg.js';
import { registerStateCommands } from './term-commands/state.js';
import { registerTaskNamespace } from './term-commands/task/commands.js';
// Provider-selectable orchestration namespaces (genie-cli-teams)
import { registerTeamNamespace } from './term-commands/team.js';
import * as workCmd from './term-commands/work.js';

const program = new Command();

program.name('genie').description('Genie CLI - Setup and utilities for AI-assisted development').version(VERSION);

// Setup command - configure genie settings
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

// Doctor command - diagnostic checks
program.command('doctor').description('Run diagnostic checks on genie installation').action(doctorCommand);

// Update command - pull latest and rebuild
program.command('update').description('Update Genie CLI to the latest version').action(updateCommand);

// Uninstall command - remove genie CLI
program.command('uninstall').description('Remove Genie CLI and clean up hooks').action(uninstallCommand);

// Internal handler for session opening (hidden -- user invokes via `genie` or `genie <team>`)
program
  .command('_open [team]', { hidden: true })
  .option('-r, --reset', 'Kill existing session and start fresh')
  .option('-d, --dir <path>', 'Working directory (default: cwd)')
  .action(async (team: string | undefined, options: SessionOptions) => {
    if (team) options.team = team;
    await sessionCommand(options);
  });

// Shortcuts command group - manage tmux keyboard shortcuts
const shortcuts = program.command('shortcuts').description('Manage tmux keyboard shortcuts');

// Make 'show' the default action for bare `genie shortcuts`
shortcuts.action(shortcutsShowCommand);

shortcuts.command('show').description('Show available shortcuts and installation status').action(shortcutsShowCommand);

shortcuts
  .command('install')
  .description('Install shortcuts to config files (~/.tmux.conf, shell rc)')
  .action(shortcutsInstallCommand);

shortcuts.command('uninstall').description('Remove shortcuts from config files').action(shortcutsUninstallCommand);

// ============================================================================
// Provider-selectable orchestration namespaces (genie-cli-teams)
// ============================================================================

registerTeamNamespace(program);
registerAgentNamespace(program);
registerDirNamespace(program);
registerSendInboxCommands(program);
registerTaskNamespace(program);
registerStateCommands(program);
registerHookNamespace(program);

// ============================================================================
// Top-level commands (migrated from genie term)
// ============================================================================

// genie work <target> — spawn worker bound to task
program
  .command('work <target>')
  .description('Spawn worker bound to task (target: task-id, "next", or "wish")')
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

// genie council — dual-model deliberation
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

// ============================================================================
// Team shortcut routing: genie <team> -> genie _open <team>
// ============================================================================

// Collect all registered subcommand names (+ aliases)
const knownCommands = new Set<string>();
for (const cmd of program.commands) {
  knownCommands.add(cmd.name());
  for (const alias of cmd.aliases()) {
    knownCommands.add(alias);
  }
}
knownCommands.add('help');

const shortcutResult = resolveTeamShortcut(process.argv.slice(2), knownCommands, (name) => {
  try {
    return existsSync(join(homedir(), '.claude', 'teams', sanitizeTeamName(name)));
  } catch {
    return false;
  }
});

if (shortcutResult.collisionWarning) {
  console.warn(shortcutResult.collisionWarning);
}

process.argv = [...process.argv.slice(0, 2), ...shortcutResult.args];

program.parse();
