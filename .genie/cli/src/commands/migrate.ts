import type { ParsedCommand, GenieConfig, ConfigPaths } from '../lib/types';
import { emitView } from '../lib/view-helpers';
import { buildErrorView, buildInfoView } from '../views/common';
import { runMigration, detectInstallType } from '../lib/migrate';

interface MigrateFlags {
  force?: boolean;
  dryRun?: boolean;
}

function parseFlags(args: string[]): MigrateFlags {
  const flags: MigrateFlags = {};

  for (const arg of args) {
    if (arg === '--force') flags.force = true;
    if (arg === '--dry-run') flags.dryRun = true;
  }

  return flags;
}

export async function runMigrateCommand(
  parsed: ParsedCommand,
  _config: GenieConfig,
  _paths: Required<ConfigPaths>
): Promise<void> {
  try {
    const flags = parseFlags(parsed.commandArgs);

    // Show banner
    console.log('╭───────────────────────────────────────────────────────────╮');
    console.log('│ Genie Migration Tool                                      │');
    console.log('│ Upgrade to npm-backed architecture                       │');
    console.log('╰───────────────────────────────────────────────────────────╯');
    console.log('');

    // Detect installation type
    const installType = detectInstallType();

    if (installType === 'clean') {
      await emitView(
        buildInfoView(
          'No Migration Needed',
          ['No existing Genie installation detected. Use `genie init` to set up a new installation.']
        ),
        parsed.options
      );
      return;
    }

    if (installType === 'already_new') {
      await emitView(
        buildInfoView(
          'Already Migrated',
          ['Your installation is already using the new npm-backed architecture.']
        ),
        parsed.options
      );
      return;
    }

    // Run migration
    console.log(`🔍 Old Genie installation detected`);
    console.log(`${flags.dryRun ? '🔬 DRY RUN MODE (no changes will be made)' : ''}`);
    console.log('');

    const result = await runMigration(flags);

    if (result.status === 'upgraded') {
      console.log('');
      await emitView(
        buildInfoView(
          'Migration Complete',
          [
            'Successfully upgraded to npm-backed architecture.',
            '',
            `Backup: ${result.backupPath}`,
            `Custom agents preserved: ${result.customAgentsPreserved.length}`,
            `Core agents removed: ${result.coreAgentsRemoved.length}`
          ]
        ),
        parsed.options
      );

      console.log('');
      console.log('📝 Next steps:');
      console.log('   1. Test your installation: genie list agents');
      console.log('   2. Verify custom agents work as expected');
      console.log('   3. Check migration guide: .genie/guides/migration-core-template.md');
      console.log('');
    } else if (result.status === 'failed') {
      await emitView(
        buildErrorView(
          'Migration Failed',
          `Errors:\n${result.errors.join('\n')}`
        ),
        parsed.options,
        { stream: process.stderr }
      );
      process.exitCode = 1;
    }
  } catch (error) {
    await emitView(
      buildErrorView(
        'Migration Error',
        error instanceof Error ? error.message : String(error)
      ),
      parsed.options,
      { stream: process.stderr }
    );
    process.exitCode = 1;
  }
}
