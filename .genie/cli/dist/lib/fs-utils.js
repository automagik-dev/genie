"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.pathExists = pathExists;
exports.ensureDir = ensureDir;
exports.copyDirectory = copyDirectory;
exports.copyFilePreserveParents = copyFilePreserveParents;
exports.toIsoId = toIsoId;
exports.listDirectories = listDirectories;
exports.removeDirectory = removeDirectory;
exports.moveDirectory = moveDirectory;
exports.snapshotDirectory = snapshotDirectory;
exports.readJsonFile = readJsonFile;
exports.writeJsonFile = writeJsonFile;
exports.collectFiles = collectFiles;
exports.backupGenieDirectory = backupGenieDirectory;
exports.finalizeBackup = finalizeBackup;
const fs_1 = __importDefault(require("fs"));
const fs_2 = require("fs");
const path_1 = __importDefault(require("path"));
async function pathExists(target) {
    try {
        await fs_2.promises.access(target, fs_1.default.constants.F_OK);
        return true;
    }
    catch {
        return false;
    }
}
async function ensureDir(target) {
    await fs_2.promises.mkdir(target, { recursive: true });
}
async function copyDirectory(source, destination, options = {}) {
    const shouldCopy = options.filter ?? (() => true);
    await ensureDir(path_1.default.dirname(destination));
    await fs_2.promises.cp(source, destination, {
        recursive: true,
        force: true,
        filter: (entry) => {
            const rel = path_1.default.relative(source, entry);
            if (rel === '') {
                return true;
            }
            return shouldCopy(rel);
        }
    });
}
async function copyFilePreserveParents(source, destination) {
    await ensureDir(path_1.default.dirname(destination));
    await fs_2.promises.copyFile(source, destination);
}
function toIsoId(date = new Date()) {
    return date.toISOString().replace(/[:.]/g, '-');
}
async function listDirectories(target) {
    try {
        const entries = await fs_2.promises.readdir(target, { withFileTypes: true });
        return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    }
    catch (error) {
        if (error && error.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}
async function removeDirectory(target) {
    await fs_2.promises.rm(target, { recursive: true, force: true });
}
async function moveDirectory(source, destination) {
    await ensureDir(path_1.default.dirname(destination));
    await fs_2.promises.rename(source, destination);
}
async function snapshotDirectory(source, destination) {
    const stagingRoot = path_1.default.join(path_1.default.dirname(source), `.genie-snapshot-${toIsoId()}`);
    const stagingTarget = path_1.default.join(stagingRoot, path_1.default.basename(source));
    await ensureDir(stagingRoot);
    await fs_2.promises.cp(source, stagingTarget, { recursive: true, force: true });
    await ensureDir(path_1.default.dirname(destination));
    await moveDirectory(stagingTarget, destination);
    await fs_2.promises.rm(stagingRoot, { recursive: true, force: true });
}
async function readJsonFile(filePath) {
    try {
        const content = await fs_2.promises.readFile(filePath, 'utf8');
        return JSON.parse(content);
    }
    catch (error) {
        if (error && error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}
async function writeJsonFile(filePath, payload) {
    await ensureDir(path_1.default.dirname(filePath));
    await fs_2.promises.writeFile(filePath, JSON.stringify(payload, null, 2));
}
async function collectFiles(root, options = {}) {
    const filter = options.filter ?? (() => true);
    const results = [];
    async function walk(current) {
        const entries = await fs_2.promises.readdir(current, { withFileTypes: true });
        for (const entry of entries) {
            const entryPath = path_1.default.join(current, entry.name);
            const relPath = path_1.default.relative(root, entryPath);
            if (!filter(relPath)) {
                continue;
            }
            if (entry.isDirectory()) {
                await walk(entryPath);
            }
            else if (entry.isFile()) {
                results.push(relPath);
            }
        }
    }
    await walk(root);
    return results.sort();
}
/**
 * Unified backup function for .genie directory
 *
 * For upgrades (pre_upgrade): Uses two-stage move to ensure clean replacement
 * For rollbacks (pre_rollback, old_genie): Uses snapshot copy to preserve original
 *
 * @param workspacePath - Root of workspace (where .genie lives)
 * @param reason - Why backup is being created (for logging/tracking)
 * @returns backupId for reference, or object with tempPath for two-stage moves
 */
async function backupGenieDirectory(workspacePath, reason) {
    const backupId = toIsoId();
    const genieDir = path_1.default.join(workspacePath, '.genie');
    // Two-stage move for upgrades (move old .genie out, create fresh, move backup in)
    if (reason === 'pre_upgrade') {
        const tempPath = path_1.default.join(workspacePath, `.genie-backup-${backupId}`);
        // Stage 1: Move old .genie/ to temp location at workspace root
        await fs_2.promises.rename(genieDir, tempPath);
        // Return both backupId and tempPath so init.ts can complete stage 3
        return { backupId, tempPath };
    }
    // Snapshot copy for rollbacks (preserve original, copy to backup)
    const backupRoot = path_1.default.join(genieDir, 'backups', backupId);
    // Create backup directory
    await ensureDir(backupRoot);
    // Backup entire .genie directory (atomic snapshot)
    await snapshotDirectory(genieDir, path_1.default.join(backupRoot, 'genie'));
    // Backup root documentation files if present
    const rootDocs = ['AGENTS.md', 'CLAUDE.md'];
    for (const doc of rootDocs) {
        const docPath = path_1.default.join(workspacePath, doc);
        if (await pathExists(docPath)) {
            await fs_2.promises.copyFile(docPath, path_1.default.join(backupRoot, doc));
        }
    }
    return backupId;
}
/**
 * Finalize two-stage backup by moving temp location into .genie/backups/
 * Called after new .genie/ has been created from templates
 *
 * @param workspacePath - Root of workspace
 * @param tempPath - Temporary backup location (e.g., .genie-backup-<timestamp>/)
 * @param backupId - Backup ID for final location
 */
async function finalizeBackup(workspacePath, tempPath, backupId) {
    const genieDir = path_1.default.join(workspacePath, '.genie');
    const finalPath = path_1.default.join(genieDir, 'backups', backupId, 'genie');
    // Ensure backups directory exists
    await ensureDir(path_1.default.join(genieDir, 'backups', backupId));
    // Stage 3: Move temp backup into new .genie/backups/<id>/genie/
    await fs_2.promises.rename(tempPath, finalPath);
    // Backup root documentation files if present
    const rootDocs = ['AGENTS.md', 'CLAUDE.md'];
    for (const doc of rootDocs) {
        const docPath = path_1.default.join(workspacePath, doc);
        if (await pathExists(docPath)) {
            await fs_2.promises.copyFile(docPath, path_1.default.join(genieDir, 'backups', backupId, doc));
        }
    }
}
