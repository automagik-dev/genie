"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildGeneralHelpView = exports.buildStopHelpView = exports.buildViewHelpView = exports.buildListHelpView = exports.buildResumeHelpView = exports.buildRunHelpView = exports.buildSubcommandHelpView = exports.buildHelpView = void 0;
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
exports.buildHelpView = buildHelpView;
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
exports.buildSubcommandHelpView = buildSubcommandHelpView;
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
            { flag: '--executor, -x', description: 'Override executor for this run' },
            { flag: '--model, -m', description: 'Override model for the selected executor' },
            { flag: '--name, -n', description: 'Custom session name (defaults to agent-timestamp)' },
            { flag: '--background, -b', description: 'Force background execution (default from config/agent)' },
            { flag: '--help, -h', description: 'Show this help message' }
        ],
        examples: [
            'genie run code/analyze "[Discovery] mission @.genie/product/mission.md"',
            'genie run code/review "Audit release branch for regressions"',
            'genie run create/writer "Draft the launch announcement outline"',
            'genie run code/commit "Stage and commit hotfix" --executor opencode --model gpt-4.1-coding'
        ],
        notes: [
            'Precedence: workspace defaults → agent front matter → CLI flags',
            'Use quotes around prompts containing spaces or special characters',
            'Agent identifiers can be found with: genie list agents',
            'Executor/model values must exist in Forge or the workspace profile sync will fail'
        ]
    });
}
exports.buildRunHelpView = buildRunHelpView;
function buildResumeHelpView() {
    return buildSubcommandHelpView({
        command: 'resume',
        description: 'Continue an existing agent session',
        usage: 'genie resume <session-name> "<prompt>" [--help]',
        arguments: [
            { name: '<session-name>', description: 'Session name from active or recent runs' },
            { name: '<prompt>', description: 'Follow-up prompt or new task instruction' }
        ],
        options: [
            { flag: '--help, -h', description: 'Show this help message' }
        ],
        examples: [
            'genie resume code-analyze-2510201015 "Follow up on the architectural risks"',
            'genie resume code-review-2510201110 "Re-run the verification checklist"',
            'genie resume create-writer-2510201205 "Add a release timeline section"'
        ],
        notes: [
            'Session names can be found with: genie list sessions',
            'Only active or recently completed sessions can be resumed',
            'Use quotes around prompts containing spaces or special characters'
        ]
    });
}
exports.buildResumeHelpView = buildResumeHelpView;
function buildListHelpView() {
    return buildSubcommandHelpView({
        command: 'list',
        description: 'Display available agents or active sessions',
        usage: 'genie list <target> [--help]',
        arguments: [
            { name: '<target>', description: 'What to list: "collectives", "agents", "workflows", "skills", or "sessions"' }
        ],
        options: [
            { flag: '--help, -h', description: 'Show this help message' }
        ],
        examples: [
            'genie list collectives',
            'genie list agents',
            'genie list sessions'
        ],
        notes: [
            'Default target is "collectives" if none specified',
            'Sessions show both active runs and recent history',
            'Agent list shows all available agents organized by collective'
        ]
    });
}
exports.buildListHelpView = buildListHelpView;
function buildViewHelpView() {
    return buildSubcommandHelpView({
        command: 'view',
        description: 'Show transcript and details for a session',
        usage: 'genie view <session-name> [--full] [--help]',
        arguments: [
            { name: '<session-name>', description: 'Session name to display' }
        ],
        options: [
            { flag: '--full', description: 'Show complete session transcript (default: recent messages)' },
            { flag: '--help, -h', description: 'Show this help message' }
        ],
        examples: [
            'genie view implementor-2510181230',
            'genie view plan-2510180915 --full'
        ],
        notes: [
            'Session names can be found with: genie list sessions',
            'Default view shows recent conversation; use --full for complete history',
            'Includes session metadata like execution mode and background status'
        ]
    });
}
exports.buildViewHelpView = buildViewHelpView;
function buildStopHelpView() {
    return buildSubcommandHelpView({
        command: 'stop',
        description: 'End a running background session',
        usage: 'genie stop <session-name> [--help]',
        arguments: [
            { name: '<session-name>', description: 'Session name to stop' }
        ],
        options: [
            { flag: '--help, -h', description: 'Show this help message' }
        ],
        examples: [
            'genie stop implementor-2510181230',
            'genie stop plan-2510180915'
        ],
        notes: [
            'Only affects running background sessions',
            'Session names can be found with: genie list sessions',
            'Stopped sessions can still be viewed but not resumed'
        ]
    });
}
exports.buildStopHelpView = buildStopHelpView;
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
exports.buildGeneralHelpView = buildGeneralHelpView;
