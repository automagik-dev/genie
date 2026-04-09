/**
 * Unified Log — Canonical event format and aggregator.
 *
 * Aggregates 6 event sources (transcript, mailbox inbox, mailbox outbox,
 * team chat, PG messages, registry state changes) into a single `LogEvent`
 * stream sorted by timestamp.
 *
 * Usage:
 *   const events = await readAgentLog('engineer', repoPath, { last: 50 });
 *   const events = await readTeamLog('genie-cli', repoPath);
 */

import type { Agent } from './agent-registry.js';
import type { AuditEventRow } from './audit.js';
import { getConnection, isAvailable } from './db.js';
import { type MailboxMessage, inbox, readOutbox } from './mailbox.js';
import {
  type RuntimeEvent,
  type RuntimeEventKind,
  type RuntimeEventSource,
  followRuntimeEvents,
} from './runtime-events.js';
import { type ChatMessage, readMessages } from './team-chat.js';
import type { TranscriptEntry } from './transcript.js';

// ============================================================================
// Types
// ============================================================================

export type LogEventKind = RuntimeEventKind;
export type LogEventSource = RuntimeEventSource;

export interface LogEvent {
  /** ISO timestamp */
  timestamp: string;
  /** Event kind */
  kind: LogEventKind;
  /** Agent that produced this event */
  agent: string;
  /** Team the agent belongs to */
  team?: string;
  /** For messages: received vs sent */
  direction?: 'in' | 'out';
  /** For messages: the other agent */
  peer?: string;
  /** Human-readable summary */
  text: string;
  /** Structured payload */
  data?: Record<string, unknown>;
  /** Where this event came from */
  source: LogEventSource;
}

export interface LogFilter {
  /** Return only last N events (applied last) */
  last?: number;
  /** Only events after this ISO timestamp */
  since?: string;
  /** Only events matching these kinds */
  kinds?: LogEventKind[];
}

// ============================================================================
// Converters
// ============================================================================

function mailboxActorKeys(agent: Agent): string[] {
  const keys = [agent.id];
  if (agent.role && agent.role !== agent.id) keys.push(agent.role);
  if (agent.customName && !keys.includes(agent.customName)) keys.push(agent.customName);
  return keys;
}

/** Check if text looks like injected system/skill content rather than real conversation. */
function isSystemNoise(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith('<command-name>') ||
    trimmed.startsWith('<command-message>') ||
    trimmed.startsWith('Base directory for this skill:') ||
    trimmed.startsWith('<system-reminder>') ||
    trimmed.startsWith('<local-command')
  );
}

/** Convert a TranscriptEntry to a LogEvent. */
export function transcriptToLogEvent(entry: TranscriptEntry, agent: string, team?: string): LogEvent | null {
  const kindMap: Record<string, LogEventKind> = {
    user: 'user',
    assistant: 'assistant',
    system: 'system',
    tool_call: 'tool_call',
    tool_result: 'tool_result',
  };

  const text = entry.text.trim();

  // Filter out system/skill injection noise
  if (isSystemNoise(text)) return null;
  if (!text) return null;

  return {
    timestamp: entry.timestamp,
    kind: kindMap[entry.role] ?? 'assistant',
    agent,
    team,
    text,
    data: {
      role: entry.role,
      ...(entry.toolCall ? { toolCall: entry.toolCall } : {}),
      ...(entry.model ? { model: entry.model } : {}),
      ...(entry.usage ? { usage: entry.usage } : {}),
    },
    source: 'provider',
  };
}

/** Convert an inbox MailboxMessage to a LogEvent (direction: in). */
export function inboxMessageToLogEvent(msg: MailboxMessage, agent: string, team?: string): LogEvent {
  return {
    timestamp: msg.createdAt,
    kind: 'message',
    agent,
    team,
    direction: 'in',
    peer: msg.from,
    text: msg.body,
    data: { messageId: msg.id, from: msg.from, to: msg.to, read: msg.read },
    source: 'mailbox',
  };
}

/** Convert an outbox MailboxMessage to a LogEvent (direction: out). */
export function outboxMessageToLogEvent(msg: MailboxMessage, agent: string, team?: string): LogEvent {
  return {
    timestamp: msg.createdAt,
    kind: 'message',
    agent,
    team,
    direction: 'out',
    peer: msg.to,
    text: msg.body,
    data: { messageId: msg.id, from: msg.from, to: msg.to },
    source: 'mailbox',
  };
}

/** Convert a ChatMessage to a LogEvent. */
export function chatMessageToLogEvent(msg: ChatMessage, team: string): LogEvent {
  return {
    timestamp: msg.timestamp,
    kind: 'message',
    agent: msg.sender,
    team,
    text: msg.body,
    data: { chatId: msg.id, sender: msg.sender },
    source: 'chat',
  };
}

// ============================================================================
// Filtering & Sorting
// ============================================================================

/** Apply filters to log events. Order: since → kinds → last. */
export function applyLogFilter(events: LogEvent[], filter?: LogFilter): LogEvent[] {
  if (!filter) return events;

  let result = events;

  if (filter.since) {
    const sinceMs = new Date(filter.since).getTime();
    result = result.filter((e) => new Date(e.timestamp).getTime() >= sinceMs);
  }

  if (filter.kinds && filter.kinds.length > 0) {
    const kinds = new Set(filter.kinds);
    result = result.filter((e) => kinds.has(e.kind));
  }

  if (filter.last && filter.last > 0) {
    result = result.slice(-filter.last);
  }

  return result;
}

/** Sort events by timestamp ascending. */
export function sortByTimestamp(events: LogEvent[]): LogEvent[] {
  return events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

// ============================================================================
// SDK Audit Events
// ============================================================================

/** Map SDK event types to existing LogEventKind values. */
const SDK_KIND_MAP: Record<string, LogEventKind> = {
  'sdk.user.message': 'user',
  'sdk.assistant.message': 'assistant',
  'sdk.tool.summary': 'tool_call',
  'sdk.system': 'system',
  'sdk.result.success': 'system',
  'sdk.hook.started': 'system',
  'sdk.hook.response': 'system',
  'sdk.rate_limit': 'system',
};

/** Convert an audit_events row (entity_type=sdk_message) to a LogEvent. */
export function sdkAuditRowToLogEvent(row: AuditEventRow): LogEvent {
  const details = row.details ?? {};
  return {
    timestamp: typeof row.created_at === 'string' ? row.created_at : new Date(row.created_at).toISOString(),
    kind: SDK_KIND_MAP[row.event_type] ?? 'system',
    agent: row.actor ?? 'unknown',
    text: (details.textPreview as string) ?? (details.summaryPreview as string) ?? row.event_type,
    data: details,
    source: 'sdk',
  };
}

/**
 * Read SDK audit events for an agent from the audit_events table.
 * Filters by entity_type='sdk_message' AND actor=agentId.
 */
async function readSdkAuditEvents(agentId: string, filter?: LogFilter): Promise<LogEvent[]> {
  try {
    if (!(await isAvailable())) return [];
    const sql = await getConnection();

    const conditions = [`entity_type = 'sdk_message'`, 'actor = $1'];
    const values: unknown[] = [agentId];
    let paramIdx = 2;

    if (filter?.since) {
      conditions.push(`created_at >= $${paramIdx++}::timestamptz`);
      values.push(filter.since);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const limit = filter?.last ?? 500;

    const rows = (await sql.unsafe(
      `SELECT id, entity_type, entity_id, event_type, actor, details, created_at
       FROM audit_events ${where}
       ORDER BY created_at ASC
       LIMIT ${limit}`,
      values,
    )) as unknown as AuditEventRow[];

    const events: LogEvent[] = [];
    for (const row of rows) {
      // Only include event types we have a mapping for
      if (SDK_KIND_MAP[row.event_type]) {
        events.push(sdkAuditRowToLogEvent(row));
      }
    }

    // Apply kinds filter if specified
    if (filter?.kinds && filter.kinds.length > 0) {
      const kinds = new Set(filter.kinds);
      return events.filter((e) => kinds.has(e.kind));
    }

    return events;
  } catch {
    return [];
  }
}

// ============================================================================
// Aggregators
// ============================================================================

/**
 * Read a unified log for a single agent.
 * Aggregates: transcript, mailbox inbox, mailbox outbox, team chat.
 */
export async function readAgentLog(agent: Agent, repoPath: string, filter?: LogFilter): Promise<LogEvent[]> {
  const agentName = agent.id;
  const team = agent.team;
  const mailboxKeys = mailboxActorKeys(agent);

  // Read all sources in parallel
  const [transcriptEntries, inboxMessages, outboxMessages, chatMessages, sdkEvents] = await Promise.all([
    readTranscriptSafe(agent),
    inbox(repoPath, mailboxKeys),
    readOutbox(repoPath, mailboxKeys),
    team ? readMessages(repoPath, team) : Promise.resolve([]),
    readSdkAuditEvents(agentName, filter),
  ]);

  // Convert to LogEvents
  const events: LogEvent[] = [];

  for (const entry of transcriptEntries) {
    const event = transcriptToLogEvent(entry, agentName, team);
    if (event) events.push(event);
  }

  for (const msg of inboxMessages) {
    events.push(inboxMessageToLogEvent(msg, agentName, team));
  }

  for (const msg of outboxMessages) {
    events.push(outboxMessageToLogEvent(msg, agentName, team));
  }

  if (team) {
    for (const msg of chatMessages) {
      events.push(chatMessageToLogEvent(msg, team));
    }
  }

  events.push(...sdkEvents);

  // Sort by time, then filter
  const sorted = sortByTimestamp(events);
  return applyLogFilter(sorted, filter);
}

/**
 * Read a unified log for all agents in a team.
 * Calls readAgentLog for each member and interleaves by timestamp.
 */
export async function readTeamLog(
  agents: Agent[],
  repoPath: string,
  teamName: string,
  filter?: LogFilter,
): Promise<LogEvent[]> {
  // Read team chat once (shared across all members)
  const chatMessages = await readMessages(repoPath, teamName);
  const chatEvents = chatMessages.map((msg) => chatMessageToLogEvent(msg, teamName));

  // Read per-agent sources in parallel (without team chat to avoid duplicates)
  const perAgentEvents = await Promise.all(
    agents.map(async (agent) => {
      const agentName = agent.id;
      const mailboxKeys = mailboxActorKeys(agent);

      const [transcriptEntries, inboxMessages, outboxMessages, sdkEvents] = await Promise.all([
        readTranscriptSafe(agent),
        inbox(repoPath, mailboxKeys),
        readOutbox(repoPath, mailboxKeys),
        readSdkAuditEvents(agentName, filter),
      ]);

      const events: LogEvent[] = [];
      for (const entry of transcriptEntries) {
        const event = transcriptToLogEvent(entry, agentName, teamName);
        if (event) events.push(event);
      }
      for (const msg of inboxMessages) {
        events.push(inboxMessageToLogEvent(msg, agentName, teamName));
      }
      for (const msg of outboxMessages) {
        events.push(outboxMessageToLogEvent(msg, agentName, teamName));
      }
      events.push(...sdkEvents);
      return events;
    }),
  );

  // Merge all sources
  const allEvents = [...chatEvents, ...perAgentEvents.flat()];
  const sorted = sortByTimestamp(allEvents);
  return applyLogFilter(sorted, filter);
}

// ============================================================================
// Follow Mode — Real-time Streaming
// ============================================================================

/** Callback for new events in follow mode. */
type LogEventCallback = (event: LogEvent) => void;

/** Handle returned by follow functions to stop streaming. */
interface FollowHandle {
  stop: () => Promise<void>;
  /** 'pg' when streaming from the PG event log */
  mode: 'pg';
}

/** Follow a single agent via the PG runtime event log. */
export async function followAgentLog(
  agent: Agent,
  repoPath: string,
  filter: LogFilter | undefined,
  onEvent: LogEventCallback,
): Promise<FollowHandle> {
  return startPgFollow([agent], repoPath, agent.team, filter, onEvent);
}

/** Follow a team via the PG runtime event log. */
export async function followTeamLog(
  agents: Agent[],
  repoPath: string,
  teamName: string,
  filter: LogFilter | undefined,
  onEvent: LogEventCallback,
): Promise<FollowHandle> {
  return startPgFollow(agents, repoPath, teamName, filter, onEvent);
}

/**
 * PG-first follow: wake up on LISTEN/NOTIFY, replay by event id cursor, and
 * filter by agent/team before emitting to the caller.
 *
 * Also polls audit_events for SDK agent events on the same interval.
 */
async function startPgFollow(
  agents: Agent[],
  repoPath: string,
  team: string | undefined,
  filter: LogFilter | undefined,
  onEvent: LogEventCallback,
): Promise<FollowHandle> {
  const kindsFilter = filter?.kinds ? new Set(filter.kinds) : null;
  const agentIds = new Set(agents.map((agent) => agent.id));
  const seenKeys = new Set<string>();

  const eventKey = (e: LogEvent): string => `${e.timestamp}|${e.kind}|${e.agent}|${e.text.slice(0, 80)}`;

  const dedupAndEmit = (event: LogEvent) => {
    if (!event.timestamp || !event.kind) return;
    if (kindsFilter && !kindsFilter.has(event.kind)) return;
    const key = eventKey(event);
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    onEvent(event);
  };

  const matchesScope = (event: RuntimeEvent) => {
    if (team === 'all') return true;
    if (team && event.team === team) return true;
    return agentIds.has(event.agent);
  };

  const handleRuntimeEvent = (event: RuntimeEvent) => {
    if (!matchesScope(event)) return;
    dedupAndEmit(event);
  };

  const handle = await followRuntimeEvents(
    {
      repoPath: team === 'all' ? undefined : repoPath,
      agentIds: team === 'all' ? undefined : [...agentIds],
      team: team && team !== 'all' ? team : undefined,
      kinds: filter?.kinds,
      scopeMode: team && team !== 'all' ? 'any' : 'all',
    },
    handleRuntimeEvent,
    {
      pollIntervalMs: 500,
    },
  );

  // SDK audit event poller — polls audit_events table for sdk_message events
  let sdkPollActive = true;
  let sdkLastId = 0;

  // Seed the cursor: get the max id so we only see new events
  try {
    if (await isAvailable()) {
      const sql = await getConnection();
      const [row] =
        await sql`SELECT COALESCE(MAX(id), 0) AS max_id FROM audit_events WHERE entity_type = 'sdk_message'`;
      sdkLastId = Number(row?.max_id ?? 0);
    }
  } catch {
    // Best effort — start from 0 if seed fails
  }

  const drainSdkAuditEvents = async () => {
    if (!(await isAvailable())) return;
    const sql = await getConnection();
    const agentList = [...agentIds];
    const rows = (await sql.unsafe(
      `SELECT id, entity_type, entity_id, event_type, actor, details, created_at
       FROM audit_events
       WHERE entity_type = 'sdk_message' AND id > $1
         AND actor = ANY($2)
       ORDER BY id ASC
       LIMIT 100`,
      [sdkLastId, agentList],
    )) as unknown as (AuditEventRow & { id: number })[];

    for (const row of rows) {
      if (SDK_KIND_MAP[row.event_type]) {
        dedupAndEmit(sdkAuditRowToLogEvent(row));
      }
      sdkLastId = Math.max(sdkLastId, Number(row.id));
    }
  };

  const sdkPoll = async () => {
    while (sdkPollActive) {
      try {
        await drainSdkAuditEvents();
      } catch {
        // Best effort — skip failed polls
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };

  // Start SDK poller in background
  sdkPoll();

  return {
    mode: 'pg',
    stop: async () => {
      sdkPollActive = false;
      await handle.stop();
    },
  };
}

// ============================================================================
// Helpers
// ============================================================================

/** Safely read transcript entries, returning [] on any error. */
async function readTranscriptSafe(agent: Agent): Promise<TranscriptEntry[]> {
  try {
    const { readTranscript } = await import('./transcript.js');
    return await readTranscript(agent);
  } catch {
    return [];
  }
}
