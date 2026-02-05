/**
 * genie profiles - Worker profile management commands
 *
 * Manages worker profiles in ~/.genie/config.json for configuring
 * how Claude Code workers are spawned (launcher, args, etc.)
 */

import { confirm, select, input } from '@inquirer/prompts';
import {
  loadGenieConfig,
  saveGenieConfig,
  getWorkerProfile,
  getDefaultWorkerProfile,
} from '../lib/genie-config.js';
import { WorkerProfile } from '../types/genie-config.js';

/**
 * genie profiles list - Show all configured worker profiles
 */
export async function profilesListCommand(): Promise<void> {
  const config = await loadGenieConfig();
  const profiles = config.workerProfiles || {};
  const profileNames = Object.keys(profiles);

  if (profileNames.length === 0) {
    console.log('\nNo worker profiles configured.\n');
    console.log('Run `genie profiles add <name>` to create one.');
    console.log('Or copy the template: cp templates/genie-config.template.json ~/.genie/config.json\n');
    return;
  }

  console.log('\n\x1b[1mWorker Profiles\x1b[0m\n');

  // Header
  const nameWidth = 20;
  const launcherWidth = 12;
  const claudioWidth = 20;
  console.log(
    `  ${'Name'.padEnd(nameWidth)}${'Launcher'.padEnd(launcherWidth)}${'Claudio Profile'.padEnd(claudioWidth)}Claude Args`
  );
  console.log(
    `  ${'-'.repeat(nameWidth - 2)}  ${'-'.repeat(launcherWidth - 2)}  ${'-'.repeat(claudioWidth - 2)}  ${'-'.repeat(30)}`
  );

  // Rows
  for (const name of profileNames) {
    const profile = profiles[name];
    const isDefault = config.defaultWorkerProfile === name;
    const marker = isDefault ? '*' : ' ';
    const claudioProfile = profile.claudioProfile || '-';
    const args = profile.claudeArgs.join(' ') || '-';

    console.log(
      `  ${marker}${name.padEnd(nameWidth - 1)}${profile.launcher.padEnd(launcherWidth)}${claudioProfile.padEnd(claudioWidth)}${args}`
    );
  }

  console.log('');
  if (config.defaultWorkerProfile) {
    console.log(`  * = default profile (${config.defaultWorkerProfile})\n`);
  }
}

/**
 * genie profiles add <name> - Create a new worker profile interactively
 */
export async function profilesAddCommand(name: string): Promise<void> {
  const config = await loadGenieConfig();

  // Check if profile already exists
  if (config.workerProfiles?.[name]) {
    console.error(`\x1b[31m✗ Profile '${name}' already exists.\x1b[0m`);
    console.log('Use `genie profiles show ${name}` to view it.');
    console.log('Use `genie profiles rm ${name}` to delete it first.\n');
    process.exit(1);
  }

  console.log(`\nCreating worker profile: ${name}\n`);

  // Prompt for launcher
  const launcher = await select({
    message: 'Launcher:',
    choices: [
      { value: 'claude', name: 'claude - Direct Claude Code' },
      { value: 'claudio', name: 'claudio - Via LLM router (custom models)' },
    ],
  }) as 'claude' | 'claudio';

  // Prompt for claudio profile if using claudio
  let claudioProfile: string | undefined;
  if (launcher === 'claudio') {
    claudioProfile = await input({
      message: 'Claudio profile name (from ~/.claudio/config.json):',
      default: 'coding-fast',
    });
  }

  // Prompt for claude args
  const claudeArgsStr = await input({
    message: 'Claude args (space-separated, e.g., --dangerously-skip-permissions --model opus):',
    default: '--dangerously-skip-permissions',
  });

  const claudeArgs = claudeArgsStr.trim() ? claudeArgsStr.trim().split(/\s+/) : [];

  // Build profile
  const profile: WorkerProfile = {
    launcher,
    claudeArgs,
  };
  if (claudioProfile) {
    profile.claudioProfile = claudioProfile;
  }

  // Save
  if (!config.workerProfiles) {
    config.workerProfiles = {};
  }
  config.workerProfiles[name] = profile;
  await saveGenieConfig(config);

  console.log(`\n\x1b[32m✓ Profile '${name}' created.\x1b[0m\n`);

  // Offer to set as default if no default exists
  if (!config.defaultWorkerProfile) {
    const setDefault = await confirm({
      message: 'Set as default profile?',
      default: true,
    });
    if (setDefault) {
      config.defaultWorkerProfile = name;
      await saveGenieConfig(config);
      console.log(`\x1b[32m✓ Default profile set to '${name}'.\x1b[0m\n`);
    }
  }
}

/**
 * genie profiles rm <name> - Delete a worker profile
 */
export async function profilesRmCommand(name: string): Promise<void> {
  const config = await loadGenieConfig();

  // Check if profile exists
  if (!config.workerProfiles?.[name]) {
    console.error(`\x1b[31m✗ Profile '${name}' not found.\x1b[0m`);
    const available = Object.keys(config.workerProfiles || {});
    if (available.length > 0) {
      console.log(`Available profiles: ${available.join(', ')}\n`);
    }
    process.exit(1);
  }

  // Confirm deletion
  const confirmed = await confirm({
    message: `Delete profile '${name}'?`,
    default: false,
  });

  if (!confirmed) {
    console.log('Cancelled.\n');
    return;
  }

  // Delete
  delete config.workerProfiles[name];

  // Clear default if it was this profile
  if (config.defaultWorkerProfile === name) {
    delete config.defaultWorkerProfile;
    console.log(`\x1b[33m⚠ Cleared default profile (was '${name}')\x1b[0m`);
  }

  await saveGenieConfig(config);
  console.log(`\x1b[32m✓ Profile '${name}' deleted.\x1b[0m\n`);
}

/**
 * genie profiles show <name> - Display profile details
 */
export async function profilesShowCommand(name: string): Promise<void> {
  const config = await loadGenieConfig();

  const profile = config.workerProfiles?.[name];
  if (!profile) {
    console.error(`\x1b[31m✗ Profile '${name}' not found.\x1b[0m`);
    const available = Object.keys(config.workerProfiles || {});
    if (available.length > 0) {
      console.log(`Available profiles: ${available.join(', ')}\n`);
    }
    process.exit(1);
  }

  const isDefault = config.defaultWorkerProfile === name;

  console.log(`\n\x1b[1mProfile: ${name}\x1b[0m${isDefault ? ' (default)' : ''}\n`);
  console.log(`  Launcher:        ${profile.launcher}`);
  if (profile.claudioProfile) {
    console.log(`  Claudio Profile: ${profile.claudioProfile}`);
  }
  console.log(`  Claude Args:     ${profile.claudeArgs.join(' ') || '(none)'}`);

  // Show example spawn command
  console.log('\n  \x1b[2mSpawn command preview:\x1b[0m');
  if (profile.launcher === 'claudio') {
    console.log(`  claudio launch ${profile.claudioProfile || 'default'} -- ${profile.claudeArgs.join(' ')}`);
  } else {
    console.log(`  claude ${profile.claudeArgs.join(' ')}`);
  }
  console.log('');
}

/**
 * genie profiles default [name] - Get or set default profile
 */
export async function profilesDefaultCommand(name?: string): Promise<void> {
  const config = await loadGenieConfig();

  // If no name provided, show current default
  if (!name) {
    if (config.defaultWorkerProfile) {
      console.log(`\nDefault profile: ${config.defaultWorkerProfile}\n`);
    } else {
      console.log('\nNo default profile set.');
      console.log('Run `genie profiles default <name>` to set one.\n');
    }
    return;
  }

  // Validate profile exists
  if (!config.workerProfiles?.[name]) {
    console.error(`\x1b[31m✗ Profile '${name}' not found.\x1b[0m`);
    const available = Object.keys(config.workerProfiles || {});
    if (available.length > 0) {
      console.log(`Available profiles: ${available.join(', ')}\n`);
    }
    process.exit(1);
  }

  // Set default
  config.defaultWorkerProfile = name;
  await saveGenieConfig(config);
  console.log(`\x1b[32m✓ Default profile set to '${name}'.\x1b[0m\n`);
}
