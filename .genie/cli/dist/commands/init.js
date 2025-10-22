"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runInit = runInit;
const path_1 = __importDefault(require("path"));
const fs_1 = require("fs");
const yaml_1 = __importDefault(require("yaml"));
const view_helpers_1 = require("../lib/view-helpers");
const common_1 = require("../views/common");
const executor_registry_1 = require("../lib/executor-registry");
const collective_discovery_js_1 = require("../lib/collective-discovery.js");
const paths_1 = require("../lib/paths");
const fs_utils_1 = require("../lib/fs-utils");
const package_1 = require("../lib/package");
const migrate_1 = require("../lib/migrate");
const mcp_config_1 = require("../lib/mcp-config");
const DEFAULT_MODE_DESCRIPTION = 'Workspace automation via Forge-backed executors.';
async function runInit(parsed, _config, _paths) {
    try {
        const flags = parseFlags(parsed.commandArgs);
        const cwd = process.cwd();
        const packageRoot = (0, paths_1.getPackageRoot)();
        // Check if running in interactive mode (TTY) or automation mode (--yes flag or explicit template)
        const isInteractive = process.stdout.isTTY && !flags.yes && !flags.template;
        let template;
        let executor;
        let model;
        let shouldInitGit = false;
        if (isInteractive) {
            // Use dynamic import to load ESM Ink components
            const { runInitWizard } = await import('../views/init-wizard.js');
            // Discover collectives dynamically from .genie/ directory
            const genieRoot = path_1.default.join(packageRoot, '.genie');
            const discovered = await (0, collective_discovery_js_1.discoverCollectives)(genieRoot);
            const templates = discovered.map(c => ({
                value: c.id,
                label: c.label || c.name,
                description: c.description
            }));
            // Fallback if discovery fails
            if (templates.length === 0) {
                templates.push({
                    value: 'code',
                    label: '💻 Code',
                    description: 'Full-stack development with Git, testing, CI/CD'
                });
            }
            const executors = Object.keys(executor_registry_1.EXECUTORS).map(key => ({
                label: executor_registry_1.EXECUTORS[key].label,
                value: key
            }));
            const hasGit = await (0, fs_utils_1.pathExists)(path_1.default.join(cwd, '.git'));
            const wizardConfig = await runInitWizard({
                templates,
                executors,
                hasGit
            });
            template = wizardConfig.template;
            executor = wizardConfig.executor;
            model = wizardConfig.model;
            shouldInitGit = wizardConfig.initGit;
        }
        else {
            // Automation mode: use flags or defaults
            template = (flags.template || 'code');
            executor = Object.keys(executor_registry_1.EXECUTORS)[0] || 'codex';
            model = undefined;
        }
        const templateGenie = (0, paths_1.getTemplateGeniePath)(template);
        const targetGenie = (0, paths_1.resolveTargetGeniePath)(cwd);
        const templateExists = await (0, fs_utils_1.pathExists)(templateGenie);
        if (!templateExists) {
            await (0, view_helpers_1.emitView)((0, common_1.buildErrorView)('Template missing', `Could not locate packaged .genie templates at ${templateGenie}`), parsed.options, { stream: process.stderr });
            process.exitCode = 1;
            return;
        }
        // Check for partial installation (templates copied but executor not started)
        const versionPath = (0, paths_1.resolveWorkspaceVersionPath)(cwd);
        const partialInit = await (0, fs_utils_1.pathExists)(versionPath);
        if (partialInit) {
            console.log('');
            console.log('🔍 Detected partial installation');
            console.log('📦 Templates already copied, resuming setup...');
            console.log('');
            // Skip file operations; go straight to executor setup
            const { executor, model } = await selectExecutorAndModel(flags);
            await applyExecutorDefaults(targetGenie, executor, model);
            await (0, mcp_config_1.configureBothExecutors)(cwd);
            await (0, view_helpers_1.emitView)(buildInitSummaryView({ executor, model, templateSource: templateGenie, target: targetGenie }), parsed.options);
            // Note: Install agent is launched by start.sh after init completes
            return;
        }
        // Auto-detect old Genie structure and suggest migration
        const installType = (0, migrate_1.detectInstallType)();
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
            await (0, view_helpers_1.emitView)((0, common_1.buildInfoView)('Old Installation Detected', [
                'Use `genie init --yes` to force reinitialize (creates backup first).'
            ]), parsed.options);
            return;
        }
        // Initialize git if needed (wizard already prompted in interactive mode)
        if (shouldInitGit || (!isInteractive && !await (0, fs_utils_1.pathExists)(path_1.default.join(cwd, '.git')))) {
            if (!isInteractive && flags.yes) {
                const { execSync } = await import('child_process');
                // Set default branch to main to suppress git init hints
                execSync('git config --global init.defaultBranch main 2>/dev/null || true', { cwd, stdio: 'pipe' });
                execSync('git init', { cwd, stdio: 'pipe' });
            }
            else if (shouldInitGit) {
                const { execSync } = await import('child_process');
                // Set default branch to main to suppress git init hints
                execSync('git config --global init.defaultBranch main 2>/dev/null || true', { cwd, stdio: 'pipe' });
                execSync('git init', { cwd, stdio: 'pipe' });
            }
        }
        const backupId = (0, fs_utils_1.toIsoId)();
        const targetExists = await (0, fs_utils_1.pathExists)(targetGenie);
        const backupsRoot = (0, paths_1.resolveBackupsRoot)(cwd);
        let backupDir;
        let stagedBackupDir = null;
        if (targetExists) {
            backupDir = path_1.default.join(backupsRoot, backupId);
            await (0, fs_utils_1.ensureDir)(backupDir);
            await (0, fs_utils_1.snapshotDirectory)(targetGenie, path_1.default.join(backupDir, 'genie'));
        }
        else {
            stagedBackupDir = path_1.default.join((0, paths_1.resolveTempBackupsRoot)(cwd), backupId);
            await (0, fs_utils_1.ensureDir)(stagedBackupDir);
            backupDir = stagedBackupDir;
        }
        // Backup AGENTS.md at repo root if present
        const agentsMdPath = path_1.default.join(cwd, 'AGENTS.md');
        const agentsMdExists = await (0, fs_utils_1.pathExists)(agentsMdPath);
        if (agentsMdExists) {
            await fs_1.promises.copyFile(agentsMdPath, path_1.default.join(backupDir, 'AGENTS.md'));
        }
        if (!targetExists) {
            await (0, fs_utils_1.ensureDir)(path_1.default.dirname(backupsRoot));
        }
        await copyTemplateFiles(packageRoot, template, targetGenie);
        await copyTemplateRootFiles(packageRoot, cwd, template);
        await migrateAgentsDocs(cwd);
        // Copy INSTALL.md workflow guide (like UPDATE.md for update command)
        const templateInstallMd = path_1.default.join(templateGenie, 'INSTALL.md');
        const targetInstallMd = path_1.default.join(targetGenie, 'INSTALL.md');
        if (await (0, fs_utils_1.pathExists)(templateInstallMd)) {
            await fs_1.promises.copyFile(templateInstallMd, targetInstallMd);
        }
        if (stagedBackupDir) {
            const finalBackupsDir = path_1.default.join(backupsRoot, backupId);
            await (0, fs_utils_1.ensureDir)(backupsRoot);
            await (0, fs_utils_1.ensureDir)(path_1.default.join(targetGenie, 'backups'));
            if (!(await (0, fs_utils_1.pathExists)(finalBackupsDir))) {
                await (0, fs_utils_1.moveDirectory)(stagedBackupDir, finalBackupsDir);
            }
            else {
                await fs_1.promises.rm(stagedBackupDir, { recursive: true, force: true });
            }
            const tempRoot = (0, paths_1.resolveTempBackupsRoot)(cwd);
            try {
                await fs_1.promises.rm(tempRoot, { recursive: true, force: true });
            }
            catch (error) {
                if (error && error.code !== 'ENOENT') {
                    // ignore
                }
            }
        }
        await (0, fs_utils_1.ensureDir)(backupsRoot);
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
        await (0, mcp_config_1.configureBothExecutors)(cwd);
        // Show completion summary (install agent will be launched by start.sh via exec)
        const summary = { executor, model, backupId, templateSource: templateGenie, target: targetGenie };
        await (0, view_helpers_1.emitView)(buildInitSummaryView(summary), parsed.options);
        // Note: Install agent is launched by start.sh after init completes
        // start.sh uses 'exec genie run' to replace itself and give install agent fresh stdin
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await (0, view_helpers_1.emitView)((0, common_1.buildErrorView)('Init failed', message), parsed.options, { stream: process.stderr });
        process.exitCode = 1;
    }
}
function parseFlags(args) {
    const flags = {};
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
                flags.template = token;
            }
        }
    }
    return flags;
}
async function copyTemplateFiles(packageRoot, template, targetGenie) {
    const blacklist = (0, paths_1.getTemplateRelativeBlacklist)();
    await (0, fs_utils_1.ensureDir)(targetGenie);
    // 1. Copy root agents/workflows/skills from package .genie/
    const rootGenieDir = path_1.default.join(packageRoot, '.genie');
    await (0, fs_utils_1.copyDirectory)(rootGenieDir, targetGenie, {
        filter: (relPath) => {
            if (!relPath)
                return true;
            const firstSeg = relPath.split(path_1.default.sep)[0];
            // Blacklist takes priority (never copy these user directories)
            if (blacklist.has(firstSeg))
                return false;
            // Only copy: agents, workflows, skills, AGENTS.md, CORE_AGENTS.md, config.yaml, templates
            if (['agents', 'workflows', 'skills'].includes(firstSeg))
                return true;
            if (relPath === 'AGENTS.md' || relPath === 'config.yaml')
                return true;
            if (relPath.endsWith('.template.md'))
                return true; // Copy all template files
            return false;
        }
    });
    // 2. Copy chosen collective DIRECTORY (preserving structure)
    const collectiveSource = path_1.default.join(packageRoot, '.genie', template);
    const collectiveTarget = path_1.default.join(targetGenie, template);
    await (0, fs_utils_1.copyDirectory)(collectiveSource, collectiveTarget, {
        filter: (relPath) => {
            if (!relPath)
                return true;
            const firstSeg = relPath.split(path_1.default.sep)[0];
            return !blacklist.has(firstSeg);
        }
    });
}
async function copyTemplateRootFiles(packageRoot, targetDir, template) {
    // Copy AGENTS.md, CORE_AGENTS.md, CLAUDE.md, and .gitignore from package root
    const rootFiles = ['AGENTS.md', 'CORE_AGENTS.md', 'CLAUDE.md', '.gitignore'];
    for (const file of rootFiles) {
        const sourcePath = path_1.default.join(packageRoot, file);
        const targetPath = path_1.default.join(targetDir, file);
        if (await (0, fs_utils_1.pathExists)(sourcePath)) {
            await fs_1.promises.copyFile(sourcePath, targetPath);
        }
    }
}
async function migrateAgentsDocs(cwd) {
    try {
        // Remove mistaken .genie/agents.genie if present
        const mistaken = path_1.default.join(cwd, '.genie', 'agents.genie');
        try {
            await fs_1.promises.rm(mistaken, { force: true });
        }
        catch { }
        // Ensure domain AGENTS.md include the root AGENTS.md directly
        const domains = [
            path_1.default.join(cwd, '.genie', 'code', 'AGENTS.md'),
            path_1.default.join(cwd, '.genie', 'create', 'AGENTS.md')
        ];
        for (const domainFile of domains) {
            try {
                const raw = await fs_1.promises.readFile(domainFile, 'utf8');
                if (!/@AGENTS\.md/i.test(raw)) {
                    const next = raw.trimEnd() + `\n\n@AGENTS.md\n`;
                    await fs_1.promises.writeFile(domainFile, next, 'utf8');
                }
            }
            catch (_) { }
        }
    }
    catch (err) {
        console.log(`⚠️  Agents docs migration skipped: ${err?.message || String(err)}`);
    }
}
async function selectExecutorAndModel(flags) {
    // Build list from packaged executors (Forge handles binaries internally)
    const keys = Object.keys(executor_registry_1.EXECUTORS);
    let defaultKey = keys.includes('codex') ? 'codex' : (keys[0] || 'codex');
    // Non-interactive default
    if (!process.stdout.isTTY || flags.yes) {
        return { executor: defaultKey, model: undefined };
    }
    const executor = await promptExecutorArrow(keys, defaultKey);
    // Prompt model with default based on current config file (if present)
    const configPath = path_1.default.join(process.cwd(), '.genie', 'config.yaml');
    let defaultModel = executor === 'claude' ? 'sonnet' : 'gpt-5-codex';
    try {
        const raw = await fs_1.promises.readFile(configPath, 'utf8');
        const data = yaml_1.default.parse(raw) || {};
        defaultModel = data?.executionModes?.default?.overrides?.exec?.model || defaultModel;
    }
    catch { }
    const model = await promptText(`Default model for ${executor}`, defaultModel);
    return { executor, model };
}
async function promptTemplateChoice() {
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
async function writeVersionState(cwd, backupId, _legacyBackedUp) {
    const versionPath = (0, paths_1.resolveWorkspaceVersionPath)(cwd);
    const version = (0, package_1.getPackageVersion)();
    const now = new Date().toISOString();
    const existing = await fs_1.promises.readFile(versionPath, 'utf8').catch(() => null);
    let installedAt = now;
    if (existing) {
        try {
            const parsed = JSON.parse(existing);
            installedAt = parsed.installedAt ?? now;
        }
        catch {
            installedAt = now;
        }
    }
    await (0, fs_utils_1.writeJsonFile)(versionPath, {
        version,
        installedAt,
        lastUpdated: now,
        migrationInfo: {
            backupId,
            claudeBackedUp: false
        }
    });
}
async function initializeProviderStatus(cwd) {
    const statusPath = (0, paths_1.resolveProviderStatusPath)(cwd);
    const existing = await (0, fs_utils_1.pathExists)(statusPath);
    if (!existing) {
        await (0, fs_utils_1.writeJsonFile)(statusPath, { entries: [] });
    }
}
function buildInitSummaryView(summary, includeInstallMessage = true) {
    const messages = [
        `✅ Installed Genie template at ${summary.target}`,
        `🔌 Default executor: ${summary.executor}${summary.model ? ` (model: ${summary.model})` : ''}`,
        `💾 Backup ID: ${summary.backupId ?? 'n/a'}`,
        `📚 Template source: ${summary.templateSource}`
    ];
    if (includeInstallMessage) {
        messages.push(`🛠️ Started Install agent via Genie run`);
    }
    return (0, common_1.buildInfoView)('Genie initialization complete', messages.filter(Boolean));
}
async function detectTemplateFromGenie(genieRoot) {
    // Detect template from .genie structure (code or create collective)
    const codeExists = await (0, fs_utils_1.pathExists)(path_1.default.join(genieRoot, 'code'));
    const createExists = await (0, fs_utils_1.pathExists)(path_1.default.join(genieRoot, 'create'));
    if (codeExists)
        return 'code';
    if (createExists)
        return 'create';
    return 'code'; // fallback
}
async function applyExecutorDefaults(genieRoot, executorKey, model) {
    await Promise.all([
        updateProjectConfig(genieRoot, executorKey, model),
        updateAgentsForExecutor(genieRoot, executorKey, model)
    ]);
}
async function updateProjectConfig(genieRoot, executorKey, model) {
    // Prefer project-level .genie/config.yaml; fallback to legacy .genie/cli/config.yaml
    const primaryConfigPath = path_1.default.join(genieRoot, 'config.yaml');
    const legacyConfigPath = path_1.default.join(genieRoot, 'cli', 'config.yaml');
    const configPath = (await fs_1.promises
        .access(primaryConfigPath)
        .then(() => true)
        .catch(() => false)) ? primaryConfigPath : legacyConfigPath;
    const exists = await fs_1.promises
        .access(configPath)
        .then(() => true)
        .catch(() => false);
    if (!exists) {
        return;
    }
    const original = await fs_1.promises.readFile(configPath, 'utf8');
    let updated = original;
    // defaults.executor
    updated = replaceFirst(updated, /(defaults:\s*\n\s*executor:\s*)([^\s#]+)/, `$1${executorKey}`);
    // executionModes.default block
    updated = replaceFirst(updated, /(executionModes:\s*\n  default:\s*\n(?:(?: {4}.+\n)+?))/, // capture default block
    (match) => {
        let block = match;
        block = replaceFirst(block, /(    description:\s*)(.*)/, `$1${DEFAULT_MODE_DESCRIPTION}`);
        block = replaceFirst(block, /(    executor:\s*)([^\s#]+)/, `$1${executorKey}`);
        if (model)
            block = replaceFirst(block, /(      model:\s*)([^\s#]+)/, `$1${model}`);
        return block;
    });
    if (updated !== original) {
        await fs_1.promises.writeFile(configPath, updated, 'utf8');
    }
}
async function updateAgentsForExecutor(genieRoot, executor, model) {
    const agentsDir = path_1.default.join(genieRoot, 'agents');
    // Skip if agents directory doesn't exist (blacklisted during init)
    const agentsDirExists = await (0, fs_utils_1.pathExists)(agentsDir);
    if (!agentsDirExists) {
        return;
    }
    const files = await collectAgentFiles(agentsDir);
    await Promise.all(files.map(async (file) => {
        const original = await fs_1.promises.readFile(file, 'utf8');
        if (!original.startsWith('---'))
            return;
        const end = original.indexOf('\n---', 3);
        if (end === -1)
            return;
        const frontMatterContent = original.slice(4, end);
        let data;
        try {
            data = yaml_1.default.parse(frontMatterContent) || {};
        }
        catch {
            return; // skip files with invalid front matter
        }
        if (!data || typeof data !== 'object')
            return;
        if (!data.genie || typeof data.genie !== 'object') {
            data.genie = {};
        }
        const genieMeta = data.genie;
        genieMeta.executor = executor;
        if (model)
            genieMeta.model = model;
        const nextFrontMatter = yaml_1.default.stringify(data, { indent: 2 }).trimEnd();
        const nextContent = `---\n${nextFrontMatter}\n---${original.slice(end + 4)}`;
        if (nextContent !== original) {
            await fs_1.promises.writeFile(file, nextContent, 'utf8');
        }
    }));
}
async function collectAgentFiles(dir) {
    const entries = await fs_1.promises.readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const fullPath = path_1.default.join(dir, entry.name);
        if (entry.isDirectory()) {
            const nested = await collectAgentFiles(fullPath);
            files.push(...nested);
            continue;
        }
        if (!entry.isFile())
            continue;
        if (!entry.name.endsWith('.md'))
            continue;
        if (entry.name.toLowerCase() === 'README.md'.toLowerCase())
            continue;
        files.push(fullPath);
    }
    return files;
}
function replaceFirst(source, pattern, replacement) {
    if (typeof replacement === 'function') {
        const match = source.match(pattern);
        if (!match)
            return source;
        const replaced = replacement(match[0]);
        return source.slice(0, match.index ?? 0) + replaced + source.slice((match.index ?? 0) + match[0].length);
    }
    return source.replace(pattern, replacement);
}
// Legacy handoff removed in favor of Forge task creation
async function promptExecutorArrow(options, defaultValue) {
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
        const onData = (buf) => {
            const s = buf.toString();
            if (s === '\u0003') { // Ctrl+C
                process.stdin.off('data', onData);
                if (process.stdin.setRawMode)
                    process.stdin.setRawMode(false);
                process.stdin.pause();
                resolve(defaultValue);
                return;
            }
            if (s === '\r' || s === '\n') {
                process.stdin.off('data', onData);
                if (process.stdin.setRawMode)
                    process.stdin.setRawMode(false);
                process.stdin.pause();
                console.log('');
                resolve(options[index]);
                return;
            }
            if (s.startsWith('\u001b')) {
                // Arrow keys
                if (s === '\u001b[A')
                    index = (index - 1 + options.length) % options.length; // up
                if (s === '\u001b[B')
                    index = (index + 1) % options.length; // down
                render();
            }
        };
        process.stdin.resume();
        if (process.stdin.setRawMode)
            process.stdin.setRawMode(true);
        process.stdin.on('data', onData);
    });
}
async function promptText(question, defaultValue) {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    const suffix = defaultValue ? ` (${defaultValue})` : '';
    const answer = await new Promise((resolve) => rl.question(`${question}${suffix}: `, (ans) => { rl.close(); resolve(ans); }));
    const trimmed = answer.trim();
    return trimmed.length ? trimmed : defaultValue;
}
async function promptYesNo(question, defaultYes = true) {
    if (!process.stdout.isTTY)
        return defaultYes;
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    const suffix = defaultYes ? ' [Y/n]' : ' [y/N]';
    const answer = await new Promise((resolve) => rl.question(`${question}${suffix}: `, (ans) => {
        rl.close();
        resolve(ans);
    }));
    const trimmed = answer.trim().toLowerCase();
    if (trimmed === '')
        return defaultYes;
    return trimmed === 'y' || trimmed === 'yes';
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
