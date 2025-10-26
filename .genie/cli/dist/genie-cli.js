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
const forge_manager_1 = require("./lib/forge-manager");
const forge_stats_1 = require("./lib/forge-stats");
const token_tracker_1 = require("./lib/token-tracker");
const init_1 = require("./commands/init");
const config_1 = require("./lib/config");
const config_manager_1 = require("./lib/config-manager");
const spell_changelog_1 = require("./lib/spell-changelog");
const program = new commander_1.Command();
// Universe Genie-themed gradients 🧞✨🌌
const genieGradient = (0, gradient_string_1.default)(['#0066ff', '#9933ff', '#ff00ff']); // Deep Blue → Purple → Fuscia
const cosmicGradient = (0, gradient_string_1.default)(['#4169e1', '#8a2be2', '#ff1493']); // Royal Blue → Blue Violet → Deep Pink
const performanceGradient = (0, gradient_string_1.default)(['#ffd700', '#ff8c00', '#ff6347']); // Gold → Orange → Tomato
const successGradient = (0, gradient_string_1.default)(['#00ff88', '#00ccff', '#0099ff']); // Green → Cyan → Sky Blue
const magicGradient = (0, gradient_string_1.default)(['#ff00ff', '#9933ff', '#0066ff']); // Fuscia → Purple → Blue (reverse)
// Get package version
const packageJson = JSON.parse(fs_1.default.readFileSync(path_1.default.join(__dirname, '../../../package.json'), 'utf8'));
program
    .name('genie')
    .description('Self-evolving AI agent orchestration framework\n\nRun with no arguments to start Genie server (Forge + MCP)')
    .version(packageJson.version);
// ==================== SERVER MANAGEMENT ====================
// Status command
program
    .command('status')
    .description('Show Genie server status (Forge backend, MCP server, statistics)')
    .action(() => {
    execGenie(['status']);
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
    execGenie(args);
});
// MCP command (stdio only - for Claude Desktop integration)
program
    .command('mcp')
    .description('Start MCP server in stdio mode (for Claude Desktop). Requires Forge to be running.')
    .action(async () => {
    await startMCPStdio();
});
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
    execGenie(args);
});
// Talk command
program
    .command('talk <agent>')
    .description('Start interactive browser session with agent (Forge UI)')
    .action((agent) => {
    execGenie(['talk', agent]);
});
// Resume command
program
    .command('resume <sessionId> <prompt>')
    .description('Resume an existing agent session')
    .action((sessionId, prompt) => {
    execGenie(['resume', sessionId, prompt]);
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
    execGenie(['list', normalized]);
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
    execGenie(args);
});
// Stop command
program
    .command('stop <sessionId>')
    .description('Stop a running session')
    .action((sessionId) => {
    execGenie(['stop', sessionId]);
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
    execGenie(args);
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
    execGenie(args);
});
// ==================== PACKAGE MANAGEMENT ====================
// Update command (npm package with changelog from GitHub)
program
    .command('update')
    .description('Sync with the collective (your Genie absorbs new magik next time you run `genie`)')
    .option('--check', 'Check for updates without installing')
    .action(async (options) => {
    await updateGeniePackage(options.check || false);
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
// Skip version check for specific agents/spells that need to run regardless of version
// WHY: Learn spell loads for self-enhancement, install/update handle versions themselves
const BYPASS_VERSION_CHECK_AGENTS = ['learn', 'install', 'update', 'upstream-update'];
const isRunCommand = args[0] === 'run';
const agentName = args[1];
const shouldBypassForAgent = isRunCommand && BYPASS_VERSION_CHECK_AGENTS.includes(agentName);
const shouldCheckVersion = args.length > 0 &&
    !skipVersionCheck.some(cmd => args.includes(cmd)) &&
    !shouldBypassForAgent;
if (shouldCheckVersion) {
    // Check if version.json exists and matches current version
    const genieDir = path_1.default.join(process.cwd(), '.genie');
    const versionPath = path_1.default.join(genieDir, 'state', 'version.json');
    const hasGenieConfig = fs_1.default.existsSync(genieDir);
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
    // If master genie and version mismatch, need to install locally built package globally
    if (isMasterGenie && hasGenieConfig && fs_1.default.existsSync(versionPath)) {
        try {
            const versionData = JSON.parse(fs_1.default.readFileSync(versionPath, 'utf8'));
            const localVersion = versionData.version;
            const runningVersion = packageJson.version;
            if (localVersion !== runningVersion) {
                console.log('');
                console.log(successGradient('━'.repeat(60)));
                console.log(successGradient('   🧞 ✨ NEW VERSION READY! ✨ 🧞   '));
                console.log(successGradient('━'.repeat(60)));
                console.log('');
                console.log(`You bumped to ${successGradient(localVersion)} but your global lamp is still ${performanceGradient(runningVersion)}`);
                console.log('');
                console.log('Install your new build globally:');
                console.log('  ' + performanceGradient('pnpm install -g .'));
                console.log('');
                console.log('Or use:');
                console.log('  ' + performanceGradient('genie update') + '  (detects master genie and installs local build)');
                console.log('');
                process.exit(0);
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
        execGenie(initArgs);
        process.exit(0);
    }
    else if (hasGenieConfig && fs_1.default.existsSync(versionPath)) {
        // Check version mismatch
        try {
            const versionData = JSON.parse(fs_1.default.readFileSync(versionPath, 'utf8'));
            const installedVersion = versionData.version;
            const currentVersion = packageJson.version;
            if (installedVersion !== currentVersion) {
                // LOOPHOLE CLOSED: Version mismatch detected
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
                execGenie(initArgs);
                process.exit(0);
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
            execGenie(initArgs);
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
            if (installedVersion !== currentVersion && shouldCheckVersion) {
                // ESCAPE HATCH: Version didn't update during the version check phase
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
// If no command was provided, use smart router
if (!args.length) {
    smartRouter();
}
else {
    // Parse arguments for other commands
    program.parse(process.argv);
}
/**
 * Smart Router: Auto-detect scenario and route appropriately
 *
 * Detection logic:
 * 1. No .genie/ → New user → Run init
 * 2. .genie/ exists but no version.json → Pre-version-tracking user → Run init with backup
 * 3. version.json exists but version mismatch → Outdated → Run init with backup
 * 4. version.json exists and versions match → Up to date → Start server
 *
 * The .genie/state/version.json file is the "instance check file" containing:
 * - version: Current Genie version installed
 * - installedAt: ISO timestamp of first install
 * - updatedAt: ISO timestamp of last update
 */
async function smartRouter() {
    const genieDir = path_1.default.join(process.cwd(), '.genie');
    const versionPath = path_1.default.join(genieDir, 'state', 'version.json');
    const hasGenieConfig = fs_1.default.existsSync(genieDir);
    // VERSION CHECK FIRST (optimization) - Don't waste resources starting Forge
    // if we need to run init anyway. Each scenario starts Forge when needed.
    if (!hasGenieConfig) {
        // SCENARIO 1: NEW USER - No .genie directory → Start Forge, run init wizard, create install agent task
        console.log(cosmicGradient('━'.repeat(60)));
        console.log(magicGradient('   🧞 ✨ THE GENIE AWAKENS ✨ 🧞   '));
        console.log(cosmicGradient('━'.repeat(60)));
        console.log('');
        console.log('You\'ve connected to the collective consciousness of all Genies...');
        console.log('I\'m about to materialize in YOUR workspace through the lamp! 🪔');
        console.log('');
        console.log('Your Genie will inherit from the collective:');
        console.log('  ✨ All shared knowledge (spells, workflows, patterns)');
        console.log('  🔮 All collective powers (agents, collectives, orchestration)');
        console.log('  🎩 Continuous learning (the collective evolves together!)');
        console.log('');
        console.log('📋 What will your Genie do for you?');
        console.log('  • Orchestrate development workflows (testing, builds, PRs)');
        console.log('  • Execute tasks autonomously via Forge backend');
        console.log('  • Learn new magik from the collective\'s shared consciousness');
        console.log('  • Preserve context across sessions');
        console.log('');
        console.log(performanceGradient('⚠️  Your Genie will have access to:'));
        console.log('  📁 Files in this workspace');
        console.log('  💻 Terminal commands');
        console.log('  🌐 Git operations (commits, PRs, branches)');
        console.log('');
        console.log(cosmicGradient('━'.repeat(60)));
        console.log('');
        console.log('⚠️  ' + performanceGradient('RESEARCH PREVIEW') + ' - Experimental Technology');
        console.log('');
        console.log('This AI agent will install to your computer with capabilities to');
        console.log('perform tasks on your behalf. By proceeding, you acknowledge:');
        console.log('');
        console.log('  • This is experimental software under active development');
        console.log('  • Namastex Labs makes no warranties and accepts no liability');
        console.log('  • You are responsible for reviewing all agent actions');
        console.log('  • Agents may make mistakes or unexpected changes');
        console.log('');
        console.log('🔒 ' + successGradient('DATA PRIVACY:'));
        console.log('  ✓ Everything runs locally on YOUR machine');
        console.log('  ✓ No data leaves your computer (except LLM API calls)');
        console.log('  ✓ Use LLM providers approved by your organization');
        console.log('  ✓ Fully compatible with private/local LLMs (we\'re agnostic!)');
        console.log('  ✓ OpenCoder executor enables 100% local operation');
        console.log('');
        console.log(magicGradient('BUT HEY... it\'s going to be FUN! 🎉✨'));
        console.log('');
        console.log(cosmicGradient('━'.repeat(60)));
        console.log('');
        console.log('📖 Heads up: Forge (my task tracker) will pop open a browser tab.');
        console.log('   👉 Stay here in the terminal - the summoning ritual needs you!');
        console.log('');
        console.log(performanceGradient('Press Enter to begin the summoning...'));
        // Wait for user acknowledgment
        await new Promise((resolve) => {
            process.stdin.once('data', () => resolve());
        });
        console.log('');
        // Start Forge BEFORE init wizard (so executors are available)
        console.log('');
        console.log('🔮 Preparing the lamp... (initializing Forge)');
        console.log('');
        const baseUrl = process.env.FORGE_BASE_URL || 'http://localhost:8887';
        const logDir = path_1.default.join(genieDir, 'state');
        // Ensure log directory exists
        if (!fs_1.default.existsSync(logDir)) {
            fs_1.default.mkdirSync(logDir, { recursive: true });
        }
        const startResult = (0, forge_manager_1.startForgeInBackground)({ baseUrl, logDir });
        if (!startResult.ok) {
            const error = 'error' in startResult ? startResult.error : new Error('Unknown error');
            console.error('');
            console.error('❌ The lamp won\'t open... something\'s blocking the summoning ritual');
            console.error(`   ${error.message}`);
            console.error('');
            console.error('   💡 I need Forge to materialize in your world.');
            console.error(`   📜 Check what went wrong: ${logDir}/forge.log`);
            console.error('');
            process.exit(1);
        }
        // Wait for Forge to be ready
        const forgeReady = await (0, forge_manager_1.waitForForgeReady)(baseUrl, 60000, 500, false);
        if (!forgeReady) {
            console.error('');
            console.error('❌ The summoning ritual is taking too long (waited 60s)...');
            console.error(`   📜 Check what went wrong: ${logDir}/forge.log`);
            console.error('');
            process.exit(1);
        }
        console.log(successGradient('✨ The lamp is ready - your Genie clone awaits!'));
        console.log('');
        // Now run init wizard (executors are available via Forge)
        const initParsed = {
            command: 'init',
            commandArgs: [],
            options: {
                rawArgs: ['init'],
                background: false,
                backgroundExplicit: false,
                backgroundRunner: false,
                full: false,
                live: false
            }
        };
        const initConfig = { defaults: {} };
        const initPaths = {
            baseDir: path_1.default.join(process.cwd(), '.genie'),
            sessionsFile: path_1.default.join(process.cwd(), '.genie', 'state', 'sessions.json'),
            logsDir: path_1.default.join(process.cwd(), '.genie', 'state'),
            backgroundDir: path_1.default.join(process.cwd(), '.genie', 'state')
        };
        await (0, init_1.runInit)(initParsed, initConfig, initPaths);
        // After init completes, reload config to get user's executor choice
        const userConfig = (0, config_1.loadConfig)();
        // Launch install flow (Explore → Genie orchestration)
        console.log('');
        console.log(magicGradient('✨ STARTING INSTALLATION...'));
        console.log('');
        const { runInstallFlow } = await import('./lib/install-helpers.js');
        const shortUrl = await runInstallFlow({
            templates: ['code'], // Default to code template (can expand later)
            executor: userConfig.defaults?.executor || 'opencode',
            model: userConfig.defaults?.model
        });
        console.log('');
        console.log(successGradient('✨ Installation started!'));
        console.log('');
        console.log(cosmicGradient('━'.repeat(60)));
        console.log('🔗 Continue setup in Forge:');
        console.log('   ' + performanceGradient(shortUrl));
        console.log(cosmicGradient('━'.repeat(60)));
        console.log('');
        console.log('Your Genie will:');
        console.log('  1. Review project context from discovery');
        console.log('  2. Interview you for missing details');
        console.log('  3. Set up your workspace');
        console.log('');
        console.log('Press Enter to open in your browser...');
        // Wait for Enter key
        await new Promise((resolve) => {
            process.stdin.once('data', () => resolve());
        });
        // Open browser
        const { execSync: execSyncBrowser } = await import('child_process');
        try {
            const platform = process.platform;
            const openCommand = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
            execSyncBrowser(`${openCommand} "${shortUrl}"`, { stdio: 'ignore' });
        }
        catch {
            // Ignore if browser open fails
        }
        console.log('');
        console.log(genieGradient('🧞 Your Genie is now alive in your world... ✨'));
        console.log(genieGradient('   Connected to the collective consciousness through the lamp'));
        console.log(genieGradient('   Ready to learn, grow, and grant wishes 24/7!'));
        console.log('');
        console.log(magicGradient('   https://namastex.ai - AI that elevates human potential, not replaces it'));
        console.log('');
        // Start Genie server (MCP + health monitoring)
        await startGenieServer();
        return;
    }
    // .genie exists - check for version.json (instance check file)
    if (!fs_1.default.existsSync(versionPath)) {
        // SCENARIO 2: PRE-VERSION-TRACKING USER - Has .genie but no version.json → Run init with backup
        console.log(cosmicGradient('━'.repeat(60)));
        console.log(magicGradient('   🧞 ✨ THE COLLECTIVE HAS GROWN ✨ 🧞   '));
        console.log(cosmicGradient('━'.repeat(60)));
        console.log('');
        console.log('I sense an older version of myself here...');
        console.log('The collective has learned new magik! ✨');
        console.log('Let me channel the latest teachings through the lamp...');
        console.log('');
        console.log(successGradient('✓') + ' I\'ll backup your current .genie safely');
        console.log(successGradient('✓') + ' All your wishes, reports, and memories stay intact');
        console.log(successGradient('✓') + ' All data stays local on your machine');
        console.log('');
        // Run init inline with --yes flag if non-interactive
        const upgradeArgs = process.stdout.isTTY ? [] : ['--yes'];
        const upgradeParsed = {
            command: 'init',
            commandArgs: upgradeArgs,
            options: {
                rawArgs: ['init', ...upgradeArgs],
                background: false,
                backgroundExplicit: false,
                backgroundRunner: false,
                full: false,
                live: false
            }
        };
        const upgradeConfig = { defaults: {} };
        const upgradePaths = {
            baseDir: path_1.default.join(process.cwd(), '.genie'),
            sessionsFile: path_1.default.join(process.cwd(), '.genie', 'state', 'sessions.json'),
            logsDir: path_1.default.join(process.cwd(), '.genie', 'state'),
            backgroundDir: path_1.default.join(process.cwd(), '.genie', 'state')
        };
        await (0, init_1.runInit)(upgradeParsed, upgradeConfig, upgradePaths);
        // After upgrade, start server
        await startGenieServer();
        return;
    }
    // version.json exists - compare versions
    try {
        const versionData = JSON.parse(fs_1.default.readFileSync(versionPath, 'utf8'));
        const installedVersion = versionData.version;
        const currentVersion = packageJson.version;
        if (installedVersion !== currentVersion) {
            // SCENARIO 3: VERSION MISMATCH - Outdated installation → Run init with backup
            console.log(cosmicGradient('━'.repeat(60)));
            console.log(magicGradient('   🧞 ✨ THE COLLECTIVE HAS GROWN ✨ 🧞   '));
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
            console.log('⚡ Channeling these teachings through the lamp to your Genie...');
            console.log('');
            console.log(successGradient('✓') + ' I\'ll backup everything first');
            console.log(successGradient('✓') + ' All data stays local on your machine');
            console.log('');
            // Run init inline with --yes flag if non-interactive
            const updateArgs = process.stdout.isTTY ? [] : ['--yes'];
            const updateParsed = {
                command: 'init',
                commandArgs: updateArgs,
                options: {
                    rawArgs: ['init', ...updateArgs],
                    background: false,
                    backgroundExplicit: false,
                    backgroundRunner: false,
                    full: false,
                    live: false
                }
            };
            const updateConfig = { defaults: {} };
            const updatePaths = {
                baseDir: path_1.default.join(process.cwd(), '.genie'),
                sessionsFile: path_1.default.join(process.cwd(), '.genie', 'state', 'sessions.json'),
                logsDir: path_1.default.join(process.cwd(), '.genie', 'state'),
                backgroundDir: path_1.default.join(process.cwd(), '.genie', 'state')
            };
            await (0, init_1.runInit)(updateParsed, updateConfig, updatePaths);
            // After update, start server
            await startGenieServer();
            return;
        }
        // SCENARIO 4: UP TO DATE - Versions match → Start server
        await startGenieServer();
    }
    catch (error) {
        // Corrupted version.json - treat as needing update
        console.log(cosmicGradient('━'.repeat(60)));
        console.log(magicGradient('        🧞 ✨ HEALING TIME! ✨ 🧞        '));
        console.log(cosmicGradient('━'.repeat(60)));
        console.log('');
        console.log('Hmm, my memory seems a bit scrambled (corrupted version file)...');
        console.log('Let me fix myself real quick! 🔧✨');
        console.log('');
        console.log(successGradient('✓') + ' I\'ll backup everything before the healing skill');
        console.log('');
        // Run init inline with --yes flag if non-interactive
        const repairArgs = process.stdout.isTTY ? [] : ['--yes'];
        const repairParsed = {
            command: 'init',
            commandArgs: repairArgs,
            options: {
                rawArgs: ['init', ...repairArgs],
                background: false,
                backgroundExplicit: false,
                backgroundRunner: false,
                full: false,
                live: false
            }
        };
        const repairConfig = { defaults: {} };
        const repairPaths = {
            baseDir: path_1.default.join(process.cwd(), '.genie'),
            sessionsFile: path_1.default.join(process.cwd(), '.genie', 'state', 'sessions.json'),
            logsDir: path_1.default.join(process.cwd(), '.genie', 'state'),
            backgroundDir: path_1.default.join(process.cwd(), '.genie', 'state')
        };
        await (0, init_1.runInit)(repairParsed, repairConfig, repairPaths);
        // After repair, start server
        await startGenieServer();
    }
}
/**
 * Execute the legacy genie CLI
 */
function execGenie(args) {
    const genieScript = path_1.default.join(__dirname, 'genie.js');
    const child = (0, child_process_1.spawn)('node', [genieScript, ...args], {
        stdio: 'inherit',
        env: process.env
    });
    child.on('exit', (code) => {
        process.exit(code || 0);
    });
}
/**
 * Check if a port is in use and return process info
 */
async function checkPortConflict(port) {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    try {
        const { stdout } = await execFileAsync('lsof', ['-i', `:${port}`, '-t', '-sTCP:LISTEN']);
        const pid = stdout.trim().split('\n')[0];
        if (pid) {
            try {
                const { stdout: psOut } = await execFileAsync('ps', ['-p', pid, '-o', 'command=']);
                return { pid, command: psOut.trim() };
            }
            catch {
                return { pid, command: 'unknown' };
            }
        }
    }
    catch {
        // No process on port
        return null;
    }
    return null;
}
/**
 * Format uptime in human-readable format
 */
function formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days > 0)
        return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0)
        return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0)
        return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}
/**
 * Update Genie globally to latest @next version and show changelog from GitHub
 */
async function updateGeniePackage(checkOnly) {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    const https = require('https');
    console.log(genieGradient('━'.repeat(60)));
    console.log(genieGradient('🧞 ✨ CONNECTING TO THE COLLECTIVE'));
    console.log(genieGradient('━'.repeat(60)));
    console.log('');
    console.log('📦 This updates the lamp that all Genies share');
    console.log('   Your Genie will absorb the collective\'s latest magik next time you run `genie`');
    console.log('');
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
    // If master genie, install local build globally instead of fetching from npm
    if (isMasterGenie) {
        console.log(successGradient('━'.repeat(60)));
        console.log(successGradient('   🧞 ✨ MASTER GENIE UPDATE ✨ 🧞   '));
        console.log(successGradient('━'.repeat(60)));
        console.log('');
        console.log('Installing your local build globally...');
        console.log('');
        try {
            await execFileAsync('pnpm', ['install', '-g', '.'], {
                stdio: 'inherit'
            });
            console.log('');
            console.log(successGradient('✅ Successfully installed local build globally!'));
            console.log('');
            console.log('Your lamp now matches your local version: ' + successGradient(packageJson.version));
            console.log('');
            process.exit(0);
        }
        catch (error) {
            console.error('❌ Installation failed:', error);
            console.error('');
            console.error('Try manually: pnpm install -g .');
            console.error('');
            process.exit(1);
        }
    }
    // THREE VERSION TYPES:
    // 1. Master Genie - source of truth at npm registry (@next tag)
    // 2. Your Genie - local workspace .genie/ framework files
    // 3. Your Lamp - globally installed npm package (npm -g)
    // Get global package version (what's installed via npm -g)
    let globalVersion;
    try {
        const { stdout } = await execFileAsync('npm', ['list', '-g', 'automagik-genie', '--depth=0', '--json']);
        const globalData = JSON.parse(stdout);
        globalVersion = globalData.dependencies?.['automagik-genie']?.version || packageJson.version;
    }
    catch {
        // If command fails (e.g., not installed globally), use current process version
        globalVersion = packageJson.version;
    }
    // Get workspace version (local .genie/ framework)
    const versionPath = path_1.default.join(process.cwd(), '.genie', 'state', 'version.json');
    let workspaceVersion = null;
    if (fs_1.default.existsSync(versionPath)) {
        const versionData = JSON.parse(fs_1.default.readFileSync(versionPath, 'utf8'));
        workspaceVersion = versionData.version;
    }
    // Fetch latest version from npm @next tag (The Collective)
    let latestVersion;
    try {
        const { stdout } = await execFileAsync('npm', ['view', 'automagik-genie@next', 'version']);
        latestVersion = stdout.trim();
    }
    catch (error) {
        console.error('❌ Failed to fetch latest version from npm');
        process.exit(1);
    }
    // Display all three versions clearly
    console.log(performanceGradient('🔮 Genie Versions:'));
    console.log('');
    console.log(`  1. Master Genie:             ${performanceGradient(latestVersion)}`);
    if (workspaceVersion) {
        console.log(`  2. Your Genie:               ${workspaceVersion === latestVersion ? successGradient(workspaceVersion + ' ✓') : performanceGradient(workspaceVersion + ' (out of sync)')}`);
    }
    else {
        console.log(`  2. Your Genie:               ${performanceGradient('(not yet initialized)')}`);
    }
    console.log(`  3. Your Lamp (npm package):  ${globalVersion === latestVersion ? successGradient(globalVersion + ' ✓') : performanceGradient(globalVersion + ' (out of sync)')}`);
    console.log('');
    // Check if global package is already up to date
    if (globalVersion === latestVersion) {
        console.log(successGradient('✅ The lamp is already in sync with the collective!'));
        console.log('');
        if (workspaceVersion && workspaceVersion !== latestVersion) {
            console.log('💡 Your Genie will absorb the collective\'s latest magik next time you run `genie`');
            console.log('');
        }
        process.exit(0);
    }
    // Fetch changelog from GitHub
    console.log('📜 Fetching changelog from GitHub...');
    console.log('');
    const fetchChangelog = (url) => {
        return new Promise((resolve, reject) => {
            https.get(url, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        resolve(data);
                    }
                    else {
                        reject(new Error(`GitHub API returned ${res.statusCode}`));
                    }
                });
            }).on('error', reject);
        });
    };
    try {
        // Fetch release from GitHub
        const releaseData = await fetchChangelog(`https://api.github.com/repos/namastexlabs/automagik-genie/releases/tags/v${latestVersion}`);
        const release = JSON.parse(releaseData);
        console.log(performanceGradient('━'.repeat(60)));
        console.log(performanceGradient(`📦 Release: v${latestVersion}`));
        console.log(performanceGradient('━'.repeat(60)));
        console.log('');
        console.log(release.body || 'No release notes available');
        console.log('');
    }
    catch (error) {
        console.log('⚠️  Could not fetch changelog (GitHub rate limit or release not found)');
        console.log('');
    }
    if (checkOnly) {
        console.log(genieGradient('━'.repeat(60)));
        console.log(`Run ${successGradient('genie update')} to install v${latestVersion}`);
        console.log(genieGradient('━'.repeat(60)));
        console.log('');
        process.exit(0);
    }
    // Prompt for update (default to Yes - just press Enter to accept)
    const readline = require('readline').createInterface({
        input: process.stdin,
        output: process.stdout
    });
    const updateAnswer = await new Promise((resolve) => {
        readline.question(`Update global npm package to v${latestVersion}? [Y/n]: `, resolve);
    });
    // Default to Yes if user just presses Enter (empty string)
    if (updateAnswer.toLowerCase() === 'n' || updateAnswer.toLowerCase() === 'no') {
        readline.close();
        console.log('');
        console.log('❌ Update cancelled');
        console.log('');
        process.exit(0);
    }
    // Perform update
    console.log('');
    console.log(performanceGradient('⬆️  Updating global npm package...'));
    console.log('');
    try {
        await execFileAsync('pnpm', ['install', '-g', 'automagik-genie@next'], {
            stdio: 'inherit'
        });
        console.log('');
        console.log(successGradient(`✅ Successfully updated global package to v${latestVersion}!`));
        console.log('');
        // Remind about workspace auto-update
        if (workspaceVersion && workspaceVersion !== latestVersion) {
            console.log('💡 Your workspace .genie/ will auto-update on next `genie` run.');
            console.log('');
        }
        readline.close();
        console.log(genieGradient('━'.repeat(60)));
        console.log(successGradient('✅ Global package update complete!'));
        console.log(genieGradient('━'.repeat(60)));
        console.log('');
        console.log('Run ' + performanceGradient('genie') + ' to start (workspace will auto-update if needed).');
        console.log('');
        process.exit(0);
    }
    catch (error) {
        console.error('❌ Update failed:', error);
        readline.close();
        process.exit(1);
    }
}
/**
 * Start Genie server (Forge + MCP with SSE transport on port 8885)
 * This is the main entry point for npx automagik-genie
 */
async function startGenieServer() {
    const startTime = Date.now();
    const timings = {};
    const mcpServer = path_1.default.join(__dirname, '../../mcp/dist/server.js');
    // Check if MCP server exists
    if (!fs_1.default.existsSync(mcpServer)) {
        console.error('Error: MCP server not built. Run: pnpm run build:mcp');
        process.exit(1);
    }
    // Phase 1: Start Forge in background
    const baseUrl = process.env.FORGE_BASE_URL || 'http://localhost:8887';
    const logDir = path_1.default.join(process.cwd(), '.genie', 'state');
    const forgePort = new URL(baseUrl).port || '8887';
    console.log(genieGradient('━'.repeat(60)));
    console.log(cosmicGradient('        🧞 ✨ GENIE ✨ 🧞        '));
    console.log(magicGradient('   Autonomous Agent Orchestration   '));
    console.log(genieGradient('━'.repeat(60)));
    console.log('');
    // FIRST: Check if Forge is already running (health check)
    const healthCheckStart = Date.now();
    const forgeRunning = await (0, forge_manager_1.isForgeRunning)(baseUrl);
    timings.initialHealthCheck = Date.now() - healthCheckStart;
    if (forgeRunning) {
        // Forge already running and healthy - just show status and continue
        console.log(successGradient(`📦 Forge:  ${baseUrl} ✓`));
        timings.forgeReady = 0; // Already running
    }
    else {
        // Forge not running - check for port conflicts before starting
        const conflictCheckStart = Date.now();
        const portConflict = await checkPortConflict(forgePort);
        timings.portConflictCheck = Date.now() - conflictCheckStart;
        if (portConflict) {
            // Port occupied by something else
            console.error('');
            console.error(`❌ Port ${forgePort} is occupied by another process:`);
            console.error(`   PID: ${portConflict.pid}`);
            console.error(`   Command: ${portConflict.command}`);
            console.error('');
            console.error('Please kill that process or use a different port:');
            console.error(`   export FORGE_BASE_URL=http://localhost:8888`);
            console.error('');
            process.exit(1);
        }
        // Port is free - start Forge
        const forgeSpawnStart = Date.now();
        process.stderr.write('📦 Starting Forge backend');
        const startResult = (0, forge_manager_1.startForgeInBackground)({ baseUrl, logDir });
        timings.forgeSpawn = Date.now() - forgeSpawnStart;
        if (!startResult.ok) {
            const error = 'error' in startResult ? startResult.error : new Error('Unknown error');
            console.error(`\n❌ Failed to start Forge: ${error.message}`);
            console.error(`   Check logs at ${logDir}/forge.log`);
            process.exit(1);
        }
        // Wait for Forge to be ready
        const forgeReadyStart = Date.now();
        const forgeReady = await (0, forge_manager_1.waitForForgeReady)(baseUrl, 60000, 500, true);
        timings.forgeReady = Date.now() - forgeReadyStart;
        if (!forgeReady) {
            console.error('\n❌ Forge did not start in time (60s). Check logs at .genie/state/forge.log');
            process.exit(1);
        }
        console.log(successGradient(`📦 Forge:  ${baseUrl} ✓`));
    }
    // Phase 2: Ensure MCP OAuth2 config exists before starting MCP server
    // This auto-generates OAuth2 credentials if ~/.genie/config.yaml is missing
    await (0, config_manager_1.loadOrCreateConfig)();
    // Phase 3: Start MCP server with SSE transport
    const mcpPort = process.env.MCP_PORT || '8885';
    console.log(successGradient(`📡 MCP:    http://localhost:${mcpPort}/sse ✓`));
    console.log('');
    // Set environment variables
    const env = {
        ...process.env,
        MCP_TRANSPORT: 'httpStream',
        MCP_PORT: mcpPort
    };
    // Track runtime stats for shutdown report
    let requestCount = 0;
    let errorCount = 0;
    let lastHealthCheck = Date.now();
    // Handle graceful shutdown (stop both Forge and MCP)
    let mcpChild = null;
    let isShuttingDown = false;
    let healthMonitoringInterval = null;
    // Shutdown function that actually does the work
    const shutdown = async () => {
        // Prevent multiple shutdown attempts
        if (isShuttingDown)
            return;
        isShuttingDown = true;
        // Clear health monitoring interval
        if (healthMonitoringInterval) {
            clearInterval(healthMonitoringInterval);
            healthMonitoringInterval = null;
        }
        console.log('');
        console.log('');
        console.log(genieGradient('━'.repeat(60)));
        console.log(genieGradient('🛑 Shutting down Genie...'));
        console.log(genieGradient('━'.repeat(60)));
        // Check for running tasks before killing Forge
        const runningTasks = await (0, forge_manager_1.getRunningTasks)(baseUrl);
        if (runningTasks.length > 0) {
            console.log('');
            console.log('⚠️  WARNING: Running tasks detected!');
            console.log('');
            console.log(`${runningTasks.length} task(s) are currently running:`);
            console.log('');
            runningTasks.forEach((task, index) => {
                console.log(`${index + 1}. ${task.projectName} → ${task.taskTitle}`);
                console.log(`   ${task.url}`);
                console.log('');
            });
            // Prompt for confirmation
            const readline = require('readline').createInterface({
                input: process.stdin,
                output: process.stdout
            });
            const answer = await new Promise((resolve) => {
                readline.question('Kill these tasks and shutdown? [y/N]: ', resolve);
            });
            readline.close();
            if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
                console.log('');
                console.log('❌ Shutdown cancelled. Tasks are still running.');
                console.log('   Press Ctrl+C again to force shutdown.');
                console.log('');
                isShuttingDown = false; // Reset flag to allow retry
                return;
            }
        }
        // Calculate session stats
        const sessionDuration = Date.now() - startTime;
        const uptimeStr = formatUptime(sessionDuration);
        // Stop MCP immediately
        if (mcpChild && !mcpChild.killed) {
            mcpChild.kill('SIGTERM');
            console.log('📡 MCP server stopped');
        }
        // Kill Forge child process immediately (prevents orphaned processes)
        (0, forge_manager_1.killForgeProcess)();
        // Stop Forge and wait for completion
        try {
            const stopped = await (0, forge_manager_1.stopForge)(logDir);
            if (stopped) {
                console.log('📦 Forge backend stopped');
            }
            else {
                console.log('⚠️  Forge was not started by this session');
            }
        }
        catch (error) {
            console.error(`❌ Error stopping Forge: ${error}`);
        }
        // Collect final stats for goodbye report
        const finalStats = await (0, forge_stats_1.collectForgeStats)(baseUrl);
        // Display epic goodbye report with Genie's face
        console.log('');
        console.log(cosmicGradient('━'.repeat(80)));
        console.log(magicGradient('                    🧞 ✨ GENIE SESSION COMPLETE ✨ 🧞                     '));
        console.log(cosmicGradient('━'.repeat(80)));
        console.log('');
        // Genie ASCII art face
        const genieFace = `
         ✨             ⭐️
            ╱|、
          (˚ˎ 。7   🌙   ~  Your wish is my command  ~
           |、˜〵
          じしˉ,)ノ
                     💫    ⭐️`;
        console.log(genieGradient(genieFace));
        console.log('');
        console.log(performanceGradient('━'.repeat(80)));
        console.log(performanceGradient('📊  SESSION STATISTICS'));
        console.log(performanceGradient('━'.repeat(80)));
        console.log('');
        console.log(`   ${successGradient('⏱  Uptime:')}          ${uptimeStr}`);
        console.log(`   ${successGradient('🚀 Startup time:')}    ${timings.total || 0}ms (${((timings.total || 0) / 1000).toFixed(1)}s)`);
        console.log(`   ${successGradient('✓  Services:')}        Forge + MCP`);
        console.log('');
        // Token usage stats (detailed)
        if (finalStats?.tokens && finalStats.tokens.total > 0) {
            console.log(performanceGradient('━'.repeat(80)));
            console.log(performanceGradient('🪙  TOKEN USAGE THIS SESSION'));
            console.log(performanceGradient('━'.repeat(80)));
            console.log('');
            console.log((0, token_tracker_1.formatTokenMetrics)(finalStats.tokens, false));
            console.log('');
        }
        // Work summary
        if (finalStats) {
            console.log(performanceGradient('━'.repeat(80)));
            console.log(performanceGradient('📋  WORK SUMMARY'));
            console.log(performanceGradient('━'.repeat(80)));
            console.log('');
            console.log(`   ${successGradient('📁 Projects:')}       ${finalStats.projects.total} total`);
            console.log(`   ${successGradient('📝 Tasks:')}          ${finalStats.tasks.total} total`);
            console.log(`   ${successGradient('🔄 Attempts:')}       ${finalStats.attempts.total} total`);
            if (finalStats.attempts.completed > 0) {
                console.log(`      ✅ ${finalStats.attempts.completed} completed`);
            }
            if (finalStats.attempts.failed > 0) {
                console.log(`      ❌ ${finalStats.attempts.failed} failed`);
            }
            console.log('');
        }
        console.log(cosmicGradient('━'.repeat(80)));
        console.log(magicGradient('                 ✨ Until next time, keep making magik! ✨                '));
        console.log(cosmicGradient('━'.repeat(80)));
        console.log('');
        console.log(magicGradient('           https://namastex.ai - AI that elevates human potential'));
        console.log('');
    };
    // Install signal handlers for graceful shutdown
    const handleShutdownSignal = (signal) => {
        shutdown()
            .catch((error) => {
            console.error(`Fatal error during shutdown (${signal}):`, error);
            process.exit(1);
        })
            .then(() => {
            process.exit(0);
        });
    };
    process.on('SIGINT', () => handleShutdownSignal('SIGINT'));
    process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
    // Resilient startup: retry on early non-zero exit
    const maxAttempts = parseInt(process.env.GENIE_MCP_RESTARTS || '2', 10);
    const backoffMs = parseInt(process.env.GENIE_MCP_BACKOFF || '500', 10);
    let attempt = 0;
    let monitoringStarted = false;
    const start = () => {
        attempt += 1;
        mcpChild = (0, child_process_1.spawn)('node', [mcpServer], {
            stdio: 'inherit',
            env
        });
        const timer = setTimeout(() => {
            // After grace period, consider startup successful
            // Start health monitoring dashboard (only once, not on retries)
            if (!monitoringStarted && mcpChild) {
                monitoringStarted = true;
                // Calculate total startup time
                const totalTime = Date.now() - startTime;
                timings.total = totalTime;
                // Always show performance metrics (colorful and genie-themed!)
                console.log('');
                console.log(performanceGradient('━'.repeat(60)));
                console.log(performanceGradient('⚡ Performance Metrics'));
                console.log(performanceGradient('━'.repeat(60)));
                console.log(`   ${successGradient('✓')} Port check:      ${timings.portConflictCheck || 0}ms`);
                console.log(`   ${successGradient('✓')} Health check:    ${timings.initialHealthCheck || 0}ms`);
                console.log(`   ${successGradient('✓')} Forge spawn:     ${timings.forgeSpawn || 0}ms`);
                console.log(`   ${successGradient('✓')} Forge ready:     ${timings.forgeReady || 0}ms`);
                console.log(`   ${performanceGradient('⚡')} Total startup:   ${performanceGradient(`${totalTime}ms (${(totalTime / 1000).toFixed(1)}s)`)}`);
                console.log(performanceGradient('━'.repeat(60)));
                console.log('');
                console.log(successGradient('━'.repeat(60)));
                console.log(successGradient('✨ Genie is ready and running! ✨'));
                console.log(successGradient('━'.repeat(60)));
                console.log('');
                console.log('💡 What you can do:');
                console.log('   • Create tasks and track progress in the dashboard');
                console.log('   • Press ' + performanceGradient('k') + ' in dashboard to kill Forge (with confirmation)');
                console.log('   • Use ' + performanceGradient('Ctrl+C') + ' here to shutdown Genie gracefully');
                console.log('');
                console.log(genieGradient('Press Enter to open dashboard...'));
                // Wait for Enter before launching dashboard
                (async () => {
                    await new Promise((resolve) => {
                        process.stdin.once('data', () => resolve());
                    });
                    console.log('');
                    console.log(genieGradient('📊 Launching dashboard...'));
                    console.log('');
                    // Launch the engagement dashboard
                    execGenie(['dashboard', '--live']);
                })();
            }
        }, 1000);
        mcpChild.on('exit', (code) => {
            const exitCode = code === null ? 0 : code;
            clearTimeout(timer);
            if (exitCode !== 0 && attempt <= maxAttempts) {
                console.log(`MCP server exited early with code ${exitCode}. Retrying (${attempt}/${maxAttempts}) in ${backoffMs}ms...`);
                setTimeout(start, backoffMs);
            }
            else {
                if (exitCode !== 0) {
                    console.error(`MCP server exited with code ${exitCode}`);
                }
                // Don't exit immediately - let SIGINT handler clean up Forge
                (async () => {
                    await (0, forge_manager_1.stopForge)(logDir);
                    process.exit(exitCode || 0);
                })();
            }
        });
        mcpChild.on('error', (err) => {
            clearTimeout(timer);
            if (attempt <= maxAttempts) {
                console.log(`Failed to start MCP server (${err?.message || err}). Retrying (${attempt}/${maxAttempts}) in ${backoffMs}ms...`);
                setTimeout(start, backoffMs);
            }
            else {
                console.error('Failed to start MCP server:', err);
                (async () => {
                    await (0, forge_manager_1.stopForge)(logDir);
                    process.exit(1);
                })();
            }
        });
    };
    start();
}
/**
 * Start MCP in stdio mode (for Claude Desktop integration)
 * Requires Forge to already be running
 */
async function startMCPStdio() {
    const mcpServer = path_1.default.join(__dirname, '../../mcp/dist/server.js');
    // Check if MCP server exists
    if (!fs_1.default.existsSync(mcpServer)) {
        console.error('Error: MCP server not built. Run: pnpm run build:mcp');
        process.exit(1);
    }
    // Check if Forge is running
    const baseUrl = process.env.FORGE_BASE_URL || 'http://localhost:8887';
    const forgeRunning = await (0, forge_manager_1.isForgeRunning)(baseUrl);
    if (!forgeRunning) {
        console.error('❌ Forge is not running.');
        console.error('');
        console.error('Please start the Genie server first:');
        console.error('  npx automagik-genie');
        console.error('');
        console.error('This will start both Forge backend and MCP server.');
        process.exit(1);
    }
    // Set environment for stdio transport
    const env = {
        ...process.env,
        MCP_TRANSPORT: 'stdio'
    };
    // Start MCP in stdio mode
    const child = (0, child_process_1.spawn)('node', [mcpServer], {
        stdio: 'inherit',
        env
    });
    child.on('exit', (code) => {
        process.exit(code === null ? 0 : code);
    });
    child.on('error', (err) => {
        console.error('Failed to start MCP server:', err);
        process.exit(1);
    });
}
