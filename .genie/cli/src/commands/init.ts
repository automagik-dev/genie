import path from 'path';
import fs from 'fs';
import { promises as fsp } from 'fs';
import YAML from 'yaml';
import type { ParsedCommand, GenieConfig, ConfigPaths } from '../lib/types';
import { emitView } from '../lib/view-helpers';
import { buildErrorView, buildInfoView } from '../views/common';
import { promptExecutorChoice } from '../lib/executor-prompt.js';
import { EXECUTORS } from '../lib/executor-registry';
// TODO: Enable once ESM imports resolved
// import { runInitWizard } from '../views/init-wizard.js';
// import { runInstallChat } from '../views/install-chat.js';
import {
  getPackageRoot,
  getTemplateGeniePath,
  getTemplateRootPath,
  getTemplateRelativeBlacklist,
  resolveTargetGeniePath,
  resolveWorkspaceProviderPath,
  resolveWorkspaceVersionPath,
  resolveBackupsRoot,
  resolveTempBackupsRoot,
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
  snapshotDirectory
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

    if (isInteractive) {
      // TODO: Enable Ink wizard once ESM imports resolved
      // For now, use existing prompts or require explicit template flag
      // const wizardConfig = await runInitWizard({...});

      console.log('');
      console.log('🧞 Genie Init');
      console.log('');
      console.log('For now, please run: genie init code  OR  genie init create');
      console.log('');
      console.log('Interactive wizard coming soon!');
      console.log('');
      process.exit(0);
    } else {
      // Automation mode: use flags or defaults
      template = (flags.template || 'code') as TemplateType;
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
    const versionPath = resolveWorkspaceVersionPath(cwd);
    const partialInit = await pathExists(versionPath);

    if (partialInit) {
      console.log('');
      console.log('🔍 Detected partial installation');
      console.log('📦 Templates already copied, resuming setup...');
      console.log('');

      // Skip file operations; go straight to Forge-backed setup
      const { executor, model } = await selectExecutorAndModel(flags);
      await applyExecutorDefaults(targetGenie, executor, model);
      await configureBothExecutors(cwd);
      // TODO: Add install chat flow here (future enhancement)
      await emitView(buildInitSummaryView({ executor, model, templateSource: templateGenie, target: targetGenie }), parsed.options);
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
      console.log('Run `genie init --yes` to force reinitialize (creates backup).');
      console.log('');

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
        execSync('git init', { cwd, stdio: 'inherit' });
        try {
          execSync('git branch -m main', { cwd, stdio: 'pipe' });
        } catch {
          // Ignore if branch rename fails (already on main)
        }
      } else if (shouldInitGit) {
        const { execSync } = await import('child_process');
        execSync('git init', { cwd, stdio: 'inherit' });
        try {
          execSync('git branch -m main', { cwd, stdio: 'pipe' });
        } catch {
          // Ignore if branch rename fails (already on main)
        }
      }
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

    // Backup AGENTS.md at repo root if present
    const agentsMdPath = path.join(cwd, 'AGENTS.md');
    const agentsMdExists = await pathExists(agentsMdPath);
    if (agentsMdExists) {
      await fsp.copyFile(agentsMdPath, path.join(backupDir, 'AGENTS.md'));
    }

    if (!targetExists) {
      await ensureDir(path.dirname(backupsRoot));
    }

    await copyTemplateFiles(packageRoot, template as TemplateType, targetGenie);

    await copyTemplateRootFiles(packageRoot, cwd, template as TemplateType);
    await migrateAgentsDocs(cwd);

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

    // Use wizard selections in interactive mode, or select defaults in automation mode
    if (!isInteractive && !executor) {
      const selected = await selectExecutorAndModel(flags);
      executor = selected.executor;
      model = selected.model;
    }

    await writeVersionState(cwd, backupId, false);
    await initializeProviderStatus(cwd);
    await applyExecutorDefaults(targetGenie, executor, model);

    // Configure MCP servers for both Codex and Claude Code
    await configureBothExecutors(cwd);

    // TODO: Add install chat flow here (future enhancement)
    const summary: InitSummary = { executor, model, backupId, templateSource: templateGenie, target: targetGenie };
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

  // 1. Copy root agents/workflows from package .genie/
  const rootGenieDir = path.join(packageRoot, '.genie');
  await copyDirectory(rootGenieDir, targetGenie, {
    filter: (relPath) => {
      if (!relPath) return true;
      const firstSeg = relPath.split(path.sep)[0];
      // Only copy: agents, workflows, skills, AGENTS.md, config.yaml
      if (['agents', 'workflows', 'skills'].includes(firstSeg)) return true;
      if (relPath === 'AGENTS.md' || relPath === 'config.yaml') return true;
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
  // Copy AGENTS.md and .gitignore from package root; never copy CLAUDE.md
  const rootFiles = ['AGENTS.md', '.gitignore'];
  for (const file of rootFiles) {
    const sourcePath = path.join(packageRoot, file);
    const targetPath = path.join(targetDir, file);
    if (await pathExists(sourcePath)) {
      await fsp.copyFile(sourcePath, targetPath);
    }
  }
  // If user has CLAUDE.md, ensure it references @AGENTS.md for compatibility
  const userClaude = path.join(targetDir, 'CLAUDE.md');
  if (await pathExists(userClaude)) {
    const content = await fsp.readFile(userClaude, 'utf8');
    if (!/@AGENTS\.md/i.test(content)) {
      const next = content.trimEnd() + `\n\n@AGENTS.md\n`;
      await fsp.writeFile(userClaude, next, 'utf8');
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

async function selectExecutorAndModel(flags: InitFlags): Promise<{ executor: string; model?: string }> {
  // Build list from packaged executors (Forge handles binaries internally)
  const keys = Object.keys(EXECUTORS);
  let defaultKey = keys.includes('codex') ? 'codex' : (keys[0] || 'codex');
  // Non-interactive default
  if (!process.stdout.isTTY || flags.yes) {
    return { executor: defaultKey, model: undefined };
  }
  const executor = await promptExecutorArrow(keys, defaultKey);
  // Prompt model with default based on current config file (if present)
  const configPath = path.join(process.cwd(), '.genie', 'config.yaml');
  let defaultModel = executor === 'claude' ? 'sonnet' : 'gpt-5-codex';
  try {
    const raw = await fsp.readFile(configPath, 'utf8');
    const data = YAML.parse(raw) || {};
    defaultModel = data?.executionModes?.default?.overrides?.exec?.model || defaultModel;
  } catch {}
  const model = await promptText(`Default model for ${executor}`, defaultModel);
  return { executor, model };
}

async function promptTemplateChoice(): Promise<TemplateType> {
  // Template choice is mandatory - show help and exit
  // User must run: genie init <template>
  console.log('');
  console.log('🧞 Genie Init - Choose Your Template');
  console.log('');
  console.log('Available templates:');
  console.log('  genie init code      - Software development (full-stack, testing, git)');
  console.log('  genie init create    - Research, writing, planning (self-adaptive AI)');
  console.log('');
  console.log('Example:');
  console.log('  genie init code');
  console.log('');

  process.exit(0);
}

async function writeVersionState(cwd: string, backupId: string, _legacyBackedUp: boolean): Promise<void> {
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
      claudeBackedUp: false
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
    `🔌 Default executor: ${summary.executor}${summary.model ? ` (model: ${summary.model})` : ''}`,
    `💾 Backup ID: ${summary.backupId ?? 'n/a'}`,
    `📚 Template source: ${summary.templateSource}`,
    `🛠️ Started Install agent via Genie run`
  ];
  return buildInfoView('Genie initialization complete', messages.filter(Boolean) as string[]);
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

async function promptExecutorArrow(options: string[], defaultValue: string): Promise<string> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      resolve(defaultValue);
      return;
    }
    let index = Math.max(0, options.indexOf(defaultValue));
    const render = () => {
      process.stdout.write('\x1Bc'); // clear screen
      console.log('Select default executor (↑/↓, Enter):');
      options.forEach((opt, i) => {
        const prefix = i === index ? '›' : ' ';
        console.log(`${prefix} ${opt}`);
      });
      console.log('');
    };
    render();
    const onData = (buf: Buffer) => {
      const s = buf.toString();
      if (s === '\u0003') { // Ctrl+C
        process.stdin.off('data', onData);
        if ((process.stdin as any).setRawMode) (process.stdin as any).setRawMode(false);
        process.stdin.pause();
        resolve(defaultValue);
        return;
      }
      if (s === '\r' || s === '\n') {
        process.stdin.off('data', onData);
        if ((process.stdin as any).setRawMode) (process.stdin as any).setRawMode(false);
        process.stdin.pause();
        console.log('');
        resolve(options[index]);
        return;
      }
      if (s.startsWith('\u001b')) {
        // Arrow keys
        if (s === '\u001b[A') index = (index - 1 + options.length) % options.length; // up
        if (s === '\u001b[B') index = (index + 1) % options.length; // down
        render();
      }
    };
    process.stdin.resume();
    if ((process.stdin as any).setRawMode) (process.stdin as any).setRawMode(true);
    process.stdin.on('data', onData);
  });
}

async function promptText(question: string, defaultValue?: string): Promise<string | undefined> {
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` (${defaultValue})` : '';
  const answer: string = await new Promise((resolve) => rl.question(`${question}${suffix}: `, (ans: string) => { rl.close(); resolve(ans); }));
  const trimmed = answer.trim();
  return trimmed.length ? trimmed : defaultValue;
}

async function promptYesNo(question: string, defaultYes: boolean = true): Promise<boolean> {
  if (!process.stdout.isTTY) return defaultYes;
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultYes ? ' [Y/n]' : ' [y/N]';
  const answer: string = await new Promise((resolve) =>
    rl.question(`${question}${suffix}: `, (ans: string) => {
      rl.close();
      resolve(ans);
    })
  );
  const trimmed = answer.trim().toLowerCase();
  if (trimmed === '') return defaultYes;
  return trimmed === 'y' || trimmed === 'yes';
}

function mapExecutorToForgeProfile(executorKey: string): { executor: string; variant: string} {
  const mapping: Record<string, string> = {
    'claude': 'CLAUDE_CODE',
    'claude-code': 'CLAUDE_CODE',
    'codex': 'CODEX',
    'opencode': 'OPENCODE',
    'gemini': 'GEMINI',
    'cursor': 'CURSOR',
    'qwen_code': 'QWEN_CODE',
    'amp': 'AMP',
    'copilot': 'COPILOT'
  };
  const normalized = (executorKey || '').toLowerCase();
  return { executor: mapping[normalized] || normalized.toUpperCase(), variant: 'DEFAULT' };
}

async function runInstallViaCli(cwd: string, template: TemplateType, flags?: InitFlags): Promise<void> {
  try {
    const { spawn } = await import('child_process');
    const cliPath = path.join(getPackageRoot(), '.genie', 'cli', 'dist', 'genie.js');
    const workflowPath = template === 'create'
      ? '@.genie/create/workflows/install.md'
      : '@.genie/code/workflows/install.md';
    const agentId = template === 'create' ? 'create/install' : 'code/install';
    const prompt = [
      'Use the install subagent to set up Genie in this repo.',
      '@agent-install',
      workflowPath
    ].join('\n');
    const baseUrl = flags?.forgeBaseUrl ? flags.forgeBaseUrl : (flags?.forgePort ? `http://localhost:${flags.forgePort}` : 'http://localhost:8887');
    const child = spawn(process.execPath, [cliPath, 'run', agentId, prompt], {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, GENIE_USE_FORGE: '1', FORGE_BASE_URL: baseUrl }
    });
    await new Promise<void>((resolve) => child.on('close', () => resolve()));
  } catch (err) {
    console.log(`⚠️  Failed to launch Install agent via CLI: ${(err as Error)?.message || String(err)}`);
  }
}
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
