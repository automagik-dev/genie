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
const paths_1 = require("../lib/paths");
const fs_utils_1 = require("../lib/fs-utils");
const package_1 = require("../lib/package");
const migrate_1 = require("../lib/migrate");
const run_1 = require("./run");
async function runUpdate(parsed, _config, _paths) {
    try {
        const flags = parseFlags(parsed.commandArgs);
        const cwd = process.cwd();
        const targetGenie = (0, paths_1.resolveTargetGeniePath)(cwd);
        const templateGenie = (0, paths_1.getTemplateGeniePath)();
        if (!(await (0, fs_utils_1.pathExists)(targetGenie))) {
            await (0, view_helpers_1.emitView)((0, common_1.buildWarningView)('Genie not initialized', [
                'No .genie directory found in this workspace.',
                'Run `npx automagik-genie init` first and then retry update.'
            ]), parsed.options);
            process.exitCode = 1;
            return;
        }
        const templateExists = await (0, fs_utils_1.pathExists)(templateGenie);
        if (!templateExists) {
            await (0, view_helpers_1.emitView)((0, common_1.buildErrorView)('Template missing', `Could not locate packaged .genie templates at ${templateGenie}`), parsed.options, { stream: process.stderr });
            process.exitCode = 1;
            return;
        }
        // Auto-detect and migrate old Genie structure
        const installType = (0, migrate_1.detectInstallType)();
        if (installType === 'old_genie') {
            console.log('');
            console.log('╭───────────────────────────────────────────────────────────╮');
            console.log('│ 🔄 Old Genie Structure Detected                          │');
            console.log('│ Migrating to npm-backed architecture...                  │');
            console.log('╰───────────────────────────────────────────────────────────╯');
            console.log('');
            const migrationResult = await (0, migrate_1.runMigration)({ dryRun: flags.dryRun });
            if (migrationResult.status === 'failed') {
                await (0, view_helpers_1.emitView)((0, common_1.buildErrorView)('Migration Failed', `Could not migrate to new architecture:\n${migrationResult.errors.join('\n')}`), parsed.options, { stream: process.stderr });
                process.exitCode = 1;
                return;
            }
            if (migrationResult.status === 'upgraded') {
                console.log('✅ Migration complete!');
                console.log(`   Backup: ${migrationResult.backupPath}`);
                console.log(`   Custom agents preserved: ${migrationResult.customAgentsPreserved.length}`);
                console.log(`   Core agents removed: ${migrationResult.coreAgentsRemoved.length}`);
                console.log('');
                console.log('📦 Continuing with template update...');
                console.log('');
            }
        }
        // Compute diff to provide context to update agent
        const diff = await computeDiff(templateGenie, targetGenie);
        if (flags.dryRun) {
            await (0, view_helpers_1.emitView)(buildUpdatePreviewView(diff), parsed.options);
            return;
        }
        if (!flags.force && diff.added.length === 0 && diff.modified.length === 0) {
            await (0, view_helpers_1.emitView)((0, common_1.buildInfoView)('No updates available', ['Your workspace already matches the packaged templates.']), parsed.options);
            return;
        }
        // Spawn update agent for intelligent orchestration
        console.log('');
        console.log('🔄 Spawning update agent for intelligent orchestration...');
        console.log('');
        const updatePrompt = buildUpdatePrompt(diff, installType, cwd);
        const agentParsed = {
            ...parsed,
            commandArgs: ['update', updatePrompt]
        };
        await (0, run_1.runChat)(agentParsed, _config, _paths);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await (0, view_helpers_1.emitView)((0, common_1.buildErrorView)('Update failed', message), parsed.options, { stream: process.stderr });
        process.exitCode = 1;
    }
}
function buildUpdatePrompt(diff, installType, cwd) {
    const version = (0, package_1.getPackageVersion)();
    return `# Update Context

## Current State
- **Project directory:** ${cwd}
- **Install type:** ${installType === 'old_genie' ? 'Migrated from v2.0.x' : 'v2.1+ architecture'}
- **Framework version:** ${version}

## Changes Detected
- **Files to add:** ${diff.added.length}
${diff.added.length > 0 ? diff.added.slice(0, 10).map(f => `  - ${f}`).join('\n') : ''}
${diff.added.length > 10 ? `  ... and ${diff.added.length - 10} more` : ''}

- **Files to update:** ${diff.modified.length}
${diff.modified.length > 0 ? diff.modified.slice(0, 10).map(f => `  - ${f}`).join('\n') : ''}
${diff.modified.length > 10 ? `  ... and ${diff.modified.length - 10} more` : ''}

## Your Task
1. Create backup of current state
2. Apply template updates intelligently
3. Preserve all user customizations (custom agents, wishes, reports)
4. Update version file
5. Generate update report with:
   - Files changed summary
   - Backup location
   - Verification steps
   - Next actions for user

## Success Criteria
- ✅ Backup created successfully
- ✅ Template updates applied
- ✅ User work preserved
- ✅ Version file updated
- ✅ Update report generated

Execute the update following your operating framework.`;
}
function parseFlags(args) {
    const flags = {};
    for (let i = 0; i < args.length; i++) {
        const token = args[i];
        if (token === '--dry-run') {
            flags.dryRun = true;
            continue;
        }
        if (token === '--force' || token === '-f') {
            flags.force = true;
            continue;
        }
    }
    return flags;
}
async function computeDiff(templateGenie, targetGenie) {
    const blacklist = (0, paths_1.getTemplateRelativeBlacklist)();
    const templateFiles = await (0, fs_utils_1.collectFiles)(templateGenie, {
        filter: (relPath) => {
            if (!relPath)
                return true;
            const head = relPath.split(path_1.default.sep)[0];
            return !blacklist.has(head);
        }
    });
    const added = [];
    const modified = [];
    const unchanged = [];
    for (const rel of templateFiles) {
        const templateFile = path_1.default.join(templateGenie, rel);
        const targetFile = path_1.default.join(targetGenie, rel);
        const exists = await (0, fs_utils_1.pathExists)(targetFile);
        if (!exists) {
            added.push(rel);
            continue;
        }
        const [templateContent, targetContent] = await Promise.all([
            fs_1.promises.readFile(templateFile, 'utf8'),
            fs_1.promises.readFile(targetFile, 'utf8')
        ]);
        if (templateContent === targetContent) {
            unchanged.push(rel);
        }
        else {
            modified.push(rel);
        }
    }
    return { added, modified, unchanged };
}
async function createBackup(targetGenie) {
    const backupId = (0, fs_utils_1.toIsoId)();
    const backupsRoot = path_1.default.join(targetGenie, 'backups');
    const backupDir = path_1.default.join(backupsRoot, backupId);
    await (0, fs_utils_1.ensureDir)(backupDir);
    await (0, fs_utils_1.snapshotDirectory)(targetGenie, path_1.default.join(backupDir, 'genie'));
    return backupId;
}
async function copyTemplateGenie(templateGenie, targetGenie) {
    const blacklist = (0, paths_1.getTemplateRelativeBlacklist)();
    await (0, fs_utils_1.copyDirectory)(templateGenie, targetGenie, {
        filter: (relPath) => {
            if (!relPath)
                return true;
            const head = relPath.split(path_1.default.sep)[0];
            if (blacklist.has(head)) {
                return false;
            }
            return true;
        }
    });
}
async function touchVersionFile(cwd) {
    const versionPath = (0, paths_1.resolveWorkspaceVersionPath)(cwd);
    const existing = await (0, fs_utils_1.pathExists)(versionPath);
    const version = (0, package_1.getPackageVersion)();
    const now = new Date().toISOString();
    if (!existing) {
        await (0, fs_utils_1.writeJsonFile)(versionPath, {
            version,
            installedAt: now,
            lastUpdated: now,
            migrationInfo: {}
        });
        return;
    }
    const content = await fs_1.promises.readFile(versionPath, 'utf8');
    const data = JSON.parse(content);
    data.version = version;
    data.lastUpdated = now;
    await (0, fs_utils_1.writeJsonFile)(versionPath, data);
}
function buildUpdatePreviewView(diff) {
    const messages = [
        diff.added.length ? `➕ Files to add: ${diff.added.length}` : '➕ Files to add: none',
        diff.modified.length ? `♻️ Files to update: ${diff.modified.length}` : '♻️ Files to update: none',
        diff.unchanged.length ? `➖ Unchanged files: ${diff.unchanged.length}` : '➖ Unchanged files: none',
        '',
        'Run without --dry-run to apply these changes.'
    ];
    return (0, common_1.buildInfoView)('Genie update preview', messages);
}
function buildUpdateSummaryView(diff, backupId) {
    const messages = [
        `✅ Update complete. Backup created: ${backupId}`,
        diff.added.length ? `➕ Added ${diff.added.length} file(s).` : '➕ No added files.',
        diff.modified.length ? `♻️ Updated ${diff.modified.length} file(s).` : '♻️ No modified files.',
        '📦 Backups stored under .genie/backups'
    ];
    return (0, common_1.buildInfoView)('Genie update applied', messages);
}
