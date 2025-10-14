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
            executor = await promptExecutorChoice(availableExecutors, config?.defaults?.executor);
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
        console.log(`📝 Generating update orchestration prompt...`);
        console.log('');
        const updatePrompt = buildUpdateOrchestrationPrompt(diff, installType, cwd, executor);
        // Save prompt to file
        const promptFile = path_1.default.join(cwd, '.genie-update-prompt.md');
        await fs_1.promises.writeFile(promptFile, updatePrompt, 'utf8');
        console.log(`✅ Orchestration prompt ready`);
        console.log(`🚀 Handing off to ${executor} (unrestricted mode)...`);
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
function buildUpdateOrchestrationPrompt(diff, installType, cwd, executor) {
    const version = (0, package_1.getPackageVersion)();
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
async function promptExecutorChoice(availableExecutors, configuredDefault) {
    const readline = await import('readline');
    // Show default if configured and available
    const defaultChoice = configuredDefault && availableExecutors.includes(configuredDefault)
        ? configuredDefault
        : availableExecutors[0];
    console.log('Multiple executors available. Which would you like to use?');
    console.log('');
    availableExecutors.forEach((exec, idx) => {
        const isDefault = exec === defaultChoice;
        const marker = isDefault ? '→' : ' ';
        console.log(`  ${marker} ${idx + 1}) ${exec}${isDefault ? ' (default)' : ''}`);
    });
    console.log('');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return new Promise((resolve) => {
        rl.question(`Select executor (1-${availableExecutors.length}, or press Enter for ${defaultChoice}): `, (answer) => {
            rl.close();
            const trimmed = answer.trim();
            // Empty = use default
            if (!trimmed) {
                console.log(`Using ${defaultChoice}`);
                console.log('');
                resolve(defaultChoice);
                return;
            }
            // Parse number selection
            const choice = parseInt(trimmed, 10);
            if (!isNaN(choice) && choice >= 1 && choice <= availableExecutors.length) {
                const selected = availableExecutors[choice - 1];
                console.log(`Using ${selected}`);
                console.log('');
                resolve(selected);
                return;
            }
            // Invalid choice - use default
            console.log(`Invalid choice, using ${defaultChoice}`);
            console.log('');
            resolve(defaultChoice);
        });
    });
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
    await (0, fs_utils_1.ensureDir)(backupDir);
    await (0, fs_utils_1.snapshotDirectory)(targetGenie, path_1.default.join(backupDir, 'genie'));
    return backupId;
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
