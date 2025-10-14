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
import { detectInstallType, runMigration } from '../lib/migrate';
import { runChat } from './run';
import { loadConfig } from '../lib/config';
import { configureBothExecutors } from '../lib/mcp-config';
import { promptExecutorChoice } from '../lib/executor-prompt.js';

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

    // Auto-detect and migrate old Genie structure
    const installType = detectInstallType();
    if (installType === 'old_genie') {
      console.log('');
      console.log('╭───────────────────────────────────────────────────────────╮');
      console.log('│ 🔄 Old Genie Structure Detected                          │');
      console.log('│ Migrating to npm-backed architecture...                  │');
      console.log('╰───────────────────────────────────────────────────────────╯');
      console.log('');

      const migrationResult = await runMigration({ dryRun: flags.dryRun });

      if (migrationResult.status === 'failed') {
        await emitView(
          buildErrorView(
            'Migration Failed',
            `Could not migrate to new architecture:\n${migrationResult.errors.join('\n')}`
          ),
          parsed.options,
          { stream: process.stderr }
        );
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
      await emitView(buildUpdatePreviewView(diff), parsed.options);
      return;
    }

    if (!flags.force && diff.added.length === 0 && diff.modified.length === 0) {
      await emitView(buildInfoView('No updates available', ['Your workspace already matches the packaged templates.']), parsed.options);
      return;
    }

    // Set up executor orchestration for update
    console.log('');
    console.log('🔄 Preparing update orchestration...');
    console.log('');

    // Detect available executors
    const availableExecutors = await detectAvailableExecutors();
    if (availableExecutors.length === 0) {
      await emitView(buildErrorView('No executor found',
        'Could not find codex or claude CLI.\n\n' +
        'Install one of:\n' +
        '  • Codex: npm install -g @namastexlabs/codex\n' +
        '  • Claude Code: https://docs.claude.com/docs/claude-code/install'
      ), parsed.options, { stream: process.stderr });
      process.exitCode = 1;
      return;
    }

    console.log(`📦 Available executors: ${availableExecutors.join(', ')}`);
    console.log('');

    const config = await loadConfig();
    let executor: string;

    // If both available, ask user to choose
    if (availableExecutors.length > 1) {
      const defaultChoice = config?.defaults?.executor && availableExecutors.includes(config.defaults.executor)
        ? config.defaults.executor
        : availableExecutors[0];

      executor = await promptExecutorChoice(availableExecutors, defaultChoice);
      console.log('');
      console.log(`✓ Using ${executor}`);
      console.log('');

      // Persist user's choice
      await saveExecutorChoice(executor, cwd);
    } else {
      // Only one available, use it
      executor = availableExecutors[0];
      console.log(`✓ Using ${executor} (only available executor)`);
      console.log('');
    }

    // Configure MCP for both Codex and Claude Code
    await configureBothExecutors(cwd);

    // Create backup BEFORE copying templates
    console.log('💾 Creating backup...');
    console.log('');
    const backupId = await createBackup(targetGenie);
    const backupPath = path.join('.genie/backups', backupId, 'genie');
    console.log(`✅ Backup created: ${backupPath}`);
    console.log('');

    // Copy UPDATE.md from template BEFORE generating prompt (so executor can reference it)
    const templateUpdateMd = path.join(templateGenie, 'UPDATE.md');
    const targetUpdateMd = path.join(targetGenie, 'UPDATE.md');
    if (await pathExists(templateUpdateMd)) {
      await fsp.copyFile(templateUpdateMd, targetUpdateMd);
      console.log('📄 Copied UPDATE.md workflow guide');
      console.log('');
    }

    // Copy template files BEFORE handing off to executor
    console.log('📦 Copying template files...');
    console.log('');
    await copyTemplateGenie(templateGenie, targetGenie);
    console.log(`✅ Copied ${diff.added.length + diff.modified.length} template files`);
    console.log('');

    // Update version file
    await touchVersionFile(cwd);

    console.log(`📝 Generating migration orchestration prompt...`);
    console.log('');

    const updatePrompt = buildUpdateOrchestrationPrompt(diff, installType, cwd, executor, backupPath);

    // Save prompt to file
    const promptFile = path.join(cwd, '.genie-update-prompt.md');
    await fsp.writeFile(promptFile, updatePrompt, 'utf8');

    console.log(`✅ Migration prompt ready`);
    console.log(`🚀 Handing off to ${executor} for context migration...`);
    console.log('');

    // Hand off to executor (replaces Node process with executor in user's terminal)
    await handoffToExecutor(executor, promptFile, cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await emitView(buildErrorView('Update failed', message), parsed.options, { stream: process.stderr });
    process.exitCode = 1;
  }
}

function buildUpdateOrchestrationPrompt(
  diff: DiffSummary,
  installType: string,
  cwd: string,
  executor: string,
  backupPath: string
): string {
  const version = getPackageVersion();

  return `# Genie Framework Context Migration

**✅ Template files already copied** - Framework updated to v${version}

Your task: Migrate user context from backup to new installation.

@.genie/UPDATE.md

## Migration Context

**Project:** ${cwd}
**Architecture:** ${installType === 'old_genie' ? 'Migrated from v2.0.x' : 'v2.1+ architecture'}
**Current version:** ${version}
**Backup location:** \`${backupPath}\`

## What's Already Done

✅ Template files copied (${diff.added.length} added, ${diff.modified.length} updated)
✅ UPDATE.md workflow guide available
✅ Version file updated
✅ MCP configured

## Your Task

Follow UPDATE.md to migrate user context:

1. **Discovery**: Inventory backup files and categorize
2. **Implementation**: Migrate wishes, custom agents, config, docs, reports
3. **Verification**: Verify 100% file coverage and run validation tests

**Focus on:** Preserving user work (wishes, custom agents, reports, context)
**Skip:** Template file copying (already done)

## Important

When you read @.genie/UPDATE.md, replace all instances of \`{{BACKUP_PATH}}\` with \`${backupPath}\`.

## Completion

After migration:
1. Document what was preserved and any items needing review
2. Provide migration summary
3. Optionally offer to delete .genie/UPDATE.md (see cleanup section in UPDATE.md)

Begin by reading @.genie/UPDATE.md and following its workflow.`;
}

async function detectAvailableExecutors(): Promise<string[]> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);

  const available: string[] = [];

  // Check Codex
  try {
    await execFileAsync('codex', ['--version'], { timeout: 5000 });
    available.push('codex');
  } catch {
    // Try npx fallback
    try {
      await execFileAsync('npx', ['-y', '@namastexlabs/codex@latest', '--version'], { timeout: 5000 });
      available.push('codex');
    } catch {
      // Not available
    }
  }

  // Check Claude
  try {
    await execFileAsync('claude', ['--version'], { timeout: 5000 });
    available.push('claude');
  } catch {
    // Not available
  }

  return available;
}


async function saveExecutorChoice(executor: string, cwd: string): Promise<void> {
  try {
    const YAML = await import('yaml');
    const configPath = path.join(cwd, '.genie/cli/config.yaml');

    // Read existing config
    const configContent = await fsp.readFile(configPath, 'utf8');
    const configData = YAML.parse(configContent) as any;

    // Update default executor
    if (!configData.defaults) {
      configData.defaults = {};
    }

    const oldExecutor = configData.defaults.executor;
    if (oldExecutor !== executor) {
      configData.defaults.executor = executor;

      // Write back
      const newContent = YAML.stringify(configData, { indent: 2, lineWidth: 120 });
      await fsp.writeFile(configPath, newContent, 'utf8');

      console.log(`💾 Saved ${executor} as default executor`);
      console.log('');
    }
  } catch (error) {
    // Non-fatal - just log warning
    console.log(`⚠️  Could not save executor preference: ${error instanceof Error ? error.message : String(error)}`);
    console.log('');
  }
}

async function handoffToExecutor(executor: string, promptFile: string, cwd: string): Promise<void> {
  const { spawn } = await import('child_process');

  const command = executor === 'claude' ? 'claude' : 'codex';

  // Read prompt content from file
  const promptContent = await fsp.readFile(promptFile, 'utf8');

  // Add unrestricted flags for infrastructure operations
  const args: string[] = [];

  if (executor === 'claude') {
    // Claude: bypass all permission checks
    args.push('--dangerously-skip-permissions');
  } else {
    // Codex: bypass approvals and sandbox
    args.push('--dangerously-bypass-approvals-and-sandbox');
  }

  // Add prompt as final argument
  args.push(promptContent);

  // Spawn executor with unrestricted flags, inheriting user's terminal (stdio)
  const child = spawn(command, args, {
    cwd,
    stdio: 'inherit',  // User terminal becomes executor terminal
    shell: false  // No shell - let Node handle argument escaping
  });

  // Wait for executor to complete, then exit with its code
  return new Promise((resolve, reject) => {
    child.on('exit', (code) => {
      process.exit(code || 0);
    });

    child.on('error', (error) => {
      reject(new Error(`Failed to start ${command}: ${error.message}`));
    });
  });
}

async function invokeExecutor(executor: string, prompt: string, cwd: string): Promise<void> {
  const { spawn } = await import('child_process');
  const os = await import('os');
  const { writeFile, unlink } = await import('fs/promises');

  const command = executor === 'claude' ? 'claude' : 'codex';

  // Write prompt to temp file
  const tmpFile = path.join(os.tmpdir(), `genie-update-prompt-${Date.now()}.txt`);
  await writeFile(tmpFile, prompt, 'utf8');

  try {
    // Use script to allocate pseudo-TTY, pass prompt as argument
    const child = spawn('script', ['-q', '-c', `${command} "$(cat ${tmpFile})"`, '/dev/null'], {
      cwd,
      stdio: 'inherit',
      shell: false
    });

    return new Promise((resolve, reject) => {
      child.on('close', async (code) => {
        await unlink(tmpFile).catch(() => {});
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${command} exited with code ${code}`));
        }
      });

      child.on('error', async (error) => {
        await unlink(tmpFile).catch(() => {});
        reject(new Error(`Failed to invoke ${command}: ${error.message}`));
      });
    });
  } catch (error) {
    await unlink(tmpFile).catch(() => {});
    throw error;
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
