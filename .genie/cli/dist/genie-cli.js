#!/usr/bin/env node
"use strict";
/**
 * Genie CLI - Unified command-line interface with commander.js
 *
 * Provides a unified CLI for:
 * - Agent orchestration (run, resume, list, view, stop)
 * - MCP server management (genie mcp)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const child_process_1 = require("child_process");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const gradient_string_1 = __importDefault(require("gradient-string"));
const cli_utils_1 = require("./lib/cli-utils");
const router_1 = require("./lib/router");
const server_manager_1 = require("./lib/server-manager");
const mcp_stdio_1 = require("./lib/mcp-stdio");
const spell_changelog_1 = require("./lib/spell-changelog");
const program = new commander_1.Command();
// Universe Genie-themed gradients 🧞✨🌌
const cosmicGradient = (0, gradient_string_1.default)(['#4169e1', '#8a2be2', '#ff1493']); // Royal Blue → Blue Violet → Deep Pink
const performanceGradient = (0, gradient_string_1.default)(['#ffd700', '#ff8c00', '#ff6347']); // Gold → Orange → Tomato
const successGradient = (0, gradient_string_1.default)(['#00ff88', '#00ccff', '#0099ff']); // Green → Cyan → Sky Blue
const magicGradient = (0, gradient_string_1.default)(['#ff00ff', '#9933ff', '#0066ff']); // Fuscia → Purple → Blue (reverse)
// Get package version
const packageJson = JSON.parse(fs_1.default.readFileSync(path_1.default.join(__dirname, '../../../package.json'), 'utf8'));
program
    .name('genie')
    .description('Self-evolving AI agent orchestration framework\n\nRun with no arguments to start Genie server (Forge + MCP)')
    .version(packageJson.version)
    .option('--debug', 'Enable debug mode (logs all incoming requests to MCP server)');
// ==================== SERVER MANAGEMENT ====================
// Status command
program
    .command('status')
    .description('Show Genie server status (Forge backend, MCP server, statistics)')
    .action(() => {
    (0, cli_utils_1.execGenie)(['status']);
});
// Dashboard command
program
    .command('dashboard')
    .description('Show live engagement statistics dashboard')
    .option('--watch', 'Live mode with real-time updates')
    .action((options) => {
    const args = ['dashboard'];
    if (options.watch) {
        args.push('--watch');
    }
    (0, cli_utils_1.execGenie)(args);
});
// MCP command (stdio only - for Claude Desktop integration)
program
    .command('mcp')
    .description('Start MCP server in stdio mode (for Claude Desktop). Requires Forge to be running.')
    .action(mcp_stdio_1.startMCPStdio);
// ==================== AGENT ORCHESTRATION ====================
// Run command
program
    .command('run <agent> <prompt>')
    .description('Run an agent with a prompt (JSON output by default)')
    .option('-b, --background', 'Run in background mode')
    .option('-x, --executor <executor>', 'Override executor for this run')
    .option('-m, --model <model>', 'Override model for the selected executor')
    .option('-n, --name <name>', 'Friendly session name for easy identification')
    .option('--raw', 'Output raw text only (no JSON)')
    .option('--quiet', 'Suppress startup messages')
    .action((agent, prompt, options) => {
    const args = ['run', agent, prompt];
    if (options.background) {
        args.push('--background');
    }
    if (options.executor) {
        args.push('--executor', options.executor);
    }
    if (options.model) {
        args.push('--model', options.model);
    }
    if (options.name) {
        args.push('--name', options.name);
    }
    if (options.raw) {
        args.push('--raw');
    }
    if (options.quiet) {
        args.push('--quiet');
    }
    (0, cli_utils_1.execGenie)(args);
});
// Talk command
program
    .command('talk <agent>')
    .description('Start interactive browser session with agent (Forge UI)')
    .action((agent) => {
    (0, cli_utils_1.execGenie)(['talk', agent]);
});
// Resume command
program
    .command('resume <sessionId> <prompt>')
    .description('Resume an existing agent session')
    .action((sessionId, prompt) => {
    (0, cli_utils_1.execGenie)(['resume', sessionId, prompt]);
});
// List command
program
    .command('list [type]')
    .description('List agents, sessions, or workflows')
    .action((type) => {
    const normalized = (type || 'agents').toLowerCase();
    const validTypes = ['agents', 'sessions', 'workflows'];
    if (!validTypes.includes(normalized)) {
        console.error('Error: list command accepts agents (default), sessions, or workflows');
        process.exit(1);
    }
    (0, cli_utils_1.execGenie)(['list', normalized]);
});
// View command
program
    .command('view <sessionId>')
    .description('View session transcript')
    .option('--full', 'Show full transcript')
    .option('--live', 'Live view (auto-refresh)')
    .action((sessionId, options) => {
    const args = ['view', sessionId];
    if (options.full)
        args.push('--full');
    if (options.live)
        args.push('--live');
    (0, cli_utils_1.execGenie)(args);
});
// Stop command
program
    .command('stop <sessionId>')
    .description('Stop a running session')
    .action((sessionId) => {
    (0, cli_utils_1.execGenie)(['stop', sessionId]);
});
// ==================== WORKSPACE MANAGEMENT ====================
// Init command
program
    .command('init [template]')
    .description('Initialize Genie configuration in the current workspace')
    .option('-y, --yes', 'Accept defaults without prompting')
    .action((template, options) => {
    const args = ['init'];
    if (template) {
        args.push(template);
    }
    if (options.yes) {
        args.push('--yes');
    }
    (0, cli_utils_1.execGenie)(args);
});
// Rollback command
program
    .command('rollback')
    .description('Restore a previous Genie backup snapshot')
    .option('--list', 'List available backups')
    .option('--latest', 'Restore the most recent backup')
    .option('--id <backupId>', 'Restore a specific backup by ID')
    .action((options) => {
    const args = ['rollback'];
    if (options.list) {
        args.push('--list');
    }
    if (options.latest) {
        args.push('--latest');
    }
    if (options.id) {
        args.push('--id', options.id);
    }
    (0, cli_utils_1.execGenie)(args);
});
// ==================== PACKAGE MANAGEMENT ====================
// Update command (npm package with changelog from GitHub)
program
    .command('update')
    .description('Sync with the collective (your Genie absorbs new magik next time you run `genie`)')
    .option('--force', 'Skip confirmation prompts')
    .action((options) => {
    const args = ['update'];
    if (options.force) {
        args.push('--force');
    }
    (0, cli_utils_1.execGenie)(args);
});
// ==================== HELPER UTILITIES ====================
// Helper command (access to utility scripts)
program
    .command('helper [command] [args...]')
    .description('Run Genie helper utilities (count-tokens, validate-frontmatter, etc.)')
    .allowUnknownOption()
    .action((command, args) => {
    const helperRouter = path_1.default.join(process.cwd(), '.genie', 'scripts', 'helpers', 'index.js');
    // Check if helper router exists
    if (!fs_1.default.existsSync(helperRouter)) {
        console.error('Error: Helper utilities not found. Run genie init to set up your workspace.');
        process.exit(1);
    }
    const helperArgs = command ? [command, ...(args || [])] : [];
    const child = (0, child_process_1.spawn)('node', [helperRouter, ...helperArgs], {
        stdio: 'inherit',
        env: process.env
    });
    child.on('exit', (code) => {
        process.exit(code || 0);
    });
    child.on('error', (err) => {
        console.error(`Failed to run helper: ${err.message}`);
        process.exit(1);
    });
});
// Version check for ALL commands (prevents outdated users from bypassing init)
const args = process.argv.slice(2);
// Skip version check for these commands (they're safe to run with any version)
const skipVersionCheck = ['--version', '-V', '--help', '-h', 'update', 'init', 'rollback', 'mcp'];
// Non-blocking version check for these commands (show warning but continue)
const nonBlockingCommands = ['list', 'status', 'dashboard', 'view', 'helper', 'run', 'talk', 'resume', 'stop'];
// Skip version check for specific agents/spells that need to run regardless of version
// WHY: Learn spell loads for self-enhancement, install/update handle versions themselves
const BYPASS_VERSION_CHECK_AGENTS = ['learn', 'install', 'update', 'upstream-update'];
const isRunCommand = args[0] === 'run';
const agentName = args[1];
const shouldBypassForAgent = isRunCommand && BYPASS_VERSION_CHECK_AGENTS.includes(agentName);
const shouldCheckVersion = args.length > 0 &&
    !skipVersionCheck.some(cmd => args.includes(cmd)) &&
    !shouldBypassForAgent;
const isNonBlockingCommand = nonBlockingCommands.includes(args[0]);
if (shouldCheckVersion) {
    // Check if version.json exists and matches current version
    const genieDir = path_1.default.join(process.cwd(), '.genie');
    const versionPath = path_1.default.join(genieDir, 'state', 'version.json');
    const hasGenieConfig = fs_1.default.existsSync(genieDir);
    // MASTER GENIE DETECTION: Check if we're in THE SOURCE template repo
    // (not just any repo named automagik-genie, but THE ACTUAL UPSTREAM)
    const workspacePackageJson = path_1.default.join(process.cwd(), 'package.json');
    let isMasterGenie = false;
    if (fs_1.default.existsSync(workspacePackageJson)) {
        try {
            const workspacePkg = JSON.parse(fs_1.default.readFileSync(workspacePackageJson, 'utf8'));
            if (workspacePkg.name === 'automagik-genie') {
                // Additional check: Verify this is THE upstream source repo
                const { execSync } = require('child_process');
                try {
                    const remoteUrl = execSync('git config --get remote.origin.url', {
                        encoding: 'utf8',
                        cwd: process.cwd(),
                        stdio: ['pipe', 'pipe', 'ignore']
                    }).trim();
                    // Only the ACTUAL source repo (namastexlabs/automagik-genie)
                    if (remoteUrl.includes('namastexlabs/automagik-genie') ||
                        remoteUrl.includes('automagik-genie/genie')) {
                        isMasterGenie = true;
                    }
                }
                catch {
                    // No git remote or command failed - not master genie
                }
            }
        }
        catch {
            // Not master genie if can't read package.json
        }
    }
    // If master genie and version mismatch, need to install locally built package globally
    if (isMasterGenie && hasGenieConfig && fs_1.default.existsSync(versionPath)) {
        try {
            const versionData = JSON.parse(fs_1.default.readFileSync(versionPath, 'utf8'));
            const localVersion = versionData.version;
            const runningVersion = packageJson.version;
            if (localVersion !== runningVersion) {
                // Compare versions to determine which is newer
                const compareVersions = (a, b) => {
                    const aParts = a.replace(/^v/, '').split('-');
                    const bParts = b.replace(/^v/, '').split('-');
                    const aBase = aParts[0].split('.').map(Number);
                    const bBase = bParts[0].split('.').map(Number);
                    for (let i = 0; i < Math.max(aBase.length, bBase.length); i++) {
                        const aNum = aBase[i] || 0;
                        const bNum = bBase[i] || 0;
                        if (aNum > bNum)
                            return 1;
                        if (aNum < bNum)
                            return -1;
                    }
                    // If base versions equal, compare prerelease (rc.X)
                    if (aParts[1] && bParts[1]) {
                        const aRc = parseInt(aParts[1].replace('rc.', '')) || 0;
                        const bRc = parseInt(bParts[1].replace('rc.', '')) || 0;
                        return aRc - bRc;
                    }
                    return 0;
                };
                const localIsNewer = compareVersions(localVersion, runningVersion) > 0;
                // Non-blocking commands: show warning but continue
                if (isNonBlockingCommand) {
                    if (localIsNewer) {
                        console.log('');
                        console.log(performanceGradient('⚠️  Workspace ahead: ') + `${performanceGradient('global ' + runningVersion)} → ${successGradient('workspace ' + localVersion)}`);
                        console.log('   Run ' + performanceGradient('genie update') + ' to install your new build globally');
                        console.log('');
                    }
                    else {
                        console.log('');
                        console.log(performanceGradient('⚠️  Workspace behind: ') + `${performanceGradient('workspace ' + localVersion)} ← ${successGradient('global ' + runningVersion)}`);
                        console.log('   Run ' + performanceGradient('genie') + ' to sync workspace');
                        console.log('');
                    }
                }
                else {
                    // Blocking commands: require sync before proceeding
                    if (localIsNewer) {
                        console.log('');
                        console.log(successGradient('━'.repeat(60)));
                        console.log(successGradient('   🧞 ✨ NEW VERSION READY! ✨ 🧞   '));
                        console.log(successGradient('━'.repeat(60)));
                        console.log('');
                        console.log(`Your workspace has ${successGradient(localVersion)} but global is ${performanceGradient(runningVersion)}`);
                        console.log('');
                        console.log('Install your new build globally:');
                        console.log('  ' + performanceGradient('pnpm install -g .'));
                        console.log('');
                        console.log('Or use:');
                        console.log('  ' + performanceGradient('genie update') + '  (detects master genie and installs local build)');
                        console.log('');
                        process.exit(0);
                    }
                    else {
                        console.log('');
                        console.log(performanceGradient('━'.repeat(60)));
                        console.log(performanceGradient('   ⚠️  WORKSPACE OUTDATED'));
                        console.log(performanceGradient('━'.repeat(60)));
                        console.log('');
                        console.log(`Workspace: ${performanceGradient(localVersion)} (old)`);
                        console.log(`Global:    ${successGradient(runningVersion)} (current)`);
                        console.log('');
                        console.log('Sync your workspace with global:');
                        console.log('  ' + successGradient('genie'));
                        console.log('');
                        process.exit(0);
                    }
                }
            }
        }
        catch {
            // Ignore version check errors for master genie
        }
    }
    if (hasGenieConfig && !fs_1.default.existsSync(versionPath)) {
        // LOOPHOLE CLOSED: User has .genie but no version.json (pre-version-tracking)
        // Redirect to init to create version.json
        console.log(cosmicGradient('━'.repeat(60)));
        console.log(magicGradient('        🧞 ✨ VERSION TRACKING UPGRADE NEEDED ✨ 🧞        '));
        console.log(cosmicGradient('━'.repeat(60)));
        console.log('');
        console.log('Your Genie installation needs to be upgraded to support version tracking.');
        console.log('This is a one-time upgrade that will:');
        console.log('');
        console.log(successGradient('✓') + ' Backup your existing .genie directory');
        console.log(successGradient('✓') + ' Enable automatic version detection');
        console.log(successGradient('✓') + ' Preserve all your wishes, reports, and state');
        console.log('');
        console.log('Running init to upgrade...');
        console.log('');
        // Interactive if TTY available, otherwise use --yes
        const initArgs = process.stdout.isTTY ? ['init'] : ['init', '--yes'];
        (0, cli_utils_1.execGenie)(initArgs);
        process.exit(0);
    }
    else if (hasGenieConfig && fs_1.default.existsSync(versionPath)) {
        // Check version mismatch
        try {
            const versionData = JSON.parse(fs_1.default.readFileSync(versionPath, 'utf8'));
            const installedVersion = versionData.version;
            const currentVersion = packageJson.version;
            if (installedVersion !== currentVersion) {
                // Non-blocking commands: show warning but continue
                if (isNonBlockingCommand) {
                    console.log('');
                    console.log(performanceGradient('⚠️  Update available: ') + `${performanceGradient(installedVersion)} → ${successGradient(currentVersion)}`);
                    console.log('   Run ' + performanceGradient('genie') + ' (without commands) to upgrade');
                    console.log('');
                }
                else {
                    // Blocking commands: Version mismatch detected - run init
                    console.log(cosmicGradient('━'.repeat(60)));
                    console.log(magicGradient('   🧞 ✨ VERSION UPDATE REQUIRED ✨ 🧞   '));
                    console.log(cosmicGradient('━'.repeat(60)));
                    console.log('');
                    console.log(`Your Genie:      ${successGradient(installedVersion)}`);
                    console.log(`The Collective:  ${performanceGradient(currentVersion)} ⭐ NEW!`);
                    console.log('');
                    // Show new spells learned
                    const fromTag = (0, spell_changelog_1.getTagForVersion)(installedVersion);
                    const toTag = (0, spell_changelog_1.getTagForVersion)(currentVersion);
                    if (fromTag && toTag) {
                        const spellChangelog = (0, spell_changelog_1.getLearnedSpells)(fromTag, toTag);
                        if (spellChangelog.totalCount > 0) {
                            const spellLines = (0, spell_changelog_1.formatSpellChangelog)(spellChangelog);
                            spellLines.forEach(line => console.log(line));
                        }
                        else {
                            console.log('The collective has learned new magik!');
                        }
                    }
                    else {
                        console.log('The collective has learned new magik!');
                    }
                    console.log('⚡ Syncing new capabilities to your local clone...');
                    console.log('');
                    console.log(successGradient('✓') + ' Your existing .genie will be backed up automatically');
                    console.log(successGradient('✓') + ' All data stays local - nothing leaves your machine');
                    console.log('');
                    // Interactive if TTY available, otherwise use --yes
                    const initArgs = process.stdout.isTTY ? ['init'] : ['init', '--yes'];
                    (0, cli_utils_1.execGenie)(initArgs);
                    process.exit(0);
                }
            }
        }
        catch (error) {
            // Corrupted version.json - force init
            console.log(cosmicGradient('━'.repeat(60)));
            console.log(magicGradient('        🧞 ✨ VERSION FILE REPAIR NEEDED ✨ 🧞        '));
            console.log(cosmicGradient('━'.repeat(60)));
            console.log('');
            console.log('Version file is corrupted. Repairing...');
            console.log(successGradient('✓') + ' Your existing .genie will be backed up automatically');
            console.log('');
            // Interactive if TTY available, otherwise use --yes
            const initArgs = process.stdout.isTTY ? ['init'] : ['init', '--yes'];
            (0, cli_utils_1.execGenie)(initArgs);
            process.exit(0);
        }
    }
    // FIX for issue #237: Escape hatch - detect infinite loop scenario
    // If version is STILL mismatched after attempting init, don't loop infinitely
    // This can happen if init returns early (e.g., for 'old_genie' without --yes)
    if (fs_1.default.existsSync(versionPath)) {
        try {
            const versionData = JSON.parse(fs_1.default.readFileSync(versionPath, 'utf8'));
            const installedVersion = versionData.version;
            const currentVersion = packageJson.version;
            if (installedVersion !== currentVersion && shouldCheckVersion && !isNonBlockingCommand) {
                // ESCAPE HATCH: Version didn't update during the version check phase (only for blocking commands)
                // This means detectInstallType() triggered old_genie without init fully running
                console.log('');
                console.log(cosmicGradient('━'.repeat(60)));
                console.log(magicGradient('   🧞 ✨ LOOPHOLE DETECTED & CLOSED ✨ 🧞   '));
                console.log(cosmicGradient('━'.repeat(60)));
                console.log('');
                console.log('⚠️  Version file did not update after init!');
                console.log(`   Expected: ${currentVersion}`);
                console.log(`   Got:      ${installedVersion}`);
                console.log('');
                console.log('This usually means init returned early (old_genie detection).');
                console.log('The fix has been applied - please try again.');
                console.log('');
                process.exit(1);
            }
        }
        catch (error) {
            // If version check fails here, safe to continue
        }
    }
}
// Extract global options manually before routing
const hasDebugFlag = args.includes('--debug');
// If no command was provided, use smart router
if (!args.length || (args.length === 1 && hasDebugFlag)) {
    // No command (or only --debug flag) → call smartRouter()
    // Pass debug flag explicitly since program.parse() hasn't been called yet
    (0, router_1.smartRouter)(packageJson.version, hasDebugFlag, server_manager_1.startGenieServer);
}
else {
    // Command provided → parse with commander
    program.parse(process.argv);
}
