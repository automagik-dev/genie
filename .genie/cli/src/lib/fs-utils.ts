import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.access(target, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(target: string): Promise<void> {
  await fsp.mkdir(target, { recursive: true });
}

export async function copyDirectory(source: string, destination: string, options: { filter?: (relPath: string) => boolean } = {}): Promise<void> {
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

export async function copyFilePreserveParents(source: string, destination: string): Promise<void> {
  await ensureDir(path.dirname(destination));
  await fsp.copyFile(source, destination);
}

export function toIsoId(date: Date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

export async function listDirectories(target: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(target, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error: any) {
    if (error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

export async function removeDirectory(target: string): Promise<void> {
  await fsp.rm(target, { recursive: true, force: true });
}

export async function moveDirectory(source: string, destination: string): Promise<void> {
  await ensureDir(path.dirname(destination));
  await fsp.rename(source, destination);
}

export async function snapshotDirectory(source: string, destination: string): Promise<void> {
  const stagingRoot = path.join(path.dirname(source), `.genie-snapshot-${toIsoId()}`);
  const stagingTarget = path.join(stagingRoot, path.basename(source));
  await ensureDir(stagingRoot);
  await fsp.cp(source, stagingTarget, { recursive: true, force: true });
  await ensureDir(path.dirname(destination));
  await moveDirectory(stagingTarget, destination);
  await fsp.rm(stagingRoot, { recursive: true, force: true });
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(content) as T;
  } catch (error: any) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function writeJsonFile(filePath: string, payload: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fsp.writeFile(filePath, JSON.stringify(payload, null, 2));
}

export async function collectFiles(root: string, options: { filter?: (relPath: string) => boolean } = {}): Promise<string[]> {
  const filter = options.filter ?? (() => true);
  const results: string[] = [];
  async function walk(current: string) {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      const relPath = path.relative(root, entryPath);
      if (!filter(relPath)) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile()) {
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
export async function backupGenieDirectory(
  workspacePath: string,
  reason: 'old_genie' | 'pre_rollback' | 'pre_upgrade'
): Promise<string | { backupId: string; tempPath: string }> {
  const backupId = toIsoId();
  const genieDir = path.join(workspacePath, '.genie');

  // Two-stage move for upgrades (move old .genie out, create fresh, move backup in)
  if (reason === 'pre_upgrade') {
    const tempPath = path.join(workspacePath, `.genie-backup-${backupId}`);

    // Stage 1: Move old .genie/ to temp location at workspace root
    await fsp.rename(genieDir, tempPath);

    // Return both backupId and tempPath so init.ts can complete stage 3
    return { backupId, tempPath };
  }

  // Snapshot copy for rollbacks (preserve original, copy to backup)
  const backupRoot = path.join(genieDir, 'backups', backupId);

  // Create backup directory
  await ensureDir(backupRoot);

  // Backup entire .genie directory (atomic snapshot)
  await snapshotDirectory(genieDir, path.join(backupRoot, 'genie'));

  // Backup root documentation files if present
  const rootDocs = ['AGENTS.md', 'CLAUDE.md'];
  for (const doc of rootDocs) {
    const docPath = path.join(workspacePath, doc);
    if (await pathExists(docPath)) {
      await fsp.copyFile(docPath, path.join(backupRoot, doc));
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
export async function finalizeBackup(
  workspacePath: string,
  tempPath: string,
  backupId: string
): Promise<void> {
  const genieDir = path.join(workspacePath, '.genie');
  const finalPath = path.join(genieDir, 'backups', backupId, 'genie');

  // Ensure backups directory exists
  await ensureDir(path.join(genieDir, 'backups', backupId));

  // Stage 3: Move temp backup into new .genie/backups/<id>/genie/
  await fsp.rename(tempPath, finalPath);

  // Backup root documentation files if present
  const rootDocs = ['AGENTS.md', 'CLAUDE.md'];
  for (const doc of rootDocs) {
    const docPath = path.join(workspacePath, doc);
    if (await pathExists(docPath)) {
      await fsp.copyFile(docPath, path.join(genieDir, 'backups', backupId, doc));
    }
  }
}
