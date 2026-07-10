#!/usr/bin/env bun

/**
 * genie — Single entrypoint CLI (zero-daemon v5).
 *
 * Surviving surface after the v4 runtime demolition:
 *   Utilities:  setup, doctor, update, install, uninstall, shortcuts
 *   Lifecycle:  init (scaffold), launch (Warp cockpit)
 *   State:      task, board  (SQLite-backed, .genie/genie.db)
 *   Hooks:      hook namespace + git hook dispatch
 */

import { Command } from 'commander';
import { doctorCommand } from './genie-commands/doctor.js';
import { type InstallOptions, installCommand } from './genie-commands/install.js';
import { type SetupOptions, setupCommand } from './genie-commands/setup.js';
import {
  shortcutsInstallCommand,
  shortcutsShowCommand,
  shortcutsUninstallCommand,
} from './genie-commands/shortcuts.js';
import { uninstallCommand } from './genie-commands/uninstall.js';
import { updateCommand } from './genie-commands/update.js';
import { registerHookNamespace } from './hooks/dispatch-command.js';
import { installWorkspaceCheck } from './lib/interactivity.js';
import { VERSION } from './lib/version.js';
import { registerInitCommand } from './term-commands/init.js';
import { registerLaunchCommand } from './term-commands/launch.js';
import { registerMcpCommand } from './term-commands/mcp.js';
import { registerOmniCommands } from './term-commands/omni.js';
import { registerV5BoardCommands } from './term-commands/v5-board.js';
import { registerV5TaskCommands } from './term-commands/v5-task.js';

const program = new Command();

program.name('genie').description('Genie CLI - AI-assisted development').version(VERSION);

// Global --no-interactive flag: disables all interactive prompts (scripting safety)
program.option('--no-interactive', 'Disable interactive prompts (exit 2 instead of prompting)');

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
  .option('--json', 'Emit JSON instead of human output')
  .option('--fix', 'Back up and remove detected v4 residue (backup-first, idempotent)')
  .action(doctorCommand);

program
  .command('update')
  .description('Update Genie CLI to the latest version (GitHub Releases)')
  .option('--dev', 'Switch to dev (pre-release) channel (.well-known/dev.json)')
  .option('--homolog', 'Switch to homolog (staging) channel (.well-known/homolog.json)')
  .option('--next', 'Deprecated alias for --dev (will be removed in a future release)')
  .option('--stable', 'Switch to stable channel (.well-known/latest.json)')
  .option('-y, --yes', 'Skip the TTY confirmation prompt (or set GENIE_UPDATE_YES=1)')
  .option('--no-restart', 'Skip the post-update binary verify probe')
  .option('--no-verify', 'Skip the post-update binary verify probe')
  .option('--skip-maintenance', 'Skip the post-update binary verify probe (or set GENIE_UPDATE_SKIP_MAINTENANCE=1)')
  .option('--rollback', 'Restore the most recent ~/.genie/bin/.previous binary backup')
  .action(updateCommand);

program
  .command('install')
  .description('Post-install finishing step — invoked by install.sh after the binary is linked')
  .option('--skip-v4-cleanup', 'Leave v4-era leftovers in place (orchestration rules, orphaned plugin caches)')
  .option('--integrations <mode>', 'Install client integrations: auto, codex, claude, all, or none', 'auto')
  .option('--skip-integrations', 'Alias for --integrations none')
  .action((options: InstallOptions) => installCommand(options));

program
  .command('uninstall')
  .description('Remove Genie CLI, plugins, marker-owned agents, and hooks')
  .option('--remove-marketplace', 'Also remove the shared Automagik marketplace registrations')
  .action(uninstallCommand);

const shortcuts = program.command('shortcuts').description('Manage tmux keyboard shortcuts');
shortcuts.action(shortcutsShowCommand);
shortcuts.command('show').description('Show available shortcuts and installation status').action(shortcutsShowCommand);
shortcuts
  .command('install')
  .description('Install shortcuts to config files (~/.tmux.conf, shell rc)')
  .action(shortcutsInstallCommand);
shortcuts.command('uninstall').description('Remove shortcuts from config files').action(shortcutsUninstallCommand);

// ============================================================================
// Hook namespace + git hook dispatch
// ============================================================================

registerHookNamespace(program);

// ============================================================================
// Bare task/board — thin commands over the zero-daemon SQLite state engine.
// ============================================================================

registerInitCommand(program);
registerLaunchCommand(program);
registerMcpCommand(program);
registerV5TaskCommands(program);
registerV5BoardCommands(program);
registerOmniCommands(program);

// ============================================================================
// Universal workspace check — ensures workspace exists before commands that need it
// ============================================================================

installWorkspaceCheck(program);

await program.parseAsync(process.argv);
