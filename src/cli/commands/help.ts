import type { ParsedCommand, GenieConfig, ConfigPaths } from '../lib/types';
import { emitView } from '../lib/view-helpers';
import { buildHelpView } from '../views/help';

export async function runHelp(
  parsed: ParsedCommand,
  config: GenieConfig,
  _paths: Required<ConfigPaths>
): Promise<void> {
  const backgroundDefault = Boolean(config.defaults && config.defaults.background);
  const commandRows = [
    { command: 'init', args: '[template] [--yes]', description: 'Initialize Genie in this workspace' },
    { command: 'rollback', args: '[--id <backup>]', description: 'Restore a previous Genie snapshot' },
    { command: 'run', args: '<agent> "<prompt>" [-x <executor>] [-m <model>]', description: 'Start or attach to an agent' },
    { command: 'list agents', args: '', description: 'Show all available agents' },
    { command: 'list tasks', args: '', description: 'Display active and recent runs' },
    { command: 'resume', args: '<taskId> "<prompt>"', description: 'Continue a background task' },
    { command: 'view', args: '<taskId> [--full]', description: 'Show transcript for a task' },
    { command: 'stop', args: '<taskId>', description: 'End a background task' },
    { command: 'statusline', args: '', description: 'Emit deprecated status line output' },
    { command: 'help', args: '', description: 'Show this panel' }
  ];

  const envelope = buildHelpView({
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
      'genie init code --yes',
      'genie run code/analyze "[Discovery] mission @.genie/product/mission.md"',
      'genie run code/commit "Stage hotfix commit" --executor opencode --model gpt-4.1-coding',
      'genie run --help  # Show help for run command',
      'genie view code-analyze-2510201015',
      'genie list agents --help  # Show help for list command'
    ]
  });

  await emitView(envelope, parsed.options);
}
