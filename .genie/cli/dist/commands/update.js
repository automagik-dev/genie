"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runUpdate = runUpdate;
const child_process_1 = require("child_process");
const util_1 = require("util");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const gradient_string_1 = __importDefault(require("gradient-string"));
const view_helpers_1 = require("../lib/view-helpers");
const common_1 = require("../views/common");
const package_1 = require("../lib/package");
const upgrade_1 = require("../lib/upgrade");
const forge_manager_1 = require("../lib/forge-manager");
const execAsync = (0, util_1.promisify)(child_process_1.exec);
// Genie-themed gradients
const successGradient = (0, gradient_string_1.default)(['#00ff88', '#00ccff', '#0099ff']);
const performanceGradient = (0, gradient_string_1.default)(['#ffd700', '#ff8c00', '#ff6347']);
/**
 * Detect which npm channel the user is on (@next or @latest)
 * Returns 'next' for RC versions, 'latest' for stable versions
 */
function detectChannel(version) {
    // RC versions are on @next channel
    if (version.includes('-rc.')) {
        return 'next';
    }
    // Stable versions are on @latest channel
    return 'latest';
}
/**
 * Update command - updates the global npm package
 *
 * NO workspace changes, NO backups - just updates the global package.
 * Workspace upgrade happens automatically when you run `genie` or `genie init` after update.
 */
async function runUpdate(parsed, _config, _paths) {
    try {
        const flags = parseFlags(parsed.commandArgs);
        const currentVersion = (0, package_1.getPackageVersion)();
        // MASTER GENIE DETECTION: Check if we're in the template repo
        const workspacePackageJson = path_1.default.join(process.cwd(), 'package.json');
        let isMasterGenie = false;
        if (fs_1.default.existsSync(workspacePackageJson)) {
            try {
                const workspacePkg = JSON.parse(fs_1.default.readFileSync(workspacePackageJson, 'utf8'));
                if (workspacePkg.name === 'automagik-genie') {
                    isMasterGenie = true;
                }
            }
            catch {
                // Not master genie if can't read package.json
            }
        }
        // If master genie, check npm for latest published version (not local package.json)
        if (isMasterGenie) {
            // Detect package manager (prefer pnpm, fallback to npm)
            let packageManager = 'npm';
            try {
                await execAsync('pnpm --version');
                packageManager = 'pnpm';
            }
            catch {
                // pnpm not available, use npm
            }
            // Check npm registry for latest published version
            console.log('📦 Checking npm for updates...');
            console.log('');
            // Get currently installed global version FIRST (to detect channel)
            let globalVersion;
            try {
                const { stdout } = await execAsync(`${packageManager} list -g automagik-genie --depth=0 --json`);
                const globalData = JSON.parse(stdout);
                // pnpm returns an array, npm returns an object
                if (Array.isArray(globalData)) {
                    globalVersion = globalData[0]?.dependencies?.['automagik-genie']?.version || '';
                }
                else {
                    globalVersion = globalData.dependencies?.['automagik-genie']?.version || '';
                }
                // Handle file:/link: protocols (when installed from local directory)
                if (globalVersion.startsWith('file:') || globalVersion.startsWith('link:')) {
                    try {
                        const filePath = globalVersion.replace(/^(file:|link:)/, '');
                        const globalPackageJson = path_1.default.join(filePath, 'package.json');
                        if (fs_1.default.existsSync(globalPackageJson)) {
                            const globalPkg = JSON.parse(fs_1.default.readFileSync(globalPackageJson, 'utf8'));
                            globalVersion = globalPkg.version || '';
                        }
                    }
                    catch {
                        globalVersion = '';
                    }
                }
            }
            catch {
                globalVersion = '';
            }
            // Detect which channel user is on (next or latest)
            const channel = detectChannel(globalVersion || currentVersion);
            // Check for updates using correct channel
            const updateCheck = await (0, upgrade_1.checkForUpdates)(currentVersion, 'unknown', channel);
            // If global already matches latest npm version, nothing to do
            if (globalVersion === updateCheck.latestVersion) {
                console.log(successGradient('━'.repeat(60)));
                console.log(successGradient('   🧞 ✨ MASTER GENIE - ALREADY UP TO DATE ✨ 🧞   '));
                console.log(successGradient('━'.repeat(60)));
                console.log('');
                console.log(`Your global Genie matches npm @${channel}: ` + successGradient(updateCheck.latestVersion));
                console.log('');
                console.log('✨ Nothing to update!');
                console.log('');
                return;
            }
            // Update available from npm - install latest from registry
            console.log(successGradient('━'.repeat(60)));
            console.log(successGradient('   🧞 ✨ MASTER GENIE UPDATE ✨ 🧞   '));
            console.log(successGradient('━'.repeat(60)));
            console.log('');
            console.log(`Updating global Genie: ${performanceGradient(globalVersion || '(not installed)')} → ${successGradient(updateCheck.latestVersion)}`);
            console.log(`Channel: @${channel}`);
            console.log('');
            console.log(`Installing from npm (using ${packageManager})...`);
            console.log('');
            try {
                await execAsync(`${packageManager} install -g automagik-genie@${channel}`, { cwd: process.cwd() });
                console.log('');
                console.log(successGradient('✅ Successfully updated global Genie from npm!'));
                console.log('');
                console.log(`Your global Genie is now: ${successGradient(updateCheck.latestVersion)} (@${channel})`);
                console.log('');
                return;
            }
            catch (error) {
                throw new Error(`Failed to install from npm: ${error.message}\n\n` +
                    `Please try manually: ${packageManager} install -g automagik-genie@${channel}`);
            }
        }
        // NOT master genie - proceed with npm update flow
        // Detect which channel user is on (next or latest)
        const channel = detectChannel(currentVersion);
        // Check for updates
        console.log('📦 Checking for updates...');
        console.log('');
        const updateCheck = await (0, upgrade_1.checkForUpdates)(currentVersion, 'unknown', channel);
        if (!updateCheck.available) {
            await (0, view_helpers_1.emitView)((0, common_1.buildInfoView)('Already up to date', [
                `Current version: ${currentVersion}`,
                `Latest version: ${updateCheck.latestVersion}`,
                '✅ No updates available'
            ]), parsed.options);
            return;
        }
        // Show update info
        await (0, view_helpers_1.emitView)((0, common_1.buildInfoView)('Update available', [
            `Current: ${currentVersion}`,
            `Available: ${updateCheck.latestVersion}`,
            '',
            'Changes:',
            ...updateCheck.changes.map(c => `  ${c}`)
        ]), parsed.options);
        console.log('');
        // Prompt for confirmation (unless --force)
        if (!flags.force) {
            const { default: prompts } = await import('prompts');
            const response = await prompts({
                type: 'confirm',
                name: 'proceed',
                message: 'Update global Genie package?',
                initial: true
            });
            if (!response.proceed) {
                console.log('Update cancelled.');
                return;
            }
        }
        console.log('');
        console.log('📦 Updating global package...');
        console.log('');
        // Detect package manager (prefer pnpm, fallback to npm)
        let packageManager = 'npm';
        try {
            await execAsync('pnpm --version');
            packageManager = 'pnpm';
        }
        catch {
            // pnpm not available, use npm
        }
        // Update global package using detected channel (already detected above)
        const updateCommand = `${packageManager} install -g automagik-genie@${channel}`;
        console.log(`   Running: ${updateCommand}`);
        console.log(`   Channel: @${channel}`);
        console.log('');
        try {
            const { stdout, stderr } = await execAsync(updateCommand);
            if (stdout)
                console.log(stdout);
            if (stderr && !stderr.includes('npm WARN'))
                console.error(stderr);
        }
        catch (error) {
            throw new Error(`Failed to update package: ${error.message}\n\n` +
                `Please try manually: ${updateCommand}`);
        }
        console.log('');
        console.log(`✅ I've evolved to ${updateCheck.latestVersion}!`);
        console.log('');
        // Check if Forge is already running
        const baseUrl = process.env.FORGE_BASE_URL || 'http://localhost:8887';
        const forgeRunning = await (0, forge_manager_1.isForgeRunning)(baseUrl);
        if (forgeRunning) {
            // Forge is running - your clone needs to learn the new powers
            await (0, view_helpers_1.emitView)((0, common_1.buildInfoView)('Master Genie Updated', [
                '✨ I (the Master) have learned new powers!',
                '',
                '💡 Your clone is still running the old me...',
                '   Run `genie` again to teach your clone these new powers',
                '   (I\'ll sync all my latest knowledge to your workspace)',
                '',
                '🔮 Your clone will inherit everything I just learned!'
            ]), parsed.options);
        }
        else {
            // Forge not running - offer to summon the clone now
            console.log('💡 Next time you summon me, I\'ll teach your clone everything new!');
            console.log('');
            // Prompt to start genie now (unless --force which skips all prompts)
            if (!flags.force) {
                const { default: prompts } = await import('prompts');
                const response = await prompts({
                    type: 'confirm',
                    name: 'startNow',
                    message: 'Summon your Genie clone now to learn these powers?',
                    initial: true
                });
                if (response.startNow) {
                    console.log('');
                    console.log('🔮 Preparing to summon your clone...');
                    console.log('');
                    await (0, view_helpers_1.emitView)((0, common_1.buildInfoView)('Ready to Summon', [
                        'Run `genie` to summon your clone',
                        '(I\'ll automatically teach it everything I just learned!)'
                    ]), parsed.options);
                }
                else {
                    await (0, view_helpers_1.emitView)((0, common_1.buildInfoView)('Master Genie Updated', [
                        '✨ I\'m ready when you are!',
                        '   Run `genie` anytime to teach your clone these new powers'
                    ]), parsed.options);
                }
            }
            else {
                await (0, view_helpers_1.emitView)((0, common_1.buildInfoView)('Master Genie Updated', [
                    '✨ Run `genie` to teach your clone these new powers!'
                ]), parsed.options);
            }
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await (0, view_helpers_1.emitView)((0, common_1.buildErrorView)('Update failed', message), parsed.options, { stream: process.stderr });
        process.exitCode = 1;
    }
}
function parseFlags(args) {
    const flags = {};
    for (let i = 0; i < args.length; i++) {
        const token = args[i];
        if (token === '--force' || token === '-f') {
            flags.force = true;
        }
    }
    return flags;
}
