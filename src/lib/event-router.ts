/**
 * Event Router — Subscription-based routing from PG NOTIFY channels to team members.
 *
 * Listens on all NOTIFY channels and routes events based on each team's
 * event_subscriptions config (preset + overrides). Events are delivered to:
 *   1. Task conversation (system message)
 *   2. Team-lead mailbox
 *   3. Runtime event log
 */

import { getConnection } from './db.js';
import { send as sendMailbox } from './mailbox.js';
import { publishRuntimeEvent } from './runtime-events.js';
import { type Actor, commentOnTask } from './task-service.js';
import { type EventSubscriptionConfig, getTeam, listTeams, shouldRouteEvent } from './team-manager.js';

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

    case 'genie_request': {
      // Payload: id:agent_id:type:status
      const parts = raw.split(':');
      if (parts.length < 4) return null;
      const eventType = parts[3] === 'pending' ? 'request.created' : `request.${parts[3]}`;
      return {
        channel,
        eventType,
        payload: { requestId: parts[0], agentId: parts[1], type: parts[2], status: parts[3] },
        agentId: parts[1],
        summary: `Request ${parts[2]} from ${parts[1]}: ${parts[3]}`,
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

/** Resolve which teams should receive an event. */
async function resolveTargetTeams(
  event: ParsedEvent,
): Promise<{ teamName: string; config: EventSubscriptionConfig }[]> {
  const teams = await listTeams();
  const targets: { teamName: string; config: EventSubscriptionConfig }[] = [];

  for (const team of teams) {
    if (team.status !== 'in_progress') continue;
    const config = team.eventSubscriptions ?? { preset: 'actionable' as const };
    if (shouldRouteEvent(config, event.eventType)) {
      targets.push({ teamName: team.name, config });
    }
  }

  return targets;
}

/** Deliver an event to a single team's destinations. */
async function deliverToTeam(event: ParsedEvent, teamName: string): Promise<void> {
  const team = await getTeam(teamName);
  if (!team) return;

  const message = `[${event.eventType}] ${event.summary}`;
  const systemActor: Actor = { actorType: 'local', actorId: 'system' };

  // 1. Post to task conversation if event has a taskId
  if (event.taskId) {
    try {
      await commentOnTask(event.taskId, systemActor, message, team.repo);
    } catch {
      // Task might not exist — best effort
    }
  }

  // 2. Deliver to team-lead mailbox
  if (team.leader) {
    try {
      await sendMailbox(team.repo, 'system', team.leader, message);
    } catch {
      // Best effort
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
      data: { channel: event.channel, eventType: event.eventType, ...event.payload },
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
  for (const { teamName } of targets) {
    await deliverToTeam(event, teamName);
  }
}

// ============================================================================
// Event Router — LISTEN/NOTIFY subscriber
// ============================================================================

const CHANNELS = [
  'genie_task_stage',
  'genie_executor_state',
  'genie_request',
  'genie_message',
  'genie_audit_event',
] as const;

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
 * Pure function to check if an event type should be routed given a config.
 * Re-exported from team-manager for convenience.
 */
export { shouldRouteEvent } from './team-manager.js';

/**
 * Parse a raw NOTIFY payload. Exported for testing.
 */
export { parseNotifyPayload };
