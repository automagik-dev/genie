/**
 * Unified Log Command — Aggregated observability feed for agents and teams.
 *
 * Usage:
 *   genie log <agent>                     # Unified feed for one agent
 *   genie log --team <name>               # Interleaved feed for all team members
 *   genie log <agent> --ndjson            # NDJSON output (pipeable to jq)
 *   genie log <agent> --type message      # Filter to messages only
 *   genie log <agent> --last 50           # Last 50 events
 *   genie log <agent> --since <timestamp> # Events after timestamp
 *   genie log <agent> --follow            # Real-time streaming (Group 5)
 */

import * as agentRegistry from '../lib/agent-registry.js';
import {
  type LogEvent,
  type LogEventKind,
  type LogFilter,
  followAgentLog,
  followTeamLog,
  readAgentLog,
  readTeamLog,
} from '../lib/unified-log.js';

// ============================================================================
// Types
// ============================================================================

export interface LogOptions {
  /** Filter by team name — shows all agents interleaved */
  team?: string;
  /** Filter by event kind (transcript, message, tool_call, etc.) */
  type?: string;
  /** Only events after this ISO timestamp */
  since?: string;
  /** Show last N events */
  last?: number;
  /** Output as NDJSON (one JSON per line) */
  ndjson?: boolean;
  /** Output as pretty JSON */
  json?: boolean;
  /** Follow mode — real-time streaming (placeholder for Group 5) */
  follow?: boolean;
}

// ============================================================================
// Display Formatting
// ============================================================================

function formatTime(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  } catch {
    return '??:??:??';
  }
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 3)}...`;
}

function kindIcon(kind: LogEventKind): string {
  switch (kind) {
    case 'transcript':
      return 'T';
    case 'message':
      return 'M';
    case 'state':
      return 'S';
    case 'tool_call':
      return 'C';
    case 'tool_result':
      return 'R';
    case 'system':
      return '*';
    default:
      return '?';
  }
}

function kindColor(kind: LogEventKind): string {
  switch (kind) {
    case 'transcript':
      return '\x1b[36m'; // cyan
    case 'message':
      return '\x1b[33m'; // yellow
    case 'state':
      return '\x1b[35m'; // magenta
    case 'tool_call':
      return '\x1b[32m'; // green
    case 'tool_result':
      return '\x1b[90m'; // dim
    case 'system':
      return '\x1b[34m'; // blue
    default:
      return '\x1b[0m';
  }
}

const RESET = '\x1b[0m';
const DIM = '\x1b[90m';
const BOLD = '\x1b[1m';

function formatEventLine(event: LogEvent): string {
  const time = formatTime(event.timestamp);
  const icon = kindIcon(event.kind);
  const color = kindColor(event.kind);

  let agent = event.agent;
  if (event.direction === 'in') agent = `${event.peer} -> ${event.agent}`;
  else if (event.direction === 'out') agent = `${event.agent} -> ${event.peer}`;

  const text = truncate(event.text.replace(/\n/g, ' '), 100);

  return `${DIM}${time}${RESET} ${color}[${icon}]${RESET} ${BOLD}${agent}${RESET} ${text}`;
}

function formatHumanOutput(events: LogEvent[], label: string): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(`${BOLD}Log: ${label}${RESET} (${events.length} events)`);
  lines.push('');

  if (events.length === 0) {
    lines.push('  No events found.');
    lines.push('');
    return lines.join('\n');
  }

  for (const event of events) {
    lines.push(formatEventLine(event));
  }

  lines.push('');
  return lines.join('\n');
}

// ============================================================================
// Agent Resolution
// ============================================================================

async function findAgent(identifier: string): Promise<agentRegistry.Agent | null> {
  let agent = await agentRegistry.get(identifier);
  if (agent) return agent;

  agent = await agentRegistry.findByTask(identifier);
  if (agent) return agent;

  const all = await agentRegistry.list();
  return (
    all.find(
      (w) =>
        w.id.includes(identifier) ||
        w.taskId?.includes(identifier) ||
        w.taskTitle?.toLowerCase().includes(identifier.toLowerCase()),
    ) ?? null
  );
}

async function findTeamAgents(teamName: string): Promise<agentRegistry.Agent[]> {
  const all = await agentRegistry.list();
  return all.filter((a) => a.team === teamName);
}

// ============================================================================
// Filter Building
// ============================================================================

function buildFilter(options: LogOptions): LogFilter | undefined {
  const filter: LogFilter = {};
  let hasFilter = false;

  if (options.last && options.last > 0) {
    filter.last = options.last;
    hasFilter = true;
  }

  if (options.since) {
    filter.since = options.since;
    hasFilter = true;
  }

  if (options.type) {
    filter.kinds = [options.type as LogEventKind];
    hasFilter = true;
  }

  return hasFilter ? filter : undefined;
}

// ============================================================================
// Output
// ============================================================================

function outputNdjson(events: LogEvent[]): void {
  for (const event of events) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }
}

function outputJson(events: LogEvent[]): void {
  process.stdout.write(`${JSON.stringify(events, null, 2)}\n`);
}

// ============================================================================
// Main Command
// ============================================================================

export async function logCommand(agentName: string | undefined, options: LogOptions): Promise<void> {
  const repoPath = process.cwd();
  const filter = buildFilter(options);

  // --follow: real-time streaming mode
  if (options.follow) {
    await followCommand(agentName, options, repoPath, filter);
    return;
  }

  let events: LogEvent[];
  let label: string;

  if (options.team) {
    // Team mode: interleave all agents in the team
    const agents = await findTeamAgents(options.team);
    if (agents.length === 0) {
      console.error(`No agents found for team "${options.team}".`);
      process.exit(1);
    }
    events = await readTeamLog(agents, repoPath, options.team, filter);
    label = `team:${options.team} (${agents.length} agents)`;
  } else if (agentName) {
    // Single agent mode
    const agent = await findAgent(agentName);
    if (!agent) {
      console.error(`Agent "${agentName}" not found. Run \`genie ls\` to see agents.`);
      process.exit(1);
    }
    events = await readAgentLog(agent, repoPath, filter);
    label = agent.id;
  } else {
    // No agent, no team — show all agents
    const allAgents = await agentRegistry.list();
    if (allAgents.length === 0) {
      console.error('No agents found. Run `genie ls` to see agents.');
      process.exit(1);
    }
    events = await readTeamLog(allAgents, repoPath, 'all', filter);
    label = `all agents (${allAgents.length})`;
  }

  // Output
  if (options.ndjson) {
    outputNdjson(events);
    return;
  }

  if (options.json) {
    outputJson(events);
    return;
  }

  console.log(formatHumanOutput(events, label));
}

// ============================================================================
// Follow Mode
// ============================================================================

async function followCommand(
  agentName: string | undefined,
  options: LogOptions,
  repoPath: string,
  filter: LogFilter | undefined,
): Promise<void> {
  const outputEvent = (event: LogEvent) => {
    if (options.ndjson) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    } else {
      process.stdout.write(`${formatEventLine(event)}\n`);
    }
  };

  let label: string;

  if (options.team) {
    const agents = await findTeamAgents(options.team);
    if (agents.length === 0) {
      console.error(`No agents found for team "${options.team}".`);
      process.exit(1);
    }
    label = `team:${options.team} (${agents.length} agents)`;

    const handle = await followTeamLog(agents, repoPath, options.team, filter, outputEvent);
    console.error(`Following ${label} via ${handle.mode === 'nats' ? 'NATS' : 'file polling'} (Ctrl+C to stop)...`);
    setupShutdown(handle.stop);
  } else if (agentName) {
    const agent = await findAgent(agentName);
    if (!agent) {
      console.error(`Agent "${agentName}" not found. Run \`genie ls\` to see agents.`);
      process.exit(1);
    }
    label = agent.id;

    const handle = await followAgentLog(agent, repoPath, filter, outputEvent);
    console.error(`Following ${label} via ${handle.mode === 'nats' ? 'NATS' : 'file polling'} (Ctrl+C to stop)...`);
    setupShutdown(handle.stop);
  } else {
    const allAgents = await agentRegistry.list();
    if (allAgents.length === 0) {
      console.error('No agents found. Run `genie ls` to see agents.');
      process.exit(1);
    }
    label = `all agents (${allAgents.length})`;

    const handle = await followTeamLog(allAgents, repoPath, 'all', filter, outputEvent);
    console.error(`Following ${label} via ${handle.mode === 'nats' ? 'NATS' : 'file polling'} (Ctrl+C to stop)...`);
    setupShutdown(handle.stop);
  }

  // Keep process alive
  await new Promise<void>(() => {});
}

function setupShutdown(stop: () => Promise<void>): void {
  const shutdown = async () => {
    await stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
