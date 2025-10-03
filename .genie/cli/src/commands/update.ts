import path from 'path';
import { promises as fsp } from 'fs';
import type { ParsedCommand, GenieConfig, ConfigPaths } from '../lib/types';
import { emitView } from '../lib/view-helpers';
import { buildErrorView, buildInfoView, buildWarningView } from '../views/common';
import {
  getTemplateGeniePath,
  getTemplateRelativeBlacklist,
  resolveTargetGeniePath,
  resolveBackupsRoot,
  resolveWorkspaceVersionPath
} from '../lib/paths';
import {
  pathExists,
  ensureDir,
  copyDirectory,
  toIsoId,
  collectFiles,
  writeJsonFile,
  snapshotDirectory
} from '../lib/fs-utils';
import { getPackageVersion } from '../lib/package';

interface UpdateFlags {
  dryRun?: boolean;
  force?: boolean;
}

interface DiffSummary {
  added: string[];
  modified: string[];
  unchanged: string[];
}

export async function runUpdate(
  parsed: ParsedCommand,
  _config: GenieConfig,
  _paths: Required<ConfigPaths>
): Promise<void> {
  try {
    const flags = parseFlags(parsed.commandArgs);
    const cwd = process.cwd();
    const targetGenie = resolveTargetGeniePath(cwd);
    const templateGenie = getTemplateGeniePath();

    if (!(await pathExists(targetGenie))) {
      await emitView(buildWarningView('Genie not initialized', [
        'No .genie directory found in this workspace.',
        'Run `npx automagik-genie init` first and then retry update.'
      ]), parsed.options);
      process.exitCode = 1;
      return;
    }

    const templateExists = await pathExists(templateGenie);
    if (!templateExists) {
      await emitView(buildErrorView('Template missing', `Could not locate packaged .genie templates at ${templateGenie}`), parsed.options, { stream: process.stderr });
      process.exitCode = 1;
      return;
    }

    const diff = await computeDiff(templateGenie, targetGenie);
    if (flags.dryRun) {
      await emitView(buildUpdatePreviewView(diff), parsed.options);
      return;
    }

    if (!flags.force && diff.added.length === 0 && diff.modified.length === 0) {
      await emitView(buildInfoView('No updates available', ['Your workspace already matches the packaged templates.']), parsed.options);
      return;
    }

    const backupId = await createBackup(targetGenie);
    await copyTemplateGenie(templateGenie, targetGenie);
    await touchVersionFile(cwd);

    await emitView(buildUpdateSummaryView(diff, backupId), parsed.options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await emitView(buildErrorView('Update failed', message), parsed.options, { stream: process.stderr });
    process.exitCode = 1;
  }
}

function parseFlags(args: string[]): UpdateFlags {
  const flags: UpdateFlags = {};
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

async function computeDiff(templateGenie: string, targetGenie: string): Promise<DiffSummary> {
  const blacklist = getTemplateRelativeBlacklist();
  const templateFiles = await collectFiles(templateGenie, {
    filter: (relPath) => {
      if (!relPath) return true;
      const head = relPath.split(path.sep)[0];
      return !blacklist.has(head);
    }
  });

  const added: string[] = [];
  const modified: string[] = [];
  const unchanged: string[] = [];

  for (const rel of templateFiles) {
    const templateFile = path.join(templateGenie, rel);
    const targetFile = path.join(targetGenie, rel);
    const exists = await pathExists(targetFile);
    if (!exists) {
      added.push(rel);
      continue;
    }
    const [templateContent, targetContent] = await Promise.all([
      fsp.readFile(templateFile, 'utf8'),
      fsp.readFile(targetFile, 'utf8')
    ]);
    if (templateContent === targetContent) {
      unchanged.push(rel);
    } else {
      modified.push(rel);
    }
  }

  return { added, modified, unchanged };
}

async function createBackup(targetGenie: string): Promise<string> {
  const backupId = toIsoId();
  const backupsRoot = path.join(targetGenie, 'backups');
  const backupDir = path.join(backupsRoot, backupId);
  await ensureDir(backupDir);
  await snapshotDirectory(targetGenie, path.join(backupDir, 'genie'));
  return backupId;
}

async function copyTemplateGenie(templateGenie: string, targetGenie: string): Promise<void> {
  const blacklist = getTemplateRelativeBlacklist();
  await copyDirectory(templateGenie, targetGenie, {
    filter: (relPath) => {
      if (!relPath) return true;
      const head = relPath.split(path.sep)[0];
      if (blacklist.has(head)) {
        return false;
      }
      return true;
    }
  });
}

async function touchVersionFile(cwd: string): Promise<void> {
  const versionPath = resolveWorkspaceVersionPath(cwd);
  const existing = await pathExists(versionPath);
  const version = getPackageVersion();
  const now = new Date().toISOString();
  if (!existing) {
    await writeJsonFile(versionPath, {
      version,
      installedAt: now,
      lastUpdated: now,
      migrationInfo: {}
    });
    return;
  }
  const content = await fsp.readFile(versionPath, 'utf8');
  const data = JSON.parse(content);
  data.version = version;
  data.lastUpdated = now;
  await writeJsonFile(versionPath, data);
}

function buildUpdatePreviewView(diff: DiffSummary) {
  const messages = [
    diff.added.length ? `➕ Files to add: ${diff.added.length}` : '➕ Files to add: none',
    diff.modified.length ? `♻️ Files to update: ${diff.modified.length}` : '♻️ Files to update: none',
    diff.unchanged.length ? `➖ Unchanged files: ${diff.unchanged.length}` : '➖ Unchanged files: none',
    '',
    'Run without --dry-run to apply these changes.'
  ];
  return buildInfoView('Genie update preview', messages);
}

function buildUpdateSummaryView(diff: DiffSummary, backupId: string) {
  const messages = [
    `✅ Update complete. Backup created: ${backupId}`,
    diff.added.length ? `➕ Added ${diff.added.length} file(s).` : '➕ No added files.',
    diff.modified.length ? `♻️ Updated ${diff.modified.length} file(s).` : '♻️ No modified files.',
    '📦 Backups stored under .genie/backups'
  ];
  return buildInfoView('Genie update applied', messages);
}
