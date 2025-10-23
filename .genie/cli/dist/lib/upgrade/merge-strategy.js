"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyUpgrade = applyUpgrade;
const path_1 = __importDefault(require("path"));
const fs_1 = require("fs");
const child_process_1 = require("child_process");
/**
 * Apply upgrade diff to workspace
 */
async function applyUpgrade(diff, context) {
    const { workspacePath, oldVersion, newVersion } = context;
    // Backup .genie directory
    await backupGenieDirectory(workspacePath);
    try {
        // Test if patch applies cleanly
        (0, child_process_1.execSync)(`git apply --check ${diff.patchFile}`, {
            cwd: workspacePath,
            stdio: 'pipe'
        });
        // Clean apply - no conflicts
        (0, child_process_1.execSync)(`git apply ${diff.patchFile}`, {
            cwd: workspacePath,
            stdio: 'pipe'
        });
        // Update .framework-version
        await updateFrameworkVersion(workspacePath, oldVersion, newVersion, context);
        // Clean up temp patch file
        await fs_1.promises.unlink(diff.patchFile).catch(() => { });
        return {
            success: true,
            filesUpdated: diff.affectedFiles.length,
            filesPreserved: 0, // TODO: Count user files
            conflicts: []
        };
    }
    catch (error) {
        // Conflicts detected
        const conflicts = parseConflicts(error, diff.affectedFiles);
        return {
            success: false,
            filesUpdated: 0,
            filesPreserved: 0,
            conflicts
        };
    }
}
/**
 * Backup .genie directory before upgrade
 */
async function backupGenieDirectory(workspacePath) {
    const genieDir = path_1.default.join(workspacePath, '.genie');
    const backupDir = path_1.default.join(workspacePath, `.genie.backup-${Date.now()}`);
    try {
        // Use cp -r for recursive copy
        (0, child_process_1.execSync)(`cp -r "${genieDir}" "${backupDir}"`, { stdio: 'pipe' });
    }
    catch (error) {
        throw new Error(`Failed to backup .genie directory: ${error instanceof Error ? error.message : String(error)}`);
    }
}
/**
 * Update .framework-version file
 */
async function updateFrameworkVersion(workspacePath, oldVersion, newVersion, context) {
    const versionPath = path_1.default.join(workspacePath, '.genie', '.framework-version');
    const now = new Date().toISOString();
    // Read existing version data (if exists)
    let existingData = {};
    try {
        const existingContent = await fs_1.promises.readFile(versionPath, 'utf8');
        existingData = JSON.parse(existingContent);
    }
    catch {
        // File doesn't exist or is invalid, start fresh
    }
    const versionData = {
        installed_version: newVersion,
        installed_commit: context.newCommit,
        installed_date: existingData.installed_date || now,
        package_name: 'automagik-genie',
        customized_files: existingData.customized_files || [],
        deleted_files: existingData.deleted_files || [],
        last_upgrade_date: now,
        previous_version: oldVersion,
        upgrade_history: [
            ...(existingData.upgrade_history || []),
            {
                from: oldVersion,
                to: newVersion,
                date: now,
                success: true
            }
        ]
    };
    await fs_1.promises.writeFile(versionPath, JSON.stringify(versionData, null, 2), 'utf8');
}
/**
 * Parse conflicts from git apply error output
 */
function parseConflicts(error, affectedFiles) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // Git apply error format: "error: patch failed: .genie/spells/learn.md:15"
    const conflictPattern = /error: patch failed: (.+?):(\d+)/g;
    const matches = [...errorMessage.matchAll(conflictPattern)];
    if (matches.length === 0) {
        // Generic error, assume all files conflicted
        return affectedFiles.map(file => ({
            file,
            hunks: [],
            reason: 'Failed to apply patch'
        }));
    }
    return matches.map(match => ({
        file: match[1],
        hunks: [`Line ${match[2]}`],
        reason: 'User modification conflicts with upstream changes'
    }));
}
