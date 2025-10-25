import path from 'path';
import fs from 'fs';
import { promises as fsp } from 'fs';
import YAML from 'yaml';
import type { ParsedCommand, GenieConfig, ConfigPaths } from '../lib/types';
import { emitView } from '../lib/view-helpers';
import { buildErrorView, buildInfoView } from '../views/common';
import { EXECUTORS } from '../lib/executor-registry';
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
  backupGenieDirectory
} from '../lib/fs-utils';
import { getPackageVersion } from '../lib/package';
import { detectInstallType } from '../lib/migrate';
import { configureBothExecutors } from '../lib/mcp-config';
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

      const executors = Object.keys(EXECUTORS)
        .filter(key => key !== 'amp') // Exclude amp from user selection
        .map(key => ({
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
    } else {
      // Automation mode: use flags or defaults
      template = (flags.template || 'code') as TemplateType;
      templates = [template];
      executor = Object.keys(EXECUTORS)[0] || 'codex';
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

    // Check for partial installation (templates copied but executor not started)
    // OR version mismatch (upgrade scenario)
    const versionPath = resolveWorkspaceVersionPath(cwd);
    const currentPackageVersion = getPackageVersion();

    if (await pathExists(versionPath)) {
      const versionData = JSON.parse(await fsp.readFile(versionPath, 'utf8'));
      const installedVersion = versionData.version;

      if (installedVersion === currentPackageVersion) {
        // True partial installation (same version, incomplete setup)
        console.log('');
        console.log('🔍 Detected partial installation');
        console.log('📦 Templates already copied, resuming setup...');
        console.log('');

        // Skip file operations; go straight to executor setup
        // In partial init, use default executor (installation already attempted, use non-interactive default)
        const resumeExecutor = Object.keys(EXECUTORS)[0] || 'codex';
        const resumeModel = undefined;
        await applyExecutorDefaults(targetGenie, resumeExecutor, resumeModel);
        await configureBothExecutors(cwd);
        await emitView(buildInitSummaryView({ executor: resumeExecutor, model: resumeModel, templateSource: templateGenie, target: targetGenie }), parsed.options);

        // Note: Install agent is launched by start.sh after init completes
        return;
      } else {
        // Version mismatch = upgrade scenario, continue with full init + backup
        console.log('');
        console.log(`🔄 Upgrading from ${installedVersion} to ${currentPackageVersion}...`);
        console.log('');
        // Continue with file operations (backup + copy)
      }
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

    // Only backup if old Genie installation detected
    let backupId: string | undefined;
    if (installType === 'old_genie') {
      console.log('');
      console.log('💾 Creating backup of old Genie installation...');
      backupId = await backupGenieDirectory(cwd, 'old_genie');
      console.log(`   Backup created: .genie/backups/${backupId}`);
      console.log('');
    }

    // Copy ALL selected templates (not just the first one)
    for (const tmpl of templates) {
      await copyTemplateFiles(packageRoot, tmpl as TemplateType, targetGenie);
    }

    await copyTemplateRootFiles(packageRoot, cwd, template as TemplateType);
    await migrateAgentsDocs(cwd);

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
      executor = Object.keys(EXECUTORS)[0] || 'codex';
      console.log(`⚠️  Warning: executor not set, using default: ${executor}`);
    }

    await writeVersionState(cwd, backupId, false);
    await initializeProviderStatus(cwd);
    await applyExecutorDefaults(targetGenie, executor, model);

    // Configure MCP servers for both Codex and Claude Code
    await configureBothExecutors(cwd);

    // Install git hooks if user opted in during wizard
    await installGitHooksIfRequested(packageRoot, shouldInstallHooks);

    // Show completion summary (install agent will be launched by start.sh via exec)
    const summary: InitSummary = { executor, model, backupId, templateSource: templateGenie, target: targetGenie };
    await emitView(buildInitSummaryView(summary), parsed.options);

    // Note: Install agent is launched by start.sh after init completes
    // start.sh uses 'exec genie run' to replace itself and give install agent fresh stdin
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

  // 1. Copy root agents/workflows/skills from package .genie/
  const rootGenieDir = path.join(packageRoot, '.genie');
  await copyDirectory(rootGenieDir, targetGenie, {
    filter: (relPath) => {
      if (!relPath) return true;
      const firstSeg = relPath.split(path.sep)[0];

      // Blacklist takes priority (never copy these user directories)
      if (blacklist.has(firstSeg)) return false;

      // Only copy: agents, workflows, skills, AGENTS.md, CORE_AGENTS.md, config.yaml, templates
      if (['agents', 'workflows', 'skills'].includes(firstSeg)) return true;
      if (relPath === 'AGENTS.md' || relPath === 'config.yaml') return true;
      if (relPath.endsWith('.template.md')) return true; // Copy all template files
      return false;
    }
  });

  // 2. Copy chosen collective DIRECTORY (preserving structure)
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
  // Copy AGENTS.md, CORE_AGENTS.md, CLAUDE.md, and .gitignore from package root
  const rootFiles = ['AGENTS.md', 'CORE_AGENTS.md', 'CLAUDE.md', '.gitignore'];
  for (const file of rootFiles) {
    const sourcePath = path.join(packageRoot, file);
    const targetPath = path.join(targetDir, file);
    if (await pathExists(sourcePath)) {
      await fsp.copyFile(sourcePath, targetPath);
    }
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

async function initializeProviderStatus(cwd: string): Promise<void> {
  const statusPath = resolveProviderStatusPath(cwd);
  const existing = await pathExists(statusPath);
  if (!existing) {
    await writeJsonFile(statusPath, { entries: [] });
  }
}

function buildInitSummaryView(summary: InitSummary, includeInstallMessage: boolean = true) {
  const messages = [
    `✅ Installed Genie template at ${summary.target}`,
    `🔌 Default executor: ${summary.executor}${summary.model ? ` (model: ${summary.model})` : ''}`,
    `💾 Backup ID: ${summary.backupId ?? 'n/a'}`,
    `📚 Template source: ${summary.templateSource}`
  ];

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
  // Prefer project-level .genie/config.yaml; fallback to legacy .genie/cli/config.yaml
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

  const { spawnSync } = await import('child_process');
  const installScript = path.join(packageRoot, '.genie', 'scripts', 'install-hooks.cjs');
  const projectDir = process.cwd();

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
