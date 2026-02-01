#!/usr/bin/env bun

import { Command } from 'commander';
import { VERSION } from './lib/version.js';
import { setupCommand } from './commands/setup.js';
import { launchProfile, launchDefaultProfile, type LaunchOptions } from './commands/launch.js';
import {
  profilesListCommand,
  profilesAddCommand,
  profilesRemoveCommand,
  profilesDefaultCommand,
  profilesShowCommand,
} from './commands/profiles.js';
import { modelsCommand, configCommand } from './commands/models.js';

const program = new Command();

program
  .name('claudio')
  .description('Launch Claude Code with custom LLM router profiles')
  .version(VERSION)
  .option('--hooks <presets>', 'Override hooks (comma-separated: collaborative,supervised,sandboxed,audited)')
  .option('--no-hooks', 'Disable all hooks');

// Setup command
program
  .command('setup')
  .description('First-time setup wizard')
  .action(async () => {
    await setupCommand();
  });

// Launch command (explicit)
program
  .command('launch [profile]')
  .description('Launch Claude Code with optional profile')
  .option('--hooks <presets>', 'Override hooks (comma-separated)')
  .option('--no-hooks', 'Disable all hooks')
  .action(async (profile: string | undefined, cmdOptions) => {
    const options: LaunchOptions = {
      hooks: cmdOptions.hooks,
      noHooks: cmdOptions.noHooks,
    };

    if (profile) {
      await launchProfile(profile, options);
    } else {
      await launchDefaultProfile(options);
    }
  });

// Profiles command with subcommands
const profiles = program
  .command('profiles')
  .description('Manage profiles');

profiles
  .command('list', { isDefault: true })
  .description('List all profiles (* = default)')
  .action(async () => {
    await profilesListCommand();
  });

profiles
  .command('add')
  .description('Add new profile (interactive picker)')
  .action(async () => {
    await profilesAddCommand();
  });

profiles
  .command('rm <name>')
  .description('Delete profile')
  .action(async (name: string) => {
    await profilesRemoveCommand(name);
  });

profiles
  .command('default <name>')
  .description('Set default profile')
  .action(async (name: string) => {
    await profilesDefaultCommand(name);
  });

profiles
  .command('show <name>')
  .description('Show profile details')
  .action(async (name: string) => {
    await profilesShowCommand(name);
  });

// Models command
program
  .command('models')
  .description('List available models from router')
  .action(async () => {
    await modelsCommand();
  });

// Config command
program
  .command('config')
  .description('Show current config (URL, default profile)')
  .action(async () => {
    await configCommand();
  });

// Handle profile launch (no args = default, or named profile)
// This is the default action when no command is specified
program.action(async (options, command) => {
  const args = command.args;

  const launchOptions: LaunchOptions = {
    hooks: options.hooks,
    noHooks: options.hooks === false, // --no-hooks sets hooks to false
  };

  if (args.length === 0) {
    // No arguments - launch default profile
    await launchDefaultProfile(launchOptions);
    return;
  }

  // Profile name provided - launch named profile
  const profileName = args[0];
  await launchProfile(profileName, launchOptions);
});

program.parse();
