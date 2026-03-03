import { configExists, getProfile, listProfiles, removeProfile, setDefaultProfile } from '../lib/config.js';
import { promptConfirm } from '../lib/picker.js';
import { runAddProfileWizard } from '../lib/wizard.js';

export async function profilesListCommand(): Promise<void> {
  if (!configExists()) {
    console.error('❌ No config found. Run `claudio setup` first.');
    process.exit(1);
  }

  const profiles = await listProfiles();

  if (profiles.length === 0) {
    console.log('No profiles configured.');
    console.log('Run `claudio profiles add` to create one.');
    return;
  }

  console.log('\nProfiles:\n');
  for (const { name, profile, isDefault } of profiles) {
    const marker = isDefault ? ' *' : '';
    console.log(`  ${name}${marker}`);
    console.log(`    opus:   ${profile.opus}`);
    console.log(`    sonnet: ${profile.sonnet}`);
    console.log(`    haiku:  ${profile.haiku}`);
    console.log('');
  }

  console.log('(* = default)');
}

export async function profilesAddCommand(): Promise<void> {
  await runAddProfileWizard();
}

export async function profilesRemoveCommand(name: string): Promise<void> {
  if (!configExists()) {
    console.error('❌ No config found. Run `claudio setup` first.');
    process.exit(1);
  }

  const profile = await getProfile(name);
  if (!profile) {
    console.error(`❌ Profile "${name}" not found`);
    process.exit(1);
  }

  const confirmed = await promptConfirm(`Delete profile "${name}"?`);
  if (!confirmed) {
    console.log('Cancelled.');
    return;
  }

  await removeProfile(name);
  console.log(`✓ Profile "${name}" deleted`);
}

export async function profilesDefaultCommand(name: string): Promise<void> {
  if (!configExists()) {
    console.error('❌ No config found. Run `claudio setup` first.');
    process.exit(1);
  }

  try {
    await setDefaultProfile(name);
    console.log(`✓ Default profile set to "${name}"`);
  } catch (error: any) {
    console.error(`❌ ${error.message}`);
    process.exit(1);
  }
}

export async function profilesShowCommand(name: string): Promise<void> {
  if (!configExists()) {
    console.error('❌ No config found. Run `claudio setup` first.');
    process.exit(1);
  }

  const profile = await getProfile(name);
  if (!profile) {
    console.error(`❌ Profile "${name}" not found`);
    process.exit(1);
  }

  console.log(`\nProfile: ${name}\n`);
  console.log(`  opus:   ${profile.opus}`);
  console.log(`  sonnet: ${profile.sonnet}`);
  console.log(`  haiku:  ${profile.haiku}`);
}
