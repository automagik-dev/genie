import path from 'path';
import fs from 'fs';
import { promises as fsp } from 'fs';
import YAML from 'yaml';
import type { ParsedCommand, GenieConfig, ConfigPaths } from '../lib/types';
import { emitView } from '../lib/view-helpers';
import { buildErrorView, buildInfoView } from '../views/common';
import { EXECUTORS, DEFAULT_EXECUTOR_KEY, USER_EXECUTOR_ORDER, normalizeExecutorKeyOrDefault } from '../lib/executor-registry';
import { discoverCollectives } from '../lib/collective-discovery.js';
import {
  getPackageRoot,
  getTemplateGeniePath,
  getTemplateRootPath,
  getTemplateRelativeBlacklist,
  resolveTargetGeniePath,
  resolveWorkspaceProviderPath,
  resolveWorkspaceVersionPath,
  resolveProviderStatusPath,
  type TemplateType
} from '../lib/paths';
import {
  pathExists,
  ensureDir,
  copyDirectory,
  toIsoId,
  moveDirectory,
  writeJsonFile,
  snapshotDirectory,
  backupGenieDirectory,
  finalizeBackup
} from '../lib/fs-utils';
import { getPackageVersion } from '../lib/package';
import { detectInstallType } from '../lib/migrate';
import { configureExecutor, type ExecutorId } from '../lib/executor-auth';
import prompts from 'prompts';
// Forge is launched and used via `genie run` (handlers/); no direct Forge API here

interface InitFlags {
  yes?: boolean;
  force?: boolean;
  template?: TemplateType;
  forgeBaseUrl?: string;
  forgePort?: string;
}

interface InitSummary {
  executor: string;
  model?: string;
  backupId?: string;
  templateSource: string;
  target: string;
}

const DEFAULT_MODE_DESCRIPTION = 'Workspace automation via Forge-backed executors.';

export async function runInit(
  parsed: ParsedCommand,
  _config: GenieConfig,
  _paths: Required<ConfigPaths>
): Promise<void> {
  try {
    const flags = parseFlags(parsed.commandArgs);
    const cwd = process.cwd();
    const packageRoot = getPackageRoot();

    // Check if running in interactive mode (TTY) or automation mode (--yes flag or explicit template)
    const isInteractive = process.stdout.isTTY && !flags.yes && !flags.template;
    let template: string;
    let executor: string;
    let model: string | undefined;
    let shouldInitGit = false;
    let shouldInstallHooks = false;

    let templates: string[] = []; // Array for multi-select

    if (isInteractive) {
      // Use dynamic import to load ESM Ink components
      const { runInitWizard } = await import('../views/init-wizard.js');

      // Discover collectives dynamically from .genie/ directory
      const genieRoot = path.join(packageRoot, '.genie');
      const discovered = await discoverCollectives(genieRoot);
      const templateChoices = discovered.map(c => ({
        value: c.id,
        label: c.label || c.name,
        description: c.description
      }));

      // Fallback if discovery fails - provide both code and create
      if (templateChoices.length === 0) {
        templateChoices.push(
          {
            value: 'code',
            label: '💻 Code',
            description: 'Software dev agents (Git, PR, tests, CI/CD workflows)'
          },
          {
            value: 'create',
            label: '✍️  Create',
            description: 'Content creation agents (writing, research, planning)'
          }
        );
      }

      const primaryExecutors = USER_EXECUTOR_ORDER.filter(key => key in EXECUTORS);
      const additionalExecutors = Object.keys(EXECUTORS).filter(
        key => key !== 'AMP' && !primaryExecutors.includes(key)
      );
      const orderedExecutors = [...primaryExecutors, ...additionalExecutors];

      const executors = orderedExecutors.map(key => ({
        label: EXECUTORS[key].label,
        value: key
      }));

      const hasGit = await pathExists(path.join(cwd, '.git'));

      const wizardConfig = await runInitWizard({
        templates: templateChoices,
        executors,
        hasGit
      });

      templates = wizardConfig.templates; // Array from multi-select
      template = templates[0]; // Keep first for backward compat
      executor = wizardConfig.executor;
      model = wizardConfig.model;
      shouldInitGit = wizardConfig.initGit;
      shouldInstallHooks = wizardConfig.installHooks;

      // Configure executor authentication (one-by-one, after wizard)
      if (wizardConfig.configureAuth) {
        await configureExecutorAuthentication(executor);
      }
    } else {
      // Automation mode: use flags or defaults
      template = (flags.template || 'code') as TemplateType;
      templates = [template];
      executor = DEFAULT_EXECUTOR_KEY;
      model = undefined;
    }

    const templateGenie = getTemplateGeniePath(template as TemplateType);
    const targetGenie = resolveTargetGeniePath(cwd);

    const templateExists = await pathExists(templateGenie);
    if (!templateExists) {
      await emitView(buildErrorView('Template missing', `Could not locate packaged .genie templates at ${templateGenie}`), parsed.options, { stream: process.stderr });
      process.exitCode = 1;
      return;
    }

    // CRITICAL: Check version BEFORE copying any files (fixes #304)
    // This must happen before template operations to correctly detect fresh vs upgrade installations
    const versionPath = resolveWorkspaceVersionPath(cwd);
    const currentPackageVersion = getPackageVersion();
    let isUpgrade = false;
    let oldVersion: string | undefined;
    let isPartialInstall = false;

    if (await pathExists(versionPath)) {
      try {
        const versionData = JSON.parse(await fsp.readFile(versionPath, 'utf8'));
        oldVersion = versionData.version;

        if (oldVersion === currentPackageVersion) {
          // True partial installation (same version, incomplete setup)
          isPartialInstall = true;
          console.log('');
          console.log('🔍 Detected partial installation');
          console.log('📦 Templates already copied, resuming setup...');
          console.log('');

          // Skip file operations; go straight to executor setup
          const resumeExecutor = DEFAULT_EXECUTOR_KEY;
          const resumeModel = undefined;
          await applyExecutorDefaults(targetGenie, resumeExecutor, resumeModel);
          // Note: MCP configuration handled by Forge, not init
          await emitView(buildInitSummaryView({ executor: resumeExecutor, model: resumeModel, templateSource: templateGenie, target: targetGenie }), parsed.options);

          // Note: Install agent is launched by start.sh after init completes
          return;
        } else {
          // Version mismatch = upgrade scenario
          isUpgrade = true;
          console.log('');
          console.log(`🔄 Upgrading from ${oldVersion} to ${currentPackageVersion}...`);
          console.log('');
        }
      } catch {
        // Corrupted version.json, treat as fresh install
        isUpgrade = false;
        oldVersion = undefined;
      }
    } else {
      // No version.json = fresh installation
      console.log('');
      console.log('🧞 Welcome to Genie! Setting up your workspace...');
      console.log('');
    }

    // Auto-detect old Genie structure and suggest migration
    const installType = detectInstallType();
    if (installType === 'old_genie' && !flags.yes) {
      console.log('');
      console.log('╭───────────────────────────────────────────────────────────╮');
      console.log('│ ⚠️  Old Genie Installation Detected                       │');
      console.log('╰───────────────────────────────────────────────────────────╯');
      console.log('');
      console.log('Your project has an old Genie structure (v2.0.x) with core');
      console.log('agents stored locally. The new architecture (v2.1.0+) loads');
      console.log('core agents from the npm package for easier updates.');
      console.log('');
      console.log('Run `genie init --yes` to force reinitialize (creates backup).');
      console.log('');

      // FIX for issue #237: Write version file even when returning early
      // This prevents infinite loop where version stays old, triggering init again
      await writeVersionState(cwd, undefined, false);

      await emitView(
        buildInfoView(
          'Old Installation Detected',
          [
            'Use `genie init --yes` to force reinitialize (creates backup first).'
          ]
        ),
        parsed.options
      );
      return;
    }

    // Initialize git if needed (wizard already prompted in interactive mode)
    if (shouldInitGit || (!isInteractive && !await pathExists(path.join(cwd, '.git')))) {
      if (!isInteractive && flags.yes) {
        const { execSync } = await import('child_process');
        // Set default branch to main to suppress git init hints
        execSync('git config --global init.defaultBranch main 2>/dev/null || true', { cwd, stdio: 'pipe' });
        execSync('git init', { cwd, stdio: 'pipe' });
      } else if (shouldInitGit) {
        const { execSync } = await import('child_process');
        // Set default branch to main to suppress git init hints
        execSync('git config --global init.defaultBranch main 2>/dev/null || true', { cwd, stdio: 'pipe' });
        execSync('git init', { cwd, stdio: 'pipe' });
      }
    }

    // CRITICAL: Always backup if .genie/ exists - no exceptions
    // Prevents data loss on re-init, aborted installs, or any overwrite scenario
    let backupId: string | undefined;
    let tempBackupPath: string | undefined;

    const genieExists = await pathExists(targetGenie);
    // Check if .genie/ has actual content (not just empty state/ directory from version check)
    const hasActualContent = genieExists ? await genieHasContent(targetGenie) : false;

    if (genieExists && hasActualContent) {
      console.log('');
      console.log('💾 Creating backup before overwriting...');
      const reason = installType === 'old_genie' ? 'old_genie' : 'pre_upgrade';
      const backupResult = await backupGenieDirectory(cwd, reason);

      // Handle two return types: string (copy backup) or object (two-stage move)
      if (typeof backupResult === 'string') {
        backupId = backupResult;
        console.log(`   Backup created: .genie/backups/${backupId}`);
      } else {
        backupId = backupResult.backupId;
        tempBackupPath = backupResult.tempPath;
        console.log(`   Old .genie moved to: ${tempBackupPath}`);
      }
      console.log('');

      // Create git checkpoint commit (clean rollback point before template modifications)
      if (backupId && oldVersion) {
        await createUpgradeCheckpoint(cwd, oldVersion, currentPackageVersion, backupId);
        console.log('');
      }
    }

    // Copy ALL selected templates (not just the first one)
    for (const tmpl of templates) {
      await copyTemplateFiles(packageRoot, tmpl as TemplateType, targetGenie);
    }

    await copyTemplateRootFiles(packageRoot, cwd, template as TemplateType);
    await migrateAgentsDocs(cwd);

    // Finalize two-stage backup if needed (move temp backup into .genie/backups/)
    if (tempBackupPath && backupId) {
      console.log('💾 Finalizing backup...');
      await finalizeBackup(cwd, tempBackupPath, backupId);
      console.log(`   Backup finalized: .genie/backups/${backupId}/genie/`);
      console.log('');
    }

    // Copy INSTALL.md workflow guide (like UPDATE.md for update command)
    const templateInstallMd = path.join(templateGenie, 'INSTALL.md');
    const targetInstallMd = path.join(targetGenie, 'INSTALL.md');
    if (await pathExists(templateInstallMd)) {
      await fsp.copyFile(templateInstallMd, targetInstallMd);
    }

    // Create blank directories for user work (not blacklisted, created fresh)
    await ensureDir(path.join(targetGenie, 'backups'));
    await ensureDir(path.join(targetGenie, 'wishes'));
    await ensureDir(path.join(targetGenie, 'reports'));

    // Wizard or automation mode should have set executor by now
    // If still missing (shouldn't happen), use default
    if (!executor) {
      executor = DEFAULT_EXECUTOR_KEY;
      console.log(`⚠️  Warning: executor not set, using default: ${executor}`);
    }

    await writeVersionState(cwd, backupId, false);
    await initializeProviderStatus(cwd);
    await applyExecutorDefaults(targetGenie, executor, model);

    // Note: MCP configuration handled by Forge, not init

    // Install git hooks if user opted in during wizard
    await installGitHooksIfRequested(packageRoot, shouldInstallHooks);

    // Auto-commit template files if git repo exists
    await commitTemplateFiles(cwd);

    // Launch install orchestration via Forge (if available)
    let dashboardUrl: string | undefined;
    let installOrchestrationStarted = false;

    try {
      const { runInstallFlow } = await import('../lib/install-helpers.js');
      dashboardUrl = await runInstallFlow({
        templates,
        executor,
        model
      });
      installOrchestrationStarted = true;
    } catch (error) {
      // Forge unavailable or install flow failed - non-fatal
      console.warn('⚠️  Install orchestration skipped (Forge unavailable)');
      console.log(`   Run: genie run master "Run explorer to acquire context, when it ends run the install workflow. Templates: ${templates.join(', ')}"`);
      console.log('');
    }

    // Show completion summary
    const summary: InitSummary = { executor, model, backupId, templateSource: templateGenie, target: targetGenie };
    await emitView(buildInitSummaryView(summary, installOrchestrationStarted), parsed.options);

    if (installOrchestrationStarted && dashboardUrl) {
      console.log('');
      console.log('🧞 Master Genie is orchestrating installation...');
      console.log(`📊 Monitor progress: ${dashboardUrl}`);
      console.log('');
    }
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

    // Handle flags
    if (token === '--yes' || token === '-y') {
      flags.yes = true;
      continue;
    }
    if (token === '--force' || token === '-f') {
      flags.force = true;
      continue;
    }
    if (token === '--forge-base-url' && args[i + 1]) {
      flags.forgeBaseUrl = args[i + 1];
      i++;
      continue;
    }
    if (token.startsWith('--forge-base-url=')) {
      flags.forgeBaseUrl = token.split('=')[1];
      continue;
    }
    if (token === '--forge-port' && args[i + 1]) {
      flags.forgePort = args[i + 1];
      i++;
      continue;
    }
    if (token.startsWith('--forge-port=')) {
      flags.forgePort = token.split('=')[1];
      continue;
    }

    // Handle positional template argument (code | create)
    if (!token.startsWith('-') && !flags.template) {
      if (token === 'code' || token === 'create') {
        flags.template = token as TemplateType;
      }
    }
  }
  return flags;
}

async function copyTemplateFiles(
  packageRoot: string,
  template: TemplateType,
  targetGenie: string
): Promise<void> {
  const blacklist = getTemplateRelativeBlacklist();
  await ensureDir(targetGenie);

  // 1. Copy root agents/skills/spells/neurons/product from package .genie/
  const rootGenieDir = path.join(packageRoot, '.genie');
  await copyDirectory(rootGenieDir, targetGenie, {
    filter: (relPath) => {
      if (!relPath) return true;
      const firstSeg = relPath.split(path.sep)[0];

      // Blacklist takes priority (never copy these user directories)
      if (blacklist.has(firstSeg)) return false;

      // Only copy: agents, skills, spells, neurons, product, AGENTS.md, config.yaml, templates
      if (['agents', 'skills', 'spells', 'neurons', 'product'].includes(firstSeg)) return true;
      if (relPath === 'AGENTS.md' || relPath === 'config.yaml') return true;
      if (relPath.endsWith('.template.md')) return true; // Copy all template files
      return false;
    }
  });

  // 2. Copy only scripts/helpers directory (generic user-facing utilities)
  const helpersSource = path.join(packageRoot, '.genie', 'scripts', 'helpers');
  const helpersTarget = path.join(targetGenie, 'scripts', 'helpers');
  if (await pathExists(helpersSource)) {
    await copyDirectory(helpersSource, helpersTarget);
  }

  // 3. Copy chosen collective DIRECTORY (preserving structure)
  const collectiveSource = path.join(packageRoot, '.genie', template);
  const collectiveTarget = path.join(targetGenie, template);
  await copyDirectory(collectiveSource, collectiveTarget, {
    filter: (relPath) => {
      if (!relPath) return true;
      const firstSeg = relPath.split(path.sep)[0];
      return !blacklist.has(firstSeg);
    }
  });
}

async function copyTemplateRootFiles(packageRoot: string, targetDir: string, template: TemplateType): Promise<void> {
  // Copy AGENTS.md and CLAUDE.md (overwrite)
  const simpleFiles = ['AGENTS.md', 'CLAUDE.md'];
  for (const file of simpleFiles) {
    const sourcePath = path.join(packageRoot, file);
    const targetPath = path.join(targetDir, file);
    if (await pathExists(sourcePath)) {
      await fsp.copyFile(sourcePath, targetPath);
    }
  }

  // Special handling for .gitignore (merge, don't overwrite)
  const sourceGitignore = path.join(packageRoot, '.gitignore');
  const targetGitignore = path.join(targetDir, '.gitignore');

  if (await pathExists(sourceGitignore)) {
    await mergeGitignore(sourceGitignore, targetGitignore);
  }
}

async function mergeGitignore(sourcePath: string, targetPath: string): Promise<void> {
  const sourceContent = await fsp.readFile(sourcePath, 'utf8');
  const sourceLines = new Set(
    sourceContent.split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
  );

  // If target .gitignore exists, merge
  if (await pathExists(targetPath)) {
    const targetContent = await fsp.readFile(targetPath, 'utf8');
    const targetLines = targetContent.split('\n');

    // Backup original
    const backupPath = `${targetPath}.backup.${Date.now()}`;
    await fsp.copyFile(targetPath, backupPath);
    console.log(`   Backed up existing .gitignore: ${path.basename(backupPath)}`);

    // Merge: keep existing lines, add new ones from template
    const existingSet = new Set(
      targetLines.map(line => line.trim()).filter(line => line && !line.startsWith('#'))
    );

    const newLines: string[] = [];
    for (const line of sourceLines) {
      if (!existingSet.has(line)) {
        newLines.push(line);
      }
    }

    if (newLines.length > 0) {
      const mergedContent = targetContent.trimEnd() + '\n\n# Added by Genie init\n' + newLines.join('\n') + '\n';
      await fsp.writeFile(targetPath, mergedContent, 'utf8');
      console.log(`   Merged ${newLines.length} new entries into .gitignore`);
    } else {
      console.log('   .gitignore already contains all Genie entries');
    }
  } else {
    // No existing .gitignore, copy template as-is
    await fsp.copyFile(sourcePath, targetPath);
    console.log('   Created .gitignore from template');
  }
}

async function migrateAgentsDocs(cwd: string): Promise<void> {
  try {
    // Remove mistaken .genie/agents.genie if present
    const mistaken = path.join(cwd, '.genie', 'agents.genie');
    try { await fsp.rm(mistaken, { force: true }); } catch {}

    // Ensure domain AGENTS.md include the root AGENTS.md directly
    const domains = [
      path.join(cwd, '.genie', 'code', 'AGENTS.md'),
      path.join(cwd, '.genie', 'create', 'AGENTS.md')
    ];
    for (const domainFile of domains) {
      try {
        const raw = await fsp.readFile(domainFile, 'utf8');
        if (!/@AGENTS\.md/i.test(raw)) {
          const next = raw.trimEnd() + `\n\n@AGENTS.md\n`;
          await fsp.writeFile(domainFile, next, 'utf8');
        }
      } catch (_) {}
    }
  } catch (err) {
    console.log(`⚠️  Agents docs migration skipped: ${(err as Error)?.message || String(err)}`);
  }
}

/**
 * Check if .genie/ has actual content worth backing up
 * Returns false if it only contains empty state/ directory (from version check)
 */
async function genieHasContent(geniePath: string): Promise<boolean> {
  try {
    const entries = await fsp.readdir(geniePath);

    // Filter out state/ directory and check if anything else exists
    const nonStateEntries = entries.filter(entry => entry !== 'state');

    if (nonStateEntries.length > 0) {
      // Has other directories/files besides state/
      return true;
    }

    // Only state/ exists - check if it has any actual content
    const statePath = path.join(geniePath, 'state');
    if (await pathExists(statePath)) {
      const stateEntries = await fsp.readdir(statePath);
      // Fresh install might have version.json and provider.json from version check
      // Consider this "empty" since it's just metadata, not user content
      return false;
    }

    // Empty .genie/ directory
    return false;
  } catch {
    // If we can't read it, assume it has content to be safe
    return true;
  }
}

// Legacy selectExecutorAndModel function removed - wizard handles all prompts now

// Legacy template choice function removed - wizard handles all prompts now

async function writeVersionState(cwd: string, backupId: string | undefined, _legacyBackedUp: boolean): Promise<void> {
  const versionPath = resolveWorkspaceVersionPath(cwd);
  const version = getPackageVersion();
  const now = new Date().toISOString();
  const gitCommit = await getGitCommit().catch(() => 'unknown');

  // Read existing version data for migration
  const existing = await fsp.readFile(versionPath, 'utf8').catch(() => null);
  let installedAt = now;
  let previousVersion: string | null = null;
  let upgradeHistory: Array<{ from: string; to: string; date: string; success: boolean }> = [];
  let customizedFiles: string[] = [];
  let deletedFiles: string[] = [];

  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      installedAt = parsed.installedAt ?? now;
      previousVersion = parsed.version !== version ? parsed.version : (parsed.previousVersion ?? null);

      // Migrate from old format
      if (parsed.upgradeHistory) {
        upgradeHistory = parsed.upgradeHistory;
      }
      if (parsed.customizedFiles) {
        customizedFiles = parsed.customizedFiles;
      }
      if (parsed.deletedFiles) {
        deletedFiles = parsed.deletedFiles;
      }

      // Add to upgrade history if version changed
      if (parsed.version && parsed.version !== version) {
        upgradeHistory.push({
          from: parsed.version,
          to: version,
          date: now,
          success: true
        });
      }
    } catch {
      installedAt = now;
    }
  }

  // Write unified version.json (single source of truth)
  await writeJsonFile(versionPath, {
    version,
    installedAt,
    updatedAt: now,
    commit: gitCommit,
    packageName: 'automagik-genie',
    customizedFiles,
    deletedFiles,
    lastUpgrade: previousVersion ? now : null,
    previousVersion,
    upgradeHistory,
    // Keep migrationInfo for backward compatibility (will be removed in future)
    migrationInfo: {
      backupId: backupId ?? 'n/a',
      claudeBackedUp: false
    }
  });
}

async function getGitCommit(): Promise<string> {
  const { execSync } = await import('child_process');
  try {
    return execSync('git rev-parse --short HEAD', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Create git checkpoint commit after backup but before template modifications
 *
 * Purpose: Provides clean rollback point if upgrade fails
 *
 * @param cwd - Workspace directory
 * @param oldVersion - Version before upgrade
 * @param newVersion - Version after upgrade
 * @param backupId - Backup timestamp ID
 */
async function createUpgradeCheckpoint(
  cwd: string,
  oldVersion: string,
  newVersion: string,
  backupId: string
): Promise<void> {
  const { execSync } = await import('child_process');

  try {
    // Verify git repo exists
    execSync('git rev-parse --git-dir', { cwd, stdio: 'pipe' });

    // Check for uncommitted changes in .genie/
    const status = execSync('git status --porcelain .genie/', {
      cwd,
      encoding: 'utf8'
    });

    if (status.trim()) {
      // Stage .genie/ changes
      execSync('git add .genie/', { cwd, stdio: 'pipe' });

      // Create checkpoint commit
      // chore(upgrade): prefix = exempt from traceability requirements (commit-advisory.cjs:345)
      // GENIE_DISABLE_COAUTHOR=1 = no co-author attribution (system operation, not Genie authoring)
      const message = `chore(upgrade): checkpoint before upgrading from ${oldVersion} to ${newVersion}\n\nBackup ID: ${backupId}`;
      execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
        cwd,
        stdio: 'pipe',
        env: {
          ...process.env,
          GENIE_DISABLE_COAUTHOR: '1'  // System operation, not Genie authoring
        }
      });

      console.log('✓ Checkpoint commit created');
    } else {
      console.log('✓ No changes to checkpoint (clean state)');
    }
  } catch (err) {
    // Non-fatal: not a git repo or git command failed
    console.log('⚠️  Skipped checkpoint commit (git not available)');
  }
}

async function initializeProviderStatus(cwd: string): Promise<void> {
  const statusPath = resolveProviderStatusPath(cwd);
  const existing = await pathExists(statusPath);
  if (!existing) {
    await writeJsonFile(statusPath, { entries: [] });
  }
}

/**
 * Auto-commit template files after init completes
 *
 * Creates checkpoint commit with all Genie template files
 * Non-fatal: skips if not a git repo or commit fails
 */
async function commitTemplateFiles(cwd: string): Promise<void> {
  // Only commit if git repo exists
  if (!await pathExists(path.join(cwd, '.git'))) {
    return;
  }

  const { execSync } = await import('child_process');

  try {
    // Check if there are files to commit
    const status = execSync('git status --porcelain .genie/ AGENTS.md CLAUDE.md .gitignore', {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    if (!status.trim()) {
      // No changes to commit
      return;
    }

    // Stage Genie template files
    execSync('git add .genie/ AGENTS.md CLAUDE.md .gitignore', {
      cwd,
      stdio: 'pipe'
    });

    // Create init commit
    // chore(init): prefix = exempt from traceability requirements
    // GENIE_DISABLE_COAUTHOR=1 = no co-author attribution (system operation)
    const message = 'chore(init): initialize Genie framework';
    execSync(`git commit -m "${message}"`, {
      cwd,
      stdio: 'pipe',
      env: {
        ...process.env,
        GENIE_DISABLE_COAUTHOR: '1'  // System operation, not Genie authoring
      }
    });

    console.log('✓ Template files committed to git');
    console.log('');
  } catch (err) {
    // Non-fatal: commit failed (maybe pre-commit hooks, dirty state, etc.)
    // Don't block init process
  }
}

function buildInitSummaryView(summary: InitSummary, includeInstallMessage: boolean = true) {
  const messages = [
    `✅ Installed Genie template at ${summary.target}`,
    `🔌 Default executor: ${summary.executor}${summary.model ? ` (model: ${summary.model})` : ''}`
  ];

  // Only show backup ID if there was actually a backup
  if (summary.backupId) {
    messages.push(`💾 Backup ID: ${summary.backupId}`);
  }

  // Only show template source in verbose mode
  if (process.env.GENIE_VERBOSE) {
    messages.push(`📚 Template source: ${summary.templateSource}`);
  }

  if (includeInstallMessage) {
    messages.push(`🛠️ Started Install agent via Genie run`);
  }

  return buildInfoView('Genie initialization complete', messages.filter(Boolean) as string[]);
}

async function detectTemplateFromGenie(genieRoot: string): Promise<string> {
  // Detect template from .genie structure (code or create collective)
  const codeExists = await pathExists(path.join(genieRoot, 'code'));
  const createExists = await pathExists(path.join(genieRoot, 'create'));

  if (codeExists) return 'code';
  if (createExists) return 'create';
  return 'code'; // fallback
}
async function applyExecutorDefaults(genieRoot: string, executorKey: string, model?: string): Promise<void> {
  await Promise.all([
    updateProjectConfig(genieRoot, executorKey, model),
    updateAgentsForExecutor(genieRoot, executorKey, model)
  ]);
}

async function updateProjectConfig(
  genieRoot: string,
  executorKey: string,
  model?: string
): Promise<void> {
  // Prefer project-level .genie/config.yaml; fallback to legacy .genie/cli/config.yaml (user workspace)
  const primaryConfigPath = path.join(genieRoot, 'config.yaml');
  const legacyConfigPath = path.join(genieRoot, 'cli', 'config.yaml');
  const configPath = (await fsp
    .access(primaryConfigPath)
    .then(() => true)
    .catch(() => false)) ? primaryConfigPath : legacyConfigPath;
  const exists = await fsp
    .access(configPath)
    .then(() => true)
    .catch(() => false);

  if (!exists) {
    return;
  }

  const original = await fsp.readFile(configPath, 'utf8');
  let updated = original;
  // defaults.executor
  updated = replaceFirst(updated, /(defaults:\s*\n\s*executor:\s*)([^\s#]+)/, `$1${executorKey}`);
  // executionModes.default block
  updated = replaceFirst(
    updated,
    /(executionModes:\s*\n  default:\s*\n(?:(?: {4}.+\n)+?))/, // capture default block
    (match) => {
      let block = match;
      block = replaceFirst(block, /(    description:\s*)(.*)/, `$1${DEFAULT_MODE_DESCRIPTION}`);
      block = replaceFirst(block, /(    executor:\s*)([^\s#]+)/, `$1${executorKey}`);
      if (model) block = replaceFirst(block, /(      model:\s*)([^\s#]+)/, `$1${model}`);
      return block;
    }
  );

  if (updated !== original) {
    await fsp.writeFile(configPath, updated, 'utf8');
  }
}

async function updateAgentsForExecutor(genieRoot: string, executor: string, model?: string): Promise<void> {
  const agentsDir = path.join(genieRoot, 'agents');

  // Skip if agents directory doesn't exist (blacklisted during init)
  const agentsDirExists = await pathExists(agentsDir);
  if (!agentsDirExists) {
    return;
  }

  const files = await collectAgentFiles(agentsDir);

  await Promise.all(
    files.map(async (file) => {
      const original = await fsp.readFile(file, 'utf8');
      if (!original.startsWith('---')) return;

      const end = original.indexOf('\n---', 3);
      if (end === -1) return;

      const frontMatterContent = original.slice(4, end);
      let data: any;

      try {
        data = YAML.parse(frontMatterContent) || {};
      } catch {
        return; // skip files with invalid front matter
      }

      if (!data || typeof data !== 'object') return;
      if (!data.genie || typeof data.genie !== 'object') {
        data.genie = {};
      }

      const genieMeta = data.genie as Record<string, unknown>;
      genieMeta.executor = executor;
      if (model) genieMeta.model = model;

      const nextFrontMatter = YAML.stringify(data, { indent: 2 }).trimEnd();
      const nextContent = `---\n${nextFrontMatter}\n---${original.slice(end + 4)}`;

      if (nextContent !== original) {
        await fsp.writeFile(file, nextContent, 'utf8');
      }
    })
  );
}

async function collectAgentFiles(dir: string): Promise<string[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectAgentFiles(fullPath);
      files.push(...nested);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.md')) continue;
    if (entry.name.toLowerCase() === 'README.md'.toLowerCase()) continue;
    files.push(fullPath);
  }

  return files;
}

/**
 * Install git hooks if user opted in during wizard
 */
async function installGitHooksIfRequested(packageRoot: string, shouldInstall: boolean): Promise<void> {
  if (!shouldInstall) {
    return;
  }

  console.log('');
  console.log('🔧 Installing git hooks...');

  // Copy hook dependencies before installing hooks
  const projectDir = process.cwd();
  const targetGenie = path.join(projectDir, '.genie');

  // Copy hooks directory (git hook templates)
  const hooksSource = path.join(packageRoot, '.genie', 'scripts', 'hooks');
  const hooksTarget = path.join(targetGenie, 'scripts', 'hooks');
  if (await pathExists(hooksSource)) {
    await copyDirectory(hooksSource, hooksTarget);
  }

  // Copy hook dependencies (scripts that hooks call)
  const hookDependencies = [
    'commit-advisory.cjs',
    'forge-task-link.cjs',
    'prevent-worktree-access.sh',
    'run-tests.cjs',
    'update-changelog.cjs',
    'validate-cross-references.cjs',
    'validate-mcp-build.cjs',
    'validate-user-files-not-committed.cjs',
  ];

  for (const script of hookDependencies) {
    const src = path.join(packageRoot, '.genie', 'scripts', script);
    const dst = path.join(targetGenie, 'scripts', script);
    if (await pathExists(src)) {
      await fsp.copyFile(src, dst);
    }
  }

  // Copy token-efficiency directory (used by pre-commit hook)
  const tokenEffSource = path.join(packageRoot, '.genie', 'scripts', 'token-efficiency');
  const tokenEffTarget = path.join(targetGenie, 'scripts', 'token-efficiency');
  if (await pathExists(tokenEffSource)) {
    await copyDirectory(tokenEffSource, tokenEffTarget);
  }

  // Copy install-hooks.cjs (used by hook installer)
  const installHooksSource = path.join(packageRoot, '.genie', 'scripts', 'install-hooks.cjs');
  const installHooksTarget = path.join(targetGenie, 'scripts', 'install-hooks.cjs');
  if (await pathExists(installHooksSource)) {
    await fsp.copyFile(installHooksSource, installHooksTarget);
  }

  const { spawnSync } = await import('child_process');
  const installScript = path.join(targetGenie, 'scripts', 'install-hooks.cjs');

  const result = spawnSync('node', [installScript, projectDir, packageRoot], {
    stdio: 'inherit'
  });

  if (result.status !== 0) {
    console.warn('⚠️  Hook installation failed (non-fatal)');
    console.warn(`   You can install later with: node ${installScript} ${projectDir} ${packageRoot}`);
  }
  console.log('');
}

function replaceFirst(source: string, pattern: RegExp, replacement: string | ((match: string) => string)): string {
  if (typeof replacement === 'function') {
    const match = source.match(pattern);
    if (!match) return source;
    const replaced = replacement(match[0]);
    return source.slice(0, match.index ?? 0) + replaced + source.slice((match.index ?? 0) + match[0].length);
  }
  return source.replace(pattern, replacement);
}


// Legacy handoff removed in favor of Forge task creation

// Legacy prompt functions removed - wizard handles all prompts now

  // Legacy handoff code removed
  /*
  console.log(`[HANDOFF] executor=${executor}, cwd=${cwd}`);

  const { spawn, execSync } = await import('child_process');

  const command = executor === 'claude' ? 'claude' : 'codex';
  console.log(`[HANDOFF] command=${command}`);

  // Build args: unrestricted flag + @ reference to saved prompt
  const args: string[] = [];

  if (executor === 'claude') {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  }

  // Use @ reference to the template's INSTALL.md
  args.push('@.genie/INSTALL.md');

  console.log(`[HANDOFF] Args: ${args.join(' ')}`);

  // Check if we have a real TTY or are in a subprocess (like npx)
  const hasRealTTY = process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY;

  // Improved npx detection - check multiple indicators
  // When running via npx, the process appears to have TTY but can't actually use setRawMode
  const isNpxSubprocess = !!(
    (process.env.npm_execpath && process.env.npm_execpath.includes('npx')) ||
    process.env.npm_command === 'exec' ||
    process.env._ && process.env._.includes('npx') ||
    // Check if we're in a temporary npx install directory
    __dirname.includes('/_npx/') ||
    __dirname.includes('\\_npx\\') ||
    // Check process.argv[1] for npx paths
    (process.argv[1] && process.argv[1].includes('/_npx/')) ||
    (process.argv[1] && process.argv[1].includes('\\_npx\\'))
  );

  // Legacy handoff code removed

  // Additional fallback: if TTY appears available but we see "_npx" anywhere in the path, force script
  const pathsHaveNpx = __dirname.includes('_npx') ||
                       (process.argv[1] && process.argv[1].includes('_npx')) ||
                       (process.env._ && process.env._.includes('_npx'));

  // Legacy handoff code removed

  // Legacy handoff code removed

  const fallbackMessage = rawModeCheck.supported
    ? '[HANDOFF] Using script fallback to ensure TTY compatibility...'
    : rawModeCheck.message === 'stdin is not a TTY'
      ? '[HANDOFF] No TTY detected, using script fallback...'
      : '[HANDOFF] Using script fallback due to raw mode limitations...';

  // Legacy handoff code removed
}
*/
// Legacy handoff code removed

/*
async function runWithScriptFallback(
  spawnFn: typeof import('child_process').spawn,
  execSyncFn: typeof import('child_process').execSync,
  command: string,
  args: string[],
  cwd: string
): Promise<number> {
  try {
    execSyncFn('which script', { stdio: 'ignore' });
  } catch {
    console.error('ERROR: script command not found. Install it or run: npm install -g automagik-genie && genie init');
    process.exit(1);
  }

  const escapedArgs = args.map(arg => arg.replace(/'/g, "'\\''"));
  const fullCommand = `${command} ${escapedArgs.map(arg => `'${arg}'`).join(' ')}`;

  console.log(`[HANDOFF] Running: script -q -c "${fullCommand}" /dev/null`);

  try {
    const exitCode = await spawnWithPromise(spawnFn, 'script', ['-q', '-c', fullCommand, '/dev/null'], cwd, {
      stdio: 'inherit',
      shell: false,
      env: { ...process.env, FORCE_TTY: '1' }
    });
    return exitCode;
  } catch (error: any) {
    console.error(`[HANDOFF] Script error:`, error?.message ?? error);
    throw new Error(`Failed to start script: ${error?.message ?? error}`);
  }
}

async function spawnWithPromise(
  spawnFn: typeof import('child_process').spawn,
  command: string,
  args: string[],
  cwd: string,
  options: import('child_process').SpawnOptions
): Promise<number> {
  return new Promise((resolve, reject) => {
    console.log(`[HANDOFF] Spawning ${command} ${args.join(' ')} (cwd=${cwd})`);
    const child = spawnFn(command, args, { cwd, ...options });
    child.on('spawn', () => {
      console.log(`[HANDOFF] ${command} started with PID ${child.pid}`);
    });
    child.on('exit', (code) => {
      console.log(`[HANDOFF] ${command} exited with code: ${code}`);
      resolve(code ?? 0);
    });
    child.on('error', (error) => {
      reject(error);
    });
  });
}

async function runWithScriptOrExit(
  spawnFn: typeof import('child_process').spawn,
  execSyncFn: typeof import('child_process').execSync,
  command: string,
  args: string[],
  cwd: string
): Promise<void> {
  try {
    const exitCode = await runWithScriptFallback(spawnFn, execSyncFn, command, args, cwd);
    if (exitCode !== 0) {
      throw new Error(`script exited with code ${exitCode}`);
    }
  } catch (error: any) {
    console.error('Claude failed to start:', error?.message ?? error);
    console.log('');
    console.log('Please run manually:');
    console.log(`  ${command} ${args.join(' ')}`);
    process.exit(1);
  }
}
*/

/**
 * Configure executor authentication with status-aware dropdown
 */
async function configureExecutorAuthentication(primaryExecutor: string): Promise<void> {
  console.log('\n🔐 Executor Authentication Setup\n');

  const { checkExecutorAuth } = await import('../lib/executor-auth.js');
  const authExecutors: ExecutorId[] = ['OPENCODE', 'CLAUDE_CODE', 'CODEX', 'GEMINI', 'CURSOR', 'COPILOT', 'QWEN_CODE'];
  const executorLabels: Record<string, string> = {
    OPENCODE: 'OpenCode',
    CLAUDE_CODE: 'Claude Code',
    CODEX: 'Codex',
    GEMINI: 'Gemini CLI',
    CURSOR: 'Cursor',
    COPILOT: 'GitHub Copilot',
    QWEN_CODE: 'Qwen Code'
  };

  // Check if primary executor needs auth
  if (!authExecutors.includes(primaryExecutor as ExecutorId)) {
    console.log(`✓ ${primaryExecutor} doesn't require authentication setup\n`);
    return;
  }

  // Configure primary executor if not already authenticated
  const isPrimaryAuth = await checkExecutorAuth(primaryExecutor as ExecutorId);
  if (!isPrimaryAuth) {
    try {
      await configureExecutor(primaryExecutor as ExecutorId);
      console.log(`✓ ${executorLabels[primaryExecutor]} configured\n`);
    } catch (error) {
      console.warn(`⚠️  Failed to configure ${primaryExecutor}: ${(error as Error).message}`);
      console.log('You can configure it later when you run: genie run <agent>\n');
    }
  } else {
    console.log(`✓ ${executorLabels[primaryExecutor]} already configured\n`);
  }

  // Offer to configure additional providers with status dropdown
  while (true) {
    // Get current auth status for all executors
    const authStatuses = await Promise.all(
      authExecutors.map(async (exec) => ({
        executor: exec,
        authenticated: await checkExecutorAuth(exec)
      }))
    );

    // Build choices with status indicators
    const choices = [
      { title: '✗ No, I\'m done', value: null }
    ].concat(
      authExecutors.map(exec => {
        const status = authStatuses.find(s => s.executor === exec);
        const icon = status?.authenticated ? '✓' : '✗';
        const label = executorLabels[exec];
        const suffix = status?.authenticated ? ' (already configured)' : '';

        return {
          title: `${icon} ${label}${suffix}`,
          value: exec,
          disabled: status?.authenticated // Can't select already-configured
        };
      })
    );

    const response = await prompts({
      type: 'select',
      name: 'selectedExecutor',
      message: 'Would you like to configure another provider?',
      choices,
      initial: 0
    }, {
      onCancel: () => ({ selectedExecutor: null })
    });

    if (!response.selectedExecutor) {
      console.log('Done configuring providers\n');
      break;
    }

    try {
      await configureExecutor(response.selectedExecutor);
      console.log(`✓ ${executorLabels[response.selectedExecutor]} configured\n`);
    } catch (error) {
      console.warn(`⚠️  Failed to configure ${response.selectedExecutor}: ${(error as Error).message}\n`);
    }
  }
}
