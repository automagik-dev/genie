/**
 * genie agent log [name] — STUB for unified observability feed.
 * Full implementation in Wave 2, Group 4.
 */

import type { Command } from 'commander';
import { type LogOptions, logCommand } from '../log.js';

export function registerAgentLog(parent: Command): void {
  parent
    .command('log [agent]')
    .description('Unified observability feed — aggregates transcript, DMs, team chat')
    .option('--team <name>', 'Show interleaved feed for all agents in a team')
    .option('--type <kind>', 'Filter by event kind (transcript, message, tool_call, state, system)')
    .option('--since <timestamp>', 'Only events after ISO timestamp')
    .option('--last <n>', 'Show last N events', Number.parseInt)
    .option('--ndjson', 'Output as newline-delimited JSON (pipeable to jq)')
    .option('--json', 'Output as pretty JSON')
    .option('-f, --follow', 'Follow mode — real-time streaming')
    .option('--raw', 'Show raw pane capture (stub — Wave 2)')
    .option('--transcript', 'Show compressed transcript (stub — Wave 2)')
    .option('--search <query>', 'Search across sessions (stub — Wave 2)')
    .action(
      async (
        agent: string | undefined,
        options: LogOptions & { raw?: boolean; transcript?: boolean; search?: string },
      ) => {
        try {
          // Stubs for Wave 2 flags
          if (options.raw) {
            console.error('genie agent log --raw: Not yet implemented (Wave 2, Group 4)');
            process.exit(1);
          }
          if (options.transcript) {
            console.error('genie agent log --transcript: Not yet implemented (Wave 2, Group 4)');
            process.exit(1);
          }
          if (options.search) {
            console.error('genie agent log --search: Not yet implemented (Wave 2, Group 4)');
            process.exit(1);
          }
          // Default: delegate to existing unified log
          await logCommand(agent, options);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Error: ${message}`);
          process.exit(1);
        }
      },
    );
}
