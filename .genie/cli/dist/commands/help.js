"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runHelp = runHelp;
const view_helpers_1 = require("../lib/view-helpers");
const help_1 = require("../views/help");
async function runHelp(parsed, config, _paths) {
    const backgroundDefault = Boolean(config.defaults && config.defaults.background);
    const commandRows = [
        { command: 'init', args: '[--provider codex|claude] [--yes]', description: 'Initialize Genie in this workspace' },
        { command: 'update', args: '[--dry-run] [--force]', description: 'Apply template updates with backups' },
        { command: 'rollback', args: '[--id <backup>]', description: 'Restore a previous Genie snapshot' },
        { command: 'run', args: '<agent> "<prompt>"', description: 'Start or attach to an agent' },
        { command: 'list agents', args: '', description: 'Show all available agents' },
        { command: 'list sessions', args: '', description: 'Display active and recent runs' },
        { command: 'resume', args: '<sessionId> "<prompt>"', description: 'Continue a background session' },
        { command: 'view', args: '<sessionId> [--full]', description: 'Show transcript for a session' },
        { command: 'stop', args: '<sessionId>', description: 'End a background session' },
        { command: 'statusline', args: '', description: 'Emit deprecated status line output' },
        { command: 'help', args: '', description: 'Show this panel' }
    ];
    const envelope = (0, help_1.buildHelpView)({
        backgroundDefault,
        commandRows,
        promptFramework: {
            title: '🧞 Genie Framework',
            bulletPoints: [
                'Plan → Load mission/roadmap/standards context, clarify scope, log assumptions/decisions, and produce the planning brief with branch/tracker guidance.',
                'Wish → Convert the planning brief into an approved wish with context ledger, inline <spec_contract>, execution groups, and blocker protocol.',
                'Forge → Break the wish into execution groups and task files, document validation hooks, evidence paths, personas, and branch strategy before implementation.',
                'Review → Audit delivery by consolidating evidence, replaying agreed checks, and issuing a verdict or follow-up report before marking the wish complete.'
            ]
        },
        examples: [
            'genie init --provider codex',
            'genie update --dry-run',
            'genie run plan "[Discovery] mission @.genie/product/mission.md"',
            'genie run --help  # Show help for run command',
            'genie view RUN-1234',
            'genie list agents --help  # Show help for list command'
        ]
    });
    await (0, view_helpers_1.emitView)(envelope, parsed.options);
}
