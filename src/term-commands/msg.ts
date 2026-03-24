/**
 * Send / Inbox / Broadcast / Chat — PG-backed messaging commands between agents.
 *
 * Replaces file-based mailbox (.genie/mailbox/*.json) and team chat (.genie/chat/*.jsonl)
 * with PG conversations + messages tables.
 *
 * Commands:
 *   genie send '<msg>' --to <name>                    — DM via PG conversation
 *   genie broadcast '<msg>'                            — Send to team conversation
 *   genie inbox                                        — List conversations with recent messages
 *   genie chat <conversation_id> '<msg>'               — Send to specific conversation
 *   genie chat thread <message_id>                     — Create threaded sub-conversation
 *   genie chat list                                    — List conversations with filters
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import type * as registryTypes from '../lib/agent-registry.js';
import type * as taskServiceTypes from '../lib/task-service.js';
import type * as teamManagerTypes from '../lib/team-manager.js';

// ============================================================================
// Lazy Loaders
// ============================================================================

let _registry: typeof registryTypes | undefined;
async function getRegistry(): Promise<typeof registryTypes> {
  if (!_registry) _registry = await import('../lib/agent-registry.js');
  return _registry;
}

let _taskService: typeof taskServiceTypes | undefined;
async function getTaskService(): Promise<typeof taskServiceTypes> {
  if (!_taskService) _taskService = await import('../lib/task-service.js');
  return _taskService;
}

let _teamManager: typeof teamManagerTypes | undefined;
async function getTeamManager(): Promise<typeof teamManagerTypes> {
  if (!_teamManager) _teamManager = await import('../lib/team-manager.js');
  return _teamManager;
}

// ============================================================================
// Sender Identity Detection
// ============================================================================

/**
 * Auto-detect the sender identity based on execution context.
 *
 * Detection cascade:
 *   1. GENIE_AGENT_NAME env var (explicit override)
 *   2. TMUX_PANE -> worker registry (findByPane) -> role or id
 *   3. TMUX_PANE -> native team config members (match tmuxPaneId) -> name
 *   4. Fallback: 'cli'
 */
export async function detectSenderIdentity(teamName?: string): Promise<string> {
  const envName = process.env.GENIE_AGENT_NAME;
  if (envName) return envName;

  const paneId = process.env.TMUX_PANE;
  if (!paneId) return 'cli';

  const registry = await getRegistry();
  const worker = typeof registry.findByPane === 'function' ? await registry.findByPane(paneId) : null;
  if (worker) return worker.role ?? worker.id;

  const resolvedTeam = teamName ?? process.env.GENIE_TEAM;
  if (resolvedTeam) {
    const memberName = await findMemberByPane(resolvedTeam, paneId);
    if (memberName) return memberName;
  }

  return 'cli';
}

/** Look up a pane ID in the native team config and return the member name. */
async function findMemberByPane(teamName: string, paneId: string): Promise<string | null> {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const sanitized = teamName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  const cfgPath = join(configDir, 'teams', sanitized, 'config.json');
  try {
    const raw = await readFile(cfgPath, 'utf-8');
    const config = JSON.parse(raw);
    const members: { tmuxPaneId?: string; name: string }[] = config.members ?? [];
    const match = members.find((m) => m.tmuxPaneId === paneId);
    return match?.name ?? null;
  } catch {
    return null;
  }
}

// ============================================================================
// Scope Checking
// ============================================================================

/**
 * Enforce team scope: if sender is in a team, recipient must be in the same team.
 * Returns an error message if scope is violated, null if OK.
 */
export async function checkSendScope(_repoPath: string, sender: string, recipient: string): Promise<string | null> {
  if (sender === 'cli') return null;

  const teamManager = await getTeamManager();
  const teams = await teamManager.listTeams();

  const senderTeams = resolveSenderTeams(teams, sender);
  if (senderTeams.length === 0) return null;

  for (const team of senderTeams) {
    if (isRecipientInTeam(team, recipient)) return null;
  }

  const teamNames = senderTeams.map((t) => t.name).join(', ');
  return `Scope violation: "${recipient}" is not in sender's team(s): ${teamNames}`;
}

/** Build the list of teams the sender belongs to, including env-based team-lead membership. */
function resolveSenderTeams(teams: teamManagerTypes.TeamConfig[], sender: string): teamManagerTypes.TeamConfig[] {
  let senderTeams = teams.filter((t) => t.members.includes(sender));

  if (sender === 'team-lead') {
    const envTeam = process.env.GENIE_TEAM;
    if (envTeam) {
      const leaderTeam = teams.find((t) => t.name === envTeam);
      if (leaderTeam && !senderTeams.some((t) => t.name === leaderTeam.name)) {
        senderTeams = [...senderTeams, leaderTeam];
      }
    }
  }

  return senderTeams;
}

/** Check whether a recipient is reachable within a given team (direct member, team-lead, or prefixed name). */
function isRecipientInTeam(team: teamManagerTypes.TeamConfig, recipient: string): boolean {
  if (team.members.includes(recipient) || recipient === 'team-lead') return true;
  if (recipient.startsWith(`${team.name}-`)) {
    const roleOnly = recipient.slice(team.name.length + 1);
    if (team.members.includes(roleOnly)) return true;
  }
  return false;
}

/**
 * Find the team for a given agent (for broadcast and chat auto-detection).
 */
async function findAgentTeam(_repoPath: string, agentName: string): Promise<teamManagerTypes.TeamConfig | null> {
  const teamManager = await getTeamManager();
  const teams = await teamManager.listTeams();

  const memberTeam = teams.find((t) => t.members.includes(agentName));
  if (memberTeam) return memberTeam;

  if (agentName === 'team-lead') {
    const envTeam = process.env.GENIE_TEAM;
    if (envTeam) return teams.find((t) => t.name === envTeam) ?? null;
  }

  return null;
}

// ============================================================================
// Actor Helpers
// ============================================================================

function localActor(name: string): taskServiceTypes.Actor {
  return { actorType: 'local', actorId: name };
}

// ============================================================================
// Display Helpers
// ============================================================================

function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}

function truncate(str: string, len: number): string {
  return str.length <= len ? str : `${str.slice(0, len - 1)}…`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Resolve team name from explicit option, agent lookup, or env var. Exits on failure. */
async function resolveTeamName(explicit: string | undefined, repoPath: string, from: string): Promise<string> {
  if (explicit) return explicit;
  const team = await findAgentTeam(repoPath, from);
  const name = team?.name ?? process.env.GENIE_TEAM;
  if (!name) {
    console.error('Error: Could not auto-detect team. Use --team <name>.');
    process.exit(1);
  }
  return name;
}

// ============================================================================
// Extracted Handlers
// ============================================================================

async function handleInbox(agent: string | undefined, options: { json?: boolean }): Promise<void> {
  const ts = await getTaskService();
  const resolvedAgent = agent ?? (await detectSenderIdentity());
  const actor = localActor(resolvedAgent);
  const conversations = await ts.listConversations(actor);

  if (options.json) {
    console.log(JSON.stringify(conversations, null, 2));
    return;
  }

  if (conversations.length === 0) {
    console.log(`No conversations for "${resolvedAgent}".`);
    return;
  }

  console.log('');
  console.log(`INBOX: ${resolvedAgent}`);
  console.log('─'.repeat(60));

  for (const conv of conversations) {
    await printConversationSummary(ts, conv);
  }
}

async function printConversationSummary(
  ts: typeof taskServiceTypes,
  conv: taskServiceTypes.ConversationRow,
): Promise<void> {
  const messages = await ts.getMessages(conv.id, { limit: 1 });
  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
  const name = conv.name ?? conv.id;
  const type = conv.type === 'dm' ? 'DM' : 'Group';
  const linked = conv.linkedEntity ? ` [${conv.linkedEntity}:${conv.linkedEntityId}]` : '';
  const preview = lastMsg ? truncate(lastMsg.body, 50) : '(no messages)';
  const time = lastMsg ? formatTime(lastMsg.createdAt) : '';

  console.log(`  ${padRight(name, 30)} ${padRight(type, 6)}${linked}`);
  if (lastMsg) {
    console.log(`    ${time} ${lastMsg.senderId}: ${preview}`);
  }
  console.log('');
}

async function handleChatThread(messageId: string, options: { name?: string; from?: string }): Promise<void> {
  const ts = await getTaskService();
  const from = options.from ?? (await detectSenderIdentity());
  const actor = localActor(from);

  const parentMsgId = Number(messageId);
  const parentMsg = await ts.getMessage(parentMsgId);
  if (!parentMsg) {
    console.error(`Error: Message not found: ${messageId}`);
    process.exit(1);
  }

  const conv = await ts.findOrCreateConversation({
    type: 'group',
    name: options.name ?? `Thread on message #${parentMsgId}`,
    parentMessageId: parentMsgId,
    createdBy: actor,
    members: [actor],
  });

  console.log(`Thread created: ${conv.id}`);
  console.log(`  Parent message: #${parentMsgId} in ${parentMsg.conversationId}`);
  console.log(`  Name: ${conv.name ?? '(unnamed)'}`);
}

function printConversationTable(conversations: taskServiceTypes.ConversationRow[]): void {
  console.log(
    `  ${padRight('ID', 20)} ${padRight('NAME', 25)} ${padRight('TYPE', 8)} ${padRight('LINKED', 20)} ${'UPDATED'}`,
  );
  console.log(`  ${'─'.repeat(80)}`);

  for (const c of conversations) {
    const name = truncate(c.name ?? '(unnamed)', 23);
    const linked = c.linkedEntity ? `${c.linkedEntity}:${c.linkedEntityId}` : '-';
    const updated = formatTime(c.updatedAt);
    console.log(
      `  ${padRight(c.id, 20)} ${padRight(name, 25)} ${padRight(c.type, 8)} ${padRight(linked, 20)} ${updated}`,
    );
  }

  console.log(`\n  ${conversations.length} conversation${conversations.length === 1 ? '' : 's'}`);
}

async function handleChatList(options: {
  type?: string;
  linked?: string;
  json?: boolean;
  from?: string;
}): Promise<void> {
  const ts = await getTaskService();
  const from = options.from ?? (await detectSenderIdentity());
  const actor = localActor(from);

  let conversations = await ts.listConversations(actor);

  if (options.type) {
    conversations = conversations.filter((c) => c.type === options.type);
  }
  if (options.linked) {
    conversations = conversations.filter((c) => c.linkedEntity === options.linked);
  }

  if (options.json) {
    console.log(JSON.stringify(conversations, null, 2));
    return;
  }

  if (conversations.length === 0) {
    console.log('No conversations found.');
    return;
  }

  printConversationTable(conversations);
}

async function handleChatRead(
  conversationId: string,
  options: { since?: string; limit?: string; json?: boolean },
): Promise<void> {
  const ts = await getTaskService();
  const conv = await ts.getConversation(conversationId);
  if (!conv) {
    console.error(`Error: Conversation not found: ${conversationId}`);
    process.exit(1);
  }

  const messages = await ts.getMessages(conversationId, {
    since: options.since,
    limit: Number(options.limit) || 50,
  });

  if (options.json) {
    console.log(JSON.stringify(messages, null, 2));
    return;
  }

  const name = conv.name ?? conversationId;
  if (messages.length === 0) {
    console.log(`No messages in "${name}".`);
    return;
  }

  console.log('');
  console.log(`CHAT: ${name}`);
  console.log('─'.repeat(60));

  for (const msg of messages) {
    const time = formatTime(msg.createdAt);
    const reply = msg.replyToId ? ` (reply to #${msg.replyToId})` : '';
    console.log(`  [${time}] ${msg.senderId}: ${msg.body}${reply}`);
  }
  console.log('');
}

// ============================================================================
// Command Registration
// ============================================================================

export function registerSendInboxCommands(program: Command): void {
  // ── genie send ──
  program
    .command('send <body>')
    .description('Send a direct message to an agent (PG-backed)')
    .option('--to <agent>', 'Recipient agent name (default: team-lead)', 'team-lead')
    .option('--from <sender>', 'Sender ID (auto-detected from context)')
    .action(async (body: string, options: { to: string; from?: string }) => {
      try {
        const ts = await getTaskService();
        const repoPath = process.cwd();
        const from = options.from ?? (await detectSenderIdentity());

        // Scope check
        const scopeError = await checkSendScope(repoPath, from, options.to);
        if (scopeError) {
          console.error(`Error: ${scopeError}`);
          process.exit(1);
        }

        const senderActor = localActor(from);
        const recipientActor = localActor(options.to);

        // Find or create DM conversation
        const conv = await ts.findOrCreateConversation({
          type: 'dm',
          members: [senderActor, recipientActor],
          createdBy: senderActor,
        });

        // Ensure both are members
        await ts.addMember(conv.id, senderActor);
        await ts.addMember(conv.id, recipientActor);

        const msg = await ts.sendMessage(conv.id, senderActor, body);

        // Bridge to CC native inbox so Claude Code agents receive in real-time
        // Search ALL teams for the recipient, not just the current team
        try {
          const nativeTeams = await import('../lib/claude-native-teams.js');
          const nativeMsg = {
            from,
            text: body,
            summary: body.length > 50 ? `${body.substring(0, 50)}...` : body,
            timestamp: new Date().toISOString(),
            color: 'blue' as const,
            read: false,
          };

          // Try current team first (fast path)
          const currentTeam = await nativeTeams.discoverTeamName().catch(() => null);
          let delivered = false;

          if (currentTeam) {
            const config = await nativeTeams.loadConfig(currentTeam).catch(() => null);
            const memberExists = config?.members?.some(
              (m: { name?: string; agentId?: string }) =>
                m.name === options.to || m.agentId === `${options.to}@${currentTeam}`,
            );
            if (memberExists) {
              await nativeTeams.writeNativeInbox(currentTeam, options.to, nativeMsg);
              delivered = true;
            }
          }

          // If not in current team, search all teams
          if (!delivered) {
            const allTeams = await nativeTeams.listTeams().catch(() => [] as string[]);
            for (const team of allTeams) {
              if (team === currentTeam) continue; // already checked
              const config = await nativeTeams.loadConfig(team).catch(() => null);
              const memberExists = config?.members?.some(
                (m: { name?: string; agentId?: string }) =>
                  m.name === options.to || m.agentId === `${options.to}@${team}`,
              );
              if (memberExists) {
                await nativeTeams.writeNativeInbox(team, options.to, nativeMsg);
                break;
              }
            }
          }
        } catch {
          // Native inbox delivery is best-effort — PG message already persisted
        }

        console.log(`Message sent to "${options.to}".`);
        console.log(`  ID: ${msg.id}`);
        console.log(`  Conversation: ${conv.id}`);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // ── genie broadcast ──
  program
    .command('broadcast <body>')
    .description('Send a message to your team conversation (PG-backed)')
    .option('--from <sender>', 'Sender ID (auto-detected from context)')
    .option('--team <name>', 'Team name (auto-detected from context)')
    .action(async (body: string, options: { from?: string; team?: string }) => {
      try {
        const ts = await getTaskService();
        const repoPath = process.cwd();
        const from = options.from ?? (await detectSenderIdentity());
        const teamName = await resolveTeamName(options.team, repoPath, from);

        const senderActor = localActor(from);

        // Find or create team conversation
        const conv = await ts.findOrCreateConversation({
          type: 'group',
          name: `Team: ${teamName}`,
          linkedEntity: 'team',
          linkedEntityId: teamName,
          createdBy: senderActor,
          members: [senderActor],
        });

        // Ensure sender is member
        await ts.addMember(conv.id, senderActor);

        const msg = await ts.sendMessage(conv.id, senderActor, body);
        console.log(`Broadcast sent to team "${teamName}".`);
        console.log(`  Message ID: ${msg.id}`);
        console.log(`  Conversation: ${conv.id}`);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // ── genie inbox ──
  program
    .command('inbox [agent]')
    .description('List conversations with recent messages (PG-backed)')
    .option('--json', 'Output as JSON')
    .action(async (agent: string | undefined, options: { json?: boolean }) => {
      try {
        await handleInbox(agent, options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // ── genie chat ──
  const chat = program.command('chat').description('Conversation management (PG-backed)');

  chat
    .command('send <conversationId> <message>')
    .description('Send a message to a specific conversation')
    .option('--reply-to <msgId>', 'Reply to a specific message ID')
    .option('--from <sender>', 'Sender ID (auto-detected)')
    .action(async (conversationId: string, message: string, options: { replyTo?: string; from?: string }) => {
      try {
        const ts = await getTaskService();
        const from = options.from ?? (await detectSenderIdentity());
        const actor = localActor(from);
        const replyTo = options.replyTo ? Number(options.replyTo) : undefined;
        const msg = await ts.sendMessage(conversationId, actor, message, replyTo);
        console.log(`Message #${msg.id} sent to conversation ${conversationId}.`);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  chat
    .command('thread <messageId>')
    .description('Create a threaded sub-conversation from a message')
    .option('--name <name>', 'Thread name')
    .option('--from <sender>', 'Sender ID (auto-detected)')
    .action(async (messageId: string, options: { name?: string; from?: string }) => {
      try {
        await handleChatThread(messageId, options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  chat
    .command('list')
    .description('List conversations with filters')
    .option('--type <type>', 'Filter by type: dm, group')
    .option('--linked <entity>', 'Filter by linked entity: task, team')
    .option('--json', 'Output as JSON')
    .option('--from <sender>', 'Actor ID (auto-detected)')
    .action(async (options: { type?: string; linked?: string; json?: boolean; from?: string }) => {
      try {
        await handleChatList(options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  chat
    .command('read <conversationId>')
    .description('Read messages in a conversation')
    .option('--since <timestamp>', 'Show messages since timestamp')
    .option('--limit <n>', 'Limit number of messages', '50')
    .option('--json', 'Output as JSON')
    .action(async (conversationId: string, options: { since?: string; limit?: string; json?: boolean }) => {
      try {
        await handleChatRead(conversationId, options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });
}
