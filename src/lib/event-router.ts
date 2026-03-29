/**
 * Event Router — Hardcoded actionable routing from PG NOTIFY channels to team members.
 *
 * Listens on NOTIFY channels and routes actionable events (blocked, error,
 * permission, request) to team members. Events are delivered to:
 *   1. Task conversation (system message)
 *   2. Team-lead mailbox (PG + native inbox via provider)
 *   3. Runtime event log
 */

import { randomUUID } from 'node:crypto';
import { getConnection } from './db.js';
import { send as sendMailbox } from './mailbox.js';
import { getProvider } from './providers/registry.js';
import { publishRuntimeEvent } from './runtime-events.js';
import { type Actor, commentOnTask } from './task-service.js';
import { getTeam, listTeams } from './team-manager.js';

// ============================================================================
// Types
// ============================================================================

interface ParsedEvent {
  channel: string;
  eventType: string;
  payload: Record<string, unknown>;
  teamName?: string;
  taskId?: string;
  agentId?: string;
  summary: string;
}

type EventHandler = (event: ParsedEvent) => Promise<void>;

// ============================================================================
// Channel Parsers
// ============================================================================

/** Parse NOTIFY payload into a structured event. Channel-specific parsing. */
function parseNotifyPayload(channel: string, raw: string): ParsedEvent | null {
  switch (channel) {
    case 'genie_task_stage': {
      // Payload: task_id:from_stage:to_stage
      const parts = raw.split(':');
      if (parts.length < 3) return null;
      return {
        channel,
        eventType: 'task.stage_change',
        payload: { taskId: parts[0], fromStage: parts[1], toStage: parts[2] },
        taskId: parts[0],
        summary: `Task ${parts[0]} moved from ${parts[1]} to ${parts[2]}`,
      };
    }

    case 'genie_executor_state': {
      // Payload: executor_id:agent_id:old_state:new_state
      const parts = raw.split(':');
      if (parts.length < 4) return null;
      const eventType = parts[3] === 'error' ? 'executor.error' : 'executor.state_change';
      return {
        channel,
        eventType,
        payload: { executorId: parts[0], agentId: parts[1], oldState: parts[2], newState: parts[3] },
        agentId: parts[1],
        summary: `${parts[1]} state: ${parts[2]} → ${parts[3]}`,
      };
    }

    case 'genie_message': {
      // Payload: message_id:conversation_id
      const parts = raw.split(':');
      if (parts.length < 2) return null;
      return {
        channel,
        eventType: 'task.comment',
        payload: { messageId: parts[0], conversationId: parts[1] },
        summary: `New message in conversation ${parts[1]}`,
      };
    }

    case 'genie_audit_event': {
      // Payload: entity_type:entity_id:event_type
      const parts = raw.split(':');
      if (parts.length < 3) return null;
      return {
        channel,
        eventType: `${parts[0]}.${parts[2]}`,
        payload: { entityType: parts[0], entityId: parts[1], auditEventType: parts[2] },
        summary: `${parts[0]} ${parts[1]}: ${parts[2]}`,
      };
    }

    default:
      return null;
  }
}

// ============================================================================
// Routing Logic
// ============================================================================

/** Hardcoded actionable event types — events that require team-lead attention. */
const ACTIONABLE_EVENTS = new Set([
  'task.blocked',
  'executor.error',
  'executor.permission',
  'task.stage_change',
  'task.comment',
]);

/** Check if an event type is actionable (or is a request message). */
function isActionableEvent(eventType: string): boolean {
  return ACTIONABLE_EVENTS.has(eventType) || eventType.startsWith('request.');
}

/** Resolve which teams should receive an event. */
async function resolveTargetTeams(event: ParsedEvent): Promise<string[]> {
  if (!isActionableEvent(event.eventType)) return [];

  const teams = await listTeams();
  return teams.filter((t) => t.status === 'in_progress').map((t) => t.name);
}

/** Write to PG mailbox with trace_id, falling back to legacy send. */
async function writeMailbox(repoPath: string, leader: string, message: string, traceId: string): Promise<void> {
  try {
    const sql = await getConnection();
    await sql`
      INSERT INTO mailbox (id, repo_path, "from", "to", body, trace_id, created_at)
      VALUES (${`mail-${traceId}`}, ${repoPath}, 'system', ${leader}, ${message}, ${traceId}, now())
    `;
  } catch {
    try {
      await sendMailbox(repoPath, 'system', leader, message);
    } catch {
      // Best effort
    }
  }
}

/** Deliver message via provider's native inbox (e.g. Claude Code's ~/.claude/teams inbox). */
async function deliverViaProvider(leader: string, teamName: string, message: string, traceId: string): Promise<void> {
  const sql = await getConnection();
  const rows = await sql`
    SELECT e.id AS executor_id, e.provider
    FROM agents a
    JOIN executors e ON a.current_executor_id = e.id
    WHERE a.custom_name = ${leader}
      AND a.team = ${teamName}
      AND e.state NOT IN ('terminated', 'done', 'error')
    LIMIT 1
  `;
  if (rows.length > 0) {
    const provider = getProvider(rows[0].provider);
    if (provider?.deliverMessage) {
      await provider.deliverMessage(rows[0].executor_id, { text: message, traceId });
    }
  }
}

/** Deliver an event to a single team's destinations. */
async function deliverToTeam(event: ParsedEvent, teamName: string): Promise<void> {
  const team = await getTeam(teamName);
  if (!team) return;

  const traceId = randomUUID();
  const message = `[${event.eventType}] ${event.summary}`;

  // 1. Post to task conversation if event has a taskId
  if (event.taskId) {
    const systemActor: Actor = { actorType: 'local', actorId: 'system' };
    try {
      await commentOnTask(event.taskId, systemActor, message, team.repo);
    } catch {
      // Task might not exist — best effort
    }
  }

  // 2. Deliver to team-lead — PG mailbox (audit trail) + native inbox via provider
  if (team.leader) {
    await writeMailbox(team.repo, team.leader, message, traceId);
    try {
      await deliverViaProvider(team.leader, teamName, message, traceId);
    } catch {
      // Best effort — PG mailbox already written
    }
  }

  // 3. Log as runtime event
  try {
    await publishRuntimeEvent({
      repoPath: team.repo,
      kind: 'system',
      agent: event.agentId ?? 'system',
      team: teamName,
      text: event.summary,
      source: 'hook',
      threadId: event.taskId ? `task:${event.taskId}` : `team:${teamName}`,
      data: { channel: event.channel, eventType: event.eventType, traceId, ...event.payload },
    });
  } catch {
    // Best effort
  }
}

/** Route an event to all appropriate destinations. */
async function routeEvent(event: ParsedEvent, handler?: EventHandler): Promise<void> {
  if (handler) {
    await handler(event);
    return;
  }

  const targets = await resolveTargetTeams(event);
  for (const teamName of targets) {
    await deliverToTeam(event, teamName);
  }
}

// ============================================================================
// Event Router — LISTEN/NOTIFY subscriber
// ============================================================================

const CHANNELS = ['genie_task_stage', 'genie_executor_state', 'genie_message', 'genie_audit_event'] as const;

export interface EventRouterHandle {
  stop: () => Promise<void>;
}

/**
 * Start the event router — listens on all NOTIFY channels and routes events
 * based on team subscription configs.
 *
 * @param handler Optional custom handler for testing/overriding routing behavior.
 */
export async function startEventRouter(handler?: EventHandler): Promise<EventRouterHandle> {
  const sql = await getConnection();
  const listeners: Array<{ unlisten: () => Promise<void> }> = [];

  for (const channel of CHANNELS) {
    const listener = await sql.listen(channel, (payload: string) => {
      const event = parseNotifyPayload(channel, payload);
      if (!event) return;
      void routeEvent(event, handler).catch(() => {
        // Swallow errors — event routing is best-effort
      });
    });
    listeners.push(listener);
  }

  return {
    stop: async () => {
      for (const listener of listeners) {
        await listener.unlisten();
      }
    },
  };
}

/**
 * Parse a raw NOTIFY payload. Exported for testing.
 */
export { parseNotifyPayload };
