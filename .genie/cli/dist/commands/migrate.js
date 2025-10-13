"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runMigrateCommand = runMigrateCommand;
const view_helpers_1 = require("../lib/view-helpers");
const common_1 = require("../views/common");
const migrate_1 = require("../lib/migrate");
function parseFlags(args) {
    const flags = {};
    for (const arg of args) {
        if (arg === '--force')
            flags.force = true;
        if (arg === '--dry-run')
            flags.dryRun = true;
    }
    return flags;
}
async function runMigrateCommand(parsed, _config, _paths) {
    try {
        const flags = parseFlags(parsed.commandArgs);
        // Show banner
        console.log('╭───────────────────────────────────────────────────────────╮');
        console.log('│ Genie Migration Tool                                      │');
        console.log('│ Upgrade to npm-backed architecture                       │');
        console.log('╰───────────────────────────────────────────────────────────╯');
        console.log('');
        // Detect installation type
        const installType = (0, migrate_1.detectInstallType)();
        if (installType === 'clean') {
            await (0, view_helpers_1.emitView)((0, common_1.buildInfoView)('No Migration Needed', ['No existing Genie installation detected. Use `genie init` to set up a new installation.']), parsed.options);
            return;
        }
        if (installType === 'already_new') {
            await (0, view_helpers_1.emitView)((0, common_1.buildInfoView)('Already Migrated', ['Your installation is already using the new npm-backed architecture.']), parsed.options);
            return;
        }
        // Run migration
        console.log(`🔍 Old Genie installation detected`);
        console.log(`${flags.dryRun ? '🔬 DRY RUN MODE (no changes will be made)' : ''}`);
        console.log('');
        const result = await (0, migrate_1.runMigration)(flags);
        if (result.status === 'upgraded') {
            console.log('');
            await (0, view_helpers_1.emitView)((0, common_1.buildInfoView)('Migration Complete', [
                'Successfully upgraded to npm-backed architecture.',
                '',
                `Backup: ${result.backupPath}`,
                `Custom agents preserved: ${result.customAgentsPreserved.length}`,
                `Core agents removed: ${result.coreAgentsRemoved.length}`
            ]), parsed.options);
            console.log('');
            console.log('📝 Next steps:');
            console.log('   1. Test your installation: genie list agents');
            console.log('   2. Verify custom agents work as expected');
            console.log('   3. Check migration guide: .genie/guides/migration-core-template.md');
            console.log('');
        }
        else if (result.status === 'failed') {
            await (0, view_helpers_1.emitView)((0, common_1.buildErrorView)('Migration Failed', `Errors:\n${result.errors.join('\n')}`), parsed.options, { stream: process.stderr });
            process.exitCode = 1;
        }
    }
    catch (error) {
        await (0, view_helpers_1.emitView)((0, common_1.buildErrorView)('Migration Error', error instanceof Error ? error.message : String(error)), parsed.options, { stream: process.stderr });
        process.exitCode = 1;
    }
}
