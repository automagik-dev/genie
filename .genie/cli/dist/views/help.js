"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildHelpView = buildHelpView;
exports.buildSubcommandHelpView = buildSubcommandHelpView;
exports.buildRunHelpView = buildRunHelpView;
exports.buildResumeHelpView = buildResumeHelpView;
exports.buildListHelpView = buildListHelpView;
exports.buildViewHelpView = buildViewHelpView;
exports.buildStopHelpView = buildStopHelpView;
exports.buildGeneralHelpView = buildGeneralHelpView;
// Main help view
function buildHelpView(params) {
    const lines = [];
    lines.push('# GENIE CLI');
    lines.push('');
    lines.push('*Genie Template :: Command Palette Quickstart*');
    lines.push('');
    // Meta badges
    const badges = [
        params.backgroundDefault ? 'Background: detached default' : 'Background: attach by default',
        'Plan → Wish → Forge workflow',
        'Evidence-first outputs'
    ];
    lines.push(badges.map(b => `**${b}**`).join(' · '));
    lines.push('');
    // Usage
    lines.push('🧭 **Usage**');
    lines.push('');
    lines.push('Invoke commands with `genie <command> [options]`.');
    lines.push('');
    // Command table
    lines.push('## Command Palette');
    lines.push('');
    lines.push('| Command | Arguments | Description |');
    lines.push('|---------|-----------|-------------|');
    for (const row of params.commandRows) {
        lines.push(`| ${row.command} | ${row.args} | ${row.description} |`);
    }
    lines.push('');
    // Prompt framework
    lines.push(`ℹ️ **${params.promptFramework.title}**`);
    for (const bullet of params.promptFramework.bulletPoints) {
        lines.push(`• ${bullet}`);
    }
    lines.push('');
    // Examples
    lines.push('⚡ **Quick start examples**');
    for (const example of params.examples) {
        lines.push(`- ${example}`);
    }
    lines.push('');
    // Tips
    lines.push('💡 **Tips**');
    lines.push('- Watch sessions: `genie list sessions`.');
    lines.push('- Run an agent: `genie run <agent-id> "<prompt>"`.');
    return lines.join('\n');
}
// Helper function to build subcommand help views
function buildSubcommandHelpView(params) {
    const lines = [];
    lines.push(`# genie ${params.command}`);
    lines.push('');
    lines.push(`*${params.description}*`);
    lines.push('');
    // Usage
    lines.push('📖 **Usage**');
    lines.push('');
    lines.push(params.usage);
    lines.push('');
    // Arguments
    if (params.arguments && params.arguments.length > 0) {
        lines.push('## Arguments');
        lines.push('');
        lines.push('| Argument | Description | Required |');
        lines.push('|----------|-------------|----------|');
        for (const arg of params.arguments) {
            const required = arg.required !== false ? 'Yes' : 'No';
            lines.push(`| ${arg.name} | ${arg.description} | ${required} |`);
        }
        lines.push('');
    }
    // Options
    if (params.options && params.options.length > 0) {
        lines.push('## Options');
        lines.push('');
        lines.push('| Option | Description |');
        lines.push('|--------|-------------|');
        for (const opt of params.options) {
            lines.push(`| ${opt.flag} | ${opt.description} |`);
        }
        lines.push('');
    }
    // Examples
    if (params.examples && params.examples.length > 0) {
        lines.push('⚡ **Examples**');
        for (const example of params.examples) {
            lines.push(`- ${example}`);
        }
        lines.push('');
    }
    // Notes
    if (params.notes && params.notes.length > 0) {
        lines.push('💡 **Notes**');
        for (const note of params.notes) {
            lines.push(`- ${note}`);
        }
        lines.push('');
    }
    return lines.join('\n');
}
// Specific help views for each subcommand
function buildRunHelpView() {
    return buildSubcommandHelpView({
        command: 'run',
        description: 'Start or attach to an agent session',
        usage: 'genie run <agent> "<prompt>" [--help]',
        arguments: [
            { name: '<agent>', description: 'Agent identifier (from genie list agents)' },
            { name: '<prompt>', description: 'Initial prompt or task description' }
        ],
        options: [
            { flag: '--help, -h', description: 'Show this help message' }
        ],
        examples: [
            'genie run plan "[Discovery] mission @.genie/product/mission.md"',
            'genie run forge "Break down the approved wish into execution groups"',
            'genie run implementor "Implement the user authentication feature"'
        ],
        notes: [
            'Agents run in background mode by default (detached)',
            'Use quotes around prompts containing spaces or special characters',
            'Agent identifiers can be found with: genie list agents'
        ]
    });
}
function buildResumeHelpView() {
    return buildSubcommandHelpView({
        command: 'resume',
        description: 'Continue an existing agent session',
        usage: 'genie resume <sessionId> "<prompt>" [--help]',
        arguments: [
            { name: '<sessionId>', description: 'Session identifier from active or recent runs' },
            { name: '<prompt>', description: 'Follow-up prompt or new task instruction' }
        ],
        options: [
            { flag: '--help, -h', description: 'Show this help message' }
        ],
        examples: [
            'genie resume RUN-1234 "Please add error handling to the implementation"',
            'genie resume GENIE-567 "Review the test coverage and suggest improvements"',
            'genie resume FORGE-890 "Update the documentation with the new API changes"'
        ],
        notes: [
            'Session IDs can be found with: genie list sessions',
            'Only active or recently completed sessions can be resumed',
            'Use quotes around prompts containing spaces or special characters'
        ]
    });
}
function buildListHelpView() {
    return buildSubcommandHelpView({
        command: 'list',
        description: 'Display available agents or active sessions',
        usage: 'genie list <target> [--help]',
        arguments: [
            { name: '<target>', description: 'What to list: "agents" or "sessions"' }
        ],
        options: [
            { flag: '--help, -h', description: 'Show this help message' }
        ],
        examples: [
            'genie list agents',
            'genie list sessions'
        ],
        notes: [
            'Default target is "agents" if none specified',
            'Sessions show both active runs and recent history',
            'Agent list shows all available agents organized by category'
        ]
    });
}
function buildViewHelpView() {
    return buildSubcommandHelpView({
        command: 'view',
        description: 'Show transcript and details for a session',
        usage: 'genie view <sessionId> [--full] [--help]',
        arguments: [
            { name: '<sessionId>', description: 'Session identifier to display' }
        ],
        options: [
            { flag: '--full', description: 'Show complete session transcript (default: recent messages)' },
            { flag: '--help, -h', description: 'Show this help message' }
        ],
        examples: [
            'genie view 01999405-7d8e-7de3-a918-464ddd15',
            'genie view 01999402-c007-7f82-87b9-0304c8e5 --full'
        ],
        notes: [
            'Session IDs can be found with: genie list sessions',
            'Default view shows recent conversation; use --full for complete history',
            'Includes session metadata like execution mode and background status'
        ]
    });
}
function buildStopHelpView() {
    return buildSubcommandHelpView({
        command: 'stop',
        description: 'End a running background session',
        usage: 'genie stop <sessionId> [--help]',
        arguments: [
            { name: '<sessionId>', description: 'Session identifier to stop' }
        ],
        options: [
            { flag: '--help, -h', description: 'Show this help message' }
        ],
        examples: [
            'genie stop RUN-1234',
            'genie stop GENIE-567'
        ],
        notes: [
            'Only affects running background sessions',
            'Session IDs can be found with: genie list sessions',
            'Stopped sessions can still be viewed but not resumed'
        ]
    });
}
function buildGeneralHelpView() {
    return buildSubcommandHelpView({
        command: 'help',
        description: 'Show help information for commands',
        usage: 'genie help [<command>] [--help]',
        arguments: [
            { name: '<command>', description: 'Specific command to get help for', required: false }
        ],
        options: [
            { flag: '--help, -h', description: 'Show this help message' }
        ],
        examples: [
            'genie help',
            'genie help run',
            'genie help list'
        ],
        notes: [
            'Without arguments, shows the main command palette',
            'With a command name, shows detailed help for that command',
            'Most commands also accept --help or -h for quick access'
        ]
    });
}
