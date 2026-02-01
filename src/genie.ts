#!/usr/bin/env bun

import { Command } from 'commander';
import { VERSION } from './lib/version.js';
import { installCommand } from './genie-commands/install.js';
import { setupCommand, quickSetupCommand } from './genie-commands/setup.js';
import { updateCommand } from './genie-commands/update.js';
import {
  showHooksCommand,
  installHooksCommand,
  uninstallHooksCommand,
  testHooksCommand,
} from './genie-commands/hooks.js';
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

// Setup command - interactive hook configuration
program
  .command('setup')
  .description('Configure hooks and settings (interactive wizard)')
  .option('--quick', 'Use recommended defaults without prompts')
  .action(async (options) => {
    if (options.quick) {
      await quickSetupCommand();
    } else {
      await setupCommand();
    }
  });

// Update command - pull latest and rebuild
program
  .command('update')
  .description('Update Genie CLI to the latest version')
  .action(updateCommand);

// Hooks command group - manage Claude Code hooks
const hooks = program
  .command('hooks')
  .description('Manage Claude Code hooks');

// Make 'show' the default action for bare `genie hooks`
hooks.action(showHooksCommand);

hooks
  .command('show')
  .description('Show current hook configuration')
  .action(showHooksCommand);

hooks
  .command('install')
  .description('Install hooks into Claude Code')
  .option('--force', 'Overwrite existing hooks')
  .action(installHooksCommand);

hooks
  .command('uninstall')
  .description('Remove hooks from Claude Code')
  .option('--keep-script', 'Keep the hook script file')
  .action(uninstallHooksCommand);

hooks
  .command('test')
  .description('Test the hook script')
  .action(testHooksCommand);

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
