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

// Extract Claude passthrough args (everything after --)
// Must be done before Commander parses argv
const separatorIndex = process.argv.indexOf('--');
const claudePassthroughArgs: string[] = separatorIndex !== -1
  ? process.argv.slice(separatorIndex + 1)
  : [];
const claudioArgs = separatorIndex !== -1
  ? process.argv.slice(0, separatorIndex)
  : process.argv;

// Special case: "claudio -- <claude args>" with no claudio args
// Launch default profile directly, bypassing Commander
if (claudePassthroughArgs.length > 0 && claudioArgs.length === 2) {
  // Only have [node, script] before --, so just launch with passthrough
  await launchDefaultProfile({ claudeArgs: claudePassthroughArgs });
} else {

const program = new Command();

program
  .name('claudio')
  .description('Launch Claude Code with custom LLM router profiles')
  .version(VERSION);

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
  .description('Launch Claude Code with optional profile (use -- to pass args to Claude)')
  .action(async (profile: string | undefined) => {
    const options: LaunchOptions = {
      claudeArgs: claudePassthroughArgs,
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
program.action(async (_options, command) => {
  const args = command.args as string[];
  const profileName = args[0];

  const launchOptions: LaunchOptions = {
    claudeArgs: claudePassthroughArgs,
  };

  if (profileName) {
    await launchProfile(profileName, launchOptions);
  } else {
    await launchDefaultProfile(launchOptions);
  }
});

program.parse(claudioArgs);

} // end else block for special case
