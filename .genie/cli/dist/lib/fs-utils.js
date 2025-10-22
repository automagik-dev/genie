import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
export async function pathExists(target) {
    try {
        await fsp.access(target, fs.constants.F_OK);
        return true;
    }
    catch {
        return false;
    }
}
export async function ensureDir(target) {
    await fsp.mkdir(target, { recursive: true });
}
export async function copyDirectory(source, destination, options = {}) {
    const shouldCopy = options.filter ?? (() => true);
    await ensureDir(path.dirname(destination));
    await fsp.cp(source, destination, {
        recursive: true,
        force: true,
        filter: (entry) => {
            const rel = path.relative(source, entry);
            if (rel === '') {
                return true;
            }
            return shouldCopy(rel);
        }
    });
}
export async function copyFilePreserveParents(source, destination) {
    await ensureDir(path.dirname(destination));
    await fsp.copyFile(source, destination);
}
export function toIsoId(date = new Date()) {
    return date.toISOString().replace(/[:.]/g, '-');
}
export async function listDirectories(target) {
    try {
        const entries = await fsp.readdir(target, { withFileTypes: true });
        return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    }
    catch (error) {
        if (error && error.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}
export async function removeDirectory(target) {
    await fsp.rm(target, { recursive: true, force: true });
}
export async function moveDirectory(source, destination) {
    await ensureDir(path.dirname(destination));
    await fsp.rename(source, destination);
}
export async function snapshotDirectory(source, destination) {
    const stagingRoot = path.join(path.dirname(source), `.genie-snapshot-${toIsoId()}`);
    const stagingTarget = path.join(stagingRoot, path.basename(source));
    await ensureDir(stagingRoot);
    await fsp.cp(source, stagingTarget, { recursive: true, force: true });
    await ensureDir(path.dirname(destination));
    await moveDirectory(stagingTarget, destination);
    await fsp.rm(stagingRoot, { recursive: true, force: true });
}
export async function readJsonFile(filePath) {
    try {
        const content = await fsp.readFile(filePath, 'utf8');
        return JSON.parse(content);
    }
    catch (error) {
        if (error && error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}
export async function writeJsonFile(filePath, payload) {
    await ensureDir(path.dirname(filePath));
    await fsp.writeFile(filePath, JSON.stringify(payload, null, 2));
}
export async function collectFiles(root, options = {}) {
    const filter = options.filter ?? (() => true);
    const results = [];
    async function walk(current) {
        const entries = await fsp.readdir(current, { withFileTypes: true });
        for (const entry of entries) {
            const entryPath = path.join(current, entry.name);
            const relPath = path.relative(root, entryPath);
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
