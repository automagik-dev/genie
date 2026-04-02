/**
 * genie agent brief — Show startup context aggregation.
 * Migrated from top-level `genie brief` in brief.ts.
 */

import type { Command } from 'commander';
import type * as briefTypes from '../../lib/brief.js';

let _brief: typeof briefTypes | undefined;
async function getBrief(): Promise<typeof briefTypes> {
  if (!_brief) _brief = await import('../../lib/brief.js');
  return _brief;
}

async function handleBrief(options: { team?: string; agent?: string; since?: string }): Promise<void> {
  const team = options.team ?? process.env.GENIE_TEAM;
  if (!team) {
    console.error('Error: --team is required (or set GENIE_TEAM)');
    process.exit(1);
  }

  const agent = options.agent ?? process.env.GENIE_AGENT_NAME;
  const briefService = await getBrief();

  const brief = await briefService.generateBrief({
    team,
    agent,
    since: options.since,
    repoPath: process.cwd(),
  });

  console.log(briefService.formatBrief(brief));
}

export function registerAgentBrief(parent: Command): void {
  parent
    .command('brief')
    .description('Show startup brief — aggregated context since last session')
    .option('--team <name>', 'Team name (default: GENIE_TEAM)')
    .option('--agent <name>', 'Agent name (default: GENIE_AGENT_NAME)')
    .option('--since <iso>', 'Start timestamp (default: last executor end)')
    .action(async (options: { team?: string; agent?: string; since?: string }) => {
      try {
        await handleBrief(options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });
}
