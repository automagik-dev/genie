import path from 'path';
import fs from 'fs';
import { promises as fsp } from 'fs';
import YAML from 'yaml';
import type { ParsedCommand, GenieConfig, ConfigPaths } from '../lib/types';
import { emitView } from '../lib/view-helpers';
import { buildErrorView, buildInfoView } from '../views/common';
import { promptExecutorChoice } from '../lib/executor-prompt.js';
import {
  getPackageRoot,
  getTemplateGeniePath,
  getTemplateClaudePath,
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
import { detectInstallType } from '../lib/migrate';
import { configureBothExecutors } from '../lib/mcp-config';

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

const PROVIDER_EXECUTOR: Record<string, string> = {
  codex: 'codex',
  claude: 'claude'
};

const PROVIDER_MODEL: Record<string, string> = {
  codex: 'gpt-5-codex',
  claude: 'sonnet-4.5'
};

const DEFAULT_MODE_DESCRIPTION: Record<string, string> = {
  codex: 'Workspace-write automation with GPT-5 Codex.',
  claude: 'Workspace automation with Claude Sonnet 4.5.'
};

const CLAUDE_EXEC_MODEL: Record<string, string> = {
  codex: 'sonnet',
  claude: 'sonnet-4.5'
};

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
    const templateClaude = getTemplateClaudePath();
    const targetGenie = resolveTargetGeniePath(cwd);

    const templateExists = await pathExists(templateGenie);
    if (!templateExists) {
      await emitView(buildErrorView('Template missing', `Could not locate packaged .genie templates at ${templateGenie}`), parsed.options, { stream: process.stderr });
      process.exitCode = 1;
      return;
    }

    // Check for partial installation (templates copied but executor not started)
    const versionPath = resolveWorkspaceVersionPath(cwd);
    const providerPath = resolveWorkspaceProviderPath(cwd);
    const partialInit = await pathExists(versionPath) && await pathExists(providerPath);

    if (partialInit) {
      console.log('');
      console.log('🔍 Detected partial installation');
      console.log('📦 Templates already copied, resuming setup...');
      console.log('');

      // Read provider from saved state
      const providerData = JSON.parse(await fsp.readFile(providerPath, 'utf8'));
      const savedProvider = providerData.provider || 'claude';

      // Detect available executors
      const available = await detectAvailableExecutors();

      let provider: string;
      if (flags.provider) {
        provider = normalizeProvider(flags.provider);
      } else if (available.length === 0) {
        console.log(`⚠️  No executors detected, using saved choice: ${savedProvider}`);
        console.log('');
        provider = savedProvider;
      } else if (available.length === 1) {
        provider = available[0];
        console.log(`✓ Using ${provider} (only available executor)`);
        console.log('');
      } else {
        // Both available - prompt user to confirm or change
        console.log(`Previously selected: ${savedProvider}`);
        console.log('');
        provider = await promptExecutorChoice(available, savedProvider);
        console.log('');
        console.log(`✓ Using ${provider}`);
        console.log('');

        // Update saved provider if changed
        if (provider !== savedProvider) {
          await writeProviderState(cwd, provider);
        }
      }

      // Verify executor is installed before resuming
      if (!available.includes(provider)) {
        console.log('');
        console.log(`⚠️  ${provider} is not installed`);
        console.log('');
        if (provider === 'claude') {
          console.log('Install Claude Code:');
          console.log('  npm install -g @anthropic-ai/claude-code');
          console.log('');
          console.log('Or visit: https://docs.claude.com/docs/claude-code/install');
        } else {
          console.log('Install Codex:');
          console.log('  npm install -g @namastexlabs/codex');
        }
        console.log('');
        console.log(`After installation, run: cd ${cwd} && genie init`);
        console.log('');
        process.exitCode = 1;
        return;
      }

      // Skip file operations, go straight to executor handoff
      const installPrompt = buildInstallPrompt(cwd, provider);

      console.log(`🚀 Resuming install with ${provider}...`);
      console.log('');

      await handoffToExecutor(provider, installPrompt, cwd);
      return;
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
      console.log('Recommended: Run `genie update` instead of `genie init`');
      console.log('This will automatically migrate to the new architecture.');
      console.log('');
      console.log('Or run `genie migrate` for migration only.');
      console.log('');

      await emitView(
        buildInfoView(
          'Migration Recommended',
          [
            'Use `genie update` to migrate and update in one step.',
            'Or use `genie migrate` for migration only.',
            'Or use `genie init --yes` to force reinitialize (not recommended).'
          ]
        ),
        parsed.options
      );
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

    if (await pathExists(templateClaude)) {
      await copyTemplateClaude(templateClaude, claudeDir);
    }

    await copyTemplateRootFiles(packageRoot, cwd);

    // Copy INSTALL.md workflow guide (like UPDATE.md for update command)
    const templateInstallMd = path.join(templateGenie, 'INSTALL.md');
    const targetInstallMd = path.join(targetGenie, 'INSTALL.md');
    if (await pathExists(templateInstallMd)) {
      await fsp.copyFile(templateInstallMd, targetInstallMd);
    }

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

    // Detect available executors ONCE and reuse throughout
    const availableExecutors = await detectAvailableExecutors();

    const provider = await resolveProviderChoice(flags, availableExecutors);
    await writeProviderState(cwd, provider);
    await writeVersionState(cwd, backupId, claudeExists);
    await initializeProviderStatus(cwd);
    await applyProviderDefaults(targetGenie, provider);

    // Configure MCP servers for both Codex and Claude Code
    await configureBothExecutors(cwd);

    const summary: InitSummary = {
      provider,
      backupId,
      claudeBackedUp: claudeExists,
      templateSource: templateGenie,
      target: targetGenie
    };

    await emitView(buildInitSummaryView(summary), parsed.options);

    // Verify executor is installed before handoff (use cached detection)
    if (!availableExecutors.includes(provider)) {
      console.log('');
      console.log(`⚠️  ${provider} is not installed`);
      console.log('');
      if (provider === 'claude') {
        console.log('Install Claude Code:');
        console.log('  npm install -g @anthropic-ai/claude-code');
        console.log('');
        console.log('Or visit: https://docs.claude.com/docs/claude-code/install');
      } else {
        console.log('Install Codex:');
        console.log('  npm install -g @namastexlabs/codex');
      }
      console.log('');
      console.log(`After installation, run: cd ${cwd} && genie init`);
      console.log('The templates are already installed - init will resume the setup.');
      console.log('');
      process.exitCode = 1;
      return;
    }

    // Hand off to install agent
    console.log('');
    console.log(`📝 Generating installation prompt...`);
    console.log('');

    console.log('[INIT] Building install prompt...');
    const installPrompt = buildInstallPrompt(cwd, provider);
    console.log(`[INIT] Prompt built: ${installPrompt.length} chars`);

    console.log(`✅ Installation prompt ready`);
    console.log(`🚀 Handing off to ${provider} for installation...`);
    console.log('');

    // Hand off to executor (replaces Node process with executor in user's terminal)
    console.log('[INIT] About to call handoffToExecutor');
    console.log(`[INIT] provider=${provider}, cwd=${cwd}`);
    await handoffToExecutor(provider, installPrompt, cwd);
    console.log('[INIT] AFTER handoffToExecutor (should never see this)');
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

async function copyTemplateClaude(templateClaude: string, targetClaude: string): Promise<void> {
  await ensureDir(path.dirname(targetClaude));
  await copyDirectory(templateClaude, targetClaude);
}

async function copyTemplateRootFiles(packageRoot: string, targetDir: string): Promise<void> {
  const templatesDir = path.join(packageRoot, 'templates');
  const rootFiles = ['AGENTS.md', 'CLAUDE.md'];

  for (const file of rootFiles) {
    const sourcePath = path.join(templatesDir, file);
    const targetPath = path.join(targetDir, file);

    if (await pathExists(sourcePath)) {
      await fsp.copyFile(sourcePath, targetPath);
    }
  }
}

async function resolveProviderChoice(flags: InitFlags, availableExecutors: string[]): Promise<string> {
  if (flags.provider) {
    return normalizeProvider(flags.provider);
  }
  if (process.env.GENIE_PROVIDER) {
    return normalizeProvider(process.env.GENIE_PROVIDER);
  }
  if (!process.stdout.isTTY || flags.yes) {
    return 'claude';  // Changed default from codex to claude
  }
  return await promptProvider(availableExecutors);
}

function normalizeProvider(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized.startsWith('claude')) {
    return 'claude';
  }
  return 'codex';
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

async function promptProvider(availableExecutors: string[]): Promise<string> {
  if (availableExecutors.length === 0) {
    console.log('');
    console.log('⚠️  No executors detected (codex or claude)');
    console.log('');
    console.log('Install one of:');
    console.log('  • Codex: npm install -g @namastexlabs/codex');
    console.log('  • Claude Code: https://docs.claude.com/docs/claude-code/install');
    console.log('');
    console.log('Defaulting to claude (you can install it later)');
    console.log('');
    return 'claude';
  }

  // If only one available, use it
  if (availableExecutors.length === 1) {
    const provider = availableExecutors[0];
    console.log('');
    console.log(`✓ Using ${provider} (only available executor)`);
    console.log('');
    return provider;
  }

  // Both available - use ink selector
  const selected = await promptExecutorChoice(availableExecutors, 'claude');
  console.log('');
  console.log(`✓ Using ${selected}`);
  console.log('');
  return selected;
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

async function applyProviderDefaults(genieRoot: string, provider: string): Promise<void> {
  const executor = PROVIDER_EXECUTOR[provider] ?? 'codex';
  const model = PROVIDER_MODEL[provider] ?? 'gpt-5-codex';
  await Promise.all([
    updateConfigForProvider(genieRoot, provider, executor, model),
    updateAgentsForProvider(genieRoot, executor, model)
  ]);
}

async function updateConfigForProvider(
  genieRoot: string,
  provider: string,
  executor: string,
  model: string
): Promise<void> {
  const configPath = path.join(genieRoot, 'cli', 'config.yaml');
  const exists = await fsp
    .access(configPath)
    .then(() => true)
    .catch(() => false);

  if (!exists) {
    return;
  }

  const original = await fsp.readFile(configPath, 'utf8');
  let updated = original;

  updated = replaceFirst(updated, /(defaults:\s*\n\s*executor:\s*)([^\s#]+)/, `$1${executor}`);

  updated = replaceFirst(
    updated,
    /(executionModes:\s*\n  default:\s*\n(?:(?: {4}.+\n)+?))/, // capture default block
    (match) => {
      let block = match;
      block = replaceFirst(block, /(    description:\s*)(.*)/, `$1${DEFAULT_MODE_DESCRIPTION[provider] ?? DEFAULT_MODE_DESCRIPTION.codex}`);
      block = replaceFirst(block, /(    executor:\s*)([^\s#]+)/, `$1${executor}`);
      block = replaceFirst(block, /(      model:\s*)([^\s#]+)/, `$1${model}`);
      return block;
    }
  );

  updated = replaceFirst(
    updated,
    /(  claude:\s*\n(?:(?: {4}.+\n)+?))/,
    (match) => {
      let block = match;
      block = replaceFirst(block, /(      model:\s*)([^\s#]+)/, `$1${CLAUDE_EXEC_MODEL[provider] ?? CLAUDE_EXEC_MODEL.codex}`);
      return block;
    }
  );

  if (updated !== original) {
    await fsp.writeFile(configPath, updated, 'utf8');
  }
}

async function updateAgentsForProvider(genieRoot: string, executor: string, model: string): Promise<void> {
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
      genieMeta.model = model;

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

function replaceFirst(source: string, pattern: RegExp, replacement: string | ((match: string) => string)): string {
  if (typeof replacement === 'function') {
    const match = source.match(pattern);
    if (!match) return source;
    const replaced = replacement(match[0]);
    return source.slice(0, match.index ?? 0) + replaced + source.slice((match.index ?? 0) + match[0].length);
  }
  return source.replace(pattern, replacement);
}

function buildInstallPrompt(cwd: string, provider: string): string {
  const version = getPackageVersion();
  return `# Genie Project Installation

**✅ Framework installed** - Genie v${version} templates ready

Your task: Complete project initialization and setup product documentation.

@.genie/INSTALL.md

## Installation Context

**Project:** ${cwd}
**Executor:** ${provider}
**Version:** ${version}

## What's Already Done

✅ Template files copied to .genie/
✅ AGENTS.md and CLAUDE.md created
✅ MCP configured (.mcp.json)
✅ Executor selected (${provider})
✅ INSTALL.md workflow guide available

## Your Task

Follow @.genie/INSTALL.md to complete the installation:

1. **Discovery**: Analyze repo state and choose installation mode
2. **Implementation**: Create product documentation
3. **Verification**: Validate installation and create summary

## Completion

After setup:
1. Provide the installation summary from INSTALL.md
2. Suggest next steps (typically \`/plan\`)
3. Optionally offer to delete .genie/INSTALL.md (see cleanup section in INSTALL.md)
`;
}

async function handoffToExecutor(executor: string, promptContent: string, cwd: string): Promise<void> {
  console.log('[HANDOFF] Starting handoffToExecutor');
  console.log(`[HANDOFF] executor=${executor}, cwd=${cwd}`);
  console.log(`[HANDOFF] Prompt content length: ${promptContent.length}`);

  const { spawn } = await import('child_process');

  const command = executor === 'claude' ? 'claude' : 'codex';
  console.log(`[HANDOFF] command=${command}`);

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
  console.log(`[HANDOFF] Args prepared: ${args.length} arguments`);

  // Spawn executor with unrestricted flags, inheriting user's terminal (stdio)
  console.log(`[HANDOFF] About to spawn: ${command}`);
  const child = spawn(command, args, {
    cwd,
    stdio: 'inherit',  // User terminal becomes executor terminal
    shell: false  // No shell - let Node handle argument escaping
  });

  console.log(`[HANDOFF] Spawned child PID: ${child.pid}`);

  // Wait for executor to complete, then exit with its code
  return new Promise((resolve, reject) => {
    child.on('exit', (code) => {
      console.log(`[HANDOFF] Child exited with code: ${code}`);
      process.exit(code || 0);
    });

    child.on('error', (error) => {
      console.error(`[HANDOFF] Child error:`, error);
      reject(new Error(`Failed to start ${command}: ${error.message}`));
    });
  });
}
