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
import { formatTime as _fmtTime } from '../lib/term-format.js';
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

function kindIcon(kind: LogEventKind): string {
  switch (kind) {
    case 'user':
      return 'U';
    case 'assistant':
      return 'A';
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
    case 'user':
      return '\x1b[33m'; // yellow
    case 'assistant':
      return '\x1b[36m'; // cyan
    case 'message':
      return '\x1b[35m'; // magenta
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

/**
 * Summarize a tool call for human display.
 * Extracts the essential info (tool name + target) instead of raw JSON.
 */
function summarizeToolCall(event: LogEvent): string {
  const tc = event.data?.toolCall as { name: string; input: Record<string, unknown> } | undefined;
  if (!tc) return event.text;

  const input = tc.input;
  switch (tc.name) {
    case 'Read':
    case 'Edit':
    case 'Write':
      return `${tc.name} ${input.file_path ?? ''}`;
    case 'Bash': {
      const cmd = String(input.command ?? '').split('\n')[0];
      return `$ ${cmd}`;
    }
    case 'Grep':
      return `Grep "${input.pattern}" ${input.path ?? ''}`;
    case 'Glob':
      return `Glob ${input.pattern}`;
    case 'Agent':
      return `Agent: ${input.description ?? ''}`;
    case 'SendMessage':
      return `SendMessage → ${input.to}: ${String(input.message ?? '').slice(0, 80)}`;
    case 'shell':
    case 'exec_command': {
      const shellCmd = Array.isArray(input.command) ? input.command.join(' ') : String(input.command ?? '');
      return `$ ${shellCmd.split('\n')[0]}`;
    }
    case 'web_search':
      return `Search: ${input.query ?? ''}`;
    default:
      return `${tc.name}`;
  }
}

function formatEventBlock(event: LogEvent): string {
  const time = _fmtTime(event.timestamp, { seconds: true, fallback: '??:??:??' });
  const icon = kindIcon(event.kind);
  const color = kindColor(event.kind);

  let agent = event.agent;
  if (event.direction === 'in') agent = `${event.peer} → ${event.agent}`;
  else if (event.direction === 'out') agent = `${event.agent} → ${event.peer}`;

  const sdkTag = event.source === 'sdk' ? ` ${DIM}[SDK]${RESET}` : '';
  const header = `${DIM}${time}${RESET} ${color}[${icon}]${RESET} ${BOLD}${agent}${RESET}${sdkTag}`;

  // Tool calls: one-line summary
  if (event.kind === 'tool_call') {
    const summary = summarizeToolCall(event);
    return `${header} ${DIM}${summary}${RESET}`;
  }

  // Tool results: dim, single line
  if (event.kind === 'tool_result') {
    const line = event.text.split('\n')[0].slice(0, 120);
    return `${header} ${DIM}${line}${RESET}`;
  }

  // Short text (< 80 chars, single line): inline
  const text = event.text.trim();
  if (text.length < 80 && !text.includes('\n')) {
    return `${header}\n  ${text}`;
  }

  // Multi-line: indent each line
  const indented = text
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
  return `${header}\n${indented}`;
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

  let lastKind: string | null = null;
  for (const event of events) {
    // Blank line between events, except consecutive tool_calls (keep them tight)
    if (lastKind !== null && !(lastKind === 'tool_call' && event.kind === 'tool_call')) {
      lines.push('');
    }
    lines.push(formatEventBlock(event));
    lastKind = event.kind;
  }

  lines.push('');
  return lines.join('\n');
}

// ============================================================================
// Agent Resolution
// ============================================================================

/**
 * Resolve an agent identifier the same way `genie send` does (#1302):
 *   1. Exact UUID match via `registry.get`.
 *   2. Exact match on `customName` → `role` → `id`, team-scoped first when
 *      `teamName` is provided, then falling back to a global search. Native
 *      team agents carry a UUID id but a human `customName`, so skipping this
 *      step is what made `genie log <name>` miss agents that `genie send` finds.
 *   3. Legacy task-id lookup (`registry.findByTask`).
 *   4. Unique prefix match on `customName` / `role`. Multiple candidates throw
 *      an "Ambiguous" error that lists the alternatives instead of silently
 *      returning the first substring hit.
 */
export async function findAgent(identifier: string, teamName?: string): Promise<agentRegistry.Agent | null> {
  const direct = await agentRegistry.get(identifier);
  if (direct) return direct;

  const all = await agentRegistry.list();
  const teamPool = teamName ? all.filter((a) => a.team === teamName) : [];
  const exact = (w: agentRegistry.Agent) => w.customName === identifier || w.role === identifier || w.id === identifier;

  const teamExact = teamPool.find(exact);
  if (teamExact) return teamExact;
  const globalExact = all.find(exact);
  if (globalExact) return globalExact;

  const byTask = await agentRegistry.findByTask(identifier);
  if (byTask) return byTask;

  const prefix = (w: agentRegistry.Agent) =>
    (w.customName !== undefined && w.customName !== identifier && w.customName.startsWith(identifier)) ||
    (w.role !== undefined && w.role !== identifier && w.role.startsWith(identifier));
  const displayName = (w: agentRegistry.Agent) => w.customName ?? w.role ?? w.id;

  const teamPrefix = teamPool.filter(prefix);
  if (teamPrefix.length === 1) return teamPrefix[0];
  if (teamPrefix.length > 1) {
    throw new Error(
      `Agent "${identifier}" is ambiguous in team "${teamName}". Did you mean: ${teamPrefix
        .map(displayName)
        .join(', ')}?`,
    );
  }

  const globalPrefix = all.filter(prefix);
  if (globalPrefix.length === 1) return globalPrefix[0];
  if (globalPrefix.length > 1) {
    throw new Error(`Agent "${identifier}" is ambiguous. Did you mean: ${globalPrefix.map(displayName).join(', ')}?`);
  }

  return null;
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
    // Single agent mode — scope to team if specified
    const agent = await findAgent(agentName, options.team);
    if (!agent) {
      console.error(`Agent "${agentName}" not found. Run \`genie agent list\` to see agents.`);
      process.exit(1);
    }
    events = await readAgentLog(agent, repoPath, filter);
    label = agent.id;
  } else {
    // No agent, no team — show all events (unfiltered)
    const allAgents = await agentRegistry.list();
    events = await readTeamLog(allAgents, repoPath, 'all', filter);
    label = allAgents.length > 0 ? `all agents (${allAgents.length})` : 'all events';
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
  let lastFollowKind: string | null = null;
  const outputEvent = (event: LogEvent) => {
    if (options.ndjson) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    } else {
      // Add spacing between events (except consecutive tool_calls)
      if (lastFollowKind !== null && !(lastFollowKind === 'tool_call' && event.kind === 'tool_call')) {
        process.stdout.write('\n');
      }
      process.stdout.write(`${formatEventBlock(event)}\n`);
      lastFollowKind = event.kind;
    }
  };

  let label: string;

  if (options.team) {
    const agents = await findTeamAgents(options.team);
    label = `team:${options.team}${agents.length > 0 ? ` (${agents.length} agents)` : ''}`;

    const handle = await followTeamLog(agents, repoPath, options.team, filter, outputEvent);
    console.error(
      `Following ${label} via ${handle.mode === 'pg' ? 'Postgres event log' : handle.mode} (Ctrl+C to stop)...`,
    );
    setupShutdown(handle.stop);
  } else if (agentName) {
    const agent = await findAgent(agentName, options.team);
    if (!agent) {
      console.error(`Agent "${agentName}" not found. Run \`genie agent list\` to see agents.`);
      process.exit(1);
    }
    label = agent.id;

    const handle = await followAgentLog(agent, repoPath, filter, outputEvent);
    console.error(
      `Following ${label} via ${handle.mode === 'pg' ? 'Postgres event log' : handle.mode} (Ctrl+C to stop)...`,
    );
    setupShutdown(handle.stop);
  } else {
    const allAgents = await agentRegistry.list();
    label = allAgents.length > 0 ? `all agents (${allAgents.length})` : 'all events';

    const handle = await followTeamLog(allAgents, repoPath, 'all', filter, outputEvent);
    console.error(
      `Following ${label} via ${handle.mode === 'pg' ? 'Postgres event log' : handle.mode} (Ctrl+C to stop)...`,
    );
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
