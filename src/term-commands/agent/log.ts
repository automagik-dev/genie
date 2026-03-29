/**
 * genie agent log [name] — Unified observability command.
 *
 * Absorbs:
 *   - `genie log` (default unified feed) via --type/--team/--follow
 *   - `genie read` (pane capture) via --raw
 *   - `genie history` (transcript) via --transcript
 *   - `genie sessions search` via --search
 *
 * Modes:
 *   default          — unified log from unified-log.ts
 *   --raw            — tmux capture-pane output (was `genie read`)
 *   --transcript     — compressed transcript (was `genie history`)
 *   --search <query> — session search (was `genie sessions search`)
 */

import type { Command } from 'commander';
import { type LogOptions, logCommand } from '../log.js';

interface AgentLogOptions extends LogOptions {
  raw?: boolean;
  transcript?: boolean;
  search?: string;
  lines?: string;
  full?: boolean;
}

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
    .option('--raw', 'Show raw pane capture (was `genie read`)')
    .option('--transcript', 'Show compressed transcript (was `genie history`)')
    .option('--full', 'Show full conversation (with --transcript)')
    .option('--search <query>', 'Search across sessions (was `genie sessions search`)')
    .option('-n, --lines <number>', 'Number of lines to read (with --raw)')
    .action(async (agent: string | undefined, options: AgentLogOptions) => {
      try {
        if (options.raw) {
          await handleRawMode(agent, options);
          return;
        }
        if (options.transcript) {
          await handleTranscriptMode(agent, options);
          return;
        }
        if (options.search) {
          await handleSearchMode(options.search, options);
          return;
        }
        // Default: unified log
        await logCommand(agent, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}

// ============================================================================
// --raw mode (was `genie read`)
// ============================================================================

async function handleRawMode(agent: string | undefined, options: AgentLogOptions): Promise<void> {
  if (!agent) {
    console.error('Error: agent name required for --raw mode.');
    console.error('Usage: genie agent log <name> --raw');
    process.exit(1);
  }

  const { readSessionLogs } = await import('../read.js');
  await readSessionLogs(agent, {
    lines: options.lines,
    follow: options.follow,
    json: options.json,
  });
}

// ============================================================================
// --transcript mode (was `genie history`)
// ============================================================================

async function handleTranscriptMode(agent: string | undefined, options: AgentLogOptions): Promise<void> {
  if (!agent) {
    console.error('Error: agent name required for --transcript mode.');
    console.error('Usage: genie agent log <name> --transcript');
    process.exit(1);
  }

  const { historyCommand } = await import('../history.js');
  await historyCommand(agent, {
    full: options.full,
    last: options.last,
    type: options.type,
    json: options.json,
    ndjson: options.ndjson,
    after: options.since,
  });
}

// ============================================================================
// --search mode (was `genie sessions search`)
// ============================================================================

async function handleSearchMode(query: string, options: AgentLogOptions): Promise<void> {
  const { isAvailable, getConnection } = await import('../../lib/db.js');

  if (!(await isAvailable())) {
    console.error('Database not available for session search.');
    process.exit(1);
  }

  const sql = await getConnection();
  const limit = options.last ?? 20;

  const rows = await sql`
    SELECT c.session_id, c.turn_index, c.role, c.content, c.timestamp,
           s.agent_id, s.team, s.status
    FROM session_content c
    JOIN sessions s ON c.session_id = s.id
    WHERE c.content ILIKE ${`%${query}%`}
    ORDER BY c.timestamp DESC
    LIMIT ${limit}
  `;

  if (options.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log(`No results for "${query}".`);
    return;
  }

  console.log('');
  console.log(`Search: "${query}" (${rows.length} results)`);
  console.log('─'.repeat(60));

  for (const r of rows) {
    const preview = String(r.content).replace(/\n/g, ' ').slice(0, 100);
    const agent = r.agent_id ?? '(unknown)';
    const time = r.timestamp ? new Date(r.timestamp as string).toLocaleTimeString() : '??:??';
    console.log(`  [${time}] ${agent} (${r.role}): ${preview}`);
  }
  console.log('');
}
