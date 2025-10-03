import path from 'path';
import fs from 'fs';
import { promises as fsp } from 'fs';
import readline from 'readline';
import type { ParsedCommand, GenieConfig, ConfigPaths } from '../lib/types';
import { emitView } from '../lib/view-helpers';
import { buildErrorView, buildInfoView } from '../views/common';
import {
  getPackageRoot,
  getTemplateGeniePath,
  getTemplateRelativeBlacklist,
  resolveTargetGeniePath,
  resolveWorkspaceProviderPath,
  resolveWorkspaceVersionPath,
  resolveBackupsRoot,
  resolveTempBackupsRoot,
  resolveProviderStatusPath
} from '../lib/paths';
import {
  pathExists,
  ensureDir,
  copyDirectory,
  toIsoId,
  moveDirectory,
  writeJsonFile,
  snapshotDirectory
} from '../lib/fs-utils';
import { getPackageVersion } from '../lib/package';

interface InitFlags {
  provider?: string;
  yes?: boolean;
  force?: boolean;
}

interface InitSummary {
  provider: string;
  backupId?: string;
  claudeBackedUp: boolean;
  templateSource: string;
  target: string;
}

export async function runInit(
  parsed: ParsedCommand,
  _config: GenieConfig,
  _paths: Required<ConfigPaths>
): Promise<void> {
  try {
    const flags = parseFlags(parsed.commandArgs);
    const cwd = process.cwd();
    const packageRoot = getPackageRoot();
    const templateGenie = getTemplateGeniePath();
    const targetGenie = resolveTargetGeniePath(cwd);

    const templateExists = await pathExists(templateGenie);
    if (!templateExists) {
      await emitView(buildErrorView('Template missing', `Could not locate packaged .genie templates at ${templateGenie}`), parsed.options, { stream: process.stderr });
      process.exitCode = 1;
      return;
    }

    const backupId = toIsoId();
    const targetExists = await pathExists(targetGenie);
    const backupsRoot = resolveBackupsRoot(cwd);
    let backupDir: string;
    let stagedBackupDir: string | null = null;

  if (targetExists) {
    backupDir = path.join(backupsRoot, backupId);
    await ensureDir(backupDir);
    await snapshotDirectory(targetGenie, path.join(backupDir, 'genie'));
  } else {
    stagedBackupDir = path.join(resolveTempBackupsRoot(cwd), backupId);
    await ensureDir(stagedBackupDir);
    backupDir = stagedBackupDir;
  }

    const claudeDir = path.resolve(cwd, '.claude');
    const claudeExists = await pathExists(claudeDir);
    if (claudeExists) {
      await copyDirectory(claudeDir, path.join(backupDir, 'claude'));
    }

    if (!targetExists) {
      await ensureDir(path.dirname(backupsRoot));
    }

    await copyTemplateGenie(templateGenie, targetGenie);

    if (stagedBackupDir) {
      const finalBackupsDir = path.join(backupsRoot, backupId);
      await ensureDir(backupsRoot);
      await ensureDir(path.join(targetGenie, 'backups'));
      if (!(await pathExists(finalBackupsDir))) {
        await moveDirectory(stagedBackupDir, finalBackupsDir);
      } else {
        await fsp.rm(stagedBackupDir, { recursive: true, force: true });
      }
      const tempRoot = resolveTempBackupsRoot(cwd);
      try {
        await fsp.rm(tempRoot, { recursive: true, force: true });
      } catch (error: any) {
        if (error && error.code !== 'ENOENT') {
          // ignore
        }
      }
    }

    await ensureDir(backupsRoot);

    const provider = await resolveProviderChoice(flags);
    await writeProviderState(cwd, provider);
    await writeVersionState(cwd, backupId, claudeExists);
    await initializeProviderStatus(cwd);

    const summary: InitSummary = {
      provider,
      backupId,
      claudeBackedUp: claudeExists,
      templateSource: templateGenie,
      target: targetGenie
    };

    await emitView(buildInitSummaryView(summary), parsed.options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await emitView(buildErrorView('Init failed', message), parsed.options, { stream: process.stderr });
    process.exitCode = 1;
  }
}

function parseFlags(args: string[]): InitFlags {
  const flags: InitFlags = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--provider' && args[i + 1]) {
      flags.provider = args[i + 1];
      i++;
      continue;
    }
    if (token.startsWith('--provider=')) {
      flags.provider = token.split('=')[1];
      continue;
    }
    if (token === '--yes' || token === '-y') {
      flags.yes = true;
      continue;
    }
    if (token === '--force' || token === '-f') {
      flags.force = true;
      continue;
    }
  }
  return flags;
}

async function copyTemplateGenie(templateGenie: string, targetGenie: string): Promise<void> {
  const blacklist = getTemplateRelativeBlacklist();
  const hasExisting = await pathExists(targetGenie);
  if (!hasExisting) {
    await ensureDir(targetGenie);
  }
  await copyDirectory(templateGenie, targetGenie, {
    filter: (relPath) => {
      if (!relPath) return true;
      const firstSegment = relPath.split(path.sep)[0];
      if (blacklist.has(firstSegment)) {
        return false;
      }
      return true;
    }
  });
}

async function resolveProviderChoice(flags: InitFlags): Promise<string> {
  if (flags.provider) {
    return normalizeProvider(flags.provider);
  }
  if (process.env.GENIE_PROVIDER) {
    return normalizeProvider(process.env.GENIE_PROVIDER);
  }
  if (!process.stdout.isTTY || flags.yes) {
    return 'codex';
  }
  return await promptProvider();
}

function normalizeProvider(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized.startsWith('claude')) {
    return 'claude';
  }
  return 'codex';
}

async function promptProvider(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const question = (): Promise<string> => {
    return new Promise((resolve) => {
      rl.question('Select provider ([c]odex / [a]nthropic): ', resolve);
    });
  };

  try {
    const answer = (await question()).trim().toLowerCase();
    if (answer.startsWith('a')) {
      return 'claude';
    }
    return 'codex';
  } finally {
    rl.close();
  }
}

async function writeProviderState(cwd: string, provider: string): Promise<void> {
  const providerPath = resolveWorkspaceProviderPath(cwd);
  await writeJsonFile(providerPath, {
    provider,
    decidedAt: new Date().toISOString(),
    source: 'init'
  });
}

async function writeVersionState(cwd: string, backupId: string, claudeBackedUp: boolean): Promise<void> {
  const versionPath = resolveWorkspaceVersionPath(cwd);
  const version = getPackageVersion();
  const now = new Date().toISOString();
  const existing = await fsp.readFile(versionPath, 'utf8').catch(() => null);
  let installedAt = now;
  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      installedAt = parsed.installedAt ?? now;
    } catch {
      installedAt = now;
    }
  }

  await writeJsonFile(versionPath, {
    version,
    installedAt,
    lastUpdated: now,
    migrationInfo: {
      backupId,
      claudeBackedUp
    }
  });
}

async function initializeProviderStatus(cwd: string): Promise<void> {
  const statusPath = resolveProviderStatusPath(cwd);
  const existing = await pathExists(statusPath);
  if (!existing) {
    await writeJsonFile(statusPath, { entries: [] });
  }
}

function buildInitSummaryView(summary: InitSummary) {
  const messages = [
    `✅ Installed Genie template at ${summary.target}`,
    `🔌 Default provider: ${summary.provider}`,
    `💾 Backup ID: ${summary.backupId ?? 'n/a'}`,
    summary.claudeBackedUp ? '📦 Legacy .claude directory archived for migration.' : '📦 No legacy .claude directory detected.',
    `📚 Template source: ${summary.templateSource}`
  ];
  return buildInfoView('Genie initialization complete', messages);
}
