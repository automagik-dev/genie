/**
 * Request — CLI for structured agent→human requests.
 *
 * Commands:
 *   genie request create --type <type> --payload '{}' [--task ID] [--team NAME]
 *   genie request list [--status pending|resolved|rejected] [--team NAME]
 *   genie request resolve <id> --value '{}'
 *   genie request reject <id> [--reason "..."]
 */

import type { Command } from 'commander';
import type * as agentRequestsTypes from '../lib/agent-requests.js';

// ============================================================================
// Lazy Loaders
// ============================================================================

let _agentRequests: typeof agentRequestsTypes | undefined;
async function getAgentRequests(): Promise<typeof agentRequestsTypes> {
  if (!_agentRequests) _agentRequests = await import('../lib/agent-requests.js');
  return _agentRequests;
}

// ============================================================================
// Helpers
// ============================================================================

function detectAgentId(): string {
  return process.env.GENIE_AGENT_NAME ?? 'cli';
}

function detectTeam(): string | undefined {
  return process.env.GENIE_TEAM;
}

function parseJsonArg(raw: string, label: string): Record<string, unknown> {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON for ${label}: ${raw}`);
  }
}

// ============================================================================
// Handlers
// ============================================================================

async function handleCreate(options: {
  type: string;
  payload: string;
  task?: string;
  team?: string;
  executor?: string;
}): Promise<void> {
  const ar = await getAgentRequests();
  const agentId = detectAgentId();
  const team = options.team ?? detectTeam();
  const payload = parseJsonArg(options.payload, '--payload');

  const request = await ar.createRequest({
    agentId,
    type: options.type as agentRequestsTypes.AgentRequestType,
    payload,
    taskId: options.task,
    team,
    executorId: options.executor,
  });

  console.log(`Request created: ${request.id}`);
  console.log(`  Type: ${request.type}`);
  console.log(`  Agent: ${request.agentId}`);
  console.log(`  Team: ${request.team ?? '(none)'}`);
  console.log(`  Payload: ${JSON.stringify(request.payload)}`);
}

async function handleList(options: {
  status?: string;
  team?: string;
  agent?: string;
  type?: string;
}): Promise<void> {
  const ar = await getAgentRequests();
  const team = options.team ?? detectTeam();

  const requests = await ar.listRequests({
    status: options.status as agentRequestsTypes.AgentRequestStatus | undefined,
    team,
    agentId: options.agent,
    type: options.type as agentRequestsTypes.AgentRequestType | undefined,
  });

  if (requests.length === 0) {
    console.log('No requests found.');
    return;
  }

  for (const req of requests) {
    const status =
      req.status === 'pending' ? '⏳' : req.status === 'resolved' ? '✅' : req.status === 'rejected' ? '❌' : '⏰';
    console.log(`${status} ${req.id}  [${req.type}]  ${req.agentId}  ${req.status}`);
    console.log(`   Payload: ${JSON.stringify(req.payload)}`);
    if (req.resolvedValue) {
      console.log(`   Resolved: ${JSON.stringify(req.resolvedValue)}`);
    }
  }
}

async function handleResolve(id: string, options: { value: string }): Promise<void> {
  const ar = await getAgentRequests();
  const resolvedBy = `human:${process.env.USER ?? 'unknown'}`;
  const value = parseJsonArg(options.value, '--value');

  const request = await ar.resolveRequest(id, resolvedBy, value);
  console.log(`Request ${request.id} resolved by ${resolvedBy}`);
}

async function handleReject(id: string, options: { reason?: string }): Promise<void> {
  const ar = await getAgentRequests();
  const resolvedBy = `human:${process.env.USER ?? 'unknown'}`;

  const request = await ar.rejectRequest(id, resolvedBy, options.reason);
  console.log(`Request ${request.id} rejected by ${resolvedBy}`);
}

// ============================================================================
// Registration
// ============================================================================

export function registerRequestCommands(program: Command): void {
  const request = program.command('request').description('Manage structured agent requests');

  request
    .command('create')
    .description('Create a new agent request')
    .requiredOption('--type <type>', 'Request type: env, confirm, choice, approve, input')
    .requiredOption('--payload <json>', 'Request payload as JSON')
    .option('--task <id>', 'Associated task ID')
    .option('--team <name>', 'Team name')
    .option('--executor <id>', 'Executor ID')
    .action(async (options: { type: string; payload: string; task?: string; team?: string; executor?: string }) => {
      try {
        await handleCreate(options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  request
    .command('list')
    .description('List agent requests')
    .option('--status <status>', 'Filter by status: pending, resolved, rejected, expired')
    .option('--team <name>', 'Filter by team')
    .option('--agent <name>', 'Filter by agent')
    .option('--type <type>', 'Filter by type')
    .action(async (options: { status?: string; team?: string; agent?: string; type?: string }) => {
      try {
        await handleList(options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  request
    .command('resolve <id>')
    .description('Resolve a pending request with a value')
    .requiredOption('--value <json>', 'Resolution value as JSON')
    .action(async (id: string, options: { value: string }) => {
      try {
        await handleResolve(id, options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  request
    .command('reject <id>')
    .description('Reject a pending request')
    .option('--reason <text>', 'Rejection reason')
    .action(async (id: string, options: { reason?: string }) => {
      try {
        await handleReject(id, options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });
}
