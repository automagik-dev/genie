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
import { emitEvent } from '../lib/emit.js';
import type * as taskServiceTypes from '../lib/task-service.js';
import type * as teamManagerTypes from '../lib/team-manager.js';
import { formatTime, padRight, truncate } from '../lib/term-format.js';

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

let _mailbox: typeof import('../lib/mailbox.js') | undefined;
async function getMailbox(): Promise<typeof import('../lib/mailbox.js')> {
  if (!_mailbox) _mailbox = await import('../lib/mailbox.js');
  return _mailbox;
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
// Leader Alias Resolution
// ============================================================================

/**
 * Resolve the 'team-lead' alias to the actual leader name for a given team context.
 * Never returns 'team-lead' — falls back to teamName via resolveLeaderName().
 */
async function resolveLeaderAlias(recipient: string, teamContext?: string): Promise<string> {
  if (recipient !== 'team-lead') return recipient;

  const teamName = teamContext ?? process.env.GENIE_TEAM;
  if (teamName) {
    const teamManager = await getTeamManager();
    return teamManager.resolveLeaderName(teamName);
  }

  return recipient;
}

// ============================================================================
// Scope Checking
// ============================================================================

/**
 * Max depth of the parentTeam chain walk — defends against accidental cycles
 * and unbounded ancestor traversal.
 */
const PARENT_CHAIN_MAX_DEPTH = 3;

/**
 * Child-team-name prefixes that have cross-team reachback enabled by default
 * (without requiring the parent to explicitly list them in allowChildReachback).
 * Reflects the canonical use case: `/council` spawns ephemeral `council-<ts>`
 * sub-teams that need to reply to the caller's home team.
 */
const DEFAULT_REACHBACK_PREFIXES = ['council-'];

/**
 * Enforce team scope: if sender is in a team, recipient must be in the same team,
 * in a transitively reachable parent team (UP-walk), or in a reachable child
 * team (DOWN-walk) — all subject to the same `childReachbackAllowed` ALLOWLIST.
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

  // Parent → child reachback: align with the in-harness `SendMessage` routing.
  // A sender in a parent team may reach any child team whose parentTeam chain
  // resolves back to the sender's team, subject to the same reachback rules
  // used by the UP-walk. Treats the child team's name as the team-lead alias
  // (mirrors how native `SendMessage` routes `to: "<team-name>"`).
  const reachableChildren = resolveReachableChildren(teams, senderTeams);
  for (const child of reachableChildren) {
    if (recipient === child.name) return null;
    if (isRecipientInTeam(child, recipient)) return null;
  }

  const teamNames = senderTeams.map((t) => t.name).join(', ');
  return `Scope violation: "${recipient}" is not in sender's team(s): ${teamNames}`;
}

/**
 * Decide whether a child team is allowed to walk up into its declared parent.
 * A child may reach back when either:
 *   (a) the parent's `allowChildReachback` ALLOWLIST contains a prefix that
 *       matches the child team's name, OR
 *   (b) the child team's name starts with a DEFAULT_REACHBACK_PREFIXES entry
 *       (currently only `council-*`) — the zero-config path for ephemeral
 *       council sub-teams.
 */
function childReachbackAllowed(child: teamManagerTypes.TeamConfig, parent: teamManagerTypes.TeamConfig): boolean {
  const allowList = parent.allowChildReachback;
  if (allowList?.some((prefix) => child.name.startsWith(prefix))) return true;
  return DEFAULT_REACHBACK_PREFIXES.some((prefix) => child.name.startsWith(prefix));
}

/** Walk the parentTeam chain from a child team, appending reachable ancestors. */
function walkParentChain(
  teams: teamManagerTypes.TeamConfig[],
  start: teamManagerTypes.TeamConfig,
  visited: Set<string>,
  out: teamManagerTypes.TeamConfig[],
): void {
  let current = start;
  let depth = 0;
  while (current.parentTeam && depth < PARENT_CHAIN_MAX_DEPTH) {
    if (visited.has(current.parentTeam)) return;
    const parent = teams.find((t) => t.name === current.parentTeam);
    if (!parent) return;
    if (!childReachbackAllowed(current, parent)) return;
    out.push(parent);
    visited.add(parent.name);
    current = parent;
    depth++;
  }
}

/** DFS descendants of a parent team, collecting children allowed by reachback rules. */
function walkChildTeams(
  teams: teamManagerTypes.TeamConfig[],
  parent: teamManagerTypes.TeamConfig,
  visited: Set<string>,
  out: teamManagerTypes.TeamConfig[],
  depth: number,
): void {
  if (depth >= PARENT_CHAIN_MAX_DEPTH) return;
  for (const child of teams) {
    if (visited.has(child.name)) continue;
    if (child.parentTeam !== parent.name) continue;
    if (!childReachbackAllowed(child, parent)) continue;
    out.push(child);
    visited.add(child.name);
    walkChildTeams(teams, child, visited, out, depth + 1);
  }
}

/**
 * Collect all child teams transitively reachable from any of the sender's
 * teams, subject to the same `childReachbackAllowed` rules used by the
 * UP-walk. This is the parent → child direction that mirrors the in-harness
 * `SendMessage` routing.
 */
function resolveReachableChildren(
  teams: teamManagerTypes.TeamConfig[],
  senderTeams: teamManagerTypes.TeamConfig[],
): teamManagerTypes.TeamConfig[] {
  const visited = new Set<string>(senderTeams.map((t) => t.name));
  const result: teamManagerTypes.TeamConfig[] = [];
  for (const team of senderTeams) {
    walkChildTeams(teams, team, visited, result, 0);
  }
  return result;
}

/** Build the list of teams the sender belongs to, including env-based leader membership. */
export function resolveSenderTeams(
  teams: teamManagerTypes.TeamConfig[],
  sender: string,
): teamManagerTypes.TeamConfig[] {
  const direct = teams.filter((t) => t.members.includes(sender));
  const visited = new Set<string>(direct.map((t) => t.name));
  const result: teamManagerTypes.TeamConfig[] = [...direct];

  // Walk the parentTeam chain from each direct team — a sender in an
  // ephemeral sub-team (e.g. council-<ts>) transitively reaches the parent
  // team's members if the parent's ALLOWLIST (or the default council prefix)
  // permits it.
  for (const team of direct) {
    walkParentChain(teams, team, visited, result);
  }

  // Leader fallback: if sender is the leader (by name or legacy 'team-lead'
  // alias), include the leader's team resolved from the ambient GENIE_TEAM.
  const isLeader = teams.some((t) => t.leader === sender) || sender === 'team-lead';
  if (isLeader) {
    const envTeam = process.env.GENIE_TEAM;
    if (envTeam) {
      const leaderTeam = teams.find((t) => t.name === envTeam);
      if (leaderTeam && !visited.has(leaderTeam.name)) {
        result.push(leaderTeam);
        visited.add(leaderTeam.name);
        walkParentChain(teams, leaderTeam, visited, result);
      }
    }
  }

  return result;
}

/**
 * Resolve the nearest leader the sender can legitimately reach, used by the
 * `--bridge` escape hatch to print a manual-relay hint after a scope violation.
 * Prefers the sender's first direct team, falling back to the first reachable
 * ancestor in the chain. Returns null when the sender belongs to no team.
 */
export async function suggestRelayLeader(sender: string): Promise<{ leader: string; team: string } | null> {
  if (sender === 'cli') return null;
  const teamManager = await getTeamManager();
  const teams = await teamManager.listTeams();
  const reachable = resolveSenderTeams(teams, sender);
  if (reachable.length === 0) return null;
  const target = reachable[0];
  return { leader: target.leader ?? target.name, team: target.name };
}

/** Check whether a recipient is reachable within a given team (direct member, leader, or prefixed name). */
function isRecipientInTeam(team: teamManagerTypes.TeamConfig, recipient: string): boolean {
  // Direct member, actual leader name, or legacy 'team-lead' alias (backwards compat)
  if (team.members.includes(recipient) || recipient === team.leader || recipient === 'team-lead') return true;
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

  // Match by leader name or legacy 'team-lead' alias (backwards compat)
  if (agentName === 'team-lead' || teams.some((t) => t.leader === agentName)) {
    const envTeam = process.env.GENIE_TEAM;
    if (envTeam) return teams.find((t) => t.name === envTeam) ?? null;
    // Also find by leader field directly
    const leaderTeam = teams.find((t) => t.leader === agentName);
    if (leaderTeam) return leaderTeam;
  }

  return null;
}

// ============================================================================
// Actor Helpers
// ============================================================================

function localActor(name: string): taskServiceTypes.Actor {
  return { actorType: 'local', actorId: name };
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
// Native Inbox Bridge
// ============================================================================

/** Discover the current team name from env, native discovery, or worker registry. */
async function discoverCurrentTeam(
  nativeTeams: typeof import('../lib/claude-native-teams.js'),
  from: string,
  explicitTeam?: string,
): Promise<string | null> {
  if (explicitTeam) return explicitTeam;
  const discovered = await nativeTeams.discoverTeamName().catch(() => null);
  if (discovered) return discovered;

  const registryMod = await getRegistry();
  const workers = await registryMod.list();
  const senderWorker = workers.find((w) => w.role === from || w.id === from || w.customName === from);
  return senderWorker?.team ?? null;
}

/** Try delivering a native inbox message to a specific team. */
async function deliverToTeam(
  nativeTeams: typeof import('../lib/claude-native-teams.js'),
  team: string,
  recipient: string,
  msg: { from: string; text: string; summary: string; timestamp: string; color: 'blue'; read: false },
): Promise<boolean> {
  const nativeName = await nativeTeams.resolveNativeMemberName(team, recipient);
  if (!nativeName) return false;
  await nativeTeams.writeNativeInbox(team, nativeName, msg);
  return true;
}

/** Bridge a message to the Claude Code native inbox for real-time delivery. */
async function bridgeToNativeInbox(
  from: string,
  recipient: string,
  body: string,
  explicitTeam?: string,
): Promise<boolean> {
  // Skip native inbox bridge for self-sends to prevent echo loops (#818)
  if (from === recipient) return false;

  const nativeTeams = await import('../lib/claude-native-teams.js');
  const nativeMsg = {
    from,
    text: body,
    summary: body.length > 50 ? `${body.substring(0, 50)}...` : body,
    timestamp: new Date().toISOString(),
    color: 'blue' as const,
    read: false as const,
  };

  const currentTeam = await discoverCurrentTeam(nativeTeams, from, explicitTeam);

  // Try current team first (fast path)
  if (currentTeam && (await deliverToTeam(nativeTeams, currentTeam, recipient, nativeMsg))) return true;

  // Search all native teams
  const allTeams = await nativeTeams.listTeams().catch(() => [] as string[]);
  for (const team of allTeams) {
    if (team === currentTeam) continue;
    if (await deliverToTeam(nativeTeams, team, recipient, nativeMsg)) return true;
  }

  console.warn(`[genie send] Native inbox bridge: could not find native team member for "${recipient}"`);
  return false;
}

// ============================================================================
// Bridge Suggestion (--bridge escape hatch)
// ============================================================================

/** Shell-quote a single argument for a copy-paste-friendly command hint. */
function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Print an informational advisory when `--bridge` is used against a scope
 * violation: explains the violation, names the nearest reachable leader, and
 * emits a ready-to-run relay command. Exits 0 (informational) rather than 1
 * so scripts can keep going.
 */
export async function printBridgeSuggestion(
  sender: string,
  recipient: string,
  body: string,
  scopeError: string,
): Promise<void> {
  const suggestion = await suggestRelayLeader(sender);
  console.error(`Scope violation: ${scopeError}`);
  if (!suggestion) {
    console.error('No reachable leader found — sender is not bound to any team.');
    return;
  }
  // If the nearest reachable leader is the sender itself, the naïve relay
  // command would loop back to the sender. Print a clear no-op-avoidance
  // message instead of emitting a useless command.
  if (suggestion.leader === sender) {
    console.error(
      `You are already the nearest reachable leader (${suggestion.leader}@${suggestion.team}) — no external relay path available.`,
    );
    return;
  }
  console.error(`Nearest reachable leader: ${suggestion.leader}@${suggestion.team}`);
  console.error('Relay manually via:');
  console.error(
    `  genie send ${quoteForShell(`[relay to ${recipient}] ${body}`)} --to ${suggestion.leader} --team ${suggestion.team}`,
  );
}

// ============================================================================
// Send Handler
// ============================================================================

async function handleSend(
  body: string,
  options: { to: string; from?: string; team?: string; bridge?: boolean },
): Promise<void> {
  const ts = await getTaskService();
  const mailbox = await getMailbox();
  const repoPath = process.cwd();
  const from = options.from ?? (await detectSenderIdentity(options.team));

  // Resolve 'team-lead' alias to actual leader name
  const to = await resolveLeaderAlias(options.to, options.team);

  const scopeError = await checkSendScope(repoPath, from, to);
  if (scopeError) {
    if (options.bridge) {
      await printBridgeSuggestion(from, to, body, scopeError);
      return;
    }
    console.error(`Error: ${scopeError}`);
    process.exit(1);
  }

  const senderActor = localActor(from);
  const recipientActor = localActor(to);

  const conv = await ts.findOrCreateConversation({
    type: 'dm',
    members: [senderActor, recipientActor],
    createdBy: senderActor,
  });

  await ts.addMember(conv.id, senderActor);
  await ts.addMember(conv.id, recipientActor);

  const mailboxMessage = await mailbox.send(repoPath, from, to, body);
  const msg = await ts.sendMessage(conv.id, senderActor, body);

  // Emit runtime event for real-time observability (fire-and-forget)
  try {
    const { publishSubjectEvent } = await import('../lib/runtime-events.js');
    await publishSubjectEvent(repoPath, `genie.msg.${to}`, {
      kind: 'message',
      agent: from,
      direction: 'out',
      peer: to,
      text: body,
      data: { messageId: msg.id, conversationId: conv.id, from, to },
      source: 'mailbox',
    });
  } catch {
    // Event log unavailable — silent degradation
  }

  // Best-effort native inbox bridge
  const bridged = await bridgeToNativeInbox(from, to, body, options.team).catch((err) => {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[genie send] Native inbox bridge failed: ${reason}`);
    return false;
  });
  if (bridged) {
    await mailbox.markDelivered(repoPath, to, mailboxMessage.id).catch(() => {});
  }

  console.log(`Message sent to "${to}".`);
  console.log(`  ID: ${msg.id}`);
  console.log(`  Conversation: ${conv.id}`);
}

// ============================================================================
// Command Registration
// ============================================================================

export function registerSendInboxCommands(program: Command): void {
  // ── genie send ──
  program
    .command('send <body>')
    .description('Send a direct message to an agent (PG-backed)')
    .option('--to <agent>', 'Recipient agent name (default: team leader)', 'team-lead')
    .option('--from <sender>', 'Sender ID (auto-detected from context)')
    .option('--team <name>', 'Explicit team context for sender/recipient resolution')
    .option('--bridge', 'On scope violation, print an advisory + relay command instead of failing (exit 0)')
    .addHelpText(
      'after',
      `
Examples:
  genie send 'start task #3' --to engineer         # Message a specific agent
  genie send 'status update' --to team-lead         # Report to team lead
  genie send 'deploy ready' --team my-feature       # Message within team context
  genie send 'hi felipe' --to felipe-3 --bridge    # Scope violation → print relay hint instead of erroring`,
    )
    .action(async (body: string, options: { to: string; from?: string; team?: string; bridge?: boolean }) => {
      try {
        await handleSend(body, options);
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

        // Emit runtime event for real-time observability (fire-and-forget)
        try {
          const { publishSubjectEvent } = await import('../lib/runtime-events.js');
          await publishSubjectEvent(repoPath, 'genie.msg.broadcast', {
            kind: 'message',
            agent: from,
            direction: 'out',
            peer: teamName,
            text: body,
            data: { messageId: msg.id, conversationId: conv.id, from, team: teamName },
            source: 'mailbox',
          });
        } catch {
          // Event log unavailable — silent degradation
        }

        console.log(`Broadcast sent to team "${teamName}".`);
        console.log(`  Message ID: ${msg.id}`);
        console.log(`  Conversation: ${conv.id}`);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // ── genie inbox ──
  const inbox = program.command('inbox').description('Inbox management — list messages or watch for new ones');

  inbox
    .command('list [agent]', { isDefault: true })
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

  inbox
    .command('watch')
    .description('Run inbox watcher in foreground (Ctrl+C to stop)')
    .action(async () => {
      const { checkInboxes, getInboxPollIntervalMs, startInboxWatcher, stopInboxWatcher } = await import(
        '../lib/inbox-watcher.js'
      );

      const pollMs = getInboxPollIntervalMs();
      if (pollMs === 0) {
        console.log('Inbox watcher is disabled (GENIE_INBOX_POLL_MS=0)');
        process.exit(0);
      }

      console.log(`Inbox watcher starting (poll every ${pollMs / 1000}s)`);
      console.log('Press Ctrl+C to stop.\n');

      // Run an initial check immediately
      const initial = await checkInboxes();
      if (initial.length > 0) {
        console.log(`[inbox-watcher] Spawned team-leads for: ${initial.join(', ')}`);
      }

      // Start the polling loop with visible logging
      const handle = startInboxWatcher({
        listTeamsWithUnreadInbox: (await import('../lib/claude-native-teams.js')).listTeamsWithUnreadInbox,
        isTeamActive: async (teamName) => {
          const { isTeamActive } = await import('../lib/team-auto-spawn.js');
          return isTeamActive(teamName);
        },
        isAgentAlive: async (agentName) => {
          const { isAgentAlive } = await import('../lib/team-auto-spawn.js');
          return isAgentAlive(agentName);
        },
        ensureTeamLead: async (teamName, workingDir) => {
          const { ensureTeamLead } = await import('../lib/team-auto-spawn.js');
          const result = await ensureTeamLead(teamName, workingDir);
          console.log(`[inbox-watcher] Spawned team-lead for "${teamName}" in ${workingDir}`);
          return result;
        },
        warn: (msg) => console.log(msg),
        // Pattern 9 — emit on silent-skip transition. Fire-and-forget; errors
        // swallowed so the poll loop never crashes on an emit glitch.
        emitDeadInbox: (payload) => {
          try {
            emitEvent('rot.inbox-watcher-spawn-loop.detected', payload as unknown as Record<string, unknown>);
          } catch {
            // best-effort
          }
        },
      });

      const shutdown = () => {
        console.log('\nStopping inbox watcher...');
        stopInboxWatcher(handle);
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      // Keep process alive
      await new Promise(() => {});
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
