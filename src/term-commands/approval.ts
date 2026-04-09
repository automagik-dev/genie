/**
 * Approval commands — CLI interface for remote approval queue management.
 *
 * Commands:
 *   genie approval request --tool <name> --input <preview> --agent <name> --wait
 *   genie approval resolve <id> --decision allow|deny --by <actor>
 *   genie approval list [--agent <name>] [--json]
 */

import type { Command } from 'commander';
import {
  insertApproval,
  listPendingApprovals,
  resolveApproval,
  waitForResolution,
} from '../lib/providers/claude-sdk-remote-approval.js';
import { findWorkspace, getWorkspaceConfig } from '../lib/workspace.js';

// ============================================================================
// Handlers
// ============================================================================

interface RequestOptions {
  tool: string;
  input: string;
  agent: string;
  wait?: boolean;
  timeout?: string;
}

async function handleRequest(options: RequestOptions): Promise<void> {
  const ws = findWorkspace();
  const permissions = ws ? getWorkspaceConfig(ws.root).permissions : undefined;
  const timeoutSec = options.timeout ? Number(options.timeout) : (permissions?.timeout ?? 300);
  const defaultAction = permissions?.defaultAction ?? 'deny';
  const timeoutAt = new Date(Date.now() + timeoutSec * 1000);

  const approvalId = await insertApproval(`cli-${process.pid}`, options.agent, options.tool, options.input, timeoutAt);

  console.log(`Approval created: ${approvalId}`);

  if (options.wait) {
    console.log(`Waiting for resolution (timeout: ${timeoutSec}s, default: ${defaultAction})...`);
    const decision = await waitForResolution(approvalId, timeoutAt, defaultAction);
    console.log(`Decision: ${decision}`);
    if (decision === 'deny') process.exit(1);
  }
}

interface ResolveOptions {
  decision: string;
  by: string;
}

async function handleResolve(id: string, options: ResolveOptions): Promise<void> {
  if (options.decision !== 'allow' && options.decision !== 'deny') {
    console.error('Error: --decision must be "allow" or "deny"');
    process.exit(1);
  }

  // Use actual agent identity or system user — --by is a display label, not an auth claim
  const actor = process.env.GENIE_AGENT_NAME || options.by;
  const updated = await resolveApproval(id, options.decision as 'allow' | 'deny', actor);
  if (updated) {
    console.log(`Approval ${id} resolved: ${options.decision} by ${options.by}`);
  } else {
    console.error(`Error: Approval ${id} not found or already resolved`);
    process.exit(1);
  }
}

interface ListOptions {
  agent?: string;
  json?: boolean;
}

async function handleList(options: ListOptions): Promise<void> {
  const rows = await listPendingApprovals(options.agent);

  if (options.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log('No pending approvals.');
    return;
  }

  console.log(`  ${'ID'.padEnd(38)} ${'AGENT'.padEnd(20)} ${'TOOL'.padEnd(15)} ${'TIMEOUT'}`);
  console.log(`  ${'─'.repeat(85)}`);
  for (const row of rows) {
    const timeout = new Date(row.timeout_at).toLocaleTimeString();
    console.log(
      `  ${String(row.id).padEnd(38)} ${String(row.agent_name).padEnd(20)} ${String(row.tool_name).padEnd(15)} ${timeout}`,
    );
  }
  console.log(`\n  ${rows.length} pending approval${rows.length === 1 ? '' : 's'}`);
}

// ============================================================================
// Registration
// ============================================================================

export function registerApprovalCommands(program: Command): void {
  const approval = program.command('approval').description('Remote approval queue management');

  approval
    .command('request')
    .description('Create an approval request (for tmux-path agents)')
    .requiredOption('--tool <name>', 'Tool name requiring approval')
    .requiredOption('--input <preview>', 'Tool input preview text')
    .requiredOption('--agent <name>', 'Agent name requesting approval')
    .option('--wait', 'Block until the approval is resolved')
    .option('--timeout <seconds>', 'Timeout in seconds (overrides workspace config)')
    .action(async (options: RequestOptions) => {
      try {
        await handleRequest(options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  approval
    .command('resolve <id>')
    .description('Resolve a pending approval')
    .requiredOption('--decision <decision>', 'Decision: allow or deny')
    .option('--by <actor>', 'Display label for decision maker (defaults to GENIE_AGENT_NAME or "cli")', 'cli')
    .action(async (id: string, options: ResolveOptions) => {
      try {
        await handleResolve(id, options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  approval
    .command('list')
    .description('List pending approvals')
    .option('--agent <name>', 'Filter by agent name')
    .option('--json', 'Output as JSON')
    .action(async (options: ListOptions) => {
      try {
        await handleList(options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });
}
