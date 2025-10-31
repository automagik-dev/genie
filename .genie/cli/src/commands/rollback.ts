import path from 'path';
import type { ParsedCommand, GenieConfig, ConfigPaths } from '../lib/types';
import { emitView } from '../lib/view-helpers';
import { buildErrorView, buildInfoView } from '../views/common';
import {
  resolveTargetGeniePath,
  resolveBackupsRoot,
  resolveWorkspaceVersionPath
} from '../lib/paths';
import {
  pathExists,
  ensureDir,
  toIsoId,
  copyDirectory,
  writeJsonFile,
  snapshotDirectory,
  backupGenieDirectory
} from '../lib/fs-utils';
import { getPackageVersion } from '../lib/package';
import { promises as fsp } from 'fs';

interface RollbackFlags {
  list?: boolean;
  id?: string;
  latest?: boolean;
  force?: boolean;
}

export async function runRollback(
  parsed: ParsedCommand,
  _config: GenieConfig,
  _paths: Required<ConfigPaths>
): Promise<void> {
  try {
    const flags = parseFlags(parsed.commandArgs);
    const cwd = process.cwd();
    const targetGenie = resolveTargetGeniePath(cwd);
    const backupsRoot = resolveBackupsRoot(cwd);

    if (!(await pathExists(targetGenie))) {
      await emitView(buildInfoView('Nothing to rollback', ['No .genie directory found in this workspace.']), parsed.options);
      return;
    }

    if (!(await pathExists(backupsRoot))) {
      await emitView(buildInfoView('No backups found', ['The .genie/backups directory is empty.']), parsed.options);
      return;
    }

    const backupIds = await listBackupIds(backupsRoot);
    if (backupIds.length === 0) {
      await emitView(buildInfoView('No backups found', ['The .genie/backups directory is empty.']), parsed.options);
      return;
    }

    if (flags.list) {
      await emitView(buildInfoView('Available backups', backupIds.map((id) => `• ${id}`)), parsed.options);
      return;
    }

    const targetId = selectBackupId(backupIds, flags);
    if (!targetId) {
      await emitView(buildInfoView('Rollback cancelled', ['No backup selected. Pass --id <backupId> to choose a specific snapshot.']), parsed.options);
      return;
    }

    const backupDir = path.join(backupsRoot, targetId, 'genie');
    if (!(await pathExists(backupDir))) {
      await emitView(buildErrorView('Invalid backup', `Backup ${targetId} does not contain a genie snapshot.`), parsed.options, { stream: process.stderr });
      process.exitCode = 1;
      return;
    }

    // Backup current state before restoring (using unified backup)
    // pre_rollback always returns a string (copy-based backup, not two-stage move)
    const backupResult = await backupGenieDirectory(cwd, 'pre_rollback');
    const preBackupId = typeof backupResult === 'string' ? backupResult : backupResult.backupId;

    await restoreFromBackup(targetGenie, backupDir);

    // Restore root documentation files if they exist in backup (now at backup root, not in docs/)
    await restoreRootDocs(cwd, path.join(backupsRoot, targetId));

    await mergeBackupHistories(targetGenie, backupsRoot, preBackupId);
    await touchVersionFile(cwd, 'rollback');

    await emitView(buildInfoView('Rollback complete', [
      `Restored snapshot: ${targetId}`,
      `Previous state stored as backup: ${preBackupId}`
    ]), parsed.options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await emitView(buildErrorView('Rollback failed', message), parsed.options, { stream: process.stderr });
    process.exitCode = 1;
  }
}

function parseFlags(args: string[]): RollbackFlags {
  const flags: RollbackFlags = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--list') {
      flags.list = true;
      continue;
    }
    if (token === '--latest') {
      flags.latest = true;
      continue;
    }
    if (token === '--id' && args[i + 1]) {
      flags.id = args[i + 1];
      i++;
      continue;
    }
    if (token.startsWith('--id=')) {
      flags.id = token.split('=')[1];
      continue;
    }
    if (token === '--force' || token === '-f') {
      flags.force = true;
      continue;
    }
  }
  return flags;
}

async function listBackupIds(backupsRoot: string): Promise<string[]> {
  const entries = await fsp.readdir(backupsRoot, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
}

function selectBackupId(ids: string[], flags: RollbackFlags): string | undefined {
  if (flags.id) {
    return ids.find((id) => id === flags.id);
  }
  if (flags.latest || !flags.force) {
    return ids[0];
  }
  return undefined;
}

// Removed - now uses unified backupGenieDirectory() function

async function restoreFromBackup(targetGenie: string, backupGenieDir: string): Promise<void> {
  const stagingDir = path.join(path.dirname(targetGenie), `.genie-restore-${toIsoId()}`);
  await copyDirectory(backupGenieDir, stagingDir);
  const previousDir = `${targetGenie}.previous-${toIsoId()}`;
  await fsp.rename(targetGenie, previousDir);
  await fsp.rename(stagingDir, targetGenie);
  // Preserve backups from previous state by merging later
  await mergeBackups(previousDir, targetGenie);
  await fsp.rm(previousDir, { recursive: true, force: true });
}

async function mergeBackups(previousDir: string, targetGenie: string): Promise<void> {
  const previousBackups = path.join(previousDir, 'backups');
  const targetBackups = path.join(targetGenie, 'backups');
  await ensureDir(targetBackups);
  const exists = await pathExists(previousBackups);
  if (!exists) {
    return;
  }
  const snapshots = await fsp.readdir(previousBackups, { withFileTypes: true });
  for (const snapshot of snapshots) {
    if (!snapshot.isDirectory()) continue;
    const source = path.join(previousBackups, snapshot.name);
    const destination = path.join(targetBackups, snapshot.name);
    if (await pathExists(destination)) {
      continue;
    }
    await fsp.rename(source, destination);
  }
}

async function mergeBackupHistories(targetGenie: string, backupsRoot: string, preBackupId: string): Promise<void> {
  await ensureDir(backupsRoot);
  const recordDir = path.join(backupsRoot, preBackupId, 'metadata');
  await ensureDir(recordDir);
  await fsp.writeFile(path.join(recordDir, 'note.txt'), 'Created automatically before rollback.');
}

async function restoreRootDocs(cwd: string, backupRoot: string): Promise<void> {
  // Root docs are now stored directly in backup root (not in docs/ subfolder)
  const rootDocsFiles = ['AGENTS.md', 'CLAUDE.md'];
  for (const file of rootDocsFiles) {
    const srcPath = path.join(backupRoot, file);
    const destPath = path.join(cwd, file);
    if (await pathExists(srcPath)) {
      await fsp.copyFile(srcPath, destPath);
    }
  }
}

async function touchVersionFile(cwd: string, reason: 'rollback'): Promise<void> {
  const versionPath = resolveWorkspaceVersionPath(cwd);
  const version = getPackageVersion();
  const now = new Date().toISOString();
  const existing = await pathExists(versionPath);
  if (!existing) {
    await writeJsonFile(versionPath, {
      version,
      installedAt: now,
      lastUpdated: now,
      migrationInfo: {
        lastAction: reason
      }
    });
    return;
  }
  const raw = await fsp.readFile(versionPath, 'utf8');
  const parsed = JSON.parse(raw);
  parsed.version = version;
  parsed.lastUpdated = now;
  parsed.migrationInfo = {
    ...(parsed.migrationInfo || {}),
    lastAction: reason
  };
  await writeJsonFile(versionPath, parsed);
}
