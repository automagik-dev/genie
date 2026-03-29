/**
 * Brief — Startup context aggregator for agents.
 *
 * Aggregates from 5 sources in parallel to give an agent a complete picture
 * of what happened since its last session:
 *   1. Unread mailbox messages
 *   2. Task conversation messages since last session
 *   3. Runtime events since last executor ended
 *   4. Pending agent requests for the team
 *   5. Team roster with executor states
 */

import { type AgentRequest, getPendingRequests } from './agent-requests.js';
import { getConnection } from './db.js';
import { type MailboxMessage, getUnread } from './mailbox.js';
import { type RuntimeEvent, listRuntimeEvents } from './runtime-events.js';
import { getTeam } from './team-manager.js';

// ============================================================================
// Types
// ============================================================================

export interface BriefOptions {
  team: string;
  agent?: string;
  since?: string;
  repoPath?: string;
}

export interface TeamMemberStatus {
  agentId: string;
  role: string | null;
  executorState: string | null;
  executorStartedAt: string | null;
}

export interface Brief {
  team: string;
  agent: string | null;
  since: string;
  unreadMessages: MailboxMessage[];
  taskMessages: TaskConversationMessage[];
  recentEvents: RuntimeEvent[];
  pendingRequests: AgentRequest[];
  teamRoster: TeamMemberStatus[];
}

interface TaskConversationMessage {
  taskId: string;
  taskTitle: string;
  senderType: string;
  senderId: string;
  body: string;
  createdAt: string;
}

// ============================================================================
// Helpers
// ============================================================================

/** Resolve the "since" timestamp — last executor ended_at or explicit override. */
async function resolveSince(options: BriefOptions): Promise<string> {
  if (options.since) return options.since;

  // Try to find the agent's last executor ended_at via direct SQL
  if (options.agent) {
    const sql = await getConnection();
    const rows = await sql`
      SELECT e.ended_at FROM executors e
      JOIN agents a ON e.agent_id = a.id
      WHERE a.custom_name = ${options.agent}
        AND a.team = ${options.team}
        AND e.ended_at IS NOT NULL
      ORDER BY e.ended_at DESC
      LIMIT 1
    `;
    if (rows.length > 0 && rows[0].ended_at) {
      const endedAt = rows[0].ended_at;
      return endedAt instanceof Date ? endedAt.toISOString() : String(endedAt);
    }
  }

  // Default: 24 hours ago
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

/** Get task conversation messages since a timestamp for all tasks in a team. */
async function getTaskMessages(team: string, since: string): Promise<TaskConversationMessage[]> {
  const sql = await getConnection();
  const rows = await sql`
    SELECT m.body, m.sender_type, m.sender_id, m.created_at,
           t.id AS task_id, t.title AS task_title
    FROM messages m
    JOIN conversations c ON m.conversation_id = c.id
    JOIN tasks t ON c.linked_entity_id = t.id
    WHERE c.linked_entity = 'task'
      AND t.team_name = ${team}
      AND m.created_at > ${since}
    ORDER BY m.created_at ASC
    LIMIT 100
  `;

  return rows.map((r: Record<string, unknown>) => ({
    taskId: r.task_id as string,
    taskTitle: r.task_title as string,
    senderType: r.sender_type as string,
    senderId: r.sender_id as string,
    body: r.body as string,
    createdAt: r.created_at instanceof Date ? (r.created_at as Date).toISOString() : String(r.created_at),
  }));
}

/** Get team roster with executor states via single SQL query. */
async function getTeamRoster(teamName: string): Promise<TeamMemberStatus[]> {
  const sql = await getConnection();
  const rows = await sql`
    SELECT a.custom_name AS agent_id, a.role, e.state AS executor_state, e.started_at AS executor_started_at
    FROM agents a
    LEFT JOIN executors e ON a.current_executor_id = e.id
    WHERE a.team = ${teamName}
    ORDER BY a.custom_name
  `;

  return rows.map((r: Record<string, unknown>) => ({
    agentId: r.agent_id as string,
    role: (r.role as string) ?? null,
    executorState: (r.executor_state as string) ?? null,
    executorStartedAt: r.executor_started_at
      ? r.executor_started_at instanceof Date
        ? (r.executor_started_at as Date).toISOString()
        : String(r.executor_started_at)
      : null,
  }));
}

// ============================================================================
// Public API
// ============================================================================

/** Generate a startup brief for an agent, aggregating all 5 sources in parallel. */
export async function generateBrief(options: BriefOptions): Promise<Brief> {
  const teamConfig = await getTeam(options.team);
  if (!teamConfig) throw new Error(`Team not found: ${options.team}`);

  const since = await resolveSince(options);
  const repoPath = options.repoPath ?? teamConfig.repo;
  const agentName = options.agent ?? teamConfig.leader ?? null;
  const agentIdentifiers = agentName ? [agentName] : [];

  // Aggregate all 5 sources in parallel
  const [unreadMessages, taskMessages, recentEvents, pendingRequests, teamRoster] = await Promise.all([
    // 1. Unread mailbox messages
    agentIdentifiers.length > 0 ? getUnread(repoPath, agentIdentifiers) : Promise.resolve([]),

    // 2. Task conversation messages since last session
    getTaskMessages(options.team, since),

    // 3. Runtime events since last executor ended
    listRuntimeEvents({ team: options.team, since, limit: 100 }),

    // 4. Pending agent requests for the team
    getPendingRequests(options.team),

    // 5. Team roster with executor states
    getTeamRoster(options.team),
  ]);

  return {
    team: options.team,
    agent: agentName,
    since,
    unreadMessages,
    taskMessages,
    recentEvents,
    pendingRequests,
    teamRoster,
  };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function formatUnreadSection(messages: MailboxMessage[]): string[] {
  if (messages.length === 0) return [];
  const lines = [`## Unread Messages (${messages.length})`];
  for (const msg of messages) {
    lines.push(`- **${msg.from}**: ${truncate(msg.body, 120)}`);
  }
  lines.push('');
  return lines;
}

function formatTaskMessagesSection(messages: TaskConversationMessage[]): string[] {
  if (messages.length === 0) return [];
  const lines = [`## Task Updates (${messages.length})`];
  const byTask = new Map<string, TaskConversationMessage[]>();
  for (const msg of messages) {
    const existing = byTask.get(msg.taskId) ?? [];
    existing.push(msg);
    byTask.set(msg.taskId, existing);
  }
  for (const [taskId, msgs] of byTask) {
    lines.push(`### ${taskId}: ${msgs[0].taskTitle}`);
    for (const msg of msgs) {
      lines.push(`- [${msg.senderType}:${msg.senderId}] ${truncate(msg.body, 100)}`);
    }
  }
  lines.push('');
  return lines;
}

function formatRequestsSection(requests: AgentRequest[]): string[] {
  if (requests.length === 0) return [];
  const lines = [`## Pending Requests (${requests.length})`];
  for (const req of requests) {
    lines.push(`- [${req.type}] ${req.agentId}: ${truncate(JSON.stringify(req.payload), 80)}`);
  }
  lines.push('');
  return lines;
}

const STATE_ICONS: Record<string, string> = { working: '●', idle: '○', error: '✘' };

function formatRosterSection(roster: TeamMemberStatus[]): string[] {
  if (roster.length === 0) return [];
  const lines = [`## Team Roster (${roster.length})`];
  for (const member of roster) {
    const state = member.executorState ?? 'offline';
    const icon = STATE_ICONS[state] ?? '◌';
    lines.push(`- ${icon} **${member.agentId}** (${member.role ?? 'unassigned'}): ${state}`);
  }
  lines.push('');
  return lines;
}

function formatEventsSection(events: RuntimeEvent[]): string[] {
  if (events.length === 0) return [];
  const lines = [`## Recent Events (${events.length})`];
  const tail = events.slice(-10);
  for (const evt of tail) {
    const ts = evt.timestamp.slice(11, 16);
    lines.push(`- ${ts} [${evt.kind}] ${evt.agent}: ${truncate(evt.text, 80)}`);
  }
  if (events.length > 10) {
    lines.push(`  _(${events.length - 10} more events)_`);
  }
  lines.push('');
  return lines;
}

/** Format a brief as structured markdown for agent consumption. */
export function formatBrief(brief: Brief): string {
  const lines = [
    `# BRIEF — ${brief.team}${brief.agent ? ` ${brief.agent}` : ''}`,
    `Since: ${brief.since}`,
    '',
    ...formatUnreadSection(brief.unreadMessages),
    ...formatTaskMessagesSection(brief.taskMessages),
    ...formatRequestsSection(brief.pendingRequests),
    ...formatRosterSection(brief.teamRoster),
    ...formatEventsSection(brief.recentEvents),
  ];

  const hasActivity =
    brief.unreadMessages.length + brief.taskMessages.length + brief.pendingRequests.length + brief.recentEvents.length >
    0;
  if (!hasActivity) {
    lines.push('_No activity since last session._', '');
  }

  return lines.join('\n');
}
