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
const executor_prompt_js_1 = require("../lib/executor-prompt.js");
const paths_1 = require("../lib/paths");
const fs_utils_1 = require("../lib/fs-utils");
const package_1 = require("../lib/package");
const migrate_1 = require("../lib/migrate");
const mcp_config_1 = require("../lib/mcp-config");
const PROVIDER_EXECUTOR = {
    codex: 'codex',
    claude: 'claude'
};
const PROVIDER_MODEL = {
    codex: 'gpt-5-codex',
    claude: 'sonnet-4.5'
};
const DEFAULT_MODE_DESCRIPTION = {
    codex: 'Workspace-write automation with GPT-5 Codex.',
    claude: 'Workspace automation with Claude Sonnet 4.5.'
};
const CLAUDE_EXEC_MODEL = {
    codex: 'sonnet',
    claude: 'sonnet-4.5'
};
async function runInit(parsed, _config, _paths) {
    try {
        const flags = parseFlags(parsed.commandArgs);
        const cwd = process.cwd();
        const packageRoot = (0, paths_1.getPackageRoot)();
        const templateGenie = (0, paths_1.getTemplateGeniePath)();
        const templateClaude = (0, paths_1.getTemplateClaudePath)();
        const targetGenie = (0, paths_1.resolveTargetGeniePath)(cwd);
        const templateExists = await (0, fs_utils_1.pathExists)(templateGenie);
        if (!templateExists) {
            await (0, view_helpers_1.emitView)((0, common_1.buildErrorView)('Template missing', `Could not locate packaged .genie templates at ${templateGenie}`), parsed.options, { stream: process.stderr });
            process.exitCode = 1;
            return;
        }
        // Check for partial installation (templates copied but executor not started)
        const versionPath = (0, paths_1.resolveWorkspaceVersionPath)(cwd);
        const providerPath = (0, paths_1.resolveWorkspaceProviderPath)(cwd);
        const partialInit = await (0, fs_utils_1.pathExists)(versionPath) && await (0, fs_utils_1.pathExists)(providerPath);
        if (partialInit) {
            console.log('');
            console.log('🔍 Detected partial installation');
            console.log('📦 Templates already copied, resuming setup...');
            console.log('');
            // Read provider from saved state
            const providerData = JSON.parse(await fs_1.promises.readFile(providerPath, 'utf8'));
            const savedProvider = providerData.provider || 'claude';
            // Detect available executors
            const available = await detectAvailableExecutors();
            let provider;
            if (flags.provider) {
                provider = normalizeProvider(flags.provider);
            }
            else if (available.length === 0) {
                console.log(`⚠️  No executors detected, using saved choice: ${savedProvider}`);
                console.log('');
                provider = savedProvider;
            }
            else if (available.length === 1) {
                provider = available[0];
                console.log(`✓ Using ${provider} (only available executor)`);
                console.log('');
            }
            else {
                // Both available - prompt user to confirm or change
                console.log(`Previously selected: ${savedProvider}`);
                console.log('');
                provider = await (0, executor_prompt_js_1.promptExecutorChoice)(available, savedProvider);
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
                }
                else {
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
            const promptFile = path_1.default.join(cwd, '.genie-install-prompt.md');
            await fs_1.promises.writeFile(promptFile, installPrompt, 'utf8');
            console.log(`🚀 Resuming install with ${provider}...`);
            console.log('');
            await handoffToExecutor(provider, promptFile, cwd);
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
            console.log('Recommended: Run `genie update` instead of `genie init`');
            console.log('This will automatically migrate to the new architecture.');
            console.log('');
            console.log('Or run `genie migrate` for migration only.');
            console.log('');
            await (0, view_helpers_1.emitView)((0, common_1.buildInfoView)('Migration Recommended', [
                'Use `genie update` to migrate and update in one step.',
                'Or use `genie migrate` for migration only.',
                'Or use `genie init --yes` to force reinitialize (not recommended).'
            ]), parsed.options);
            return;
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
        const claudeDir = path_1.default.resolve(cwd, '.claude');
        const claudeExists = await (0, fs_utils_1.pathExists)(claudeDir);
        if (claudeExists) {
            await (0, fs_utils_1.copyDirectory)(claudeDir, path_1.default.join(backupDir, 'claude'));
        }
        if (!targetExists) {
            await (0, fs_utils_1.ensureDir)(path_1.default.dirname(backupsRoot));
        }
        await copyTemplateGenie(templateGenie, targetGenie);
        if (await (0, fs_utils_1.pathExists)(templateClaude)) {
            await copyTemplateClaude(templateClaude, claudeDir);
        }
        await copyTemplateRootFiles(packageRoot, cwd);
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
        // Detect available executors ONCE and reuse throughout
        const availableExecutors = await detectAvailableExecutors();
        const provider = await resolveProviderChoice(flags, availableExecutors);
        await writeProviderState(cwd, provider);
        await writeVersionState(cwd, backupId, claudeExists);
        await initializeProviderStatus(cwd);
        await applyProviderDefaults(targetGenie, provider);
        // Configure MCP servers for both Codex and Claude Code
        await (0, mcp_config_1.configureBothExecutors)(cwd);
        const summary = {
            provider,
            backupId,
            claudeBackedUp: claudeExists,
            templateSource: templateGenie,
            target: targetGenie
        };
        await (0, view_helpers_1.emitView)(buildInitSummaryView(summary), parsed.options);
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
            }
            else {
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
        // Save prompt to file
        const promptFile = path_1.default.join(cwd, '.genie-install-prompt.md');
        console.log(`[INIT] Prompt file path: ${promptFile}`);
        try {
            console.log('[INIT] BEFORE writeFile');
            await fs_1.promises.writeFile(promptFile, installPrompt, 'utf8');
            console.log('[INIT] AFTER writeFile - file written successfully');
        }
        catch (writeError) {
            console.error('❌ Failed to write prompt file:', writeError);
            throw writeError;
        }
        console.log(`✅ Installation prompt ready`);
        console.log(`🚀 Handing off to ${provider} for installation...`);
        console.log('');
        // Hand off to executor (replaces Node process with executor in user's terminal)
        console.log('[INIT] About to call handoffToExecutor');
        console.log(`[INIT] provider=${provider}, promptFile=${promptFile}, cwd=${cwd}`);
        await handoffToExecutor(provider, promptFile, cwd);
        console.log('[INIT] AFTER handoffToExecutor (should never see this)');
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
async function copyTemplateGenie(templateGenie, targetGenie) {
    const blacklist = (0, paths_1.getTemplateRelativeBlacklist)();
    const hasExisting = await (0, fs_utils_1.pathExists)(targetGenie);
    if (!hasExisting) {
        await (0, fs_utils_1.ensureDir)(targetGenie);
    }
    await (0, fs_utils_1.copyDirectory)(templateGenie, targetGenie, {
        filter: (relPath) => {
            if (!relPath)
                return true;
            const firstSegment = relPath.split(path_1.default.sep)[0];
            if (blacklist.has(firstSegment)) {
                return false;
            }
            return true;
        }
    });
}
async function copyTemplateClaude(templateClaude, targetClaude) {
    await (0, fs_utils_1.ensureDir)(path_1.default.dirname(targetClaude));
    await (0, fs_utils_1.copyDirectory)(templateClaude, targetClaude);
}
async function copyTemplateRootFiles(packageRoot, targetDir) {
    const templatesDir = path_1.default.join(packageRoot, 'templates');
    const rootFiles = ['AGENTS.md', 'CLAUDE.md'];
    for (const file of rootFiles) {
        const sourcePath = path_1.default.join(templatesDir, file);
        const targetPath = path_1.default.join(targetDir, file);
        if (await (0, fs_utils_1.pathExists)(sourcePath)) {
            await fs_1.promises.copyFile(sourcePath, targetPath);
        }
    }
}
async function resolveProviderChoice(flags, availableExecutors) {
    if (flags.provider) {
        return normalizeProvider(flags.provider);
    }
    if (process.env.GENIE_PROVIDER) {
        return normalizeProvider(process.env.GENIE_PROVIDER);
    }
    if (!process.stdout.isTTY || flags.yes) {
        return 'claude'; // Changed default from codex to claude
    }
    return await promptProvider(availableExecutors);
}
function normalizeProvider(value) {
    const normalized = value.toLowerCase();
    if (normalized.startsWith('claude')) {
        return 'claude';
    }
    return 'codex';
}
async function detectAvailableExecutors() {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    const available = [];
    // Check Codex
    try {
        await execFileAsync('codex', ['--version'], { timeout: 5000 });
        available.push('codex');
    }
    catch {
        // Try npx fallback
        try {
            await execFileAsync('npx', ['-y', '@namastexlabs/codex@latest', '--version'], { timeout: 5000 });
            available.push('codex');
        }
        catch {
            // Not available
        }
    }
    // Check Claude
    try {
        await execFileAsync('claude', ['--version'], { timeout: 5000 });
        available.push('claude');
    }
    catch {
        // Not available
    }
    return available;
}
async function promptProvider(availableExecutors) {
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
    const selected = await (0, executor_prompt_js_1.promptExecutorChoice)(availableExecutors, 'claude');
    console.log('');
    console.log(`✓ Using ${selected}`);
    console.log('');
    return selected;
}
async function writeProviderState(cwd, provider) {
    const providerPath = (0, paths_1.resolveWorkspaceProviderPath)(cwd);
    await (0, fs_utils_1.writeJsonFile)(providerPath, {
        provider,
        decidedAt: new Date().toISOString(),
        source: 'init'
    });
}
async function writeVersionState(cwd, backupId, claudeBackedUp) {
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
            claudeBackedUp
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
function buildInitSummaryView(summary) {
    const messages = [
        `✅ Installed Genie template at ${summary.target}`,
        `🔌 Default provider: ${summary.provider}`,
        `💾 Backup ID: ${summary.backupId ?? 'n/a'}`,
        summary.claudeBackedUp ? '📦 Legacy .claude directory archived for migration.' : '📦 No legacy .claude directory detected.',
        `📚 Template source: ${summary.templateSource}`
    ];
    return (0, common_1.buildInfoView)('Genie initialization complete', messages);
}
async function applyProviderDefaults(genieRoot, provider) {
    const executor = PROVIDER_EXECUTOR[provider] ?? 'codex';
    const model = PROVIDER_MODEL[provider] ?? 'gpt-5-codex';
    await Promise.all([
        updateConfigForProvider(genieRoot, provider, executor, model),
        updateAgentsForProvider(genieRoot, executor, model)
    ]);
}
async function updateConfigForProvider(genieRoot, provider, executor, model) {
    const configPath = path_1.default.join(genieRoot, 'cli', 'config.yaml');
    const exists = await fs_1.promises
        .access(configPath)
        .then(() => true)
        .catch(() => false);
    if (!exists) {
        return;
    }
    const original = await fs_1.promises.readFile(configPath, 'utf8');
    let updated = original;
    updated = replaceFirst(updated, /(defaults:\s*\n\s*executor:\s*)([^\s#]+)/, `$1${executor}`);
    updated = replaceFirst(updated, /(executionModes:\s*\n  default:\s*\n(?:(?: {4}.+\n)+?))/, // capture default block
    (match) => {
        let block = match;
        block = replaceFirst(block, /(    description:\s*)(.*)/, `$1${DEFAULT_MODE_DESCRIPTION[provider] ?? DEFAULT_MODE_DESCRIPTION.codex}`);
        block = replaceFirst(block, /(    executor:\s*)([^\s#]+)/, `$1${executor}`);
        block = replaceFirst(block, /(      model:\s*)([^\s#]+)/, `$1${model}`);
        return block;
    });
    updated = replaceFirst(updated, /(  claude:\s*\n(?:(?: {4}.+\n)+?))/, (match) => {
        let block = match;
        block = replaceFirst(block, /(      model:\s*)([^\s#]+)/, `$1${CLAUDE_EXEC_MODEL[provider] ?? CLAUDE_EXEC_MODEL.codex}`);
        return block;
    });
    if (updated !== original) {
        await fs_1.promises.writeFile(configPath, updated, 'utf8');
    }
}
async function updateAgentsForProvider(genieRoot, executor, model) {
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
function buildInstallPrompt(cwd, provider) {
    const version = (0, package_1.getPackageVersion)();
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
async function handoffToExecutor(executor, promptFile, cwd) {
    console.log('[HANDOFF] Starting handoffToExecutor');
    console.log(`[HANDOFF] executor=${executor}, cwd=${cwd}`);
    const { spawn } = await import('child_process');
    const command = executor === 'claude' ? 'claude' : 'codex';
    console.log(`[HANDOFF] command=${command}`);
    // Read prompt content from file
    console.log(`[HANDOFF] Reading prompt file: ${promptFile}`);
    const promptContent = await fs_1.promises.readFile(promptFile, 'utf8');
    console.log(`[HANDOFF] Prompt content length: ${promptContent.length}`);
    // Add unrestricted flags for infrastructure operations
    const args = [];
    if (executor === 'claude') {
        // Claude: bypass all permission checks
        args.push('--dangerously-skip-permissions');
    }
    else {
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
        stdio: 'inherit', // User terminal becomes executor terminal
        shell: false // No shell - let Node handle argument escaping
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
