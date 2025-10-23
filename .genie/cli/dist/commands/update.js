"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runUpdate = runUpdate;
const path_1 = __importDefault(require("path"));
const fs_1 = require("fs");
const view_helpers_1 = require("../lib/view-helpers");
const common_1 = require("../views/common");
const fs_utils_1 = require("../lib/fs-utils");
const upgrade_1 = require("../lib/upgrade");
async function runUpdate(parsed, _config, _paths) {
    try {
        const flags = parseFlags(parsed.commandArgs);
        const cwd = process.cwd();
        // Check if .genie exists
        const genieDir = path_1.default.join(cwd, '.genie');
        if (!await (0, fs_utils_1.pathExists)(genieDir)) {
            await (0, view_helpers_1.emitView)((0, common_1.buildErrorView)('Not initialized', 'No .genie directory found. Run `genie init` first.'), parsed.options, { stream: process.stderr });
            process.exitCode = 1;
            return;
        }
        // Check for .framework-version
        const versionPath = path_1.default.join(genieDir, '.framework-version');
        let installedVersion;
        let installedCommit;
        if (await (0, fs_utils_1.pathExists)(versionPath)) {
            const versionData = JSON.parse(await fs_1.promises.readFile(versionPath, 'utf8'));
            installedVersion = versionData.installed_version;
            installedCommit = versionData.installed_commit;
        }
        else {
            // Legacy installation without .framework-version
            // Check if version.json exists (old version tracking file)
            const legacyVersionPath = path_1.default.join(genieDir, 'state', 'version.json');
            let legacyVersion = null;
            if (await (0, fs_utils_1.pathExists)(legacyVersionPath)) {
                try {
                    const legacyData = JSON.parse(await fs_1.promises.readFile(legacyVersionPath, 'utf8'));
                    legacyVersion = legacyData.version;
                }
                catch {
                    // Ignore parse errors
                }
            }
            // Use legacy version if available, otherwise assume old version
            // Using 2.4.0-rc.1 as baseline for legacy installations (before .framework-version was added)
            installedVersion = legacyVersion || '2.4.0-rc.1';
            installedCommit = 'unknown';
            await (0, view_helpers_1.emitView)((0, common_1.buildWarningView)('Legacy installation detected', [
                'No .framework-version file found.',
                `Detected version: ${installedVersion}`,
                'Creating .framework-version for future updates...'
            ]), parsed.options);
            // Create .framework-version file for future updates
            const frameworkVersion = {
                installed_version: installedVersion,
                installed_commit: installedCommit,
                installed_date: new Date().toISOString(),
                package_name: 'automagik-genie',
                customized_files: [],
                deleted_files: [],
                last_upgrade_date: null,
                previous_version: null,
                upgrade_history: []
            };
            await fs_1.promises.writeFile(versionPath, JSON.stringify(frameworkVersion, null, 2), 'utf8');
        }
        // Check for updates
        const updateCheck = await (0, upgrade_1.checkForUpdates)(installedVersion, installedCommit);
        if (!updateCheck.available) {
            await (0, view_helpers_1.emitView)((0, common_1.buildInfoView)('Already up to date', [
                `Current version: ${installedVersion}`,
                `Latest version: ${updateCheck.latestVersion}`,
                '✅ No updates available'
            ]), parsed.options);
            return;
        }
        // Show update info
        await (0, view_helpers_1.emitView)((0, common_1.buildInfoView)('Update available', [
            `Current: ${installedVersion}`,
            `Available: ${updateCheck.latestVersion}`,
            '',
            'Changes:',
            ...updateCheck.changes.map(c => `  ${c}`)
        ]), parsed.options);
        // Preview mode - just show what would change
        if (flags.preview) {
            await (0, view_helpers_1.emitView)((0, common_1.buildInfoView)('Preview mode', ['Run `genie update` without --preview to apply changes']), parsed.options);
            return;
        }
        // Prompt for confirmation (unless --force)
        if (!flags.force) {
            const { default: prompts } = await import('prompts');
            const response = await prompts({
                type: 'confirm',
                name: 'proceed',
                message: 'Would you like to upgrade now?',
                initial: true
            });
            if (!response.proceed) {
                console.log('Update cancelled.');
                return;
            }
        }
        // Generate upgrade diff
        await (0, view_helpers_1.emitView)((0, common_1.buildInfoView)('Preparing upgrade', ['📦 Fetching framework diff...']), parsed.options);
        const upgradeContext = {
            oldVersion: installedVersion,
            newVersion: updateCheck.latestVersion,
            oldCommit: installedCommit,
            newCommit: updateCheck.latestCommit,
            workspacePath: cwd
        };
        const diff = await (0, upgrade_1.generateFrameworkDiff)(upgradeContext);
        if (!diff.hasChanges) {
            await (0, view_helpers_1.emitView)((0, common_1.buildInfoView)('No framework changes', ['All files are up to date']), parsed.options);
            return;
        }
        // Test merge
        await (0, view_helpers_1.emitView)((0, common_1.buildInfoView)('Testing merge', ['🧪 Checking for conflicts...']), parsed.options);
        const result = await (0, upgrade_1.applyUpgrade)(diff, upgradeContext);
        if (result.success) {
            // Clean merge succeeded
            await (0, view_helpers_1.emitView)((0, common_1.buildInfoView)('Upgrade complete', [
                `✅ Successfully upgraded to ${updateCheck.latestVersion}`,
                `Files updated: ${result.filesUpdated}`,
                `User files preserved: ${result.filesPreserved}`,
                `💾 Backup ID: ${result.backupId}`
            ]), parsed.options);
        }
        else {
            // Conflicts detected - needs Update Agent
            await (0, view_helpers_1.emitView)((0, common_1.buildWarningView)('Conflicts detected', [
                `⚠️  ${result.conflicts.length} file(s) have conflicts:`,
                ...result.conflicts.map(c => `   - ${c.file}`),
                '',
                `💾 Backup ID: ${result.backupId}`,
                '',
                '🤖 Update Agent required for conflict resolution.',
                'This feature is coming soon.',
                '',
                'For now, please:',
                '1. Review conflicts manually',
                '2. Or wait for Update Agent integration'
            ]), parsed.options);
            process.exitCode = 1;
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await (0, view_helpers_1.emitView)((0, common_1.buildErrorView)('Update failed', message), parsed.options, { stream: process.stderr });
        process.exitCode = 1;
    }
}
function parseFlags(args) {
    const flags = {};
    for (let i = 0; i < args.length; i++) {
        const token = args[i];
        if (token === '--preview' || token === '-p') {
            flags.preview = true;
        }
        else if (token === '--rollback') {
            flags.rollback = true;
        }
        else if (token === '--force' || token === '-f') {
            flags.force = true;
        }
    }
    return flags;
}
