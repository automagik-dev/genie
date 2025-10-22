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
