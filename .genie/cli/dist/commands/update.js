"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runUpdate = runUpdate;
const path_1 = __importDefault(require("path"));
const fs_1 = require("fs");
const view_helpers_1 = require("../lib/view-helpers");
const common_1 = require("../views/common");
const paths_1 = require("../lib/paths");
const fs_utils_1 = require("../lib/fs-utils");
const package_1 = require("../lib/package");
const migrate_1 = require("../lib/migrate");
const config_1 = require("../lib/config");
const mcp_config_1 = require("../lib/mcp-config");
const executor_prompt_js_1 = require("../lib/executor-prompt.js");
async function runUpdate(parsed, _config, _paths) {
    try {
        const flags = parseFlags(parsed.commandArgs);
        const cwd = process.cwd();
        const targetGenie = (0, paths_1.resolveTargetGeniePath)(cwd);
        const templateGenie = (0, paths_1.getTemplateGeniePath)();
        if (!(await (0, fs_utils_1.pathExists)(targetGenie))) {
            await (0, view_helpers_1.emitView)((0, common_1.buildWarningView)('Genie not initialized', [
                'No .genie directory found in this workspace.',
                'Run `npx automagik-genie init` first and then retry update.'
            ]), parsed.options);
            process.exitCode = 1;
            return;
        }
        const templateExists = await (0, fs_utils_1.pathExists)(templateGenie);
        if (!templateExists) {
            await (0, view_helpers_1.emitView)((0, common_1.buildErrorView)('Template missing', `Could not locate packaged .genie templates at ${templateGenie}`), parsed.options, { stream: process.stderr });
            process.exitCode = 1;
            return;
        }
        // Auto-detect and migrate old Genie structure
        const installType = (0, migrate_1.detectInstallType)();
        if (installType === 'old_genie') {
            console.log('');
            console.log('╭───────────────────────────────────────────────────────────╮');
            console.log('│ 🔄 Old Genie Structure Detected                          │');
            console.log('│ Migrating to npm-backed architecture...                  │');
            console.log('╰───────────────────────────────────────────────────────────╯');
            console.log('');
            const migrationResult = await (0, migrate_1.runMigration)({ dryRun: flags.dryRun });
            if (migrationResult.status === 'failed') {
                await (0, view_helpers_1.emitView)((0, common_1.buildErrorView)('Migration Failed', `Could not migrate to new architecture:\n${migrationResult.errors.join('\n')}`), parsed.options, { stream: process.stderr });
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
            await (0, view_helpers_1.emitView)(buildUpdatePreviewView(diff), parsed.options);
            return;
        }
        if (!flags.force && diff.added.length === 0 && diff.modified.length === 0) {
            await (0, view_helpers_1.emitView)((0, common_1.buildInfoView)('No updates available', ['Your workspace already matches the packaged templates.']), parsed.options);
            return;
        }
        // Set up executor orchestration for update
        console.log('');
        console.log('🔄 Preparing update orchestration...');
        console.log('');
        // Detect available executors
        const availableExecutors = await detectAvailableExecutors();
        if (availableExecutors.length === 0) {
            await (0, view_helpers_1.emitView)((0, common_1.buildErrorView)('No executor found', 'Could not find codex or claude CLI.\n\n' +
                'Install one of:\n' +
                '  • Codex: npm install -g @namastexlabs/codex\n' +
                '  • Claude Code: https://docs.claude.com/docs/claude-code/install'), parsed.options, { stream: process.stderr });
            process.exitCode = 1;
            return;
        }
        console.log(`📦 Available executors: ${availableExecutors.join(', ')}`);
        console.log('');
        const config = await (0, config_1.loadConfig)();
        let executor;
        // If both available, ask user to choose
        if (availableExecutors.length > 1) {
            const defaultChoice = config?.defaults?.executor && availableExecutors.includes(config.defaults.executor)
                ? config.defaults.executor
                : availableExecutors[0];
            executor = await (0, executor_prompt_js_1.promptExecutorChoice)(availableExecutors, defaultChoice);
            console.log('');
            console.log(`✓ Using ${executor}`);
            console.log('');
            // Persist user's choice
            await saveExecutorChoice(executor, cwd);
        }
        else {
            // Only one available, use it
            executor = availableExecutors[0];
            console.log(`✓ Using ${executor} (only available executor)`);
            console.log('');
        }
        // Configure MCP for both Codex and Claude Code
        await (0, mcp_config_1.configureBothExecutors)(cwd);
        // Create backup BEFORE copying templates
        console.log('💾 Creating backup...');
        console.log('');
        const backupId = await createBackup(targetGenie);
        const backupPath = path_1.default.join('.genie/backups', backupId, 'genie');
        console.log(`✅ Backup created: ${backupPath}`);
        console.log('');
        // Copy UPDATE.md from template BEFORE generating prompt (so executor can reference it)
        const templateUpdateMd = path_1.default.join(templateGenie, 'UPDATE.md');
        const targetUpdateMd = path_1.default.join(targetGenie, 'UPDATE.md');
        if (await (0, fs_utils_1.pathExists)(templateUpdateMd)) {
            await fs_1.promises.copyFile(templateUpdateMd, targetUpdateMd);
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
        // Run update agent for version transition guidance
        console.log('🧞 Consulting update agent for migration guidance...');
        console.log('');
        await runUpdateNeuron(backupId, cwd);
        console.log('');
        console.log(`📝 Generating migration orchestration prompt...`);
        console.log('');
        const updatePrompt = buildUpdateOrchestrationPrompt(diff, installType, cwd, executor, backupPath);
        // Save prompt to file
        const promptFile = path_1.default.join(cwd, '.genie-update-prompt.md');
        await fs_1.promises.writeFile(promptFile, updatePrompt, 'utf8');
        console.log(`✅ Migration prompt ready`);
        console.log(`🚀 Handing off to ${executor} for context migration...`);
        console.log('');
        // Hand off to executor (replaces Node process with executor in user's terminal)
        await handoffToExecutor(executor, promptFile, cwd);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await (0, view_helpers_1.emitView)((0, common_1.buildErrorView)('Update failed', message), parsed.options, { stream: process.stderr });
        process.exitCode = 1;
    }
}
function buildUpdateOrchestrationPrompt(diff, installType, cwd, executor, backupPath) {
    const version = (0, package_1.getPackageVersion)();
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
async function saveExecutorChoice(executor, cwd) {
    try {
        const YAML = await import('yaml');
        const configPath = path_1.default.join(cwd, '.genie/cli/config.yaml');
        // Read existing config
        const configContent = await fs_1.promises.readFile(configPath, 'utf8');
        const configData = YAML.parse(configContent);
        // Update default executor
        if (!configData.defaults) {
            configData.defaults = {};
        }
        const oldExecutor = configData.defaults.executor;
        if (oldExecutor !== executor) {
            configData.defaults.executor = executor;
            // Write back
            const newContent = YAML.stringify(configData, { indent: 2, lineWidth: 120 });
            await fs_1.promises.writeFile(configPath, newContent, 'utf8');
            console.log(`💾 Saved ${executor} as default executor`);
            console.log('');
        }
    }
    catch (error) {
        // Non-fatal - just log warning
        console.log(`⚠️  Could not save executor preference: ${error instanceof Error ? error.message : String(error)}`);
        console.log('');
    }
}
async function handoffToExecutor(executor, promptFile, cwd) {
    const { spawn } = await import('child_process');
    const command = executor === 'claude' ? 'claude' : 'codex';
    // Read prompt content from file
    const promptContent = await fs_1.promises.readFile(promptFile, 'utf8');
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
    // Spawn executor with unrestricted flags, inheriting user's terminal (stdio)
    const child = spawn(command, args, {
        cwd,
        stdio: 'inherit', // User terminal becomes executor terminal
        shell: false // No shell - let Node handle argument escaping
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
async function invokeExecutor(executor, prompt, cwd) {
    const { spawn } = await import('child_process');
    const os = await import('os');
    const { writeFile, unlink } = await import('fs/promises');
    const command = executor === 'claude' ? 'claude' : 'codex';
    // Write prompt to temp file
    const tmpFile = path_1.default.join(os.tmpdir(), `genie-update-prompt-${Date.now()}.txt`);
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
                await unlink(tmpFile).catch(() => { });
                if (code === 0) {
                    resolve();
                }
                else {
                    reject(new Error(`${command} exited with code ${code}`));
                }
            });
            child.on('error', async (error) => {
                await unlink(tmpFile).catch(() => { });
                reject(new Error(`Failed to invoke ${command}: ${error.message}`));
            });
        });
    }
    catch (error) {
        await unlink(tmpFile).catch(() => { });
        throw error;
    }
}
function parseFlags(args) {
    const flags = {};
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
async function computeDiff(templateGenie, targetGenie) {
    const blacklist = (0, paths_1.getTemplateRelativeBlacklist)();
    const templateFiles = await (0, fs_utils_1.collectFiles)(templateGenie, {
        filter: (relPath) => {
            if (!relPath)
                return true;
            const head = relPath.split(path_1.default.sep)[0];
            return !blacklist.has(head);
        }
    });
    const added = [];
    const modified = [];
    const unchanged = [];
    for (const rel of templateFiles) {
        const templateFile = path_1.default.join(templateGenie, rel);
        const targetFile = path_1.default.join(targetGenie, rel);
        const exists = await (0, fs_utils_1.pathExists)(targetFile);
        if (!exists) {
            added.push(rel);
            continue;
        }
        const [templateContent, targetContent] = await Promise.all([
            fs_1.promises.readFile(templateFile, 'utf8'),
            fs_1.promises.readFile(targetFile, 'utf8')
        ]);
        if (templateContent === targetContent) {
            unchanged.push(rel);
        }
        else {
            modified.push(rel);
        }
    }
    return { added, modified, unchanged };
}
async function createBackup(targetGenie) {
    const backupId = (0, fs_utils_1.toIsoId)();
    const backupsRoot = path_1.default.join(targetGenie, 'backups');
    const backupDir = path_1.default.join(backupsRoot, backupId);
    const cwd = process.cwd();
    await (0, fs_utils_1.ensureDir)(backupDir);
    // Backup .genie directory
    await (0, fs_utils_1.snapshotDirectory)(targetGenie, path_1.default.join(backupDir, 'genie'));
    // Backup root framework documentation files
    const rootDocsDir = path_1.default.join(backupDir, 'docs');
    await (0, fs_utils_1.ensureDir)(rootDocsDir);
    const rootDocsFiles = ['AGENTS.md', 'CLAUDE.md'];
    for (const file of rootDocsFiles) {
        const srcPath = path_1.default.join(cwd, file);
        const destPath = path_1.default.join(rootDocsDir, file);
        if (await (0, fs_utils_1.pathExists)(srcPath)) {
            await fs_1.promises.copyFile(srcPath, destPath);
        }
    }
    return backupId;
}
async function runUpdateNeuron(backupId, cwd) {
    try {
        // Read version information
        const versionPath = (0, paths_1.resolveWorkspaceVersionPath)(cwd);
        const newVersion = (0, package_1.getPackageVersion)();
        // Try to get old version from backup
        const backupVersionPath = path_1.default.join(cwd, '.genie/backups', backupId, 'genie/state/version.json');
        let oldVersion = 'unknown';
        if (await (0, fs_utils_1.pathExists)(backupVersionPath)) {
            try {
                const backupVersionData = JSON.parse(await fs_1.promises.readFile(backupVersionPath, 'utf8'));
                oldVersion = backupVersionData.version || 'unknown';
            }
            catch {
                // If backup version file missing or corrupt, that's okay
                oldVersion = 'unknown';
            }
        }
        const backupPath = `.genie/backups/${backupId}/`;
        console.log(`📊 Version transition: ${oldVersion} → ${newVersion}`);
        console.log(`💾 Backup location: ${backupPath}`);
        console.log('');
        console.log('💡 Update agent guidance:');
        console.log('');
        // Determine which transition guide to use
        const majorMinor = (v) => {
            const match = v.match(/^(\d+)\.(\d+)/);
            return match ? `${match[1]}.${match[2]}` : null;
        };
        const oldMM = majorMinor(oldVersion);
        const newMM = majorMinor(newVersion);
        let guideFile = 'generic-update.md';
        if (oldMM && newMM && oldMM !== newMM) {
            const specificGuide = `v${oldMM}.x-to-v${newMM}.0.md`;
            const specificPath = path_1.default.join(cwd, '.genie/code/agents/update/versions', specificGuide);
            if (await (0, fs_utils_1.pathExists)(specificPath)) {
                guideFile = specificGuide;
            }
        }
        // Output guide summary
        const guidePath = path_1.default.join(cwd, '.genie/code/agents/update/versions', guideFile);
        if (await (0, fs_utils_1.pathExists)(guidePath)) {
            console.log(`   Using transition guide: ${guideFile}`);
            console.log(`   Full guide at: .genie/code/agents/update/versions/${guideFile}`);
            console.log('');
            console.log('   Key points:');
            console.log('   • Your previous configuration is safely backed up');
            console.log('   • Fresh framework templates have been installed');
            console.log('   • Check the transition guide for version-specific changes');
            console.log('   • Manually merge any customizations you want to preserve');
            console.log('');
        }
        else {
            console.log(`   ⚠️  Transition guide not found: ${guideFile}`);
            console.log('   Generic guidance: Review backup and manually merge customizations');
            console.log('');
        }
        console.log('✅ Update agent guidance provided');
    }
    catch (error) {
        // Non-fatal - log warning and continue
        console.log(`⚠️  Update agent unavailable: ${error instanceof Error ? error.message : String(error)}`);
        console.log('   Continuing with update...');
    }
}
async function copyTemplateGenie(templateGenie, targetGenie) {
    const blacklist = (0, paths_1.getTemplateRelativeBlacklist)();
    await (0, fs_utils_1.copyDirectory)(templateGenie, targetGenie, {
        filter: (relPath) => {
            if (!relPath)
                return true;
            const head = relPath.split(path_1.default.sep)[0];
            if (blacklist.has(head)) {
                return false;
            }
            return true;
        }
    });
}
async function touchVersionFile(cwd) {
    const versionPath = (0, paths_1.resolveWorkspaceVersionPath)(cwd);
    const existing = await (0, fs_utils_1.pathExists)(versionPath);
    const version = (0, package_1.getPackageVersion)();
    const now = new Date().toISOString();
    if (!existing) {
        await (0, fs_utils_1.writeJsonFile)(versionPath, {
            version,
            installedAt: now,
            lastUpdated: now,
            migrationInfo: {}
        });
        return;
    }
    const content = await fs_1.promises.readFile(versionPath, 'utf8');
    const data = JSON.parse(content);
    data.version = version;
    data.lastUpdated = now;
    await (0, fs_utils_1.writeJsonFile)(versionPath, data);
}
function buildUpdatePreviewView(diff) {
    const messages = [
        diff.added.length ? `➕ Files to add: ${diff.added.length}` : '➕ Files to add: none',
        diff.modified.length ? `♻️ Files to update: ${diff.modified.length}` : '♻️ Files to update: none',
        diff.unchanged.length ? `➖ Unchanged files: ${diff.unchanged.length}` : '➖ Unchanged files: none',
        '',
        'Run without --dry-run to apply these changes.'
    ];
    return (0, common_1.buildInfoView)('Genie update preview', messages);
}
function buildUpdateSummaryView(diff, backupId) {
    const messages = [
        `✅ Update complete. Backup created: ${backupId}`,
        diff.added.length ? `➕ Added ${diff.added.length} file(s).` : '➕ No added files.',
        diff.modified.length ? `♻️ Updated ${diff.modified.length} file(s).` : '♻️ No modified files.',
        '📦 Backups stored under .genie/backups'
    ];
    return (0, common_1.buildInfoView)('Genie update applied', messages);
}
