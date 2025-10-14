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

    const config = await loadConfig();
    const executor = config?.defaults?.executor || 'codex';

    // Configure MCP for both Codex and Claude Code
    await configureBothExecutors(cwd);

    console.log(`🚀 Invoking ${executor} to orchestrate update...`);
    console.log('');

    const updatePrompt = buildUpdateOrchestrationPrompt(diff, installType, cwd, executor);
    await invokeExecutor(executor, updatePrompt, cwd);
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
  executor: string
): string {
  const version = getPackageVersion();

  return `# Genie Framework Update Orchestration

You are orchestrating a Genie framework update. Use the Genie MCP server to run the update agent in background.

## Update Context

**Project:** ${cwd}
**Current architecture:** ${installType === 'old_genie' ? 'Migrated from v2.0.x' : 'v2.1+ architecture'}
**Target version:** ${version}
**Executor:** ${executor}

**Changes detected:**
- Files to add: ${diff.added.length}
- Files to update: ${diff.modified.length}

## Orchestration Steps

1. **Launch update agent** via Genie MCP:
   \`\`\`
   mcp__genie__run with agent="update" and prompt="<paste full update context below>"
   \`\`\`

2. **Wait for agent** (update typically takes 60-120 seconds):
   - Poll \`mcp__genie__list_sessions\` to check status
   - Or wait 90 seconds then view results

3. **Review results**:
   \`\`\`
   mcp__genie__view with sessionId="<session-id>" and full=false
   \`\`\`

4. **Resume if needed**:
   \`\`\`
   mcp__genie__resume with sessionId="<session-id>" and prompt="<follow-up>"
   \`\`\`

## Update Agent Context

Use this as the prompt when calling \`mcp__genie__run\`:

\`\`\`
# Update Task

## Current State
- Project directory: ${cwd}
- Install type: ${installType}
- Framework version: ${version}

## Changes to Apply
- Add ${diff.added.length} new files
- Update ${diff.modified.length} existing files
${diff.added.length > 0 ? '\n### Files to Add\n' + diff.added.slice(0, 10).map(f => `- ${f}`).join('\n') : ''}
${diff.added.length > 10 ? `... and ${diff.added.length - 10} more` : ''}
${diff.modified.length > 0 ? '\n### Files to Update\n' + diff.modified.slice(0, 10).map(f => `- ${f}`).join('\n') : ''}
${diff.modified.length > 10 ? `... and ${diff.modified.length - 10} more` : ''}

## Your Task
1. Create timestamped backup of current state
2. Extract content from old structure (if applicable) into custom overrides
3. Apply template updates intelligently (add new files, update modified files)
4. Preserve ALL user customizations (custom agents, wishes, reports, context.md)
5. Populate .genie/custom/ folder with project-specific content
6. Update .genie/version.json with framework version and timestamp
7. Create update report with evidence

## Success Criteria
- ✅ Backup created successfully
- ✅ Old structure content extracted (if applicable)
- ✅ Template updates applied
- ✅ User work preserved (custom/, wishes/, reports/, context.md)
- ✅ Custom folder populated with project content
- ✅ Version file updated
- ✅ Update report generated with file paths and verification steps

Execute following @.genie/agents/core/update.md framework.
\`\`\`

## Begin

Start by launching the update agent with the context above.`;
}

async function invokeExecutor(executor: string, prompt: string, cwd: string): Promise<void> {
  const { spawn } = await import('child_process');

  const command = executor === 'claude' ? 'claude' : 'codex';

  // Pipe prompt via stdin to avoid shell escaping issues with markdown
  const child = spawn(command, [], {
    cwd,
    stdio: ['pipe', 'inherit', 'inherit'],
    shell: false
  });

  // Write prompt to stdin
  if (child.stdin) {
    child.stdin.write(prompt);
    child.stdin.end();
  }

  return new Promise((resolve, reject) => {
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });

    child.on('error', (error) => {
      reject(new Error(`Failed to invoke ${command}: ${error.message}`));
    });
  });
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
