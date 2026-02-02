#!/usr/bin/env bun

import { Command } from 'commander';
import { VERSION } from './lib/version.js';
import { installCommand } from './genie-commands/install.js';
import { setupCommand, type SetupOptions } from './genie-commands/setup.js';
import { updateCommand } from './genie-commands/update.js';
import { uninstallCommand } from './genie-commands/uninstall.js';
import { doctorCommand } from './genie-commands/doctor.js';
import {
  shortcutsShowCommand,
  shortcutsInstallCommand,
  shortcutsUninstallCommand,
} from './genie-commands/shortcuts.js';

const program = new Command();

program
  .name('genie')
  .description('Genie CLI - Setup and utilities for AI-assisted development')
  .version(VERSION);

// Install command - check/install prerequisites
program
  .command('install')
  .description('Verify and install prerequisites')
  .option('--check', 'Only check prerequisites, do not install')
  .option('--yes', 'Auto-approve all installations')
  .action(installCommand);

// Setup command - configure genie settings
program
  .command('setup')
  .description('Configure genie settings')
  .option('--quick', 'Accept all defaults')
  .option('--shortcuts', 'Only configure keyboard shortcuts')
  .option('--claudio', 'Only configure Claudio integration')
  .option('--terminal', 'Only configure terminal defaults')
  .option('--session', 'Only configure session settings')
  .option('--reset', 'Reset configuration to defaults')
  .option('--show', 'Show current configuration')
  .action(async (options: SetupOptions) => {
    await setupCommand(options);
  });

// Doctor command - diagnostic checks
program
  .command('doctor')
  .description('Run diagnostic checks on genie installation')
  .action(doctorCommand);

// Update command - pull latest and rebuild
program
  .command('update')
  .description('Update Genie CLI to the latest version')
  .action(updateCommand);

// Uninstall command - remove genie CLI
program
  .command('uninstall')
  .description('Remove Genie CLI and clean up hooks')
  .action(uninstallCommand);

// Shortcuts command group - manage tmux keyboard shortcuts
const shortcuts = program
  .command('shortcuts')
  .description('Manage tmux keyboard shortcuts');

// Make 'show' the default action for bare `genie shortcuts`
shortcuts.action(shortcutsShowCommand);

shortcuts
  .command('show')
  .description('Show available shortcuts and installation status')
  .action(shortcutsShowCommand);

shortcuts
  .command('install')
  .description('Install shortcuts to config files (~/.tmux.conf, shell rc)')
  .action(shortcutsInstallCommand);

shortcuts
  .command('uninstall')
  .description('Remove shortcuts from config files')
  .action(shortcutsUninstallCommand);

program.parse();
